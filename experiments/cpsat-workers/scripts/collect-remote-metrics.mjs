import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const accountId = "305d89a643ac689b4204454c5493cbde";
const workerName = "yude-men-cpsat-wasm-poc";
const directory = fileURLToPath(new URL("../results/", import.meta.url));
const benchmark = JSON.parse(await readFile(join(directory, "deterministic-remote.json"), "utf8"));
const from = new Date(Date.parse(benchmark.measuredAt) - 5000).toISOString();
const to = benchmark.completedAt ?? new Date().toISOString();
let token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  const authFile =
    process.env.CPSAT_CF_AUTH_FILE ??
    join(homedir(), "Library/Preferences/.wrangler/config/default.toml");
  const auth = await readFile(authFile, "utf8");
  token = /^oauth_token\s*=\s*"([^"]+)"/m.exec(auth)?.[1];
}
if (!token) throw new Error("Cloudflare credential unavailable (value never displayed)");

async function api(path, body) {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/${path}`,
    {
      method: body ? "POST" : "GET",
      redirect: "error",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const value = await response.json();
  if (!response.ok || !value.success) {
    throw new Error(`Cloudflare ${response.status}: ${JSON.stringify(value.errors)}`);
  }
  return value.result;
}

function pocPayload(source) {
  let parsed = source;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  if (typeof parsed?.message === "string") {
    try {
      parsed = JSON.parse(parsed.message);
    } catch {
      return undefined;
    }
  }
  if (parsed?.kind !== "cpsat-poc-result") return undefined;
  const {
    requestId,
    isolateId,
    caseName,
    clockMode,
    repeat,
    initializedNow,
    statuses,
    maxWasmMemoryBytes,
  } = parsed;
  return {
    requestId,
    isolateId,
    caseName,
    clockMode,
    repeat,
    initializedNow,
    statuses,
    maxWasmMemoryBytes,
  };
}

const report = { collectedAt: new Date().toISOString(), accountId, workerName };
try {
  const settings = await api(`workers/scripts/${workerName}/settings`);
  report.settings = {
    usageModel: settings.usage_model,
    limits: settings.limits,
    compatibilityDate: settings.compatibility_date,
    observability: settings.observability,
    bindings: settings.bindings?.map(({ name, type }) => ({ name, type })),
  };
  const deployments = await api(`workers/scripts/${workerName}/deployments`);
  report.deployments = deployments.deployments?.map(({ id, created_on, versions }) => ({
    id,
    created_on,
    versions,
  }));
  const query = {
    queryId: "cpsat-poc-ad-hoc",
    dry: true,
    view: "events",
    limit: 2000,
    timeframe: { from: Date.parse(from), to: Date.parse(to) },
    parameters: {
      filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: workerName }],
    },
  };
  report.query = query;
  const result = await api("workers/observability/telemetry/query", query);
  report.resultKeys = Object.keys(result);
  report.eventKeys = Object.keys(result.events ?? {});
  // Persist an allowlist only; never store request headers or raw event bodies.
  report.events = (result.events?.events ?? []).map((event) => {
    const worker = event.$workers ?? {};
    return {
      timestamp: event.timestamp,
      id: event.$metadata?.id,
      platformRequestId: worker.requestId,
      scriptName: worker.scriptName,
      cpuTimeMs: worker.cpuTimeMs,
      wallTimeMs: worker.wallTimeMs,
      outcome: worker.outcome,
      scriptVersion: worker.scriptVersion?.id,
      requestUrl: worker.event?.request?.url,
      responseStatus: worker.event?.response?.status,
      poc: pocPayload(event.source),
    };
  });
  report.count = report.events.length;
  report.metricsCount = report.events.filter((event) => typeof event.cpuTimeMs === "number").length;
} catch (error) {
  report.telemetryFailure = error.message;
}

// OAuth credentials may read Workers analytics even when the newer telemetry
// API requires an additional scope. These aggregate metrics are a separate
// source, not per-request replacements for missing invocation logs.
try {
  const query = `query Metrics($account: string, $worker: string, $from: string, $to: string) {
    viewer { accounts(filter: {accountTag: $account}) {
      workersInvocationsAdaptive(limit: 1000, filter: {
        scriptName: $worker, datetime_geq: $from, datetime_leq: $to
      }) {
        dimensions { scriptName scriptVersion coloCode status datetime }
        quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 wallTimeP99 }
        max { cpuTime wallTime memoryUsageBytes wasmMemoryBytes }
        sum { requests errors subrequests }
      }
    } }
    units: __type(name: "AccountWorkersInvocationsAdaptiveMax") { fields { name description } }
  }`;
  const variables = {
    account: accountId,
    worker: workerName,
    from,
    to,
  };
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const result = await response.json();
  if (!response.ok || result.errors?.length) throw new Error(JSON.stringify(result.errors));
  report.graphql = { query, variables, data: result.data };
  const rows = result.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  if (rows.length === 0) throw new Error("No analytics rows yet; retry after ingestion");
  report.summary = {
    rows: rows.length,
    requests: rows.reduce((sum, row) => sum + row.sum.requests, 0),
    errors: rows.reduce((sum, row) => sum + row.sum.errors, 0),
    maxCpuTimeMs: Math.max(...rows.map((row) => row.max.cpuTime)) / 1000,
    maxWallTimeMs: Math.max(...rows.map((row) => row.max.wallTime)) / 1000,
    maxMemoryUsageBytes: Math.max(...rows.map((row) => row.max.memoryUsageBytes)),
    maxWasmMemoryBytes: Math.max(...rows.map((row) => row.max.wasmMemoryBytes)),
  };
} catch (error) {
  report.graphqlFailure = error.message;
  process.exitCode = 1;
}
await writeFile(join(directory, "remote-metrics.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      count: report.count,
      metricsCount: report.metricsCount,
      telemetryFailure: report.telemetryFailure,
      graphqlRows: report.graphql?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive?.length,
      graphqlFailure: report.graphqlFailure,
      summary: report.summary,
      settings: report.settings,
    },
    null,
    2,
  ),
);
