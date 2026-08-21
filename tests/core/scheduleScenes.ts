// tests/core/scheduleScenes.ts — 調理順計画（online-cook-scheduling）の property test が共有する
// 場面の生成器と、Requirement 3 のハード制約の述語。
//
// **ハード制約の述語をここに置く理由が主である。** Property 1（自前解は feasible）と Property 20
// （合成後の計画は feasible）は同じ「feasible とは何か」を主張する。述語を各テストに書けば feasible の
// 定義が二つになり、片方だけを緩めた変更が黙って通る。生成器の共有はその副産物として付いてくる
// （場面の素材——注文・開始済み Timer・パラメータ——も両者で同一である）。
//
// 共有の代償（テスト間の結合）は引き受ける。ここに置くのは「計画の入力空間」と「ハード制約」だけで、
// どちらも spec が定めた対象であってテスト固有の都合ではない。各 property の主張そのもの（何を expect するか）は
// 各テストファイルに残す。

import * as fc from "fast-check";
import {
  baselineSchedule,
  initialRelease,
  refersTo,
  type CookSchedule,
  type Placement,
  type SlotRelease,
} from "../../src/engine/schedule";
import type { ScheduleParams } from "../../src/engine/objective";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import type { PendingOrder } from "../../src/domain/order";
import type { Firmness } from "../../src/domain/firmness";
import {
  AFFINITY_TOLERANCE_DISTANCE_MAX,
  AFFINITY_TOLERANCE_DISTANCE_MIN,
  DEFAULT_NOODLE_PRESETS,
  DEFAULT_SLOT_OFFSETS,
  SYNC_TOLERANCE_SECONDS_MAX,
  SYNC_TOLERANCE_SECONDS_MIN,
  WEIGHT_MAX,
  WEIGHT_MIN,
  defaultUnitOrigins,
  slotOf,
} from "../../src/domain/store";
import { nonEmpty } from "../nonEmpty";

/** 場面の基準時刻。開始済み Timer の endTime も注文の到着時刻もこの点の周りに散らす。 */
export const NOW = 1_700_000_000_000 as EpochMillis;

/** 店が持つ麺種。既定プリセットの 3 種は茹で時間が異なり、提供時刻を揃える逆算の経路を踏む。 */
export const KNOWN_NOODLE_TYPES = DEFAULT_NOODLE_PRESETS.map((preset) => preset.noodleType);

/**
 * プリセットに無い麺種。設定の差し替えを跨いだ永続待ち行列にだけ現れ得る（受理時は弾かれる）。
 * この品目は配置されないが、同じグループの他の品目の feasibility を壊してはならない。
 */
export const UNKNOWN_NOODLE_TYPE = "Ghost";

/** 1 品目の内容（itemIndex は注文内の位置から決定的に振る）。 */
export interface ItemSpec {
  readonly noodleType: string;
  readonly firmness: Firmness;
  readonly tableId: string | null;
}

/** 1 注文の素データ。arrivalTime は注文単位（到着は注文単位で届く）。 */
export interface OrderSpec {
  readonly arrivalTime: number;
  readonly items: readonly ItemSpec[];
}

/** 開始済み Timer 1 本の素データ。走行中と茹で上がり済みの双方を振る。 */
export interface RunningSpec {
  readonly slot: number;
  readonly endOffset: number;
  readonly boiled: boolean;
}

/** 卓の固定集合。同卓に複数注文が乗る形・卓なしの単独グループの双方を高い頻度で踏む。 */
export const TABLE_IDS = ["t-1", "t-2"] as const;

/** 品目の内容。麺種の集合を渡す（未知の麺種を混ぜるかは場面の関心事であって品目の関心事ではない）。 */
export function genItemSpec(noodleTypes: readonly string[]): fc.Arbitrary<ItemSpec> {
  return fc.record({
    noodleType: fc.constantFrom(...noodleTypes),
    firmness: fc.constantFrom<Firmness>("extraHard", "hard", "normal", "soft"),
    tableId: fc.oneof(fc.constantFrom<string>(...TABLE_IDS), fc.constant(null)),
  });
}

/** 1 注文。品目は 1〜4 件（同一オーダー内の同時提供の経路を踏む本数）。 */
export function genOrderSpec(noodleTypes: readonly string[]): fc.Arbitrary<OrderSpec> {
  return fc.record({
    arrivalTime: fc.integer({ min: NOW - 600_000, max: NOW }),
    items: fc.array(genItemSpec(noodleTypes), { minLength: 1, maxLength: 4 }),
  });
}

/** 採点パラメータ。レイアウトは既定（原点は unitCount 個・slot 番号と座標の対応が解放表と一致する）。 */
export function genParams(unitCount: number): fc.Arbitrary<ScheduleParams> {
  return fc.record({
    orderSyncWeight: fc.integer({ min: WEIGHT_MIN, max: WEIGHT_MAX }),
    tableSyncWeight: fc.integer({ min: WEIGHT_MIN, max: WEIGHT_MAX }),
    affinityWeight: fc.integer({ min: WEIGHT_MIN, max: WEIGHT_MAX }),
    orderSyncToleranceSeconds: fc.integer({ min: SYNC_TOLERANCE_SECONDS_MIN, max: SYNC_TOLERANCE_SECONDS_MAX }),
    tableSyncToleranceSeconds: fc.integer({ min: SYNC_TOLERANCE_SECONDS_MIN, max: SYNC_TOLERANCE_SECONDS_MAX }),
    affinityToleranceDistance: fc.integer({
      min: AFFINITY_TOLERANCE_DISTANCE_MIN,
      max: AFFINITY_TOLERANCE_DISTANCE_MAX,
    }),
    unitOrigins: fc.constant(defaultUnitOrigins(unitCount)),
    slotOffsets: fc.constant(DEFAULT_SLOT_OFFSETS),
  });
}

/** 開始済み Timer 1 本の素データ。 */
export function genRunning(slotCount: number): fc.Arbitrary<RunningSpec> {
  return fc.record({
    slot: fc.integer({ min: 0, max: slotCount - 1 }),
    endOffset: fc.integer({ min: -120_000, max: 300_000 }),
    boiled: fc.boolean(),
  });
}

/** 素データから Timer を組む。endTime だけが解放表に効く（noodleType・firmness は関与しない）。 */
export function timerOn(seed: RunningSpec, seq: number): Timer {
  const endTime = (NOW + seed.endOffset) as EpochMillis;
  return createTimer({
    id: `t-${seq}` as TimerId,
    slotIds: nonEmpty([String(seed.slot) as SlotId]),
    noodleType: "Thin" as NoodleType,
    firmness: "normal",
    startTime: (endTime - 60_000) as EpochMillis,
    endTime,
    seq,
    // 茹で上がり済みでも釜は空いている（湯切りで麺が上がる）。解放表がそれを式ひとつで扱うことを踏む。
    boiledAt: seed.boiled && seed.endOffset <= 0 ? endTime : null,
  });
}

/** 注文の素データを PendingOrder 列へ（id は位置から振るので (id, itemIndex) は一意）。 */
export function toPending(orders: readonly OrderSpec[]): readonly PendingOrder[] {
  return orders.flatMap((order, orderIndex) =>
    order.items.map((item, itemIndex) => ({
      externalOrderId: `o-${orderIndex}`,
      itemIndex,
      noodleType: item.noodleType,
      firmness: item.firmness,
      tableId: item.tableId,
      arrivalTime: order.arrivalTime,
      // 本 spec は割り当ての算術を変えず 1 品目 1 スロットで計画する。ゆえに場面も占有幅 1 で組む。
      slotSpan: 1,
    })),
  );
}

/**
 * 外部から届く計画を 1 本組む。**別パラメータ**で、かつ **Table_Group を 1 つ落として**自前解を走らせる。
 *
 * 外部ソルバーを持たずに「現行 Committed_Plan より真に良い計画」を作る手がこれである。落とした group の
 * 品目は計画に現れないだけで待ち行列からは消えない——外部が「この group は後でいい」と判断した計画と
 * 同じ形である。残った一片は落とした group が取らなかった釜を使えるため、対応部分和が真に良くなりうる
 * （段 1 の (d) を通る場面が生まれる）。同時にこれは段 2 が効く場面も作る：落とした group は尾部で
 * 後ろへ倒れるため、部分和が改善しても合成後の総和が悪化する経路を踏む。
 *
 * `dropPick` の剰余が一片数と等しい位置なら何も落とさない（全 group を含む計画も場面に残す）。
 *
 * **ここに置くのは、採用が起きる場面を要する property が複数あるからである。** Property 4 / 5 / 7
 * （admit）と Property 11（冪等）は同じ素材を要する——「改善する外部計画をどう作るか」を各テストに
 * 書けば、片方だけが採用の起きない生成器へ退化しても気づけない。
 */
export function externalPlan(
  pending: readonly PendingOrder[],
  running: readonly Timer[],
  slotCount: number,
  params: ScheduleParams,
  dropPick: number,
): CookSchedule {
  const release = initialRelease(running, NOW, slotCount);
  const full = baselineSchedule(pending, release, DEFAULT_NOODLE_PRESETS, params);
  const victim = full.slices[dropPick % (full.slices.length + 1)];
  const planned =
    victim === undefined
      ? pending
      : pending.filter((order) => !victim.placements.some((placement) => refersTo(placement, order)));
  return baselineSchedule(planned, release, DEFAULT_NOODLE_PRESETS, params);
}

/**
 * 外部から届く計画をもう 1 通り組む。**茹で時間の短い順を到着順に見立てて**自前解を走らせる。
 *
 * 釜が足りない場面では、短い品目を先に茹でるほど待ちの総和が小さくなる（最短処理時間優先＝リスト
 * スケジューリングの古典的な改善）。自前解は到着順に置くため、この順序は自前解が到達しない解であり、
 * **合成後の総和まで真に良い計画**——すなわち段 2 を通る計画——が得られる。
 *
 * `externalPlan`（Table_Group を落とす手）だけでは採用がほとんど起きない。あちらは残った一片の部分和を
 * 改善する一方、落とした group が尾部で後ろへ倒れて総和を悪化させるため、段 2 が大半を棄却する
 * （実測で 200 場面中 1 件しか採用に至らなかった）。採用の起きない場面ばかりでは、採用後の振る舞いを
 * 主張する property（Property 11 の「二度目は動かない」）が空虚に通る。
 *
 * 置換するのは計画を組むための `arrivalTime` だけである。返る配置が指すのは実在の品目（`externalOrderId` /
 * `itemIndex`）であり、採点も判定も呼び出し側の**本物の待ち行列**に対して行われる。
 */
export function shortestFirstPlan(
  pending: readonly PendingOrder[],
  running: readonly Timer[],
  slotCount: number,
  params: ScheduleParams,
): CookSchedule {
  const byBoil = [...pending].sort((order, other) => boilSecondsOf(order) - boilSecondsOf(other));
  // 置き換えるのは arrivalTime だけ（他の 6 属性はそのまま写す）。
  const resequenced: readonly PendingOrder[] = byBoil.map((order, index) => ({
    externalOrderId: order.externalOrderId,
    itemIndex: order.itemIndex,
    noodleType: order.noodleType,
    firmness: order.firmness,
    tableId: order.tableId,
    arrivalTime: NOW - byBoil.length + index,
    slotSpan: order.slotSpan,
  }));
  return baselineSchedule(resequenced, initialRelease(running, NOW, slotCount), DEFAULT_NOODLE_PRESETS, params);
}

/** 品目の茹で時間（秒）。プリセットに無い麺種は最後尾へ回す（そもそも配置されない）。 */
function boilSecondsOf(order: PendingOrder): number {
  const preset = DEFAULT_NOODLE_PRESETS.find((candidate) => candidate.noodleType === order.noodleType);
  return preset === undefined ? Number.MAX_SAFE_INTEGER : preset.boilSeconds[order.firmness];
}

// ────────────────────────────────────────────────────────────────────────────
// ハード制約の述語（Requirement 3 の (a)(b)(c)）。feasible の定義はここだけに置く。
// ────────────────────────────────────────────────────────────────────────────

/** 計画の全配置を平坦に並べる。ハード制約は PlanSlice を跨いで成り立たねばならない。 */
export function allPlacements(
  slices: readonly { readonly placements: readonly Placement[] }[],
): readonly Placement[] {
  return slices.flatMap((slice) => slice.placements);
}

/** (a) 同一 slot に置かれた配置の時間帯 [startAt, serveAt) が重ならないこと。 */
export function hasOverlapOnSameSlot(placements: readonly Placement[]): boolean {
  const bySlot = new Map<number, { start: number; end: number }[]>();
  for (const placement of placements) {
    for (const slotId of placement.slotIds) {
      const slot = slotOf(slotId);
      const spans = bySlot.get(slot);
      const span = { start: placement.startAt, end: placement.serveAt };
      if (spans === undefined) bySlot.set(slot, [span]);
      else spans.push(span);
    }
  }
  for (const spans of bySlot.values()) {
    const ordered = [...spans].sort((span, other) => span.start - other.start);
    for (let i = 1; i < ordered.length; i++) {
      // 前の茹でが上がった時刻に次を始めるのは重複ではない（釜はその瞬間に空く）。
      if (ordered[i]!.start < ordered[i - 1]!.end) return true;
    }
  }
  return false;
}

/** (b) 任意の時点で同時に走る本数が slot 数を超えないこと。境界は各配置の開始時刻でだけ変わる。 */
export function exceedsSlotCount(placements: readonly Placement[], slotCount: number): boolean {
  return placements.some((moment) => {
    const running = placements.filter(
      (placement) => placement.startAt <= moment.startAt && moment.startAt < placement.serveAt,
    );
    return running.length > slotCount;
  });
}

/** (c) 解放表の初期値より前に開始する配置が無いこと（開始済み Timer の占有と実効 endTime を侵さない）。 */
export function startsBeforeRelease(placements: readonly Placement[], release: SlotRelease): boolean {
  return placements.some((placement) =>
    placement.slotIds.some((slotId) => {
      const free = release[slotOf(slotId)];
      // 解放表の外を指す slot はそもそも置き場所ではない（存在しない釜への配置）。
      return free === undefined || placement.startAt < free;
    }),
  );
}
