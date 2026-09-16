import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { connectSolver } from "./cloud-client.mjs";

const directory = process.argv[2];
const output = process.argv[3];
assert(directory && output);
const solver = await connectSolver({ local: process.argv.includes("--local") });
const capturedBytes = await readFile(`${directory}/captures.json`);
const captures = JSON.parse(capturedBytes);
const startedAt = new Date().toISOString();
const boundaries = [];
const rows = [];
const completedRequests = [];
const report = {
  startedAt,
  runtime: solver.ready,
  capturesSha256: createHash("sha256").update(capturedBytes).digest("hex"),
  boundaries,
  rows,
  completedRequests,
  allOutcomesEqualLocalWasm: false,
};
await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
let saving = Promise.resolve();
function checkpoint() {
  const snapshot = JSON.stringify(report, null, 2) + "\n";
  saving = saving.then(async () => {
    await writeFile(`${output}.tmp`, snapshot, { mode: 0o600 });
    await rename(`${output}.tmp`, output);
  });
  return saving;
}
try {
  if (!process.argv.includes("--minimal")) {
    async function boundary(path, options, status, auth = true) {
      const r = await solver.request(path, options, auth);
      assert.equal(r.status, status);
      boundaries.push({ path, status });
    }
    const headers = {
      "content-type": "application/octet-stream",
      "x-cpsat-request-id": randomUUID(),
    };
    await boundary("/health", {}, 401, false);
    await boundary("/health", { headers: { authorization: `Bearer ${"0".repeat(64)}` } }, 401);
    await boundary("/solve-model", {}, 405);
    await boundary("/solve-model?deterministicLimit=0.1", { method: "POST" }, 415);
    for (const query of [
      "deterministicLimit=0",
      "deterministicLimit=0.201",
      "deterministicLimit=NaN",
      "deterministicLimit=0.1&repeat=2",
      "deterministicLimit=0.1&clock=host",
      "deterministicLimit=0.1&deterministicLimit=0.1",
    ])
      await boundary(`/solve-model?${query}`, { method: "POST", headers }, 400);
    await boundary(
      "/solve-model?deterministicLimit=0.1",
      { method: "POST", headers, body: new Uint8Array() },
      413,
    );
    await boundary(
      "/solve-model?deterministicLimit=0.1",
      { method: "POST", headers, body: new Uint8Array(1048577) },
      413,
    );
    await boundary(
      "/solve-model?deterministicLimit=0.1",
      { method: "POST", headers, body: new Uint8Array([255]) },
      422,
    );
  }
  // A separate untimed warm-up keeps the serial batch from uniquely paying startup.
  const warmup = await solver.solve(captures[0].model, captures[0].wasm.protoBase64);
  report.warmupMs = warmup.clientElapsedMs;
  for (const key of ["status", "objective", "solution", "deterministicTime"])
    assert.deepEqual(warmup[key], captures[0].wasm[key]);
  // Identical mixed workload at every concurrency. Cloud scheduling is not controlled.
  for (const parallel of process.argv.includes("--minimal") ? [] : [1, 2, 4]) {
    const queue = Array.from({ length: 12 }, (_, i) => ({
      index: i,
      capture: captures[i % captures.length],
    }));
    const begin = performance.now();
    const results = [];
    let stopped = false;
    const outcomes = await Promise.allSettled(
      Array.from({ length: parallel }, async () => {
        try {
          while (queue.length && !stopped) {
            const task = queue.shift();
            const r = await solver.solve(task.capture.model, task.capture.wasm.protoBase64);
            for (const key of ["status", "objective", "solution", "deterministicTime"])
              assert.deepEqual(
                r[key],
                task.capture.wasm[key],
                `Changed ${key}, model ${task.index}`,
              );
            results.push({
              index: task.index,
              status: r.status,
              elapsedMs: r.clientElapsedMs,
              memoryBytes: r.wasmMemoryBytes,
              isolateId: r.isolateId,
              cfRay: r.cfRay,
            });
            completedRequests.push({ parallel, ...results.at(-1) });
            await checkpoint();
          }
        } catch (error) {
          stopped = true;
          throw error;
        }
      }),
    );
    const failure = outcomes.find((r) => r.status === "rejected");
    if (failure) throw failure.reason;
    rows.push({
      parallel,
      requests: results.length,
      elapsedMs: performance.now() - begin,
      isolateCount: new Set(results.map((r) => r.isolateId)).size,
      results: results.sort((a, b) => a.index - b.index),
    });
  }
  report.allOutcomesEqualLocalWasm = true;
} catch (error) {
  report.failure = error.message;
  throw error;
} finally {
  report.completedAt = new Date().toISOString();
  await checkpoint();
}
console.log(
  JSON.stringify({
    runtime: solver.ready,
    boundaries: boundaries.length,
    allOutcomesEqualLocalWasm: true,
    rows: rows.map(({ results: _results, ...r }) => r),
  }),
);
