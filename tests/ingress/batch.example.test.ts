// tests/ingress/batch.example.test.ts — Arrival_Batch の解釈の example test（実データ形と境界を固定する）。
//
// property test（batch.property.test.ts）が全域性と素通しを面で押さえるのに対し、ここでは上流の実データ形と
// 「null になる境界」を点で固定する。タスク 22.1 で拡充する前提の最小限。

import { describe, expect, it } from "vitest";
import { toArrivalBatch, toArrivalRecord } from "../../src/ingress/batch";

/** 上流の実データ形（記録された 3 件のうち 1 件の形。payload は解釈せず生のまま運ばれる）。 */
const orderRaw = {
  path: "/lio/order",
  payload: {
    store_id: 1001,
    terminal_id: 41,
    bill_no: 7,
    datetime: "2026-08-17T20:52:19",
    order_id: "display-only",
    table_no: 12,
    order_items: [
      { plu_no: 11421, item_type: 1, qty: 1, child_items: [{ plu_no: 19401, s_class_code: 65 }] },
    ],
  },
  arrival_timestamp_ms: 1_755_432_739_000,
  sequence_number: "49590338271490256608027716141221070800233838749102571522",
} as const;

describe("ingress/batch — toArrivalBatch のボディ形", () => {
  it("records 配列を持つボディを受理し、要素を生値のまま保つ", () => {
    const batch = toArrivalBatch({ records: [orderRaw, { broken: true }] });
    expect(batch?.records).toEqual([orderRaw, { broken: true }]);
  });

  it("records が空配列でも受理する（上流が全件除外した結果を失敗としない・AC 1.12）", () => {
    expect(toArrivalBatch({ records: [] })).toEqual({ records: [] });
  });

  it("records 配列を成さないボディだけが null になる（それが 400 になる・AC 1.11）", () => {
    expect(toArrivalBatch({})).toBeNull();
    expect(toArrivalBatch({ records: {} })).toBeNull();
    expect(toArrivalBatch({ records: null })).toBeNull();
    expect(toArrivalBatch([orderRaw])).toBeNull();
    expect(toArrivalBatch("records")).toBeNull();
    expect(toArrivalBatch(null)).toBeNull();
    expect(toArrivalBatch(undefined)).toBeNull();
  });
});

describe("ingress/batch — toArrivalRecord の 4 つの構造", () => {
  it("実データ形の Record を検証済みの形へ写し、payload を書き換えない", () => {
    const record = toArrivalRecord(orderRaw);
    expect(record).toEqual({
      path: "/lio/order",
      payload: orderRaw.payload,
      arrivalTimestampMs: 1_755_432_739_000,
      sequenceNumber: "49590338271490256608027716141221070800233838749102571522",
    });
    expect(record?.payload).toBe(orderRaw.payload);
  });

  it("payload が空オブジェクトでも受理する（中身は一切検証しない・AC 14.6）", () => {
    expect(toArrivalRecord({ ...orderRaw, payload: {} })?.payload).toEqual({});
  });

  it("arrival_timestamp_ms が 0 でも受理する（値域窓の判定は解釈の関心事ではない・AC 8.6）", () => {
    expect(toArrivalRecord({ ...orderRaw, arrival_timestamp_ms: 0 })?.arrivalTimestampMs).toBe(0);
  });

  it("4 つの構造のいずれかが欠ければ null になる", () => {
    expect(toArrivalRecord({ ...orderRaw, path: "" })).toBeNull();
    expect(toArrivalRecord({ ...orderRaw, payload: [] })).toBeNull();
    expect(toArrivalRecord({ ...orderRaw, arrival_timestamp_ms: -1 })).toBeNull();
    expect(toArrivalRecord({ ...orderRaw, sequence_number: "" })).toBeNull();
  });

  it("path が未知でも受理する（既知でないことの扱いは分類の関心事・AC 7.3）", () => {
    expect(toArrivalRecord({ ...orderRaw, path: "/lio/whatever" })?.path).toBe("/lio/whatever");
  });
});
