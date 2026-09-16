#!/usr/bin/env node
// `elementVars`（変数の配列を変数で引く）が落ちる条件を 1 回だけ記録する。
//
//   node experiments/cpsat-workers/quality/probe-elementvars-domain.mjs [OUT.json]
//
// 見立て：添字の値ごとに「定義域の広い整数どうしの等式」へ展開され、bool 符号化が定義域の幅に
// 比例して増える。**幅を 1/10 にして落ちなくなれば、この読みは 1 回で確かめられる。**
// 形は実モデルの骨格だけを抜き出す——クラスタ時刻 T_k（狭義単調増加）を杯ごとに引いて end に等しくし、
// end の和を最小化する。
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
const scratch = await mkdtemp(resolve(tmpdir(), "cpsat-elemdom-"));

const entry = resolve(scratch, "entry.ts");
await writeFile(
  entry,
  `import { encodeModel } from ${JSON.stringify(resolve(root, "src/cpsat/protobuf.ts"))};
   import { runtime, solve } from ${JSON.stringify(resolve(root, "experiments/cpsat-workers/src/runtime"))};
   function model(n, k, width) {
     const variables = [];
     const constraints = [];
     const objective = [];
     const v = (lo, hi) => (variables.push([lo, hi]), variables.length - 1);
     const T = [];
     for (let i = 0; i < k; i++) {
       const t = v(1, width);
       if (i > 0) constraints.push({ kind: "linear", terms: [[t, 1], [T[i - 1], -1]], lo: 1, hi: 1000000000, when: [] });
       T.push(t);
     }
     const exprs = T.map((t) => ({ terms: [[t, 1]], offset: 0 }));
     for (let i = 0; i < n; i++) {
       const a = v(0, k - 1);
       const end = v(1, width);
       constraints.push({ kind: "elementVars", index: a, target: end, exprs });
       objective.push([end, 1]);
     }
     return { variables, constraints, intervals: [], objective, hints: [], budget: 0.3 };
   }
   export default {
     async fetch(request) {
       const { n, k, width } = await request.json();
       const m = model(n, k, width);
       try {
         const loaded = await runtime("frozen");
         const result = solve(loaded.value, "model", m.budget, encodeModel(m));
         return Response.json({ ok: true, status: result.status, objective: result.objective,
           memoryBytes: result.wasmMemoryBytes, variables: m.variables.length });
       } catch (error) {
         return Response.json({ ok: false, error: String(error).slice(0, 120), variables: m.variables.length });
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
  // **幅だけを動かす。** 杯数・クラスタ数を固定するので、差が出れば原因は定義域の幅である。
  for (const width of [27000, 2700, 270]) {
    for (const [n, k] of [
      [16, 16],
      [24, 24],
      [32, 32],
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      const response = await worker.fetch("https://probe.invalid/", {
        method: "POST",
        body: JSON.stringify({ n, k, width }),
      });
      // oxlint-disable-next-line no-await-in-loop
      rows.push({ width, n, k, ...(await response.json()) });
    }
  }
} finally {
  await mf.dispose();
}
const output = process.argv[2];
if (output)
  await writeFile(resolve(output), `${JSON.stringify({ cloudEvidence: false, rows }, null, 2)}\n`, {
    flag: "wx",
  });
for (const row of rows)
  console.log(
    `幅 ${String(row.width).padStart(6)} 杯 ${String(row.n).padStart(3)} クラスタ ${String(row.k).padStart(3)} → ` +
      (row.ok
        ? `${row.status} memory ${(row.memoryBytes / 1048576).toFixed(0)} MiB`
        : `**失敗** ${row.error}`),
  );
