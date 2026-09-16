// Read-only query (dry: true), no saved query, subscription, deployment or solve.
// Only these new private Workers; never export request headers or raw log bodies.
import assert from "node:assert/strict";
import { readFile, writeFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const output = process.argv[2];
assert.ok(output && process.argv.length === 3, "Usage: check-bootstrap-logs.mjs NEW_REPORT.json");
await assert.rejects(access(resolve(output)), { code: "ENOENT" });
const token =
  process.env.CLOUDFLARE_API_TOKEN ??
  /^oauth_token\s*=\s*"([^"]+)"/m.exec(
    await readFile(
      process.env.CPSAT_CF_AUTH_FILE ??
        join(homedir(), "Library/Preferences/.wrangler/config/default.toml"),
      "utf8",
    ),
  )?.[1];
assert.ok(token, "Cloudflare credential unavailable");
const accountId = "305d89a643ac689b4204454c5493cbde";
const report = { collectedAt: new Date().toISOString(), accountId, queries: [] };
await Promise.all(
  ["yude-men-cpsat-planner-dev", "yude-men-cpsat-transport-shim-dev"].map(async (worker) => {
    const query = {
      queryId: "cpsat-transport-bootstrap",
      dry: true,
      view: "events",
      limit: 1000,
      timeframe: { from: Date.parse("2026-09-10T11:21:00Z"), to: Date.parse(report.collectedAt) },
      parameters: {
        filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: worker }],
      },
    };
    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/query`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(query),
        },
      );
      const value = await response.json();
      const events = value.result?.events?.events;
      report.queries.push({
        worker,
        query,
        status: response.status,
        success: value.success === true,
        errorCodes: value.errors?.map((error) => error.code) ?? [],
        // null is missing, not an assertion that no invocations happened.
        events: Array.isArray(events)
          ? events.map((event) => ({
              timestamp: event.timestamp,
              id: event.$metadata?.id,
              requestId: event.$workers?.requestId,
              version: event.$workers?.scriptVersion?.id,
              cpuTimeMs: event.$workers?.cpuTimeMs,
              wallTimeMs: event.$workers?.wallTimeMs,
              outcome: event.$workers?.outcome,
              responseStatus: event.$workers?.event?.response?.status,
            }))
          : null,
      });
      if (!response.ok || value.success !== true) process.exitCode = 1;
    } catch {
      report.queries.push({
        worker,
        query,
        status: null,
        success: false,
        events: null,
        error: "query-unavailable",
      });
      process.exitCode = 1;
    }
  }),
);
report.queries.sort((a, b) => a.worker.localeCompare(b.worker));
await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify(report));
