import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  formulate,
  type History,
  type Placement,
  type ModelShape,
} from "../experiments/cpsat-workers/tuning/schedule";
import defaults from "../experiments/cpsat-workers/tuning/defaults.json";
import { encodeModel } from "../src/cpsat/protobuf";
import type { SolverResult } from "../experiments/cpsat-workers/src/runtime";

// Run the actual formulation and protobuf through the pinned, frozen-clock WASM.
// Fixing every supplied hint makes recovery by the solver unable to hide a bad hint.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { build } = wranglerRequire("esbuild");
const { Miniflare, Log, LogLevel } = wranglerRequire("miniflare");
let scratch: string;
let mf: InstanceType<typeof Miniflare>;

beforeAll(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "cpsat-hint-test-"));
  const built = await build({
    stdin: {
      contents: `import { runtime, solve } from "./experiments/cpsat-workers/src/runtime";
        export default { async fetch(request) {
          const loaded = await runtime("frozen");
          const bytes = new Uint8Array(await request.arrayBuffer());
          return Response.json(solve(loaded.value, "model", 1, bytes));
        } };`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["*.wasm"],
  });
  mf = new Miniflare({
    port: 0,
    cf: false,
    log: new Log(LogLevel.ERROR),
    modulesRoot: scratch,
    compatibilityDate: "2026-06-26",
    modules: [
      {
        type: "ESModule",
        path: resolve(scratch, "app/entry.js"),
        contents: built.outputFiles[0].text,
      },
      {
        type: "CompiledWasm",
        path: resolve(scratch, "vendor/cpsat_workers_poc_runtime.wasm"),
        contents: await readFile("experiments/cpsat-workers/vendor/cpsat_workers_poc_runtime.wasm"),
      },
    ],
  });
  await mf.ready;
});

afterAll(async () => {
  await mf?.dispose();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

function scene(ends: readonly number[], boilSeconds: number, slotSpan = 1, shape: ModelShape = {}) {
  const running: Placement[] = ends.map((end, slot) => ({
    id: `running:${slot}`,
    order: `running:${slot}`,
    purchasedAt: 0,
    boilSeconds: end,
    slotSpan: 1,
    start: 0,
    end,
    slots: [slot],
  }));
  const pending = { id: "pending", order: "pending", purchasedAt: 0, boilSeconds, slotSpan };
  const history: History = {
    id: "future-lift",
    items: [...running, pending],
    coordinates: Array.from({ length: 12 }, (_, slot) => ({
      x: slot % 6,
      y: Math.floor(slot / 6),
    })),
    arms: 2,
    liftWindow: 45,
    tolerancePercent: 0,
  };
  return formulate(history, 8, history.items, running, new Map(), [], defaults, [], {
    ...shape,
    fixHints: true,
  });
}

async function fixedStatus(built: ReturnType<typeof formulate>) {
  const response = await mf.dispatchFetch("https://hint.invalid", {
    method: "POST",
    body: encodeModel(built.model),
  });
  const result = (await response.json()) as SolverResult;
  expect(result.status).not.toBe("MODEL_INVALID");
  return result.status;
}

it.each([undefined, true])(
  "rejects an ineffective soft-cap switch with cumulativeLift=%s",
  (cumulativeLift) => {
    expect(() =>
      scene([], 270, 1, {
        hardLiftCap: false,
        ...(cumulativeLift === undefined ? {} : { cumulativeLift }),
      }),
    ).toThrow(/hardLiftCap: false requires cumulativeLift: false/);
  },
);

it("rejects the pairwise lift model when its generating loop is disabled", () => {
  expect(() => scene([], 270, 1, { cumulativeLift: false })).toThrow(
    /cumulativeLift: false requires leanPairs: false/,
  );
});

it.each([false, true])(
  "actually changes the legacy lift constraint with hardLiftCap=%s",
  async (hardLiftCap) => {
    const built = scene([300, 300, 300, 300], 270, 1, {
      hardLiftCap,
      cumulativeLift: false,
      leanPairs: false,
      seed: new Map([["pending", { start: 8, end: 278, slots: [4] }]]),
    });
    const status = await fixedStatus(built);
    if (hardLiftCap) expect(status).toBe("INFEASIBLE");
    else expect(status).toMatch(/^(FEASIBLE|OPTIMAL)$/);
  },
);

it.each([{ ends: [] }, { ends: [300] }])(
  "does not return a hint after failing to fit its lift demand ($ends)",
  ({ ends }) => {
    expect(() => scene(ends, 270, 3)).toThrow(/Greedy hint cannot fit lift demand/);
  },
);

it("does not put a lift just before an already full future lifting window", async () => {
  const built = scene([300, 300, 300, 300], 270);
  expect(await fixedStatus(built)).toMatch(/^(FEASIBLE|OPTIMAL)$/);
  const pending = built.hints.at(-1)!;
  expect(pending.end <= 255 || pending.end >= 345).toBe(true);
});

it("can use an idle pot early when its lift is outside the running lifting window", async () => {
  const built = scene([300, 300, 300, 300], 200);
  expect(await fixedStatus(built)).toMatch(/^(FEASIBLE|OPTIMAL)$/);
  expect(built.hints.at(-1)!.end).toBe(208);
});

it("handles staggered future lifts and two-pot demand", async () => {
  const built = scene([300, 315, 330], 270, 2);
  expect(await fixedStatus(built)).toMatch(/^(FEASIBLE|OPTIMAL)$/);
});

it("accounts for fixed lifts when hinting who needs assistance", async () => {
  const built = scene([300, 300], 270, 1, {
    seed: new Map([["pending", { start: 20, end: 290, slots: [2] }]]),
  });
  expect(await fixedStatus(built)).toMatch(/^(FEASIBLE|OPTIMAL)$/);
  expect(built.hints.at(-1)!.end).toBe(290);
});

it("still rejects an externally supplied lift that overlaps a full future window", async () => {
  const built = scene([300, 300, 300, 300], 270, 1, {
    seed: new Map([["pending", { start: 8, end: 278, slots: [4] }]]),
  });
  expect(await fixedStatus(built)).toBe("INFEASIBLE");
  const withoutLiftWindows = {
    ...built,
    model: {
      ...built.model,
      constraints: built.model.constraints.filter((c) => c.kind !== "cumulative"),
    },
  };
  expect(await fixedStatus(withoutLiftWindows)).toMatch(/^(FEASIBLE|OPTIMAL)$/);
});

it.each([247, 248, 249])(
  "respects the half-open window at a lift ending at %i + 8",
  async (boilSeconds) => {
    const built = scene([300, 300, 300, 300], boilSeconds);
    expect(await fixedStatus(built)).toMatch(/^(FEASIBLE|OPTIMAL)$/);
    expect(built.hints.at(-1)!.end).toBe(boilSeconds <= 247 ? boilSeconds + 8 : 345);
  },
);
