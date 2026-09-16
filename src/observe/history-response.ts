// R2 SQL の応答の解釈（純粋）。送信は tools/observe が行う。
//
// 応答の形は Cloudflare の公開資料と wrangler の実装に合わせてある。`result.rows` は列名を鍵にした
// オブジェクトの配列で、走査量は `result.metrics` に出る。**継続 token は無い**——次のページは
// こちらが cursor 条件を書いて取りに行く（要件 7.8）。
//
// 失敗を握り潰さない。`success: false` の応答も、形が違う応答も、どちらも「読めなかった」として
// 呼び出し側へ返し、0 件と混同させない。

/** 1 query の走査量。費用と上限超過の判断材料として manifest へ残す。 */
export interface QueryMetrics {
  readonly bytesScanned: number;
  readonly filesScanned: number;
  readonly r2Requests: number;
}

export type QueryOutcome =
  | {
      readonly ok: true;
      readonly rows: readonly Readonly<Record<string, unknown>>[];
      readonly columns: readonly string[];
      readonly metrics: QueryMetrics;
    }
  | {
      readonly ok: false;
      readonly failure: "rejected" | "malformed-response";
      readonly errors: readonly { readonly code: number; readonly message: string }[];
    };

/** 再試行してよい失敗（接続断など）。SQL の誤りは何度送っても同じなので含めない。 */
const RETRYABLE_CODES = new Set([80001]);

export function isRetryable(outcome: QueryOutcome): boolean {
  return !outcome.ok && outcome.errors.some(({ code }) => RETRYABLE_CODES.has(code));
}

function readErrors(value: unknown): readonly { code: number; message: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { code, message } = entry as Record<string, unknown>;
    return [
      {
        code: typeof code === "number" ? code : 0,
        message: typeof message === "string" ? message : "",
      },
    ];
  });
}

function readMetrics(value: unknown): QueryMetrics {
  const metrics = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const read = (key: string): number => (typeof metrics[key] === "number" ? metrics[key] : 0);
  return {
    bytesScanned: read("bytes_scanned"),
    filesScanned: read("files_scanned"),
    r2Requests: read("r2_requests_count"),
  };
}

/** 応答 JSON を、行と走査量、または失敗へ写す。 */
export function readQueryResponse(body: unknown): QueryOutcome {
  if (typeof body !== "object" || body === null) {
    return { ok: false, failure: "malformed-response", errors: [] };
  }
  const envelope = body as Record<string, unknown>;
  const errors = readErrors(envelope.errors);

  if (envelope.success !== true) {
    return { ok: false, failure: "rejected", errors };
  }

  const result = envelope.result;
  if (typeof result !== "object" || result === null) {
    return { ok: false, failure: "malformed-response", errors };
  }
  const { rows, schema, metrics } = result as Record<string, unknown>;
  if (!Array.isArray(rows)) {
    return { ok: false, failure: "malformed-response", errors };
  }
  if (!rows.every((row) => typeof row === "object" && row !== null && !Array.isArray(row))) {
    return { ok: false, failure: "malformed-response", errors };
  }

  const columns = Array.isArray(schema)
    ? schema.flatMap((field) => {
        const name = (field as Record<string, unknown> | null)?.name;
        return typeof name === "string" ? [name] : [];
      })
    : [];

  return {
    ok: true,
    rows: rows as readonly Readonly<Record<string, unknown>>[],
    columns,
    metrics: readMetrics(metrics),
  };
}

/**
 * warehouse 名からアカウントとバケットへ分ける。R2 SQL の URL はこの 2 つで組む。
 * warehouse は `{accountId}_{bucket}` の形で、バケット名にも `_` が入り得るので**最初の 1 個**で切る。
 */
export function splitWarehouse(
  warehouse: string,
): { readonly accountId: string; readonly bucket: string } | undefined {
  const separator = warehouse.indexOf("_");
  if (separator <= 0 || separator === warehouse.length - 1) return undefined;
  return {
    accountId: warehouse.slice(0, separator),
    bucket: warehouse.slice(separator + 1),
  };
}

/** query を送る URL。host は R2 SQL 専用で、api.cloudflare.com とは別である。 */
export function queryEndpoint(warehouse: string): string | undefined {
  const parts = splitWarehouse(warehouse);
  if (parts === undefined) return undefined;
  return `https://api.sql.cloudflarestorage.com/api/v1/accounts/${parts.accountId}/r2-sql/query/${parts.bucket}`;
}
