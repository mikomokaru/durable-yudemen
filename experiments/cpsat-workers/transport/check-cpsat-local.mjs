#!/usr/bin/env node
// 実モデルの CP-SAT 経路をローカルで通す。
//
//   node experiments/cpsat-workers/transport/check-cpsat-local.mjs OUT.json
//
// これまでの harness は**固定問題**（同梱 fixture の protobuf）を解いていた。輸送の性質を
// 測るにはそれで足りたが、`src/cpsat/plan.ts` の実モデル生成——`formulate` → protobuf →
// CP-SAT → 検証 → `CookSchedule`——は**一度も検証されていない**。ここで初めて通す。
//
// 経路は本番の形にする：実 `PlanRequest` → `planCpsat` → 実 `CookSchedule`。Queue と DO は
// 挟まない（輸送は別に検証済みで、ここで混ぜると失敗の切り分けができなくなる）。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../../..");
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { build } = wranglerRequire("esbuild");
const { Miniflare, Log, LogLevel } = wranglerRequire("miniflare");

const output = process.argv[2];
if (!output || process.argv.length !== 3)
  throw new Error("Usage: node check-cpsat-local.mjs NEW_REPORT.json");

const wasm = await readFile(resolve(directory, "../vendor/cpsat_workers_poc_runtime.wasm"));
const scratch = await mkdtemp(resolve(tmpdir(), "cpsat-real-local-"));

// 実モデルを呼ぶだけの入口。`src/cpsat/plan.ts` をそのまま使う。
const entry = resolve(scratch, "entry.ts");
await writeFile(
  entry,
  `import { planCpsat } from ${JSON.stringify(resolve(root, "src/cpsat/plan.ts"))};
   import { schedulingDefaults } from ${JSON.stringify(resolve(root, "tests/storeConfigDefaults.ts"))};
   import { DEFAULT_NOODLE_PRESETS } from ${JSON.stringify(resolve(root, "src/domain/store.ts"))};
   export default {
     async fetch(request) {
       const { request: incoming, now, unitCount } = await request.json();
       // 採点パラメータ 11 値と麺プリセットは**正本から組む**。手で書き写すと
       // slotOffsets のような項目が抜け、モデル生成の手前で落ちる（実際に落ちた）。
       const plan = {
         ...incoming,
         params: schedulingDefaults(unitCount),
         noodlePresets: DEFAULT_NOODLE_PRESETS,
       };
       try {
         const result = await planCpsat(plan, now);
         return Response.json({
           ok: true,
           status: result.status,
           variables: result.variables,
           memoryBytes: result.memoryBytes,
           slices: result.schedule.slices.length,
           placements: result.schedule.slices.reduce((n, s) => n + s.placements.length, 0),
           schedule: result.schedule,
         });
       } catch (error) {
         return Response.json({ ok: false, error: String(error), stack: error?.stack ?? null });
       }
     },
   };`,
);

const built = await build({
  absWorkingDir: root,
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2022",
  metafile: true,
  plugins: [
    {
      name: "wasm-external",
      setup(bundler) {
        bundler.onResolve({ filter: /\.wasm$/ }, () => ({
          path: "./runtime.wasm",
          external: true,
        }));
      },
    },
  ],
});
const inputs = Object.keys(built.metafile.inputs);
// 実モデル生成が本当に束ねられていること。固定 fixture へすり替わっていたら意味がない。
assert.ok(
  inputs.some((path) => /src\/cpsat\/plan\.ts$/.test(path)),
  "planCpsat が束ねられていない",
);
assert.ok(
  inputs.some((path) => /tuning\/schedule/.test(path)),
  "formulate（実モデル）が束ねられていない",
);
assert.ok(
  !inputs.some((path) => /transport\/fixtures\.json$/.test(path)),
  "固定 fixture が混ざっている",
);

const runtime = new Miniflare({
  port: 0,
  cf: false,
  log: new Log(LogLevel.ERROR),
  workers: [
    {
      name: "planner",
      compatibilityDate: "2026-06-26",
      compatibilityFlags: ["no_nodejs_compat", "no_nodejs_compat_v2"],
      modulesRoot: scratch,
      modules: [
        {
          type: "ESModule",
          path: resolve(scratch, "entry.js"),
          contents: built.outputFiles[0].text,
        },
        { type: "CompiledWasm", path: resolve(scratch, "runtime.wasm"), contents: wasm },
      ],
    },
  ],
});

const T0 = 1_700_000_000_000;
// 麺種は既定プリセットの 1 件目に合わせる。表と食い違うと `cpsatTargets` が
// 「茹で時間が引けない品目」として 0 件に落とし、モデルが空になる。
const PRESET_NOODLE = "Thin";
/** 実データに寄せた要求。麺は既定プリセット、卓は 2 つ、釜は 3 ユニット。 */
function planRequest(itemCount) {
  const items = Array.from({ length: itemCount }, (_, index) => ({
    externalOrderId: `POS-${String(index).padStart(4, "0")}`,
    itemIndex: 0,
    noodleType: PRESET_NOODLE,
    firmness: "normal",
    tableId: index % 2 === 0 ? "T-1" : "T-2",
    arrivalTime: T0 + index * 30_000,
    portions: 1,
    itemName: "特味噌ネギラーメン",
    sizeName: "中盛",
    completedAt: null,
    interruptedAt: null,
  }));
  return {
    planner: "cpsat",
    storeId: "local-real-store",
    requestId: "00000000-0000-4000-8000-000000000000",
    inputKey: "",
    pending: items,
    running: [],
    // params と noodlePresets は entry 側が正本から埋める。
    digest: 0,
    shownPlan: [],
  };
}

const report = {
  measuredAt: new Date().toISOString(),
  environment: "local-workerd",
  cloudEvidence: false,
  what: "実モデル（formulate → protobuf → CP-SAT → 検証 → CookSchedule）をローカルで初めて通す",
  bundleIncludes: inputs.filter((path) => /src\/cpsat\/|tuning\//.test(path)).sort(),
  cases: [],
};
try {
  await runtime.ready;
  const worker = await runtime.getWorker("planner");
  for (const count of [1, 2, 3, 6]) {
    const request = planRequest(count);
    const started = Date.now();
    // oxlint-disable-next-line no-await-in-loop
    const response = await worker.fetch("https://planner.invalid/", {
      method: "POST",
      body: JSON.stringify({ request, now: T0 + count * 30_000, unitCount: 3 }),
    });
    // oxlint-disable-next-line no-await-in-loop
    const result = await response.json();
    report.cases.push({
      pending: count,
      wallMs: Date.now() - started,
      ok: result.ok,
      status: result.status ?? null,
      variables: result.variables ?? null,
      memoryBytes: result.memoryBytes ?? null,
      slices: result.slices ?? null,
      placements: result.placements ?? null,
      error: result.error ?? null,
      stack: result.stack ?? null,
      // 配置の中身を 1 件だけ残す。形が壊れていれば数字だけでは気づけない。
      firstPlacement: result.schedule?.slices?.[0]?.placements?.[0] ?? null,
    });
  }
} finally {
  await runtime.dispose();
}
const serialized = JSON.stringify(report, null, 2);
await writeFile(resolve(output), `${serialized}\n`, { flag: "wx" });
console.log(
  JSON.stringify(
    report.cases.map(({ pending, ok, status, variables, placements, wallMs, error }) => ({
      pending,
      ok,
      status,
      variables,
      placements,
      wallMs,
      error,
    })),
    null,
    1,
  ),
);
