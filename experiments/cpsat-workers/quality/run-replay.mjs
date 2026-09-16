#!/usr/bin/env node
// 7-B：コーパスを**本番の取り込み経路**へ流し、同じ局面を TS と CP-SAT に解かせて比べる。
//
//   node experiments/cpsat-workers/quality/run-replay.mjs OUT.json [--window 20] [--per-file 20] [--max 200]
//
// 経路。
//   コーパス行 → Arrival_Record（メタデータ 2 つだけ付与）→ 実 StoreTimerDO.receiveRecords
//   → engine が RequestPlan を出す → shell が PlanRequest を組んで SOLVER へ送る
//   → ここ（Node）が捕まえる = **局面**
//   → eval worker が TS（engine 自前解）と CP-SAT（実 WASM）を同じ局面に当てて採点する
//
// 取り込みの変換をこの harness は一切持たない。局面の中身は DO が作ったものである。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildStoreConfigs,
  readCorpus,
  seededRandom,
  toArrivalRecords,
  CORPUS_DIRECTORY,
} from "./corpus.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../../..");
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { build } = wranglerRequire("esbuild");
const { Miniflare, Log, LogLevel } = wranglerRequire("miniflare");

const [output, ...flags] = process.argv.slice(2);
if (!output)
  throw new Error("Usage: run-replay.mjs OUT.json [--window N] [--per-file N] [--max N]");
const flag = (name, fallback) => {
  const index = flags.indexOf(`--${name}`);
  return index < 0 ? fallback : Number(flags[index + 1]);
};
/** 局面の窓（分）。コーパスは開始・完了を持たないので、この窓の長さが pending 件数を決める。 */
const WINDOW_MINUTES = flag("window", 20);
const PER_FILE = flag("per-file", 20);
const MAX_SCENES = flag("max", 200);
/**
 * 対象上限の掃引。`--limits 6,12,24,64` で指定すると、各局面に対して上限だけを変えて解き、
 * 費用（時間・モデル規模）と**採否**の両方を記録する。省略すると通常の TS/CP-SAT 比較を行う。
 */
const LIMITS = (() => {
  const index = flags.indexOf("--limits");
  if (index < 0) return null;
  const parsed = String(flags[index + 1] ?? "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= 64);
  if (parsed.length === 0) throw new Error("--limits は 1..64 の整数をカンマ区切りで与える");
  return parsed;
})();
/**
 * 防壁（変数 8192・制約＋区間 40000）を外して素の劣化を見る。**掃引専用である**
 * ——外した実行は「実行時が有界である」という根拠を持たない。
 */
const UNGUARDED = flags.includes("--unguarded");
/** 旧形（上げ窓の上限を値段で持つ）で測る。新旧を並べるときだけ使う。 */
const LEGACY_LIFT_CAP = flags.includes("--legacy-lift-cap");
/** 釜の在否を旧い形（`eq` 経由・1 釜 4 変数）で組む。ダイエットの効きを見るときだけ使う。 */
const FAT_SLOTS = flags.includes("--fat-slots");
/** 対の項を旧い形（全組）で組む。E4・E7 の新旧を並べるときだけ使う。 */
const FAT_PAIRS = flags.includes("--fat-pairs");
/** hint を固定して解き、実行可能であることを各局面で確かめる（モデルに変数を足したら回す）。 */
const CHECK_HINTS = flags.includes("--check-hints");
/** 走行中 Timer を注入する本数（コーパスに開始履歴が無いので合成する）。 */
const INJECT_RUNNING = (() => {
  const index = flags.indexOf("--running");
  return index < 0 ? 0 : Number(flags[index + 1]);
})();
/** 注入した走行中の上がりを 1 つの上げ窓へ寄せる（固定分だけで上限を超える局面）。 */
const CROWD_RUNNING = flags.includes("--crowd-running");
/** 注入する走行中の残り時間（ミリ秒）。lead の窓の内側を踏むため。 */
const RUNNING_SAME_SLOT = flags.includes("--running-same-slot");
const RUNNING_ENDS_IN_MS = (() => {
  const index = flags.indexOf("--running-ends");
  if (index < 0) return null;
  const value = Number(flags[index + 1]);
  // **負を許す。** 本番の失敗局面では走行中の 76% が「既に上がっている」（残り時間が負）——
  // 茹で上がって Complete 待ちの状態である。0 以上に縛ると、その局面を一度も踏めない（2026-09-15）。
  if (!Number.isInteger(value)) throw new Error("--running-ends はミリ秒の整数");
  return value;
})();
/** 1 度解いた結果を Shown_Plan として渡して解き直し、釜の揺れを数える。 */
const CHAIN_SHOWN = flags.includes("--chain-shown");
/** 前回の釜を hint に使わない旧い形（負の対照）。 */
const LEGACY_HINT_SLOTS = flags.includes("--legacy-hint-slots");
/** 伝票ごとの待ちを目的にする試作（手順 2）。 */
const BILL_WAIT = flags.includes("--bill-wait");
/** 同じ伝票の杯を同じクラスタへ縛る（構造で同時提供を作る）。 */
const BILL_CLUSTER = flags.includes("--bill-cluster");
/** 貪欲 hint を伝票単位で組む。 */
const BILL_HINT = flags.includes("--bill-hint");
/** 連続 2 回の求解の間に走行中が何本増減するか（負も可）。 */
const CHAIN_RUNNING_DELTA = (() => {
  const index = flags.indexOf("--chain-running-delta");
  if (index < 0) return 0;
  const value = Number(flags[index + 1]);
  if (!Number.isInteger(value)) throw new Error("--chain-running-delta は整数");
  return value;
})();
/** Head 近傍の釜を守る重みの倍率（1 は一律＝負の対照）。 */
const UNORDERED_HINT = flags.includes("--unordered-hint");
const INVERSION_COST = (() => {
  const index = flags.indexOf("--inversion-cost");
  if (index < 0) return null;
  const value = Number(flags[index + 1]);
  if (!Number.isFinite(value) || value < 0) throw new Error("--inversion-cost は 0 以上");
  return value;
})();
const HEAD_FACTOR = (() => {
  const index = flags.indexOf("--head-factor");
  if (index < 0) return null;
  const value = Number(flags[index + 1]);
  if (!Number.isFinite(value) || value < 1) throw new Error("--head-factor は 1 以上");
  return value;
})();
/** hint を固定して解く（hint がモデルの制約を満たすかの検査）。 */
const FIX_HINTS = flags.includes("--fix-hints");
/**
 * **固定解を完全 hint として戻して解き直す。** 1 度目は hint を固定して解き、返った
 * 全変数の解を 2 度目の出発点にする。探索の入口が改善するかを見るための摘みである。
 */
const COMPLETE_HINT = flags.includes("--complete-hint");
/** hint を種別ごとに積み上げて固定し、どこで実行不能になるかを見る。 */
const BISECT_HINT = flags.includes("--bisect-hint");
/** Head 近傍で動いた釜を、前回の釜へ固定して解き直し、必要な変更かを判定する。 */
const HOLD_HEAD = flags.includes("--hold-head");
/**
 * **局面の「今」を固定する（`--now <epochMs>`）。** 省略すると実時刻。
 *
 * 絶対時刻の位相で丸めが変わり、同じコードでも解が変わる。前後比較を主張する実行は固定する。
 */
const NOW_MS = (() => {
  const index = flags.indexOf("--now");
  if (index < 0) return null;
  const value = Number(flags[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("--now は正の整数（epoch ms）");
  return value;
})();
/** 伝票を割ったときの費用。 */
const BILL_SPLIT_COST = (() => {
  const index = flags.indexOf("--bill-split");
  if (index < 0) return null;
  const value = Number(flags[index + 1]);
  if (!Number.isFinite(value) || value < 0) throw new Error("--bill-split は 0 以上");
  return value;
})();
/** TS の解を出発点にする。"hint"（実験 2）／"fix"（実験 1・採点だけ）。 */
const TS_SEED = (() => {
  const index = flags.indexOf("--ts-seed");
  if (index < 0) return null;
  const value = String(flags[index + 1] ?? "");
  if (value !== "hint" && value !== "fix") throw new Error("--ts-seed は hint か fix");
  return value;
})();
/** 伝票の内側の広がりの重み。既定は 10（待ち 1 秒と同じ）。 */
const BILL_SPREAD_WEIGHT = (() => {
  const index = flags.indexOf("--bill-spread");
  if (index < 0) return null;
  const value = Number(flags[index + 1]);
  if (!Number.isFinite(value) || value < 0) throw new Error("--bill-spread は 0 以上");
  return value;
})();
/** クラスタ数の上限。モデルの制限なので、掃引で効きと副作用を測るためだけに使う。 */
const CLUSTER_CAP = (() => {
  const index = flags.indexOf("--cluster-cap");
  if (index < 0) return null;
  const value = Number(flags[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 64)
    throw new Error("--cluster-cap は 1..64");
  return value;
})();
/**
 * **受領までの遅れ（ミリ秒）。** 本番では計画を組んだ時刻と DO が受け取る時刻がずれる。
 * 0（既定）は同じ時刻で採否を見る——**本番の形ではない**。
 */
const DELIVER_DELAY_MS = (() => {
  const index = flags.indexOf("--deliver-delay");
  if (index < 0) return 0;
  const value = Number(flags[index + 1]);
  if (!Number.isInteger(value) || value < 0 || value > 600_000)
    throw new Error("--deliver-delay は 0..600000 のミリ秒");
  return value;
})();
/** 探索予算（決定的時間）の上限。既定の式より大きくできる。掃引専用。 */
const BUDGET_CAP = (() => {
  const index = flags.indexOf("--budget");
  if (index < 0) return null;
  const value = Number(flags[index + 1]);
  if (!Number.isFinite(value) || value <= 0 || value > 10) throw new Error("--budget は 0<x<=10");
  return value;
})();
/** 評価計画 §2 の seed。標本の選び方はこの 1 値で決まる。 */
const SEED = "cpsat-plan-quality-20260913";

const scratch = await mkdtemp(resolve(tmpdir(), "cpsat-replay-"));
const wasm = await readFile(resolve(directory, "../vendor/cpsat_workers_poc_runtime.wasm"));

async function bundle(entryPoint) {
  const built = await build({
    absWorkingDir: root,
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    metafile: true,
    external: ["cloudflare:workers", "cloudflare:sockets"],
    loader: { ".html": "text" },
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
  return { text: built.outputFiles[0].text, inputs: Object.keys(built.metafile.inputs) };
}

const app = await bundle(resolve(root, "src/worker.ts"));
const evaluator = await bundle(resolve(directory, "eval-entry.ts"));
// 実モデルが束ねられていること。固定 fixture へすり替わっていたら比較の意味が無い。
assert.ok(evaluator.inputs.some((path) => /src\/cpsat\/plan\.ts$/.test(path)));
assert.ok(evaluator.inputs.some((path) => /tuning\/schedule/.test(path)));

// --- 局面の材料 -----------------------------------------------------------
const files = await readCorpus();
const { configs, conflicts } = buildStoreConfigs(
  await readFile(resolve(CORPUS_DIRECTORY, "noodle_reference.csv"), "utf8"),
  files.flatMap((file) => file.rows),
);
const random = seededRandom(SEED);
const windowMillis = WINDOW_MINUTES * 60_000;
const cuts = [];
for (const file of files) {
  // 窓が丸ごと収まる切り口だけを候補にする（先頭近くの窓は短くなり、他と比べられない）。
  const first = file.rows[0].corpusMillis;
  const candidates = file.rows
    .map((row, index) => ({ index, at: row.corpusMillis }))
    .filter((row) => row.at - first >= windowMillis);
  const picked = candidates
    .map((row) => ({ row, key: random() }))
    .sort((a, b) => a.key - b.key)
    .slice(0, PER_FILE)
    .map(({ row }) => row)
    .sort((a, b) => a.index - b.index);
  for (const cut of picked) cuts.push({ file: file.name, storeId: file.storeId, ...cut });
}
// 全体の上限も seed で決める（ファイル順の偏りを作らない）。
const scenes = cuts
  .map((cut) => ({ cut, key: random() }))
  .sort((a, b) => a.key - b.key)
  .slice(0, MAX_SCENES)
  .map(({ cut }) => cut)
  .sort((a, b) => a.file.localeCompare(b.file) || a.index - b.index);

// --- 実行 -----------------------------------------------------------------
/** DO が SOLVER へ送った PlanRequest（＝局面）を storeId で受ける。 */
const captured = new Map();
let captures = 0;

const runtime = new Miniflare({
  port: 0,
  cf: false,
  log: new Log(LogLevel.ERROR),
  workers: [
    {
      name: "app",
      compatibilityDate: "2026-06-26",
      modulesRoot: scratch,
      modules: [{ type: "ESModule", path: resolve(scratch, "app.js"), contents: app.text }],
      bindings: {
        PLANNER_BACKEND: "ts",
        ADMIN_TOKEN: "replay-admin",
        ORDER_INGRESS_TOKEN: "replay-ingress",
        ACCESS_REQUIRED: "0",
        OBSERVE_DEBUG: "0",
        OPERATION_HISTORY_ENABLED: "0",
      },
      durableObjects: {
        STORE_TIMER_DO: { className: "StoreTimerDO", useSQLite: true },
        STORE_REGISTRY_DO: { className: "StoreRegistryDO", useSQLite: true },
      },
      serviceBindings: {
        // 往路をここで捕まえる。**作り変えない**——DO が組んだ本番のボディそのものを局面にする。
        SOLVER: async (request) => {
          const body = await request.json();
          captured.set(body.storeId, body);
          captures += 1;
          return new Response(null, { status: 202 });
        },
        ASSETS: () => new Response(null, { status: 404 }),
      },
    },
    {
      name: "evaluator",
      compatibilityDate: "2026-06-26",
      compatibilityFlags: ["no_nodejs_compat", "no_nodejs_compat_v2"],
      modulesRoot: scratch,
      modules: [
        { type: "ESModule", path: resolve(scratch, "evaluator.js"), contents: evaluator.text },
        { type: "CompiledWasm", path: resolve(scratch, "runtime.wasm"), contents: wasm },
      ],
      durableObjects: {
        STORE_TIMER_DO: { className: "StoreTimerDO", scriptName: "app", useSQLite: true },
      },
    },
  ],
});

const report = {
  measuredAt: new Date().toISOString(),
  environment: "local-workerd",
  cloudEvidence: false,
  seed: SEED,
  windowMinutes: WINDOW_MINUTES,
  perFile: PER_FILE,
  maxScenes: MAX_SCENES,
  limits: LIMITS,
  unguarded: UNGUARDED,
  legacyLiftCap: LEGACY_LIFT_CAP,
  budgetCap: BUDGET_CAP,
  fatSlots: FAT_SLOTS,
  fatPairs: FAT_PAIRS,
  checkHints: CHECK_HINTS,
  injectRunning: INJECT_RUNNING,
  crowdRunning: CROWD_RUNNING,
  runningEndsInMs: RUNNING_ENDS_IN_MS,
  runningSameSlot: RUNNING_SAME_SLOT,
  deliverDelayMs: DELIVER_DELAY_MS,
  chainShown: CHAIN_SHOWN,
  legacyHintSlots: LEGACY_HINT_SLOTS,
  billWait: BILL_WAIT,
  billCluster: BILL_CLUSTER,
  billHint: BILL_HINT,
  chainRunningDelta: CHAIN_RUNNING_DELTA,
  headFactor: HEAD_FACTOR,
  inversionCost: INVERSION_COST,
  unorderedHint: UNORDERED_HINT,
  fixHints: FIX_HINTS,
  billSplitCost: BILL_SPLIT_COST,
  tsSeed: TS_SEED,
  billSpreadWeight: BILL_SPREAD_WEIGHT,
  clusterCap: CLUSTER_CAP,
  corpus: {
    files: files.length,
    rows: files.reduce((sum, file) => sum + file.rows.length, 0),
    stores: configs.size,
    menuItemConflicts: conflicts,
  },
  sceneCount: scenes.length,
  rows: [],
  errors: [],
};

try {
  await runtime.ready;
  const worker = await runtime.getWorker("evaluator");
  for (const [ordinal, scene] of scenes.entries()) {
    const file = files.find((entry) => entry.name === scene.file);
    const store = configs.get(scene.storeId);
    const rows = file.rows.filter(
      (row) => row.corpusMillis > scene.at - windowMillis && row.corpusMillis <= scene.at,
    );
    // 局面ごとに新しい DO を使う。平行移動が窓を跨がないための条件である。
    const storeId = `replay-${scene.file.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${scene.index}`;
    const delta = Date.now() - scene.at;
    const records = toArrivalRecords(rows, delta);
    captured.delete(storeId);
    const before = captures;
    // oxlint-disable-next-line no-await-in-loop
    const scened = await worker.fetch("https://evaluator.invalid/scene", {
      method: "POST",
      body: JSON.stringify({ storeId, store, records }),
    });
    // oxlint-disable-next-line no-await-in-loop
    const sceneResult = await scened.json();
    const request = captured.get(storeId) ?? null;
    if (request === null) {
      report.rows.push({
        ordinal,
        file: scene.file,
        storeId: scene.storeId,
        cutAt: new Date(scene.at).toISOString(),
        recordCount: rows.length,
        outcome: sceneResult.outcome ?? null,
        planRequested: false,
        newCaptures: captures - before,
        note: "RequestPlan が出なかった局面（比較対象なし）",
      });
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop
    const compared = await worker.fetch(
      LIMITS === null ? "https://evaluator.invalid/compare" : "https://evaluator.invalid/sweep",
      {
        method: "POST",
        body: JSON.stringify({
          request,
          unitCount: store.unitCount,
          ...(LIMITS === null
            ? {}
            : {
                limits: LIMITS,
                unguarded: UNGUARDED,
                legacyLiftCap: LEGACY_LIFT_CAP,
                budgetCap: BUDGET_CAP,
                fatSlots: FAT_SLOTS,
                fatPairs: FAT_PAIRS,
                checkHints: CHECK_HINTS,
                injectRunning: INJECT_RUNNING,
                crowdRunning: CROWD_RUNNING,
                runningEndsInMs: RUNNING_ENDS_IN_MS,
                runningSameSlot: RUNNING_SAME_SLOT,
                deliverDelayMs: DELIVER_DELAY_MS,
                chainShown: CHAIN_SHOWN,
                legacyHintSlots: LEGACY_HINT_SLOTS,
                billWait: BILL_WAIT,
                billCluster: BILL_CLUSTER,
                billHint: BILL_HINT,
                chainRunningDelta: CHAIN_RUNNING_DELTA,
                headFactor: HEAD_FACTOR,
                inversionCost: INVERSION_COST,
                unorderedHint: UNORDERED_HINT,
                fixHints: FIX_HINTS,
                completeHint: COMPLETE_HINT,
                bisectHint: BISECT_HINT,
                holdHead: HOLD_HEAD,
                ...(NOW_MS === null ? {} : { nowMs: NOW_MS }),
                billSplitCost: BILL_SPLIT_COST,
                tsSeed: TS_SEED,
                billSpreadWeight: BILL_SPREAD_WEIGHT,
                clusterCap: CLUSTER_CAP,
              }),
        }),
      },
    );
    // oxlint-disable-next-line no-await-in-loop
    const result = await compared.json();
    report.rows.push({
      ordinal,
      file: scene.file,
      storeId: scene.storeId,
      cutAt: new Date(scene.at).toISOString(),
      recordCount: rows.length,
      outcome: sceneResult.outcome ?? null,
      planRequested: true,
      unitCount: store.unitCount,
      digest: request.digest,
      ...result,
    });
  }
} catch (error) {
  report.errors.push({ error: String(error), stack: error?.stack ?? null });
} finally {
  await runtime.dispose();
}

// **指定した摘みが本当に効いたかを検算する。** shape の指定が黙って届かない事故を 3 度やった
// （`plan.ts` が `shape` を渡していない／予算の「上限」が縛っていない／`shapeOf` への整理で
// 予算が落ちる）。**いずれも結果は返るので、値を見比べない限り気づけない。**
// 気づけなかった回は、掃引の結果を「差が無い」と読み違えたまま報告している。
const solved = report.rows.flatMap((row) => row.results ?? []).filter((result) => result.ok);
const mismatched = [];
if (BUDGET_CAP !== null)
  for (const result of solved)
    if (Math.abs(result.budget - BUDGET_CAP) > 1e-9)
      mismatched.push(`--budget ${BUDGET_CAP} を指定したのに ${result.budget} で解いている`);
for (const result of solved)
  if (result.effectiveTargetLimit !== undefined && result.effectiveTargetLimit !== result.limit)
    mismatched.push(
      `--limits に ${result.limit} を指定したのに ${result.effectiveTargetLimit} で解いている`,
    );
if (INJECT_RUNNING > 0)
  for (const result of solved)
    if (result.runningCount !== INJECT_RUNNING)
      mismatched.push(
        `--running ${INJECT_RUNNING} を指定したのに走行中 ${result.runningCount} で解いている`,
      );
for (const result of solved)
  if (result.deliverDelayMs !== undefined && result.deliverDelayMs !== DELIVER_DELAY_MS)
    mismatched.push(
      `--deliver-delay ${DELIVER_DELAY_MS} を指定したのに ${result.deliverDelayMs} で採否を見ている`,
    );
if (CLUSTER_CAP !== null)
  for (const result of solved)
    if (result.clusters !== undefined && result.clusters.cap > CLUSTER_CAP)
      mismatched.push(
        `--cluster-cap ${CLUSTER_CAP} を指定したのに ${result.clusters.cap} で解いている`,
      );
if (mismatched.length > 0) {
  report.knobMismatch = [...new Set(mismatched)];
  throw new Error(`指定した摘みが効いていない：${[...new Set(mismatched)][0]}`);
}

await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
console.log(
  JSON.stringify(
    {
      report: resolve(output),
      scenes: report.sceneCount,
      compared: report.rows.filter((row) => row.planRequested).length,
      failures: report.rows.filter((row) => row.failure).length,
      errors: report.errors.length,
    },
    null,
    2,
  ),
);
