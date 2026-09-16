// 共通 observe の query 組み立て（operation-history-log 要件 6.2 / 7.7 / 7.8）。
//
// R2 SQL の制約がそのまま形になっている。1 query の LIMIT は最大 10,000、OFFSET は無い。ゆえに
// 取得は keyset——直前の行より後ろだけを次の範囲にする——で進める。境界に同じ鍵の複製が跨がる可能性が
// あるため、鍵は「取込時刻」と「到達 ID」の対にして、後者で一意に切る。
//
// **この module は文字列を作るだけで、送らない。** 送信・再試行・保存は tools/observe に置く。

import { ARRIVAL_FIELDS, type Dataset } from "../data-platform/arrival";

/** sink が自動で付ける取込時刻列。partition は day(__ingest_ts) で、イベント日では切られない。 */
export const INGEST_COLUMN = "__ingest_ts";

/** R2 SQL の 1 query の返却上限。これを超える LIMIT は拒否される。 */
export const MAX_ROWS_PER_QUERY = 10_000;

/** 取得の対象範囲。イベント期間と取込走査期間を**別々に**受ける（要件 6.2）。 */
export interface HistoryScope {
  readonly dataset: Dataset;
  /** 物理世代のテーブル名（`history.operation_arrivals_v1` 等）。世代は reader が束ねる。 */
  readonly table: string;
  readonly storeId?: string;
  /** 元の操作時刻の範囲（epoch ms・両端含む）。 */
  readonly eventTimeFrom?: number;
  readonly eventTimeTo?: number;
  /** 取込時刻の範囲（RFC 3339 の UTC 文字列）。partition の枝刈りはこちらで効く。 */
  readonly ingestFrom: string;
  readonly ingestTo: string;
  /** 合成プローブ行を含めるか。既定は業務行だけ（要件 7.3）。 */
  readonly includeSynthetic?: boolean;
}

/** 直前の取得が返した最後の行の鍵。ここより後ろを次の範囲にする。 */
export interface HistoryCursor {
  readonly ingestedAt: string;
  readonly arrivalId: string;
}

const SELECTED_COLUMNS = [INGEST_COLUMN, ...ARRIVAL_FIELDS.map((field) => field.name)];

/**
 * SQL の文字列リテラル。R2 SQL に parameter binding が無いため、**通す値の形を先に狭めてから**
 * 引用符を重ねる。ここを通らない値は query に載らない。
 */
function literal(value: string): string {
  if (!/^[\w.:@+-]{1,128}$/.test(value)) {
    throw new Error(`query へ載せられない値: ${value}`);
  }
  return `'${value}'`;
}

function timestampLiteral(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)) {
    throw new Error(`RFC 3339 の UTC 時刻ではない: ${value}`);
  }
  return `'${value}'`;
}

function epochLiteral(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`epoch ms ではない: ${value}`);
  }
  return `${value}`;
}

function scopeConditions(scope: HistoryScope): string[] {
  const conditions = [
    `${INGEST_COLUMN} >= ${timestampLiteral(scope.ingestFrom)}`,
    `${INGEST_COLUMN} <= ${timestampLiteral(scope.ingestTo)}`,
    `dataset = ${literal(scope.dataset)}`,
  ];
  if (scope.storeId !== undefined) conditions.push(`storeId = ${literal(scope.storeId)}`);
  if (scope.eventTimeFrom !== undefined) {
    conditions.push(`eventTime >= ${epochLiteral(scope.eventTimeFrom)}`);
  }
  if (scope.eventTimeTo !== undefined) {
    conditions.push(`eventTime <= ${epochLiteral(scope.eventTimeTo)}`);
  }
  // 合成行は既定で外す。混ぜたまま数えると、経路確認のための行が店舗の件数に化ける。
  if (scope.includeSynthetic !== true) conditions.push("isSynthetic = false");
  return conditions;
}

/**
 * keyset の 1 ページ分。`cursor` より後ろだけを、鍵の昇順で `limit` 件取る。
 *
 * 同じ取込時刻の行が複数あるため、`>` を時刻だけに掛けると取りこぼす。時刻が同値の場合に
 * 到達 ID で切る条件を対で置く。
 */
export function historyPageQuery(
  scope: HistoryScope,
  limit: number,
  cursor?: HistoryCursor,
): string {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ROWS_PER_QUERY) {
    throw new Error(`limit は 1〜${MAX_ROWS_PER_QUERY} の整数である: ${limit}`);
  }
  const conditions = scopeConditions(scope);
  if (cursor !== undefined) {
    const at = timestampLiteral(cursor.ingestedAt);
    const id = literal(cursor.arrivalId);
    conditions.push(
      `(${INGEST_COLUMN} > ${at} OR (${INGEST_COLUMN} = ${at} AND arrivalId > ${id}))`,
    );
  }
  return [
    `SELECT ${SELECTED_COLUMNS.join(", ")}`,
    `FROM ${scope.table}`,
    `WHERE ${conditions.join(" AND ")}`,
    `ORDER BY ${INGEST_COLUMN} ASC, arrivalId ASC`,
    `LIMIT ${limit}`,
  ].join(" ");
}

/** status が使う、店舗ごとの件数と最新時刻。全件取得の代わりに集計だけを取る。 */
export function historyStatusQuery(scope: HistoryScope): string {
  return [
    `SELECT storeId, count(*) AS arrivals, max(eventTime) AS latestEventTime,`,
    `max(${INGEST_COLUMN}) AS latestIngestedAt`,
    `FROM ${scope.table}`,
    `WHERE ${scopeConditions(scope).join(" AND ")}`,
    `GROUP BY storeId`,
    `ORDER BY storeId ASC`,
    `LIMIT ${MAX_ROWS_PER_QUERY}`,
  ].join(" ");
}

/** 合成プローブの到達確認。ID を名指しで引く（要件 7.3 / 7.4）。 */
export function probeVisibilityQuery(scope: HistoryScope, probeId: string): string {
  const conditions = [
    `${INGEST_COLUMN} >= ${timestampLiteral(scope.ingestFrom)}`,
    `${INGEST_COLUMN} <= ${timestampLiteral(scope.ingestTo)}`,
    `probeId = ${literal(probeId)}`,
  ];
  return [
    `SELECT probeId, eventTime, ${INGEST_COLUMN}`,
    `FROM ${scope.table}`,
    `WHERE ${conditions.join(" AND ")}`,
    `LIMIT 2`,
  ].join(" ");
}

/** 取得した 1 ページから次の cursor を決める。行が尽きたら undefined。 */
export function nextCursor(
  rows: readonly Readonly<Record<string, unknown>>[],
): HistoryCursor | undefined {
  const last = rows[rows.length - 1];
  if (last === undefined) return undefined;
  const ingestedAt = last[INGEST_COLUMN];
  const arrivalId = last.arrivalId;
  if (typeof ingestedAt !== "string" || typeof arrivalId !== "string") return undefined;
  return { ingestedAt, arrivalId };
}
