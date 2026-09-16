// tests/cpsat-head-slot-stability.example.test.ts — **間もなく始まる杯の釜が動かない**。
//
// **Validates: cpsat-planner-integration R4.7, plan-stability R2.2**
//
// 現場から「サジェストの釜がパタパタ動く」という観察があった（2026-09-15・`yamaokaya-1108`）。
// 本番の実測では対応した 463 杯のうち 95 杯（21%）が受領のたびに別の釜へ移っていた。
//
// **守る範囲を現場の見え方に合わせる。** 1 時間後に茹でる杯の釜が変わっても画面には見えない
// ——動いて見えるのは**手を伸ばしている先**である。ゆえに `slotChangeCost` を一律に上げるのでは
// なく、**前回の提案で間もなく始まる杯（Head 近傍）だけ**を重くする（`headSlotChangeFactor`）。
// 一律に上げると遠くの杯まで硬直し、待ちや同時提供の項を押し退ける。
//
// **ハード制約にしない。** 前回の釜が塞がった局面で強制すれば解が消える——釜を変えたほうが
// 明らかに良い場面は実在する。高い値段を払ってでも変えるべきなら、ソルバーがそう決めてよい。
//
// **測り方が肝心である。** 同じ待ち行列を 2 度解いても揺れは出ない（入力が同じなら答えも同じ）。
// 本番の連続する 2 回の間には必ず何かが起きているので、**待ち行列を 1 件ずらして解き直す**。
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { cpsatCorpusAvailable } from "./cpsat-corpus";

interface Chain {
  readonly compared: number;
  readonly slotChanged: number;
  readonly headCompared: number;
  readonly headSlotChanged: number;
}

async function churn(flags: readonly string[]): Promise<Chain> {
  const scratch = await mkdtemp(resolve(tmpdir(), "cpsat-head-"));
  const output = resolve(scratch, "report.json");
  execFileSync(
    process.execPath,
    [
      "experiments/cpsat-workers/quality/run-replay.mjs",
      output,
      "--limits",
      "24",
      // **局面数を絞らない。** `--max 8` では一律の重みでも Head が動かない局面ばかりで、
      // **負の対照が立たなかった**（2026-09-15）。揺れは待ち行列が少ない局面で出るので、
      // それを含む幅が要る。
      "--per-file",
      "3",
      "--max",
      "12",
      "--deliver-delay",
      "5000",
      "--chain-shown",
      // **求解の最中に釜が埋まる局面で測る（2026-09-15）。** 走行中が変わらない局面だけを見ていた
      // ため、40 倍で「0%」と測っていたのに本番では 11% 動いていた——押しまくっている現場では、
      // 求解を始めた時点と届いた時点で釜の状況が別物になる。
      "--running",
      "6",
      "--running-ends",
      "300000",
      "--chain-running-delta",
      "2",
      ...flags,
    ],
    { stdio: "pipe" },
  );
  const report = JSON.parse(await readFile(output, "utf8")) as {
    readonly rows: readonly { readonly results?: readonly { readonly chain: Chain | null }[] }[];
    readonly errors: readonly unknown[];
  };
  expect(report.errors).toEqual([]);
  const total = { compared: 0, slotChanged: 0, headCompared: 0, headSlotChanged: 0 };
  for (const row of report.rows)
    for (const result of row.results ?? []) {
      if (result.chain === null) continue;
      total.compared += result.chain.compared;
      total.slotChanged += result.chain.slotChanged;
      total.headCompared += result.chain.headCompared;
      total.headSlotChanged += result.chain.headSlotChanged;
    }
  return total;
}

// **2026-09-16 に止めた。CP-SAT への経路を閉じたため（`PLANNER_BACKEND: "ts"`）。**
//
// 期待値 0 は正しく、実測 1 の側に欠陥がある。`--hold-head` で判定済み——動いた杯の釜だけを
// 前回の釜へ固定して解き直すと `FEASIBLE` で、しかもモデル目的値が **15,136 良い**。
// 制約を足して目的値が下がる以上、自由に解いた側がより良い解を見落としている
// （必要な取引ではなく探索上の後退）。開始まで 8 秒の杯で起きている。
//
// **期待値は緩めていない。** CP-SAT を再開するときはこの skip を外し、先にこの後退を直すこと。
// 次に見るべきは「2 度目の求解の hint が前回の釜を持っていたか」——持っていて動いたなら
// 目的関数か探索、持っていなければ `rememberSlots` が chain 経路で効いていない hint の不具合。
// 経緯は .kiro/specs/cpsat-planner-integration/verification/ordered-hint-inversion-cost-20260915.md。
//
// なお、この試験は局面の「今」に `Date.now()` を使うため判定が揺れる。戻すときは
// `--now <epochMs>`（2026-09-16 に追加）で固定すること。固定すれば 43 対 1 で再現する。
it.skip("**間もなく始まる杯の釜は動かない**（既定の重み）", async () => {
  const now = await churn([]);
  expect(now.headCompared).toBeGreaterThan(10);
  expect(now.headSlotChanged).toBe(0);
}, 180_000);

it.skipIf(!cpsatCorpusAvailable)(
  "**負の対照**——重みを一律（倍率 1）に戻すと動く",
  async () => {
    const flat = await churn(["--head-factor", "1"]);
    expect(flat.headCompared).toBeGreaterThan(10);
    // 本番と同じ桁の揺れが出る。**試験に歯があることの根拠。**
    expect(flat.headSlotChanged).toBeGreaterThan(0);
  },
  180_000,
);
