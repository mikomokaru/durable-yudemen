// tests/cpsat-boiled-slot-hint.example.test.ts — **貪欲 hint が「使えない釜」を選ばない**。
//
// **Validates: cpsat-planner-integration R6.5, R6.6**
//
// **これは本番の求解失敗（`status=UNKNOWN`）の原因だった**（2026-09-15・失敗局面 47 件の分析で特定）。
//
// 茹で上がって Complete を待っている釜（`boiled`）と、実効終了を過ぎた走行中の釜は、CP-SAT へ
// **`unavailableSlots`（そこに何も置くな）**として渡る。ところが貪欲 hint は「空くのが早い釜」から
// 取るだけで、その集合を見ていなかった——**`release`（解放表）は上がった釜を「いま空いている」と
// 見なす**ので、貪欲は真っ先にそこを選ぶ。選べば hint はモデルの制約（`presence = 0`）を破り、
// **ソルバーは最初の実行可能解を自力で探す羽目になって予算内に見つけられない。**
//
// **「前回と同じ釜」の枝だけは検査していた。** 既定の枝に同じ検査が無かったという非対称である。
//
// 本番の失敗局面の実測：走行中 136 本のうち **103 本（76%）が「既に上がっている」**、
// 47 局面のうち 30 が**全部が過去**。1125 には 12 日前に上がったまま Complete されていない
// タイマーが 2 本あった。
//
// **走行中のある局面は人が操作している店にしか現れない**ので、コーパス（開始履歴を持たない）
// だけでは永久に踏めない。`--running-ends` に**負**を渡して合成する。
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { cpsatCorpusAvailable } from "./cpsat-corpus";

interface Report {
  readonly rows: readonly { readonly results?: readonly { readonly ok: boolean }[] }[];
  readonly errors: readonly unknown[];
}

async function solved(endsInMs: number, extra: readonly string[] = []) {
  const scratch = await mkdtemp(resolve(tmpdir(), "cpsat-boiled-"));
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
      "--running",
      "3",
      "--running-ends",
      String(endsInMs),
      ...extra,
    ],
    { stdio: "pipe" },
  );
  const report = JSON.parse(await readFile(output, "utf8")) as Report;
  expect(report.errors).toEqual([]);
  const results = report.rows.flatMap((row) => row.results ?? []);
  return { ok: results.filter((result) => result.ok).length, total: results.length };
}

it.skipIf(!cpsatCorpusAvailable)(
  "**既に上がっている走行中があっても解ける**（残り −60 秒）",
  async () => {
    const past = await solved(-60_000);
    expect(past.total).toBeGreaterThan(0);
    expect(past.ok).toBe(past.total);
  },
  180_000,
);

it.skipIf(!cpsatCorpusAvailable)(
  "**その局面の hint 自体がモデルの制約を満たす**（固定して解けることで示す）",
  async () => {
    // hint を固定して解いて答えが返れば、hint は実行可能である。旧実装はここで `INFEASIBLE` になった。
    const pinned = await solved(-60_000, ["--fix-hints"]);
    expect(pinned.total).toBeGreaterThan(0);
    expect(pinned.ok).toBe(pinned.total);
  },
  180_000,
);

it.skipIf(!cpsatCorpusAvailable)(
  "何日も前に上がったまま Complete されていない走行中でも解ける（実測にあった局面）",
  async () => {
    // 本番の `yamaokaya-1125` に、12.07 日前（−1,043,026 秒）に上がったタイマーが 2 本あった。
    const ancient = await solved(-1_043_026_000);
    expect(ancient.total).toBeGreaterThan(0);
    expect(ancient.ok).toBe(ancient.total);
  },
  180_000,
);
