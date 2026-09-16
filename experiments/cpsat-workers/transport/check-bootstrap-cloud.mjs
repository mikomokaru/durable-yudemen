// Explicit cloud command, never imported by pnpm test. No browser listener,
// application operations, arbitrary URL, model input or public-URL fallback.
import assert from "node:assert/strict";
import { readFile, writeFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPlatformProxy } from "wrangler";
import { TrialLedger } from "./ledger.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const output = process.argv[2];
const shim = process.argv[3] === "shim";
// **求解 Worker への直接 binding は 2026-09-12 に外した**（design 第9節・Queue 方式）。
// この script の非 shim 経路はその binding を叩くもので、旧手順の検証物である。黙って
// 失敗させず、ここで理由を添えて止める——動かないことと、動かすべきでないことは違う。
if (!shim) {
  throw new Error(
    [
      "The non-shim mode reached the solver through a direct binding, which no longer exists.",
      "CP-SAT is reachable only through the queue now; drive the shim (`shim` argument) or",
      "the trial driver instead. This path is kept as a record of the superseded procedure.",
    ].join(" "),
  );
}
assert.ok(
  output && (process.argv.length === 3 || (process.argv.length === 4 && shim)),
  "Usage: check-bootstrap-cloud.mjs NEW_REPORT.json [shim]",
);
await assert.rejects(access(resolve(output)), { code: "ENOENT" });
const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
assert.equal(manifest.enabled, false);
assert.equal(manifest.notBefore, 0);
assert.equal(manifest.expiresAt, 0);
// Reuse this journal on EVERY bootstrap invocation, not a fresh trial per run.
// Its spent total must be subtracted from the later active trial's 128 sends.
const journal = resolve(directory, "../../../.wrangler/cpsat-bootstrap/dispatch.journal");
const ledger = await TrialLedger.open(journal, manifest, {
  dispatch: 128,
  operation: 512,
  connection: 32,
  concurrent: 4,
  openConnections: 4,
});
let proxy;
const report = {
  startedAt: new Date().toISOString(),
  phase: shim ? "ts-only-shim-bootstrap" : "disabled-planner-bootstrap",
  worker: shim ? "yude-men-cpsat-transport-shim-dev" : "yude-men-cpsat-planner-dev",
  path: "/plan",
  method: shim ? "POST" : "GET",
  expectedStatus: shim ? 400 : 503,
  route: "Wrangler getPlatformProxy, remote service binding; no public URL",
  request: null,
  ledger: null,
  error: null,
  claim: shim
    ? "Empty storeId passes shim routing and is refused by TS before solve/callback; not a valid plan or app request"
    : "Disabled-entry refusal only; not Wasm execution, callback or acceptance/solve separation",
};
try {
  proxy = await getPlatformProxy({
    configPath: resolve(directory, "wrangler.remote-bootstrap.jsonc"),
    envFiles: [],
    persist: false,
    remoteBindings: true,
  });
  // Empty storeId is rejected by TS before planning; never names a real store.
  // Charge an operation conservatively, without a CP send allowance.
  const reservation = shim
    ? await ledger.reserve("operation", 0)
    : await ledger.reserve("dispatch");
  const started = Date.now();
  let status = null;
  try {
    const response = await proxy.env.SOLVER.fetch("https://solver.invalid/plan", {
      method: report.method,
      ...(shim ? { headers: { "Content-Type": "application/json" }, body: '{"storeId":""}' } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    status = response.status;
    if (shim) {
      const reader = response.body?.getReader();
      assert.ok(reader);
      let bytes = 0;
      let body = "";
      const decoder = new TextDecoder();
      try {
        while (true) {
          // Bounded streaming read; do not retain or print unexpected content.
          // oxlint-disable-next-line no-await-in-loop
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          assert.ok(bytes <= 64);
          body += decoder.decode(chunk.value, { stream: true });
        }
        assert.equal(body + decoder.decode(), "Malformed request");
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    } else await response.body?.cancel();
  } finally {
    report.request = { reservation, started, returnedAt: Date.now(), status };
    await ledger.settle(reservation, status === null ? "failed" : String(status));
  }
  assert.equal(status, report.expectedStatus);
} catch {
  // No raw exception: a proxy error can contain authentication material.
  report.error = "bootstrap-failed; inspect sanitized control-plane state before retrying";
  process.exitCode = 1;
} finally {
  try {
    await proxy?.dispose();
  } finally {
    report.ledger = ledger.totals;
    await ledger.close();
    await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  }
}
console.log(JSON.stringify(report));
