import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const from = process.argv[2];
const output = process.argv[3];
const to = process.argv[4] ?? new Date().toISOString();
assert(Number.isFinite(Date.parse(from)) && Date.parse(to) > Date.parse(from) && output);
const account = "305d89a643ac689b4204454c5493cbde";
const worker = "yude-men-cpsat-search";
const auth =
  process.env.CLOUDFLARE_API_TOKEN ??
  /^oauth_token\s*=\s*"([^"]+)"/m.exec(
    await readFile(join(homedir(), "Library/Preferences/.wrangler/config/default.toml"), "utf8"),
  )?.[1];
assert(auth, "Cloudflare credential unavailable");
async function request(path, body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, {
    method: body ? "POST" : "GET",
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  assert(
    response.ok && !result.errors?.length,
    `Cloudflare API status ${response.status}: ${JSON.stringify(result.errors)}`,
  );
  return result;
}
const settings = (await request(`accounts/${account}/workers/scripts/${worker}/settings`)).result;
const deployments = (await request(`accounts/${account}/workers/scripts/${worker}/deployments`))
  .result;
const priorPoc = (
  await request(`accounts/${account}/workers/scripts/yude-men-cpsat-wasm-poc/deployments`)
).result;
const deploymentSummary = (result) =>
  result.deployments.map(({ id, created_on, versions }) => ({ id, created_on, versions }));
const query = `query Metrics($account: string, $worker: string, $from: string, $to: string) {
  viewer { accounts(filter: {accountTag: $account}) {
    workersInvocationsAdaptive(limit: 10000, filter: {scriptName: $worker, datetime_geq: $from, datetime_leq: $to}) {
      dimensions { scriptName scriptVersion coloCode status datetime }
      quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 wallTimeP99 }
      max { cpuTime wallTime memoryUsageBytes wasmMemoryBytes }
      sum { requests errors subrequests cpuTimeUs }
      avg { sampleInterval }
    }
  } }
  units: __type(name: "AccountWorkersInvocationsAdaptiveMax") { fields { name description } }
  sums: __type(name: "AccountWorkersInvocationsAdaptiveSum") { fields { name description } }
  averages: __type(name: "AccountWorkersInvocationsAdaptiveAvg") { fields { name description } }
}`;
const variables = { account, worker, from, to };
const result = await request("graphql", { query, variables });
const rows = result.data.viewer.accounts[0].workersInvocationsAdaptive;
const report = {
  collectedAt: new Date().toISOString(),
  from,
  to,
  account,
  worker,
  settings: {
    usageModel: settings.usage_model,
    limits: settings.limits,
    compatibilityDate: settings.compatibility_date,
    compatibilityFlags: settings.compatibility_flags,
    bindings: settings.bindings.map(({ name, type }) => ({ name, type })),
  },
  deployments: deploymentSummary(deployments),
  priorPocDeployments: deploymentSummary(priorPoc),
  graphql: { query, variables, data: result.data },
  summary: {
    rows: rows.length,
    requests: rows.reduce((sum, r) => sum + r.sum.requests, 0),
    errors: rows.reduce((sum, r) => sum + r.sum.errors, 0),
    cpuTimeSeconds: rows.reduce((sum, r) => sum + r.sum.cpuTimeUs, 0) / 1000000,
    maxSampleInterval: rows.length ? Math.max(...rows.map((r) => r.avg.sampleInterval)) : null,
    statuses: [...new Set(rows.map((r) => r.dimensions.status))],
    maxCpuTimeMs: rows.length ? Math.max(...rows.map((r) => r.max.cpuTime)) / 1000 : null,
    maxMemoryBytes: rows.length ? Math.max(...rows.map((r) => r.max.memoryUsageBytes)) : null,
    maxWasmMemoryBytes: rows.length ? Math.max(...rows.map((r) => r.max.wasmMemoryBytes)) : null,
  },
};
await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
console.log(
  JSON.stringify({
    summary: report.summary,
    settings: report.settings,
    sumFields: result.data.sums,
    avgFields: result.data.averages,
  }),
);
