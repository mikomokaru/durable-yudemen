// tests/cpsat-real-model.example.test.ts — 実モデルの CP-SAT 経路が通ることを固定する。
//
// **Validates: cpsat-planner-integration R6.1, R6.5, R6.8, R9.9**
//
// ここまでの試験はすべて**固定問題**（同梱 fixture の protobuf）だった。輸送の性質を測るには
// それで足りたが、`src/cpsat/plan.ts` の実モデル生成——`formulate` → protobuf → CP-SAT →
// 検証 → `CookSchedule`——は 2026-09-12 まで一度も検証されていなかった。ここで閉じる。
//
// 実行は harness（`check-cpsat-local.mjs`）へ委ねる。実 WASM を Miniflare へ載せる必要があり、
// vitest の worker pool から同じ構成を組むと二重管理になるためである（既存の
// `cpsat-transport-app.example.test.ts` と同じ置き方）。
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("実モデルで計画対象 1〜6 件を解き、配置が茹で時間と一致する", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "cpsat-real-test-"));
  const output = resolve(scratch, "report.json");
  execFileSync(
    process.execPath,
    ["experiments/cpsat-workers/transport/check-cpsat-local.mjs", output],
    { stdio: "pipe" },
  );
  const report = JSON.parse(await readFile(output, "utf8")) as {
    readonly cloudEvidence: boolean;
    readonly bundleIncludes: readonly string[];
    readonly cases: readonly {
      readonly pending: number;
      readonly ok: boolean;
      readonly status: string | null;
      readonly variables: number | null;
      readonly placements: number | null;
      readonly firstPlacement: { readonly startAt: number; readonly serveAt: number } | null;
    }[];
  };

  // ローカルの成功を cloud の成功としない（R9.6）。
  expect(report.cloudEvidence).toBe(false);
  // 実モデル生成が束ねられていること。固定 fixture へすり替わっていたら、この試験は
  // 何も主張していない。
  expect(report.bundleIncludes).toContain("src/cpsat/plan.ts");
  expect(report.bundleIncludes.some((path) => /tuning\/schedule/.test(path))).toBe(true);

  expect(report.cases).toHaveLength(4);
  for (const entry of report.cases) {
    expect(entry.ok, `計画対象 ${entry.pending} 件が解けない`).toBe(true);
    // 打ち切りでも実行可能解なら採用候補にできる（R6.5）。証明は要求しない。
    expect(["OPTIMAL", "FEASIBLE"]).toContain(entry.status);
    // 全件が配置されること——処理できなかった品目を落として成功にしない（R6.4）。
    expect(entry.placements).toBe(entry.pending);
    expect(entry.variables).toBeGreaterThan(0);
  }
  // 配置の中身が茹で時間と噛み合うこと。件数だけ見ていると、形の壊れた計画に気づけない。
  // 既定プリセット `Thin` の `normal` は 60 秒である。
  const first = report.cases[0]?.firstPlacement;
  expect(first).not.toBeNull();
  expect((first?.serveAt ?? 0) - (first?.startAt ?? 0)).toBe(60_000);
}, 120_000);
