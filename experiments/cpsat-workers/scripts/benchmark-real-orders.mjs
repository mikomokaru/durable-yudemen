import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Deliberately local-only. This runner has no remote URL or deploy option.
const directory = resolve("experiments/cpsat-workers");
const nativePath = resolve(process.argv[2] ?? `${directory}/fixtures/local/native-real.json`);
const output = resolve(process.argv[3] ?? `${directory}/fixtures/local/worker-real.json`);
const nativeBytes = await readFile(nativePath);
const native = JSON.parse(nativeBytes);
assert(native.scenes.length > 0 && native.scenes.length <= 1000);
assert(native.repeat >= 1 && native.repeat <= 10 && native.budget > 0 && native.budget <= 0.2);
const secret = await readFile(`${directory}/.dev.vars`, "utf8");
const token = /^POC_AUTH_TOKEN=([a-f0-9]{64})$/m.exec(secret)?.[1];
assert(token, "Missing isolated PoC auth token; run scripts/init-secret.mjs");
const port = 8791;
const origin = `http://127.0.0.1:${port}`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  measuredAt: new Date().toISOString(),
  nativeSha256: hash(nativeBytes),
  wasmSha256: hash(await readFile(`${directory}/vendor/cpsat_workers_poc_runtime.wasm`)),
  host: { platform: process.platform, architecture: process.arch, node: process.version },
  budget: native.budget,
  repeat: native.repeat,
  localOnly: true,
  freshWorkerdPerClock: true,
  requestWatchdogMs: 15000,
  startup: {},
  boundaries: [],
  requests: [],
};
async function save() {
  await writeFile(output, `${JSON.stringify(report)}\n`, { mode: 0o600 });
}
async function request(path, options = {}) {
  const startedAt = performance.now();
  const response = await fetch(`${origin}${path}`, {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${token}` },
    ...options,
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { nonJsonResponse: true };
  }
  return { status: response.status, clientElapsedMs: performance.now() - startedAt, body };
}
async function boundary(path, options, expected) {
  const response = await request(path, options);
  assert.equal(response.status, expected);
  report.boundaries.push({ path, status: response.status });
}
function signalGroup(server, signal) {
  if (server.pid === undefined) return;
  try {
    process.kill(-server.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
for (const clock of ["host", "frozen"]) {
  const probe = createServer();
  await new Promise((accept, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close(accept));
  });
  let log = "";
  let spawnError;
  const startedAt = performance.now();
  const server = spawn(
    "pnpm",
    [
      "exec",
      "wrangler",
      "dev",
      "--config",
      `${directory}/wrangler.jsonc`,
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--log-level",
      "warn",
      "--show-interactive-dev-session=false",
    ],
    { cwd: directory, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  for (const stream of [server.stdout, server.stderr])
    stream.on("data", (chunk) => {
      log = `${log}${chunk}`.slice(-20000);
    });
  server.on("error", (error) => {
    spawnError = error;
  });
  try {
    let ready = false;
    while (performance.now() - startedAt < 30000) {
      assert(
        server.exitCode === null && server.signalCode === null && !spawnError,
        `Local server exited: ${log}`,
      );
      try {
        const response = await request("/health", { signal: AbortSignal.timeout(500) });
        if (response.status === 200 && response.body.poc === "cpsat-deterministic-v1") {
          ready = true;
          break;
        }
      } catch {
        /* Owned local listener is not ready yet. */
      }
      await delay(100);
    }
    assert(ready, `Local server startup timed out: ${log}`);
    report.startup[clock] = performance.now() - startedAt;
    await boundary("/solve-model", { method: "POST", headers: {} }, 401);
    await boundary("/solve-model", {}, 405);
    await boundary("/solve-model", { method: "POST", body: new Uint8Array() }, 413);
    await boundary("/solve-model", { method: "POST", body: new Uint8Array(1048577) }, 413);
    await boundary("/solve-model?deterministicLimit=0", { method: "POST" }, 400);
    // Do not warm the Wasm instance before the first valid solve.
    for (const model of native.scenes) {
      const bytes = Buffer.from(model.protoBase64, "base64");
      assert.equal(hash(bytes), model.protoSha256);
      const modelBudget = model.budget ?? native.budget;
      assert(modelBudget > 0 && modelBudget <= 0.2);
      for (let repeat = 0; repeat < native.repeat; repeat++) {
        const response = await request(
          `/solve-model?clock=${clock}&deterministicLimit=${modelBudget}`,
          {
            method: "POST",
            body: bytes,
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/octet-stream",
              "x-cpsat-request-id": `${clock}-${model.id}-${repeat}`,
            },
          },
        );
        assert.equal(response.status, 200, `Solve failed: ${model.id} ${clock} ${response.status}`);
        assert.equal(response.body.samples.length, 1);
        report.requests.push({ id: model.id, clock, repeat, ...response });
      }
      await save();
      if (report.requests.length % 25 === 0)
        console.log(
          JSON.stringify({
            clock,
            requests: report.requests.length,
            status: report.requests.at(-1).body.samples[0].status,
          }),
        );
    }
    // Malformed protobuf must return promptly; this local-only diagnostic surface
    // currently exposes runtime parse failure as HTTP 500, never as a valid solution.
    await boundary(
      `/solve-model?clock=${clock}`,
      { method: "POST", body: new Uint8Array([255]) },
      500,
    );
    const recovery = await request(`/run?clock=${clock}`);
    assert.equal(recovery.status, 200);
    assert.equal(recovery.body.samples[0].status, "OPTIMAL");
    report.boundaries.push({
      path: `/run?clock=${clock}`,
      status: recovery.status,
      recovery: true,
    });
  } finally {
    await save();
    signalGroup(server, "SIGTERM");
    await delay(500);
    signalGroup(server, "SIGKILL");
  }
}
await save();
console.log(
  JSON.stringify({
    output,
    requests: report.requests.length,
    startup: report.startup,
    maxWasmMemoryBytes: Math.max(...report.requests.map((r) => r.body.samples[0].wasmMemoryBytes)),
  }),
);
