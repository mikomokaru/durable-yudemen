#!/usr/bin/env node
// Repeated solves of the hard problem, one after another, in cloud.
//
//   node experiments/cpsat-workers/transport/run-cloud-repeat.mjs OUT.json [count]
//
// Serial by intent: the question is whether the same isolate keeps solving
// correctly, so overlapping runs would confuse reuse with concurrency. Stops at
// the first refusal rather than pressing on.
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { getPlatformProxy } = require("wrangler");
const directory = dirname(fileURLToPath(import.meta.url));
const output = process.argv[2];
const count = Number(process.argv[3] ?? 20);
// The solver takes one solve at a time and refuses the rest with 429. Pacing is
// the driver waiting its turn, not a retry: a refusal is still recorded as one.
const paceMs = Number(process.argv[4] ?? 3000);
if (!output || !Number.isInteger(count) || count < 1 || count > 40)
  throw new Error("Usage: run-cloud-repeat.mjs OUT.json [count 1..40]");

const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
const token = (
  await readFile(resolve(directory, "../fixtures/local/trial-token.txt"), "utf8")
).trim();
if (createHash("sha256").update(token).digest("hex") !== manifest.requestTokenSha256)
  throw new Error("The stored token does not match the deployed manifest.");
if (Date.now() >= manifest.expiresAt) throw new Error("The trial window has already closed.");

const problem = manifest.problems.find((p) => p.name === "hard");
const store = manifest.stores.find((s) => s.problem === "hard" && s.series === "direct");
const proxy = await getPlatformProxy({
  configPath: resolve(directory, "wrangler.remote-bootstrap.jsonc"),
  experimental: { remoteBindings: true },
});
const report = {
  startedAt: new Date().toISOString(),
  problem: problem.name,
  requested: count,
  runs: [],
};
try {
  for (let index = 0; index < count; index += 1) {
    const requestId = randomUUID();
    const row = {
      schemaVersion: 1,
      eventId: randomUUID(),
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
    // oxlint-disable-next-line no-await-in-loop
    if (index > 0) await delay(paceMs);
    const started = performance.now();
    // oxlint-disable-next-line no-await-in-loop
    const response = await proxy.env.CPSAT_TRANSPORT_PROBE.fetch("https://probe.invalid/plan", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: manifest.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(row),
    });
    // oxlint-disable-next-line no-await-in-loop
    await response.text();
    report.runs.push({
      index,
      requestId,
      status: response.status,
      wallMs: Math.round(performance.now() - started),
    });
    // A refusal is recorded and ends the run; the point is whether repeated
    // solving stays correct, not how many refusals can be collected.
    if (response.status !== 202) break;
  }
} finally {
  await proxy.dispose();
}
report.finishedAt = new Date().toISOString();
report.accepted = report.runs.filter((r) => r.status === 202).length;
const serialized = JSON.stringify(report, null, 2);
if (serialized.includes(token)) throw new Error("Refusing to write a report containing the token");
await writeFile(resolve(output), `${serialized}\n`, { flag: "wx" });
const walls = report.runs.map((r) => r.wallMs).sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      accepted: report.accepted,
      requested: count,
      statuses: [...new Set(report.runs.map((r) => r.status))],
      wallMs: {
        min: walls[0],
        p50: walls[Math.floor(walls.length / 2)],
        max: walls[walls.length - 1],
      },
    },
    null,
    2,
  ),
);
