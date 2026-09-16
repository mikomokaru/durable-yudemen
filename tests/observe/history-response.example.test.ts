// R2 SQL の応答の解釈。読めなかったことと 0 件を混同しない、が全ての主張である。

import { describe, expect, it } from "vitest";
import {
  isRetryable,
  queryEndpoint,
  readQueryResponse,
  splitWarehouse,
} from "../../src/observe/history-response";

const success = {
  success: true,
  errors: [],
  result: {
    schema: [
      { name: "storeId", type: "string" },
      { name: "eventTime", type: "long" },
    ],
    rows: [{ storeId: "store-1", eventTime: 1_700_000_000_000 }],
    metrics: { r2_requests_count: 3, files_scanned: 2, bytes_scanned: 10_240 },
  },
};

describe("応答の解釈", () => {
  it("行・列名・走査量を読む", () => {
    const outcome = readQueryResponse(success);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rows).toEqual([{ storeId: "store-1", eventTime: 1_700_000_000_000 }]);
    expect(outcome.columns).toEqual(["storeId", "eventTime"]);
    expect(outcome.metrics).toEqual({ bytesScanned: 10_240, filesScanned: 2, r2Requests: 3 });
  });

  it("成功して 0 件なら 0 件として読む", () => {
    const outcome = readQueryResponse({ ...success, result: { ...success.result, rows: [] } });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.rows).toEqual([]);
  });

  it("拒否された query を 0 件にしない", () => {
    const outcome = readQueryResponse({
      success: false,
      errors: [{ code: 40003, message: "invalid SQL" }],
      result: null,
    });

    expect(outcome).toEqual({
      ok: false,
      failure: "rejected",
      errors: [{ code: 40003, message: "invalid SQL" }],
    });
  });

  it("認可されない応答も読めなかったとして扱う", () => {
    // 権限不足は 403 と本文で返る。本文に result が無いので 0 件と区別できる。
    const outcome = readQueryResponse({
      success: false,
      errors: [{ code: 10000, message: "Authentication error" }],
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.errors[0]?.code).toBe(10000);
  });

  it("JSON でない応答（HTML のエラーページ等）を形の問題として扱う", () => {
    // fetch 側で JSON.parse に失敗すれば呼び出し側が例外を掴むが、文字列が来た場合もここで落とす。
    expect(readQueryResponse("<html>502</html>")).toEqual({
      ok: false,
      failure: "malformed-response",
      errors: [],
    });
    expect(readQueryResponse(null)).toEqual({
      ok: false,
      failure: "malformed-response",
      errors: [],
    });
  });

  it("行が配列でない・行がオブジェクトでない応答を弾く", () => {
    expect(readQueryResponse({ ...success, result: { rows: "none" } }).ok).toBe(false);
    expect(readQueryResponse({ ...success, result: { rows: [1, 2] } }).ok).toBe(false);
  });

  it("走査量が無い応答でも 0 として読む（欠落を推測で埋めない）", () => {
    const outcome = readQueryResponse({ ...success, result: { ...success.result, metrics: {} } });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.metrics.bytesScanned).toBe(0);
  });
});

describe("再試行してよい失敗", () => {
  it("接続断だけを再試行の対象にする", () => {
    expect(
      isRetryable({ ok: false, failure: "rejected", errors: [{ code: 80001, message: "edge" }] }),
    ).toBe(true);
  });

  it("SQL の誤り・資源拒否は繰り返さない", () => {
    for (const code of [40003, 40004, 10000]) {
      expect(isRetryable({ ok: false, failure: "rejected", errors: [{ code, message: "" }] })).toBe(
        false,
      );
    }
  });

  it("成功は再試行しない", () => {
    expect(isRetryable(readQueryResponse(success))).toBe(false);
  });
});

describe("warehouse から URL を組む", () => {
  it("最初の下線で account と bucket に分ける", () => {
    expect(splitWarehouse("305d89a643ac689b4204454c5493cbde_yude-men-history")).toEqual({
      accountId: "305d89a643ac689b4204454c5493cbde",
      bucket: "yude-men-history",
    });
  });

  it("bucket 名に下線があっても壊さない", () => {
    expect(splitWarehouse("acct_my_bucket_name")?.bucket).toBe("my_bucket_name");
  });

  it("分けられない warehouse では URL を作らない", () => {
    for (const warehouse of ["", "nounderscore", "_leading", "trailing_"]) {
      expect(queryEndpoint(warehouse)).toBeUndefined();
    }
  });

  it("R2 SQL 専用の host を使う", () => {
    expect(queryEndpoint("acct_bucket")).toBe(
      "https://api.sql.cloudflarestorage.com/api/v1/accounts/acct/r2-sql/query/bucket",
    );
  });
});
