// 全ページ取得。実テーブルでは作れない状況（10,001 行超・境界の複製・資源拒否）を偽の実行体で置く。

import { describe, expect, it } from "vitest";
import { collectHistoryPages, type PageRunner } from "../../src/observe/history-fetch";
import {
  INGEST_COLUMN,
  MAX_ROWS_PER_QUERY,
  type HistoryScope,
} from "../../src/observe/history-query";
import type { QueryOutcome } from "../../src/observe/history-response";

const scope: HistoryScope = {
  dataset: "operation",
  table: "history.operation_arrivals_v1",
  ingestFrom: "2026-09-12T00:00:00Z",
  ingestTo: "2026-09-13T00:00:00Z",
};

const metrics = { bytesScanned: 10, filesScanned: 1, r2Requests: 1 };

const page = (rows: readonly Readonly<Record<string, unknown>>[]): QueryOutcome => ({
  ok: true,
  rows,
  columns: [INGEST_COLUMN, "arrivalId"],
  metrics,
});

/** 同じ取込時刻に並ぶ連番の行。鍵は到達 ID で一意になる（実データでも同秒は普通に起きる）。 */
const INGESTED_AT = "2026-09-12T06:00:00Z";
const rows = (from: number, count: number) =>
  Array.from({ length: count }, (_unused, index) => ({
    [INGEST_COLUMN]: INGESTED_AT,
    arrivalId: `arrival-${String(from + index).padStart(6, "0")}`,
  }));

/** 渡した順に応答する実行体。受け取った query も残す。 */
function runnerOf(outcomes: readonly QueryOutcome[]): { run: PageRunner; queries: string[] } {
  const queries: string[] = [];
  let index = 0;
  const run: PageRunner = (query) => {
    queries.push(query);
    const outcome = outcomes[index] ?? page([]);
    index += 1;
    return Promise.resolve(outcome);
  };
  return { run, queries };
}

describe("ページを辿る", () => {
  it("満杯でないページで完了とする", async () => {
    const { run, queries } = runnerOf([page(rows(0, 5)), page(rows(5, 2))]);

    const fetched = await collectHistoryPages(run, scope, { pageSize: 5, maxPages: 10 });

    expect(fetched.rows).toHaveLength(7);
    expect(fetched.pages).toBe(2);
    expect(fetched.incomplete).toBeNull();
    expect(queries).toHaveLength(2);
    // 2 回目は 1 回目の最後の鍵より後ろを引く。
    expect(queries[1]).toContain("arrival-000004");
  });

  it("1 query の上限を超える件数を複数ページで取る", async () => {
    const pageSize = MAX_ROWS_PER_QUERY;
    const { run } = runnerOf([
      page(rows(0, pageSize)),
      page(rows(pageSize, 1)), // 合計 10,001 行
    ]);

    const fetched = await collectHistoryPages(run, scope, { pageSize, maxPages: 5 });

    expect(fetched.rows).toHaveLength(MAX_ROWS_PER_QUERY + 1);
    expect(fetched.incomplete).toBeNull();
  });

  it("ページ予算に当たったら incomplete で止める", async () => {
    const { run } = runnerOf([page(rows(0, 5)), page(rows(5, 5)), page(rows(10, 5))]);

    const fetched = await collectHistoryPages(run, scope, { pageSize: 5, maxPages: 2 });

    expect(fetched.pages).toBe(2);
    expect(fetched.rows).toHaveLength(10);
    expect(fetched.incomplete).toBe("page-budget-exhausted");
    expect(fetched.lastCursor).toEqual({ ingestedAt: INGESTED_AT, arrivalId: "arrival-000009" });
  });

  it("境界に同じ鍵が並ぶページでは多重度を確定できないと示す", async () => {
    // 末尾 2 行が同じ鍵。cursor は「この鍵より後ろ」で進むため、残りがあっても次から落ちる。
    const duplicated = { [INGEST_COLUMN]: INGESTED_AT, arrivalId: "arrival-dup" };
    const { run } = runnerOf([page([...rows(0, 3), duplicated, duplicated])]);

    const fetched = await collectHistoryPages(run, scope, { pageSize: 5, maxPages: 5 });

    expect(fetched.incomplete).toBe("boundary-key-duplicated");
    // 取れた行は捨てない。数えられないのは「その先」だけである。
    expect(fetched.rows).toHaveLength(5);
  });

  it("同じ鍵がページの途中にあるだけなら完了できる", async () => {
    const duplicated = { [INGEST_COLUMN]: INGESTED_AT, arrivalId: "arrival-dup" };
    const { run } = runnerOf([page([duplicated, duplicated, ...rows(5, 1)])]);

    const fetched = await collectHistoryPages(run, scope, { pageSize: 5, maxPages: 5 });

    expect(fetched.incomplete).toBeNull();
    expect(fetched.rows).toHaveLength(3);
  });
});

describe("失敗の扱い", () => {
  const rejection: QueryOutcome = {
    ok: false,
    failure: "rejected",
    errors: [{ code: 40004, message: "query would scan too much data" }],
  };

  it("資源拒否では取れた分を残し、理由を伝える", async () => {
    const { run } = runnerOf([page(rows(0, 5)), rejection]);

    const fetched = await collectHistoryPages(run, scope, { pageSize: 5, maxPages: 5 });

    expect(fetched.rows).toHaveLength(5);
    expect(fetched.incomplete).toBe("query-failed");
    expect(fetched.errors).toEqual([{ code: 40004, message: "query would scan too much data" }]);
  });

  it("最初の query が失敗すれば 0 件でも完了とは呼ばない", async () => {
    const { run } = runnerOf([rejection]);

    const fetched = await collectHistoryPages(run, scope, { pageSize: 5, maxPages: 5 });

    expect(fetched.rows).toEqual([]);
    expect(fetched.incomplete).toBe("query-failed");
  });

  it("行が 0 件で成功したときだけ完了とする", async () => {
    const { run } = runnerOf([page([])]);

    const fetched = await collectHistoryPages(run, scope, { pageSize: 5, maxPages: 5 });

    expect(fetched.rows).toEqual([]);
    expect(fetched.incomplete).toBeNull();
  });

  it("上限外の pageSize を拒む", async () => {
    const { run } = runnerOf([]);

    await expect(
      collectHistoryPages(run, scope, { pageSize: MAX_ROWS_PER_QUERY + 1, maxPages: 1 }),
    ).rejects.toThrow();
  });
});
