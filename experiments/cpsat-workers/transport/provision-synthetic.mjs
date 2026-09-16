#!/usr/bin/env node
// Deployment sequence step 5: create the trial's synthetic chain and stores.
//
//   ADMIN_TOKEN=... node experiments/cpsat-workers/transport/provision-synthetic.mjs OUT.json
//   ADMIN_TOKEN=... node ... OUT.json --create      # without --create, checks only
//
// Runs against the real Provisioning API on the confirmed target. The default
// is a check: it reports whether each id is free and writes nothing. Creation
// needs --create, and stops at the first id that already exists rather than
// overwriting it — an occupied id means the target is not what the plan
// recorded, and continuing would edit someone else's store.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const BASE = "https://timer-dev.yamaokaya.org";
const CHAIN = "cpsat-transport-20260909";
const STORES = ["01", "02", "03", "04"].map((suffix) => `${CHAIN}-${suffix}`);
const output = process.argv[2];
const create = process.argv.includes("--create");
if (!output || process.argv.length > 4)
  throw new Error("Usage: provision-synthetic.mjs OUT.json [--create]");
const token = process.env.ADMIN_TOKEN;
if (!token) throw new Error("ADMIN_TOKEN is not set.");

const call = async (path, init = {}) => {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const text = await response.text();
  return { status: response.status, ok: response.ok, text: text.slice(0, 400) };
};

const report = {
  checkedAt: new Date().toISOString(),
  base: BASE,
  chain: CHAIN,
  created: create,
  checks: [],
  writes: [],
};

// Free means "not found". Anything else — an existing record, or an error that
// leaves it unknown — stops the run.
for (const id of [CHAIN, ...STORES]) {
  const path = id === CHAIN ? `/admin/chains/${id}` : `/admin/stores/${id}`;
  // oxlint-disable-next-line no-await-in-loop
  const found = await call(path);
  // A refused credential is not an occupied id. Reporting one as the other
  // sends someone to re-confirm the target when the token was simply wrong —
  // and the local .dev.vars value is not the deployed secret.
  if (found.status === 401 || found.status === 403) {
    report.checks.push({ id, status: found.status, free: null, reason: "unauthorized" });
    throw new Error(
      `Provisioning API refused the credential with ${found.status}. ADMIN_TOKEN does not match the deployed secret for ${BASE}; nothing was read or written.`,
    );
  }
  const free = found.status === 404;
  report.checks.push({ id, status: found.status, free });
  if (!free)
    throw new Error(
      `${id} is not free (${found.status}). Not overwriting. The target differs from the recorded plan; re-confirm before continuing.`,
    );
}
if (!create) {
  await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ report: resolve(output), allFree: true, created: false }, null, 2));
  process.exit(0);
}

const chain = await call(`/admin/chains/${CHAIN}`, {
  method: "PUT",
  body: JSON.stringify({ name: "cpsat transport trial", chainRoster: [] }),
});
report.writes.push({ id: CHAIN, status: chain.status });
if (!chain.ok) throw new Error(`Chain creation failed with ${chain.status}: ${chain.text}`);

for (const id of STORES) {
  // oxlint-disable-next-line no-await-in-loop
  const store = await call("/admin/stores", {
    method: "POST",
    body: JSON.stringify({
      storeId: id,
      chainId: CHAIN,
      name: "cpsat transport synthetic",
      storeRoster: ["transport@invalid.example"],
      override: {
        noodlePresets: [
          { noodleType: "probe", boilSeconds: { extraHard: 45, hard: 52, normal: 60, soft: 75 } },
        ],
      },
    }),
  });
  report.writes.push({ id, status: store.status });
  if (!store.ok) throw new Error(`Store ${id} failed with ${store.status}: ${store.text}`);
}

const serialized = JSON.stringify(report, null, 2);
if (serialized.includes(token)) throw new Error("Refusing to write a report containing the token");
await writeFile(resolve(output), `${serialized}\n`, { flag: "wx" });
console.log(
  JSON.stringify({ report: resolve(output), created: true, stores: STORES.length }, null, 2),
);
