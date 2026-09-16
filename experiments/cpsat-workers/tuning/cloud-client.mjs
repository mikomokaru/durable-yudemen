import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { validateSolution } from "./validate-solution.mjs";

export const cloudOrigin = "https://yude-men-cpsat-search.yamaokaya.workers.dev";
export const localOrigin = "http://127.0.0.1:8793";
export const wasmSha256 = "c8b89a734a15ad067e18edd08fc58d179aff63bf9922080e75fbeeecfb0223a1";
const protocol = "cpsat-search-v1";

export class CloudSolver {
  #token;
  constructor(origin, token, versionId) {
    assert(
      origin === cloudOrigin || origin === localOrigin,
      "Only the isolated search Worker is allowed",
    );
    assert(/^[a-f0-9]{64}$/.test(token));
    this.origin = origin;
    this.#token = token;
    this.versionId = versionId;
  }

  async request(path, options = {}, auth = true) {
    const started = performance.now();
    const response = await fetch(`${this.origin}${path}`, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(35000),
      headers: { ...(auth ? { authorization: `Bearer ${this.#token}` } : {}), ...options.headers },
    });
    assert(response.body, "Missing response body");
    const reader = response.body.getReader();
    const parts = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 2097152) {
        await reader.cancel();
        throw new Error("Worker response exceeds 2 MiB");
      }
      parts.push(chunk.value);
    }
    const raw = Buffer.concat(parts).toString("utf8");
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = { nonJson: true, platformErrorCode: /error code:\s*(\d+)/i.exec(raw)?.[1] ?? null };
    }
    return {
      status: response.status,
      body,
      elapsedMs: performance.now() - started,
      cfRay: response.headers.get("cf-ray"),
    };
  }

  async connect() {
    const r = await this.request("/health");
    assert.equal(r.status, 200, `Search Worker health HTTP ${r.status}`);
    assert.equal(r.body.protocol, protocol);
    assert.equal(r.body.wasmSha256, wasmSha256);
    assert.equal(r.body.clock, "frozen");
    assert.equal(r.body.searchWorkers, 1);
    assert.equal(r.body.cpuLimitMs, 10000);
    if (this.versionId)
      assert.equal(r.body.versionId, this.versionId, "Unexpected Worker deployment");
    this.versionId = r.body.versionId;
    assert(this.versionId);
    this.ready = {
      kind: "ready",
      runtime: this.origin === cloudOrigin ? "wasm-cloud" : "wasm-search-local",
      origin: this.origin,
      versionId: this.versionId,
      wasmSha256,
      clock: "frozen",
      cpuLimitMs: 10000,
      expiresAt: r.body.expiresAt,
      healthElapsedMs: r.elapsedMs,
      cfRay: r.cfRay,
    };
    return this;
  }

  async solve(model, protoBase64) {
    assert(model.budget > 0 && model.budget <= 0.2);
    const bytes = Buffer.from(protoBase64, "base64");
    assert(bytes.length && bytes.length <= 1048576);
    const requestId = randomUUID();
    // No automatic retries: a transport failure cannot quietly duplicate cost
    // or turn an incomplete replay into a successful parameter evaluation.
    const r = await this.request(`/solve-model?deterministicLimit=${model.budget}`, {
      method: "POST",
      body: bytes,
      headers: { "content-type": "application/octet-stream", "x-cpsat-request-id": requestId },
    });
    assert.equal(
      r.status,
      200,
      `Search Worker solve HTTP ${r.status}, platform ${r.body.platformErrorCode ?? "unknown"}, ray ${r.cfRay}, request ${requestId}`,
    );
    assert.equal(r.body.requestId, requestId);
    assert.equal(r.body.protocol, protocol);
    assert.equal(r.body.wasmSha256, wasmSha256);
    assert.equal(r.body.versionId, this.versionId, "Deployment changed during replay");
    assert.equal(r.body.searchWorkers, 1);
    assert.equal(r.body.samples.length, 1);
    const result = r.body.samples[0];
    assert.equal(result.requestedDeterministicLimit, model.budget);
    assert.equal(result.wallTimeLimitEnabled, false);
    assert.equal(result.sharedWasmMemory, false);
    assert.equal(result.clockMode, "frozen");
    assert(result.frozenClockReads > 0 && result.wasmMemoryBytes <= 96 * 1024 * 1024);
    assert.equal(result.modelVariables, model.variables.length);
    assert(
      ["OPTIMAL", "FEASIBLE", "UNKNOWN"].includes(result.status),
      `Unexpected ${result.status}`,
    );
    const found = result.status !== "UNKNOWN";
    const actual = found ? validateSolution(model, result) : null;
    return {
      ...result,
      validated: found,
      recomputedObjective: actual,
      clientElapsedMs: r.elapsedMs,
      cfRay: r.cfRay,
      requestId,
      isolateId: r.body.isolateId,
      versionId: this.versionId,
    };
  }
}

export async function connectSolver({ local = false, versionId } = {}) {
  const secrets = JSON.parse(
    await readFile("experiments/cpsat-workers/fixtures/local/search-secrets.json", "utf8"),
  );
  return new CloudSolver(
    local ? localOrigin : cloudOrigin,
    secrets.SEARCH_AUTH_TOKEN,
    versionId,
  ).connect();
}
