// Local workerd only. Node orchestrates; it never instantiates or solves Wasm.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const directory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// Reuse Wrangler's pinned tooling; do not add another workerd or test framework.
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { build } = wranglerRequire("esbuild");
const { Miniflare, Log, LogLevel } = wranglerRequire("miniflare");
const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
const fixtures = JSON.parse(await readFile(resolve(directory, "fixtures.json"), "utf8"));
const wasm = await readFile(resolve(directory, "../vendor/cpsat_workers_poc_runtime.wasm"));
const glue = await readFile(resolve(directory, "../vendor/cpsat_workers_poc_runtime.js"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
assert.equal(hash(wasm), manifest.wasm);
assert.equal(hash(glue), manifest.glue);
for (const fixture of fixtures.fixtures) {
  const bytes = Buffer.from(fixture.protoBase64, "base64");
  assert.equal(hash(bytes), fixture.sha256);
  assert.equal(bytes.length, fixture.byteLength);
}
assert.equal(manifest.enabled, false, "The checked-in manifest must remain inert");
const scratch = await mkdtemp(resolve(tmpdir(), "cpsat-transport-local-"));
const trial = {
  ...manifest,
  enabled: true,
  notBefore: Date.now() - 1000,
  expiresAt: Date.now() + 120_000,
};
const output = process.argv[2];
if (!output || process.argv.length !== 3)
  throw new Error("Usage: node check-local.mjs NEW_REPORT.json");
const report = {
  measuredAt: new Date().toISOString(),
  environment: "local-workerd",
  cloudEvidence: false,
  appEffectPathTested: false,
  callback: "local RPC test double",
  manifest: trial,
  wasmSha256: hash(wasm),
  glueSha256: hash(glue),
  fixtures: fixtures.fixtures.map(({ protoBase64: _, ...fixture }) => fixture),
  toolchain: {
    node: process.version,
    wrangler: wranglerRequire("./package.json").version,
    miniflare: wranglerRequire("miniflare/package.json").version,
    esbuild: wranglerRequire("esbuild/package.json").version,
  },
  checks: {},
  driverObservations: [],
  requests: [],
  callbacks: [],
  nativeComparisons: [],
  observations: [],
  scratch,
};
let holdCallback;
let failCallback = false;
const rows = [];
const runtimeText = [];
let release;
let worker;

async function bundle(enabled, overrides = {}) {
  const result = await build({
    absWorkingDir: directory,
    entryPoints: ["solver.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    metafile: true,
    plugins: [
      {
        name: "local-fixed-manifest",
        setup(bundler) {
          bundler.onResolve({ filter: /\.wasm$/ }, () => ({
            path: "./runtime.wasm",
            external: true,
          }));
          bundler.onLoad({ filter: /\/transport\/manifest\.json$/ }, () => ({
            contents: JSON.stringify({ ...trial, enabled, ...overrides }),
            loader: "json",
          }));
        },
      },
    ],
  });
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(
    !inputs.some((input) => /\.py$|tuning\/|src\/cpsat\/(plan|protobuf|request)\.ts$/.test(input)),
  );
  report.bundleInputs = inputs;
  return result.outputFiles[0].text;
}

function row(fixture = fixtures.fixtures[0]) {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    at: Date.now(),
    storeRef: manifest.stores[0].ref,
    backend: "cpsat",
    mode: "probe",
    instanceId: "local-driver",
    invocationId: randomUUID(),
    parentEventId: null,
    versions: {
      code: manifest.code,
      codec: manifest.codec,
      model: fixture.sha256,
      wasm: manifest.wasm,
      glue: manifest.glue,
      profile: manifest.profile,
      budget: String(fixture.budget),
      missingReason: null,
    },
    fact: {
      type: "cpsat.request-dispatched",
      requestId: randomUUID(),
      origin: { kind: "probe" },
      sameInputRetry: false,
    },
  };
}

async function request(input, expected = 202, target = worker) {
  const start = performance.now();
  const counted = expected === 202 || expected === 429;
  if (counted) report.driverObservations.push(input);
  const response = await target.fetch("https://solver.invalid/plan", {
    method: "POST",
    body: typeof input === "string" ? input : JSON.stringify(input),
  });
  const text = await response.text();
  assert.equal(response.status, expected, text);
  if (counted)
    report.driverObservations.push({
      ...input,
      eventId: randomUUID(),
      at: Date.now(),
      parentEventId: input.eventId,
      fact: {
        type: "cpsat.dispatch-result",
        requestId: input.fact.requestId,
        outcome: response.status === 202 ? "accepted" : "busy",
      },
    });
  report.requests.push({
    requestId: input?.fact?.requestId ?? null,
    status: response.status,
    clientElapsedMs: performance.now() - start,
  });
  return response;
}

async function until(predicate) {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`Local wait failed: ${runtimeText.join("").slice(-3000)}`);
    // Polling is test orchestration, never added to solver execution.
    // oxlint-disable-next-line no-await-in-loop
    await delay(10);
  }
}

const runtime = new Miniflare({
  port: 0,
  cf: false,
  log: new Log(LogLevel.ERROR),
  handleRuntimeStdio(stdout, stderr) {
    for (const stream of [stdout, stderr]) {
      let pending = "";
      stream.on("data", (chunk) => {
        const text = chunk.toString();
        runtimeText.push(text);
        pending += text;
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines) {
          try {
            const start = line.indexOf('{"');
            if (start < 0) continue;
            const parsed = JSON.parse(line.slice(start));
            if (parsed.schemaVersion === 1 && parsed.fact) rows.push(parsed);
          } catch {
            /* Non-observation workerd diagnostics stay in runtimeText. */
          }
        }
      });
    }
  },
  workers: [
    ...(await Promise.all(
      [
        ["solver", true, {}],
        ["disabled", false, {}],
        ["expired", true, { notBefore: Date.now() - 10_000, expiresAt: Date.now() - 1000 }],
      ].map(async ([name, enabled, overrides]) => ({
        name,
        compatibilityDate: "2026-06-26", // Installed workerd's supported date.
        compatibilityFlags: ["no_nodejs_compat", "no_nodejs_compat_v2"],
        modulesRoot: scratch,
        modules: [
          {
            type: "ESModule",
            path: resolve(scratch, `${name}.js`),
            contents: await bundle(enabled, overrides),
          },
          { type: "CompiledWasm", path: resolve(scratch, "runtime.wasm"), contents: wasm },
        ],
        durableObjects: {
          STORE_TIMER_DO: { className: "StoreTimerDO", scriptName: "callback", useSQLite: true },
        },
      })),
    )),
    {
      name: "callback",
      compatibilityDate: "2026-06-26",
      modules: true,
      script: `import { DurableObject } from "cloudflare:workers";
        export class StoreTimerDO extends DurableObject {
          async deliverPlan(plan) {
            const response = await this.env.CALLBACK.fetch("https://callback.invalid/", {
              method: "POST", body: JSON.stringify({ id: this.ctx.id.name, plan })
            });
            await response.text();
            if (!response.ok) throw new Error("Injected callback failure");
          }
        }
        export default { fetch() { return new Response(null, {status: 404}); } };`,
      durableObjects: { STORE_TIMER_DO: { className: "StoreTimerDO", useSQLite: true } },
      serviceBindings: {
        CALLBACK: async (request) => {
          report.callbacks.push(await request.json());
          if (holdCallback) await holdCallback;
          return new Response(null, { status: failCallback ? 503 : 204 });
        },
      },
    },
  ],
});

try {
  await runtime.ready;
  worker = await runtime.getWorker("solver");
  await request(row(), 503, await runtime.getWorker("disabled"));
  await request(row(), 503, await runtime.getWorker("expired"));
  for (const input of [
    "{",
    "x".repeat(16_385),
    { ...row(), storeRef: "0".repeat(64) },
    { ...row(), extraModel: "not permitted" },
    { ...row(), mode: "live" },
    { ...row(), versions: { ...row().versions, budget: "1" } },
  ]) {
    // Sequential inputs make the zero-solve negative assertion unambiguous.
    // oxlint-disable-next-line no-await-in-loop
    await request(input, 400);
  }
  assert.equal(report.callbacks.length, 0);
  assert.equal(rows.length, 0);
  report.checks.invalidAndDisabledNeverSolve = true;

  // Exercise busy while callback is pending. This deliberately injected wait is
  // only a concurrency test and is excluded from all performance conclusions.
  holdCallback = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  const first = row();
  await request(first);
  await until(() => report.callbacks.length === 1);
  await request(row(), 429);
  assert.equal(report.callbacks[0].plan.result.objective, 5);
  assert.equal(rows.filter((r) => r.fact.type === "cpsat.callback-returned").length, 0);
  release();
  holdCallback = undefined;
  await until(() => rows.some((r) => r.fact.type === "cpsat.callback-returned"));
  report.checks.busyUntilCallbackReturns = true;

  for (const fixture of [
    ...Array(4).fill(fixtures.fixtures[1]),
    ...Array(4).fill(fixtures.fixtures[0]),
  ]) {
    const input = row(fixture);
    // Reuse the same isolate across separate fetches; never a repeat loop inside a solve.
    // oxlint-disable-next-line no-await-in-loop
    await request(input);
    // oxlint-disable-next-line no-await-in-loop
    await until(() =>
      rows.some(
        (r) =>
          r.fact.type === "cpsat.measurement" &&
          r.fact.metric === "wait-until-wall-ms" &&
          r.fact.requestId === input.fact.requestId,
      ),
    );
  }
  assert.equal(report.callbacks.length, 9);
  for (const { id, plan } of report.callbacks) {
    assert.equal(id, manifest.stores[0].id);
    assert.equal(Object.hasOwn(plan, "slices"), false);
    assert.equal(plan.protocol, "cpsat/v1");
    assert.equal(plan.runtime.initializationCount, 1);
    assert.ok(plan.runtime.clockReads > 0);
    assert.ok(plan.runtime.memoryBytes <= 96 * 1024 * 1024);
    assert.equal(plan.result.solverWallTimeMs, 0);
    const fixture = fixtures.fixtures.find((f) => f.sha256 === plan.observation.versions.model);
    const expected = fixture.native;
    const keys = [
      "status",
      "objective",
      "bestBound",
      "solution",
      "branches",
      "conflicts",
      "deterministicTime",
    ];
    const differences = keys.filter(
      (key) => JSON.stringify(plan.result[key]) !== JSON.stringify(expected[key]),
    );
    report.nativeComparisons.push({
      requestId: plan.requestId,
      fixture: fixture.name,
      differences,
    });
    if (fixture.name === "small") {
      for (const key of ["status", "objective", "bestBound", "solution"])
        assert.deepEqual(plan.result[key], expected[key]);
    } else {
      // The fork/native builds may take different search paths. Exact incumbent,
      // bound, branches or consumed-work equality is recorded, not required.
      assert.ok(["UNKNOWN", "FEASIBLE"].includes(plan.result.status));
      assert.ok(plan.result.deterministicTime >= fixture.budget);
      assert.ok(plan.result.deterministicTime <= fixture.budget + 0.02);
    }
  }
  assert.equal(report.callbacks[0].plan.runtime.initializedNow, true);
  assert.ok(report.callbacks.slice(1).every((c) => !c.plan.runtime.initializedNow));
  report.checks.smallOptimumMatchesNative = true;
  report.checks.hardStopsOnWorkBudget = true;
  report.checks.singleInstanceReuseAndMemoryBound = true;

  failCallback = true;
  const failure = row();
  await request(failure);
  await until(() =>
    rows.some(
      (r) =>
        r.fact.type === "cpsat.callback-returned" &&
        r.fact.requestId === failure.fact.requestId &&
        r.fact.outcome === "failed",
    ),
  );
  failCallback = false;
  const recovery = row();
  await request(recovery);
  await until(() =>
    rows.some(
      (r) =>
        r.fact.type === "cpsat.measurement" &&
        r.fact.metric === "wait-until-wall-ms" &&
        r.fact.requestId === recovery.fact.requestId,
    ),
  );
  assert.equal(report.callbacks.at(-1).plan.runtime.initializationCount, 1);
  assert.equal(
    rows.filter(
      (r) => r.fact.type === "cpsat.solve-finished" && r.fact.requestId === failure.fact.requestId,
    ).length,
    1,
  );
  report.checks.callbackFailureIsSeparateAndReleasesBusy = true;
  assert.equal(rows.filter((r) => r.fact.type === "cpsat.solver-accepted").length, 11);
  assert.equal(rows.filter((r) => r.fact.type === "cpsat.solve-started").length, 11);
  assert.equal(rows.filter((r) => r.fact.type === "cpsat.solve-finished").length, 11);
  assert.equal(rows.filter((r) => r.fact.type === "cpsat.callback-returned").length, 11);
  assert.equal(rows.filter((r) => r.fact.type === "cpsat.request-generated").length, 0);
  report.checks.distinctNonVacuousCounts = true;
  report.observations = rows;
  // Exercise the existing pure collector on real instrumented rows, not just
  // hand-counted JSON. Node executes only the collector, not the Wasm module.
  const collector = await build({
    entryPoints: [resolve(directory, "../../../src/observe/cpsat.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "es2022",
  });
  const { summarizeCpsatObservations } = await import(
    `data:text/javascript;base64,${Buffer.from(collector.outputFiles[0].text).toString("base64")}`
  );
  const to = Date.now() + 1;
  report.countSummary = summarizeCpsatObservations([...report.driverObservations, ...rows], {
    from: trial.notBefore,
    to,
    capturedFrom: trial.notBefore,
    capturedTo: to,
    retainedFrom: trial.notBefore,
    samplingRate: 1,
    exportComplete: true,
    scopes: [{ storeRef: manifest.stores[0].ref, backend: "cpsat", mode: "probe" }],
    gaps: [],
    frequencyLimits: null,
  });
  assert.deepEqual(report.countSummary.issues, []);
  assert.equal(report.countSummary.usableForRates, true);
  report.checks.causalLinksAcceptedByCollector = true;
  report.limitations = [
    "Not cloud transport gate 2.5 evidence; app, authentication and engine effect path not connected yet.",
    "RPC target is a local test double, not the live StoreTimerDO.",
    "Local callback hold is a test injection, not evidence of concurrent kitchen operations during solve.",
    "No platform CPU, waitUntil duration, whole-isolate memory or request/solve separation claim.",
    "Local workerd date 2026-06-26 differs from planned cloud date 2026-09-09.",
    "No Wasm trap or initialization-failure injection in this run.",
  ];
  await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(
    JSON.stringify(
      {
        report: resolve(output),
        checks: report.checks,
        callbacks: report.callbacks.length,
        observations: rows.length,
      },
      null,
      2,
    ),
  );
} finally {
  release?.();
  await runtime.dispose();
}
