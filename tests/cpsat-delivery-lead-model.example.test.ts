// tests/cpsat-delivery-lead-model.example.test.ts — **見込みの遅れが本当にモデルへ届いている**ことを
// 実 WASM で押さえる（2026-09-14）。
//
// **Validates: cpsat-planner-integration R5.4, R6.2**
//
// `cpsat-delivery-lead.example.test.ts` が押さえるのは受理側の性質（遅れて届いた過去開始の計画は
// 採用されない）である。こちらが押さえるのは**送り出す側**——`planCpsat` が組む計画の最も早い
// 開始時刻が、解いた時刻より `CPSAT_DELIVERY_LEAD_MS` 以上あとであること。
//
// **摘みが黙って届かない事故を 3 度やっている**（`shape` を渡し忘れ／予算の上限が縛らない／
// 整理で落ちる）。いずれも結果は返るので、値を見比べない限り気づけない。`formulate` の第 2 引数を
// 「今」へ戻しても解は返り、status も objective も正常に見える——本番で棄却されるまで分からない。
//
// 実行は harness（`run-replay.mjs`）へ委ねる。実 WASM を Miniflare へ載せる必要があり、vitest の
// worker pool から同じ構成を組むと二重管理になる（`cpsat-cumulative-encoding.example.test.ts` と
// 同じ置き方）。コーパスは実データ（`docs/data_samples/noodle_plan_histories`）で、局面は本番の
// 取り込み経路（`StoreTimerDO.receiveRecords`）が作る。
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { CPSAT_DELIVERY_LEAD_MS } from "../src/cpsat/request";

/** 本番実測の最大の遅れ（2026-09-14・60 分・n=320）。この遅れで届いても採用されること。 */
const OBSERVED_MAX_LAG_MS = 6_619;

interface Row {
  readonly results?: readonly {
    readonly ok: boolean;
    readonly earliestStartOffsetMs: number;
    readonly acceptedSlices: number;
    readonly deliverDelayMs: number;
  }[];
}

it("CP-SAT の計画は「今」ではなく「受領の見込み時刻」から置き始める（実 WASM）", async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), "cpsat-lead-test-"));
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
      "--deliver-delay",
      String(OBSERVED_MAX_LAG_MS),
    ],
    { stdio: "pipe" },
  );
  const report = JSON.parse(await readFile(output, "utf8")) as {
    readonly rows: readonly Row[];
    readonly errors: readonly unknown[];
  };
  expect(report.errors).toEqual([]);
  const solved = report.rows.flatMap((row) => row.results ?? []).filter((result) => result.ok);
  expect(solved.length).toBeGreaterThan(0);
  for (const result of solved) {
    // 送り出す側。最も早い配置が見込みの遅れより先にある。
    expect(result.earliestStartOffsetMs).toBeGreaterThanOrEqual(CPSAT_DELIVERY_LEAD_MS);
    // 受理する側。実測の最大の遅れで届いても、その計画は採用される。
    expect(result.deliverDelayMs).toBe(OBSERVED_MAX_LAG_MS);
    expect(result.acceptedSlices).toBeGreaterThan(0);
  }
}, 120_000);
