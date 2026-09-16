#!/usr/bin/env node
// Where does the caller's `await solver.fetch(...)` actually resolve?
//
//   node experiments/cpsat-workers/transport/check-accept-boundary.mjs OUT.json
//
// In cloud the app's own two observation rows sat 1,292-3,270 ms apart, which
// brackets `await solver.fetch(request)` AND `await response.body?.cancel()`
// together. Those two need separating: if the fetch resolves at the response
// headers and only the body handling waits, the fix is one line and the
// execution method stands. If the fetch itself waits for the solve, it is not.
//
// So this runs the real solver — real WASM, real fixed problem, no sleep — and
// stamps three points in the caller: before the fetch, after it resolves, and
// after the body is dealt with. Three callers differ only in what they do with
// the body. A fourth measurement drives an independent request during the
// solve, because a caller that waits is a different failure from a runtime that
// cannot serve anything else meanwhile.
//
// Local workerd is not cloud. A difference here is evidence about the boundary,
// not proof about production; the cloud recheck stays required.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { build } = wranglerRequire("esbuild");
const { Miniflare, Log, LogLevel } = wranglerRequire("miniflare");

const output = process.argv[2];
if (!output || process.argv.length !== 3)
  throw new Error("Usage: node check-accept-boundary.mjs NEW_REPORT.json");

const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
const fixtures = JSON.parse(await readFile(resolve(directory, "fixtures.json"), "utf8"));
const wasm = await readFile(resolve(directory, "../vendor/cpsat_workers_poc_runtime.wasm"));
const glue = await readFile(resolve(directory, "../vendor/cpsat_workers_poc_runtime.js"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
assert.equal(hash(wasm), manifest.wasm);
assert.equal(hash(glue), manifest.glue);
// The hard problem is the one worth measuring: a solve short enough to hide
// inside network noise proves nothing about where the caller resumes.
const fixture = fixtures.fixtures.reduce((a, b) => (b.budget > a.budget ? b : a));
const scratch = await mkdtemp(resolve(tmpdir(), "cpsat-accept-boundary-"));
const trial = {
  ...manifest,
  enabled: true,
  notBefore: Date.now() - 1000,
  expiresAt: Date.now() + 300_000,
};

const rows = [];
async function bundleSolver() {
  const result = await build({
    absWorkingDir: directory,
    entryPoints: ["solver.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    plugins: [
      {
        name: "local-fixed-manifest",
        setup(bundler) {
          bundler.onResolve({ filter: /\.wasm$/ }, () => ({
            path: "./runtime.wasm",
            external: true,
          }));
          bundler.onLoad({ filter: /\/transport\/manifest\.json$/ }, () => ({
            contents: JSON.stringify(trial),
            loader: "json",
          }));
        },
      },
    ],
  });
  return result.outputFiles[0].text;
}

// Three callers, differing only in what they do with the response body. The
// stamps are read from Date.now(), which advances at I/O — the same clock the
// deployed app's two rows were read from.
const caller = (body) => `export default {
  async fetch(request, env) {
    const t1 = Date.now();
    const response = await env.SOLVER.fetch(new Request("https://solver.invalid/plan", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: await request.text(),
    }));
    const t2 = Date.now();
    const status = response.status;
    ${body}
    const t3 = Date.now();
    return Response.json({ t1, t2, t3, status, fetchMs: t2 - t1, bodyMs: t3 - t2 });
  },
};`;

const runtime = new Miniflare({
  port: 0,
  cf: false,
  log: new Log(LogLevel.ERROR),
  handleRuntimeStdio(stdout, stderr) {
    for (const stream of [stdout, stderr]) {
      let pending = "";
      stream.on("data", (chunk) => {
        pending += chunk.toString();
        const lines = pending.split("\n");
        pending = lines.pop();
        for (const line of lines) {
          const start = line.indexOf('{"');
          if (start < 0) continue;
          try {
            const parsed = JSON.parse(line.slice(start));
            if (parsed.schemaVersion === 1 && parsed.fact)
              rows.push({ ...parsed, seenAt: Date.now() });
          } catch {
            /* workerd diagnostics are not observations. */
          }
        }
      });
    }
  },
  workers: [
    {
      name: "solver",
      compatibilityDate: "2026-06-26",
      compatibilityFlags: ["no_nodejs_compat", "no_nodejs_compat_v2"],
      modulesRoot: scratch,
      modules: [
        { type: "ESModule", path: resolve(scratch, "solver.js"), contents: await bundleSolver() },
        { type: "CompiledWasm", path: resolve(scratch, "runtime.wasm"), contents: wasm },
      ],
      durableObjects: {
        STORE_TIMER_DO: { className: "StoreTimerDO", scriptName: "callback", useSQLite: true },
      },
    },
    ...[
      ["cancel", "await response.body?.cancel();"],
      ["text", "await response.text();"],
      ["untouched", "/* the body is left alone */"],
    ].map(([name, body]) => ({
      name: `caller-${name}`,
      compatibilityDate: "2026-06-26",
      modules: true,
      script: caller(body),
      serviceBindings: { SOLVER: "solver" },
    })),
    // Controls. `child-none` isolates the round trip itself; the other two hold
    // the same duration in waitUntil by opposite means.
    ...[
      ["none", ""],
      ["async", "ctx.waitUntil(new Promise((done) => setTimeout(done, 1500)));"],
      // A synchronous burn, not a sleep: this is the shape a single-threaded
      // WASM solve has, and the only one that can occupy the shared thread.
      [
        "sync",
        "ctx.waitUntil((async () => { const until = Date.now() + 1500; while (Date.now() < until) {} })());",
      ],
    ].map(([name, work]) => ({
      name: `child-${name}`,
      compatibilityDate: "2026-06-26",
      modules: true,
      script: `export default { fetch(request, env, ctx) { ${work} return Response.json({ accepted: true }, { status: 202 }); } };`,
    })),
    ...[
      ["none", "child-none"],
      ["async", "child-async"],
      ["sync", "child-sync"],
    ].map(([name, target]) => ({
      name: `control-${name}`,
      compatibilityDate: "2026-06-26",
      modules: true,
      script: caller("await response.body?.cancel();"),
      serviceBindings: { SOLVER: target },
    })),
    {
      name: "callback",
      compatibilityDate: "2026-06-26",
      modules: true,
      script: `import { DurableObject } from "cloudflare:workers";
        export class StoreTimerDO extends DurableObject {
          async deliverPlan(plan) { return { delivered: true }; }
        }
        export default { fetch() { return new Response(null, { status: 404 }); } };`,
      durableObjects: { STORE_TIMER_DO: { className: "StoreTimerDO", useSQLite: true } },
    },
  ],
});

const row = () => ({
  schemaVersion: 1,
  eventId: randomUUID(),
  at: Date.now(),
  storeRef: manifest.stores[0].ref,
  backend: "cpsat",
  mode: "probe",
  instanceId: "boundary-driver",
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
});

const report = {
  measuredAt: new Date().toISOString(),
  environment: "local-workerd",
  cloudEvidence: false,
  problem: { sha256: fixture.sha256, budget: fixture.budget, byteLength: fixture.byteLength },
  wasmSha256: hash(wasm),
  glueSha256: hash(glue),
  toolchain: {
    node: process.version,
    wrangler: wranglerRequire("./package.json").version,
    miniflare: wranglerRequire("miniflare/package.json").version,
  },
  variants: [],
  controls: [],
};
try {
  await runtime.ready;
  for (const name of ["cancel", "text", "untouched"]) {
    const worker = await runtime.getWorker(`caller-${name}`);
    const input = row();
    const before = rows.length;
    const driverStart = Date.now();
    // oxlint-disable-next-line no-await-in-loop
    const response = await worker.fetch("https://caller.invalid/", {
      method: "POST",
      body: JSON.stringify(input),
    });
    const driverMs = Date.now() - driverStart;
    // oxlint-disable-next-line no-await-in-loop
    const stamps = await response.json();
    // The solve runs after the 202. Wait for its own rows rather than guessing.
    // oxlint-disable-next-line no-await-in-loop
    const finished = await (async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const mine = rows.slice(before).filter((r) => r.fact.requestId === input.fact.requestId);
        if (mine.some((r) => r.fact.type === "cpsat.callback-returned")) return mine;
        // oxlint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 50));
      }
      return rows.slice(before).filter((r) => r.fact.requestId === input.fact.requestId);
    })();
    const started = finished.find((r) => r.fact.type === "cpsat.solve-started");
    const callback = finished.find((r) => r.fact.type === "cpsat.callback-returned");
    report.variants.push({
      bodyHandling: name,
      status: stamps.status,
      // Point 1: the caller's fetch resolved.
      fetchResolvedAfterMs: stamps.fetchMs,
      // Point 2: the body was dealt with.
      bodyHandledAfterMs: stamps.bodyMs,
      // Point 3: the driver holding the caller got its answer.
      driverSawAnswerAfterMs: driverMs,
      // Point 4: the solve's own end, from the solver's rows.
      solveStartedSeen: Boolean(started),
      callbackSeen: Boolean(callback),
      callbackOutcome: callback?.fact?.outcome ?? null,
      solveEndSeenAfterDriverMs: callback ? callback.seenAt - driverStart : null,
    });
  }
  for (const name of ["none", "async", "sync"]) {
    const worker = await runtime.getWorker(`control-${name}`);
    const driverStart = Date.now();
    // oxlint-disable-next-line no-await-in-loop
    const response = await worker.fetch("https://caller.invalid/", {
      method: "POST",
      body: JSON.stringify(row()),
    });
    const driverMs = Date.now() - driverStart;
    // oxlint-disable-next-line no-await-in-loop
    const stamps = await response.json();
    report.controls.push({
      waitUntilWork: name,
      status: stamps.status,
      fetchResolvedAfterMs: stamps.fetchMs,
      bodyHandledAfterMs: stamps.bodyMs,
      driverSawAnswerAfterMs: driverMs,
    });
  }
} finally {
  await runtime.dispose();
}
const serialized = JSON.stringify(report, null, 2);
await writeFile(resolve(output), `${serialized}\n`, { flag: "wx" });
console.log(serialized);
