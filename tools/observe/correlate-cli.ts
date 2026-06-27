// tools/observe/correlate-cli.ts — 突き合わせ CLI（Node ランタイムの端・I/O）。
//
// 二つのログ（Operation_Log: JSONL ファイル / Instrumentation_Log: `wrangler tail` で
// 収集したテキスト）を読み、src/observe/ の純粋関数だけで判定する薄い殻である。
// 本ファイルに判定ロジックは一切置かない——パース→マージ→分類→判定はすべて
// src/observe/correlate.ts・src/observe/log.ts の純粋関数へ委ね、CLI は
//   (1) ファイル読み込み、(2) 純粋関数の呼び出し、(3) 結果の整形・出力、(4) 終了コード決定
// だけを担う（design.md「計算と作用の分離を観測ハーネスにも適用する」）。
//
// ユーザー向け出力はすべて英語（要件9.4）。コードコメントは日本語。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  parseInstrumentationLine,
  parseOperationLog,
  type InstrumentationLogEntry,
} from "../../src/observe/log";
import {
  classifyInstances,
  determineVerdict,
  mergeByTime,
  type ConditionA,
  type ConditionB,
  type InstanceInterval,
  type MergedRow,
} from "../../src/observe/correlate";

// ── 終了コード（sysexits 慣習に倣う） ────────────────────────────────────────
// 判定区分そのものを終了コードへ写す。confirmed=成功、fail=失敗、inconclusive=判定保留。
const EXIT_CONFIRMED = 0;
const EXIT_FAIL = 1;
const EXIT_INCONCLUSIVE = 2;
const EXIT_USAGE = 64; // 引数不足・誤用（EX_USAGE）
const EXIT_NO_INPUT = 66; // ログファイルの読み込み失敗（EX_NOINPUT）

/** Instrumentation_Log（tail 収集テキスト）の解析結果。有効 entry と解析失敗行を分離する。 */
interface InstrumentationLogParse {
  readonly entries: readonly InstrumentationLogEntry[];
  readonly failures: readonly string[];
}

/**
 * `wrangler tail` 収集テキストを行ごとに parseInstrumentationLine へ通す（純粋関数の薄い反復）。
 * tail 出力には JSON でない行（接続メッセージ等）が混じりうるが、それらは failures に落ちるだけで
 * 有効 entry を取りこぼさない（log.ts の判別構造に委ねる）。空行は無視する。
 */
function parseInstrumentationLog(text: string): InstrumentationLogParse {
  const entries: InstrumentationLogEntry[] = [];
  const failures: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const result = parseInstrumentationLine(line);
    if (result.ok) {
      entries.push(result.entry);
    } else {
      failures.push(result.raw);
    }
  }
  return { entries, failures };
}

/**
 * 観測終了時刻 = 観測されたすべての行のうち最大の epoch ms。
 * これは判定ではなく「最後に観測した時刻」という素のデータ導出であり、classifyInstances の
 * observationEndAt と determineVerdict の observationWindowEndAt の双方へ渡す共通の観測境界とする。
 */
function latestObservedAt(merged: readonly MergedRow[]): number {
  let latest = 0;
  for (const row of merged) {
    if (row.at > latest) {
      latest = row.at;
    }
  }
  return latest;
}

/** 検証条件 a の 1 件を英語 1 行へ整形する。 */
function formatConditionA(condition: ConditionA): string {
  if (condition.verdict === "pass") {
    return `  [pass] timer ${condition.timerId}: alarm fired at or before done`;
  }
  const detail =
    condition.cause === "NoAlarm"
      ? "no alarm observed in idle interval"
      : "alarm observed after done";
  return `  [fail] timer ${condition.timerId}: ${detail} (${condition.cause})`;
}

/** 検証条件 b の 1 件を英語 1 行へ整形する。 */
function formatConditionB(condition: ConditionB): string {
  if (condition.verdict === "pass") {
    return `  [pass] rehydrate restored ${condition.restoredCount} timer(s), matching active count`;
  }
  return `  [fail] rehydrate restored ${condition.restoredCount} timer(s), but ${condition.expectedActive} were active`;
}

/** instanceId 区間の 1 件を英語 1 行へ整形する。 */
function formatInstance(interval: InstanceInterval): string {
  return `  ${interval.instanceId}  born=${interval.bornAt} end=${interval.endAt}  ${interval.classification}`;
}

/**
 * 純粋関数群を所定の順序で呼び、判定レポート（英語）を組み立てる。
 * パイプライン: parse → mergeByTime → classifyInstances → determineVerdict
 * （determineVerdict が内部で idle 区間を導出し検証条件 a/b を判定し、その内訳を結果として返す）。
 * 本関数は I/O を持たない（テキスト入力 → レポート文字列＋終了コード）。
 */
function correlate(
  operationLogText: string,
  instrumentationLogText: string,
): { readonly report: string; readonly exitCode: number } {
  const operation = parseOperationLog(operationLogText);
  const instrumentation = parseInstrumentationLog(instrumentationLogText);

  const merged = mergeByTime(operation.entries, instrumentation.entries);
  const observationEndAt = latestObservedAt(merged);
  const instances = classifyInstances(
    instrumentation.entries,
    operation.entries,
    observationEndAt,
  );
  const verdict = determineVerdict(merged, instances, observationEndAt);

  const lines: string[] = [
    "Hibernation Observability — Correlation Report",
    "",
    `Operation log:       ${operation.entries.length} entr(ies), ${operation.failures.length} parse failure(s)`,
    `Instrumentation log: ${instrumentation.entries.length} entr(ies), ${instrumentation.failures.length} parse failure(s)`,
    `Merged rows:         ${merged.length}`,
    `Observation end:     ${observationEndAt} (epoch ms)`,
    "",
    `Instances (${instances.length}):`,
    ...(instances.length === 0 ? ["  (none)"] : instances.map(formatInstance)),
    "",
  ];

  switch (verdict.kind) {
    case "confirmed":
    case "fail": {
      lines.push(`Verdict: ${verdict.kind.toUpperCase()}`);
      lines.push("");
      lines.push("Condition a (alarm fires during idle):");
      lines.push(
        ...(verdict.conditionA.length === 0
          ? ["  (no done events in idle interval)"]
          : verdict.conditionA.map(formatConditionA)),
      );
      lines.push("");
      lines.push("Condition b (rehydrate count matches active timers):");
      lines.push(
        ...(verdict.conditionB.length === 0
          ? ["  (no rehydrate after re-construct)"]
          : verdict.conditionB.map(formatConditionB)),
      );
      const exitCode = verdict.kind === "confirmed" ? EXIT_CONFIRMED : EXIT_FAIL;
      return { report: lines.join("\n"), exitCode };
    }
    case "inconclusive": {
      lines.push("Verdict: INCONCLUSIVE");
      lines.push("");
      lines.push("No hibernation wake signal (new instanceId + rehydrate) observed within the window.");
      return { report: lines.join("\n"), exitCode: EXIT_INCONCLUSIVE };
    }
  }
}

/** 使い方（英語）。 */
function usage(): string {
  return [
    "Usage: correlate-cli <operation-log.jsonl> <instrumentation-log.txt>",
    "",
    "  operation-log.jsonl     Operation_Log written by the Probe_Client (JSON Lines).",
    "  instrumentation-log.txt Instrumentation_Log collected via `wrangler tail` (text).",
    "",
    "Exit codes: 0 confirmed, 1 fail, 2 inconclusive, 64 usage error, 66 input error.",
  ].join("\n");
}

/**
 * CLI 本体。引数を読み、ファイルを読み、correlate を呼び、結果を出力し、終了コードを返す。
 * 判定は一切せず、I/O と終了コード決定のみを担う。
 */
function main(args: readonly string[]): number {
  if (args.length !== 2) {
    console.error(usage());
    return EXIT_USAGE;
  }
  const [operationLogPath, instrumentationLogPath] = args;

  let operationLogText: string;
  let instrumentationLogText: string;
  try {
    operationLogText = readFileSync(operationLogPath as string, "utf8");
    instrumentationLogText = readFileSync(instrumentationLogPath as string, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to read log file: ${message}`);
    return EXIT_NO_INPUT;
  }

  const { report, exitCode } = correlate(operationLogText, instrumentationLogText);
  console.log(report);
  return exitCode;
}

// このモジュールが直接実行されたときのみ CLI として動かす（import 時は副作用なし）。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}

export { correlate, main, parseInstrumentationLog };
