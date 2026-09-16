// Pipelines の取込・配送・処理エラーの指標（operation-history-log 要件 7.1）。
//
// **これは業務イベント別の欠落率ではない。** 取込んだ件数、sink が書いた件数、検証で落ちた件数を、
// 集計として見るだけである。どの行が落ちたかは分からない——best-effort の収集でそこまで持たない、
// というのが設計の選択であり、その代わりに「落ちた件数が 0 でない」ことだけは見える。
//
// 認可は R2 の token とは別である（Account Analytics の読み取り）。無ければ status は取得不能と表示し、
// 0 件とは表示しない。

/** GraphQL の document。集計 3 種を 1 回で取る。 */
export const PIPELINE_HEALTH_QUERY = `query PipelineHealth($accountTag: string!, $pipelineId: string!, $from: Time!, $to: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      operator: pipelinesOperatorAdaptiveGroups(
        limit: 100
        filter: { pipelineId: $pipelineId, datetime_geq: $from, datetime_leq: $to }
      ) {
        sum { recordsIn decodeErrors bytesIn }
      }
      sink: pipelinesSinkAdaptiveGroups(
        limit: 100
        filter: { pipelineId: $pipelineId, datetime_geq: $from, datetime_leq: $to }
      ) {
        sum { recordsWritten filesWritten bytesWritten }
      }
      userErrors: pipelinesUserErrorsAdaptiveGroups(
        limit: 100
        filter: { pipelineId: $pipelineId, datetime_geq: $from, datetime_leq: $to }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { errorFamily errorType }
      }
    }
  }
}`;

export interface PipelineHealthVariables {
  readonly accountTag: string;
  readonly pipelineId: string;
  readonly from: string;
  readonly to: string;
}

export interface PipelineHealth {
  /** 取込んだ件数と、復号できなかった件数。 */
  readonly recordsIn: number;
  readonly decodeErrors: number;
  /** sink が書いた件数。取込との差が、落ちた分と処理中の分の合計である。 */
  readonly recordsWritten: number;
  readonly filesWritten: number;
  /** 検証で落ちた件数の内訳。種別ごとに残す（欠落を 1 つの数字に畳まない）。 */
  readonly userErrors: readonly {
    readonly errorFamily: string;
    readonly errorType: string;
    readonly count: number;
  }[];
}

export type PipelineHealthOutcome =
  | { readonly ok: true; readonly health: PipelineHealth }
  | {
      readonly ok: false;
      readonly failure: "rejected" | "malformed-response";
      readonly errors: readonly string[];
    };

function sumOf(groups: unknown, field: string): number {
  if (!Array.isArray(groups)) return 0;
  return groups.reduce((total: number, group) => {
    const sum = (group as Record<string, unknown> | null)?.sum;
    const value = (sum as Record<string, unknown> | null)?.[field];
    return total + (typeof value === "number" ? value : 0);
  }, 0);
}

function readUserErrors(groups: unknown): PipelineHealth["userErrors"] {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group) => {
    const entry = group as Record<string, unknown>;
    const dimensions = (entry.dimensions ?? {}) as Record<string, unknown>;
    const count = entry.count;
    if (typeof count !== "number") return [];
    return [
      {
        errorFamily: typeof dimensions.errorFamily === "string" ? dimensions.errorFamily : "",
        errorType: typeof dimensions.errorType === "string" ? dimensions.errorType : "",
        count,
      },
    ];
  });
}

/** GraphQL の応答を指標へ写す。errors があれば取得できなかったものとして扱う。 */
export function readPipelineHealth(body: unknown): PipelineHealthOutcome {
  if (typeof body !== "object" || body === null) {
    return { ok: false, failure: "malformed-response", errors: [] };
  }
  const envelope = body as Record<string, unknown>;
  const graphqlErrors = Array.isArray(envelope.errors)
    ? envelope.errors.flatMap((error) => {
        const message = (error as Record<string, unknown> | null)?.message;
        return typeof message === "string" ? [message] : [];
      })
    : [];
  if (graphqlErrors.length > 0) {
    return { ok: false, failure: "rejected", errors: graphqlErrors };
  }

  const accounts = (
    (envelope.data as Record<string, unknown> | null)?.viewer as Record<string, unknown> | null
  )?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return { ok: false, failure: "malformed-response", errors: [] };
  }
  const account = accounts[0] as Record<string, unknown>;

  return {
    ok: true,
    health: {
      recordsIn: sumOf(account.operator, "recordsIn"),
      decodeErrors: sumOf(account.operator, "decodeErrors"),
      recordsWritten: sumOf(account.sink, "recordsWritten"),
      filesWritten: sumOf(account.sink, "filesWritten"),
      userErrors: readUserErrors(account.userErrors),
    },
  };
}

/**
 * 取込と書込の差。**「落ちた件数」ではない**——sink の roll 待ちの分も差に出る。
 * 落ちたと言い切れるのは `decodeErrors` と `userErrors` の合計だけである。
 */
export function pendingOrDropped(health: PipelineHealth): number {
  return health.recordsIn - health.recordsWritten;
}

export function droppedByValidation(health: PipelineHealth): number {
  return health.decodeErrors + health.userErrors.reduce((total, entry) => total + entry.count, 0);
}
