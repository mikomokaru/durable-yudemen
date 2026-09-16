// 観測行 → 物理行の写像と、送信前の検査が落とす理由の例。

import { describe, expect, it } from "vitest";
import {
  ARRIVAL_BYTE_LIMIT,
  CANONICAL_PAYLOAD_BYTE_LIMIT,
  OPERATION_PAYLOAD_VERSION,
  PHYSICAL_VERSION,
  operationArrival,
  validateArrival,
  type HistoryArrival,
} from "../../src/data-platform/arrival";
import { canonicalPayload, completedRecord, observation } from "./support/arrival-fixture";

const arrival = operationArrival(completedRecord, canonicalPayload, observation);
const rejectionOf = (row: unknown) => {
  const checked = validateArrival(row);
  return checked.ok ? null : checked.rejection;
};

describe("operation の物理行", () => {
  it("原文と原時刻をそのまま運び、観測時刻と分ける", () => {
    expect(arrival).toEqual({
      dataset: "operation",
      physicalVersion: PHYSICAL_VERSION,
      payloadVersion: OPERATION_PAYLOAD_VERSION,
      arrivalId: observation.arrivalId,
      eventId: null,
      storeId: "store-1",
      source: "tail",
      guarantee: "best-effort",
      eventTime: completedRecord.eventTime,
      observedAt: observation.observedAt,
      canonicalPayload: canonicalPayload,
      sourceMetadata: JSON.stringify({
        v: 1,
        producerScript: "yude-men-timer",
        truncation: "not-detected",
        truncationBasis: "trace-item",
      }),
      isSynthetic: false,
      probeId: null,
    } satisfies HistoryArrival);
  });

  it("切詰めが確認できない場合は不明を根拠付きで残す", () => {
    const unknownTruncation = operationArrival(completedRecord, canonicalPayload, {
      ...observation,
      truncation: "unknown",
    });

    expect(JSON.parse(unknownTruncation.sourceMetadata)).toEqual({
      v: 1,
      producerScript: "yude-men-timer",
      truncation: "unknown",
      truncationBasis: "unavailable",
    });
  });

  it("プローブ行は probeId を持ち、合成として区別される", () => {
    const probe = operationArrival(completedRecord, canonicalPayload, {
      ...observation,
      probeId: "probe-1",
    });

    expect([probe.isSynthetic, probe.probeId]).toEqual([true, "probe-1"]);
    expect(validateArrival(probe).ok).toBe(true);
  });

  it("写像した行はそのまま検査を通る", () => {
    expect(validateArrival(arrival).ok).toBe(true);
  });
});

describe("送信前の検査", () => {
  it("未知の列を落とす", () => {
    expect(rejectionOf({ ...arrival, extra: 1 })).toEqual({
      reason: "unknown-column",
      column: "extra",
    });
  });

  it("必須列の欠落と null を同じ理由で落とす", () => {
    const { storeId: _omitted, ...missing } = arrival;

    expect(rejectionOf(missing)).toEqual({ reason: "missing-column", column: "storeId" });
    expect(rejectionOf({ ...arrival, storeId: null })).toEqual({
      reason: "missing-column",
      column: "storeId",
    });
  });

  it("nullable 列の null は通し、省略は落とす", () => {
    const { probeId: _omitted, ...missing } = arrival;

    expect(validateArrival({ ...arrival, probeId: null }).ok).toBe(true);
    expect(rejectionOf(missing)).toEqual({ reason: "missing-column", column: "probeId" });
  });

  it("型違反を列名付きで落とす", () => {
    expect(rejectionOf({ ...arrival, eventTime: "1700000000000" })).toEqual({
      reason: "column-type",
      column: "eventTime",
    });
    expect(rejectionOf({ ...arrival, isSynthetic: "false" })).toEqual({
      reason: "column-type",
      column: "isSynthetic",
    });
  });

  it("安全整数でない時刻を型違反として落とす", () => {
    expect(rejectionOf({ ...arrival, eventTime: 1.5 })).toEqual({
      reason: "column-type",
      column: "eventTime",
    });
    expect(rejectionOf({ ...arrival, eventTime: Number.MAX_SAFE_INTEGER + 2 })).toEqual({
      reason: "column-type",
      column: "eventTime",
    });
  });

  it("値域違反を落とす", () => {
    expect(rejectionOf({ ...arrival, dataset: "operations" })).toEqual({
      reason: "column-value",
      column: "dataset",
    });
    expect(rejectionOf({ ...arrival, guarantee: "committed" })).toEqual({
      reason: "column-value",
      column: "guarantee",
    });
    expect(rejectionOf({ ...arrival, storeId: "Store 1" })).toEqual({
      reason: "column-value",
      column: "storeId",
    });
    expect(rejectionOf({ ...arrival, eventTime: 0 })).toEqual({
      reason: "column-value",
      column: "eventTime",
    });
    expect(rejectionOf({ ...arrival, physicalVersion: PHYSICAL_VERSION + 1 })).toEqual({
      reason: "column-value",
      column: "physicalVersion",
    });
  });

  it("operation に安定イベント ID を持たせない", () => {
    expect(rejectionOf({ ...arrival, eventId: "event-1" })).toEqual({
      reason: "column-value",
      column: "eventId",
    });
  });

  it("遅延 dataset には安定イベント ID を要求する", () => {
    expect(rejectionOf({ ...arrival, dataset: "lift-delay" })).toEqual({
      reason: "column-value",
      column: "eventId",
    });
    expect(validateArrival({ ...arrival, dataset: "lift-delay", eventId: "event-1" }).ok).toBe(
      true,
    );
  });

  it("注文到着 dataset にも安定イベント ID を要求する", () => {
    // **2026-09-16 の回帰。** 「eventId を持つのは lift-delay だけ」と書いていたため、注文到着の行が
    // 本番で全て弾かれた。dataset を足すたびに直す形にせず、**持たない側（operation）を挙げる**。
    expect(rejectionOf({ ...arrival, dataset: "order-arrival" })).toEqual({
      reason: "column-value",
      column: "eventId",
    });
    expect(validateArrival({ ...arrival, dataset: "order-arrival", eventId: "order-1#1" }).ok).toBe(
      true,
    );
  });

  it("合成の申告と probeId の食い違いを落とす", () => {
    expect(rejectionOf({ ...arrival, isSynthetic: true })).toEqual({
      reason: "column-value",
      column: "probeId",
    });
    expect(rejectionOf({ ...arrival, probeId: "probe-1" })).toEqual({
      reason: "column-value",
      column: "probeId",
    });
  });

  it("埋め込み改行のある原文を落とす", () => {
    expect(rejectionOf({ ...arrival, canonicalPayload: '{"a":1}\n{"a":2}' })).toEqual({
      reason: "column-value",
      column: "canonicalPayload",
    });
  });

  it("版を名乗らない sourceMetadata を落とす", () => {
    expect(rejectionOf({ ...arrival, sourceMetadata: "{}" })).toEqual({
      reason: "column-value",
      column: "sourceMetadata",
    });
    expect(rejectionOf({ ...arrival, sourceMetadata: "not json" })).toEqual({
      reason: "column-value",
      column: "sourceMetadata",
    });
  });

  it("原文の byte 上限を UTF-8 で数える", () => {
    const wide = "あ".repeat(CANONICAL_PAYLOAD_BYTE_LIMIT / 3 + 1);

    expect(wide.length).toBeLessThan(CANONICAL_PAYLOAD_BYTE_LIMIT);
    expect(rejectionOf({ ...arrival, canonicalPayload: wide })).toEqual({
      reason: "column-value",
      column: "canonicalPayload",
    });
  });

  it("行全体の byte 上限を超えたら byte 数を返す", () => {
    const rejection = rejectionOf({
      ...arrival,
      canonicalPayload: "x".repeat(ARRIVAL_BYTE_LIMIT),
    });

    expect(rejection?.reason).toBe("row-bytes");
  });

  it("行でないものを落とす", () => {
    expect(rejectionOf(null)).toEqual({ reason: "column-type", column: "" });
    expect(rejectionOf([arrival])).toEqual({ reason: "column-type", column: "" });
    expect(rejectionOf("{}")).toEqual({ reason: "column-type", column: "" });
  });
});
