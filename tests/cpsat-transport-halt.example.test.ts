import { readFile } from "node:fs/promises";
import { parseConfigFileTextToJson } from "typescript";
import { expect, it } from "vitest";
import { isRecord } from "../src/domain/predicate";
import haltWorker from "../experiments/cpsat-workers/transport/halt";

const DIRECTORY = "experiments/cpsat-workers/transport";
const CONFIGS = [
  ["wrangler.halt-shim.jsonc", "yude-men-cpsat-transport-shim-dev"],
  ["wrangler.halt-planner.jsonc", "yude-men-cpsat-planner-dev"],
] as const;

it("the stop version refuses everything and depends on nothing", async () => {
  const handler = haltWorker;
  if (!handler.fetch) throw new Error("No fetch handler");
  // Not a proof of input-independence on its own — a function can ignore its
  // declared parameters and still read globals. What the guarantee rests on is
  // the hashed source returning only 503, checked together with the config and
  // the absence of imports below. The arity is recorded because a signature
  // that grows is a signal the source changed shape.
  expect(handler.fetch.length).toBe(0);
  const response = await handler.fetch();
  expect(response.status).toBe(503);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.text()).toBe("");

  // The source reaches nothing: no bindings to read, nothing to import.
  const source = await readFile(`${DIRECTORY}/halt.ts`, "utf8");
  expect(source).not.toMatch(/^\s*import\s/m);
  expect(source).not.toMatch(/env\./);
});

it.each(CONFIGS)("%s deploys the stop source with no way out", async (file, name) => {
  const path = `${DIRECTORY}/${file}`;
  const parsed = parseConfigFileTextToJson(path, await readFile(path, "utf8"));
  expect(parsed.error).toBeUndefined();
  const config: unknown = parsed.config;
  if (!isRecord(config)) throw new Error("Malformed config");

  // Deployed over the trial Worker itself, which is what "off" means for a
  // Worker with no earlier version to roll back to.
  expect(config.name).toBe(name);
  // Resolved relative to the config, which is how wrangler reads it.
  expect(config.main).toBe("./halt.ts");
  expect(config.workers_dev).toBe(false);
  expect(config.preview_urls).toBe(false);
  // Nothing to solve with, forward to, or call back into.
  for (const key of [
    "services",
    "durable_objects",
    "vars",
    "kv_namespaces",
    "r2_buckets",
    "routes",
    "route",
    "rules",
    "limits",
  ])
    expect(config).not.toHaveProperty(key);
});
