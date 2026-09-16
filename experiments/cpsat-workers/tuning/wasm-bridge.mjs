import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { validateSolution } from "./validate-solution.mjs";

// Started in its own process group by search.py. Wrangler/workerd inherit that
// group, so even an exited wrapper cannot leave an orphan runtime behind.
// Deliberately no remote URL, cloud deployment, or native solver option.
const directory = resolve("experiments/cpsat-workers");
const port = Number(process.argv[2] ?? 8792);
assert(Number.isInteger(port) && port >= 1024 && port <= 65535);
const origin = `http://127.0.0.1:${port}`;
const secret = await readFile(`${directory}/.dev.vars`, "utf8");
const token = /^POC_AUTH_TOKEN=([a-f0-9]{64})$/m.exec(secret)?.[1];
assert(token, "Missing isolated PoC auth token");
const probe = createServer();
await new Promise((accept, reject) => {
  probe.once("error", reject);
  probe.listen(port, "127.0.0.1", () => probe.close(accept));
});
const started = performance.now();
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
  { cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
);
// Consume logs, but never mix logs (or possibly private settings) into the protocol.
server.stdout.resume();
server.stderr.resume();
let spawnError;
server.on("error", (error) => {
  spawnError = error;
});
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
async function request(path, options = {}, timeout = 35000) {
  assert(
    !spawnError && server.exitCode === null && server.signalCode === null,
    "Owned workerd exited",
  );
  const response = await fetch(`${origin}${path}`, {
    ...options,
    redirect: "error",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
    signal: AbortSignal.timeout(timeout),
  });
  assert.equal(response.status, 200, `Local Worker HTTP ${response.status}`);
  return response.json();
}
const stop = () => {
  server.kill("SIGTERM");
};
process.once("SIGTERM", () => {
  stop();
  process.exit(143);
});
process.once("SIGINT", () => {
  stop();
  process.exit(130);
});
try {
  let ready = false;
  while (performance.now() - started < 30000) {
    assert(
      !spawnError && server.exitCode === null && server.signalCode === null,
      "Workerd startup failed",
    );
    try {
      ready = (await request("/health", {}, 500)).poc === "cpsat-deterministic-v1";
    } catch {
      /* Starting. */
    }
    if (ready) break;
    await delay(100);
  }
  assert(ready, "Workerd startup timed out");
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  send({
    kind: "ready",
    runtime: "wasm-workerd",
    localOnly: true,
    clock: "frozen",
    startupMs: performance.now() - started,
    requestWatchdogMs: 35000,
    wasmSha256: hash(await readFile(`${directory}/vendor/cpsat_workers_poc_runtime.wasm`)),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const input = JSON.parse(line);
    if (input.kind === "stop") break;
    assert.equal(input.kind, "solve");
    const model = input.model;
    assert(model.budget > 0 && model.budget <= 0.2);
    const bytes = Buffer.from(input.protoBase64, "base64");
    assert(bytes.length > 0 && bytes.length <= 1048576);
    const begin = performance.now();
    const body = await request(`/solve-model?clock=frozen&deterministicLimit=${model.budget}`, {
      method: "POST",
      body: bytes,
    });
    assert.equal(body.samples.length, 1);
    const result = body.samples[0];
    assert.equal(result.requestedDeterministicLimit, model.budget);
    assert.equal(result.wallTimeLimitEnabled, false);
    assert.equal(result.sharedWasmMemory, false);
    assert(result.frozenClockReads > 0);
    assert(result.wasmMemoryBytes > 0 && result.wasmMemoryBytes <= 96 * 1024 * 1024);
    assert.equal(result.modelVariables, model.variables.length);
    assert(
      ["OPTIMAL", "FEASIBLE", "UNKNOWN"].includes(result.status),
      `Unexpected status: ${result.status}`,
    );
    const found = result.status === "OPTIMAL" || result.status === "FEASIBLE";
    const actual = found ? validateSolution(model, result) : null;
    send({
      ...result,
      validated: found,
      recomputedObjective: actual,
      clientElapsedMs: performance.now() - begin,
      isolateId: body.runtime.isolateId,
    });
  }
} catch (error) {
  send({ error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  stop();
  await delay(250);
  server.kill("SIGKILL");
}
