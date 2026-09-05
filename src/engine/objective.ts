// engine/objective.ts — 計画の良さを測る純粋関数群。cloudflare:workers にも storage にも触れない。
//
// ここに置くのは「計画をどう採点するか」だけで、計画をどう作るかは schedule.ts の関心事である。
// 採点が整数で閉じることは Acceptance_Gate の改善判定（真に良いか同値か）の前提ゆえ、
// 距離も浮動小数を一切生まない形で持つ。距離の尺度そのもの（slotDistance）は domain/store.ts が正本で、
// ここは超過分を計上するだけ——client の釜の組も同じ尺度を要るため、engine には置かない
// （lift-group-display Requirement 6.7）。
//
// 採点のパラメータ（ScheduleParams）もここに置く。計画の算出・合成・受け入れも同じ 9 値を要するが、
// それらは採点を経由して要求するのであって、値の意味を定めているのは目的関数である（sync.ts が
// SyncParams を持つのと同じ置き方）。

import { position, slotDistance, slotOf, type SlotOffsets, type UnitOrigin } from "../domain/store";
import type { PendingOrder } from "../domain/order";
import type { NonEmptyArray } from "../domain/timer";
import type { TableMembers } from "./project";
import type { Placement, PlanSlice } from "./schedule";
import type { EpochMillis, SlotId } from "./types";

/**
 * ScheduleParams — 計画の採点に要するパラメータ（値）。shell が StoreConfig から解決して渡す。
 *
 * engine は domain の設定型（StoreConfig）を知らない。StoreConfig をそのまま渡せば、麺プリセットのように
 * 採点と無関係な項目まで engine が引き連れることになる（SyncParams が arms / toleranceRatio だけを受けるのと
 * 同じ規律）。重み 3・arms 1・許容幅 2・距離 1・レイアウト 2 の 9 値が、この計算の全入力である。
 * arms は本数であって重みではない。SyncParams も arms を持つが、SettleParams が両者を継承するので実体は一つで
 * 足りる——値の意味（同時に上がる本数の超過を数える）を定めるのは目的関数の側ゆえ、ここにも置く。
 */
export interface ScheduleParams {
  /** w_order。同一オーダーの提供時刻差の超過分に掛かる係数。 */
  readonly orderSyncWeight: number;
  /** w_table。卓の遅れ（Table_Lag）の和に掛かる係数。arms 超過の重みもここから導く（w_table − 1）。 */
  readonly tableSyncWeight: number;
  /** w_affinity。代表 slot 間距離の超過分に掛かる係数。 */
  readonly affinityWeight: number;
  /** 同時に上げられる本数（腕の本数）。同じ時刻に上がる卓の成員がこれを超えた分を数える。 */
  readonly arms: number;
  /** 同一オーダー内の提供時刻差の許容幅（秒）。超過分のみ計上する。 */
  readonly orderSyncToleranceSeconds: number;
  /**
   * 同一 Table_Group 内の提供時刻差の許容幅（秒）。
   *
   * **本項目を読む計算は無い。** 卓同期の項は許容幅を使わず遅れの和を数える（lift-group-planning 判断 5）。
   * StoreConfig の項目を増減しないため型には残す。撤去候補として online-cook-scheduling の design に記録した。
   */
  readonly tableSyncToleranceSeconds: number;
  /** 許容 slot 距離。超過分のみ計上する。 */
  readonly affinityToleranceDistance: number;
  /** ユニット原点の列。slot 座標は原点とオフセットの合成で導く。 */
  readonly unitOrigins: readonly UnitOrigin[];
  /** ユニット内 slot のオフセット（全ユニット共通）。 */
  readonly slotOffsets: SlotOffsets;
}

/**
 * ScheduleScore — 目的関数値。総和と PlanSlice ごとの部分和。
 *
 * 部分和を返すのは Acceptance_Gate の段 1 が部分和どうしを比べるためで、総和を返すのは段 2 が
 * 合成後の全体値を比べるため。**部分和は入力の slices と同じ index で並ぶ**（PlanSlice を指す鍵を
 * 別に持たない——tableKey を鍵にすると同一の Table_Group が二度現れる計画で部分和が潰れる）。
 */
export interface ScheduleScore {
  /** 計画全体の目的関数値（bySlice の総和に厳密に一致する）。 */
  readonly total: number;
  /** PlanSlice ごとの部分和（入力の slices と同じ順序・同じ長さ）。 */
  readonly bySlice: readonly number[];
}

/**
 * 時刻の単位（ミリ秒）を目的関数の単位（秒）へ落とす除数。
 *
 * 目的関数は秒で閉じる。Wait_Time も許容幅も秒で定義されており（Requirement 3 の確定式）、
 * ミリ秒のまま足すと affinity 項（距離・無単位）が三桁沈んで w_affinity の校正が成立しない。
 */
const MILLIS_PER_SECOND = 1000;

/**
 * scoreSchedule — 計画の目的関数値を算出する（整数・秒換算・lift-group-planning Requirement 2）。
 *
 * = Σ Wait_Time（未着手の配置のみ）
 *   + w_table × Σ Table_Lag（卓の成員＝未着手の配置と同じ卓の走行中 Timer。最遅からの各成員の遅れの和）
 *   + (w_table − 1) × Σ Arms_Overflow（同じ時刻に上がる成員の本数のうち arms を超える分）
 *   + w_order × Σ(同一オーダーの提供時刻最大差の許容幅 超過分)
 *   + w_affinity × Σ max(0, slotDistance − 許容距離)
 *
 * 卓同期の項だけ形が違う。最大差の許容超過では 3 本目以降を揃える得が無く、遅れの和なら w_table > 1 の下で
 * 「揃える方が点が良い」が何本の卓でも成り立つ。揃えることは制約でも保証でもなく、この式の最適点である
 * （ADR-0001）。到達可能な下限 0 は、走行中の仲間が無い卓で成り立つ——走行中が錨より早く上がる卓では
 * その差が Table_Lag に必ず残る。
 *
 * **走行中 Timer を卓の成員として受け取る**（TableMembers・project.ts）。成員の提供時刻は動かせない事実で、
 * 錨として lag に寄与するが、Wait_Time には寄与しない（Placement ではなく、その待ちは既に実現済み）。
 * tableId を持たない走行中はどの卓の成員にもならない——単独キーは NUL 始まりで非空の tableId と一致しない。
 *
 * **Pending_Order 集合を受け取る。** Wait_Time は `serveAt − arrivalTime` だが、Placement は arrivalTime を
 * 持たない（Pending_Order 集合が正本であり、計画が写しを持てば二つの真実になる）。ゆえに起点は集合から引く。
 * 対応する Pending_Order が見つからない配置——アドホック麺茹で由来など、Order_Arrival_Time という事実を
 * 持たないもの——は Σ Wait_Time に寄与しない（Requirement 8 の確定注記）。0 秒待ったと数えるのは嘘であり、
 * 寄与しないことが真である。
 *
 * 一片は点数を持たない。採点は比較の時点（Acceptance_Gate）だけの導出で、配置（baselineSchedule）は
 * 採点を呼ばない。外部から届いた計画もそのまま渡して採点できる。
 *
 * slotIds は解放表の内側（存在する釜）を指すことを前提とする。ハード制約の検査を通っていない配置を
 * 採点しても意味のある値にはならないため、ここに範囲防御は置かない（slotDistance と同じ規律）。
 */
export function scoreSchedule(
  slices: readonly PlanSlice[],
  pending: readonly PendingOrder[],
  members: TableMembers,
  params: ScheduleParams,
): ScheduleScore {
  const arrivals = new Map(pending.map((order) => [itemKey(order), order.arrivalTime]));
  const bySlice = slices.map((slice) =>
    scoreSlice(slice.placements, arrivals, members.get(slice.tableKey) ?? [], params),
  );

  // 全項が卓（Table_Group とその卓の走行中）の内部に閉じるため、総和は部分和の和で尽きる
  // （AC 6.2(d) の部分比較の成立条件）。走行中は一つの卓にしか属さない。
  return { total: bySlice.reduce((sum, score) => sum + score, 0), bySlice };
}

/** 一片（Table_Group）の部分和。Σ Wait_Time と 4 つのソフト制約項をこの範囲だけで閉じて足す。 */
function scoreSlice(
  placements: readonly Placement[],
  arrivals: ReadonlyMap<string, number>,
  memberEnds: readonly EpochMillis[],
  params: ScheduleParams,
): number {
  const serveTimes = [...placements.map((placement) => placement.serveAt), ...memberEnds];
  return (
    waitSeconds(placements, arrivals) +
    params.tableSyncWeight * tableLagSeconds(serveTimes) +
    armsOverflowWeight(params) * armsOverflow(serveTimes, params.arms) +
    params.orderSyncWeight * orderExcessSeconds(placements, params.orderSyncToleranceSeconds) +
    params.affinityWeight * affinityExcess(placements, params)
  );
}

/**
 * 卓の遅れ（Table_Lag）の和（秒）。最遅の提供時刻から各成員の提供時刻までの差を、成員ごとに切り上げて足す。
 *
 * 切り上げは意図である（ADR-0006）。切り捨てで揃えると、揃った計画の 1 本を 1 ms だけ早めた計画が
 * Wait_Time の切り捨てを 1 減らし lag を増やさず「真に良い」を作り、Acceptance_Gate を通る。client は
 * serveAt の等号で群を組むので、その 1 ms で群が割れる。切り上げなら任意の Δ > 0 に対し lag が
 * w_table × ceil(Δ) 増え、wait の節約は高々 ceil(Δ) なので、w_table ≥ 2 の下で常に損になる。
 * 差がちょうど 0 のときだけ 0 になることは切り上げでも保たれる（下限 0 は破れない）。
 */
function tableLagSeconds(serveTimes: readonly number[]): number {
  if (serveTimes.length === 0) return 0;
  const latest = Math.max(...serveTimes);
  let total = 0;
  for (const serveAt of serveTimes) total += ceilSeconds(latest - serveAt);
  return total;
}

/**
 * arms 超過（Arms_Overflow）。同じ提供時刻に上がる成員を束ね、本数のうち arms を超える分を足す。
 *
 * 「群の本数」ではなく同時刻で数える——腕が競合するのは同時刻だけで、batch に割れて同時に上がらない本数は
 * 数えない。卓同期の項と同じ成員集合（走行中を含む）の上で数える。
 */
function armsOverflow(serveTimes: readonly number[], arms: number): number {
  const counts = new Map<number, number>();
  for (const serveAt of serveTimes) counts.set(serveAt, (counts.get(serveAt) ?? 0) + 1);
  let total = 0;
  for (const count of counts.values()) total += Math.max(0, count - arms);
  return total;
}

/**
 * arms 超過の重み。設定にも定数にもせず w_table から導く（lift-group-planning 判断 8）。
 *
 * 任意の w_table ≥ 1 で「卓同期 > arms 超過」が式から出る——arms 超過は卓の群を組むときにだけ生まれる費用で、
 * 群を組む価値の一段下に群を組む代償を置く。単位は秒 対 本数で既定（w_table = 2）では 1 本 1 秒に相当し、
 * 実質はタイブレークである。効かせるには「arms を超えた 1 本が上げ遅れる秒数」という計測値が要る。
 */
function armsOverflowWeight(params: ScheduleParams): number {
  return Math.max(0, params.tableSyncWeight - 1);
}

/** Σ Wait_Time（秒）。起点を持たない配置は寄与しない。 */
function waitSeconds(
  placements: readonly Placement[],
  arrivals: ReadonlyMap<string, number>,
): number {
  let total = 0;
  for (const placement of placements) {
    const arrivalTime = arrivals.get(itemKey(placement));
    if (arrivalTime === undefined) continue;
    total += toWholeSeconds(placement.serveAt - arrivalTime);
  }
  return total;
}

/** 同一オーダーごとの提供時刻差の超過分の和（秒）。オーダー内は Table_Group 内に含まれる。 */
function orderExcessSeconds(placements: readonly Placement[], toleranceSeconds: number): number {
  const byOrder = new Map<string, Placement[]>();
  for (const placement of placements) {
    const group = byOrder.get(placement.externalOrderId);
    if (group === undefined) byOrder.set(placement.externalOrderId, [placement]);
    else group.push(placement);
  }
  let total = 0;
  for (const group of byOrder.values()) {
    total += excessSeconds(serveSpread(group), toleranceSeconds);
  }
  return total;
}

/** グループ内の全ペアについて、代表 slot 間距離の許容超過分を足す。 */
function affinityExcess(placements: readonly Placement[], params: ScheduleParams): number {
  const representatives = placements.map((placement) =>
    representativeSlot(placement.slotIds, params),
  );
  let total = 0;
  for (let i = 0; i < representatives.length; i++) {
    for (let j = i + 1; j < representatives.length; j++) {
      const distance = slotDistance(
        representatives[i]!,
        representatives[j]!,
        params.unitOrigins,
        params.slotOffsets,
      );
      total += Math.max(0, distance - params.affinityToleranceDistance);
    }
  }
  return total;
}

/**
 * 品目の代表 slot ＝ slotIds のうち座標の辞書式最小（y, x, slot 番号）。
 *
 * 複数 slot 占有は例外的であり代表点で足りる。最小距離や重心を採ると距離が slot 数に依存して
 * w_affinity の効きがぶれる。同座標の並びは slot 番号で断ち、代表の選択を決定的にする。
 */
function representativeSlot(slotIds: NonEmptyArray<SlotId>, params: ScheduleParams): number {
  let best = slotOf(slotIds[0]);
  let bestAt = position(best, params.unitOrigins, params.slotOffsets);
  for (const slotId of slotIds) {
    const slot = slotOf(slotId);
    const at = position(slot, params.unitOrigins, params.slotOffsets);
    if (
      at.y < bestAt.y ||
      (at.y === bestAt.y && (at.x < bestAt.x || (at.x === bestAt.x && slot < best)))
    ) {
      best = slot;
      bestAt = at;
    }
  }
  return best;
}

/** 配置群の提供時刻の最大差（ミリ秒）。空群と単独は 0。 */
function serveSpread(placements: readonly Placement[]): number {
  if (placements.length === 0) return 0;
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const placement of placements) {
    if (placement.serveAt < earliest) earliest = placement.serveAt;
    if (placement.serveAt > latest) latest = placement.serveAt;
  }
  return latest - earliest;
}

/** ミリ秒差のうち許容幅（秒）を超えた分（秒）。許容幅ちょうどまでは 0。 */
function excessSeconds(spreadMillis: number, toleranceSeconds: number): number {
  return Math.max(0, toWholeSeconds(spreadMillis) - toleranceSeconds);
}

/**
 * ミリ秒を秒へ落とす（水準の側）。**切り捨て（floor）を採る。**
 *
 * 許容幅は秒で与えられるため、差を秒へ落としてから超過を採る必要がある。切り捨てなら「許容幅ちょうどまでは
 * 超過 0」という境界が厳密に保たれる（切り上げなら 60.001 秒が 61 秒になり、許容幅 60 秒に対して 1 秒の
 * 超過が立ってしまう）。Wait_Time にも同じ規則を用いる。client の残り時間表示（format.ts）も同じ切り捨てで、
 * 秒未満は人の知覚の粒度に無い。
 *
 * 単位を落とす規則は役割で二つに分かれる。水準（どれだけ待ったか・どれだけ超えたか）は切り捨て、逸脱の罰
 * （Table_Lag）は切り上げ（ceilSeconds）。ゼロでない逸脱をすべて 1 秒以上に数えなければ「ずらす得」が残る。
 */
function toWholeSeconds(millis: number): number {
  return Math.floor(millis / MILLIS_PER_SECOND);
}

/** ミリ秒を秒へ落とす（逸脱の罰の側）。切り上げ。理由は tableLagSeconds と ADR-0006。 */
function ceilSeconds(millis: number): number {
  return Math.ceil(millis / MILLIS_PER_SECOND);
}

/** 品目を指す鍵（externalOrderId × itemIndex）。区切りに文字列に現れない NUL を使い、鍵の衝突を作らない。 */
function itemKey(item: { readonly externalOrderId: string; readonly itemIndex: number }): string {
  return `${item.externalOrderId}\u0000${item.itemIndex}`;
}
