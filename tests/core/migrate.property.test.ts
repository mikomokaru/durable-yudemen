// tests/core/migrate.property.test.ts — migrate と永続境界の Property。
//
// **どの spec のどの面を守るかは、各 describe の見出しが正本である。** ここに一覧を写さないのは、
// 版が上がるたびに面が増える場所であり、写しは必ず古くなるからである（実際、v9 → v12 の 3 面が
// 抜けたまま「3 つの Property」と名乗っていた）。ファイル全体に共通する前提だけをここに書く。
//
// **品目集合を組む生成器は鍵一意（`fc.uniqueArray(..., { selector: itemKeyOf })`）である。** 重複鍵は
// `MigrationFailed` になる契約（order-item-truncation AC 4.5）なので、移行の成功を要求する面に重複を
// 与えれば偽陽性で落ちる。重複を与える面は専用の property が別に持つ。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { migrate } from "../../src/engine/migrate";
import { fromSnapshot, toSnapshot } from "../../src/engine/snapshot";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import { createTimer } from "../../src/engine/timer";
import { CURRENT_SCHEMA_VERSION } from "../../src/engine/types";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { FIRMNESS_ORDER } from "../../src/domain/firmness";
import { SLOT_SPAN_MIN } from "../../src/domain/store";
import { compareArrival, itemKeyOf } from "../../src/domain/order";
import { ORDER_ITEM_LIMIT } from "../../src/engine/pending";
import { shuffleBySeed } from "./generators";

/** version > 現行スキーマの永続データ。timers/nextSeq の妥当性に関わらず UnsupportedSchemaVersion になる。 */
const genUnsupported = fc
  .integer({ min: CURRENT_SCHEMA_VERSION + 1, max: 100_000 })
  .map((version) => ({
    raw: { version, timers: [], nextSeq: 0 } as unknown,
    expected: "UnsupportedSchemaVersion" as const,
  }));

/** スナップショットとして解釈できない壊れたデータ。MigrationFailed になる。 */
const genCorrupt = fc
  .oneof(
    // 非オブジェクトのプリミティブ（null/undefined は「未保存」扱いなので除く）。
    fc.oneof(fc.integer(), fc.string({ minLength: 1 }), fc.boolean()),
    // version は妥当だが timers が配列でない。
    fc.record({
      version: fc.constant(1),
      timers: fc.oneof(fc.string(), fc.integer(), fc.constant({})),
      nextSeq: fc.nat(),
    }),
    // version・timers は形を満たすが、要素 Timer が壊れている（id が文字列でない）。
    fc.record({ version: fc.constant(1), timers: fc.constant([{ id: 123 }]), nextSeq: fc.nat() }),
    // timers は妥当だが nextSeq が負または非整数。
    fc.record({
      version: fc.constant(1),
      timers: fc.constant([]),
      nextSeq: fc.constantFrom(-1, -5, 1.5, 2.7),
    }),
  )
  .map((raw) => ({ raw: raw as unknown, expected: "MigrationFailed" as const }));

describe("core/migrate", () => {
  // Feature: yude-men-timer, Property 13: migrate は version 不整合時に元データ不変でエラーを返す。
  // version > 1 で UnsupportedSchemaVersion、壊れたデータで MigrationFailed、いずれも入力不変。
  it("Property 13: version 不整合・移行失敗でエラーを返し、入力 raw を一切変更しない", () => {
    fc.assert(
      fc.property(fc.oneof(genUnsupported, genCorrupt), ({ raw, expected }) => {
        const before = structuredClone(raw);
        const result = migrate(raw);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.failure.code).toBe(expected);
        }
        // 失敗時も入力データを一切変更しない（移行を確定しない・要件11.5 / 11.6）。
        expect(raw).toEqual(before);
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 12（pos-order-ingress / slot-suggested-start）— 移行は既存の挙動を保つ。
//
// migrate.example.test.ts が v7 → v8 を点で固定するのに対し、ここは**任意の** v7 スナップショットに対して
// 成り立つことを面で押さえる。置き場は `migrate` が `src/engine/` にあることに従い `tests/core/` とする
// （既存の migrate テスト 2 本と同じ場所に置き、移行の検証を 1 箇所に集める）。
// ---------------------------------------------------------------------------

/** v7 の Timer 一件（v7 は orderItem まで持ち、slotSpan / 判定材料の語彙を持たない）。 */
const genV7Timer = fc.record({
  id: fc.string({ minLength: 1, maxLength: 8 }),
  slotIds: fc.array(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 3 }),
  noodleType: fc.constantFrom("Thin", "Medium", "Thick"),
  firmness: fc.constantFrom(...FIRMNESS_ORDER),
  startTime: fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }),
  endTime: fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }),
  seq: fc.nat({ max: 1000 }),
  boiledAt: fc.option(fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }), {
    nil: null,
  }),
  adjustment: fc.integer({ min: -60_000, max: 60_000 }),
  orderItem: fc.option(
    fc.record({
      externalOrderId: fc.string({ minLength: 1, maxLength: 8 }),
      itemIndex: fc.nat({ max: 9 }),
    }),
    { nil: null },
  ),
});

/** v7 の待ち行列 1 件。**slotSpan を持たない**（それが v7 であることの定義そのものである）。 */
const genV7PendingOrder = fc.record({
  externalOrderId: fc.string({ minLength: 1, maxLength: 10 }),
  itemIndex: fc.nat({ max: 9 }),
  noodleType: fc.constantFrom("Thin", "Medium", "Thick"),
  firmness: fc.constantFrom(...FIRMNESS_ORDER),
  tableId: fc.option(fc.string({ minLength: 1, maxLength: 6 }), { nil: null }),
  arrivalTime: fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }),
});

/** v7 の採用済み計画。v8 で形が変わらないため、版上げが触らないことの確認材料になる。 */
const genV7AcceptedSlice = fc.record({
  tableKey: fc.string({ minLength: 1, maxLength: 6 }),
  placements: fc.array(
    fc.record({
      externalOrderId: fc.string({ minLength: 1, maxLength: 8 }),
      itemIndex: fc.nat({ max: 9 }),
      slotIds: fc.array(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 2 }),
      startAt: fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }),
      serveAt: fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }),
    }),
    { maxLength: 2 },
  ),
  score: fc.integer({ min: -1000, max: 1000 }),
});

/** v7 の永続スナップショット。v8 で増える 2 つ（slotSpan・lastSequenceByTerminal）をどこにも持たない。 */
const genV7Snapshot = fc.record({
  version: fc.constant(7),
  timers: fc.array(genV7Timer, { maxLength: 3 }),
  nextSeq: fc.nat({ max: 1000 }),
  // 鍵が重複すれば移行失敗になる（order-item-truncation AC 4.5）ので、成功を要求する面では
  // 鍵一意な集合だけを生成する。重複を与える面は専用の property で別に持つ。
  pendingOrders: fc.uniqueArray(genV7PendingOrder, { maxLength: 4, selector: itemKeyOf }),
  acceptedSlices: fc.array(genV7AcceptedSlice, { maxLength: 2 }),
  requestedDigest: fc.option(fc.integer({ min: 0, max: 1_000_000 }), { nil: null }),
});

/** 計時の事実だけを取り出す（版上げが走行中の釜の挙動を変えないことの比較対象）。 */
function boilFacts(timer: { endTime: number; adjustment: number; boiledAt: number | null }) {
  return { endTime: timer.endTime, adjustment: timer.adjustment, boiledAt: timer.boiledAt };
}

describe("core/migrate — v7 → v8 の面", () => {
  // Feature: pos-order-ingress, Property 12: 移行は既存の挙動を保つ
  // **Validates: Requirements 6.25, 13.5**
  //
  // v7 の待ち行列は麺量の語彙を持たず、現に 1 品目 1 スロットで計画されていた。ゆえに欠如を 1 で埋めるのが
  // 当時の実際の挙動に一致する。判定材料は空から始める——v7 以前は取り込み経路が存在せず、材料を持つ端末が
  // 無い。空なら最初の Record が必ず受理され、以降は単調性が効く。
  it("Property 12: 任意の v7 スナップショットで slotSpan は 1 になり、判定材料は空になる", () => {
    fc.assert(
      fc.property(genV7Snapshot, (v7) => {
        // 生成器が v8 の語彙を混ぜていないことを先に確かめる（混ざれば以降の主張が意味を失う）。
        expect("lastSequenceByTerminal" in v7).toBe(false);
        expect(v7.pendingOrders.some((order) => "slotSpan" in order)).toBe(false);
        expect(v7.pendingOrders.some((order) => "itemName" in order)).toBe(false);

        const raw = structuredClone(v7) as unknown;
        const result = migrate(raw);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.snapshot.version).toBe(CURRENT_SCHEMA_VERSION);
        expect(result.snapshot.orderItems).toHaveLength(v7.pendingOrders.length);
        for (const order of result.snapshot.orderItems) expect(order.slotSpan).toBe(SLOT_SPAN_MIN);
        expect(result.snapshot.lastSequenceByTerminal).toEqual({});
      }),
      { numRuns: 300 },
    );
  });

  // Feature: pos-order-ingress, Property 12: 移行は既存の挙動を保つ
  // **Validates: Requirements 6.25, 13.5**
  //
  // 埋めた 2 つ以外は写しである。版上げが既存の待ち行列・採用済み計画・計時の事実を書き換えないことが
  // 「既存の挙動を保つ」の残りの半分である。
  it("Property 12: 埋めた 2 つ以外の事実は写しで、入力は不変である", () => {
    fc.assert(
      fc.property(genV7Snapshot, (v7) => {
        const raw = structuredClone(v7) as unknown;
        const result = migrate(raw);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // slotSpan を除いた待ち行列は v7 の値そのままである。
        // v9 が埋めるのは 3 つ（slotSpan・itemName・sizeName）、v13 が埋めるのは 2 つ（completedAt・interruptedAt）。
        // 埋めた分を除いた残りが写しであることを問う。
        expect(
          result.snapshot.orderItems.map(
            ({
              slotSpan: _span,
              itemName: _item,
              sizeName: _size,
              completedAt: _completed,
              interruptedAt: _interrupted,
              ...rest
            }) => rest,
          ),
        ).toEqual(v7.pendingOrders);
        // v10 で一片は点数を持たない。v7 の score は余剰として捨てられ、v11 が配置に埋める anchor（null）を
        // 除けば写しである。
        expect(result.snapshot.acceptedSlices).toEqual(
          v7.acceptedSlices.map(({ score: _score, ...rest }) => ({
            ...rest,
            placements: rest.placements.map((placement) => ({ ...placement, anchor: null })),
          })),
        );
        expect(result.snapshot.requestedDigest).toBe(v7.requestedDigest);
        expect(result.snapshot.nextSeq).toBe(v7.nextSeq);
        // 計時の事実（endTime / adjustment / boiledAt）に一切触れない。
        expect(result.snapshot.timers.map(boilFacts)).toEqual(v7.timers.map(boilFacts));
        // 移行は入力を書き換えない（失敗時と同じ規律を成功時にも保つ）。
        expect(raw).toEqual(v7);
      }),
      { numRuns: 300 },
    );
  });
});

// Adjustment を 0 だけに偏らせないため、符号ごとの領域を明示して往復境界を踏む。
const genAdjustment = fc.oneof(
  fc.integer({ min: -60_000, max: -1 }),
  fc.constant(0),
  fc.integer({ min: 1, max: 60_000 }),
);

const genAdjustmentTimerSpec = fc.record({
  startTime: fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }),
  boilDuration: fc.integer({ min: 1, max: 1_800_000 }),
  adjustment: genAdjustment,
  boiled: fc.boolean(),
});

const genAdjustmentState: fc.Arbitrary<TimerState> = fc
  .array(genAdjustmentTimerSpec, { maxLength: 30 })
  .map((specs) => {
    const timers = specs.map((spec, index) => {
      const endTime = spec.startTime + spec.boilDuration;
      return createTimer({
        id: `adjustment-${index}` as TimerId,
        slotIds: [`slot-${index}` as SlotId],
        noodleType: "migration-noodle" as NoodleType,
        firmness: "normal",
        startTime: spec.startTime as EpochMillis,
        endTime: endTime as EpochMillis,
        orderItem: null,
        seq: index,
        boiledAt: spec.boiled ? (endTime as EpochMillis) : null,
        adjustment: spec.adjustment,
      });
    });
    return {
      timers,
      nextSeq: timers.length,
      orderItems: EMPTY_STATE.orderItems,
      acceptedSlices: EMPTY_STATE.acceptedSlices,
      requestedDigest: EMPTY_STATE.requestedDigest,
      lastSequenceByTerminal: EMPTY_STATE.lastSequenceByTerminal,
      shownPlan: EMPTY_STATE.shownPlan,
    };
  });

describe("core/migrate — Adjustment snapshot round-trip", () => {
  // Feature: synchronized-boil-adjustment, Migration: Adjustment v5→current
  // **Validates: Requirements 4.5**
  it("現行 snapshot の往復で各 Timer の符号付き Adjustment を id ごとに保存する", () => {
    fc.assert(
      fc.property(genAdjustmentState, (state) => {
        const restored = fromSnapshot(toSnapshot(state));
        const adjustmentById = new Map(state.timers.map((timer) => [timer.id, timer.adjustment]));

        expect(restored.timers).toHaveLength(state.timers.length);
        for (const timer of restored.timers) {
          expect(timer.adjustment).toBe(adjustmentById.get(timer.id));
        }
        expect(restored).toEqual(state);
      }),
      { numRuns: 200 },
    );
  });
});

describe("Feature: order-lifecycle, Requirement 6.1 / 性質 7.9: v12 → v13 は品目を落とさず、往復は同一", () => {
  /** v12 の待ち行列 1 件（厨房の事実を持たない）。 */
  const genV12Order = fc.record({
    externalOrderId: fc.string({ minLength: 1, maxLength: 6 }),
    itemIndex: fc.nat({ max: 3 }),
    noodleType: fc.constantFrom("Thin", "Medium", "Thick"),
    firmness: fc.constantFrom(...FIRMNESS_ORDER),
    tableId: fc.option(fc.string({ minLength: 1, maxLength: 4 }), { nil: null }),
    arrivalTime: fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }),
    slotSpan: fc.integer({ min: SLOT_SPAN_MIN, max: 6 }),
    itemName: fc.option(fc.string({ minLength: 1, maxLength: 4 }), { nil: null }),
    sizeName: fc.option(fc.string({ minLength: 1, maxLength: 4 }), { nil: null }),
  });
  /** v13 の品目（厨房の事実は null か時刻）。 */
  const genV13Order = genV12Order.chain((order) =>
    fc
      .record({
        completedAt: fc.option(fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }), {
          nil: null,
        }),
        interruptedAt: fc.option(fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }), {
          nil: null,
        }),
      })
      .map((facts) => ({ ...order, ...facts })),
  );

  it("v12 の pendingOrders は同じ件数・同じ並びで orderItems に読み替えられ、厨房の事実は null になる", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(genV12Order, { maxLength: 5, selector: itemKeyOf }),
        (pendingOrders) => {
          const result = migrate({ version: 12, timers: [], nextSeq: 0, pendingOrders });
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.snapshot.version).toBe(CURRENT_SCHEMA_VERSION);
          expect(result.snapshot.orderItems).toEqual(
            pendingOrders.map((order) => ({ ...order, completedAt: null, interruptedAt: null })),
          );
          expect(result.snapshot).not.toHaveProperty("pendingOrders");
        },
      ),
      { numRuns: 200 },
    );
  });

  it("現行 snapshot の往復（toSnapshot → migrate → fromSnapshot）は品目の厨房の事実を含めて同一", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(genV13Order, { maxLength: 5, selector: itemKeyOf }),
        (orderItems) => {
          const state: TimerState = { ...EMPTY_STATE, orderItems };
          const result = migrate(structuredClone(toSnapshot(state)));
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(fromSnapshot(result.snapshot)).toEqual(state);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("Feature: slot-suggested-start, Property 9: 移行は品目を落とさない", () => {
  /** v8 の待ち行列 1 件（商品名を持たない）。 */
  const genV8Order = fc.record({
    externalOrderId: fc.string({ minLength: 1, maxLength: 6 }),
    itemIndex: fc.nat({ max: 3 }),
    noodleType: fc.constantFrom("Thin", "Medium", "Thick"),
    firmness: fc.constantFrom(...FIRMNESS_ORDER),
    tableId: fc.option(fc.string({ minLength: 1, maxLength: 4 }), { nil: null }),
    arrivalTime: fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }),
    slotSpan: fc.integer({ min: SLOT_SPAN_MIN, max: 6 }),
  });

  it("版 8 の永続値は 2 項目が null になり、件数と他の事実は保たれる", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(genV8Order, { maxLength: 5, selector: itemKeyOf }),
        (pendingOrders) => {
          const v8 = {
            version: 8,
            timers: [],
            nextSeq: 0,
            pendingOrders,
            lastSequenceByTerminal: {},
          };
          const result = migrate(structuredClone(v8));
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          // 件数は変わらない——名前が読めないことは品目を落とす理由にならない。
          expect(result.snapshot.orderItems).toHaveLength(pendingOrders.length);
          for (const [index, order] of result.snapshot.orderItems.entries()) {
            expect(order.itemName).toBeNull();
            expect(order.sizeName).toBeNull();
            // 埋めた 2 つ（と v13 の厨房の事実 2 つ）以外は写しである。
            const {
              itemName: _item,
              sizeName: _size,
              completedAt: _completed,
              interruptedAt: _interrupted,
              ...rest
            } = order;
            expect(rest).toEqual(pendingOrders[index]);
          }
          expect(result.snapshot.version).toBe(CURRENT_SCHEMA_VERSION);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("空文字の商品名を持つ永続値は移行失敗にする（自分が書いた値の形が違う）", () => {
    // 取り込みが null へ畳む以上、永続に空文字は在りえない。在れば自分の不具合であり、黙って
    // 読み替えれば壊れた値が正本へ入る。
    const broken = {
      version: 9,
      timers: [],
      nextSeq: 0,
      pendingOrders: [
        {
          externalOrderId: "o-1",
          itemIndex: 0,
          noodleType: "Thin",
          firmness: "normal",
          tableId: null,
          arrivalTime: 1_700_000_000_000,
          slotSpan: 1,
          itemName: "",
          sizeName: null,
          completedAt: null,
          interruptedAt: null,
        },
      ],
      lastSequenceByTerminal: {},
    };
    expect(migrate(broken).ok).toBe(false);
  });
});

// ── lift-group-planning — v10 の移行は二方向（tableId の追加・score の除去） ──────────────────────

/** v9 の Timer。orderItem は卓を持たない（それが v9 であることの定義）。 */
const genV9Timer = fc.record({
  id: fc.string({ minLength: 1, maxLength: 8 }),
  slotIds: fc.array(fc.string({ minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 2 }),
  noodleType: fc.constantFrom("Thin", "Medium", "Thick"),
  firmness: fc.constantFrom(...FIRMNESS_ORDER),
  startTime: fc.integer({ min: 1_600_000_000_000, max: 1_700_000_000_000 }),
  endTime: fc.integer({ min: 1_700_000_000_001, max: 1_800_000_000_000 }),
  seq: fc.nat({ max: 1000 }),
  boiledAt: fc.constant(null),
  adjustment: fc.integer({ min: -60_000, max: 60_000 }),
  orderItem: fc.option(
    fc.record({
      externalOrderId: fc.string({ minLength: 1, maxLength: 8 }),
      itemIndex: fc.nat({ max: 9 }),
    }),
    { nil: null },
  ),
});

const genV9Snapshot = fc.record({
  version: fc.constant(9),
  timers: fc.array(genV9Timer, { maxLength: 4 }),
  nextSeq: fc.nat({ max: 1000 }),
  pendingOrders: fc.constant([]),
  acceptedSlices: fc.array(genV7AcceptedSlice, { maxLength: 3 }),
  requestedDigest: fc.constant(null),
  lastSequenceByTerminal: fc.constant({}),
});

describe("core/migrate — v9 → v10 の面（lift-group-planning）", () => {
  // Feature: lift-group-planning, Property 5 — 移行（追加）
  // **Validates: Requirements 3.7, 7.5**
  it("Property 5: v9 の Timer は orderItem.tableId = null として保持され、落ちない", () => {
    fc.assert(
      fc.property(genV9Snapshot, (v9) => {
        const result = migrate(structuredClone(v9));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.snapshot.timers).toHaveLength(v9.timers.length);
        result.snapshot.timers.forEach((timer, index) => {
          const before = v9.timers[index]!.orderItem;
          expect(timer.orderItem).toEqual(before === null ? null : { ...before, tableId: null });
        });
      }),
      { numRuns: 200 },
    );
  });

  // Feature: lift-group-planning, Property 6 — 移行（除去）
  // **Validates: Requirements 3.7, 7.6**
  //
  // v9 の採用済み一片は score を持つ。v10 はそれを読まずに捨てる。整数性の検査を外し忘れた実装は
  // ここで落ちる（v10 の永続データが全滅する種類の失敗）。
  it("Property 6: v9 の AcceptedSlice は score を捨てて保持され、落ちない", () => {
    fc.assert(
      fc.property(genV9Snapshot, (v9) => {
        const result = migrate(structuredClone(v9));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.snapshot.acceptedSlices).toEqual(
          v9.acceptedSlices.map(({ score: _score, ...rest }) => ({
            ...rest,
            placements: rest.placements.map((placement) => ({ ...placement, anchor: null })),
          })),
        );
        for (const slice of result.snapshot.acceptedSlices) {
          expect(slice).not.toHaveProperty("score");
        }
      }),
      { numRuns: 200 },
    );
  });

  it("v10 の永続値（score を持たない一片）はそのまま読める", () => {
    fc.assert(
      fc.property(genV9Snapshot, (v9) => {
        const v10 = {
          ...v9,
          version: 10,
          acceptedSlices: v9.acceptedSlices.map(({ score: _score, ...rest }) => rest),
        };
        const result = migrate(structuredClone(v10));
        expect(result.ok).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

// ── lift-group-planning — v11 の移行は二方向（v10 の配置に anchor を埋める・v11 の anchor を保つ） ──────────

/** v10 の採用済み一片。配置は anchor を持たない（それが v10 であることの定義）。 */
const genV10AcceptedSlice = fc.record({
  tableKey: fc.string({ minLength: 1, maxLength: 6 }),
  placements: fc.array(
    fc.record({
      externalOrderId: fc.string({ minLength: 1, maxLength: 8 }),
      itemIndex: fc.nat({ max: 9 }),
      slotIds: fc.array(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 2 }),
      startAt: fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }),
      serveAt: fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }),
    }),
    { maxLength: 3 },
  ),
});

const genV10Snapshot = fc.record({
  version: fc.constant(10),
  timers: fc.array(genV9Timer, { maxLength: 3 }),
  nextSeq: fc.nat({ max: 1000 }),
  pendingOrders: fc.constant([]),
  acceptedSlices: fc.array(genV10AcceptedSlice, { maxLength: 3 }),
  requestedDigest: fc.constant(null),
  lastSequenceByTerminal: fc.constant({}),
});

/** v11 の anchor。合流していない（null）と合流先の実効 endTime（数値）の双方を踏む。 */
const genAnchor = fc.option(fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }), {
  nil: null,
});

describe("core/migrate — v10 → v11 の面（lift-group-planning 判断 20）", () => {
  // Feature: lift-group-planning, Property 12 — 移行（追加）
  // **Validates: Requirements 9.9, 7.5**
  //
  // v10 の配置は合流の所属を持たない。移行は設定（toleranceRatio）を持たず h_i の窓を引けないので推定せず、
  // null で埋める（design Component 10「推定できなければ null」）。埋めた anchor 以外は写しで、計時の事実に触れない。
  it("Property 12: 任意の v10 スナップショットで配置の anchor は null になり、それ以外は写しである", () => {
    fc.assert(
      fc.property(genV10Snapshot, (v10) => {
        // 生成器が v11 の語彙を混ぜていないことを先に確かめる。
        expect(
          v10.acceptedSlices.some((slice) => slice.placements.some((p) => "anchor" in p)),
        ).toBe(false);

        const raw = structuredClone(v10) as unknown;
        const result = migrate(raw);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.snapshot.version).toBe(CURRENT_SCHEMA_VERSION);
        expect(result.snapshot.acceptedSlices).toEqual(
          v10.acceptedSlices.map((slice) => ({
            ...slice,
            placements: slice.placements.map((placement) => ({ ...placement, anchor: null })),
          })),
        );
        expect(result.snapshot.timers.map(boilFacts)).toEqual(v10.timers.map(boilFacts));
        expect(raw).toEqual(v10);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: lift-group-planning, Property 12 — 移行（現行の往復）
  // **Validates: Requirements 9.9, 7.5**
  //
  // v11 が書いた anchor（null も数値も）はそのまま読み戻る。所属を失えば合成が合流分を 1 品の単位として
  // 再検証し直すことになり、採用の事実が黙って書き換わる。
  it("Property 12: v11 の永続値の anchor は null も数値もそのまま保たれる", () => {
    fc.assert(
      fc.property(
        genV10Snapshot,
        fc.array(fc.array(genAnchor, { minLength: 3, maxLength: 3 }), {
          minLength: 3,
          maxLength: 3,
        }),
        (v10, anchors) => {
          const v11 = {
            ...v10,
            version: 11,
            acceptedSlices: v10.acceptedSlices.map((slice, sliceIndex) => ({
              ...slice,
              placements: slice.placements.map((placement, index) => ({
                ...placement,
                anchor: anchors[sliceIndex]![index]!,
              })),
            })),
          };
          const result = migrate(structuredClone(v11));
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.snapshot.acceptedSlices).toEqual(v11.acceptedSlices);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ── plan-stability — v12 の移行は二方向（v11 の欠如を空に畳む・v12 の shownPlan を保つ・壊れた要素だけ落とす） ────

/** v11 の採用済み一片（配置は anchor を持つ）。 */
const genV11AcceptedSlice = fc.record({
  tableKey: fc.string({ minLength: 1, maxLength: 6 }),
  placements: fc.array(
    fc.record({
      externalOrderId: fc.string({ minLength: 1, maxLength: 8 }),
      itemIndex: fc.nat({ max: 9 }),
      slotIds: fc.array(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 2 }),
      startAt: fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }),
      serveAt: fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }),
      anchor: genAnchor,
    }),
    { maxLength: 3 },
  ),
});

/** v11 の永続スナップショット。**shownPlan を持たない**（それが v11 であることの定義そのものである）。 */
const genV11Snapshot = fc.record({
  version: fc.constant(11),
  timers: fc.array(genV9Timer, { maxLength: 3 }),
  nextSeq: fc.nat({ max: 1000 }),
  pendingOrders: fc.constant([]),
  acceptedSlices: fc.array(genV11AcceptedSlice, { maxLength: 3 }),
  requestedDigest: fc.constant(null),
  lastSequenceByTerminal: fc.constant({}),
});

/** v12 が書く Shown_Plan の 1 品目（形を満たすもの）。 */
const genShownItem = fc.record({
  externalOrderId: fc.string({ minLength: 1, maxLength: 8 }),
  itemIndex: fc.nat({ max: 9 }),
  slotIds: fc.array(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 2 }),
  startAt: fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }),
  serveAt: fc.integer({ min: 1_600_000_000_000, max: 1_800_000_000_000 }),
  anchor: genAnchor,
  mates: fc.array(fc.string({ minLength: 1, maxLength: 12 }), { maxLength: 3 }),
});

/** 形を満たす 1 品目を、鍵・釜・時刻・まとまりのいずれかで壊す（kind が壊し方を選ぶ）。 */
function brokenShownItem(item: Record<string, unknown>, kind: number): unknown {
  switch (kind) {
    case 0:
      return { ...item, externalOrderId: "" };
    case 1:
      return { ...item, itemIndex: -1 };
    case 2:
      return { ...item, slotIds: [] };
    case 3:
      return { ...item, startAt: 0.5 };
    case 4:
      return { ...item, serveAt: "later" };
    case 5:
      return { ...item, anchor: Number.NaN };
    case 6:
      return { ...item, mates: [42] };
    default:
      return null;
  }
}

/** 壊れた 1 品目（壊し方を面で踏む）。 */
const genBrokenShownItem = fc
  .tuple(genShownItem, fc.nat({ max: 7 }))
  .map(([item, kind]) => brokenShownItem(item, kind));

/** 形を満たす要素と壊れた要素を混ぜた Shown_Plan（どれが残るべきかを添えて）。 */
const genMixedShownPlan = fc.array(
  fc.oneof(
    genShownItem.map((item) => ({ ok: true as const, item })),
    genBrokenShownItem.map((item) => ({ ok: false as const, item })),
  ),
  { maxLength: 6 },
);

describe("core/migrate — v11 → v12 の面（plan-stability 判断 1・AC 1.3・性質 5.8）", () => {
  // Feature: plan-stability, Property 5.8 — 移行（追加）
  // **Validates: Requirements 1.3, 5.8**
  //
  // v11 以前の永続は前回の提案を持たない。欠如は空（比較の相手なし・Change_Cost 0）に畳み、それ以外は写しで、
  // 計時の事実にも採用済み計画にも触れない。落ちない。
  it("Property 5.8: 任意の v11 スナップショットで shownPlan は空になり、それ以外は写しである", () => {
    fc.assert(
      fc.property(genV11Snapshot, (v11) => {
        // 生成器が v12 の語彙を混ぜていないことを先に確かめる。
        expect("shownPlan" in v11).toBe(false);

        const raw = structuredClone(v11) as unknown;
        const result = migrate(raw);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.snapshot.version).toBe(CURRENT_SCHEMA_VERSION);
        expect(result.snapshot.shownPlan).toEqual([]);
        expect(result.snapshot.acceptedSlices).toEqual(v11.acceptedSlices);
        expect(result.snapshot.timers.map(boilFacts)).toEqual(v11.timers.map(boilFacts));
        expect(raw).toEqual(v11);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: plan-stability, Property 5.8 — 移行（現行の往復）
  // **Validates: Requirements 1.1, 1.3**
  //
  // v12 が書いた Shown_Plan（錨の null も数値も・まとまりの鍵も）はそのまま読み戻る。失えば次の計画は比較の
  // 相手を持たず、前回の提案を守る費用が一度だけ消える。
  it("Property 5.8: v12 の永続値の shownPlan はそのまま保たれる", () => {
    fc.assert(
      fc.property(genV11Snapshot, fc.array(genShownItem, { maxLength: 4 }), (v11, shownPlan) => {
        const v12 = { ...v11, version: 12, shownPlan };
        const result = migrate(structuredClone(v12));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.snapshot.shownPlan).toEqual(shownPlan);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: plan-stability, design Error Handling — 壊れた要素はその要素だけ落とす
  // **Validates: Requirements 1.3**
  //
  // 待ち行列・採用済み計画（一件でも不正なら全体を移行失敗）と規律を分ける。Shown_Plan は比較にだけ使う履歴で、
  // 要素の欠けは費用 0 に倒れるだけで嘘を生まない。壊れた 1 要素で店舗を起動不能にしない。
  it("壊れた要素はその要素だけ落ち、形を満たす要素は順序を保って残り、移行は落ちない", () => {
    fc.assert(
      fc.property(genV11Snapshot, genMixedShownPlan, (v11, mixed) => {
        const v12 = { ...v11, version: 12, shownPlan: mixed.map((entry) => entry.item) };
        const result = migrate(structuredClone(v12));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.snapshot.shownPlan).toEqual(
          mixed.filter((entry) => entry.ok).map((entry) => entry.item),
        );
        expect(result.snapshot.acceptedSlices).toEqual(v11.acceptedSlices);
      }),
      { numRuns: 200 },
    );
  });
});

describe("Feature: order-item-truncation, Requirement 4: 上限と鍵の一意性の面", () => {
  /** v13 の素の 1 品目。鍵は呼び出し側が与える（一意にも重複にも組めるようにする）。 */
  function order(externalOrderId: string, itemIndex: number, arrivalTime: number) {
    return {
      externalOrderId,
      itemIndex,
      noodleType: "Thin",
      firmness: "normal" as const,
      tableId: null,
      arrivalTime,
      slotSpan: 1,
      itemName: null,
      sizeName: null,
      completedAt: null,
      interruptedAt: null,
    };
  }

  const v13With = (orderItems: readonly unknown[]) => ({
    version: 13,
    timers: [],
    nextSeq: 0,
    orderItems,
    acceptedSlices: [],
    requestedDigest: null,
    lastSequenceByTerminal: {},
    shownPlan: [],
  });

  // 上限超過の集合は 1 件が 4096 件超の配列ゆえ、runs を絞る（振れ幅は超過分 k と並びの置換だけ）。
  const OVER_LIMIT_ASSERT_OPTIONS = { numRuns: 100 };

  it("鍵が一意な上限超過の集合は、移行に成功して上限以下になる（超過は移行が直せる欠陥）", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 0, max: 0x7fff_ffff }),
        (overflow, seed) => {
          const length = ORDER_ITEM_LIMIT + overflow;
          // 鍵は一意、arrivalTime は添字の順（＝ compareArrival の順）。並びは置換して与える。
          const built = Array.from({ length }, (_unused, index) =>
            order(`o-${String(index).padStart(6, "0")}`, index % 3, index * 1000),
          );
          const given = shuffleBySeed(built, seed);

          const result = migrate(v13With(given));

          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const kept = result.snapshot.orderItems;
          // 期待値は truncateOrderItems を使わずに組む——件数・鍵・並び・古さから独立に主張する。
          expect(kept.length).toBe(ORDER_ITEM_LIMIT);
          const givenKeys = new Set(given.map((item) => itemKeyOf(item)));
          const keptKeys = new Set(kept.map((item) => itemKeyOf(item)));
          // 1. 残ったものは与えたものの部分集合で、鍵は一意のまま。
          expect(keptKeys.size).toBe(kept.length);
          // 要素ごとに expect を呼ばない（4096 件 × 100 runs では呼び出し自体が支配的になる）。
          expect([...keptKeys].every((key) => givenKeys.has(key))).toBe(true);
          // 2. 残ったものの相対順序は与えた並びのまま。
          expect(kept.map((item) => itemKeyOf(item))).toEqual(
            given.filter((item) => keptKeys.has(itemKeyOf(item))).map((item) => itemKeyOf(item)),
          );
          // 3. 落ちたものはいずれも残ったもののすべてより真に古い。
          const dropped = given.filter((item) => !keptKeys.has(itemKeyOf(item)));
          expect(dropped.length).toBe(overflow);
          // 全順序の下では「落ちた中の最も新しい < 残った中の最も古い」と同値（二重ループを畳む）。
          const newestDropped = dropped.reduce((a, b) => (compareArrival(a, b) >= 0 ? a : b));
          const oldestKept = kept.reduce((a, b) => (compareArrival(a, b) <= 0 ? a : b));
          expect(compareArrival(newestDropped, oldestKept)).toBeLessThan(0);
        },
      ),
      OVER_LIMIT_ASSERT_OPTIONS,
    );
  });

  it("鍵が重複する集合は、上限以下でも上限超過でも MigrationFailed（部分受理しない）", () => {
    /** 同じ鍵の 2 件（最も古い側に置く——上限を当てれば消えうる形）と、鍵一意な rest 件。 */
    function withDuplicate(rest: number, seed: number): readonly unknown[] {
      const built = [
        order("dup", 0, 0),
        order("dup", 0, 1),
        ...Array.from({ length: rest }, (_unused, index) =>
          order(`o-${String(index).padStart(6, "0")}`, index % 3, 10_000 + index * 1000),
        ),
      ];
      return shuffleBySeed(built, seed);
    }

    function expectMigrationFailed(items: readonly unknown[]) {
      const result = migrate(v13With(items));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.code).toBe("MigrationFailed");
    }

    fc.assert(
      fc.property(
        // **両帯を各 run で必ず生成する。** 一つの整数を 0..LIMIT+4 から抽選すると上限超過になるのは
        // 6 / 4101 通りしかなく、12 runs では 1.7% しか踏まない——「上限以下でも上限超過でも」が
        // 事実上「上限以下だけ」になる。帯ごとに引数を分ければ、どの run も両側を検査する。
        fc.integer({ min: 0, max: ORDER_ITEM_LIMIT - 2 }), // + 重複 2 件で上限以下
        fc.integer({ min: ORDER_ITEM_LIMIT - 1, max: ORDER_ITEM_LIMIT + 4 }), // + 2 件で上限超過
        fc.integer({ min: 0, max: 0x7fff_ffff }),
        (restBelow, restAbove, seed) => {
          expect(restBelow + 2).toBeLessThanOrEqual(ORDER_ITEM_LIMIT);
          expect(restAbove + 2).toBeGreaterThan(ORDER_ITEM_LIMIT);
          expectMigrationFailed(withDuplicate(restBelow, seed));
          expectMigrationFailed(withDuplicate(restAbove, seed));
        },
      ),
      OVER_LIMIT_ASSERT_OPTIONS,
    );
  });
});
