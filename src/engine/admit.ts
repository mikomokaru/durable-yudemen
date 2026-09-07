// engine/admit.ts — Acceptance_Gate。外部から届いた計画のうち採用できる範囲を決める（要件6）。
// cloudflare:workers にも storage にも触れない純粋モジュール。
//
// ここに置くのは「外部計画を信じてよいか」の判定だけである。計画の型と自前解は schedule.ts、採点は
// objective.ts、合成は commit.ts の関心事であり、この関数はそれらを呼ぶだけで一つも作り直さない。
// **採点は比較の時点でここが行う。** 計画は点数を持たず（PlanSlice に score は無い）、外部計画が score を
// 添えてきても読まない。永続した点数を比較に使えば、重みや走行中の変化とずれた値で単調改善を判定する
// ことになる（lift-group-planning 判断 7）。
//
// 判定は 2 段である。役割が違う（design.md「単調改善は全体判定が担保する」）。
//   段 1 — (a)〜(d) を PlanSlice ごとに、計画順の接頭辞として。**枝刈り**。
//   段 2 — 接頭辞を採用した場合の合成後の総和 vs 現行 Committed_Plan の総和。**単調性の担保**。
// 段 1 の (d) は Committed_Plan の**対応部分和**、段 2 は**合成後総和**と現行総和を、いずれも比較の時点の
// 走行中（卓の成員表）で採点し直して比べる。
// どちらも比較基準は Baseline_Plan ではない——基準を自前解に取れば、採用済みのより良い計画を後着の
// 劣る計画が上書きできてしまう（AC 6.2(d) が Committed_Plan 基準を要求する理由そのもの）。

import { SLOTS_PER_UNIT, type NoodlePreset } from "../domain/store";
import { pendingOrders, type OrderItem } from "../domain/order";
import { committedSchedule } from "./commit";
import { advanceLifts, initialLifts, liftsOf, withinLiftCap } from "./lift";
import { scoreSchedule, type ScheduleParams, type ScoreContext } from "./objective";
import { tableMembers } from "./project";
import {
  feasibleRelease,
  initialRelease,
  isStale,
  keepsAnchor,
  placeableTargets,
  type AcceptedSlice,
  type CookSchedule,
} from "./schedule";
import type { ShownPlan } from "./stability";
import type { Timer } from "./timer";
import type { EpochMillis } from "./types";

/**
 * admit — 外部計画を PlanSlice ごとに検証し、計画順の接頭辞のうち採用できる範囲を返す（AC 6.2〜6.4）。
 *
 * 段 1 の判定は 4 つを一体で行う。
 *   (a) 陳腐化A — 一片の対象品目が現在も計画対象の未調理の品目に在る
 *   (b) 陳腐化B — 一片の Table_Group に計画が知らない新着が加わっていない
 *   (c) feasibility — Requirement 3 のハード制約を満たす
 *   (d) 改善 — 部分和が Committed_Plan の対応部分和より真に良い（同値は棄却）
 * (a)(b) は `isStale`（schedule.ts）ただ一つ——確定計画の合成（commit.ts）が維持に用いるのと同じ述語である。
 * 採用の基準と維持の基準を別に書けば、両者は黙ってずれる。
 *
 * 最初に落ちた一片以降は棄却する（接頭辞採用）。そのうえで段 2 の全体判定を行い、**悪化するなら接頭辞を
 * 短くせず全棄却する**。段階的に短くする探索を採らないのは、棄却が無害（現行 Committed_Plan がそのまま残り、
 * 次の状態変化で新しい要求が出る）である一方、接頭辞長ごとに尾部を再実行すると baselineSchedule を最大
 * 一片数回走らせることになり、要件11.1 の計算量上限を押し上げるためである。
 *
 * 判定に必要な構造は引数（現行 Committed_Plan・待ち行列・開始済み Timer）から受け取り、外部への照会を
 * 一切行わない（AC 6.7）。in-flight の重複・追い越しは (a)〜(d) と段 2 だけで吸収する（AC 6.4）——
 * 要求と応答の対応付けも版カウンタも持たない。
 *
 * **design の署名からの変更点。** design は `(arrived, committed, pending, running, now, params)` だが、
 * `presets` を足す。理由は 2 つあり、いずれも「茹で時間を引く必要がある」に帰着する。
 * (1) 段 2 が `committedSchedule` を走らせ、それが尾部の再実行に茹で時間を要する（タスク 9.1 / 11.1 の判断）。
 * (2) 段 1 の (c) が「serveAt = startAt ＋ 茹で時間」を検査する（schedule.ts の `feasibleRelease` の注記）。
 *
 * **旧 Shown_Plan（`shown`）を受け、Business_Cost + Change_Cost で採点する（plan-stability AC 4.1・判断 6）。** 3 回の採点
 * すべてに同じ文脈を渡す——旧 Shown_Plan は遷移前の状態が持つもの（`receivePlan` の `state.shownPlan`・AC 1.7）、Timer
 * 集合は再同期後の `running`、now は受領時刻（判断 8）。前回と大きく違う計画で微小な改善を出す外部解は、変更費用が改善を
 * 食って段 2 で落ちる。改善判定の基準は現行の Committed_Plan のまま（Committed_Plan 自身も同じ費用で採点される）。
 *
 * 返す一片は点数を持たない。採用は「この店が採用した」という事実であり、点数はその時点の導出にすぎない。
 */
export function admit(
  arrived: CookSchedule,
  committed: CookSchedule,
  pending: readonly OrderItem[],
  running: readonly Timer[],
  shown: ShownPlan,
  now: EpochMillis,
  presets: readonly NoodlePreset[],
  params: ScheduleParams,
): readonly AcceptedSlice[] {
  // 受領時刻の未調理の品目（`pendingOrders`＝期限内 ∧ unstarted）を冒頭で一度だけ導き、変更費用の文脈・採点・計画対象
  // （段 1 の `planTargets`）・段 2 の合成のすべてがそれを読む（pending-order-expiry AC 2.3 / 2.4・order-lifecycle AC 4.1）。
  // 正本の集合を文脈に残せば、期限切れの旧先頭が Head に数えられ、生きている次品目を遅らせる計画の先頭の変更（2L）が
  // 0 に消える。呼び手が既に絞った集合を渡しても冪等。
  const live = pendingOrders(pending, running, now);
  // 卓の成員表と上げ表は 1 回だけ引き、変更費用の文脈と束ねて段 1・段 2 の採点 3 回（と段 1 の (e)(f)）で共有する。
  const scoreContext: ScoreContext = {
    members: tableMembers(running),
    lifts: initialLifts(running),
    change: { shown, running, now, pending: live, presets },
  };
  const committedScore = scoreSchedule(committed.slices, live, scoreContext, params);
  const prefix = prune(
    arrived,
    committed,
    committedScore.bySlice,
    live,
    running,
    now,
    scoreContext,
    presets,
    params,
  );
  if (prefix.length === 0) return [];

  // 段 2。候補接頭辞で合成を 1 回走らせ、総和を現行 Committed_Plan と比べる。合成は接頭辞の占有から
  // 尾部を再実行するため、ここで得る総和は「採用した後に実際に確定する計画」の値そのものである。
  // 尾部の自前解も同じ文脈で前回を残す（採用後に実際に確定する計画そのものを採点する）。
  const composed = committedSchedule(
    prefix,
    live,
    running,
    now,
    presets,
    params,
    scoreContext.change,
  );
  const composedScore = scoreSchedule(composed.slices, live, scoreContext, params);
  return composedScore.total < committedScore.total ? prefix : [];
}

/**
 * 段 1。計画順に見て、(a)〜(d) をすべて満たす一片が続く限り採る（最初に落ちた一片以降は捨てる）。
 *
 * 解放表を一片ごとに進めながら判定するので、**接頭辞の feasibility は接頭辞の内側だけで閉じる**
 * ——後方の一片が採られるかどうかに依存しない（Property 7）。
 */
function prune(
  arrived: CookSchedule,
  committed: CookSchedule,
  committedBySlice: readonly number[],
  pending: readonly OrderItem[],
  running: readonly Timer[],
  now: EpochMillis,
  scoreContext: ScoreContext,
  presets: readonly NoodlePreset[],
  params: ScheduleParams,
): readonly AcceptedSlice[] {
  // 計画対象は**置ける品目**（`placeableTargets`・plan-stability Requirement 7）——合成（`livePrefix`）と復元が `isStale` に
  // 渡すのと同じ集合。正本のまま比べると、自前解が置かない品目（未知麺種・上限を超える span）を含む卓の外部計画が
  // 常に「欠落」で落ちる。置けない品目を置いた一片は「対象外の混入」として引き続き落ちる（AC 7.3）。
  const targets = placeableTargets(pending, now, presets, params);
  const { members } = scoreContext;
  // 対応部分和は tableKey で引く。**index では引けない**——外部計画の一片の並びは現行 Committed_Plan の
  // 並びと無関係であり、同じ index の一片は別の Table_Group を指しうる（別物どうしの部分和を比べても
  // 意味のある判定にならない）。Committed_Plan の側は tableKey が一意である：自前解は Table_Group を
  // Map で束ねるので重複を作らず、合成の接頭辞は当該 group の全品目を覆う（さもなくば isStale が落とす）ため
  // 尾部に同じ key が再び現れることもない。**外部計画の側の重複は下で明示的に落とす。**
  const corresponding = new Map(
    committed.slices.map((slice, index) => [slice.tableKey, committedBySlice[index]!]),
  );
  // 採点は一度で済む（全項が卓の内側に閉じるため部分和は一片ごとに独立・Property 3）。
  const scores = scoreSchedule(arrived.slices, pending, scoreContext, params).bySlice;

  const prefix: AcceptedSlice[] = [];
  const claimed = new Set<string>();
  let release = initialRelease(running, now, params.unitOrigins.length * SLOTS_PER_UNIT);
  // 上げ表（「店舗全体でいつ上がるか」）も走行中から始め、採用した一片の上がりで進める（合成と同じ位置・同じ表）。
  let lifts = scoreContext.lifts;

  for (const [index, slice] of arrived.slices.entries()) {
    // 同じ Table_Group を二度計画した外部計画は、計画としての形を成していない（一片は採用/棄却の単位ゆえ
    // 一つの group につき一つである）。二度目も isStale を通ってしまう——group との集合一致は両方で立つ——
    // ので、ここで断つ。落とさないと同一品目を二度置く計画が採用されうる（二重調理の計画）。
    if (claimed.has(slice.tableKey)) break;
    // (a)(b)。述語は schedule.ts の isStale ただ一つ。
    if (isStale(slice, targets)) break;
    // (e) 始めたまとまりを崩さない。走行中の仲間が在る卓で、合流分の錨の主張が現在の仲間に無い・錨より手前に
    // 散らす・集合として合流できていない・窓以外の理由で延期した計画と、その錨に合流できた品目を候補時刻からの
    // `firstFit` より後ろへ押し出した計画は feasible と認めない（判断 16 / 17・AC 9.10・ADR-0007）。目的関数は最遅参照
    // ゆえ「合流できない 1 本のために全員を遅らせる」配置を真に良いと採点し、ソフトでは外部解に消される。述語は
    // schedule.ts の keepsAnchor ただ一つ（確定計画の合成・自前解の性質検査と共用）で、一片を置く前の解放表と上げ表を
    // 受けて pack の単位で検証する——錨の主張だけでは合流分と認めない（主張を信じれば、押し出した配置に仲間の endTime
    // を書くだけで (e) を素通りする）。仲間が無い卓（siblings null）でも通す——`anchor` の主張（AC 9.10 (a)）は仲間の
    // 有無に関わらず述語が見る。
    const siblings = members.get(slice.tableKey) ?? null;
    if (!keepsAnchor(slice.placements, release, lifts, siblings, targets, presets, params)) break;
    // (f) 上げ窓の上限。走行中の上がりと計画順に見た手前の一片の上がりで埋めた表に当該一片の配置を載せたとき、
    // 各配置を**含む**窓の負荷が arms + HELPER_ARMS を超えれば feasible と認めない（lift-group-planning AC 9.5・判断 20・
    // ADR-0009）。含まない窓——走行中だけで既に超えている窓——は見ない（AC 9.4・9.14）。arms の超過は採点
    // （Lift_Overflow）に委ねる。1 品で上限を超える品目（大盛 span 2 が arms 1 + 2 = 3 に入るのは可・span 4 は不可）は
    // 置ける品目に無いので (a)(b) で既に落ちている（AC 9.12）。述語は lift.ts の withinLiftCap ただ一つ（合成と共用）。
    if (!withinLiftCap(lifts, liftsOf(slice.placements), params)) break;
    // (c)（と (a)(b)(d)・茹で時間の一致）。進めた解放表が返れば feasible。述語は schedule.ts の feasibleRelease ただ一つ
    // （復元と共用）。
    const advanced = feasibleRelease(slice.placements, release, targets, presets);
    if (advanced === null) break;
    // (d)。**同値は棄却する**（無駄な Persist / Broadcast を生まないため・AC 6.2(d)）。
    // 対応する一片が現行 Committed_Plan に無いときも棄却する——比べる基準が無い一片は「真に良い」と
    // 言えない。自前解が置かない品目（茹で時間の引けない麺種）を外部が置いた場合がこれに当たり、
    // (c) の茹で時間検査と合わせて二重に落ちる。
    const current = corresponding.get(slice.tableKey);
    const score = scores[index]!;
    if (current === undefined || score >= current) break;

    prefix.push({ tableKey: slice.tableKey, placements: slice.placements });
    claimed.add(slice.tableKey);
    release = advanced;
    lifts = advanceLifts(lifts, liftsOf(slice.placements));
  }
  return prefix;
}
