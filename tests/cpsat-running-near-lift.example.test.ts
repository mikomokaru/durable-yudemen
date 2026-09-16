// tests/cpsat-running-near-lift.example.test.ts — **lead の窓の内側で上がる走行中**で求解が落ちない。
//
// **Validates: cpsat-planner-integration R5.5, R6.6**
//
// **これは本番で出た欠陥の回帰試験である**（2026-09-13・`yamaokaya-1108` で `CP-SAT invariant failed` 3 件）。
//
// モデルの「今」は受領の見込み時刻（今 ＋ `CPSAT_DELIVERY_LEAD_MS` ＝ 8 秒）である。**走行中の
// タイマーはそれより前に上がりうる**——残り 3 秒の麺は、計画が届く頃にはもう上がっている。
// ところが 2 か所が「何も『今』より前には上がらない」と仮定していた。
//
//   1. 走行中の `end` の定義域を `max(now + 1, r.end)` 〜 `r.end` で作っていた
//      → `r.end < now + 1` で**下限が上限を追い越し**、変数の生成で落ちる（`CP-SAT invariant failed`）
//   2. クラスタ時刻の下限を `now + 1` にしていた
//      → 走行中の `end` がどのクラスタ時刻にも一致できず `INFEASIBLE`
//
// **1 を直すと 2 が出る**という重なり方だったので、両方を固定する。実測では残り 3 秒の走行中を
// 2 本入れるだけで 6 局面すべてが落ちた。**走行中のある局面は人が操作している店にしか現れない**
// ので、コーパス（開始履歴を持たない）だけでは永久に踏めない。
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { CPSAT_DELIVERY_LEAD_MS } from "../src/cpsat/request";

interface Report {
  readonly rows: readonly { readonly results?: readonly { readonly ok: boolean }[] }[];
  readonly errors: readonly unknown[];
}

async function solved(endsInMs: number): Promise<{ ok: number; total: number }> {
  const scratch = await mkdtemp(resolve(tmpdir(), "cpsat-near-lift-"));
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
      "3",
      "--running",
      "2",
      "--running-ends",
      String(endsInMs),
    ],
    { stdio: "pipe" },
  );
  const report = JSON.parse(await readFile(output, "utf8")) as Report;
  expect(report.errors).toEqual([]);
  const results = report.rows.flatMap((row) => row.results ?? []);
  return { ok: results.filter((result) => result.ok).length, total: results.length };
}

it("**lead の窓の内側で上がる走行中があっても解ける**（残り 1 秒）", async () => {
  // 1 秒後に上がる麺。lead（8 秒）よりずっと手前で、旧い実装はここで全滅した。
  expect(CPSAT_DELIVERY_LEAD_MS).toBeGreaterThan(1_000);
  const near = await solved(1_000);
  expect(near.total).toBeGreaterThan(0);
  expect(near.ok).toBe(near.total);
}, 180_000);

it("lead の窓の外で上がる走行中でも従来どおり解ける（残り 20 秒）", async () => {
  const far = await solved(20_000);
  expect(far.total).toBeGreaterThan(0);
  expect(far.ok).toBe(far.total);
}, 180_000);
