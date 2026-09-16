import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { getPlatformProxy } = require("wrangler");

// Reachability only. The trial manifest is disabled, so the entrance refuses at
// its first check and returns 503 without touching a store or the solver. A 503
// therefore proves the binding resolved and the call arrived; a binding failure
// would look different, which is what makes the two distinguishable.
const proxy = await getPlatformProxy({
  configPath: "experiments/cpsat-workers/transport/wrangler.remote-bootstrap.jsonc",
  experimental: { remoteBindings: true },
});
const report = { checkedAt: new Date().toISOString(), calls: [] };
try {
  for (const [name, url] of [
    ["CPSAT_TRANSPORT_PROBE", "https://probe.invalid/plan"],
    [
      "CPSAT_TRANSPORT_OPERATIONS",
      "https://probe.invalid/ops/orders?store=cpsat-transport-20260909-03",
    ],
  ]) {
    const binding = proxy.env[name];
    try {
      const response = await binding.fetch(url, { method: "POST", body: "{}" });
      report.calls.push({ name, reached: true, status: response.status });
      await response.text();
    } catch (error) {
      report.calls.push({
        name,
        reached: false,
        error: String(error?.message ?? error).slice(0, 200),
      });
    }
  }
} finally {
  await proxy.dispose();
}
console.log(JSON.stringify(report, null, 1));
