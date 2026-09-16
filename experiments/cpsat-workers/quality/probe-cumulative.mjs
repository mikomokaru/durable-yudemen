#!/usr/bin/env node
// `cumulative` が**本当に効いているか**を実 WASM で確かめる。
//
//   node experiments/cpsat-workers/quality/probe-cumulative.mjs [OUT.json]
//
// **番号を取り違えた符号化は、静かに無視されて解が返る。** それは「制約を書いたつもりで
// 書けていない」という最悪の形なので、制約が無ければ通る解を用意して、通らないことを見る。
//
// 仕掛け：3 本の区間（長さ 10・需要 1）を 0..30 の窓に置き、開始時刻の和を最小化する。
//   ・制約が無い／無視される → 3 本とも 0 に置ける。和 = 0。
//   ・容量 2 の cumulative が効く → 同時に置けるのは 2 本まで。3 本目は 10 以降。和 = 10。
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
const wasm = await readFile(resolve(directory, "../vendor/cpsat_workers_poc_runtime.wasm"));
const scratch = await mkdtemp(resolve(tmpdir(), "cpsat-cumulative-"));

const entry = resolve(scratch, "entry.ts");
await writeFile(
  entry,
  `import { encodeModel } from ${JSON.stringify(resolve(root, "src/cpsat/protobuf.ts"))};
   import { runtime, solve } from ${JSON.stringify(resolve(root, "experiments/cpsat-workers/src/runtime"))};
   /** 3 本の区間・需要 1・容量 cap。開始の和を最小化する。 */
   function model(cap, withConstraint) {
     const variables = [];
     const constraints = [];
     const intervals = [];
     const objective = [];
     const v = (lo, hi) => (variables.push([lo, hi]), variables.length - 1);
     const size = v(10, 10);
     for (let i = 0; i < 3; i++) {
       const start = v(0, 30);
       const end = v(10, 40);
       constraints.push({ kind: "linear", terms: [[end, 1], [start, -1], [size, -1]], lo: 0, hi: 0, when: [] });
       intervals.push([start, size, end, null]);
       objective.push([start, 1]);
     }
     if (withConstraint)
       constraints.push({
         kind: "cumulative",
         intervals: [0, 1, 2],
         demands: [{ terms: [], offset: 1 }, { terms: [], offset: 1 }, { terms: [], offset: 1 }],
         capacity: { terms: [], offset: cap },
       });
     return { variables, constraints, intervals, objective, hints: [], budget: 0.5 };
   }
   /**
    * 変数を引く element の検査。pick で選んだ式の値が target に入るか。
    * 制約が無視されれば target は自由なので、最小化した目的値が 0 になる。
    */
   function elementModel(pick) {
     const variables = [];
     const constraints = [];
     const objective = [];
     const v = (lo, hi) => (variables.push([lo, hi]), variables.length - 1);
     const a = v(7, 7), bb = v(11, 11), cc = v(23, 23);
     const index = v(pick, pick);
     const target = v(0, 100);
     constraints.push({
       kind: "elementVars",
       index,
       target,
       exprs: [
         { terms: [[a, 1]], offset: 0 },
         { terms: [[bb, 1]], offset: 0 },
         { terms: [[cc, 1]], offset: 5 },
       ],
     });
     objective.push([target, 1]);
     return { variables, constraints, intervals: [], objective, hints: [], budget: 0.5 };
   }
   export default {
     async fetch(request) {
       const { cap, withConstraint, element } = await request.json();
       const m = element === undefined ? model(cap, withConstraint) : elementModel(element);
       const loaded = await runtime("frozen");
       const result = solve(loaded.value, "model", m.budget, encodeModel(m));
       return Response.json({ status: result.status, objective: result.objective, solution: [...result.solution] });
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
const mf = new Miniflare({
  port: 0,
  cf: false,
  log: new Log(LogLevel.ERROR),
  workers: [
    {
      name: "probe",
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
const rows = [];
try {
  await mf.ready;
  const worker = await mf.getWorker("probe");
  for (const [name, cap, withConstraint, element] of [
    ["制約なし（対照）", 3, false, undefined],
    ["容量 3（緩い）", 3, true, undefined],
    ["容量 2（効くはず）", 2, true, undefined],
    ["容量 1（さらに効く）", 1, true, undefined],
    // 変数を引く element。選んだ式の値がそのまま最小値になる（無視されれば 0 になる）。
    ["element 変数 0 → 7", 0, true, 0],
    ["element 変数 1 → 11", 0, true, 1],
    ["element 変数 2 → 28", 0, true, 2],
  ]) {
    // oxlint-disable-next-line no-await-in-loop
    const response = await worker.fetch("https://probe.invalid/", {
      method: "POST",
      body: JSON.stringify({ cap, withConstraint, element }),
    });
    // oxlint-disable-next-line no-await-in-loop
    rows.push({ name, cap, withConstraint, ...(await response.json()) });
  }
} finally {
  await mf.dispose();
}
const output = process.argv[2];
if (output) {
  const { writeFile: write } = await import("node:fs/promises");
  await write(resolve(output), `${JSON.stringify({ cloudEvidence: false, rows }, null, 2)}\n`, {
    flag: "wx",
  });
}
for (const row of rows) console.log(row.name, "→", row.status, "objective =", row.objective);

const by = (n) => rows.find((row) => row.name === n);
assert.equal(by("制約なし（対照）").objective, 0, "対照が 0 でなければ仕掛けが違う");
assert.equal(by("容量 3（緩い）").objective, 0, "容量 3 は 3 本同時に置ける");
assert.equal(by("容量 2（効くはず）").objective, 10, "**cumulative が無視されている**");
assert.equal(by("容量 1（さらに効く）").objective, 30, "**cumulative が無視されている**");
assert.equal(by("element 変数 0 → 7").objective, 7, "**elementVars が無視されている**");
assert.equal(by("element 変数 1 → 11").objective, 11, "**elementVars が無視されている**");
assert.equal(by("element 変数 2 → 28").objective, 28, "**elementVars が無視されている**");
console.log("\n✅ cumulative も elementVars も効いている（容量・添字で最適値が動いた）");
