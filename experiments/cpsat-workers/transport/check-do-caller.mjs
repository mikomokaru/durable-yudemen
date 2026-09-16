#!/usr/bin/env node
// When the caller is a Durable Object, is that object occupied for the solve?
//
//   node experiments/cpsat-workers/transport/check-do-caller.mjs OUT.json
//
// The cloud runs so far all had a plain entrypoint issue the request, and the
// store's own operations stayed at 39-52 ms throughout. That says nothing about
// the arrangement the application actually uses, where the store DO issues it
// from its Persist Effect. `check-accept-boundary.mjs` showed the caller is
// held whenever the child's post-response work is synchronous; whether a held
// DO can still serve its own traffic is a separate question, and it is the one
// that decides whether the execution method has to change.
//
// So: a DO calls the real solver and, while that call is outstanding, an
// independent request is sent to the SAME object. Three children are used —
// the real solver, a synchronous burn, an asynchronous wait — because the
// second is the shape of a solve and the third is the shape of ordinary I/O.
//
// Local workerd is not cloud. This identifies the mechanism; the cloud recheck
// stays required before 2.5 is judged.
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
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { build } = wranglerRequire("esbuild");
const { Miniflare, Log, LogLevel } = wranglerRequire("miniflare");

const output = process.argv[2];
if (!output || process.argv.length !== 3)
  throw new Error("Usage: node check-do-caller.mjs NEW_REPORT.json");

const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
const fixtures = JSON.parse(await readFile(resolve(directory, "fixtures.json"), "utf8"));
const wasm = await readFile(resolve(directory, "../vendor/cpsat_workers_poc_runtime.wasm"));
const glue = await readFile(resolve(directory, "../vendor/cpsat_workers_poc_runtime.js"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
assert.equal(hash(wasm), manifest.wasm);
assert.equal(hash(glue), manifest.glue);
const fixture = fixtures.fixtures.reduce((a, b) => (b.budget > a.budget ? b : a));
const scratch = await mkdtemp(resolve(tmpdir(), "cpsat-do-caller-"));
const trial = {
  ...manifest,
  enabled: true,
  notBefore: Date.now() - 1000,
  expiresAt: Date.now() + 300_000,
};

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

// The DO under test. `/plan` is the Effect-shaped path: it issues the request
// and waits, exactly as the application's Persist Effect would. `/ping` is any
// other traffic that object has to keep serving meanwhile — an order arriving,
// a Timer being started. Both are on the same object, deliberately.
const callerDo = `import { DurableObject } from "cloudflare:workers";
  export class CallerDO extends DurableObject {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/ping") return Response.json({ servedAt: Date.now() });
      // Fire-and-forget: the send is started and never awaited. This is the
      // shape "let the solver push the result back" reduces to on the outbound
      // side, and the question is whether dropping the await frees the object.
      if (url.pathname === "/plan-noawait") {
        const t0 = Date.now();
        const body = await request.text();
        void this.env.SOLVER.fetch(new Request("https://solver.invalid/plan", {
          method: "POST", headers: { "Content-Type": "application/json" }, body,
        })).catch(() => {});
        return Response.json({ t1: t0, t2: Date.now(), t3: Date.now(), status: 0,
          fetchMs: Date.now() - t0, bodyMs: 0 });
      }
      const t1 = Date.now();
      const response = await this.env.SOLVER.fetch(new Request("https://solver.invalid/plan", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: await request.text(),
      }));
      const t2 = Date.now();
      const status = response.status;
      await response.body?.cancel();
      const t3 = Date.now();
      return Response.json({ t1, t2, t3, status, fetchMs: t2 - t1, bodyMs: t3 - t2 });
    }
  }
  export default {
    fetch(request, env) {
      const id = env.CALLER_DO.idFromName("under-test");
      return env.CALLER_DO.get(id).fetch(request);
    },
  };`;

const rows = [];
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
      // A synchronous burn is the shape of the solve; an asynchronous wait is
      // the shape of ordinary I/O. Same duration, opposite occupancy.
      [
        "sync",
        "ctx.waitUntil((async () => { const until = Date.now() + 1500; while (Date.now() < until) {} })());",
      ],
      ["async", "ctx.waitUntil(new Promise((done) => setTimeout(done, 1500)));"],
    ].map(([name, work]) => ({
      name: `child-${name}`,
      compatibilityDate: "2026-06-26",
      modules: true,
      script: `export default { fetch(request, env, ctx) { ${work} return Response.json({ accepted: true }, { status: 202 }); } };`,
    })),
    ...[
      ["solver", "solver"],
      ["sync", "child-sync"],
      ["async", "child-async"],
    ].map(([name, target]) => ({
      name: `do-${name}`,
      compatibilityDate: "2026-06-26",
      modules: true,
      script: callerDo,
      durableObjects: { CALLER_DO: { className: "CallerDO", useSQLite: true } },
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
  instanceId: "do-caller-driver",
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
  caller: "durable object",
  problem: { sha256: fixture.sha256, budget: fixture.budget, byteLength: fixture.byteLength },
  wasmSha256: hash(wasm),
  glueSha256: hash(glue),
  toolchain: {
    node: process.version,
    wrangler: wranglerRequire("./package.json").version,
    miniflare: wranglerRequire("miniflare/package.json").version,
  },
  cases: [],
};
try {
  await runtime.ready;
  for (const [name, path] of [
    ["solver", "/plan"],
    // Same child, same solve. Only the caller's handling of the send differs.
    ["solver-noawait", "/plan-noawait"],
    ["sync", "/plan"],
    // The residual interference matters only if it is bounded. A 1,500 ms
    // synchronous child, fired and not awaited, says whether what is left of
    // the child's work still stops the object.
    ["sync-noawait", "/plan-noawait"],
    ["async", "/plan"],
  ]) {
    const worker = await runtime.getWorker(`do-${name.replace("-noawait", "")}`);
    const ping = async () => {
      const started = Date.now();
      const response = await worker.fetch("https://caller.invalid/ping");
      await response.json();
      return Date.now() - started;
    };
    // Baseline first, so a slow object is not mistaken for an occupied one.
    // oxlint-disable-next-line no-await-in-loop
    const idlePingMs = [await ping(), await ping(), await ping()];
    const driverStart = Date.now();
    // Deliberately not awaited: the call must be outstanding while the ping goes.
    const before = rows.length;
    const call = worker
      .fetch(`https://caller.invalid${path}`, { method: "POST", body: JSON.stringify(row()) })
      .then(async (response) => ({ stamps: await response.json(), at: Date.now() - driverStart }));
    // oxlint-disable-next-line no-await-in-loop
    await delay(120);
    // oxlint-disable-next-line no-await-in-loop
    const busyPingMs = await ping();
    const busyPingFinishedAt = Date.now() - driverStart;
    // oxlint-disable-next-line no-await-in-loop
    const { stamps, at } = await call;
    // Did the send survive being un-awaited? Wait for the solve's own rows.
    let solved = false;
    for (let i = 0; i < 120 && !solved; i += 1) {
      solved = rows.slice(before).some((r) => r.fact.type === "cpsat.callback-returned");
      if (!solved) await delay(50);
    }
    report.cases.push({
      child: name,
      awaited: path === "/plan",
      solveReachedCallback: solved,
      status: stamps.status,
      // Is the DO's own call held?
      doFetchResolvedAfterMs: stamps.fetchMs,
      doBodyHandledAfterMs: stamps.bodyMs,
      doCallReturnedToDriverAfterMs: at,
      // Can the same object still serve anything while it is held?
      idlePingMs,
      busyPingMs,
      busyPingFinishedBeforeCall: busyPingFinishedAt < at,
    });
  }
} finally {
  await runtime.dispose();
}
const serialized = JSON.stringify(report, null, 2);
await writeFile(resolve(output), `${serialized}\n`, { flag: "wx" });
console.log(serialized);
