// engine/objective.ts — 計画の良さを測る純粋関数群。cloudflare:workers にも storage にも触れない。
//
// ここに置くのは「計画をどう採点するか」だけで、計画をどう作るかは schedule.ts の関心事である。
// 採点が整数で閉じることは Acceptance_Gate の改善判定（真に良いか同値か）の前提ゆえ、
// 距離も浮動小数を一切生まない形で持つ。
//
// 採点のパラメータ（ScheduleParams）もここに置く。計画の算出・合成・受け入れも同じ 8 値を要するが、
// それらは採点を経由して要求するのであって、値の意味を定めているのは目的関数である（sync.ts が
// SyncParams を持つのと同じ置き方）。

import {
  SLOTS_PER_UNIT,
  slotOf,
  type GridPoint,
  type SlotOffsets,
  type UnitOrigin,
} from "../domain/store";
import type { PendingOrder } from "../domain/order";
import type { NonEmptyArray } from "../domain/timer";
import type { Placement, PlanSlice } from "./schedule";
import type { SlotId } from "./types";

/**
 * ScheduleParams — 計画の採点に要するパラメータ（値）。shell が StoreConfig から解決して渡す。
 *
 * engine は domain の設定型（StoreConfig）を知らない。StoreConfig をそのまま渡せば、麺プリセットのように
 * 採点と無関係な項目まで engine が引き連れることになる（SyncParams が arms / toleranceRatio だけを受けるのと
 * 同じ規律）。重み 3・許容幅 3・レイアウト 2 のちょうど 8 値が、この計算の全入力である。
 */
export interface ScheduleParams {
  /** w_order。同一オーダーの提供時刻差の超過分に掛かる係数。 */
  readonly orderSyncWeight: number;
  /** w_table。同一 Table_Group の提供時刻差の超過分に掛かる係数。 */
  readonly tableSyncWeight: number;
  /** w_affinity。代表 slot 間距離の超過分に掛かる係数。 */
  readonly affinityWeight: number;
  /** 同一オーダー内の提供時刻差の許容幅（秒）。超過分のみ計上する。 */
  readonly orderSyncToleranceSeconds: number;
  /** 同一 Table_Group 内の提供時刻差の許容幅（秒）。超過分のみ計上する。 */
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
 * scoreSchedule — 計画の目的関数値を Requirement 3 の確定式で算出する（整数・秒換算）。
 *
 * = Σ Wait_Time + w_table × Σ(同卓の提供時刻最大差の許容幅 超過分)
 *   + w_order × Σ(同一オーダーの提供時刻最大差の許容幅 超過分)
 *   + w_affinity × Σ max(0, slotDistance − 許容距離)
 *
 * 3 項すべてが「許容幅からの超過分」で揃い、到達可能な下限 0 を持つ。
 *
 * **Pending_Order 集合を受け取る。** Wait_Time は `serveAt − arrivalTime` だが、Placement は arrivalTime を
 * 持たない（Pending_Order 集合が正本であり、計画が写しを持てば二つの真実になる）。ゆえに起点は集合から引く。
 * 対応する Pending_Order が見つからない配置——アドホック麺茹で由来など、Order_Arrival_Time という事実を
 * 持たないもの——は Σ Wait_Time に寄与しない（Requirement 8 の確定注記）。0 秒待ったと数えるのは嘘であり、
 * 寄与しないことが真である。
 *
 * **入力の一片は score を持たない**（`Omit<PlanSlice, "score">`）。部分和はこの関数の出力であって入力ではない。
 * 完成した PlanSlice を要求すると、baselineSchedule が仮の score を置いてから採点し直す形になり、
 * 一瞬でも嘘の値を持つ計画が存在してしまう。CookSchedule.slices はこの型を構造的に満たすため、外部から
 * 届いた計画（主張された score を含む）をそのまま渡して再採点できる。
 *
 * slotIds は解放表の内側（存在する釜）を指すことを前提とする。ハード制約の検査を通っていない配置を
 * 採点しても意味のある値にはならないため、ここに範囲防御は置かない（slotDistance と同じ規律）。
 */
export function scoreSchedule(
  slices: readonly Omit<PlanSlice, "score">[],
  pending: readonly PendingOrder[],
  params: ScheduleParams,
): ScheduleScore {
  const arrivals = new Map(pending.map((order) => [itemKey(order), order.arrivalTime]));
  const bySlice = slices.map((slice) => scoreSlice(slice.placements, arrivals, params));

  // 全項が Table_Group の内部に閉じるため、総和は部分和の和で尽きる（AC 6.2(d) の部分比較の成立条件）。
  return { total: bySlice.reduce((sum, score) => sum + score, 0), bySlice };
}

/** 一片（Table_Group）の部分和。Σ Wait_Time と 3 つのソフト制約項をこの範囲だけで閉じて足す。 */
function scoreSlice(
  placements: readonly Placement[],
  arrivals: ReadonlyMap<string, number>,
  params: ScheduleParams,
): number {
  return (
    waitSeconds(placements, arrivals) +
    params.tableSyncWeight *
      excessSeconds(serveSpread(placements), params.tableSyncToleranceSeconds) +
    params.orderSyncWeight * orderExcessSeconds(placements, params.orderSyncToleranceSeconds) +
    params.affinityWeight * affinityExcess(placements, params)
  );
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
 * ミリ秒を秒へ落とす。**切り捨て（floor）を採る。**
 *
 * 許容幅は秒で与えられるため、差を秒へ落としてから超過を採る必要がある。切り捨てなら「許容幅ちょうどまでは
 * 超過 0」という境界が厳密に保たれる（切り上げなら 60.001 秒が 61 秒になり、許容幅 60 秒に対して 1 秒の
 * 超過が立ってしまう）。Wait_Time にも同じ規則を用いる——単位を落とす規則を二つ持てば、同じ時間差が
 * 項によって違う秒数になる。client の残り時間表示（format.ts）も同じ切り捨てで、秒未満は人の知覚の粒度に無い。
 */
function toWholeSeconds(millis: number): number {
  return Math.floor(millis / MILLIS_PER_SECOND);
}

/** 品目を指す鍵（externalOrderId × itemIndex）。区切りに文字列に現れない NUL を使い、鍵の衝突を作らない。 */
function itemKey(item: { readonly externalOrderId: string; readonly itemIndex: number }): string {
  return `${item.externalOrderId}\u0000${item.itemIndex}`;
}

/** 縦横 1 マスのコスト。オクタイル距離を整数へ正規化する基準。 */
const STRAIGHT_STEP_COST = 10;

/** 斜め 1 マスの追加コスト。斜め移動は STRAIGHT_STEP_COST + 4 = 14 で、√2 ≈ 1.4 の整数近似になる。 */
const DIAGONAL_EXTRA_COST = 4;

/**
 * slotDistance — 2 つの slot の物理的な近さを測るオクタイル距離の整数版。
 *
 * 合成座標 position(i) = unitOrigins[⌊i / SLOTS_PER_UNIT⌋] + slotOffsets[i % SLOTS_PER_UNIT] を求め、
 * dx = |x₁ − x₂|・dy = |y₁ − y₂| として 10 × max(dx, dy) + 4 × min(dx, dy) を返す。
 *
 * なぜオクタイルか。要求されている順序は「縦横隣接 < 斜め隣接 < 2 マス直線」（10 < 14 < 20）であり、
 * この 1 点で他の候補が落ちる。マンハッタンは斜め隣接と 2 マス直線を同値に見て斜めを遠すぎに扱い、
 * チェビシェフは縦横隣接と斜め隣接を同値に見て斜めを近すぎに扱う。ユークリッドは順序を満たすが
 * 平方根が無理数を生み、改善判定を丸め誤差に晒す（Boil_Sync が整数スケールで決定性を担保するのと同じ規律で退ける）。
 * 二乗ユークリッドは整数で順序も満たすが距離が二次で伸び、Wait_Time（秒）の和と足し合わされる線形の
 * 重み係数と噛み合わない。オクタイルはユークリッドの利点をその欠点なしに得る（誤差は 8% 以内）。
 *
 * レイアウトを引数で受ける（合成座標は導出値ゆえ設定として持たない）。目的関数へ計上するのは
 * ここで得た生の距離ではなく許容距離からの超過分だが、それは呼び出し側（scoreSchedule）の関心事である。
 */
export function slotDistance(
  slot: number,
  other: number,
  unitOrigins: readonly UnitOrigin[],
  slotOffsets: SlotOffsets,
): number {
  const from = position(slot, unitOrigins, slotOffsets);
  const to = position(other, unitOrigins, slotOffsets);
  const dx = Math.abs(from.x - to.x);
  const dy = Math.abs(from.y - to.y);

  return STRAIGHT_STEP_COST * Math.max(dx, dy) + DIAGONAL_EXTRA_COST * Math.min(dx, dy);
}

/**
 * slot 番号から合成座標を導く。
 *
 * 範囲外への防御を置かない。unitOrigins は toUnitOrigins が長さを unitCount へ揃えるため、slot 番号が
 * unitCount × SLOTS_PER_UNIT の内側にある限り原点は必ず在る。オフセットの index は i % SLOTS_PER_UNIT ゆえ
 * 定義上 6 要素タプルの内側に収まる。起こり得ない状態に既定座標を用意すれば、不正な slot 番号が
 * 座標を持ててしまい（嘘をつく計画が作れる）、かつ本当の設定不整合が黙って埋もれる。
 */
function position(
  slot: number,
  unitOrigins: readonly UnitOrigin[],
  slotOffsets: SlotOffsets,
): GridPoint {
  const origin = unitOrigins[Math.floor(slot / SLOTS_PER_UNIT)]!;
  const offset = slotOffsets[slot % SLOTS_PER_UNIT]!;

  return { x: origin.x + offset.x, y: origin.y + offset.y };
}
