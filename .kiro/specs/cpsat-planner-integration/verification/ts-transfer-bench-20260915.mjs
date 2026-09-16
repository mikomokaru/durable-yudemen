// One-off synthetic before/after measurement. No production data or bindings.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
const root = process.cwd();
const require = createRequire(resolve(root, "package.json"));
const { build } = createRequire(require.resolve("wrangler/package.json"))("esbuild");
const beforeDir = process.argv[2];
const output = process.argv[3];
if (!beforeDir || !output)
  throw Error(
    "usage: node ts-transfer-bench-20260915.mjs BEFORE_DIRECTORY OUTPUT_JSON (run from repository root)",
  );
const source = `export * from './src/engine/schedule'; export * from './src/engine/lift'; export * from './src/engine/objective'; export * from './src/engine/timer'; export * from './src/engine/project'; export * from './src/domain/store'; export * from './tests/storeConfigDefaults';`;
await Promise.all(
  ["before", "after"].map(async (which) => {
    await build({
      stdin: { contents: source, resolveDir: root, loader: "ts" },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: resolve(beforeDir, which + "-engine.cjs"),
      plugins:
        which === "before"
          ? [
              {
                name: "before",
                setup(b) {
                  b.onLoad({ filter: /src\/engine\/(lift|schedule)\.ts$/ }, (args) => ({
                    contents: readFileSync(
                      resolve(beforeDir, args.path.slice(root.length + 1)),
                      "utf8",
                    ),
                    loader: "ts",
                    resolveDir: resolve(root, "src/engine"),
                  }));
                },
              },
            ]
          : [],
    });
  }),
);
const before = require(resolve(beforeDir, "before-engine.cjs")),
  after = require(resolve(beforeDir, "after-engine.cjs"));
let sink = 0;
function elapsed(fn, n) {
  let t = performance.now();
  for (let i = 0; i < n; i++) sink += fn();
  return (performance.now() - t) / n;
}
function median(a) {
  return a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
}
const micro = [];
for (const count of [32, 128, 164])
  for (const spacing of [1, 1000, 60000]) {
    const lifts = Array.from({ length: count }, (_, i) => ({
      at: 1700000000000 + i * spacing,
      span: 1,
    }));
    const at = lifts[Math.floor(count / 2)].at,
      params = { arms: 2, liftIntervalSeconds: 45 };
    for (const operation of ["loadWith", "firstFit"]) {
      const fns = [before, after].map((m) => () => m[operation](lifts, at, 1, params));
      if (fns[0]() !== fns[1]()) throw Error("different load result");
      const n = operation === "loadWith" ? 10000 : 1000;
      fns.forEach((fn) => elapsed(fn, 1000));
      const times = [[], []];
      for (let k = 0; k < 7; k++)
        for (const side of k % 2 ? [1, 0] : [0, 1]) times[side].push(elapsed(fns[side], n) * 1000);
      micro.push({
        count,
        spacing,
        operation,
        beforeUs: median(times[0]),
        afterUs: median(times[1]),
      });
    }
  }
let state = 20260915;
const rand = (n) => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return Math.floor((state / 4294967296) * n);
};
const scenes = [];
for (let sceneIndex = 0; sceneIndex < 1000; sceneIndex++) {
  const now = 1700000000000 + rand(1000),
    unitCount = 1 + rand(3),
    slotCount = unitCount * 6;
  const params = {
    ...after.schedulingDefaults(unitCount),
    arms: 1 + rand(4),
    liftIntervalSeconds: 5 + rand(116),
    tableSyncWeight: rand(5),
    orderSyncWeight: rand(5),
  };
  const running = Array.from({ length: rand(Math.min(slotCount, 8)) }, (_, i) =>
    after.createTimer({
      id: "r" + i,
      slotIds: [String(i)],
      noodleType: "Thin",
      firmness: "normal",
      startTime: now - 100000,
      endTime: now - 10000 + rand(250000),
      seq: i,
      orderItem: { externalOrderId: "r" + i, itemIndex: 0, tableId: "t" + rand(5) },
    }),
  );
  const pending = Array.from({ length: 1 + rand(64) }, (_, i) => ({
    externalOrderId: "p" + Math.floor(i / 3),
    itemIndex: i % 3,
    noodleType: ["Thin", "Medium", "Thick"][rand(3)],
    firmness: ["extraHard", "hard", "normal", "soft"][rand(4)],
    tableId: "t" + rand(5),
    arrivalTime: now - rand(600000),
    slotSpan: 1 + rand(2),
    itemName: null,
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
  }));
  const presets = after.DEFAULT_NOODLE_PRESETS.map((p) => ({
    ...p,
    boilSeconds: Object.fromEntries(Object.entries(p.boilSeconds).map(([k, v]) => [k, v * 3])),
  }));
  const members = after.tableMembers(running),
    lifts = after.initialLifts(running);
  const args = [
    pending,
    after.initialRelease(running, now, slotCount),
    members,
    lifts,
    presets,
    params,
    now,
    after.occupiedSlotsOf(running),
    null,
  ];
  scenes.push({ args, pending, params, context: { members, lifts, change: null } });
}
const rows = [];
let changed = 0,
  improved = 0,
  worsened = 0,
  invalid = 0;
for (let i = 0; i < scenes.length; i++) {
  const s = scenes[i];
  const schedules = [before, after].map((m) => m.baselineSchedule(...s.args));
  const costs = schedules.map(
    (p) => after.scoreSchedule(p.slices, s.pending, s.context, s.params).total,
  );
  if (JSON.stringify(schedules[0]) !== JSON.stringify(schedules[1])) changed++;
  if (costs[1] < costs[0]) improved++;
  if (costs[1] > costs[0]) worsened++;
  if (
    !after.withinLiftCap(
      s.context.lifts,
      after.liftsOf(schedules[1].slices.flatMap((slice) => slice.placements)),
      s.params,
    )
  )
    invalid++;
  if (costs[0] !== costs[1])
    rows.push({ scene: i, before: costs[0], after: costs[1], delta: costs[1] - costs[0] });
}
const planTimes = [[], []];
for (let k = 0; k < 5; k++)
  for (const side of k % 2 ? [1, 0] : [0, 1]) {
    let start = performance.now();
    for (const s of scenes) sink += [before, after][side].baselineSchedule(...s.args).slices.length;
    planTimes[side].push(performance.now() - start);
  }
const hashes = Object.fromEntries(
  ["src/engine/lift.ts", "src/engine/schedule.ts"].map((p) => [
    p,
    {
      before: createHash("sha256")
        .update(readFileSync(resolve(beforeDir, p)))
        .digest("hex"),
      after: createHash("sha256").update(readFileSync(p)).digest("hex"),
    },
  ]),
);
const results = {
  node: process.version,
  hashes,
  seed: 20260915,
  sample: "synthetic, 1000 scenes, 6/12/18 slots, 1-64 pending, no previous plan",
  micro,
  quality: { scenes: 1000, changed, improved, worsened, invalid, rows },
  planTimingMsPer1000: { before: median(planTimes[0]), after: median(planTimes[1]) },
  sink,
};
writeFileSync(output, JSON.stringify(results, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      quality: { ...results.quality, rows: undefined },
      planTimingMsPer1000: results.planTimingMsPer1000,
    },
    null,
    2,
  ),
);
