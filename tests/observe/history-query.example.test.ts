// 取得の query 組み立て。R2 SQL の制約（LIMIT 10,000・OFFSET なし）を形として固定する。

import { describe, expect, it } from "vitest";
import {
  INGEST_COLUMN,
  MAX_ROWS_PER_QUERY,
  historyPageQuery,
  historyStatusQuery,
  nextCursor,
  probeVisibilityQuery,
  type HistoryScope,
} from "../../src/observe/history-query";

const scope: HistoryScope = {
  dataset: "operation",
  table: "history.operation_arrivals_v1",
  ingestFrom: "2026-09-12T00:00:00Z",
  ingestTo: "2026-09-13T00:00:00Z",
};

describe("1 ページ分の取得", () => {
  it("取込時刻と dataset で範囲を絞り、合成行を既定で外す", () => {
    const sql = historyPageQuery(scope, 100);

    expect(sql).toContain(`${INGEST_COLUMN} >= '2026-09-12T00:00:00Z'`);
    expect(sql).toContain(`${INGEST_COLUMN} <= '2026-09-13T00:00:00Z'`);
    expect(sql).toContain("dataset = 'operation'");
    expect(sql).toContain("isSynthetic = false");
    expect(sql).toContain("LIMIT 100");
  });

  it("合成行を明示すれば除外条件を外す（列としては選ぶ）", () => {
    const sql = historyPageQuery({ ...scope, includeSynthetic: true }, 10);

    expect(sql).not.toContain("isSynthetic = false");
    expect(sql).toContain("SELECT __ingest_ts, dataset");
  });

  it("イベント期間と取込走査期間を別に載せる", () => {
    const sql = historyPageQuery(
      { ...scope, eventTimeFrom: 1_700_000_000_000, eventTimeTo: 1_700_000_100_000 },
      10,
    );

    expect(sql).toContain("eventTime >= 1700000000000");
    expect(sql).toContain("eventTime <= 1700000100000");
    // 取込の範囲は消えない。イベント期間だけに頼ると遅着を取りこぼす。
    expect(sql).toContain(`${INGEST_COLUMN} >= '2026-09-12T00:00:00Z'`);
  });

  it("cursor があれば同時刻の行を到達 ID で切る", () => {
    const sql = historyPageQuery(scope, 10, {
      ingestedAt: "2026-09-12T06:29:17Z",
      arrivalId: "arrival-7",
    });

    expect(sql).toContain(
      `(${INGEST_COLUMN} > '2026-09-12T06:29:17Z' OR (${INGEST_COLUMN} = '2026-09-12T06:29:17Z' AND arrivalId > 'arrival-7'))`,
    );
    expect(sql).toContain(`ORDER BY ${INGEST_COLUMN} ASC, arrivalId ASC`);
  });

  it("OFFSET を使わない", () => {
    expect(
      historyPageQuery(scope, 10, { ingestedAt: scope.ingestFrom, arrivalId: "a" }),
    ).not.toContain("OFFSET");
  });

  it("1 query の上限を超える limit を拒む", () => {
    expect(() => historyPageQuery(scope, MAX_ROWS_PER_QUERY)).not.toThrow();
    expect(() => historyPageQuery(scope, MAX_ROWS_PER_QUERY + 1)).toThrow();
    expect(() => historyPageQuery(scope, 0)).toThrow();
  });

  it("query へ載せられない値を拒む", () => {
    expect(() => historyPageQuery({ ...scope, storeId: "store'; DROP TABLE" }, 10)).toThrow();
    expect(() => historyPageQuery({ ...scope, ingestFrom: "2026-09-12" }, 10)).toThrow();
    expect(() => historyPageQuery({ ...scope, eventTimeFrom: 1.5 }, 10)).toThrow();
  });
});

describe("status と プローブ", () => {
  it("店舗ごとの件数と最新時刻を集計で取る", () => {
    const sql = historyStatusQuery({ ...scope, storeId: "store-1" });

    expect(sql).toContain("count(*) AS arrivals");
    expect(sql).toContain("max(eventTime) AS latestEventTime");
    expect(sql).toContain("GROUP BY storeId");
    expect(sql).toContain("storeId = 'store-1'");
  });

  it("プローブは ID を名指しで引く", () => {
    const sql = probeVisibilityQuery(scope, "probe-1");

    expect(sql).toContain("probeId = 'probe-1'");
    expect(sql).toContain("LIMIT 2");
    // 合成行を引く query ゆえ、isSynthetic の除外を持ち込まない。
    expect(sql).not.toContain("isSynthetic = false");
  });
});

describe("次の cursor", () => {
  it("最後の行の鍵を返す", () => {
    expect(
      nextCursor([
        { [INGEST_COLUMN]: "2026-09-12T06:00:00Z", arrivalId: "a" },
        { [INGEST_COLUMN]: "2026-09-12T06:01:00Z", arrivalId: "b" },
      ]),
    ).toEqual({ ingestedAt: "2026-09-12T06:01:00Z", arrivalId: "b" });
  });

  it("行が無ければ終わりとする", () => {
    expect(nextCursor([])).toBeUndefined();
  });

  it("鍵を読めない行では続きを作らない", () => {
    expect(nextCursor([{ [INGEST_COLUMN]: 1, arrivalId: "a" }])).toBeUndefined();
  });
});
