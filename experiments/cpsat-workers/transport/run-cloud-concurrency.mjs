#!/usr/bin/env node
// Does an independent operation on the same store finish while that store's
// solve is still running?
//
//   node experiments/cpsat-workers/transport/run-cloud-concurrency.mjs OUT.json [rounds]
//
// 2.1 sets the bar: a 202 alone is not separation, and neither is a slow
// callback. So each round fires the hard problem WITHOUT awaiting it — the
// remote binding does not return until the whole invocation ends, waitUntil
// included — then sends an order through the private operations entrance and
// records whether that order came back, and whether the store broadcast the
// change, before the solve's own fetch resolved. Completion alone is not what
// 2.1 asks for: it asks for completion *and* notification.
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { getPlatformProxy } = require("wrangler");
const directory = dirname(fileURLToPath(import.meta.url));
const output = process.argv[2];
const rounds = Number(process.argv[3] ?? 4);
if (!output) throw new Error("Usage: run-cloud-concurrency.mjs OUT.json [rounds]");

const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
const token = (
  await readFile(resolve(directory, "../fixtures/local/trial-token.txt"), "utf8")
).trim();
if (createHash("sha256").update(token).digest("hex") !== manifest.requestTokenSha256)
  throw new Error("The stored token does not match the deployed manifest.");
if (Date.now() >= manifest.expiresAt) throw new Error("The trial window has already closed.");

const problem = manifest.problems.find((entry) => entry.name === "hard");
const store = manifest.stores.find(
  (entry) => entry.problem === "hard" && entry.series === "direct",
);
const auth = { Authorization: `Bearer ${token}`, Origin: manifest.origin };

const proxy = await getPlatformProxy({
  configPath: resolve(directory, "wrangler.remote-bootstrap.jsonc"),
  experimental: { remoteBindings: true },
});
// One subscription for the whole run. The relay is subscription-only, so the
// driver can watch without being able to drive the store through it.
const watch = await proxy.env.CPSAT_TRANSPORT_OPERATIONS.fetch(
  `https://ops.invalid/ops/watch?store=${encodeURIComponent(store.id)}`,
  { headers: { ...auth, Upgrade: "websocket" } },
);
const socket = watch.webSocket;
if (watch.status !== 101 || !socket) throw new Error(`watch refused with ${watch.status}`);
const frames = [];
socket.addEventListener("message", (event) => {
  const text = String(event.data);
  // Only the type and arrival time are kept. Frames carry order contents.
  frames.push({ at: Date.now(), type: JSON.parse(text)?.type ?? "unknown", bytes: text.length });
});
let closeReason = null;
socket.addEventListener("close", (event) => {
  closeReason = { code: event.code, reason: event.reason };
});
socket.accept();

const report = {
  startedAt: new Date().toISOString(),
  storeId: store.id,
  watch: { status: watch.status, framesOnOpen: null },
  rounds: [],
};
try {
  // The store sends config and snapshot on connect. Draining them first keeps
  // those out of the per-round counts.
  await delay(1500);
  report.watch.framesOnOpen = frames.length;
  frames.length = 0;
  for (let round = 0; round < rounds; round += 1) {
    // oxlint-disable-next-line no-await-in-loop
    if (round > 0) await delay(3000);
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
    const t0 = performance.now();
    // Deliberately not awaited: the solve must be in flight while the order goes.
    let solveEndedMs = null;
    const solve = proxy.env.CPSAT_TRANSPORT_PROBE.fetch("https://probe.invalid/plan", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(row),
    }).then(async (response) => {
      solveEndedMs = performance.now() - t0;
      return { status: response.status, body: (await response.text()).slice(0, 120) };
    });

    // Long enough for the solve to have started, short enough to land well
    // inside it: the hard problem's invocations ran 701-4,384 ms.
    // oxlint-disable-next-line no-await-in-loop
    await delay(200);
    const externalOrderId = `concurrency-${round}-${randomUUID().slice(0, 8)}`;
    const orderStarted = performance.now();
    // oxlint-disable-next-line no-await-in-loop
    const order = await proxy.env.CPSAT_TRANSPORT_OPERATIONS.fetch(
      `https://ops.invalid/ops/orders?store=${encodeURIComponent(store.id)}`,
      {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [
            {
              externalOrderId,
              itemIndex: 0,
              noodleType: "probe",
              firmness: "normal",
              tableId: `t${round}`,
              slotSpan: 1,
            },
          ],
        }),
      },
    );
    const orderStatus = order.status;
    const orderBody = (await order.text()).slice(0, 200);
    const orderFinishedMs = performance.now() - t0;
    const orderReturnedAt = Date.now();
    // oxlint-disable-next-line no-await-in-loop
    const solved = await solve;
    const notice = frames.find((frame) => frame.at >= orderReturnedAt - 2000);
    frames.length = 0;
    report.rounds.push({
      round,
      requestId,
      externalOrderId,
      acceptStatus: solved.status,
      acceptBody: solved.body,
      orderStatus,
      orderBody,
      orderSentAtMs: Math.round(orderStarted - t0),
      orderFinishedAtMs: Math.round(orderFinishedMs),
      solveFetchEndedAtMs: Math.round(solveEndedMs),
      // The claim under test. The order must come back, and the store must
      // broadcast it, strictly before the solve's own invocation ends.
      orderFinishedBeforeSolve: orderFinishedMs < solveEndedMs,
      broadcast: notice ? { type: notice.type, afterOrderMs: notice.at - orderReturnedAt } : null,
      broadcastBeforeSolve:
        notice === undefined ? false : notice.at - orderReturnedAt + orderFinishedMs < solveEndedMs,
    });
    if (solved.status !== 202) break;
  }
} finally {
  // Close from this side rather than leaving it to the window: the relay holds
  // the store's socket until both sides confirm.
  try {
    socket.close(1000, "run finished");
  } catch {
    // Already closing; the close event still arrives.
  }
  await delay(500);
  report.watch.close = closeReason;
  await proxy.dispose();
}
report.finishedAt = new Date().toISOString();
const serialized = JSON.stringify(report, null, 2);
if (serialized.includes(token)) throw new Error("Refusing to write a report containing the token");
await writeFile(resolve(output), `${serialized}\n`, { flag: "wx" });
console.log(serialized);
