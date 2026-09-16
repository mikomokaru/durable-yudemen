import { readFileSync, statSync } from "node:fs";
import { isRecord } from "../../src/domain/predicate";
import { summarizeCpsatObservations } from "../../src/observe/cpsat";

// 入力は { coverage, rows }。Workers の生ログからの抽出・取得証明は別工程で行う。
// 読めた行の最小／最大時刻から coverage を作ると、欠測を検出できなくなるため自動生成しない。
try {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) throw new Error("usage");
  if (statSync(path).size > 32 * 1024 * 1024) throw new Error("size");
  const input: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(input) || !Array.isArray(input.rows)) throw new Error("shape");
  const summary = summarizeCpsatObservations(input.rows, input.coverage);
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = summary.usableForRates ? 0 : 1;
} catch {
  // パス・生の行・例外本文をエラー出力へ流さない。
  console.error("Expected a readable JSON file (up to 32 MiB) containing coverage and rows.");
  process.exitCode = 2;
}
