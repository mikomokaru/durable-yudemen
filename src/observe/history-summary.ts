// 取得した行を、既存の相関・品質の純粋関数へ渡せる形へ写す（operation-history-log 要件 5.3 / 5.4 / 5.7）。
//
// 保存されているのは canonical 行そのものである。列は範囲を絞るための写しにすぎないので、**分析の根拠は
// 必ず canonical payload を解析し直したもの**にする。列と payload が食い違う行は、直すのではなく食い違いと
// して数える——どちらが正しいかをここで決めれば、原文を保っている意味がなくなる。
//
// 数え方の分かれ目を一つだけ守る。保存された配送複製を到達 ID で先に間引かない（要件 5.4）。重複率の
// 分母は「保存されていた行数」であって「一意な到達の数」ではない。

import { parseOperationLines, type OperationLineFailure } from "../operation-history/codec";
import { operationArrivalQualityFromEvidence } from "../operation-history/correlation";
import type { OperationRecord } from "../operation-history/record";
import { INGEST_COLUMN } from "./history-query";

/** 取得した 1 行のうち、この層が読む列。 */
export interface HistoryRow {
  readonly arrivalId: string;
  readonly storeId: string;
  readonly eventTime: number;
  readonly canonicalPayload: string;
  readonly sourceMetadata: string;
  readonly [INGEST_COLUMN]: string;
}

/** 解析できなかった行と、その理由。捨てずに数に残す。 */
export type HistoryRowFault =
  | { readonly kind: "payload"; readonly arrivalId: string; readonly failure: OperationLineFailure }
  | { readonly kind: "row-shape"; readonly arrivalId: string; readonly column: string }
  | {
      readonly kind: "column-mismatch";
      readonly arrivalId: string;
      readonly column: "storeId" | "eventTime";
    };

export interface DecodedHistory {
  /** 相関・品質へ渡す証拠。`traceMetadata` に到達の来歴を載せ、原文の hash は補助に留める。 */
  readonly evidence: readonly {
    readonly record: OperationRecord;
    readonly traceMetadata: Readonly<Record<string, unknown>>;
  }[];
  readonly faults: readonly HistoryRowFault[];
}

function readRow(row: Readonly<Record<string, unknown>>): HistoryRow | { readonly column: string } {
  for (const column of [
    "arrivalId",
    "storeId",
    "canonicalPayload",
    "sourceMetadata",
    INGEST_COLUMN,
  ]) {
    if (typeof row[column] !== "string") return { column };
  }
  if (typeof row.eventTime !== "number") return { column: "eventTime" };
  return row as unknown as HistoryRow;
}

/** 行を解析して証拠へ写す。解析できない行・列と食い違う行は faults に残す。 */
export function decodeHistoryRows(
  rows: readonly Readonly<Record<string, unknown>>[],
): DecodedHistory {
  const evidence: DecodedHistory["evidence"][number][] = [];
  const faults: HistoryRowFault[] = [];

  for (const raw of rows) {
    const row = readRow(raw);
    if ("column" in row) {
      const arrivalId = typeof raw.arrivalId === "string" ? raw.arrivalId : "";
      faults.push({ kind: "row-shape", arrivalId, column: row.column });
      continue;
    }

    const [parsed] = parseOperationLines(row.canonicalPayload);
    if (parsed?.ok !== true) {
      faults.push({
        kind: "payload",
        arrivalId: row.arrivalId,
        failure: parsed?.failure ?? "invalid-json",
      });
      continue;
    }

    if (parsed.record.storeId !== row.storeId) {
      faults.push({ kind: "column-mismatch", arrivalId: row.arrivalId, column: "storeId" });
      continue;
    }
    if (parsed.record.eventTime !== row.eventTime) {
      faults.push({ kind: "column-mismatch", arrivalId: row.arrivalId, column: "eventTime" });
      continue;
    }

    evidence.push({
      record: parsed.record,
      traceMetadata: {
        arrivalId: row.arrivalId,
        ingestedAt: row[INGEST_COLUMN],
        sourceMetadata: row.sourceMetadata,
      },
    });
  }

  return { evidence, faults };
}

export interface HistoryCounts {
  /** 取得できた保存済みの行数。重複率の分母はこれである。 */
  readonly storedRows: number;
  /** 到達 ID の一意数。行数とは別の指標として並べる（要件 5.4）。 */
  readonly uniqueArrivals: number;
  /** 収束後の分析標本数。 */
  readonly analysisSamples: number;
  readonly duplicates: number;
  readonly orphans: number;
  readonly conflicts: number;
  readonly faults: number;
}

export interface HistorySummary {
  readonly counts: HistoryCounts;
  readonly faults: readonly HistoryRowFault[];
  /** `operationQualityAssessmentFromCounts` へそのまま渡せる形。 */
  readonly qualityInput: Readonly<{
    expectedLifecycleRecordCount: number;
    missingLifecycleRecordCount: number;
    arrivalCount: number;
    duplicateArrivalCount: number;
    convergedRecordCount: number;
    orphanRecordCount: number;
    primaryCandidateCount: number;
    conflictingPrimaryCandidateCount: number;
  }>;
}

/**
 * 取得した行から件数と品質の入力を作る。
 *
 * `expectedRecords` は「復元可能な期待記録」で、渡さなければ lifecycle 内欠落率は**算出不能**になる
 * （要件 5.5）。取得した行だけから期待値を作って 0 件と言わないために、既定を空にしてある。
 */
export function summarizeHistoryRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  expectedRecords: readonly OperationRecord[] = [],
): HistorySummary {
  const decoded = decodeHistoryRows(rows);
  const assessed = operationArrivalQualityFromEvidence(decoded.evidence, expectedRecords);

  const uniqueArrivals = new Set(
    decoded.evidence.map(({ traceMetadata }) => traceMetadata.arrivalId),
  ).size;
  const duplicates = assessed.convergedRecords.reduce(
    (total, converged) => total + converged.duplicateCount,
    0,
  );
  const primaryCandidates = new Set(
    decoded.evidence.map(({ record }) =>
      JSON.stringify([record.storeId, record.timerId, record.operationKind, record.eventTime]),
    ),
  ).size;

  return {
    counts: {
      storedRows: rows.length,
      uniqueArrivals,
      analysisSamples: assessed.convergedRecords.length,
      duplicates,
      orphans: assessed.quality.orphan.length,
      conflicts: assessed.quality.conflict.length,
      faults: decoded.faults.length,
    },
    faults: decoded.faults,
    qualityInput: {
      expectedLifecycleRecordCount: expectedRecords.length,
      missingLifecycleRecordCount: assessed.quality.missing.length,
      // 分母は保存されていた行数。到達 ID で間引いた数にしない（要件 5.4）。
      arrivalCount: decoded.evidence.length,
      duplicateArrivalCount: duplicates,
      convergedRecordCount: assessed.convergedRecords.length,
      orphanRecordCount: assessed.quality.orphan.length,
      primaryCandidateCount: primaryCandidates,
      conflictingPrimaryCandidateCount: assessed.quality.conflict.length,
    },
  };
}
