// tests/cpsat-slot-stability.example.test.ts — **連続する計画で釜が入れ替わらない**ことを固定する。
//
// **Validates: cpsat-planner-integration R4.7, plan-stability R2.2**
//
// **これは本番で見えていた欠陥の回帰試験である**（2026-09-13・`yamaokaya-1108`）。対応した杯の
// **16/16・23/23・22/22——ほぼ全数が受領のたびに別の釜へ移っていた**。
//
// 原因は `slotChangeCost` の不在ではなく **hint** だった。解は `FEASIBLE`（予算内で打ち切り）なので
// ソルバーは hint の近くを返すが、その hint は毎回「空くのが早い釜」からゼロで選び直しており、
// 前回と同じ釜へ戻る理由が無かった。**費用はモデルに在っても、探索がそこへ行き着く前に予算が尽きる。**
//
// **測り方が肝心である。** 同じ待ち行列を 2 度解いても揺れは出ない（入力が同じなら答えも同じ）。
// 本番の連続する 2 回の間には必ず何かが起きている——**待ち行列を 1 件ずらして解き直す**ことで
// 初めて現場の揺れが測れる。実測：旧い形 93%、前回の釜を hint に使うと 0%。
//
// 実行は harness（`run-replay.mjs`）へ委ねる。実 WASM を Miniflare へ載せる必要があるため。
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";

interface Report {
  readonly rows: readonly {
    readonly results?: readonly {
      readonly chain: { readonly compared: number; readonly slotChanged: number } | null;
    }[];
  }[];
  readonly errors: readonly unknown[];
}

async function churn(flags: readonly string[]): Promise<{ compared: number; changed: number }> {
  const scratch = await mkdtemp(resolve(tmpdir(), "cpsat-slot-test-"));
  const output = resolve(scratch, "report.json");
  execFileSync(
    process.execPath,
    [
      "experiments/cpsat-workers/quality/run-replay.mjs",
      output,
      "--limits",
      "24",
      "--per-file",
      "1",
      "--max",
      "4",
      "--deliver-delay",
      "5000",
      "--chain-shown",
      ...flags,
    ],
    { stdio: "pipe" },
  );
  const report = JSON.parse(await readFile(output, "utf8")) as Report;
  expect(report.errors).toEqual([]);
  const chains = report.rows.flatMap((row) => row.results ?? []).map((result) => result.chain);
  let compared = 0;
  let changed = 0;
  for (const chain of chains) {
    if (chain === null) continue;
    compared += chain.compared;
    changed += chain.slotChanged;
  }
  return { compared, changed };
}

it("**連続する計画で釜が入れ替わらない**（前回の釜を hint に使う）", async () => {
  const now = await churn([]);
  expect(now.compared).toBeGreaterThan(20);
  // 前回と同じ釜が使えるのに移った杯は 1 つも無い。
  expect(now.changed).toBe(0);
}, 180_000);

it("**負の対照**——前回の釜を見ない旧い形では、ほぼ全数が別の釜へ移る", async () => {
  const legacy = await churn(["--legacy-hint-slots"]);
  expect(legacy.compared).toBeGreaterThan(20);
  // 本番の実測（16/16・23/23・22/22）と同じ桁の揺れが出る。**試験に歯があることの根拠。**
  expect(legacy.changed / legacy.compared).toBeGreaterThan(0.5);
}, 180_000);
