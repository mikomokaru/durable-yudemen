// Read-only diagnostics. Never print or persist raw tail events (auth headers).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

assert(process.env.CPSAT_WRANGLER && process.argv[2]);
const events = [];
const child = spawn(
  process.env.CPSAT_WRANGLER,
  [
    "tail",
    "yude-men-cpsat-search",
    "--config",
    "experiments/cpsat-workers/search-worker/wrangler.jsonc",
    "--format",
    "json",
  ],
  { detached: true, stdio: ["ignore", "pipe", "ignore"] },
);
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.length) {
    const start = buffer.indexOf("{");
    if (start < 0) {
      buffer = "";
      break;
    }
    buffer = buffer.slice(start);
    let depth = 0,
      quoted = false,
      escaped = false,
      end = -1;
    for (let i = 0; i < buffer.length; i++) {
      const c = buffer[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        if (--depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end < 0) break;
    const raw = buffer.slice(0, end);
    buffer = buffer.slice(end);
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      continue;
    }
    const safe = {
      timestamp: event.eventTimestamp,
      outcome: event.outcome,
      scriptVersion: event.scriptVersion,
      cpuTime: event.cpuTime,
      wallTime: event.wallTime,
      responseStatus: event.event?.response?.status,
      exceptions: event.exceptions?.map((e) => ({ name: e.name, message: e.message })),
      logs: event.logs?.flatMap(
        (log) =>
          log.message?.flatMap((message) => {
            try {
              const p = JSON.parse(message);
              return p.kind === "cpsat-search-v1"
                ? [
                    {
                      requestId: p.requestId,
                      isolateId: p.isolateId,
                      status: p.status,
                      error: p.error,
                      wasmMemoryBytes: p.wasmMemoryBytes,
                    },
                  ]
                : [];
            } catch {
              return [];
            }
          }) ?? [],
      ),
    };
    events.push(safe);
    if (!process.argv.includes("--quiet")) console.log(JSON.stringify(safe));
  }
});
await new Promise((resolve) => setTimeout(resolve, 55000));
try {
  process.kill(-child.pid, "SIGTERM");
} catch (error) {
  if (error.code !== "ESRCH") throw error;
}
await writeFile(process.argv[2], JSON.stringify({ events }, null, 2) + "\n", {
  mode: 0o600,
  flag: "wx",
});
console.log(
  JSON.stringify({
    events: events.length,
    cpuTimeMs: events.reduce((s, e) => s + (e.cpuTime ?? 0), 0),
    outcomes: [...new Set(events.map((e) => e.outcome))],
  }),
);
