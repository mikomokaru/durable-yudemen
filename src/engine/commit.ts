// engine/commit.ts — 確定計画（Committed_Plan）の合成。
// cloudflare:workers にも storage にも触れない純粋モジュール。
//
// ここに置くのは「採用済みの計画と自前解をどう繋ぐか」だけである。計画の型と算出は schedule.ts の
// 関心事であり、この関数はそれを一度呼ぶ。採点は呼ばない——採点は比較の時点（admit.ts）の導出であって
// 合成の一部ではない（lift-group-planning 判断 7）。
//
// 確定計画は**導出値**であって状態ではない。正本は採用済み PlanSlice 列（TimerState.acceptedSlices）と
// 現在の Pending_Order / Timer 集合である。ゆえにここに永続する形は現れない。

import { SLOTS_PER_UNIT, type NoodlePreset } from "../domain/store";
import type { PendingOrder } from "../domain/order";
import type { ScheduleParams } from "./objective";
import { tableMembers } from "./project";
import {
  advanceRelease,
  baselineSchedule,
  initialRelease,
  isStale,
  planTargets,
  refersTo,
  type AcceptedSlice,
  type CookSchedule,
} from "./schedule";
import type { Timer } from "./timer";
import type { EpochMillis } from "./types";

/**
 * committedSchedule — 採用済み PlanSlice と自前解を合成して現在の確定計画を導出する（AC 7.5）。
 *
 * 採用済み計画は時間経過のみでは失効しない。次の状態変化を処理する `decide` の内側でこの関数が走り、
 * 陳腐化しない PlanSlice を維持し、陳腐化した PlanSlice を Baseline_Plan の対応部分で置き換える。
 * 時刻起動の失効判定は設けない（イベント間は推奨が過去時刻のまま表示されて構わない）。
 *
 * **尾部は「切り貼り」ではなく再実行する。** 自前解の後方 PlanSlice は自前解自身の前方配置を前提に解放表を
 * 積んでいる。採用接頭辞の配置がそれと違えば、繋いだ計画は同一 slot の時間帯重複（ハード制約違反）を
 * 起こしうる。「接頭辞の feasibility は自己完結する」は接頭辞**単体**についての主張であり、合成後には及ばない。
 * ゆえに接頭辞の占有で解放表を進め、残りの計画対象に対して baselineSchedule をその表から**再実行**する。
 * 合成後の計画が feasible であることは、この構成から従う（検証は Property 20）。
 *
 * **接頭辞である。** 陳腐化しない一片を拾い集めるのではなく、計画順に見て最初に陳腐化した一片以降を捨てる。
 * 「前方の確定は後方の変化に影響されない」という時間的半順序が採用の単位を接頭辞に定めているため、
 * 途中を飛ばして後方だけを採ると、その一片が前提していた前方の配置がもう無い。
 * accepted は計画順に並んでいることを前提とする（状態が保つ不変条件）。
 *
 * **design の署名からの変更点。** design は `(accepted, pending, running, now, params)` だが、
 * (1) 茹で時間を引くために `presets` を要する（baselineSchedule が同じ理由で受ける・タスク 9.1）。
 * (2) `slotCount` は引数に取らない——`params.unitOrigins` の要素数が unitCount であり（toUnitOrigins が
 *     長さを揃える）、slot 数はそこからの導出値である。引数で受ければ、レイアウトと釜の数という
 *     同じ事実の入口が二つになる。
 */
export function committedSchedule(
  accepted: readonly AcceptedSlice[],
  pending: readonly PendingOrder[],
  running: readonly Timer[],
  now: EpochMillis,
  presets: readonly NoodlePreset[],
  params: ScheduleParams,
): CookSchedule {
  const targets = planTargets(pending);
  const prefix = livePrefix(accepted, targets, now);

  // 解放表は開始済み Timer の占有から始め、接頭辞の配置で順に進める（design の合成手順 2）。
  // 卓の成員表も同じ走行中から引く（「その釜がいつ空くか」と「その卓がいつ上がるか」の二つの表）。
  let release = initialRelease(running, now, params.unitOrigins.length * SLOTS_PER_UNIT);
  for (const slice of prefix) release = advanceRelease(release, slice.placements);
  const members = tableMembers(running);

  // 尾部の対象は「接頭辞が使わなかった計画対象」。全 Pending_Order から除くのではない——それでは
  // 65 件目以降が繰り上がって計画に現れ、計画対象を 64 件に限る AC 11.2 が破れる。
  const remaining = targets.filter((order) => !isPlaced(order, prefix));
  const tail = baselineSchedule(remaining, release, members, presets, params);

  return { slices: [...prefix, ...tail.slices] };
}

/**
 * 採用済み列のうち、計画順に見て最初に陳腐化した一片の手前まで（design の合成手順 1）。
 *
 * 陳腐化は 2 つの理由で立つ。**判定を分けているのは概念が違うから**である。
 *   - `isStale` — 対象品目が計画対象と食い違った（陳腐化A・B）。`admit` と共有する述語（schedule.ts）。
 *   - `hasLapsedStart` — 推奨開始時刻を過ぎた。合成側だけの関心事ゆえここに置く。
 */
function livePrefix(
  accepted: readonly AcceptedSlice[],
  targets: readonly PendingOrder[],
  now: EpochMillis,
): readonly AcceptedSlice[] {
  const stale = accepted.findIndex(
    (slice) => isStale(slice, targets) || hasLapsedStart(slice, now),
  );
  return stale === -1 ? accepted : accepted.slice(0, stale);
}

/**
 * 推奨開始時刻が既に過ぎた一片か。**人が推奨時刻に開始しなかった事実**であり、その前提の上に積んだ
 * 後方も意味を失う（ゆえに接頭辞がここで切れる）。
 *
 * 一片の中の 1 本でも過ぎていれば全体を陳腐化と見る。同一 Table_Group の配置は提供時刻を揃えるために
 * 互いの開始時刻を前提にしているので、1 本だけを落として残りを維持すれば、その一片が主張していた
 * 同時提供はもう成り立たない。
 */
function hasLapsedStart(slice: AcceptedSlice, now: EpochMillis): boolean {
  return slice.placements.some((placement) => placement.startAt < now);
}

/** 接頭辞が既に配置した品目か。品目の同一性は schedule.ts の refersTo ただ一つ。 */
function isPlaced(order: PendingOrder, prefix: readonly AcceptedSlice[]): boolean {
  return prefix.some((slice) => slice.placements.some((placement) => refersTo(placement, order)));
}
