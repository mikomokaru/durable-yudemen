import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseConfigFileTextToJson } from "typescript";
import { expect, it } from "vitest";
import { isRecord } from "../../src/domain/predicate";

const directory = "experiments/cpsat-workers/transport";

it.each([
  ["planner", "yude-men-cpsat-planner-dev", "./solver.ts"],
  ["shim", "yude-men-cpsat-transport-shim-dev", "./shim.ts"],
])("%s bootstrap is private and cannot add application resources", async (kind, name, main) => {
  const path = `${directory}/wrangler.bootstrap-${kind}.jsonc`;
  const parsed = parseConfigFileTextToJson(path, await readFile(path, "utf8"));
  expect(parsed.error).toBeUndefined();
  const config: unknown = parsed.config;
  if (!isRecord(config)) throw new Error("Invalid bootstrap config");
  expect(config.account_id).toBe("305d89a643ac689b4204454c5493cbde");
  expect(config.name).toBe(name);
  expect(config.main).toBe(main);
  expect(config.workers_dev).toBe(false);
  expect(config.preview_urls).toBe(false);
  expect(config.routes).toEqual([]);
  expect(config.compatibility_date).toBe("2026-09-09");
  expect(config.compatibility_flags).toEqual(["no_nodejs_compat", "no_nodejs_compat_v2"]);
  expect(config.observability).toEqual({
    enabled: true,
    head_sampling_rate: 1,
    logs: { enabled: true, invocation_logs: true, persist: true },
  });
  for (const field of ["migrations", "assets", "vars", "build", "alias", "define", "route"])
    expect(config).not.toHaveProperty(field);
  if (kind === "planner") {
    expect(config.limits).toEqual({ cpu_ms: 10000 });
    expect(config).not.toHaveProperty("services");
    expect(config.durable_objects).toEqual({
      bindings: [
        {
          name: "STORE_TIMER_DO",
          class_name: "StoreTimerDO",
          script_name: "yude-men-timer",
        },
      ],
    });
  } else {
    expect(config).not.toHaveProperty("durable_objects");
    expect(config.services).toEqual([{ binding: "SOLVER", service: "yude-men-solver" }]);
  }
});

it("bootstrap uses the inert manifest and unchanged fixed binary, not an enabled trial", async () => {
  const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, "utf8"));
  expect(manifest.enabled).toBe(false);
  expect(manifest.notBefore).toBe(0);
  expect(manifest.expiresAt).toBe(0);
  expect(manifest.requestTokenSha256).toBe("");
  await Promise.all(
    [
      ["../vendor/cpsat_workers_poc_runtime.wasm", manifest.wasm],
      ["../vendor/cpsat_workers_poc_runtime.js", manifest.glue],
      ["fixtures.json", "2a57e18be75b668f8fd5100210311f411d1f70f6d3c5f769d7b5ff9547574045"],
    ].map(async ([name, expected]) => {
      const bytes = await readFile(`${directory}/${name}`);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected);
    }),
  );
});
