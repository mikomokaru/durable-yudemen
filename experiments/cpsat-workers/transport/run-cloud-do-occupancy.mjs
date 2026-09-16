#!/usr/bin/env node
// Is the store's own Durable Object occupied while its solve runs, in cloud?
//
//   node experiments/cpsat-workers/transport/run-cloud-do-occupancy.mjs OUT.json [rounds]
//
// `store-timer-do.ts:1213` states the intent plainly: the RequestPlan effect
// awaits the 202 receipt and "計算完了は待たない". Locally that does not hold —
// the caller is released only when the child's synchronous work ends. This
// settles it on the real platform, for the arrangement the application uses:
// the store DO itself issues the request from its Persist effect.
//
// The probe has to be an operation that does NOT itself request a plan, or it
// would queue behind its own solve and measure nothing. A WebSocket connect to
// an already-warm object is that operation: no state transition, no effect.
// (On a cold object the constructor's Reconcile can emit one, so the object is
// warmed first and the baseline is taken from the warm state.)
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
const rounds = Number(process.argv[3] ?? 3);
if (!output) throw new Error("Usage: run-cloud-do-occupancy.mjs OUT.json [rounds]");

const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
const token = (
  await readFile(resolve(directory, "../fixtures/local/trial-token.txt"), "utf8")
).trim();
if (createHash("sha256").update(token).digest("hex") !== manifest.requestTokenSha256)
  throw new Error("The stored token does not match the deployed manifest.");
if (Date.now() >= manifest.expiresAt) throw new Error("The trial window has already closed.");

// The shim series: an order here makes the store's own effect reach the shim,
// which substitutes the fixed hard problem. The direct series bypasses the DO.
const store = manifest.stores.find((s) => s.series === "shim" && s.problem === "hard");
if (!store) throw new Error("No shim/hard store in the manifest.");
const auth = { Authorization: `Bearer ${token}`, Origin: manifest.origin };
const proxy = await getPlatformProxy({
  configPath: resolve(directory, "wrangler.remote-bootstrap.jsonc"),
  experimental: { remoteBindings: true },
});

const ops = (path) =>
  `https://ops.invalid${path}${path.includes("?") ? "&" : "?"}store=${encodeURIComponent(store.id)}`;

/** One WebSocket connect, timed, then closed. Never left open. */
async function probeConnect() {
  const started = Date.now();
  const response = await proxy.env.CPSAT_TRANSPORT_OPERATIONS.fetch(ops("/ops/watch"), {
    headers: { ...auth, Upgrade: "websocket" },
  });
  const socket = response.webSocket;
  const upgradedMs = Date.now() - started;
  if (response.status !== 101 || !socket)
    return { status: response.status, upgradedMs, firstFrameMs: null };
  let firstFrameAt = null;
  socket.addEventListener("message", () => {
    firstFrameAt ??= Date.now();
  });
  socket.accept();
  // The store sends config/snapshot on connect; the first frame is the object
  // actually doing work for this caller, which is the thing being timed.
  for (let i = 0; i < 60 && firstFrameAt === null; i += 1) await delay(50);
  try {
    socket.close(1000, "probe done");
  } catch {
    /* already closing */
  }
  return {
    status: response.status,
    upgradedMs,
    firstFrameMs: firstFrameAt === null ? null : firstFrameAt - started,
  };
}

async function sendOrder(tag) {
  const externalOrderId = `occupancy-${tag}-${randomUUID().slice(0, 8)}`;
  const started = Date.now();
  const response = await proxy.env.CPSAT_TRANSPORT_OPERATIONS.fetch(ops("/ops/orders"), {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      items: [
        {
          externalOrderId,
          itemIndex: 0,
          noodleType: "probe",
          firmness: "normal",
          tableId: tag,
          slotSpan: 1,
        },
      ],
    }),
  });
  const body = (await response.text()).slice(0, 120);
  return {
    externalOrderId,
    status: response.status,
    body,
    startedAt: started,
    wallMs: Date.now() - started,
  };
}

const report = {
  startedAt: new Date().toISOString(),
  storeId: store.id,
  storeRef: store.ref,
  window: { notBefore: manifest.notBefore, expiresAt: manifest.expiresAt },
  rounds: [],
};
try {
  // Warm the object, then take the baseline from the warm state.
  await probeConnect();
  for (let round = 0; round < rounds; round += 1) {
    if (round > 0) await delay(8000);
    const idle = [await probeConnect(), await probeConnect()];
    const orderStart = Date.now();
    // Not awaited: the solve must be in flight while the probe connects.
    const order = sendOrder(`r${round}`);
    // **固定の遅延では求解に当たらない。** Queue の配送遅延は実測 1,271〜4,922 ms と
    // ばらつき、求解自体は 0.7〜2.2 秒しか続かない。1 回だけ狙って撃つと、配送待ちの
    // 最中か求解の後を測ってしまう（実際に 118 ms 差で外した）。
    //
    // ゆえに**複数のオフセットで撃ち、あとで重なった分だけを評価する**。重なりが
    // 確認できない probe は判定に使わない——成功にも失敗にも数えない。
    const offsets = (process.env.CPSAT_PROBE_OFFSETS_MS ?? "1500,2500,3500,4500,5500,6500")
      .split(",")
      .map(Number);
    const probes = [];
    let previous = 0;
    for (const offset of offsets) {
      // oxlint-disable-next-line no-await-in-loop
      await delay(Math.max(0, offset - previous));
      previous = offset;
      const sentAt = Date.now();
      // oxlint-disable-next-line no-await-in-loop
      const result = await probeConnect();
      probes.push({ offsetMs: offset, sentAt, finishedAt: Date.now(), ...result });
      previous = Date.now() - orderStart;
    }
    const settled = await order;
    report.rounds.push({
      round,
      idle,
      // 送出・完了の実時刻を残す。重なりの判定は収集後に求解区間と突き合わせる。
      probes: probes.map((probe) => ({
        offsetMs: probe.offsetMs,
        sentAfterOrderMs: probe.sentAt - orderStart,
        finishedAfterOrderMs: probe.finishedAt - orderStart,
        status: probe.status,
        firstFrameMs: probe.firstFrameMs,
      })),
      order: settled,
      orderFinishedAfterMs: settled.startedAt - orderStart + settled.wallMs,
    });
  }
} finally {
  await proxy.dispose();
}
report.finishedAt = new Date().toISOString();
const serialized = JSON.stringify(report, null, 2);
if (serialized.includes(token)) throw new Error("Refusing to write a report containing the token");
await writeFile(resolve(output), `${serialized}\n`, { flag: "wx" });
console.log(serialized);
