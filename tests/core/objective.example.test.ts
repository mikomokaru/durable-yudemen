// engine/objective の具体値の回帰テスト（slotDistance と scoreSchedule）。
//
// 距離尺度の選定理由は「縦横隣接 < 斜め隣接 < 2 マス直線」という順序の要求ひとつに掛かっている。
// 10 / 14 / 20 という値そのものは式を読まないと出てこないため、既定の 3 行 × 2 列のユニットで
// 3 つの代表対を固定する（要件3.4）。順序・対称・自己 0 の全域の主張は Property 17 が担う。
//
// 同じく目的関数も、Property 3・16・19 は「分解される」「整数で閉じる」「許容内は寄与しない」を全域で
// 言うが、式が Requirement 3 の確定式であることは言わない（どの項に何が乗るか、重みがどこに掛かるかは
// 具体値でしか固定できない）。ゆえに 1 つの計画を手計算で置く。

import { describe, it, expect } from "vitest";
import { scoreSchedule, slotDistance, type ScheduleParams } from "../../src/engine/objective";
import type { PlanSlice } from "../../src/engine/schedule";
import type { EpochMillis, SlotId } from "../../src/engine/types";
import type { PendingOrder } from "../../src/domain/order";
import {
  DEFAULT_ARMS,
  DEFAULT_AFFINITY_TOLERANCE_DISTANCE,
  DEFAULT_AFFINITY_WEIGHT,
  DEFAULT_ORDER_SYNC_TOLERANCE_SECONDS,
  DEFAULT_ORDER_SYNC_WEIGHT,
  DEFAULT_SLOT_OFFSETS,
  DEFAULT_TABLE_SYNC_TOLERANCE_SECONDS,
  DEFAULT_TABLE_SYNC_WEIGHT,
  defaultUnitOrigins,
} from "../../src/domain/store";
import { nonEmpty } from "../nonEmpty";

// 既定レイアウトの unit 0 は slot 0..5 → (0,0) (1,0) / (0,1) (1,1) / (0,2) (1,2)。
const origins = defaultUnitOrigins(1);
const distance = (slot: number, other: number) =>
  slotDistance(slot, other, origins, DEFAULT_SLOT_OFFSETS);

describe("slotDistance — 既定レイアウトの代表対", () => {
  it("縦横隣接は 10", () => {
    expect(distance(0, 1)).toBe(10); // (0,0) と (1,0)
    expect(distance(0, 2)).toBe(10); // (0,0) と (0,1)
  });

  it("斜め隣接は 14", () => {
    expect(distance(0, 3)).toBe(14); // (0,0) と (1,1)
  });

  it("2 マス直線は 20", () => {
    expect(distance(0, 4)).toBe(20); // (0,0) と (0,2)
  });
});

const T0 = 1_000_000;

/** 既定値の採点パラメータ（1 ユニット・既定レイアウト）。 */
const PARAMS: ScheduleParams = {
  orderSyncWeight: DEFAULT_ORDER_SYNC_WEIGHT,
  tableSyncWeight: DEFAULT_TABLE_SYNC_WEIGHT,
  affinityWeight: DEFAULT_AFFINITY_WEIGHT,
  arms: DEFAULT_ARMS,
  orderSyncToleranceSeconds: DEFAULT_ORDER_SYNC_TOLERANCE_SECONDS,
  tableSyncToleranceSeconds: DEFAULT_TABLE_SYNC_TOLERANCE_SECONDS,
  affinityToleranceDistance: DEFAULT_AFFINITY_TOLERANCE_DISTANCE,
  unitOrigins: defaultUnitOrigins(1),
  slotOffsets: DEFAULT_SLOT_OFFSETS,
};

/** 配置 1 件。目的関数は提供時刻だけを見るため startAt は整合する値を置くだけ。 */
function placement(input: {
  orderId: string;
  itemIndex: number;
  slot: number;
  serveAtMillis: number;
}) {
  return {
    externalOrderId: input.orderId,
    itemIndex: input.itemIndex,
    slotIds: nonEmpty([String(input.slot) as SlotId]),
    startAt: (input.serveAtMillis - 60_000) as EpochMillis,
    serveAt: input.serveAtMillis as EpochMillis,
  };
}

/** Pending_Order 1 件（Wait_Time の起点を与える）。麺種・硬さ・卓は採点に寄与しない。 */
function pendingItem(orderId: string, itemIndex: number, arrivalTime: number): PendingOrder {
  return {
    externalOrderId: orderId,
    itemIndex,
    noodleType: "Thin",
    firmness: "normal",
    tableId: "table-1",
    arrivalTime,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
  };
}

describe("scoreSchedule — 確定式の内訳", () => {
  // 同一卓に 2 オーダー。オーダー A は 2 品目（提供差 40 秒＝許容 30 秒を 10 秒超過）、オーダー B は 1 品目。
  // 卓の最遅は +300 秒で、各品目の遅れは 180 / 140 / 0 秒（和 320 秒）。slot は 0・1・4。
  const slice: PlanSlice = {
    tableKey: "table-1",
    placements: [
      placement({ orderId: "A", itemIndex: 0, slot: 0, serveAtMillis: T0 + 120_000 }),
      placement({ orderId: "A", itemIndex: 1, slot: 1, serveAtMillis: T0 + 160_000 }),
      placement({ orderId: "B", itemIndex: 0, slot: 4, serveAtMillis: T0 + 300_000 }),
    ],
  };
  const pending = [
    pendingItem("A", 0, T0),
    pendingItem("A", 1, T0),
    pendingItem("B", 0, T0 + 60_000),
  ];

  it("Σ Wait_Time と 4 つのソフト制約項の重み付き和になる", () => {
    // Σ Wait_Time = 120 + 160 + 240 = 520 秒
    // w_table × 卓の遅れの和 = 2 × (180 + 140 + 0) = 640
    // (w_table − 1) × arms 超過 = 1 × 0（同時刻の成員は各 1 本・arms 2 以下）
    // w_order × 超過 = 3 × ((40 − 30) + 0) = 30
    // w_affinity × 超過 = 1 × ((10 − 14 → 0) + (20 − 14 = 6) + (24 − 14 = 10)) = 16
    expect(scoreSchedule([slice], pending, new Map(), PARAMS)).toEqual({
      total: 1206,
      bySlice: [1206],
    });
  });

  it("重みを 0 にした項は消える（Σ Wait_Time だけが残る）", () => {
    const noSoftConstraints = {
      ...PARAMS,
      tableSyncWeight: 0,
      orderSyncWeight: 0,
      affinityWeight: 0,
    };

    expect(scoreSchedule([slice], pending, new Map(), noSoftConstraints).total).toBe(520);
  });

  it("対応する Pending_Order を持たない配置は Σ Wait_Time に寄与しない（ソフト制約項には寄与する）", () => {
    // オーダー B の起点だけを落とす。Wait_Time から 240 秒が消え、同期項と affinity 項は変わらない。
    const withoutOriginOfB = [pendingItem("A", 0, T0), pendingItem("A", 1, T0)];

    expect(scoreSchedule([slice], withoutOriginOfB, new Map(), PARAMS).total).toBe(1206 - 240);
  });

  it("卓の遅れは許容幅を持たず、秒未満でも切り上げて 1 秒以上に数える", () => {
    // 提供差 60.999 秒。卓の遅れは切り上げて 61 秒（× w_table 2 = 122）。かつての許容幅 60 秒は使わない。
    const spread: PlanSlice = {
      tableKey: "table-2",
      placements: [
        placement({ orderId: "C", itemIndex: 0, slot: 0, serveAtMillis: T0 }),
        placement({ orderId: "D", itemIndex: 0, slot: 1, serveAtMillis: T0 + 60_999 }),
      ],
    };
    // 起点を与えず Wait_Time を 0 に、slot 0・1 は縦横隣接ゆえ affinity も 0 にして同期項だけを見る。
    expect(scoreSchedule([spread], [], new Map(), PARAMS).total).toBe(122);

    // 1 ms のずれも 1 秒の遅れとして計上される（ADR-0006・揃った計画を 1 ms 崩した計画が勝てない根拠）。
    const hairline: PlanSlice = {
      tableKey: "table-2",
      placements: [
        placement({ orderId: "C", itemIndex: 0, slot: 0, serveAtMillis: T0 }),
        placement({ orderId: "D", itemIndex: 0, slot: 1, serveAtMillis: T0 + 1 }),
      ],
    };
    expect(scoreSchedule([hairline], [], new Map(), PARAMS).total).toBe(2);
  });

  it("走行中の仲間は錨として卓の遅れに寄与し、Wait_Time には寄与しない", () => {
    // 走行中の仲間が +300 秒で上がる卓に、+120 秒の配置が 1 本。配置の遅れ 180 秒 × 2 = 360。
    // 走行中の待ちは既に実現済みなので Σ Wait_Time には入らない（起点も持たない）。
    const one: PlanSlice = {
      tableKey: "table-1",
      placements: [placement({ orderId: "A", itemIndex: 0, slot: 0, serveAtMillis: T0 + 120_000 })],
    };
    const members = new Map([["table-1", nonEmpty([(T0 + 300_000) as EpochMillis])]]);
    expect(scoreSchedule([one], [], members, PARAMS).total).toBe(360);
    // 卓が違えば成員にならない。
    expect(
      scoreSchedule(
        [one],
        [],
        new Map([["table-9", nonEmpty([(T0 + 300_000) as EpochMillis])]]),
        PARAMS,
      ).total,
    ).toBe(0);
  });

  it("空の計画は 0（Pending_Order が空なら計画も空になる）", () => {
    expect(scoreSchedule([], [], new Map(), PARAMS)).toEqual({ total: 0, bySlice: [] });
  });
});
