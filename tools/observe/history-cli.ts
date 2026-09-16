// 共通 observe の CLI（operation-history-log 要件 7.6〜7.8）。R2 SQL へ送り、取得と保存を行う端である。
//
// 純粋な組み立て・解釈・集計は `src/observe/` にあり、ここは I/O だけを持つ：引数、HTTP、ファイル、
// 有界な再試行。Worker へは載らない（Node の API を使う）。
//
// 出力は機械可読を既定にする。人が読む表は使う側が組み立てればよく、こちらが整形して壊すほうが損である。

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  MAX_ROWS_PER_QUERY,
  historyStatusQuery,
  type HistoryScope,
} from "../../src/observe/history-query";
import { collectHistoryPages, type FetchedHistory } from "../../src/observe/history-fetch";
import { checkProbeVisibility } from "../../src/observe/history-probe-check";
import {
  PIPELINE_HEALTH_QUERY,
  droppedByValidation,
  pendingOrDropped,
  readPipelineHealth,
} from "../../src/observe/pipelines-metrics";
import { summarizeHistoryRows } from "../../src/observe/history-summary";
import { summarizeLiftDelayRows } from "../../src/observe/lift-delay-summary";
import {
  isRetryable,
  queryEndpoint,
  readQueryResponse,
  type QueryOutcome,
} from "../../src/observe/history-response";
import { operationQualityAssessmentFromCounts } from "../../src/operation-history/quality";

const HELP = `history-cli — read the operation history stored in R2 Data Catalog (Iceberg).

Usage:
  history-cli status    [options]
  history-cli export    [options] --out <dir>
  history-cli summarize [options]
  history-cli probe     [options] --probe-id <id>

Required:
  --warehouse <name>      R2 Data Catalog warehouse (account_id + "_" + bucket)

Options:
  --table <name>          Iceberg table (default follows --dataset)
  --dataset <name>        operation | lift-delay | order-arrival (default: operation)
  --store <storeId>       limit to one store
  --ingest-from <ts>      ingest window start, RFC 3339 UTC (default: 24h ago)
  --ingest-to <ts>        ingest window end, RFC 3339 UTC (default: now)
  --event-from <epochMs>  event time lower bound
  --event-to <epochMs>    event time upper bound
  --include-synthetic     include probe rows (excluded by default)
  --page-size <n>         rows per query, 1..${MAX_ROWS_PER_QUERY} (default: 1000)
  --max-pages <n>         stop after n pages and report the result as incomplete (default: 20)
  --threshold <rate=value> quality threshold, repeatable; without all four, trust is not judged
  --out <dir>             export destination (export only)
  --pipeline-id <id>      read Pipelines metrics for this pipeline (status only)
  --account <id>          Cloudflare account id, needed with --pipeline-id
  --probe-id <id>         synthetic probe to confirm (probe only)
  --emitted-at <epochMs>  when the probe was emitted (default: now)
  --attempts <n>          confirmation attempts, bounded (default: 5)
  --deadline <seconds>    give up confirming after this long (default: 900)

Auth:
  WRANGLER_R2_SQL_AUTH_TOKEN or CLOUDFLARE_API_TOKEN must hold an R2 token with
  R2 SQL read, R2 Data Catalog read and R2 storage permissions.
  CLOUDFLARE_ANALYTICS_TOKEN is a separate token with Account Analytics Read; without
  it, Pipelines metrics are reported as unavailable rather than as zero.

Output is JSON on stdout. Exit code 1 means the request failed or the result is incomplete.`;

const RATE_NAMES = ["lifecycleMissingRate", "duplicateRate", "orphanRate", "conflictRate"] as const;

type RateName = (typeof RATE_NAMES)[number];

interface CliOptions {
  readonly command: "status" | "export" | "summarize" | "probe";
  readonly warehouse: string;
  readonly scope: HistoryScope;
  readonly pageSize: number;
  readonly maxPages: number;
  readonly out?: string;
  readonly thresholds?: Readonly<Record<RateName, number>>;
  readonly probeId?: string;
  readonly pipelineId?: string;
  readonly accountId?: string;
  readonly emittedAt: number;
  readonly attempts: number;
  readonly deadlineMs: number;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) fail(`--${name} needs a value`);
  return value;
}

function integer(argv: readonly string[], name: string, fallback: number): number {
  const raw = flag(argv, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) fail(`--${name} must be an integer`);
  return value;
}

function thresholds(argv: readonly string[]): Readonly<Record<RateName, number>> | undefined {
  const collected = new Map<string, number>();
  argv.forEach((candidate, index) => {
    if (candidate !== "--threshold") return;
    const [name, raw] = (argv[index + 1] ?? "").split("=");
    const value = Number(raw);
    if (!RATE_NAMES.includes(name as RateName) || !Number.isFinite(value)) {
      fail("--threshold takes <rateName>=<value>");
    }
    collected.set(name as RateName, value);
  });
  if (collected.size === 0) return undefined;
  const missing = RATE_NAMES.filter((name) => !collected.has(name));
  // 一部だけ渡して「満たした」と言わない。四つ揃わなければ判定しない（要件 5.6）。
  if (missing.length > 0) fail(`--threshold is missing: ${missing.join(", ")}`);
  return Object.fromEntries(RATE_NAMES.map((name) => [name, collected.get(name) ?? 0])) as Record<
    RateName,
    number
  >;
}

/** dataset ごとの既定テーブル。世代は名前の末尾に持つ（config/history-pipelines/README.md）。 */
function defaultTable(dataset: string): string {
  switch (dataset) {
    case "lift-delay":
      return "history.lift_delay_arrivals_v1";
    case "order-arrival":
      return "history.order_arrival_arrivals_v1";
    default:
      return "history.operation_arrivals_v1";
  }
}

function utc(at: number): string {
  return `${new Date(at).toISOString().slice(0, 19)}Z`;
}

export function parseArgs(argv: readonly string[], now: number): CliOptions {
  const [command] = argv;
  if (
    command !== "status" &&
    command !== "export" &&
    command !== "summarize" &&
    command !== "probe"
  ) {
    fail(HELP);
  }

  const warehouse = flag(argv, "warehouse") ?? fail("--warehouse is required");
  const out = flag(argv, "out");
  if (command === "export" && out === undefined) fail("export needs --out");

  const eventFrom = flag(argv, "event-from");
  const eventTo = flag(argv, "event-to");
  const scope: HistoryScope = {
    dataset: (flag(argv, "dataset") ?? "operation") as HistoryScope["dataset"],
    table: flag(argv, "table") ?? defaultTable(flag(argv, "dataset") ?? "operation"),
    ingestFrom: flag(argv, "ingest-from") ?? utc(now - 24 * 60 * 60 * 1000),
    ingestTo: flag(argv, "ingest-to") ?? utc(now),
    ...(flag(argv, "store") === undefined ? {} : { storeId: flag(argv, "store") as string }),
    ...(eventFrom === undefined ? {} : { eventTimeFrom: Number(eventFrom) }),
    ...(eventTo === undefined ? {} : { eventTimeTo: Number(eventTo) }),
    ...(argv.includes("--include-synthetic") ? { includeSynthetic: true } : {}),
  };

  const probeId = flag(argv, "probe-id");
  if (command === "probe" && probeId === undefined) fail("probe needs --probe-id");

  const parsed = thresholds(argv);
  return {
    command,
    emittedAt: integer(argv, "emitted-at", now),
    attempts: integer(argv, "attempts", 5),
    deadlineMs: integer(argv, "deadline", 900) * 1000,
    ...(probeId === undefined ? {} : { probeId }),
    ...(flag(argv, "pipeline-id") === undefined
      ? {}
      : { pipelineId: flag(argv, "pipeline-id") as string }),
    ...(flag(argv, "account") === undefined ? {} : { accountId: flag(argv, "account") as string }),
    warehouse,
    scope,
    pageSize: integer(argv, "page-size", 1000),
    maxPages: integer(argv, "max-pages", 20),
    ...(out === undefined ? {} : { out }),
    ...(parsed === undefined ? {} : { thresholds: parsed }),
  };
}

/** 1 query を送る。再試行は有界で、SQL の誤りは繰り返さない。 */
async function runQuery(
  endpoint: string,
  token: string,
  warehouse: string,
  query: string,
): Promise<QueryOutcome> {
  let last: QueryOutcome = { ok: false, failure: "malformed-response", errors: [] };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let outcome: QueryOutcome;
    try {
      // 再試行は直列である。並べて投げれば、拒否された query を同時に撃ち直すだけになる。
      // oxlint-disable-next-line no-await-in-loop
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ warehouse, query }),
      });
      // oxlint-disable-next-line no-await-in-loop
      outcome = readQueryResponse(await response.json());
    } catch (error) {
      outcome = {
        ok: false,
        failure: "malformed-response",
        errors: [{ code: 80001, message: `${error}` }],
      };
    }
    if (outcome.ok || !isRetryable(outcome)) return outcome;
    last = outcome;
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((wake) => setTimeout(wake, 500 * (attempt + 1)));
  }
  return last;
}

function manifest(options: CliOptions, fetched: FetchedHistory, startedAt: number, now: number) {
  return {
    reader: "r2-sql",
    table: options.scope.table,
    dataset: options.scope.dataset,
    storeId: options.scope.storeId ?? null,
    ingestWindow: { from: options.scope.ingestFrom, to: options.scope.ingestTo },
    eventWindow: {
      from: options.scope.eventTimeFrom ?? null,
      to: options.scope.eventTimeTo ?? null,
    },
    includesSynthetic: options.scope.includeSynthetic === true,
    queryVersion: 1,
    fetchedAt: { startedAt: utc(startedAt), finishedAt: utc(now) },
    pages: fetched.pages,
    pageSize: options.pageSize,
    rows: fetched.rows.length,
    lastCursor: fetched.lastCursor,
    scan: { bytesScanned: fetched.bytesScanned, filesScanned: fetched.filesScanned },
    // 「完全な固定 snapshot を取った」と言わないための二つ。複数 query は同じ snapshot を見る保証がない。
    completeness: fetched.incomplete === null ? "bounded-by-window" : "incomplete",
    incompleteReason: fetched.incomplete,
    snapshotConsistency: "not-guaranteed-across-queries",
    errors: fetched.errors,
  };
}

/** Pipelines の指標を取る。R2 の token とは別の認可を要するので、無ければ取得不能として返す。 */
async function pipelineMetrics(options: CliOptions): Promise<Record<string, unknown>> {
  const analyticsToken = process.env.CLOUDFLARE_ANALYTICS_TOKEN;
  if (options.pipelineId === undefined || options.accountId === undefined) {
    return { status: "not-requested", reason: "pipeline-id-or-account-not-given" };
  }
  if (analyticsToken === undefined || analyticsToken.length === 0) {
    return { status: "unavailable", reason: "analytics-credential-not-set" };
  }

  let body: unknown;
  try {
    const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${analyticsToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: PIPELINE_HEALTH_QUERY,
        variables: {
          accountTag: options.accountId,
          pipelineId: options.pipelineId,
          from: options.scope.ingestFrom,
          to: options.scope.ingestTo,
        },
      }),
    });
    body = await response.json();
  } catch (error) {
    return { status: "unavailable", reason: `request-failed: ${error}` };
  }

  const outcome = readPipelineHealth(body);
  if (!outcome.ok) {
    return { status: "unavailable", reason: outcome.failure, errors: outcome.errors };
  }
  return {
    status: "read",
    recordsIn: outcome.health.recordsIn,
    recordsWritten: outcome.health.recordsWritten,
    filesWritten: outcome.health.filesWritten,
    droppedByValidation: droppedByValidation(outcome.health),
    pendingOrDropped: pendingOrDropped(outcome.health),
    userErrors: outcome.health.userErrors,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help")) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  const startedAt = Date.now();
  const options = parseArgs(argv, startedAt);
  const token = process.env.WRANGLER_R2_SQL_AUTH_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN;
  if (token === undefined || token.length === 0) {
    fail("set WRANGLER_R2_SQL_AUTH_TOKEN (or CLOUDFLARE_API_TOKEN)");
  }
  const endpoint = queryEndpoint(options.warehouse) ?? fail("--warehouse must be account_bucket");

  if (options.command === "probe") {
    const check = await checkProbeVisibility(
      (query) => runQuery(endpoint, token, options.warehouse, query),
      options.scope,
      options.probeId ?? "",
      options.emittedAt,
      { attempts: options.attempts, deadlineMs: options.deadlineMs },
      {
        now: () => Date.now(),
        sleep: (ms) => new Promise((wake) => setTimeout(wake, ms)),
      },
    );
    // 合成経路の成否である。業務ログの全件到達率へ読み替えない（要件 7.4）。
    const body = {
      command: "probe",
      table: options.scope.table,
      check,
      meaning: "synthetic-path-liveness-only",
    };
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    if (check.status !== "visible") process.exit(1);
    return;
  }

  if (options.command === "status") {
    const outcome = await runQuery(
      endpoint,
      token,
      options.warehouse,
      historyStatusQuery(options.scope),
    );
    const body = {
      command: "status",
      table: options.scope.table,
      ingestWindow: { from: options.scope.ingestFrom, to: options.scope.ingestTo },
      stores: outcome.ok ? outcome.rows : [],
      scan: outcome.ok ? outcome.metrics : null,
      errors: outcome.ok ? [] : outcome.errors,
      // status が見せられるのは保存済みの行だけである。送信側のエラーは Worker のログにしか無く、
      // その取得経路は未確定（タスク 1.4）。0 件と取得不能を混同させない。
      pipelineMetrics: await pipelineMetrics(options),
      producerDiagnostics: { status: "not-wired", reason: "workers-logs-query-not-implemented" },
    };
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    if (!outcome.ok) process.exit(1);
    return;
  }

  const fetched = await collectHistoryPages(
    (query) => runQuery(endpoint, token, options.warehouse, query),
    options.scope,
    { pageSize: options.pageSize, maxPages: options.maxPages },
  );
  const meta = manifest(options, fetched, startedAt, Date.now());

  if (options.command === "export") {
    const directory = resolve(options.out ?? ".");
    await mkdir(directory, { recursive: true });
    await writeFile(
      resolve(directory, "arrivals.jsonl"),
      fetched.rows.map((row) => JSON.stringify(row)).join("\n") +
        (fetched.rows.length > 0 ? "\n" : ""),
      "utf8",
    );
    await writeFile(
      resolve(directory, "manifest.json"),
      `${JSON.stringify(meta, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(
      `${JSON.stringify({ command: "export", directory, manifest: meta }, null, 2)}\n`,
    );
    if (fetched.incomplete !== null) process.exit(1);
    return;
  }

  // 遅延 dataset は別の要約を使う。操作履歴の品質率は操作の lifecycle を前提にしており、
  // 開始と終端の 2 行で 1 つの事実になる遅延には当てはまらない。
  if (options.scope.dataset === "lift-delay") {
    const summary = summarizeLiftDelayRows(fetched.rows);
    process.stdout.write(
      `${JSON.stringify({ command: "summarize", manifest: meta, ...summary }, null, 2)}\n`,
    );
    if (fetched.incomplete !== null) process.exit(1);
    return;
  }

  const summary = summarizeHistoryRows(fetched.rows);
  const assessment =
    options.thresholds === undefined
      ? { status: "not-judged", reason: "thresholds-not-set" }
      : operationQualityAssessmentFromCounts({
          storeId: options.scope.storeId ?? "(all)",
          period: `${options.scope.ingestFrom}/${options.scope.ingestTo}`,
          counts: summary.qualityInput,
          thresholds: options.thresholds,
        });

  process.stdout.write(
    `${JSON.stringify(
      {
        command: "summarize",
        manifest: meta,
        counts: summary.counts,
        faults: summary.faults,
        quality: assessment,
      },
      null,
      2,
    )}\n`,
  );
  if (fetched.incomplete !== null) process.exit(1);
}

await main();
