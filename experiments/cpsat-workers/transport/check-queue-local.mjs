#!/usr/bin/env node
// Queue 方式の測定（ローカル）。
//
//   node experiments/cpsat-workers/transport/check-queue-local.mjs OUT.json
//
// **ローカルで測れることと測れないことを先に分ける。**
//
// 測れる：要求元の handler が求解の完了を待たなくなったか。これはスレッドの配置に
// 依存しない——`send()` が返れば handler が返る、という構造の話だからである。
// 比較対象は同じ harness で取った「求解まで待つ」旧経路の値である。
//
// **測れない：求解中に要求元が他の通信を捌けるか。** Miniflare は全 Worker を 1 つの
// workerd プロセスで動かすので、Queue にしてもスレッドは共有されたままである。ここで
// 遅い値が出ても design の否定にならず、速い値が出ても保証にならない。その判定は
// cloud の測定（連鎖の外の DO が自店舗の求解中も 39〜52ms で応答した）が担う。
// 参考として記録はするが、`evidence: false` を付けて結論に使わせない。
//
// あわせて ack / retry / DLQ の経路を、`attempts` と結末を並べて記録する。
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
  throw new Error("Usage: node check-queue-local.mjs NEW_REPORT.json");

const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
const fixtures = JSON.parse(await readFile(resolve(directory, "fixtures.json"), "utf8"));
const wasm = await readFile(resolve(directory, "../vendor/cpsat_workers_poc_runtime.wasm"));
const glue = await readFile(resolve(directory, "../vendor/cpsat_workers_poc_runtime.js"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(hash(wasm), manifest.wasm);
assert.equal(hash(glue), manifest.glue);
assert.equal(manifest.enabled, false, "The checked-in manifest must remain inert");

const fixture = fixtures.fixtures.reduce((a, b) => (b.budget > a.budget ? b : a));
const store = manifest.stores[0];
const scratch = await mkdtemp(resolve(tmpdir(), "cpsat-queue-local-"));
const trial = {
  ...manifest,
  enabled: true,
  notBefore: Date.now() - 1000,
  expiresAt: Date.now() + 600_000,
};

async function bundle(entry) {
  const result = await build({
    absWorkingDir: directory,
    entryPoints: [entry],
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

// 要求元。`/plan` は Queue へ投入して返すだけ、`/plan-await` は旧経路と同じく
// 求解 Worker を直接呼んで待つ。同じ harness で両方を測らないと、速くなったのが
// 経路のおかげか環境のおかげか分からない。
const producer = `import { DurableObject } from "cloudflare:workers";
  export class ProducerDO extends DurableObject {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/ping") return Response.json({ servedAt: Date.now() });
      const body = await request.text();
      const started = Date.now();
      if (url.pathname === "/plan-await") {
        const response = await this.env.SOLVER.fetch(new Request("https://solver.invalid/plan", {
          method: "POST", headers: { "Content-Type": "application/json" }, body,
        }));
        await response.body?.cancel();
        return Response.json({ handlerMs: Date.now() - started, status: response.status });
      }
      await this.env.CPSAT_PLAN_QUEUE.send({ row: JSON.parse(body) });
      return Response.json({ handlerMs: Date.now() - started, status: 202 });
    }
  }
  export default {
    fetch(request, env) {
      return env.PRODUCER_DO.get(env.PRODUCER_DO.idFromName("under-test")).fetch(request);
    },
  };`;

const rows = [];
const receipts = [];
const dlq = [];
let holdCallback;
let releaseCallback;

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
            if (parsed.schemaVersion === 1 && parsed.fact) rows.push(parsed);
            else if (typeof parsed.transport === "string") receipts.push(parsed);
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
      queueConsumers: {
        "cpsat-plan-requests": {
          maxBatchSize: 1,
          maxBatchTimeout: 0,
          maxRetries: 3,
          maxConcurrency: 1,
          deadLetterQueue: "cpsat-plan-requests-dlq",
        },
      },
      modulesRoot: scratch,
      modules: [
        {
          type: "ESModule",
          path: resolve(scratch, "solver.js"),
          contents: await bundle("solver.ts"),
        },
        { type: "CompiledWasm", path: resolve(scratch, "runtime.wasm"), contents: wasm },
      ],
      durableObjects: {
        STORE_TIMER_DO: { className: "StoreTimerDO", scriptName: "callback", useSQLite: true },
      },
    },
    {
      name: "producer",
      compatibilityDate: "2026-06-26",
      modules: true,
      script: producer,
      durableObjects: { PRODUCER_DO: { className: "ProducerDO", useSQLite: true } },
      queueProducers: { CPSAT_PLAN_QUEUE: "cpsat-plan-requests" },
      serviceBindings: { SOLVER: "solver" },
    },
    {
      // DLQ の到達を数えるだけの consumer。ここへ落ちた要求は解かれていない。
      name: "dlq",
      compatibilityDate: "2026-06-26",
      modules: true,
      script: `export default {
        async queue(batch) {
          for (const message of batch.messages) {
            console.log(JSON.stringify({ transport: "dlq", messageId: message.id, attempts: message.attempts }));
            message.ack();
          }
        },
      };`,
      queueConsumers: { "cpsat-plan-requests-dlq": { maxBatchSize: 1, maxBatchTimeout: 0 } },
    },
    {
      name: "callback",
      compatibilityDate: "2026-06-26",
      modules: true,
      script: `import { DurableObject } from "cloudflare:workers";
        export class StoreTimerDO extends DurableObject {
          async deliverPlan(plan) {
            const response = await this.env.CALLBACK.fetch("https://callback.invalid/", {
              method: "POST", body: JSON.stringify({ id: this.ctx.id.name }),
            });
            await response.text();
            return { delivered: true };
          }
        }
        export default { fetch() { return new Response(null, { status: 404 }); } };`,
      durableObjects: { STORE_TIMER_DO: { className: "StoreTimerDO", useSQLite: true } },
      serviceBindings: {
        CALLBACK: async () => {
          if (holdCallback) await holdCallback;
          return new Response(null, { status: 204 });
        },
      },
    },
  ],
});

const row = () => ({
  schemaVersion: 1,
  eventId: randomUUID(),
  at: Date.now() - 1000,
  storeRef: store.ref,
  backend: "cpsat",
  mode: "probe",
  instanceId: randomUUID(),
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

const until = async (predicate, limitMs = 20_000) => {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    // oxlint-disable-next-line no-await-in-loop
    await delay(50);
  }
  return false;
};

const report = {
  measuredAt: new Date().toISOString(),
  environment: "local-workerd",
  cloudEvidence: false,
  problem: { sha256: fixture.sha256, budget: fixture.budget },
  wasmSha256: hash(wasm),
  toolchain: {
    node: process.version,
    wrangler: wranglerRequire("./package.json").version,
    miniflare: wranglerRequire("miniflare/package.json").version,
  },
  handlerReturn: {},
  delivery: {},
  deadLetter: {},
  notMeasurableHere: [],
};
try {
  await runtime.ready;
  const worker = await runtime.getWorker("producer");
  const call = async (path, input) => {
    const response = await worker.fetch(`https://producer.invalid${path}`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    return response.json();
  };

  // 1. 要求元の handler が求解を待つか。旧経路と新経路を同じ harness で交互に測る。
  //    1 回では外れ値と区別できないので繰り返す（tasks 2.3 の合格条件の形に寄せる）。
  const ROUNDS = 10;
  const viaServiceBinding = [];
  const viaQueue = [];
  const queuedIds = [];
  const settled = () => rows.filter((r) => r.fact.type === "cpsat.callback-returned").length;
  for (let round = 0; round < ROUNDS; round += 1) {
    const beforeAwait = settled();
    // oxlint-disable-next-line no-await-in-loop
    viaServiceBinding.push((await call("/plan-await", row())).handlerMs);
    // oxlint-disable-next-line no-await-in-loop
    await until(() => settled() > beforeAwait);
    const input = row();
    queuedIds.push(input.fact.requestId);
    const beforeQueue = settled();
    // oxlint-disable-next-line no-await-in-loop
    viaQueue.push((await call("/plan", input)).handlerMs);
    // oxlint-disable-next-line no-await-in-loop
    await until(() => settled() > beforeQueue);
  }
  const spread = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      n: sorted.length,
      min: sorted[0],
      p50: sorted[Math.floor(sorted.length / 2)],
      max: sorted[sorted.length - 1],
      all: sorted,
    };
  };
  report.handlerReturn = {
    viaServiceBinding: spread(viaServiceBinding),
    viaQueue: spread(viaQueue),
    note: [
      "同一 harness・同一問題で交互に測った。差は要求元が求解を待つかどうかだけに由来する。",
      "絶対値は代表値ではない。ローカルの Queue は実配送ではなく、cloud の send() の往復を含まない。",
    ],
  };

  // 2. 2.4 の測定行。件数ではなく要求ごとの値を残す——「時計が進まない」問題が
  //    invocation の境界で解けたかは、この行を見ないと言えない。
  const metricOf = (requestId, metric) => {
    const found = rows.find(
      (r) =>
        r.fact.type === "cpsat.measurement" &&
        r.fact.requestId === requestId &&
        r.fact.metric === metric,
    );
    return found ? found.fact.reading : null;
  };
  report.measurementRows = queuedIds.map((requestId) => {
    const started = rows.find(
      (r) => r.fact.type === "cpsat.solve-started" && r.fact.requestId === requestId,
    );
    const finished = rows.find(
      (r) => r.fact.type === "cpsat.solve-finished" && r.fact.requestId === requestId,
    );
    return {
      requestId,
      status: finished?.fact.status ?? null,
      solveCallbackWallMs: metricOf(requestId, "solve-callback-wall-ms"),
      consumedDeterministic: metricOf(requestId, "consumed-deterministic"),
      wasmBytes: metricOf(requestId, "wasm-bytes"),
      waitUntilWallMs: metricOf(requestId, "wait-until-wall-ms"),
      // 同期求解の間 Workers の時計は進まない。cloud の fetch 経路では
      // solve-started と solve-finished の `at` が同値になり区間を特定できなかった。
      // Queue 経路で同じことが起きているかを、生の差として残す。
      solveStartedToFinishedMs: started && finished ? finished.at - started.at : null,
    };
  });
  // 時計の比較。cloud の fetch 経路では solve-started と solve-finished の `at` が
  // 同値になり、求解区間を特定できなかった。Queue 経路で幅が出たとしても、それが
  // 「invocation の境界で解けた」のか「ローカル workerd が時計を凍らせないだけ」なのかは、
  // **同じ harness の fetch 経路と比べないと言えない**。両方を並べる。
  const spans = { queue: [], fetch: [] };
  for (const finished of rows.filter((r) => r.fact.type === "cpsat.solve-finished")) {
    const started = rows.find(
      (r) => r.fact.type === "cpsat.solve-started" && r.fact.requestId === finished.fact.requestId,
    );
    if (!started) continue;
    const bucket = queuedIds.includes(finished.fact.requestId) ? spans.queue : spans.fetch;
    bucket.push(finished.at - started.at);
  }
  report.clockSpans = {
    queue: spread(spans.queue),
    fetch: spread(spans.fetch),
    note: "両方に幅が出るなら、幅はローカル workerd の時計の性質であって Queue 経路の成果ではない。cloud の再確認が要る。",
  };
  report.delivery = {
    callbackReturnedRows: settled(),
    solveFinishedRows: rows.filter((r) => r.fact.type === "cpsat.solve-finished").length,
    allQueuedDelivered: queuedIds.every((id) =>
      rows.some((r) => r.fact.type === "cpsat.callback-returned" && r.fact.requestId === id),
    ),
  };

  // 2. DLQ。deliver 失敗は attempts 2 で ack するので DLQ へは行かない。
  //    到達するのは busy が続いた場合だけなので、意図的に作る。
  holdCallback = new Promise((resolvePromise) => {
    releaseCallback = resolvePromise;
  });
  const solver = await runtime.getWorker("solver");
  // fetch 経路で isolate を占有する。callback が保留されている間 busy が立ち続ける。
  const occupying = solver.fetch("https://solver.invalid/plan", {
    method: "POST",
    body: JSON.stringify(row()),
  });
  await until(() => rows.some((r) => r.fact.type === "cpsat.solve-started"), 5000);
  await call("/plan", row());
  const reachedDlq = await until(() => receipts.some((r) => r.transport === "dlq"), 25_000);
  releaseCallback();
  holdCallback = undefined;
  await occupying.catch(() => {});
  report.deadLetter = {
    reached: reachedDlq,
    // busy の受領行は attempts つきで出る。deliver 失敗の打ち切りと読み違えないよう並べる。
    busyReceipts: receipts
      .filter((r) => r.transport === "cpsat-queue-consumer" && r.outcome === "busy")
      .map((r) => ({ attempts: r.attempts, outcome: r.outcome })),
    dlqArrivals: receipts
      .filter((r) => r.transport === "dlq")
      .map((r) => ({ attempts: r.attempts })),
    note: "DLQ へ到達する経路は busy の連続だけである。deliver 失敗は attempts 2 で ack され DLQ へ行かない。",
  };
  report.consumerReceipts = receipts
    .filter((r) => r.transport === "cpsat-queue-consumer")
    .map((r) => ({ outcome: r.outcome, attempts: r.attempts }));
  report.notMeasurableHere = [
    "求解中に要求元が他の通信を捌けるか。Miniflare は全 Worker を 1 プロセスで動かすため、Queue にしてもスレッドが共有される。ここでの値は evidence にしない。cloud の測定（連鎖の外の DO が自店舗の求解中も 39〜52ms で応答）が判定を担う。",
    "素の配送遅延（R5.10）。ローカルの Queue は実配送ではない。",
    "isolate をまたぐ再利用と memory growth。",
  ];
} finally {
  await runtime.dispose();
}
const serialized = JSON.stringify(report, null, 2);
await writeFile(resolve(output), `${serialized}\n`, { flag: "wx" });
console.log(serialized);
