// tests/ingress/batch.property.test.ts — Arrival_Batch の解釈（src/ingress/batch.ts）の property test。
//
// Property 1: 解釈は全域である。
//   任意の生値に対し toArrivalBatch は ArrivalBatch か null を返し、例外を投げない（上流が何を送っても
//   受け口が落ちない）。toArrivalRecord も同様に全域で、返した値は必ず 4 つの構造を満たす。
// Property 2: 素通しは payload に閉じる。
//   payload へ任意の未知フィールド・型違い・想定外の値を混ぜても Record は拒否されず、payload は
//   書き換えられない。拒否されるのは 4 つの構造が欠けたときだけである。
//
// タスク 22.1 で拡充する前提の最小限（Unique_Key 4 要素の欠落は toUniqueKey の関心事ゆえここでは見ない）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { toArrivalBatch, toArrivalRecord, type ArrivalRecord } from "../../src/ingress/batch";

/** payload の生成。キーも値も任意——素通しの対象はここだけである。 */
const genPayload: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(fc.string(), fc.anything());

/** 4 つの構造を満たす Record の生値（ワイヤのキー名は上流の snake_case）。 */
const genValidRaw = fc.record({
  path: fc.constantFrom("/lio/order", "/lio/status", "/lio/unknown"),
  payload: genPayload,
  arrival_timestamp_ms: fc.integer({ min: 0, max: 4_000_000_000_000 }),
  sequence_number: fc.string({ minLength: 1, maxLength: 56 }),
});

describe("ingress/batch — toArrivalBatch", () => {
  // Feature: pos-order-ingress, Property 1: 解釈は全域である
  // **Validates: Requirements 1.11, 14.1**
  it("Property 1: 任意の生値に対し ArrivalBatch か null を返し、例外を投げない", () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const batch = toArrivalBatch(raw);
        if (batch === null) return;
        // 非 null なら records は必ず配列を成す（それが本型の表明する唯一の事実）。
        expect(Array.isArray(batch.records)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  // Feature: pos-order-ingress, Property 1: 解釈は全域である
  // **Validates: Requirements 1.11, 14.1**
  it("Property 1: null を返すのはボディが records 配列を成さないときだけ", () => {
    fc.assert(
      fc.property(fc.array(fc.anything(), { maxLength: 8 }), fc.dictionary(fc.string(), fc.anything()), (records, extra) => {
        // 要素が何であれ（毒・型違反を含む）バッチは受理され、要素は生値のまま保たれる。
        const batch = toArrivalBatch({ ...extra, records });
        expect(batch).not.toBeNull();
        expect(batch?.records).toEqual(records);
      }),
      { numRuns: 300 },
    );
  });
});

describe("ingress/batch — toArrivalRecord", () => {
  // Feature: pos-order-ingress, Property 1: 解釈は全域である
  // **Validates: Requirements 14.1, 14.10, 14.11**
  it("Property 1: 任意の生値に対し ArrivalRecord か null を返し、返した値は 4 つの構造を満たす", () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const record = toArrivalRecord(raw);
        if (record === null) return;
        expectFourStructures(record);
      }),
      { numRuns: 500 },
    );
  });

  // Feature: pos-order-ingress, Property 2: 素通しは payload に閉じる
  // **Validates: Requirements 14.2, 14.3, 14.4, 14.6, 14.10, 14.11**
  it("Property 2: payload の中身は拒否事由にならず、書き換えられない", () => {
    fc.assert(
      fc.property(genValidRaw, (raw) => {
        const record = toArrivalRecord(raw);
        expect(record).not.toBeNull();
        expectFourStructures(record as ArrivalRecord);
        // 参照のまま運ぶ（スキーマ検証も正規化も行わない・AC 14.5・14.6）。
        expect(record?.payload).toBe(raw.payload);
      }),
      { numRuns: 300 },
    );
  });

  // Feature: pos-order-ingress, Property 2: 素通しは payload に閉じる
  // **Validates: Requirements 14.2, 14.3, 14.4**
  it("Property 2: payload へ未知フィールド・型違いを混ぜても可否が変わらない", () => {
    fc.assert(
      fc.property(genValidRaw, fc.string(), fc.anything(), (raw, key, value) => {
        const mixed = { ...raw, payload: { ...raw.payload, [key]: value } };
        // 混ぜる前後で受理される事実が変わらない（素通しのための例外経路も持たない・AC 14.8）。
        expect(toArrivalRecord(mixed)).not.toBeNull();
        expect(toArrivalRecord(mixed)?.path).toBe(raw.path);
      }),
      { numRuns: 300 },
    );
  });

  // Feature: pos-order-ingress, Property 2: 素通しは payload に閉じる
  // **Validates: Requirements 14.10, 14.11**
  it("Property 2: 拒否されるのはメタデータの 4 構造が欠けたときだけ", () => {
    const genBrokenField = fc.constantFrom<keyof typeof brokenValues>(
      "path",
      "payload",
      "arrival_timestamp_ms",
      "sequence_number",
    );
    fc.assert(
      fc.property(genValidRaw, genBrokenField, fc.nat({ max: 3 }), (raw, field, pick) => {
        const candidates = brokenValues[field];
        const broken = { ...raw, [field]: candidates[pick % candidates.length] };
        expect(toArrivalRecord(broken)).toBeNull();
      }),
      { numRuns: 300 },
    );
  });
});

/** 4 つの構造を満たさない値。いずれもメタデータの層に対する検証であり、素通しの例外ではない。 */
const brokenValues = {
  path: ["", 1, null, undefined],
  payload: [[], null, "x", 1],
  arrival_timestamp_ms: [-1, 1.5, Number.NaN, "0"],
  sequence_number: ["", 1, null, undefined],
} as const satisfies Record<string, readonly unknown[]>;

/** 検証済みの形が満たすべき 4 つの構造（返り値の表明を実測で確かめる）。 */
function expectFourStructures(record: ArrivalRecord): void {
  expect(typeof record.path).toBe("string");
  expect(record.path.length).toBeGreaterThan(0);
  expect(typeof record.payload).toBe("object");
  expect(Array.isArray(record.payload)).toBe(false);
  expect(Number.isInteger(record.arrivalTimestampMs)).toBe(true);
  expect(record.arrivalTimestampMs).toBeGreaterThanOrEqual(0);
  expect(typeof record.sequenceNumber).toBe("string");
  expect(record.sequenceNumber.length).toBeGreaterThan(0);
}
