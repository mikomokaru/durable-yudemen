// tools/observe/probe-cli.ts — Probe CLI エントリ（観測ハーネスの実行体・Node ランタイムの端）。
//
// このファイルは観測クライアント（`probe`）の唯一の実行体エントリである。確定した CLI コマンド名
// `probe` に対応し、Probe_Client 本体（probe.ts）・突き合わせ CLI（correlate-cli.ts）と同じ
// `tools/observe/` 配下に置く。判定や I/O の実体は持たず、既存の端関数を「配線するだけ」の薄い殻である。
//
// 配線の順序（要件1.1 / 1.3 / 3.8）:
//   validateProbeArgs（引数検証・純粋）
//     → 不正なら接続せず Operation_Log に記録して非ゼロ終了（要件1.1）
//   → scenario ファイル読込・validateScenario（シナリオ検証・純粋）
//     → 不正なら記録して非ゼロ終了
//   → connectProbe（WS 接続・端）
//     → 失敗/タイムアウトなら記録して非ゼロ終了（要件1.3）
//   → runScenario（シナリオ実時間駆動・端）
//     → 返った終了コードでそのまま終了（0 は全ステップ完了・要件3.8）
//
// 責務境界の不変点:
//  - **process.argv / process.env / process.exit を読む・呼ぶのはこのファイルだけ**である。
//    他の層（src/observe の純粋関数・probe.ts / runner.ts の端）はこれらに触れない。
//  - 接続・送受信・ログ書き込み・実時間スケジューリングのロジックはここに再実装しない
//    （connectProbe / openOperationLog / runScenario へ委ねる。重複させない）。
//  - **ユーザー向け出力（ヘルプ・エラー表示）は英語のみ**（要件9.4）。コードコメントは日本語。
//
// 実行方法（TS ランナーは本プロジェクトの依存に含めない方針のため、ワンショットで起動する）:
//   pnpm dlx tsx tools/observe/probe-cli.ts <wss-endpoint> <store-id> <scenario.json> <operation-log.jsonl>

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { validateProbeArgs } from "../../src/observe/args";
import { validateScenario } from "../../src/observe/scenario";
import type { UnsequencedOperationEntry } from "../../src/observe/log";

import { connectProbe, openOperationLog } from "./probe";
import type { OperationLogSink, ProbeConnection } from "./probe";
import { runScenario } from "./runner";

// ── 終了コード（correlate-cli.ts と同じ sysexits 慣習に倣う） ──────────────────
// runScenario が返す 0/非ゼロ（要件3.8）を成功/失敗の基準とし、配線段の失敗は EXIT_FAILURE、
// 引数の個数誤り（誤用）は EXIT_USAGE で表す。
const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 64; // 引数不足・誤用（EX_USAGE）

/** CLI が要求する位置引数の個数（endpoint / storeId / scenario / output-log）。 */
const REQUIRED_ARG_COUNT = 4;

// ── 配線条件の診断記録（接続が無い段階での記録は Operation_Log へ直接追記する） ──
//
// 引数不正・シナリオ不正・接続失敗は「接続が確立する前にハーネスが観測した条件」である。
// runner.ts の診断記録の慣習（direction "recv"・既存ワイヤ種別と衝突しない messageType・
// payload に理由）にならい、recv（観測）として Operation_Log に残す。messageType は
// start/cancel/snapshot/started/cancelled/done/error のいずれとも衝突しない診断名とし、
// Correlator の検証（done 等の種別を見る）には不活性なまま証跡として残る。

/** 起動引数が不正だった条件の診断記録（要件1.1）。接続は試行していない。 */
function buildArgsInvalidEntry(at: number, reason: string): UnsequencedOperationEntry {
  return {
    at,
    atIso: new Date(at).toISOString(),
    direction: "recv",
    messageType: "args-invalid",
    payload: { reason },
  };
}

/** シナリオが不正だった条件の診断記録。読込/解析失敗も検証失敗もここに集約する。 */
function buildScenarioInvalidEntry(at: number, reason: string): UnsequencedOperationEntry {
  return {
    at,
    atIso: new Date(at).toISOString(),
    direction: "recv",
    messageType: "scenario-invalid",
    payload: { reason },
  };
}

/** 接続確立に失敗した条件の診断記録（要件1.3）。タイムアウト・確立失敗の理由を残す。 */
function buildConnectFailedEntry(at: number, reason: string): UnsequencedOperationEntry {
  return {
    at,
    atIso: new Date(at).toISOString(),
    direction: "recv",
    messageType: "connect-failed",
    payload: { reason },
  };
}

// ── シナリオファイルの読込・解析（端の I/O） ──────────────────────────────────

/** シナリオ読込の結果。成功なら検証前の生 JSON 値、失敗なら理由（英語）を持つ。 */
type ScenarioSource =
  | { readonly ok: true; readonly raw: unknown }
  | { readonly ok: false; readonly reason: string };

/**
 * シナリオファイルを読み JSON として解析する（検証は validateScenario が行う・要件3.1）。
 * 読込失敗・JSON 解析失敗はいずれも「シナリオが不正」という一つの条件に畳み込み、理由を英語で持つ。
 */
function readScenarioFile(filePath: string): ScenarioSource {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    return { ok: false, reason: `cannot read scenario file: ${toMessage(error)}` };
  }
  try {
    return { ok: true, raw: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, reason: `scenario file is not valid JSON: ${toMessage(error)}` };
  }
}

/** Error/非 Error を表示用メッセージへ畳む。 */
function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── 使い方（英語・要件9.4） ──────────────────────────────────────────────────

function usage(): string {
  return [
    "Usage: probe <wss-endpoint> <store-id> <scenario.json> <operation-log.jsonl>",
    "",
    "  wss-endpoint         WebSocket endpoint (must use the wss:// scheme).",
    "  store-id             Store identifier (must not be empty).",
    "  scenario.json        Declarative scenario file (JSON) driving start/cancel/wait/await-done.",
    "  operation-log.jsonl  Output path for the Operation_Log (JSON Lines).",
    "",
    "Connects to the endpoint, runs the scenario in real time, and records every",
    "sent/received message to the Operation_Log. Exits 0 when all steps complete.",
  ].join("\n");
}

// ── CLI 本体（配線のみ） ──────────────────────────────────────────────────────

/**
 * CLI 本体。argv の位置引数を読み、検証 → 接続 → シナリオ駆動を配線し、終了コードを返す。
 * process.exit はここでは呼ばず、呼び出し側（直接実行ガード）が返り値で終了する。
 */
async function main(args: readonly string[]): Promise<number> {
  // 引数の個数が揃わなければ、ログ出力先も定まらないため使い方を表示して誤用終了する。
  if (args.length !== REQUIRED_ARG_COUNT) {
    console.error(usage());
    return EXIT_USAGE;
  }

  // noUncheckedIndexedAccess 下でも個数を検証済みなので、ここでの取り出しは安全。
  const [rawEndpoint, rawStoreId, scenarioPath, outputLogPath] = args as readonly [
    string,
    string,
    string,
    string,
  ];

  // Operation_Log の追記口を開く。以降の配線条件（引数不正・シナリオ不正・接続失敗）は
  // すべてこの sink へ記録する。seq は sink が 0 から採番する。
  const log: OperationLogSink = openOperationLog(outputLogPath);

  // 1) 起動引数の検証（純粋・要件1.1）。不正なら接続を試みず記録して非ゼロ終了する。
  const argsResult = validateProbeArgs(rawEndpoint, rawStoreId);
  if (!argsResult.ok) {
    await log.record(buildArgsInvalidEntry(Date.now(), argsResult.reason));
    console.error(`Invalid arguments: ${describeArgReason(argsResult.reason)}`);
    return EXIT_FAILURE;
  }

  // 2) シナリオの読込・解析・検証（純粋検証・要件3.1）。不正なら記録して非ゼロ終了する。
  const source = readScenarioFile(scenarioPath);
  if (!source.ok) {
    await log.record(buildScenarioInvalidEntry(Date.now(), source.reason));
    console.error(`Invalid scenario: ${source.reason}`);
    return EXIT_FAILURE;
  }
  const scenarioResult = validateScenario(source.raw);
  if (!scenarioResult.ok) {
    await log.record(buildScenarioInvalidEntry(Date.now(), scenarioResult.reason));
    console.error(`Invalid scenario: ${scenarioResult.reason}`);
    return EXIT_FAILURE;
  }

  // 3) WS 接続の確立（端・要件1.2 / 1.3）。失敗/タイムアウトなら記録して非ゼロ終了する。
  let connection: ProbeConnection;
  try {
    connection = await connectProbe(argsResult.endpoint, argsResult.storeId);
  } catch (error) {
    const reason = toMessage(error);
    await log.record(buildConnectFailedEntry(Date.now(), reason));
    console.error(`Connection failed: ${reason}`);
    return EXIT_FAILURE;
  }

  // 4) シナリオを実時間で駆動し、その終了コードでそのまま終了する（要件3.8）。
  //    全ステップ完了なら 0、タイムアウト/接続未確立/送信失敗なら非ゼロ。
  return runScenario(scenarioResult.scenario, connection, log);
}

/** 引数拒否理由を英語の説明へ写す（要件9.4）。 */
function describeArgReason(reason: "NotWssScheme" | "EmptyStoreId"): string {
  return reason === "NotWssScheme"
    ? "endpoint must use the wss:// scheme"
    : "store id must not be empty";
}

// このモジュールが直接実行されたときのみ CLI として動かす（import 時は副作用なし）。
if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (exitCode) => {
      process.exit(exitCode);
    },
    (error: unknown) => {
      // 予期しない失敗も英語で報告し、非ゼロ終了する（要件9.4）。
      console.error(`Unexpected failure: ${toMessage(error)}`);
      process.exit(EXIT_FAILURE);
    },
  );
}

export { main, EXIT_SUCCESS, EXIT_FAILURE, EXIT_USAGE };
