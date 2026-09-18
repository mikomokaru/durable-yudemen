#!/usr/bin/env node
// Did acceptance return before the solve finished?
//
//   node experiments/cpsat-workers/transport/run-cloud-separation.mjs OUT.json [rounds]
//
// The local driver cannot answer this: a remote binding call does not return
// until the whole invocation ends, waitUntil included. The shim can. It is a
// Worker, its subrequest to the solver returns at response headers, and both
// Workers are billed their own invocation record. So if the shim's invocation
// is short while the solver's is long, the 202 demonstrably came back before
// the solve was done — measured by the platform, not by a frozen clock.
//
// The chain is driven the way the application drives it: an order into the
// store, whose existing Persist Effect calls SOLVER.
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
// 空き時間ごとに 8 件。空き依存なら backoff（流量があれば消える）、
// 無関係な刻みなら位相（消せない）。
const plan = (process.env.CPSAT_INTERVALS ?? "1000,2000,4000,8000,15000")
  .split(",")
  .flatMap((ms) => Array.from({ length: Number(process.env.CPSAT_PER ?? 8) }, () => Number(ms)));
if (!output) throw new Error("Usage: run-cloud-separation.mjs OUT.json [rounds]");

const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
const token = (
  await readFile(resolve(directory, "../fixtures/local/trial-token.txt"), "utf8")
).trim();
if (createHash("sha256").update(token).digest("hex") !== manifest.requestTokenSha256)
  throw new Error("The stored token does not match the deployed manifest.");
if (Date.now() >= manifest.expiresAt) throw new Error("The trial window has already closed.");

const store = manifest.stores.find((entry) => entry.problem === "hard" && entry.series === "shim");
if (!store) throw new Error("No shim/hard store in the manifest.");
const auth = { Authorization: `Bearer ${token}`, Origin: manifest.origin };
const proxy = await getPlatformProxy({
  configPath: resolve(directory, "wrangler.remote-bootstrap.jsonc"),
  experimental: { remoteBindings: true },
});
const report = {
  startedAt: new Date().toISOString(),
  storeId: store.id,
  storeRef: store.ref,
  rounds: [],
};
try {
  for (let round = 0; round < rounds; round += 1) {
    // oxlint-disable-next-line no-await-in-loop
    if (round > 0) await delay(plan[round - 1] ?? 4000);
    const externalOrderId = `separation-${round}-${randomUUID().slice(0, 8)}`;
    const startedAt = Date.now();
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
              tableId: `s${round}`,
              portions: 1,
            },
          ],
        }),
      },
    );
    report.rounds.push({
      round,
      externalOrderId,
      startedAt,
      orderStatus: order.status,
      orderBody: (await order.text()).slice(0, 120),
      orderWallMs: Date.now() - startedAt,
      gapBeforeMs: round > 0 ? (plan[round - 1] ?? 4000) : null,
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
