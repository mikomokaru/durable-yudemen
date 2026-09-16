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
  cannotStart,
  feasibleRelease,
  initialRelease,
  isStale,
  keepsAnchor,
  placeableTargets,
  retimed,
  type AcceptedSlice,
  type CookSchedule,
} from "./schedule";
import { occupiedSlotsOf } from "../domain/store";
import type { ShownPlan } from "./stability";
import type { Timer } from "./timer";
import type { EpochMillis } from "./types";

/**
 * 接頭辞が伸びるのを止めた述語。**採否の理由そのもので、採点の値ではない。**
 *
 * `"complete"` は「届いた一片をすべて採った」——止めた述語が無いという意味である。
 * 採用が 0 件でも `"complete"` にはならない（空の計画は `"empty"`）。
 */
export type AdmitStage =
  /** 届いた一片をすべて採った。 */
  | "complete"
  /** 届いた計画に一片が無い。 */
  | "empty"
  /** 同じ Table_Group を二度計画している（計画としての形を成していない）。 */
  | "duplicate-table"
  /** 陳腐化——置いた品目が現在の計画対象に無い／現在の slotSpan を満たさない（TS モードは全件被覆も）。 */
  | "stale"
  /** 走行中の錨を守っていない（合流の主張・散らし・押し出し）。 */
  | "anchor"
  /** 上げ窓の上限（arms + HELPER_ARMS）を超える。 */
  | "lift-cap"
  /** 解放表と噛み合わない（過去開始・釜が空いていない・茹で時間の不一致）。 */
  | "release"
  /** 非改善（TS モードのみ・段 1 の (d)）。 */
  | "not-improving"
  /** 合成後の総和が現行を下回らない（TS モードのみ・段 2）。 */
  | "composed-worse"
  /** 遅延補正の幅が上限（30 秒）を超える——補正不能（CP-SAT モードのみ）。 */
  | "retime-too-large"
  /** 補正後の「今開始」の釜が塞がっている（CP-SAT モードのみ）。 */
  | "not-startable";

/** `admitDetailed` の答え。採用した一片と、採否の理由と、当てた遅延補正の幅。 */
export interface AdmitOutcome {
  readonly slices: readonly AcceptedSlice[];
  readonly stage: AdmitStage;
  /** 当てた遅延補正の幅（ミリ秒・0 は補正なし）。採用した配置はこの分だけ後ろにある。 */
  readonly retimedByMs: number;
}

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
  /**
   * 採点パラメータに**計画器の選択**を添えたもの。`admit` が `SettleParams` 全体を要求しないのは、
   * 麺プリセットを二度受け取らないためである（第 7 引数で既に受けている）。
   * **`planner` は省略できない**——省けば「どちらの規則で採ったか」が呼び出し側から読めなくなる。
   */
  params: ScheduleParams & { readonly planner: "ts" | "cpsat" },
): readonly AcceptedSlice[] {
  return admitDetailed(arrived, committed, pending, running, shown, now, presets, params).slices;
}

/**
 * admit と同じ判定を行い、**採否の理由と遅延補正の幅を添えて**返す（2026-09-13 追加）。
 *
 * `admit` はこれの `slices` だけを返す薄い包みである——判定を二度書かない。
 *
 * **なぜ理由が要るか。** 配備後の実測で採用率は 90.4% だが、残る 10% が「求解中に人が開始した」
 * という正常な棄却なのか別の欠陥なのかを、`cpsat.plan-decided` の 1 行から分けられなかった。
 * **次に直す対象を決める唯一の材料がこれである。**
 *
 * 段は「接頭辞が伸びるのを止めた述語」である。すべての一片を採ったなら `"complete"`。
 */
export function admitDetailed(
  arrived: CookSchedule,
  committed: CookSchedule,
  pending: readonly OrderItem[],
  running: readonly Timer[],
  shown: ShownPlan,
  now: EpochMillis,
  presets: readonly NoodlePreset[],
  params: ScheduleParams & { readonly planner: "ts" | "cpsat" },
): AdmitOutcome {
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
  // **CP-SAT モードでは改善判定を課さない（R1.4・R5.4・2026-09-13）。**
  //
  // 「TS の物差しで真に良いこと」を採用の条件にすると、別の目的関数で解いた計画は構造的に
  // 通らない——実測で本番 165 店舗・334 件の受領すべてが棄却された。R5.4 が求めるのは
  // **有効性の検査**（形式・対象集合への一意性と全件充足・占有・時刻・レシピ）であって、
  // 旧計画器との優劣ではない。
  //
  // **消えるのは同値・劣化の判定だけである。** 鮮度（R5.2）と指紋（R5.3）は `receivePlan` の側で、
  // 上げ窓の上限（R4.4）・陳腐化・feasibility は下の `prune` で引き続き効く。ゆえに「いまの局面の
  // 指紋と一致する、最新の有効な応答」だけが採られるという性質は保たれる。
  //
  // **ちらつきの守り手はモデルへ移る**——前回の配置を `previous` として渡し `slotChangeCost` で
  // 値段を付けている（design 第 7.6.5 節）。係数が十分かは連続局面の再生で数える。
  const requireImprovement = params.planner !== "cpsat";

  // **遅延補正（R5.5・design 第 5.3 節 手順 4）。CP-SAT モードだけに当てる。**
  //
  // 要求から応答までに時刻は進み、計画の先頭は過去開始になる。ここで全配置を同じ幅だけ
  // 後ろへずらす——相対関係は保たれるので、通るようになるのは「過去開始」ただ一つである。
  // 幅が上限（30 秒）を超えるなら補正不能として応答全体を棄却する。
  //
  // **TS モードには当てない。** あちらの外部計画（旧 Solver_Worker）は既存の契約で動いており、
  // 巻き戻しの経路でもある。補正を入れれば「同じ計画が前は落ち、いまは通る」を TS 側にも
  // 持ち込むことになる。R5.5 は CP-SAT の新着ゲート（design 第 5.3 節）の手順である。
  //
  // **モデル側の `CPSAT_DELIVERY_LEAD_MS` とは別物で、役割が違う。** lead は「先にずらしておく」
  // 第一線で、遅れが lead を超えれば効かない。こちらは「実際の遅れの分だけ受領側でずらす」
  // 第二線で、裾を救う。両方在って初めて、lead を短くしても棄却が増えない形になる。
  const corrected = requireImprovement ? { plan: arrived, byMs: 0 } : retimed(arrived, now);
  if (corrected === null) return { slices: [], stage: "retime-too-large", retimedByMs: 0 };
  // **補正した計画の「今開始」は、全釜 idle を別途検査する**（design 第 5.3 節 手順 4）。
  // ずらした結果ちょうど `now` に来た配置は、その釜に running / boiled が残っていれば人が
  // 押せない。`admit` の feasibility は通常この述語を読まない（plan-stability 判断 5）ので、
  // **補正したときに限って**当てる——補正しなかった計画の扱いは一切変えない。
  if (
    corrected.byMs > 0 &&
    corrected.plan.slices.some((slice) => cannotStart(slice, now, occupiedSlotsOf(running)))
  )
    return { slices: [], stage: "not-startable", retimedByMs: corrected.byMs };
  const retimedByMs = corrected.byMs;

  const pruned = prune(
    corrected.plan,
    committed,
    committedScore.bySlice,
    live,
    running,
    now,
    scoreContext,
    presets,
    params,
    requireImprovement,
  );
  const prefix = pruned.slices;
  if (prefix.length === 0) return { slices: [], stage: pruned.stage, retimedByMs };
  // 段 2（合成後の総和が現行を真に下回ること）も CP-SAT モードでは課さない。段 1 と同じ理由である。
  if (!requireImprovement) return { slices: prefix, stage: pruned.stage, retimedByMs };

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
  return composedScore.total < committedScore.total
    ? { slices: prefix, stage: pruned.stage, retimedByMs }
    : { slices: [], stage: "composed-worse", retimedByMs };
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
  requireImprovement: boolean,
): { readonly slices: readonly AcceptedSlice[]; readonly stage: AdmitStage } {
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
  /** 飛ばした一片のうち**最初の**理由。採用が起きても「何が落ちたか」を記録に残す。 */
  let skipped: AdmitStage | null = null;
  let release = initialRelease(running, now, params.unitOrigins.length * SLOTS_PER_UNIT);
  // 上げ表（「店舗全体でいつ上がるか」）も走行中から始め、採用した一片の上がりで進める（合成と同じ位置・同じ表）。
  let lifts = scoreContext.lifts;

  // **CP-SAT モードでは、落ちた一片を飛ばして後続を見る（ADR-0016・2026-09-15）。**
  //
  // 接頭辞（最初に落ちた一片以降を捨てる）は TS モードの契約のまま残す。CP-SAT の計画は
  // **伝票ごとに独立した一片が並ぶ**形で、片の中に早い配置と遅い配置が混ざるため、どう並べ替えても
  // 釜の時刻が他の片と交錯する——「釜 11 を 518 秒から使う片」を先に採ると「釜 11 を 53 秒から
  // 使う片」が通らない。実測（空き釜 4 本）では**届いた一片の 24% がこれで落ちていた**。
  // 現場からは「出ていた提案が取り下げられた」に見える。
  //
  // **飛ばしても feasibility は保たれる。** 判定は解放表・上げ表を**採った一片だけ**で進めるので、
  // 落とした一片の配置は表に載らない。採った集合はそれ自身で実行可能である（Property 7 の主張は
  // 「接頭辞の内側で閉じる」だが、成り立っている理由は**採った一片だけで表を進める**ことであり、
  // 連続していることではない）。
  const skipOnFailure = !requireImprovement;
  for (const [index, slice] of arrived.slices.entries()) {
    // 同じ Table_Group を二度計画した外部計画は、計画としての形を成していない（一片は採用/棄却の単位ゆえ
    // 一つの group につき一つである）。二度目も isStale を通ってしまう——group との集合一致は両方で立つ——
    // ので、ここで断つ。落とさないと同一品目を二度置く計画が採用されうる（二重調理の計画）。
    if (claimed.has(slice.tableKey)) {
      if (!skipOnFailure) return { slices: prefix, stage: "duplicate-table" };
      skipped = skipped ?? "duplicate-table";
      continue;
    }
    // (a)(b)。述語は schedule.ts の isStale ただ一つ。
    // **CP-SAT モードでは全件被覆を要求しない**（2026-09-13 ユーザー判断）。天井で切った部分集合を
    // 計画するので、要求すれば構造上どの計画も採用されない。置いた品目が計画対象に在ることは見る。
    if (isStale(slice, targets, requireImprovement)) {
      if (!skipOnFailure) return { slices: prefix, stage: "stale" };
      skipped = skipped ?? "stale";
      continue;
    }
    // (e) 始めたまとまりを崩さない。走行中の仲間が在る卓で、合流分の錨の主張が現在の仲間に無い・錨より手前に
    // 散らす・集合として合流できていない・窓以外の理由で延期した計画と、その錨に合流できた品目を候補時刻からの
    // `firstFit` より後ろへ押し出した計画は feasible と認めない（判断 16 / 17・AC 9.10・ADR-0007）。目的関数は最遅参照
    // ゆえ「合流できない 1 本のために全員を遅らせる」配置を真に良いと採点し、ソフトでは外部解に消される。述語は
    // schedule.ts の keepsAnchor ただ一つ（確定計画の合成・自前解の性質検査と共用）で、一片を置く前の解放表と上げ表を
    // 受けて pack の単位で検証する——錨の主張だけでは合流分と認めない（主張を信じれば、押し出した配置に仲間の endTime
    // を書くだけで (e) を素通りする）。仲間が無い卓（siblings null）でも通す——`anchor` の主張（AC 9.10 (a)）は仲間の
    // 有無に関わらず述語が見る。
    const siblings = members.get(slice.tableKey) ?? null;
    if (!keepsAnchor(slice.placements, release, lifts, siblings, targets, presets, params)) {
      if (!skipOnFailure) return { slices: prefix, stage: "anchor" };
      skipped = skipped ?? "anchor";
      continue;
    }
    // (f) 上げ窓の上限。走行中の上がりと計画順に見た手前の一片の上がりで埋めた表に当該一片の配置を載せたとき、
    // 各配置を**含む**窓の負荷が arms + HELPER_ARMS を超えれば feasible と認めない（lift-group-planning AC 9.5・判断 20・
    // ADR-0009）。含まない窓——走行中だけで既に超えている窓——は見ない（AC 9.4・9.14）。arms の超過は採点
    // （Lift_Overflow）に委ねる。1 品で上限を超える品目（大盛 span 2 が arms 1 + 2 = 3 に入るのは可・span 4 は不可）は
    // 置ける品目に無いので (a)(b) で既に落ちている（AC 9.12）。述語は lift.ts の withinLiftCap ただ一つ（合成と共用）。
    if (!withinLiftCap(lifts, liftsOf(slice.placements), params)) {
      if (!skipOnFailure) return { slices: prefix, stage: "lift-cap" };
      skipped = skipped ?? "lift-cap";
      continue;
    }
    // (c)（と (a)(b)(d)・茹で時間の一致）。進めた解放表が返れば feasible。述語は schedule.ts の feasibleRelease ただ一つ
    // （復元と共用）。
    const advanced = feasibleRelease(slice.placements, release, targets, presets);
    if (advanced === null) {
      if (!skipOnFailure) return { slices: prefix, stage: "release" };
      skipped = skipped ?? "release";
      continue;
    }
    // (d)。**同値は棄却する**（無駄な Persist / Broadcast を生まないため・AC 6.2(d)）。
    // 対応する一片が現行 Committed_Plan に無いときも棄却する——比べる基準が無い一片は「真に良い」と
    // 言えない。自前解が置かない品目（茹で時間の引けない麺種）を外部が置いた場合がこれに当たり、
    // (c) の茹で時間検査と合わせて二重に落ちる。
    // (d)。**同値は棄却する**（無駄な Persist / Broadcast を生まないため・AC 6.2(d)）。
    //
    // **CP-SAT モードでは (d) を丸ごと課さない。** 当初は「対応する一片が現行に無い場合は引き続き
    // 落とす」として `current === undefined` の判定を残したが、**それが CP-SAT モードで採用を
    // 構造的に不可能にしていた**（2026-09-13 の配備で判明）——段 3 で尾部の補完を外したので、
    // 採用済みが無い間の `committed` は空であり、`corresponding` も空になる。比べる相手が
    // 存在しないのだから、そこで落とせば最初の 1 件が永久に採られない。
    //
    // 「自前解が置かない品目を外部が置いた」場合を取りこぼさないことは確かめてある。
    // `placeableTargets` が除外する理由は 2 つだけで（`isPlaceable`）、**どちらも陳腐化A が捕まえる**
    // ——除外された品目は `targets` に無いので、それを指す配置は `group` に対応が見つからず
    // `isStale` が真になる（CP-SAT モードでも陳腐化A は残している）。
    //
    //   ・茹で時間を引けない（プリセットに無い麺種）→ targets に無い → 陳腐化A
    //   ・単体で上げ窓の上限を超える（`slotSpan > liftCap`）→ targets に無い → 陳腐化A
    //
    // **(c)（`feasibleRelease`）が代わりになる、という説明は不正確だった**（2026-09-13 訂正）。
    // (c) が見るのは解放表と茹で時間の整合であって、上限超過の span は見ない。
    const current = corresponding.get(slice.tableKey);
    const score = scores[index]!;
    if (requireImprovement && (current === undefined || score >= current))
      return { slices: prefix, stage: "not-improving" };

    prefix.push({ tableKey: slice.tableKey, placements: slice.placements });
    claimed.add(slice.tableKey);
    release = advanced;
    lifts = advanceLifts(lifts, liftsOf(slice.placements));
  }
  // 全件を見終えた。飛ばした一片があれば、その最初の理由を段として返す——「全部採れた」と
  // 「一部を飛ばして残りを採った」は別の事実である。
  return {
    slices: prefix,
    stage: arrived.slices.length === 0 ? "empty" : (skipped ?? "complete"),
  };
}
