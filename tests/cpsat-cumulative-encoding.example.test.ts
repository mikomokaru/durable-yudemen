// tests/cpsat-cumulative-encoding.example.test.ts — `cumulative` の符号化が**本当に効いている**ことを固定する。
//
// **Validates: cpsat-planner-integration R4.4, R6.1, R9.9**
//
// **field 番号を取り違えた符号化は、静かに無視されて解が返る。** 制約を書いたつもりで書けていない
// という最悪の形で、objective も status も正常に見える。ゆえに「制約が無ければ通る解が、
// 制約を入れると通らないこと」を見る——これが唯一の観測可能な違いである。
//
// 仕掛けは 3 本の区間（長さ 10・需要 1）を置き、開始時刻の和を最小化するだけのモデルである。
//   ・制約が無い／無視される → 3 本とも 0 に置けて和は 0
//   ・容量 2 が効く         → 同時は 2 本まで。3 本目は 10 以降で和は 10
//   ・容量 1 が効く         → 1 本ずつ。和は 30
//
// 実行は harness（`probe-cumulative.mjs`）へ委ねる。実 WASM を Miniflare へ載せる必要があり、
// vitest の worker pool から同じ構成を組むと二重管理になる（`cpsat-real-model.example.test.ts`
// と同じ置き方）。
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("cumulative の容量が最適値を動かす（無視されていない）", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "cpsat-cumulative-test-"));
  const output = resolve(scratch, "report.json");
  execFileSync(
    process.execPath,
    ["experiments/cpsat-workers/quality/probe-cumulative.mjs", output],
    { stdio: "pipe" },
  );
  const report = JSON.parse(await readFile(output, "utf8")) as {
    readonly cloudEvidence: boolean;
    readonly rows: readonly {
      readonly name: string;
      readonly cap: number;
      readonly withConstraint: boolean;
      readonly status: string;
      readonly objective: number;
    }[];
  };

  // ローカルの成功を cloud の成功としない（R9.6）。
  expect(report.cloudEvidence).toBe(false);
  const by = (name: string) => report.rows.find((row) => row.name === name);
  for (const row of report.rows) expect(row.status).toBe("OPTIMAL");

  // 対照。仕掛け自体が壊れていれば、以下の主張は何も語らない。
  expect(by("制約なし（対照）")?.objective).toBe(0);
  // 容量が十分なら制約は結果を変えない。
  expect(by("容量 3（緩い）")?.objective).toBe(0);
  // ここが本題。**動かなければ符号化が無視されている。**
  expect(by("容量 2（効くはず）")?.objective).toBe(10);
  expect(by("容量 1（さらに効く）")?.objective).toBe(30);
});
