// engine/commit.ts — 確定計画（Committed_Plan）の合成。
// cloudflare:workers にも storage にも触れない純粋モジュール。
//
// ここに置くのは「採用済みの計画と自前解をどう繋ぐか」だけである。計画の型と算出は schedule.ts の
// 関心事であり、この関数はそれを一度呼ぶ。採点は呼ばない——採点は比較の時点（admit.ts）の導出であって
// 合成の一部ではない（lift-group-planning 判断 7）。
//
// 確定計画は**導出値**であって状態ではない。正本は採用済み PlanSlice 列（TimerState.acceptedSlices）と
// 現在の Pending_Order / Timer 集合である。ゆえにここに永続する形は現れない。

import { SLOTS_PER_UNIT, occupiedSlotsOf, type NoodlePreset } from "../domain/store";
import type { PendingOrder } from "../domain/order";
import { advanceLifts, initialLifts, liftsOf, withinLiftCap, type LiftTable } from "./lift";
import type { ScheduleParams } from "./objective";
import { tableMembers } from "./project";
import {
  advanceRelease,
  baselineSchedule,
  cannotStart,
  initialRelease,
  isStale,
  keepsAnchor,
  placeableTargets,
  refersTo,
  type AcceptedSlice,
  type CookSchedule,
  type SlotRelease,
} from "./schedule";
import type { TableMembers } from "./project";
import type { ChangeContext } from "./stability";
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
 * (3) `changeContext`（plan-stability Component 5）——尾部の自前解が前回の提案（旧 Shown_Plan）の釜とまとまりを
 *     候補にするための文脈。null は比較の相手なし。接頭辞（採用済み一片）は前回の配置ではなく採用の事実ゆえ
 *     文脈を読まない。
 */
export function committedSchedule(
  accepted: readonly AcceptedSlice[],
  pending: readonly PendingOrder[],
  running: readonly Timer[],
  now: EpochMillis,
  presets: readonly NoodlePreset[],
  params: ScheduleParams,
  changeContext: ChangeContext | null,
): CookSchedule {
  // 計画対象は生きている待ち行列から（期限切れは `planTargets` が `now` で絞る・pending-order-expiry AC 2.1）のうち
  // **置ける品目**（茹で時間が引け・単体で上限に収まる・`placeableTargets`・plan-stability Requirement 7）。接頭辞の
  // `isStale` も尾部の残りも同じ集合を読む——置けない品目を含む卓の一片が「欠落」で常に落ちる経路を閉じる。
  const targets = placeableTargets(pending, now, presets, params);
  // 解放表は開始済み Timer の占有から始め、接頭辞の配置で順に進める（design の合成手順 2）。
  // 卓の成員表も同じ走行中から引く（「その釜がいつ空くか」と「その卓がいつ上がるか」の二つの表）。
  const initial = initialRelease(running, now, params.unitOrigins.length * SLOTS_PER_UNIT);
  const members = tableMembers(running);
  // 「今、開始操作できるか」の事実——Timer（running / boiled とも）の載る釜。解放表（予測・boiled は `now` に空く）
  // とは別に一度だけ作り、接頭辞の失効（開始を妨げる配置）と尾部の自前解の配分（「今」置く品目の釜の選択）が読む
  // （startable-placement 判断 1・8）。client の全釜 idle と同じ domain の述語。
  const occupied = occupiedSlotsOf(running);
  // 上げ表（「店舗全体でいつ上がるか」）も同じ走行中から引く第三の表（lift-group-planning 判断 20）。
  const { prefix, release, lifts } = livePrefix(
    accepted,
    targets,
    now,
    occupied,
    initial,
    initialLifts(running),
    members,
    presets,
    params,
  );

  // 尾部の対象は「接頭辞が使わなかった計画対象」。全 Pending_Order から除くのではない——それでは
  // 65 件目以降が繰り上がって計画に現れ、計画対象を 64 件に限る AC 11.2 が破れる。
  const remaining = targets.filter((order) => !isPlaced(order, prefix));
  const tail = baselineSchedule(
    remaining,
    release,
    members,
    lifts,
    presets,
    params,
    now,
    occupied,
    changeContext,
  );

  return { slices: [...prefix, ...tail.slices] };
}

/**
 * 採用済み列のうち、計画順に見て最初に陳腐化した一片の手前まで（design の合成手順 1）と、その接頭辞で進めた
 * 解放表・上げ表。尾部はその表から再計算する（採用済み一片の上がりを避けて置く・AC 9.14）。
 *
 * 陳腐化は 4 つの理由で立つ。**判定を分けているのは概念が違うから**である。
 *   - `isStale` — 対象品目が計画対象と食い違った（陳腐化A・B）、または配置が品目の現在の slotSpan を
 *     満たさない（v9 で採用された 1 釜の配置は v10 の制約で再検証され、ここで切れる）。`admit` と共有する
 *     述語（schedule.ts）。
 *   - `cannotStart` — 開始できない配置を含む。推奨開始時刻を過ぎた（過去開始）か、開始時刻が来ているのに釜に
 *     Timer が残っている（押せない釜）。採用済み・復元した一片を**保持する**条件（plan-stability 判断 13）で、復元
 *     （retain）と共有する述語（schedule.ts）。生成した計画全体には当てない（待つ配置は合法・AC 1.4）。
 *   - 解放表の feasibility（`feasibleRelease`）はここでは当てない——採用済み一片は採用時にゲートで通っており、その後の
 *     変化（新しい Timer・錨・上げ窓）は上の 4 つが見る（採用済み接頭辞の契約は従来のまま）。
 *   - `keepsAnchor` の否定 — 配置の `anchor` が現在の走行中の仲間の実効 endTime に無い（AC 9.10 (a)）、走行中の
 *     錨が在る卓で pack が集合として合流できていない・窓以外の理由で延期している（(b)〜(d)）、または合流できる
 *     品目を押し出している。採用済み一片は採用時の
 *     錨の上に組まれ、錨は Boil_Sync で動くので、ここで再検証しなければ「1 本目に揃う」という一片の主張が
 *     黙って嘘になる（lift-group-planning 判断 17）——`recommend` は `Placement.anchor` を無条件に運ぶので、
 *     嘘の錨を運ばない保証はここにしか無い。`admit` の (e) と同じ述語。一片ごとに、その一片を置く前の解放表と
 *     上げ表で判定する（ゲートと同じ位置・同じ表）。
 *   - `withinLiftCap` の否定 — 採用済み一片の上がりを、現在の走行中と手前の一片で埋めた上げ表に載せたとき、
 *     当該配置を含む窓が arms + HELPER_ARMS を超える（ハード制約 (f)・AC 9.5・9.14・ADR-0009）。採用時には収まって
 *     いた窓も、その後に始まった無関係な Timer（ラジアルからの開始は上限を検査しない・AC 8.3）で埋まりうる。
 *     走行中だけで超えている窓は当該一片を含まない限り見ない。`admit` の (f) と同じ述語（lift.ts）。
 */
function livePrefix(
  accepted: readonly AcceptedSlice[],
  targets: readonly PendingOrder[],
  now: EpochMillis,
  occupied: ReadonlySet<number>,
  initial: SlotRelease,
  initialLiftTable: LiftTable,
  members: TableMembers,
  presets: readonly NoodlePreset[],
  params: ScheduleParams,
): {
  readonly prefix: readonly AcceptedSlice[];
  readonly release: SlotRelease;
  readonly lifts: LiftTable;
} {
  const prefix: AcceptedSlice[] = [];
  let release = initial;
  let lifts = initialLiftTable;
  for (const slice of accepted) {
    if (isStale(slice, targets) || cannotStart(slice, now, occupied)) break;
    // 仲間が無い卓（null）でも通す——`anchor` の主張（AC 9.10 (a)）は仲間の有無に関わらず述語が見る。
    const siblings = members.get(slice.tableKey) ?? null;
    if (!keepsAnchor(slice.placements, release, lifts, siblings, targets, presets, params)) break;
    if (!withinLiftCap(lifts, liftsOf(slice.placements), params)) break;
    prefix.push(slice);
    release = advanceRelease(release, slice.placements);
    lifts = advanceLifts(lifts, liftsOf(slice.placements));
  }
  return { prefix, release, lifts };
}

/** 接頭辞が既に配置した品目か。品目の同一性は schedule.ts の refersTo ただ一つ。 */
function isPlaced(order: PendingOrder, prefix: readonly AcceptedSlice[]): boolean {
  return prefix.some((slice) => slice.placements.some((placement) => refersTo(placement, order)));
}
