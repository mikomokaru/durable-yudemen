// tests/core/migrate.property.test.ts — migrate と永続境界の 3 つの Property。
//   yude-men-timer Property 13: version 不整合・移行失敗で元データ不変。
//   pos-order-ingress Property 12: 移行は既存の挙動を保つ（v7 → v8 の欠如の埋め方）。
//   synchronized-boil-adjustment: 現行 snapshot 往復で符号付き Adjustment を保存。

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
  pendingOrders: fc.array(genV7PendingOrder, { maxLength: 4 }),
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
        expect(result.snapshot.pendingOrders).toHaveLength(v7.pendingOrders.length);
        for (const order of result.snapshot.pendingOrders)
          expect(order.slotSpan).toBe(SLOT_SPAN_MIN);
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
        // v9 が埋めるのは 3 つ（slotSpan・itemName・sizeName）。埋めた分を除いた残りが写しであることを問う。
        expect(
          result.snapshot.pendingOrders.map(
            ({ slotSpan: _span, itemName: _item, sizeName: _size, ...rest }) => rest,
          ),
        ).toEqual(v7.pendingOrders);
        // v10 で一片は点数を持たない。v7 の score は余剰として捨てられ、それ以外は写しである。
        expect(result.snapshot.acceptedSlices).toEqual(
          v7.acceptedSlices.map(({ score: _score, ...rest }) => rest),
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
        seq: index,
        boiledAt: spec.boiled ? (endTime as EpochMillis) : null,
        adjustment: spec.adjustment,
      });
    });
    return {
      timers,
      nextSeq: timers.length,
      pendingOrders: EMPTY_STATE.pendingOrders,
      acceptedSlices: EMPTY_STATE.acceptedSlices,
      requestedDigest: EMPTY_STATE.requestedDigest,
      lastSequenceByTerminal: EMPTY_STATE.lastSequenceByTerminal,
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
      fc.property(fc.array(genV8Order, { maxLength: 5 }), (pendingOrders) => {
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
        expect(result.snapshot.pendingOrders).toHaveLength(pendingOrders.length);
        for (const [index, order] of result.snapshot.pendingOrders.entries()) {
          expect(order.itemName).toBeNull();
          expect(order.sizeName).toBeNull();
          // 埋めた 2 つ以外は写しである。
          const { itemName: _item, sizeName: _size, ...rest } = order;
          expect(rest).toEqual(pendingOrders[index]);
        }
        expect(result.snapshot.version).toBe(CURRENT_SCHEMA_VERSION);
      }),
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
        },
      ],
      lastSequenceByTerminal: {},
    };
    expect(migrate(broken).ok).toBe(false);
  });
});
