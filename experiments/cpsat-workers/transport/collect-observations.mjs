#!/usr/bin/env node
// Pull the trial's observation rows out of Workers Logs and summarise them.
//
//   set -a; . experiments/cpsat-workers/fixtures/local/observability.env; set +a
//   node experiments/cpsat-workers/transport/collect-observations.mjs OUT.json [minutes]
//
// What the query returns is not the same as what happened. Sampling, retention
// and export gaps all shrink it, and none of them are visible in the rows
// themselves. So the coverage this builds says what is *known*, and anything
// unknown stays null — which makes the summariser refuse to report rates rather
// than report a floor as if it were a count.
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The summariser is TypeScript with extensionless imports, which Node cannot
// resolve on its own. Bundle it the same way the local harness does rather than
// keeping a second copy of the counting rules here.
const directory = dirname(fileURLToPath(import.meta.url));
const wranglerRequire = createRequire(
  createRequire(import.meta.url).resolve("wrangler/package.json"),
);
const { build } = wranglerRequire("esbuild");
const scratch = await mkdtemp(resolve(tmpdir(), "cpsat-collect-"));
const bundled = resolve(scratch, "summarize.mjs");
await build({
  entryPoints: [resolve(directory, "../../../src/observe/cpsat.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile: bundled,
});
const { summarizeCpsatObservations } = await import(bundled);

const ACCOUNT = "305d89a643ac689b4204454c5493cbde";
const WORKERS = ["yude-men-cpsat-planner-dev", "yude-men-cpsat-transport-shim-dev"];
const output = process.argv[2];
const minutes = Number(process.argv[3] ?? 15);
if (!output || !Number.isInteger(minutes) || minutes < 1 || minutes > 240)
  throw new Error("Usage: collect-observations.mjs OUT.json [minutes 1..240]");
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not set; load observability.env first.");

const call = async (path, init = {}) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, body };
};

// Windows are whole minutes so a run's edges cannot slice a bucket in half.
const to = Math.floor(Date.now() / 60_000) * 60_000;
const from = to - minutes * 60_000;

/** Head sampling and retention are settings, not something the rows reveal. */
async function observabilitySettings(worker) {
  const settings = await call(`accounts/${ACCOUNT}/workers/scripts/${worker}/settings`);
  if (!settings.ok) return { worker, status: settings.status, known: false };
  const observability = settings.body?.result?.observability ?? null;
  return {
    worker,
    status: settings.status,
    known: observability !== null,
    enabled: observability?.enabled ?? null,
    headSamplingRate:
      observability?.head_sampling_rate ?? observability?.logs?.head_sampling_rate ?? null,
  };
}

async function queryWorker(worker) {
  const pages = [];
  const rows = [];
  let cursor;
  // Bounded: a run must not page forever if the window is busier than expected.
  for (let page = 0; page < 20; page += 1) {
    const query = {
      queryId: `cpsat-collect-${worker}`,
      view: "events",
      limit: 1000,
      timeframe: { from, to },
      parameters: {
        filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: worker }],
      },
      ...(cursor ? { cursor } : {}),
    };
    // oxlint-disable-next-line no-await-in-loop
    const result = await call(`accounts/${ACCOUNT}/workers/observability/telemetry/query`, {
      method: "POST",
      body: JSON.stringify(query),
    });
    pages.push({
      page,
      status: result.status,
      ok: result.ok,
      count: result.body?.result?.events?.events?.length ?? null,
    });
    if (!result.ok) return { worker, pages, rows, complete: false };
    const events = result.body?.result?.events?.events ?? [];
    for (const event of events) {
      // 構造化ログの載り方は 2 つある。**両方を読む**——片方だけを読む形は、API の形が
      // 変わった日に静かに 0 行を返し、それが「何も起きていない」と読まれる（2026-09-13 実測：
      // `yude-men-cpsat-planner-dev` の行は `source` にしか載っておらず、下の 2 経路は 0 件だった）。
      if (event?.source && typeof event.source === "object") rows.push(event.source);
      else if (typeof event?.source === "string") rows.push(event.source);
      // Structured logs arrive as the console.log argument list; the row is the
      // first JSON object among them.
      for (const candidate of event?.$workers?.event?.logs?.flatMap((log) => log.message ?? []) ??
        [])
        rows.push(candidate);
      if (event?.$metadata?.message) rows.push(event.$metadata.message);
    }
    cursor = result.body?.result?.events?.cursor ?? undefined;
    if (!cursor || events.length === 0) return { worker, pages, rows, complete: true };
  }
  // Stopping at the page cap means the window was not fully read.
  return { worker, pages, rows, complete: false };
}

const settings = await Promise.all(WORKERS.map(observabilitySettings));
const queries = await Promise.all(WORKERS.map(queryWorker));
// 輸送の受領行は `CpsatObservation` ではない（`fact` を持たない）。観測スキーマの
// 集計には入らないが、**配送遅延の測定値はここにしかない**——`enqueuedAt`（Queue の
// 投入時刻）と `receivedAt` の差が R5.10 の主たる値である。集計と分けて、そのまま残す。
const receiptsOf = (rows) =>
  rows.flatMap((row) => {
    const value = typeof row === "string" ? tryParse(row) : row;
    return value && typeof value === "object" && typeof value.transport === "string" ? [value] : [];
  });
function tryParse(text) {
  const offset = text.indexOf('{"');
  if (offset < 0) return null;
  try {
    return JSON.parse(text.slice(offset));
  } catch {
    return null;
  }
}

const parsed = queries.flatMap((query) =>
  query.rows.flatMap((row) => {
    if (typeof row === "string") {
      const offset = row.indexOf('{"');
      if (offset < 0) return [];
      try {
        return [JSON.parse(row.slice(offset))];
      } catch {
        return [];
      }
    }
    return typeof row === "object" && row !== null ? [row] : [];
  }),
);

// Every unknown stays null. `summarizeCpsatObservations` then reports observed
// values but refuses `counts`, so nothing here can be read as a measured rate.
// Unknown must stay unknown. An earlier version fell through to 1 when the
// settings call was refused, which would have reported an unread sampling rate
// as full capture and let windows be published as measured rates.
const rates = settings.map((entry) =>
  entry.known && typeof entry.headSamplingRate === "number" ? entry.headSamplingRate : null,
);
const sampling = rates.every((rate) => rate !== null) ? Math.min(...rates) : null;
const scopes = [...new Set(parsed.map((row) => row?.storeRef))]
  .filter((ref) => typeof ref === "string" && /^[a-f0-9]{64}$/.test(ref))
  .flatMap((storeRef) => [
    { storeRef, backend: "cpsat", mode: "live" },
    { storeRef, backend: "cpsat", mode: "probe" },
  ]);
const coverage = {
  from,
  to,
  capturedFrom: from,
  capturedTo: to,
  // Retention is an account/plan setting this query does not report, so the
  // window's own start cannot be claimed as retained.
  retainedFrom: null,
  samplingRate: sampling,
  exportComplete: queries.every((query) => query.complete) ? true : false,
  scopes,
  gaps: [],
  frequencyLimits: null,
};

const summary = scopes.length > 0 ? summarizeCpsatObservations(parsed, coverage) : null;
const receipts = queries.flatMap((query) => receiptsOf(query.rows));
// 配送遅延はここで組む。求解時間を含まず、producer の時計も経由しない。
const deliveryLatency = receipts
  .filter(
    (row) =>
      row.transport === "cpsat-queue-consumer" &&
      typeof row.enqueuedAt === "number" &&
      typeof row.receivedAt === "number",
  )
  .map((row) => ({
    requestId: row.requestId ?? null,
    outcome: row.outcome ?? null,
    attempts: row.attempts ?? null,
    // R5.10 の主たる測定値。定義 2（時計 1 つ）である。
    enqueueToReceiveMs: row.receivedAt - row.enqueuedAt,
    // この受領が WASM の用意を負ったか。冷起動を分布から外す判定に用いる。
    coldStart: row.coldStart ?? null,
    initializations: row.initializations ?? null,
  }));

const report = {
  collectedAt: new Date().toISOString(),
  account: ACCOUNT,
  window: { from, to, minutes },
  settings,
  queries: queries.map(({ worker, pages, complete, rows }) => ({
    worker,
    pages,
    complete,
    rowsSeen: rows.length,
  })),
  parsedRows: parsed.length,
  transportReceipts: receipts.length,
  // 冷起動は分布から外す。**系列の 1 件目だけを外す形では足りない**——isolate が
  // 入れ替われば途中でも初期化が起きるので、受領行の `coldStart` で分ける。
  deliveryLatency: {
    definition:
      "Queue の message.timestamp から consumer の受領まで。求解時間を含まず、producer の時計を経由しない。",
    cold: deliveryLatency.filter((row) => row.coldStart === true),
    warm: deliveryLatency.filter((row) => row.coldStart !== true),
  },
  coverage,
  summary,
  limitations: [
    "Retention is unknown to this query, so coverage.retainedFrom stays null and no window can be reported as a rate.",
    "Head sampling is read from the Worker's settings, not from the rows; an unreadable setting leaves samplingRate null, which keeps every window off the rate reporting.",
    "A head sampling rate of 1 says no sampling was configured. It is not a guarantee that nothing was dropped: log limits and truncation are separate conditions.",
    "Reading those settings needs Workers Scripts Read, which this token does not have (403). Sampling is therefore unknown for this run.",
    "Stopping at the page cap sets exportComplete false. A complete read is not proof that nothing was dropped upstream.",
    "配送遅延は Queue の timestamp と consumer の時計の差である。両者は同一の時計ではないので、ミリ秒精度の主張にはしない。",
    "冷起動は受領行の coldStart で分ける。系列の 1 件目だけを外す形では、isolate の入れ替わりで途中に起きる初期化を取り逃す。",
    "No credential, header or raw request body is recorded here.",
  ],
};
const serialized = JSON.stringify(report, null, 2);
if (serialized.includes(token)) throw new Error("Refusing to write a report containing the token");
await writeFile(resolve(output), `${serialized}\n`, { flag: "wx" });
console.log(
  JSON.stringify(
    {
      report: resolve(output),
      parsedRows: parsed.length,
      usableForRates: summary?.usableForRates ?? null,
      issues: summary?.issues ?? null,
      queryStatuses: queries.flatMap((query) => query.pages.map((page) => page.status)),
    },
    null,
    2,
  ),
);
