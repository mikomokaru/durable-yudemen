import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const directory = resolve("experiments/cpsat-workers");
const local = `${directory}/fixtures/local`;
const read = async (name) => JSON.parse(await readFile(`${local}/${name}`, "utf8"));
const [scenes, native, worker, checks] = await Promise.all([
  read("real-scenes.json"),
  read("native-real.json"),
  read("worker-real.json"),
  read("real-checks.json"),
]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(hash(await readFile(`${local}/native-real.json`)), checks.nativeSha256);
assert.equal(worker.nativeSha256, checks.nativeSha256);
assert.equal(native.sceneSha256, checks.sceneSha256);
assert.equal(hash(await readFile(`${local}/real-scenes.json`)), checks.sceneSha256);
assert.equal(worker.requests.length, native.scenes.length * native.repeat * 2);
const models = new Map(native.scenes.map((model) => [model.id, model]));
function stats(values) {
  assert(values.length > 0 && values.every(Number.isFinite));
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
}
const environments = ["host", "frozen"].map((clock) => {
  const requests = worker.requests.filter((request) => request.clock === clock);
  const samples = requests.map((request) => request.body.samples[0]);
  const initialized = requests.filter((request) => request.body.runtime.initializedNow);
  assert(
    requests.every(
      (r) =>
        r.status === 200 &&
        r.body.runtime.searchWorkers === 1 &&
        r.body.runtime.pthreadsLinked === false,
    ),
  );
  assert(
    samples.every(
      (s) =>
        !s.sharedWasmMemory &&
        !s.wallTimeLimitEnabled &&
        s.requestedDeterministicLimit === native.budget,
    ),
  );
  if (clock === "frozen")
    assert(samples.every((s) => s.frozenClockReads > 0 && s.solverWallTimeMs === 0));
  const deterministicDeltas = requests.map((r) =>
    Math.abs(r.body.samples[0].deterministicTime - models.get(r.id).samples[0].deterministicTime),
  );
  assert(Math.max(...deterministicDeltas) < 1e-9);
  return {
    clock,
    solves: samples.length,
    observedIsolates: new Set(requests.map((r) => r.body.runtime.isolateId)).size,
    initializedRequests: initialized.length,
    serverReadyMs: worker.startup[clock],
    firstClientElapsedMs: requests[0].clientElapsedMs,
    firstInitializationMs: requests[0].body.runtime.initializationMs,
    warmClientElapsedMs: stats(
      requests.filter((r) => !r.body.runtime.initializedNow).map((r) => r.clientElapsedMs),
    ),
    wasmCapacityBytes: stats(samples.map((s) => s.wasmMemoryBytes)),
    sharedMemory: false,
    frozenClockReads: stats(samples.map((s) => s.frozenClockReads)),
    deterministicConsumed: stats(samples.map((s) => s.deterministicTime)),
    nativeDeterministicMaxDelta: Math.max(...deterministicDeltas),
  };
});
const files = [
  "cpp/cpsat_workers_poc.cc",
  "src/index.ts",
  "src/runtime.ts",
  "scripts/prepare-real-scenes.ts",
  "native/real_orders.py",
  "scripts/check-real-orders.ts",
  "scripts/benchmark-real-orders.mjs",
  "scripts/summarize-real-orders.mjs",
  "patches/or-tools-wasm-single-thread.patch",
  "vendor/cpsat_workers_poc_runtime.wasm",
];
const codeHashes = Object.fromEntries(
  await Promise.all(
    files.map(async (file) => [file, hash(await readFile(`${directory}/${file}`))]),
  ),
);
const summary = {
  measuredAt: worker.measuredAt,
  host: worker.host,
  repositoryBase: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  toolchain: {
    native: "ortools==9.15.6755",
    wasmRevision: "e1453348bc43d3b0afc0c2e5a535f5c9b45326f4",
    emscripten: "4.0.20",
    wrangler: execFileSync("pnpm", ["exec", "wrangler", "--version"], { encoding: "utf8" }).trim(),
  },
  localOnly: true,
  deploymentPerformed: false,
  seed: scenes.seed,
  assumptions: scenes.assumptions,
  sourceHashes: {
    scenes: checks.sceneSha256,
    admin: scenes.adminSha256,
    policy: scenes.policySha256,
    native: checks.nativeSha256,
    worker: hash(await readFile(`${local}/worker-real.json`)),
  },
  codeHashes,
  stores: scenes.stores,
  scenes: native.scenes.length,
  repeats: native.repeat,
  allScenesFullyPinned: native.scenes.filter((model) => model.freeItems === 0).length,
  objective: native.objective,
  anchorPolicy: native.anchorPolicy,
  budget: native.budget,
  coverage: checks.coverage,
  modelVariables: stats(native.scenes.map((model) => model.modelVariables)),
  modelConstraints: stats(native.scenes.map((model) => model.modelConstraints)),
  protoBytes: stats(native.scenes.map((model) => Buffer.from(model.protoBase64, "base64").length)),
  validation: checks.environments,
  negativeControls: checks.negativeControls,
  liftNegativeControls: checks.liftNegativeControls,
  parityMismatches: checks.parityMismatches,
  environments,
  boundaries: worker.boundaries,
  limitations: [
    "100 distinct single-table scenes, not 1000 independent problems",
    "CP-SAT results are not fed back into the simulation",
    "Full business/change objective not encoded",
    "Baseline-anchored placements pinned; all baseline placements hinted",
    "No remote real-order measurement; Wasm capacity is not peak isolate memory or proof of no leaks",
  ],
};
const output = `${directory}/results/real-order-local-summary.json`;
await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`);
console.log(
  JSON.stringify({
    output,
    validation: summary.validation,
    environments,
    coverage: checks.coverage,
    allScenesFullyPinned: summary.allScenesFullyPinned,
    negativeControls: checks.negativeControls,
  }),
);
