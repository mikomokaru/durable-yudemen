// 取得した行 → 相関・品質の入力。数え方の分かれ目（保存行数と一意到達数を混ぜない）を固定する。

import { describe, expect, it } from "vitest";
import { INGEST_COLUMN } from "../../src/observe/history-query";
import { decodeHistoryRows, summarizeHistoryRows } from "../../src/observe/history-summary";
import { printCanonicalOperationLine } from "../../src/operation-history/codec";
import { operationQualityAssessmentFromCounts } from "../../src/operation-history/quality";
import type { OperationRecord } from "../../src/operation-history/record";

const timestamp = (value: number): OperationRecord["eventTime"] =>
  value as OperationRecord["eventTime"];

const started = {
  storeId: "store-1",
  timerId: "timer-1",
  operationKind: "boil-started",
  eventTime: timestamp(1_700_000_000_000),
  slotIds: ["slot-1"],
  noodleType: "Thin",
  firmness: "normal",
  startTime: timestamp(1_700_000_000_000),
  endTime: timestamp(1_700_000_090_000),
} satisfies OperationRecord;

const completed = {
  storeId: "store-1",
  timerId: "timer-1",
  operationKind: "completed",
  eventTime: timestamp(1_700_000_120_000),
  slotIds: ["slot-1"],
  noodleType: "Thin",
  firmness: "normal",
} satisfies OperationRecord;

const row = (record: OperationRecord, arrivalId: string, ingestedAt = "2026-09-12T06:00:00Z") => ({
  [INGEST_COLUMN]: ingestedAt,
  arrivalId,
  storeId: record.storeId,
  eventTime: record.eventTime as number,
  canonicalPayload: printCanonicalOperationLine(record),
  sourceMetadata: '{"v":1,"producerScript":"yude-men-timer","truncation":"not-detected"}',
});

describe("行の解析", () => {
  it("原文から record を起こし、到達の来歴を添える", () => {
    const decoded = decodeHistoryRows([row(completed, "a-1")]);

    expect(decoded.faults).toEqual([]);
    expect(decoded.evidence).toHaveLength(1);
    expect(decoded.evidence[0]?.record).toEqual(completed);
    expect(decoded.evidence[0]?.traceMetadata).toMatchObject({
      arrivalId: "a-1",
      ingestedAt: "2026-09-12T06:00:00Z",
    });
  });

  it("解析できない原文を捨てずに数える", () => {
    const decoded = decodeHistoryRows([{ ...row(completed, "a-2"), canonicalPayload: "{" }]);

    expect(decoded.evidence).toEqual([]);
    expect(decoded.faults).toEqual([
      { kind: "payload", arrivalId: "a-2", failure: "invalid-json" },
    ]);
  });

  it("列と原文の食い違いを直さずに残す", () => {
    const decoded = decodeHistoryRows([{ ...row(completed, "a-3"), storeId: "store-9" }]);

    expect(decoded.evidence).toEqual([]);
    expect(decoded.faults).toEqual([
      { kind: "column-mismatch", arrivalId: "a-3", column: "storeId" },
    ]);
  });

  it("読めない列の行を形の問題として残す", () => {
    const decoded = decodeHistoryRows([{ ...row(completed, "a-4"), eventTime: "1700000120000" }]);

    expect(decoded.faults).toEqual([{ kind: "row-shape", arrivalId: "a-4", column: "eventTime" }]);
  });
});

describe("件数の数え方", () => {
  it("保存行数と一意到達数を別に出し、重複の分母を減らさない", () => {
    // 同じ到達が 2 行保存されている場合。到達 ID で先に間引けば重複率は 0 に化ける。
    const summary = summarizeHistoryRows([row(completed, "a-1"), row(completed, "a-1")]);

    expect(summary.counts.storedRows).toBe(2);
    expect(summary.counts.uniqueArrivals).toBe(1);
    expect(summary.counts.analysisSamples).toBe(1);
    expect(summary.counts.duplicates).toBe(1);
    expect(summary.qualityInput.arrivalCount).toBe(2);
    expect(summary.qualityInput.duplicateArrivalCount).toBe(1);
  });

  it("開始のない終端を孤児として数える", () => {
    const summary = summarizeHistoryRows([row(completed, "a-1")]);

    expect(summary.counts.orphans).toBe(1);
    expect(summary.qualityInput.orphanRecordCount).toBe(1);
  });

  it("lifecycle が揃っていれば孤児にしない", () => {
    const summary = summarizeHistoryRows([row(started, "a-1"), row(completed, "a-2")]);

    expect(summary.counts.orphans).toBe(0);
    expect(summary.counts.analysisSamples).toBe(2);
  });

  it("期待記録を渡さなければ lifecycle 内欠落率は算出不能になる", () => {
    const summary = summarizeHistoryRows([row(started, "a-1"), row(completed, "a-2")]);
    const assessment = operationQualityAssessmentFromCounts({
      storeId: "store-1",
      period: "2026-09-12",
      counts: summary.qualityInput,
      thresholds: {
        lifecycleMissingRate: 0.01,
        duplicateRate: 0.01,
        orphanRate: 0.01,
        conflictRate: 0.01,
      },
    });

    expect(assessment.rates.lifecycleMissingRate.status).toBe("not-calculable");
    // 算出不能を「満たしている」に化けさせない。
    expect(assessment.trustedAnalysis.status).toBe("excluded");
    expect(assessment.consoleLogCompleteMissingRate.status).toBe("unmeasurable");
  });
});
