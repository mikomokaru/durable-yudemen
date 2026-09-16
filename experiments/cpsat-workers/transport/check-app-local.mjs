// Real application/Registry/StoreTimerDO and real Wasm, local workerd only.
// This is not the bounded cloud driver and never loads Cloudflare credentials.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdtemp, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { TrialLedger } from "./ledger.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { build } = wranglerRequire("esbuild");
const { Miniflare, Log, LogLevel } = wranglerRequire("miniflare");
const output = process.argv[2];
if (!output || process.argv.length !== 3)
  throw new Error("Usage: node check-app-local.mjs NEW_REPORT.json");
await assert.rejects(access(resolve(output)), { code: "ENOENT" });
const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
const fixtures = JSON.parse(await readFile(resolve(directory, "fixtures.json"), "utf8"));
const provenancePath = "../../../tests/observe/fixtures/cpsat-transport-provenance.json";
const provenance = JSON.parse(await readFile(resolve(directory, provenancePath), "utf8"));
const wasm = await readFile(resolve(directory, "../vendor/cpsat_workers_poc_runtime.wasm"));
const glue = await readFile(resolve(directory, "../vendor/cpsat_workers_poc_runtime.js"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(hash(wasm), manifest.wasm);
assert.equal(hash(glue), manifest.glue);
assert.equal(manifest.enabled, false);
assert.equal(manifest.origin, "");
assert.equal(manifest.requestTokenSha256, "");
assert.deepEqual(
  manifest.problems,
  fixtures.fixtures.map(({ name, sha256, budget }) => ({ name, sha256, budget })),
);
for (const fixture of fixtures.fixtures)
  assert.equal(hash(Buffer.from(fixture.protoBase64, "base64")), fixture.sha256);

const scratch = await mkdtemp(resolve(tmpdir(), "cpsat-app-local-"));
const token = randomBytes(32).toString("hex");
const adminToken = randomBytes(32).toString("hex");
const ingressToken = randomBytes(32).toString("hex");
// A real TCP ingress, not an Origin header injected before the tested boundary.
// The only forward target is installed after the private local binding is ready.
let loopbackForward = null;
let loopbackForwarded = 0;
const loopback = createServer(
  {
    requestTimeout: 5000,
    headersTimeout: 5000,
    keepAliveTimeout: 1000,
    maxHeaderSize: 8192,
  },
  (request, response) => {
    void acceptLoopback(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(503, { Connection: "close" });
      response.end();
    });
  },
);
await new Promise((resolve, reject) => {
  loopback.once("error", reject);
  loopback.listen(0, "127.0.0.1", resolve);
});
// A startup failure must not leave this test listener keeping the process alive.
loopback.unref();
const address = loopback.address();
assert.ok(address && typeof address !== "string" && address.address === "127.0.0.1");
const trial = {
  ...manifest,
  enabled: true,
  notBefore: Date.now() - 1000,
  expiresAt: Date.now() + 120_000,
  origin: `http://127.0.0.1:${address.port}`,
  requestTokenSha256: hash(token),
};
const report = {
  measuredAt: new Date().toISOString(),
  environment: "local-workerd",
  cloudEvidence: false,
  appEffectPathTested: false,
  engineGeneration: { measured: false, count: null, reason: "H1 is not wired in the real shell" },
  shimReceipts: [],
  effectTrials: [],
  transportCoverage: {
    boundary: "shim receipt after input/store/window validation",
    doToShimMeasured: false,
    preReceiptRefusalsMeasured: false,
    operationToDispatch: "inference only; not H1",
    durableLedgerImplemented: true,
  },
  ledger: null,
  browserReachability: null,
  loopbackCases: [],
  callback: "unmodified real StoreTimerDO.deliverPlan",
  artifacts: { wasm: hash(wasm), glue: hash(glue) },
  trial: {
    notBefore: trial.notBefore,
    expiresAt: trial.expiresAt,
    stores: manifest.stores,
    problems: manifest.problems,
    code: manifest.code,
    codec: manifest.codec,
    profile: manifest.profile,
    authorization: "per-run 256-bit random token, exact loopback Origin; secret not recorded",
  },
  toolchain: {
    node: process.version,
    wrangler: wranglerRequire("./package.json").version,
    miniflare: wranglerRequire("miniflare/package.json").version,
    esbuild: wranglerRequire("esbuild/package.json").version,
    compatibilityDate: "2026-06-26",
  },
  checks: {},
  requests: [],
  bundleInputs: {},
  observations: [],
};
// One trial's aggregate budget. The solver counts per isolate only, so the stop
// condition that spans isolates, failures and restarts lives in this journal.
const limits = {
  dispatch: 128,
  operation: 512,
  connection: 32,
  concurrent: 4,
  // Sockets connecting or connected at once. Independent of `concurrent`,
  // which bounds reservation work and frees as soon as a socket is accepted.
  openConnections: 4,
};
const ledgerPath = resolve(scratch, "trial-ledger.jsonl");
const ledger = await TrialLedger.open(ledgerPath, trial, limits);
// Observed dispatches arrive on a synchronous log stream. Reconcile them at the
// bounded polling points rather than awaiting inside the stream handler.
const observedDispatches = [];
// The store whose Effect-induced send belongs to a reservation currently in
// flight. Attribution is what actually tests "one dispatch per operation"; the
// total bound alone is loose enough for unused allowance to hide a second send.
const attributionByStore = new Map();
// Direct sends the driver issues itself: it knows the request id up front.
const attributionByRequest = new Map();
const isRecord = (value) => typeof value === "object" && value !== null;
async function drainLedger() {
  while (observedDispatches.length) {
    const row = observedDispatches.shift();
    // oxlint-disable-next-line no-await-in-loop
    await ledger.recordObservedDispatch(
      row.requestId,
      attributionByRequest.get(row.requestId) ?? attributionByStore.get(row.storeRef),
    );
  }
}

const diagnostics = [];
const sockets = [];
let tsDispatches = 0;

async function acceptLoopback(request, response) {
  const refuse = (status) => {
    response.writeHead(status, { Connection: "close", "Cache-Control": "no-store" });
    response.end();
    request.resume();
  };
  if (!loopbackForward) return refuse(503);
  // Literal Host prevents another hostname resolving to loopback from borrowing
  // this origin. Reject duplicates instead of trusting Node's first-value rule.
  if (
    request.headersDistinct.host?.length !== 1 ||
    request.headers.host !== new URL(trial.origin).host
  )
    return refuse(403);
  if (request.method !== "POST" || request.url !== "/plan") return refuse(404);
  if (request.headersDistinct.origin?.length !== 1 || request.headers.origin !== trial.origin)
    return refuse(403);
  const authorization = request.headers.authorization ?? "";
  if (
    request.headersDistinct.authorization?.length !== 1 ||
    !/^Bearer [0-9a-f]{64}$/.test(authorization) ||
    !timingSafeEqual(Buffer.from(authorization.slice(7), "hex"), Buffer.from(token, "hex"))
  )
    return refuse(401);
  if (request.headers["content-type"] !== "application/json") return refuse(415);
  if (Date.now() < trial.notBefore || Date.now() >= trial.expiresAt) return refuse(503);
  const bytes = await new Promise((resolve) => {
    let size = 0;
    let chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16_384) {
        chunks = [];
        resolve(null);
      } else chunks.push(chunk);
    });
    request.once("end", () => resolve(size > 16_384 ? null : Buffer.concat(chunks)));
    request.once("aborted", () => resolve(null));
    request.once("error", () => resolve(null));
  });
  if (bytes === null) return refuse(413);
  // Reading a streaming body may cross the manifest deadline.
  if (Date.now() < trial.notBefore || Date.now() >= trial.expiresAt) return refuse(503);
  loopbackForwarded += 1;
  const result = await loopbackForward.fetch("https://probe.invalid/plan", {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      // Miniflare's ingress strips/rejects foreign Origin. Only promote the
      // already validated literal here; never trust incoming X-Local-Test-Origin.
      "X-Local-Test-Origin": trial.origin,
    },
    body: bytes,
  });
  response.writeHead(result.status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(await result.text());
}

async function callLoopback(label, body, expected, options = {}) {
  const reservation = expected === 202 ? await ledger.reserve("dispatch") : null;
  if (reservation && isRecord(body) && isRecord(body.fact))
    attributionByRequest.set(body.fact.requestId, reservation);
  const before = loopbackForwarded;
  const started = performance.now();
  const result = await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port: address.port,
        method: options.method ?? "POST",
        path: options.path ?? "/plan",
        headers: options.headers ?? {
          Host: new URL(trial.origin).host,
          Origin: trial.origin,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
      (response) => {
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 16_384) request.destroy(new Error("Unbounded loopback response"));
        });
        response.once("end", () =>
          resolve({ status: response.statusCode, headers: response.headers }),
        );
        response.once("error", reject);
      },
    );
    request.once("error", reject);
    request.setTimeout(5000, () => request.destroy(new Error("Loopback response timeout")));
    request.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  assert.equal(result.status, expected, label);
  if (reservation) await ledger.settle(reservation, "sent");
  assert.equal(result.headers["access-control-allow-origin"], undefined);
  assert.equal(result.headers["access-control-allow-credentials"], undefined);
  const entry = {
    label,
    status: result.status,
    forwarded: loopbackForwarded - before,
    clientWallMs: performance.now() - started,
  };
  report.loopbackCases.push(entry);
  return entry;
}

async function bundle(entry, overrides = {}) {
  const built = await build({
    absWorkingDir: directory,
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    metafile: true,
    external: ["cloudflare:workers"],
    plugins: [
      {
        name: "local-only-trial-manifest",
        setup(bundler) {
          bundler.onResolve({ filter: /\.wasm$/ }, () => ({
            path: "./runtime.wasm",
            external: true,
          }));
          bundler.onLoad({ filter: /\/transport\/manifest\.json$/ }, () => ({
            contents: JSON.stringify({ ...trial, ...overrides }),
            loader: "json",
          }));
        },
      },
    ],
  });
  const inputs = Object.keys(built.metafile.inputs);
  // 固定問題の輸送に、**実モデルの生成と runtime を持ち込まない**。
  //
  // 2026-09-12：`src/cpsat/request.ts` を除外から外した。`store-timer-do.ts` が
  // `cpsatInputKey`・`checkCpsatPayload` を正当に使うようになったからである。あのファイルは
  // 型と入力鍵とサイズ検査だけで、モデル生成も WASM も持たない。引き続き排除するのは
  // `plan.ts`（`formulate` と tuning）・`protobuf.ts`・`worker.ts` と、tuning/Python である。
  assert.ok(
    !inputs.some((path) => /\.py$|tuning\/|src\/cpsat\/(worker|plan|protobuf)\.ts$/.test(path)),
  );
  if (entry === "app.ts") assert.ok(!inputs.some((path) => /vendor\/|fixtures\.json$/.test(path)));
  report.bundleInputs[entry] = inputs;
  return built.outputFiles[0].text;
}

const variations = [
  ["app", {}],
  ["disabled", { enabled: false }],
  ["expired", { notBefore: Date.now() - 10_000, expiresAt: Date.now() - 1000 }],
  ["future", { notBefore: Date.now() + 60_000, expiresAt: Date.now() + 90_000 }],
  ["wide-window", { expiresAt: trial.notBefore + 7_200_001 }],
  ["missing-token", { requestTokenSha256: "" }],
  // 求解 Worker への直接 binding を外したので、solver の 503／429／到達不能は
  // アプリからもう見えない。送出側に残る失敗は「投入が失敗する」だけである。
  ["send-failure", {}],
];
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
          diagnostics.push(line);
          try {
            const offset = line.indexOf('{"');
            if (offset < 0) continue;
            const row = JSON.parse(line.slice(offset));
            if (row.schemaVersion === 1 && row.fact) {
              report.observations.push(row);
              // One send is one dispatch row; the ledger deduplicates repeats.
              if (row.fact.type === "cpsat.request-dispatched")
                observedDispatches.push({
                  requestId: row.fact.requestId,
                  storeRef: row.storeRef,
                });
            }
            if (row.transport === "shim") report.shimReceipts.push(row);
          } catch {
            /* Workerd diagnostics are not observations. */
          }
        }
      });
    }
  },
  workers: [
    ...variations.map(([name]) => ({
      name: `caller-${name}`,
      compatibilityDate: "2026-06-26",
      modules: true,
      // Miniflare rejects foreign Origin at its own HTTP ingress. Inject the
      // test Origin only inside this local relay to exercise the app's gate,
      // rather than accidentally testing Miniflare's 403 as the app's 401.
      script: `export default { fetch(request, env) {
        const forwarded = new Request(request);
        const origin = forwarded.headers.get("X-Local-Test-Origin");
        forwarded.headers.delete("X-Local-Test-Origin");
        if (origin !== null) forwarded.headers.set("Origin", origin);
        const path = new URL(forwarded.url).pathname;
        return path.startsWith("/ops/")
          ? env.CPSAT_TRANSPORT_OPERATIONS.fetch(forwarded)
          : env.CPSAT_TRANSPORT_PROBE.fetch(forwarded);
      } };`,
      serviceBindings: {
        CPSAT_TRANSPORT_PROBE: { name, entrypoint: "CpsatTransportProbe" },
        CPSAT_TRANSPORT_OPERATIONS: { name, entrypoint: "CpsatTransportOperations" },
      },
    })),
    ...(await Promise.all(
      variations.map(async ([name, overrides]) => ({
        name,
        compatibilityDate: "2026-06-26",
        modules: true,
        script: await bundle("app.ts", overrides),
        bindings: {
          ADMIN_TOKEN: adminToken,
          ORDER_INGRESS_TOKEN: ingressToken,
          ACCESS_REQUIRED: "1",
          TEAM_DOMAIN: "local.invalid",
          POLICY_AUD: "local-only",
          OBSERVE_DEBUG: "0",
          OPERATION_HISTORY_ENABLED: "0",
        },
        durableObjects: {
          STORE_TIMER_DO: { className: "StoreTimerDO", useSQLite: true },
          STORE_REGISTRY_DO: { className: "StoreRegistryDO", useSQLite: true },
        },
        // 投入口だけ。`send-failure` は binding を張らない——`env.CPSAT_PLAN_QUEUE`
        // が無ければ `send` が throw し、送出側が握って 503 になる。作り物の
        // Response ではなく、実際に起きる形で失敗を作る。
        ...(name === "send-failure"
          ? {}
          : { queueProducers: { CPSAT_PLAN_QUEUE: "cpsat-plan-requests" } }),
        serviceBindings: {
          SOLVER:
            name === "app"
              ? "shim"
              : () => {
                  tsDispatches += 1;
                  return new Response(null, { status: 202 });
                },
          ASSETS: () => new Response(null, { status: 404 }),
        },
      })),
    )),
    {
      name: "shim",
      compatibilityDate: "2026-06-26",
      modules: true,
      script: await bundle("shim.ts"),
      // 求解への到達手段は Queue だけである。shim は CP-SAT Worker への binding を
      // 持たないので、ここでも張らない（design 第9節）。
      queueProducers: { CPSAT_PLAN_QUEUE: "cpsat-plan-requests" },
      serviceBindings: {
        SOLVER: () => {
          tsDispatches += 1;
          return new Response(null, { status: 202 });
        },
      },
    },
    {
      name: "solver",
      compatibilityDate: "2026-06-26",
      compatibilityFlags: ["no_nodejs_compat", "no_nodejs_compat_v2"],
      // 1 invocation 1 求解。区間の測定が invocation の境界と一致し、handler の
      // throw が巻き込む範囲も 1 件に閉じる（tasks 2.4・wrangler.queue-consumer.jsonc）。
      queueConsumers: {
        "cpsat-plan-requests": {
          maxBatchSize: 1,
          maxBatchTimeout: 0,
          maxRetries: 3,
          // 配備設定（wrangler.queue-consumer.jsonc）と揃える。ここだけ既定のままだと
          // ローカルで通った条件が cloud の条件と食い違う。
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
        STORE_TIMER_DO: { className: "StoreTimerDO", scriptName: "app", useSQLite: true },
      },
    },
    {
      // DLQ を消費して数えるだけ。置かないと再配送を尽くした要求の行方が harness から
      // 見えない。
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
      // Same solver source, admission only. A valid row reaches the exhausted
      // send budget (429); a bad provenance must stop earlier (400). No fake
      // engine generation or Persist observations are manufactured for this.
      name: "solver-admission",
      compatibilityDate: "2026-06-26",
      compatibilityFlags: ["no_nodejs_compat", "no_nodejs_compat_v2"],
      modulesRoot: scratch,
      modules: [
        {
          type: "ESModule",
          path: resolve(scratch, "solver-admission.js"),
          contents: await bundle("solver.ts", { maxDispatches: 0 }),
        },
        { type: "CompiledWasm", path: resolve(scratch, "runtime.wasm"), contents: wasm },
      ],
      durableObjects: {
        STORE_TIMER_DO: { className: "StoreTimerDO", scriptName: "app", useSQLite: true },
      },
    },
  ],
});

function input(store = manifest.stores[0], problem = manifest.problems[0]) {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    at: Date.now(),
    storeRef: store.ref,
    backend: "cpsat",
    mode: "probe",
    instanceId: "test-intent",
    invocationId: randomUUID(),
    parentEventId: null,
    versions: {
      code: manifest.code,
      model: problem.sha256,
      codec: manifest.codec,
      wasm: manifest.wasm,
      glue: manifest.glue,
      profile: manifest.profile,
      budget: String(problem.budget),
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

async function until(predicate) {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    // oxlint-disable-next-line no-await-in-loop
    await drainLedger();
    if (Date.now() >= deadline) throw new Error("Local completion missing");
    // Bounded local orchestration; never sleeps inside the solver.
    // oxlint-disable-next-line no-await-in-loop
    await delay(10);
  }
}

async function probe(label, body, expected, options = {}) {
  const target = await runtime.getWorker(options.target ?? "caller-app");
  const started = performance.now();
  // Budget follows the send, not the status. A refused input spends nothing,
  // but an accepted input whose downstream fails (503/429) has already sent.
  // The call site declares it; `unreserved-dispatch` catches any site that
  // forgets, which is how the first wiring of this ledger was found wrong.
  const reservation =
    expected === 202 || options.reachesBinding ? await ledger.reserve("dispatch") : null;
  // The driver knows which send this is, so attribute it: the loose total bound
  // alone cannot tell an extra send from unused allowance elsewhere.
  if (reservation && isRecord(body) && isRecord(body.fact))
    attributionByRequest.set(body.fact.requestId, reservation);
  const headers = new Headers(
    options.headers ?? { Authorization: `Bearer ${token}`, Origin: trial.origin },
  );
  if (options.target !== "app" && headers.has("Origin")) {
    headers.set("X-Local-Test-Origin", headers.get("Origin"));
    headers.delete("Origin");
  }
  const response = await target.fetch(`https://probe.invalid${options.path ?? "/plan"}`, {
    method: options.method ?? "POST",
    headers,
    ...(options.method === "GET"
      ? {}
      : {
          body:
            typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body),
        }),
  });
  assert.equal(response.status, expected, label);
  await response.text();
  if (reservation) await ledger.settle(reservation, "sent");
  report.requests.push({
    label,
    status: response.status,
    clientWallMs: performance.now() - started,
  });
}

try {
  await runtime.ready;
  loopbackForward = await runtime.getWorker("caller-app");
  const app = await runtime.getWorker("app");
  // Use the real public Provisioning API with ephemeral local-only credentials.
  const provision = async (path, method, body, status) => {
    const response = await app.fetch(`https://app.invalid${path}`, {
      method,
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, status, await response.text());
  };
  await provision(
    "/admin/chains/cpsat-transport-20260909",
    "PUT",
    { name: "local fixed transport", chainRoster: [] },
    200,
  );
  for (const store of manifest.stores) {
    // Provision all destinations, not only a callback test double.
    // oxlint-disable-next-line no-await-in-loop
    await provision(
      "/admin/stores",
      "POST",
      {
        storeId: store.id,
        chainId: "cpsat-transport-20260909",
        name: "local synthetic",
        storeRoster: ["transport@invalid.example"],
        override: {
          noodlePresets: [
            { noodleType: "probe", boilSeconds: { extraHard: 45, hard: 52, normal: 60, soft: 75 } },
          ],
        },
      },
      201,
    );
  }
  // The private entrance replaces Miniflare's namespace handle, which has no
  // cloud equivalent. The driver reserves in the ledger before connecting, so a
  // WebSocket cannot enter without passing window, store and budget checks.
  const relay = await runtime.getWorker("caller-app");
  const opsUrl = (path, store) =>
    `https://probe.invalid/ops/${path}?store=${encodeURIComponent(store.id)}`;
  const opsHeaders = () => ({
    Authorization: `Bearer ${token}`,
    "X-Local-Test-Origin": trial.origin,
  });
  const connect = async (store = manifest.stores[0]) => {
    // Cumulative: reconnects and failures spend a slot too, and closing does
    // not return it. Distinct from the concurrent-in-flight bound. The default
    // allowance is charged because a connection that wakes a cold object runs
    // the constructor's Reconcile through runEffects, which can emit a request.
    const reservation = await ledger.reserve("connection");
    let response;
    try {
      response = await relay.fetch(opsUrl("watch", store), {
        headers: { ...opsHeaders(), Upgrade: "websocket" },
      });
    } catch (error) {
      // A failed connection returns the simultaneity slot; the attempt stays spent.
      await ledger.releaseConnection(reservation, "failed");
      throw error;
    }
    await ledger.settle(reservation, "open");
    if (response.status !== 101) {
      await ledger.releaseConnection(reservation, "refused");
      assert.equal(response.status, 101);
    }
    const messages = [];
    const socket = response.webSocket;
    assert.ok(socket);
    socket.addEventListener("message", (event) => messages.push(JSON.parse(event.data)));
    socket.accept();
    // Resolve on the close event, not on the close request: releasing the slot
    // when close() returns would say a socket had gone while it was still open.
    const closed = new Promise((resolve) => socket.addEventListener("close", () => resolve()));
    sockets.push({ socket, reservation, closed });
    await until(() => messages.some((m) => m.type === "snapshot"));
    return Object.assign(messages, { socket, reservation });
  };
  const messages = await connect();
  const orderPath = `/s/${manifest.stores[0].id}/orders`;
  const order = {
    items: [
      {
        externalOrderId: "local-transport-order",
        itemIndex: 0,
        noodleType: "probe",
        firmness: "normal",
        tableId: null,
      },
    ],
  };
  let response = await app.fetch(`https://app.invalid${orderPath}`, {
    method: "POST",
    body: JSON.stringify(order),
  });
  assert.equal(response.status, 401);
  response = await app.fetch(`https://app.invalid${orderPath}`, {
    method: "POST",
    body: JSON.stringify(order),
    headers: { Authorization: `Bearer ${ingressToken}` },
  });
  assert.equal(response.status, 200, await response.text());
  await until(() => messages.filter((m) => m.type === "snapshot").length === 2);
  assert.equal(tsDispatches, 1, "Positive business transition still uses the existing TS binding");
  const beforeMessages = messages.length;

  await probe("public handler has no solver route", input(), 404, { target: "app" });
  for (const target of ["disabled", "expired", "future", "wide-window"])
    // oxlint-disable-next-line no-await-in-loop
    await probe(target, input(), 503, { target: `caller-${target}` });
  await probe("missing run-token configuration", input(), 401, { target: "caller-missing-token" });
  for (const headers of [
    {},
    { Origin: trial.origin },
    { Origin: trial.origin, Authorization: `Bearer ${"0".repeat(64)}` },
    { Origin: "https://attacker.invalid", Authorization: `Bearer ${token}` },
    { Authorization: `Bearer ${token}` },
  ])
    // oxlint-disable-next-line no-await-in-loop
    await probe("unauthorized", input(), 401, { headers });
  await probe("wrong path", input(), 404, { path: "/admin/stores" });
  await probe("arbitrary callback query", input(), 404, {
    path: "/plan?callback=https://other.invalid",
  });
  await probe("wrong method", input(), 404, { method: "GET" });
  const valid = input();
  for (const body of [
    "{",
    "x".repeat(16_385),
    new Uint8Array([0xc0, 0xaf]),
    { ...valid, storeRef: "0".repeat(64) },
    { ...valid, mode: "live" },
    { ...valid, callbackUrl: "https://other.invalid" },
    { ...valid, model: [] },
    { ...valid, versions: { ...valid.versions, budget: "1" } },
    { ...valid, versions: { ...valid.versions, model: "0".repeat(64) } },
    { ...valid, versions: { ...valid.versions, wasm: "0".repeat(64) } },
    { ...valid, versions: { ...valid.versions, profile: "0".repeat(64) } },
    { ...valid, at: trial.notBefore - 1 },
    { ...valid, at: trial.expiresAt + 1 },
    { ...valid, parentEventId: randomUUID() },
    {
      ...valid,
      fact: {
        ...valid.fact,
        origin: { kind: "engine", instanceId: "fake", decisionId: "fake", effectIndex: 0 },
      },
    },
    { ...valid, fact: { ...valid.fact, sameInputRetry: true } },
  ])
    // oxlint-disable-next-line no-await-in-loop
    await probe("invalid input", body, 400);
  assert.equal(report.observations.length, 0);
  assert.equal(tsDispatches, 1);
  assert.equal(messages.length, beforeMessages);
  report.checks.negativeInputsNeverDispatch = true;
  report.checks.publicAuthAndTsPathUnchanged = true;

  const admission = await runtime.getWorker("solver-admission");
  report.provenanceCases = [];
  for (const [index, fixture] of provenance.entries()) {
    const intended = input();
    const body = {
      ...intended,
      mode: fixture.mode,
      instanceId: "do-1",
      parentEventId: fixture.parentEventId,
      fact: {
        ...intended.fact,
        origin:
          fixture.origin === "probe"
            ? { kind: "probe" }
            : { kind: "engine", instanceId: "do-1", decisionId: "decision-1", effectIndex: 3 },
      },
    };
    // Every negative uses the identical fixture at the private app entrance.
    if (!fixture.transportAccepted)
      // oxlint-disable-next-line no-await-in-loop
      await probe(`provenance-${index}`, body, 400);
    // oxlint-disable-next-line no-await-in-loop
    const response = await admission.fetch("https://solver.invalid/plan", {
      method: "POST",
      body: JSON.stringify(body),
    });
    assert.equal(
      response.status,
      fixture.transportAccepted ? 429 : 400,
      `solver provenance ${index}`,
    );
    // oxlint-disable-next-line no-await-in-loop
    await response.text();
    report.provenanceCases.push({ ...fixture, solverStatus: response.status });
  }
  assert.equal(report.observations.length, 0);
  report.checks.sharedProvenanceAdmission = true;

  const headers = {
    Host: new URL(trial.origin).host,
    Origin: trial.origin,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  for (const [label, overrides, status] of [
    ["foreign Host", { headers: { ...headers, Host: "attacker.invalid" } }, 403],
    ["localhost alias", { headers: { ...headers, Host: `localhost:${address.port}` } }, 403],
    [
      "foreign Origin with valid token",
      { headers: { ...headers, Origin: "https://attacker.invalid" } },
      403,
    ],
    ["null Origin", { headers: { ...headers, Origin: "null" } }, 403],
    [
      "missing Origin",
      {
        headers: {
          Host: headers.Host,
          Authorization: headers.Authorization,
          "Content-Type": "application/json",
        },
      },
      403,
    ],
    [
      "missing token",
      { headers: { Host: headers.Host, Origin: trial.origin, "Content-Type": "application/json" } },
      401,
    ],
    ["wrong token", { headers: { ...headers, Authorization: `Bearer ${"0".repeat(64)}` } }, 401],
    [
      "form content type",
      { headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" } },
      415,
    ],
    ["plain content type", { headers: { ...headers, "Content-Type": "text/plain" } }, 415],
    ["preflight", { method: "OPTIONS" }, 404],
    ["GET", { method: "GET" }, 404],
    ["arbitrary destination", { path: "/plan?callback=https://other.invalid" }, 404],
    ["unrelated route", { path: "/admin/stores" }, 404],
    [
      "forged relay Origin",
      {
        headers: {
          ...headers,
          Origin: "https://attacker.invalid",
          "X-Local-Test-Origin": trial.origin,
        },
      },
      403,
    ],
  ]) {
    // These are actual HTTP requests to the Node listener, not Miniflare refusals.
    // oxlint-disable-next-line no-await-in-loop
    const result = await callLoopback(label, input(), status, overrides);
    assert.equal(result.forwarded, 0);
  }
  assert.equal((await callLoopback("oversized body", "x".repeat(16_385), 413)).forwarded, 0);
  assert.equal(report.observations.length, 0);
  assert.equal(report.shimReceipts.length, 0);
  report.checks.realLoopbackRefusalsNeverForward = true;

  for (const store of manifest.stores.filter((item) => item.series === "shim"))
    // A direct probe cannot contaminate a shim store's aggregate scope.
    // oxlint-disable-next-line no-await-in-loop
    await probe("direct probe rejects shim scope", input(store), 400);

  for (const [index, store] of manifest.stores
    .filter((item) => item.series === "direct")
    .entries()) {
    const intended = input(store, manifest.problems[index % 2]);
    // oxlint-disable-next-line no-await-in-loop
    report.requests.push(await callLoopback(`fixed-${index}`, intended, 202));
    // oxlint-disable-next-line no-await-in-loop
    await until(() =>
      report.observations.some(
        (row) =>
          row.fact.type === "cpsat.measurement" &&
          row.fact.metric === "wait-until-wall-ms" &&
          row.fact.requestId === intended.fact.requestId,
      ),
    );
    const sent = report.observations.find(
      (row) =>
        row.fact.type === "cpsat.request-dispatched" &&
        row.fact.requestId === intended.fact.requestId,
    );
    assert.ok(sent);
    assert.notEqual(sent.eventId, intended.eventId);
    assert.notEqual(sent.instanceId, intended.instanceId);
    const returned = report.observations.find(
      (row) =>
        row.fact.type === "cpsat.callback-returned" &&
        row.fact.requestId === intended.fact.requestId,
    );
    assert.equal(returned?.fact.outcome, "delivered");
    assert.equal(returned?.storeRef, store.ref);
    const finished = report.observations.find(
      (row) =>
        row.fact.type === "cpsat.solve-finished" && row.fact.requestId === intended.fact.requestId,
    );
    assert.equal(finished?.fact.status, index % 2 === 0 ? "OPTIMAL" : "UNKNOWN");
  }
  assert.equal(messages.length, beforeMessages, "No callback broadcast on the live local socket");
  const afterMessages = await connect();
  const before = messages.at(-1);
  const after = afterMessages.at(-1);
  assert.deepEqual(after.orderItems, before.orderItems);
  assert.deepEqual(after.timers, before.timers);
  // Existing TS projection advances an immediately startable proposal to the
  // hydration clock. Check that exact shift, not an unjustified byte equality
  // or a blanket omission of recommendations from the assertion.
  assert.equal(before.recommendations.length, 1);
  assert.equal(before.recommendations[0].startAt, before.serverTime);
  assert.equal(before.recommendations[0].group, `0:${before.serverTime + 60_000}`);
  assert.deepEqual(after.recommendations, [
    {
      ...before.recommendations[0],
      startAt: after.serverTime,
      group: `0:${after.serverTime + 60_000}`,
    },
  ]);
  assert.equal(tsDispatches, 1, "Callback must not cause another ordinary plan request");
  report.checks.realWasmCallsRealDoCallback = true;
  report.checks.callbackDoesNotChangeBusinessFactsOrBroadcast = true;
  report.checks.tsHydrationOnlyAdvancesImmediateProposal = true;

  for (const store of manifest.stores.filter((item) => item.series === "shim")) {
    // The actual public ingress reaches the unmodified DO's state-changing,
    // Persist-first Effect interpreter. No synthetic H1 or PlanRequest is sent.
    const observationStart = report.observations.length;
    // The driver never calls the Effect-induced send, so it cannot reserve it
    // afterwards. The operation pays its worst-case allowance up front.
    // oxlint-disable-next-line no-await-in-loop
    const operation = await ledger.reserve("operation");
    attributionByStore.set(store.ref, operation);
    // oxlint-disable-next-line no-await-in-loop
    const response = await app.fetch(`https://app.invalid/s/${store.id}/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ingressToken}` },
      body: JSON.stringify(order),
    });
    // oxlint-disable-next-line no-await-in-loop
    assert.equal(response.status, 200, await response.text());
    // oxlint-disable-next-line no-await-in-loop
    await until(() => report.shimReceipts.some((row) => row.storeRef === store.ref));
    const receipt = report.shimReceipts.find((row) => row.storeRef === store.ref);
    assert.ok(receipt);
    assert.equal(receipt.pendingCount, 1);
    assert.equal(receipt.runningCount, 0);
    // oxlint-disable-next-line no-await-in-loop
    await until(() =>
      report.observations.some(
        (row) =>
          row.fact.type === "cpsat.measurement" &&
          row.fact.metric === "wait-until-wall-ms" &&
          row.fact.requestId === receipt.requestId,
      ),
    );
    const rows = report.observations.slice(observationStart);
    const sent = rows.find((row) => row.fact.type === "cpsat.request-dispatched");
    const problem = manifest.problems.find((item) => item.name === store.problem);
    assert.ok(problem);
    assert.equal(sent?.fact.requestId, receipt.requestId);
    assert.equal(sent?.versions.model, problem.sha256);
    assert.equal(sent?.versions.budget, String(problem.budget));
    assert.equal(sent?.mode, "probe");
    assert.deepEqual(sent?.fact.origin, { kind: "probe" });
    assert.equal(sent?.parentEventId, null);
    assert.equal(
      rows.find((row) => row.fact.type === "cpsat.callback-returned")?.fact.outcome,
      "delivered",
    );
    assert.equal(
      rows.find((row) => row.fact.type === "cpsat.solve-finished")?.fact.status,
      store.problem === "small" ? "OPTIMAL" : "UNKNOWN",
    );
    assert.ok(rows.every((row) => row.storeRef === store.ref));
    // oxlint-disable-next-line no-await-in-loop
    await drainLedger();
    attributionByStore.delete(store.ref);
    // oxlint-disable-next-line no-await-in-loop
    await ledger.settle(operation, "dispatched");
    report.effectTrials.push({
      storeRef: store.ref,
      requestId: receipt.requestId,
      status: response.status,
      problem: problem.name,
    });
    // Idempotent redelivery has no new Effect, hence no second fixed request.
    // oxlint-disable-next-line no-await-in-loop
    const duplicate = await app.fetch(`https://app.invalid/s/${store.id}/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ingressToken}` },
      body: JSON.stringify(order),
    });
    assert.equal(duplicate.status, 200);
    // oxlint-disable-next-line no-await-in-loop
    await duplicate.text();
  }
  assert.equal(report.shimReceipts.length, 2);
  assert.equal(tsDispatches, 1, "Only the non-shim business transition went to TS");

  // The private entrance must be able to drive a real business transition, not
  // only observe one. Aim it at a direct-series store so the Effect goes to TS
  // and the fixed-transport counts stay untouched.
  const direct = manifest.stores.find((item) => item.series === "direct");
  const opsCases = [
    ["ops unauthorized", { headers: { "X-Local-Test-Origin": trial.origin } }, 401],
    ["ops missing origin", { headers: { Authorization: `Bearer ${token}` } }, 401],
    ["ops unknown store", { store: { id: "cpsat-transport-absent" } }, 404],
    ["ops wrong method", { method: "GET" }, 404],
    ["ops unknown path", { path: "plan" }, 404],
    ["ops oversized", { body: JSON.stringify({ items: [], pad: "x".repeat(17_000) }) }, 413],
  ];
  for (const [label, options, expected] of opsCases) {
    // oxlint-disable-next-line no-await-in-loop
    const refused = await relay.fetch(opsUrl(options.path ?? "orders", options.store ?? direct), {
      method: options.method ?? "POST",
      headers: options.headers ?? opsHeaders(),
      ...(options.method === "GET" ? {} : { body: options.body ?? "{}" }),
    });
    assert.equal(refused.status, expected, label);
    // oxlint-disable-next-line no-await-in-loop
    await refused.text();
    report.requests.push({ label, status: refused.status, clientWallMs: 0 });
  }
  // The watch entrance is subscription only. A caller frame must not reach the
  // store: it closes the relay instead of being forwarded.
  const watcher = await connect(direct);
  const rejected = await new Promise((resolve) => {
    watcher.socket.addEventListener("close", (event) => resolve(event.code));
    watcher.socket.send(JSON.stringify({ type: "start", slotIds: ["0"] }));
  });
  assert.equal(rejected, 4003, "A caller frame closes the subscription");
  await ledger.releaseConnection(watcher.reservation, "closed");
  sockets.splice(sockets.indexOf(watcher), 1);
  report.checks.watchIsSubscriptionOnly = true;

  // Store-initiated close must reach the caller. Deactivating a synthetic store
  // closes its Durable Object sockets, so the relay's upstream side ends first;
  // the caller must then be closed too, not left waiting for the deadline.
  const closingStore = manifest.stores.find((item) => item.series === "direct" && item !== direct);
  const observer = await connect(closingStore);
  const storeInitiated = new Promise((resolve) => {
    observer.socket.addEventListener("close", (event) => resolve(event.code));
  });
  await provision(
    `/admin/stores/${closingStore.id}`,
    "PUT",
    { chainId: "cpsat-transport-20260909", name: "local synthetic", active: false },
    200,
  );
  const storeClose = await Promise.race([storeInitiated, delay(5000).then(() => "timeout")]);
  assert.notEqual(storeClose, "timeout", "A store-initiated close must reach the caller");
  await ledger.releaseConnection(observer.reservation, "closed");
  sockets.splice(sockets.indexOf(observer), 1);
  report.checks.storeInitiatedCloseReachesCaller = true;

  const beforeOps = tsDispatches;
  // A direct-series Effect goes to TS, so this operation charges no fixed-send
  // allowance. The allowance is per reservation, not per kind.
  const opsOperation = await ledger.reserve("operation", 0);
  const opsOrder = await relay.fetch(opsUrl("orders", direct), {
    method: "POST",
    headers: opsHeaders(),
    body: JSON.stringify({
      items: [
        {
          externalOrderId: "local-transport-order-ops",
          itemIndex: 0,
          noodleType: "probe",
          firmness: "normal",
          tableId: null,
        },
      ],
    }),
  });
  assert.equal(opsOrder.status, 200, await opsOrder.text());
  await until(() => tsDispatches > beforeOps);
  await ledger.settle(opsOperation, "dispatched");
  assert.equal(tsDispatches, 2, "The private entrance drove one more TS-bound transition");
  assert.equal(report.shimReceipts.length, 2, "and none of it reached the fixed transport");
  report.checks.privateEntranceDrivesRealOperations = true;
  report.appEffectPathTested = true;
  report.checks.realEffectReachesOnlyFixedTransport = true;

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
  for (const type of [
    "cpsat.request-dispatched",
    "cpsat.dispatch-result",
    "cpsat.solver-accepted",
    "cpsat.solve-started",
    "cpsat.solve-finished",
    "cpsat.callback-returned",
  ])
    assert.equal(report.observations.filter((row) => row.fact.type === type).length, 4, type);
  assert.equal(
    report.observations.filter((row) => row.fact.type === "cpsat.request-generated").length,
    0,
  );
  // These are deliberate transport fakes, separate from the four real solves.
  const realRowCount = report.observations.length;
  // Compare against the count entering this block, not an absolute total: the
  // claim is that these failures added no TS fallback, whatever ran before.
  const tsBeforeInjection = tsDispatches;
  for (const [target, status, outcome] of [["send-failure", 503, "failed"]]) {
    const intended = input();
    // oxlint-disable-next-line no-await-in-loop
    await probe(`injected-${target}`, intended, status, {
      target: `caller-${target}`,
      reachesBinding: true,
    });
    // oxlint-disable-next-line no-await-in-loop
    await until(() =>
      report.observations.some(
        (row) =>
          row.fact.type === "cpsat.dispatch-result" &&
          row.fact.requestId === intended.fact.requestId,
      ),
    );
    const own = report.observations.filter((row) => row.fact.requestId === intended.fact.requestId);
    assert.deepEqual(own.map((row) => row.fact.type).sort(), [
      "cpsat.dispatch-result",
      "cpsat.request-dispatched",
    ]);
    assert.equal(
      own.find((row) => row.fact.type === "cpsat.dispatch-result").fact.outcome,
      outcome,
    );
  }
  assert.equal(report.observations.length, realRowCount + 2);
  assert.equal(tsDispatches, tsBeforeInjection, "Transport failure must not fall back to TS");
  report.injectedFailureRequestIds = report.observations
    .slice(realRowCount)
    .filter((row) => row.fact.type === "cpsat.request-dispatched")
    .map((row) => row.fact.requestId);
  report.checks.sendFailureIsBoundedAndNeverRetriesOrFallsBack = true;
  // Keep injected sends in the total export. Omitting their rows while claiming
  // complete coverage of the same scope/time window would undercount dispatches.
  const to = Date.now() + 1;
  report.countSummary = summarizeCpsatObservations(report.observations, {
    from: trial.notBefore,
    to,
    capturedFrom: trial.notBefore,
    capturedTo: to,
    retainedFrom: trial.notBefore,
    samplingRate: 1,
    exportComplete: true,
    scopes: manifest.stores.map(({ ref }) => ({ storeRef: ref, backend: "cpsat", mode: "probe" })),
    gaps: [],
    frequencyLimits: null,
  });
  assert.deepEqual(report.countSummary.issues, []);
  assert.equal(report.countSummary.usableForRates, true);
  for (const store of manifest.stores) {
    // 直接 probe の 1 件に、注入した送出失敗 1 件が乗る店舗だけが 2 件になる。
    // 求解 Worker への直接 binding を外した時点で、注入は 3 系列から 1 系列へ減った。
    const expected = store.id === manifest.stores[0].id ? 2 : 1;
    const total = report.countSummary.totals.find((row) => row.storeRef === store.ref);
    assert.equal(total?.counts.dispatched, expected);
    assert.equal(total?.counts.solveStarted, 1);
    const minutes = report.countSummary.minutes.filter((row) => row.storeRef === store.ref);
    assert.equal(
      minutes.reduce((sum, row) => sum + row.counts.dispatched, 0),
      expected,
    );
  }
  assert.equal(new Set(report.countSummary.totals.map((row) => row.storeRef)).size, 4);
  report.checks.seriesAreDisjointAggregateScopes = true;
  // 直接 probe 4 店舗 ＋ shim 系列 ＋ 注入した送出失敗 1 件。注入が 3 系列から
  // 1 系列へ減った分だけ、以前の 7 から 5 になる。
  assert.equal(
    report.observations.filter((row) => row.fact.type === "cpsat.request-dispatched").length,
    5,
  );
  report.checks.distinctCountersAndCausalLinks = true;
  assert.equal(report.loopbackCases.filter((row) => row.status === 202).length, 2);
  assert.ok(
    report.loopbackCases.filter((row) => row.status === 202).every((row) => row.forwarded === 1),
  );
  report.checks.realLoopbackReachesPrivateBinding = true;
  await drainLedger();
  const totals = ledger.totals;
  // Every observed send is covered by a reservation made before it happened.
  assert.ok(totals.observedDispatches <= totals.dispatch);
  assert.equal(totals.inFlight, 0);
  assert.equal(totals.stopped, null);
  report.ledger = {
    limits,
    totals,
    durable: "append-only journal, reservation flushed before the work it authorises",
    // Each run mints a fresh trial window, so the journal is per run here. The
    // restart-crossing rules (unsettled reservations stay spent, the replayed
    // operation allowance is not refunded) are covered by the unit tests, not
    // by this run.
    restartCrossingExercisedHere: false,
    restartCrossingCoveredBy: "tests/cpsat-transport-ledger.example.test.ts",
    operationAllowance:
      "one dispatch per operation; an unreserved observed dispatch stops the trial",
    connectionAllowance:
      "cumulative WebSocket attempts, charged one dispatch each: a connection that wakes a cold object runs the constructor's Reconcile through runEffects, which can emit a request",
    openConnectionsAtReport:
      "the two observing sockets were still open when this snapshot was taken; they are released in teardown, which returns the simultaneity slot but not the attempt",
    connectionsWereWarmHere:
      "this run connected to an already running object, so no connection caused a dispatch; that is a property of this run, not of connections",
  };
  report.browserReachability = {
    measured: false,
    basis:
      "argued from the asserted loopback behaviour plus the Fetch standard, not from a browser run",
    specification: "https://fetch.spec.whatwg.org/#cors-preflight-fetch",
    serverFacts: [
      "OPTIONS preflight answers 404 with no Access-Control-Allow-* headers",
      "Content-Type is a single-value allowlist of application/json, so all three preflight-free types are refused with 415",
      "no response carries Access-Control-Allow-Origin or Access-Control-Allow-Credentials",
      "foreign, null and missing Origin are refused with 403; foreign Host and localhost aliases are refused with 403",
    ],
    browserAssumptions: [
      // Authorization IS settable from script. Setting it, like Content-Type:
      // application/json, makes the request non-safelisted, so the browser must
      // first run a CORS-preflight fetch. This entrance answers that preflight
      // with 404 and no Access-Control-Allow-*, so the actual request is never
      // sent. https://fetch.spec.whatwg.org/#cors-preflight-fetch
      "a request carrying Authorization or Content-Type: application/json is not CORS-safelisted, so a cross-origin browser runs a preflight first and does not send the actual request when that preflight is refused",
      // A separate mechanism, not CORS: Host is a forbidden header name, so the
      // foreign-Host refusal is unreachable from script in the first place.
      // Script cannot set Host, but the browser derives it from the URL, so a
      // page fetching http://localhost:<port>/ does produce Host: localhost:
      // <port>. That refusal is reachable from a page; it is simply refused.
      // Only a Host unrelated to the requested URL is unreachable from script.
      "Host is a forbidden header name that script cannot set, so a page cannot forge a Host unrelated to the URL it requests; the browser still derives Host from the URL, so the localhost-alias refusal is reachable from a page and is refused there",
    ],
    outOfScope:
      "environments where those assumptions do not hold, such as browser extensions or relaxed local policies",
  };
  report.limitations = [
    "Task 2.2 is incomplete: private operations/WS entrance, cloud driver, deployment diff/rollback preparation remain.",
    "H1/engine-generation and decision/effect/Persist provenance are unmeasured. Shim receipts are not generation observations.",
    "No cloud deployment, remote bindings, live data, platform CPU, waitUntil margin or DO hibernation proof.",
    "Real loopback HTTP ingress tested with constructed headers. Browser unreachability is argued from those results, not measured; remote bindings remain untested.",
    "Completeness begins at the shim receipt after validation, not at the DO. Operation-to-request correlation is inference; the ledger bounds sends but does not observe DO-to-shim loss.",
    "Synthetic operations and the WebSocket view go through the private entrance; its cloud reachability over a remote binding is untested.",
    "No callback storage spy in this harness; storage/Alarm no-op is covered separately by the existing real-DO integration test.",
    "The TS binding is a 202 test double. CP-SAT and callback use real source and Wasm.",
  ];
  report.sourceSha256 = Object.fromEntries(
    await Promise.all(
      [
        "app.ts",
        "request.ts",
        "shim.ts",
        "solver.ts",
        "check-app-local.mjs",
        "ledger.mjs",
        "manifest.json",
        "fixtures.json",
        "../../../src/worker.ts",
        "../../../src/shell/store-timer-do.ts",
        "../../../src/shell/store-registry-do.ts",
        "../../../src/cpsat/observation.ts",
        "../../../src/cpsat/observe.ts",
        "../../../src/observe/cpsat.ts",
        provenancePath,
      ].map(async (path) => [path, hash(await readFile(resolve(directory, path)))]),
    ),
  );
  const serialized = JSON.stringify(report, null, 2);
  for (const secret of [token, adminToken, ingressToken]) {
    assert.ok(!serialized.includes(secret));
    assert.ok(!diagnostics.join("\n").includes(secret));
  }
  assert.ok(!serialized.includes("local-transport-order"));
  assert.ok(!diagnostics.join("\n").includes("local-transport-order"));
  await writeFile(resolve(output), `${serialized}\n`, { flag: "wx" });
  console.log(
    JSON.stringify(
      {
        report: resolve(output),
        checks: report.checks,
        requests: report.requests.length,
        observations: report.observations.length,
      },
      null,
      2,
    ),
  );
} finally {
  loopbackForward = null;
  loopback.closeAllConnections();
  await new Promise((resolve) => loopback.close(resolve));
  const teardown = { closes: [], ledger: null, error: null };
  for (const { socket, reservation, closed } of sockets) {
    socket.close(1000, "teardown");
    // Bounded wait so teardown cannot hang. A timeout is not a close: the
    // ledger keeps the slot and records the connection as unconfirmed.
    // oxlint-disable-next-line no-await-in-loop
    const confirmed = await Promise.race([closed.then(() => true), delay(2000).then(() => false)]);
    // oxlint-disable-next-line no-await-in-loop
    await ledger
      .releaseConnection(reservation, confirmed ? "closed" : "close-unconfirmed")
      .catch((error) => {
        teardown.error ??= String(error?.message ?? error);
      });
    teardown.closes.push({ confirmed, waitedMs: 2000 });
  }
  teardown.ledger = ledger.totals;
  // The report is already written by now, so teardown results would otherwise
  // be lost. Keep them beside it rather than leaving the run's end unrecorded.
  await writeFile(`${resolve(output)}.teardown.json`, `${JSON.stringify(teardown, null, 2)}\n`, {
    flag: "wx",
  }).catch(() => undefined);
  await runtime.dispose();
}
