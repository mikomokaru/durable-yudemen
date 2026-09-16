#!/usr/bin/env node
// One small problem and one hard problem, acceptance through callback, in cloud.
//
//   node experiments/cpsat-workers/transport/run-cloud-trial.mjs OUT.json
//
// Direct probe only: driver → remote binding → the app's trial entrance →
// the solver → callback into the real Durable Object. The shim is untouched,
// so the live plan traffic flowing through it is not disturbed.
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { getPlatformProxy } = require("wrangler");
const directory = dirname(fileURLToPath(import.meta.url));
const output = process.argv[2];
if (!output) throw new Error("Usage: run-cloud-trial.mjs OUT.json");

const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
const token = (
  await readFile(resolve(directory, "../fixtures/local/trial-token.txt"), "utf8")
).trim();
if (createHash("sha256").update(token).digest("hex") !== manifest.requestTokenSha256)
  throw new Error("The stored token does not match the deployed manifest.");
if (Date.now() >= manifest.expiresAt) throw new Error("The trial window has already closed.");

const proxy = await getPlatformProxy({
  configPath: resolve(directory, "wrangler.remote-bootstrap.jsonc"),
  experimental: { remoteBindings: true },
});
const report = {
  startedAt: new Date().toISOString(),
  window: { notBefore: manifest.notBefore, expiresAt: manifest.expiresAt },
  runs: [],
};
try {
  // Serial by intent: check the small problem's callback before sending the
  // hard one, so a failure stops at one send rather than two.
  for (const problem of manifest.problems) {
    const store = manifest.stores.find((s) => s.problem === problem.name && s.series === "direct");
    const requestId = randomUUID();
    const row = {
      schemaVersion: 1,
      eventId: randomUUID(),
      // Slightly in the past: the entrance rejects a row stamped after its own
      // clock, and the two clocks are not the same one.
      at: Date.now() - 30_000,
      storeRef: store.ref,
      backend: "cpsat",
      mode: "probe",
      instanceId: randomUUID(),
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
        requestId,
        origin: { kind: "probe" },
        sameInputRetry: false,
      },
    };
    const started = performance.now();
    const response = await proxy.env.CPSAT_TRANSPORT_PROBE.fetch("https://probe.invalid/plan", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: manifest.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(row),
    });
    const acceptedMs = performance.now() - started;
    const body = await response.text();
    report.runs.push({
      problem: problem.name,
      storeId: store.id,
      requestId,
      acceptStatus: response.status,
      acceptWallMs: Math.round(acceptedMs),
      body: body.slice(0, 200),
    });
    if (response.status !== 202) break;
  }
} finally {
  await proxy.dispose();
}
report.finishedAt = new Date().toISOString();
const serialized = JSON.stringify(report, null, 2);
if (serialized.includes(token)) throw new Error("Refusing to write a report containing the token");
await writeFile(resolve(output), `${serialized}\n`, { flag: "wx" });
console.log(serialized);
