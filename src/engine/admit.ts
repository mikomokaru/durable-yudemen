// engine/admit.ts — Acceptance_Gate。外部から届いた計画のうち採用できる範囲を決める（要件6）。
// cloudflare:workers にも storage にも触れない純粋モジュール。
//
// ここに置くのは「外部計画を信じてよいか」の判定だけである。計画の型と自前解は schedule.ts、採点は
// objective.ts、合成は commit.ts の関心事であり、この関数はそれらを呼ぶだけで一つも作り直さない。
// とくに**採点は engine 自身の scoreSchedule ただ一つ**を用いる——外部計画が載せてきた score は
// 外部が主張した値にすぎず、判定の根拠にすれば嘘の値で単調改善を判定することになる。
//
// 判定は 2 段である。役割が違う（design.md「単調改善は全体判定が担保する」）。
//   段 1 — (a)〜(d) を PlanSlice ごとに、計画順の接頭辞として。**枝刈り**。
//   段 2 — 接頭辞を採用した場合の合成後の総和 vs 現行 Committed_Plan の総和。**単調性の担保**。
// 段 1 の (d) は Committed_Plan の**対応部分和**と比べ、段 2 は**合成後総和**と現行総和を比べる。
// どちらも比較基準は Baseline_Plan ではない——基準を自前解に取れば、採用済みのより良い計画を後着の
// 劣る計画が上書きできてしまう（AC 6.2(d) が Committed_Plan 基準を要求する理由そのもの）。

import { SLOTS_PER_UNIT, slotOf, type NoodlePreset } from "../domain/store";
import type { PendingOrder } from "../domain/order";
import { committedSchedule } from "./commit";
import { scoreSchedule, type ScheduleParams } from "./objective";
import {
  advanceRelease,
  initialRelease,
  isStale,
  planTargets,
  refersTo,
  type AcceptedSlice,
  type CookSchedule,
  type Placement,
  type SlotRelease,
} from "./schedule";
import type { Timer } from "./timer";
import type { EpochMillis } from "./types";

/**
 * admit — 外部計画を PlanSlice ごとに検証し、計画順の接頭辞のうち採用できる範囲を返す（AC 6.2〜6.4）。
 *
 * 段 1 の判定は 4 つを一体で行う。
 *   (a) 陳腐化A — 一片の対象品目が現在も計画対象の Pending_Order に在る
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
 * (2) 段 1 の (c) が「serveAt = startAt ＋ 茹で時間」を検査する（下記 `feasibleRelease` の注記）。
 *
 * 返す一片の score は**engine が算出した値**に差し替える。外部が主張した score をそのまま状態へ載せれば、
 * 永続する事実が嘘の値を含むことになる（「コードは真実を語る」）。
 */
export function admit(
  arrived: CookSchedule,
  committed: CookSchedule,
  pending: readonly PendingOrder[],
  running: readonly Timer[],
  now: EpochMillis,
  presets: readonly NoodlePreset[],
  params: ScheduleParams,
): readonly AcceptedSlice[] {
  const prefix = prune(arrived, committed, pending, running, now, presets, params);
  if (prefix.length === 0) return [];

  // 段 2。候補接頭辞で合成を 1 回走らせ、総和を現行 Committed_Plan と比べる。合成は接頭辞の占有から
  // 尾部を再実行するため、ここで得る総和は「採用した後に実際に確定する計画」の値そのものである。
  const composed = committedSchedule(prefix, pending, running, now, presets, params);
  return composed.score < committed.score ? prefix : [];
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
  pending: readonly PendingOrder[],
  running: readonly Timer[],
  now: EpochMillis,
  presets: readonly NoodlePreset[],
  params: ScheduleParams,
): readonly AcceptedSlice[] {
  const targets = planTargets(pending);
  // 対応部分和は tableKey で引く。**index では引けない**——外部計画の一片の並びは現行 Committed_Plan の
  // 並びと無関係であり、同じ index の一片は別の Table_Group を指しうる（別物どうしの部分和を比べても
  // 意味のある判定にならない）。Committed_Plan の側は tableKey が一意である：自前解は Table_Group を
  // Map で束ねるので重複を作らず、合成の接頭辞は当該 group の全品目を覆う（さもなくば isStale が落とす）ため
  // 尾部に同じ key が再び現れることもない。**外部計画の側の重複は下で明示的に落とす。**
  const corresponding = new Map(committed.slices.map((slice) => [slice.tableKey, slice.score]));
  // 採点は一度で済む（全項が Table_Group の内側に閉じるため部分和は一片ごとに独立・Property 3）。
  const scores = scoreSchedule(arrived.slices, pending, params).bySlice;

  const prefix: AcceptedSlice[] = [];
  const claimed = new Set<string>();
  let release = initialRelease(running, now, params.unitOrigins.length * SLOTS_PER_UNIT);

  for (const [index, slice] of arrived.slices.entries()) {
    // 同じ Table_Group を二度計画した外部計画は、計画としての形を成していない（一片は採用/棄却の単位ゆえ
    // 一つの group につき一つである）。二度目も isStale を通ってしまう——group との集合一致は両方で立つ——
    // ので、ここで断つ。落とさないと同一品目を二度置く計画が採用されうる（二重調理の計画）。
    if (claimed.has(slice.tableKey)) break;
    // (a)(b)。述語は schedule.ts の isStale ただ一つ。
    if (isStale(slice, targets)) break;
    // (c)。進めた解放表が返れば feasible。
    const advanced = feasibleRelease(slice.placements, release, targets, presets);
    if (advanced === null) break;
    // (d)。**同値は棄却する**（無駄な Persist / Broadcast を生まないため・AC 6.2(d)）。
    // 対応する一片が現行 Committed_Plan に無いときも棄却する——比べる基準が無い一片は「真に良い」と
    // 言えない。自前解が置かない品目（茹で時間の引けない麺種）を外部が置いた場合がこれに当たり、
    // (c) の茹で時間検査と合わせて二重に落ちる。
    const current = corresponding.get(slice.tableKey);
    const score = scores[index]!;
    if (current === undefined || score >= current) break;

    prefix.push({ tableKey: slice.tableKey, placements: slice.placements, score });
    claimed.add(slice.tableKey);
    release = advanced;
  }
  return prefix;
}

/**
 * 一片がハード制約を満たすか。満たすなら当該一片の占有で進めた解放表を、破るなら null を返す。
 *
 * 検査するのは Requirement 3 のハード制約 (a)(b)(c) と、**配置が物理的に成立していること**である。
 *
 * - (a) 同一 slot の時間帯を重複させない — 解放表が請け負う。配置を開始時刻の昇順に見て、その釜の解放時刻
 *   より前に始まる配置を落とす。一片の内側でも同じ釜を順に使う配置はあり得る（釜の数を超える大人数の卓は
 *   分割して置かれる）ため、一片の中でも表を進めながら見る。
 * - (b) 各時点の同時走行本数 ≤ slot 数 — (a) から従う。各配置は自分の釜の時間帯を排他に占めるので、
 *   ある瞬間に走れる本数は表の長さ＝釜の数を超えられない。独立の検査を置かない（同じ事実を二度書かない）。
 * - (c) 開始済み Timer の割当と実効 endTime を変えない — `initialRelease` が請け負う。表の初期値が開始済み
 *   Timer の実効 endTime であり、下限が now ゆえ過去に始まる配置もここで落ちる。
 *
 * **serveAt = startAt ＋ 当該品目の茹で時間 を検査する（design の (a)(b)(c) への追加）。** 外部計画は
 * startAt と serveAt の両方を主張してくるが、両者を結ぶのは品目の茹で時間ただ一つである。検査しないと
 * 「10 秒で茹で上がる」と主張する計画が作れ、Wait_Time も解放表もその嘘に従う——目的関数値はいくらでも
 * 小さくでき、改善判定 (d) と段 2 が無条件に通る。外部を信用しない設計の要は、外部が申告した値のうち
 * 検証できるものをすべて検証することにある。茹で時間が引けない麺種（設定の差し替えを跨いだ待ち行列に
 * 残り得る）もここで落ちる。
 */
function feasibleRelease(
  placements: readonly Placement[],
  release: SlotRelease,
  targets: readonly PendingOrder[],
  presets: readonly NoodlePreset[],
): SlotRelease | null {
  // 開始時刻の昇順で見る。同時刻は代表 slot の番号で断つ（判定を配置の並び順に依存させない）。
  const ordered = [...placements].sort(
    (placement, other) =>
      placement.startAt - other.startAt || slotOf(placement.slotIds[0]) - slotOf(other.slotIds[0]),
  );

  let free = release;
  for (const placement of ordered) {
    const boilMillis = boilMillisOf(placement, targets, presets);
    if (boilMillis === null) return null;
    if (placement.serveAt - placement.startAt !== boilMillis) return null;
    for (const slotId of placement.slotIds) {
      const at = free[slotOf(slotId)];
      // 表の外を指す slot は存在しない釜であり、置き場所ではない。
      if (at === undefined) return null;
      if (placement.startAt < at) return null;
    }
    free = advanceRelease(free, [placement]);
  }
  return free;
}

/**
 * 配置が指す品目の茹で時間（ミリ秒）。品目が計画対象に無いか、麺種がプリセットに無ければ null。
 *
 * 品目の同一性は schedule.ts の refersTo ただ一つ。茹で時間は PendingOrder が持たない導出値ゆえ
 * （noodleType × firmness）、判定の直前に引く。
 */
function boilMillisOf(
  placement: Placement,
  targets: readonly PendingOrder[],
  presets: readonly NoodlePreset[],
): number | null {
  const order = targets.find((candidate) => refersTo(placement, candidate));
  if (order === undefined) return null;
  const preset = presets.find((candidate) => candidate.noodleType === order.noodleType);
  if (preset === undefined) return null;
  return preset.boilSeconds[order.firmness] * 1000;
}
