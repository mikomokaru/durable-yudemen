// tools/observe/runner.ts — Scenario_Runner（宣言的シナリオの実時間駆動・端・Node ランタイム）。
//
// この層は「実時間・スケジューリング・終了コードの決定」という作用に閉じる端である。
// シナリオの純粋な意味（整列・待機判定）は src/observe/scenario.ts に置き、ここはそれを呼ぶだけ
// （計算と作用の分離）。送受信とログ書き込みの I/O は Probe_Client（./probe.ts）に委ね、重複させない。
//
// hibernation 規律「待つなら寝かせる、抱えると漏れる」はハーネス自身にも適用する。各ステップは
// 「一度きりの遅延起動」であり、必ず解決する単一の setTimeout だけで表現する。setInterval も
// 終わらない setTimeout も持ち込まない（シナリオ完了で必ず終わる）。
//
// 判定（confirmed / fail 等）は一切行わない。runScenario は終了コードを返すだけで、process.exit は
// 呼ばない——終了コードの最終的な扱いは CLI エントリの責務である。

import { orderedSteps, shouldStopAwaiting } from "../../src/observe/scenario";
import type { Scenario, ScenarioStep } from "../../src/observe/scenario";
import type { UnsequencedOperationEntry } from "../../src/observe/log";
import type { ClientMessage, ServerMessage } from "../../src/domain/messages";

import { buildSentEntry, recordReceivedMessages } from "./probe";
import type { OperationLogSink, ProbeConnection } from "./probe";

/** 終了コード。0 は全ステップ完了、非ゼロは異常終了（タイムアウト / 接続未確立 / 送信失敗）。 */
const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

/**
 * 宣言的シナリオを実時間に沿って駆動する（要件3.2 / 3.6 / 3.7 / 3.8）。
 *
 * orderedSteps で相対時刻 at の昇順に整列したステップを順に処理する。各ステップは、その相対時刻に
 * 達するまで単一の setTimeout で待ってから操作を開始する（既に過ぎていれば即時＝250ms 以内・要件3.2）。
 *  - start / cancel: 既存 ClientMessage 形式で送信し、送信記録を Operation_Log へ追記する。
 *  - wait: その区間中コマンドを送らず、受信記録のみ継続する（要件3.3）。
 *  - await-done: 指定 timerId の done 受信か上限待機時間まで待つ。不一致の done も含め受信は全件記録され、
 *    待機は一致するまで継続する（要件3.4 / 3.5）。
 *
 * 操作実行時点で接続未確立なら接続未確立を記録して非ゼロ終了（要件3.7）。await-done が上限待機時間に
 * 達したらタイムアウトを記録して非ゼロ終了（要件3.6）。いずれもログは保持し、証跡保全のため接続は閉じない。
 * 全ステップ完了時のみ接続を閉じ、ゼロ終了する（要件3.8）。
 */
export async function runScenario(
  scenario: Scenario,
  connection: ProbeConnection,
  log: OperationLogSink,
): Promise<number> {
  // 受信全件を受信順・本文不改変で Operation_Log へ記録する配線（wait / await-done 中も継続・要件1.7 / 3.3 / 3.4）。
  recordReceivedMessages(connection, log);

  // await-done の待機解決のための受信監視。最新の待機対象だけを見る（同時に複数は待たない）。
  // 受信記録（上の配線）とは別の関心事——ここでは「指定 done が来たか」だけを純粋判定で見る。
  let pendingAwait: PendingAwait | null = null;
  connection.onMessage((raw) => {
    const awaiting = pendingAwait;
    if (awaiting === null) {
      return;
    }
    const message = parseServerMessage(raw);
    if (message !== null && shouldStopAwaiting(message, awaiting.targetTimerId)) {
      awaiting.onMatched();
    }
  });

  const startedAt = Date.now();

  // ステップは実時間に沿って「一つずつ順に」駆動する——前のステップ（特に wait / await-done）が
  // 終わってから次へ進むのが本ランナーの本質である。Promise.all による並列化は意味を壊すため、
  // ここでの逐次 await は意図的であり no-await-in-loop を無効化する。
  /* eslint-disable no-await-in-loop */
  for (const step of orderedSteps(scenario)) {
    // 一度きりの遅延起動。相対時刻 at に達するまで待つ（必ず解決する単一の setTimeout・要件3.2）。
    await delayUntil(startedAt + step.at);

    // 要件3.7: 操作実行時点で接続未確立なら、接続未確立を記録しログ保持のまま非ゼロ終了する。
    if (!connection.isOpen()) {
      await log.record(buildConnectionNotEstablishedEntry(Date.now(), step.op));
      return EXIT_FAILURE;
    }

    const failure = await runStep(step, connection, log, {
      register: (awaiter) => {
        pendingAwait = awaiter;
      },
      clear: () => {
        pendingAwait = null;
      },
    });
    if (failure !== null) {
      return failure;
    }
  }
  /* eslint-enable no-await-in-loop */

  // 要件3.8: 全ステップ完了で接続を閉じ、ログを確定しゼロ終了する。
  await connection.close();
  return EXIT_SUCCESS;
}

/** await-done の待機対象。受信監視ハンドラが done 一致時に onMatched を呼ぶ。 */
interface PendingAwait {
  readonly targetTimerId: string;
  readonly onMatched: () => void;
}

/** await-done の待機登録/解除口。runScenario の pendingAwait を端から操作する。 */
interface AwaitChannel {
  readonly register: (awaiter: PendingAwait) => void;
  readonly clear: () => void;
}

/**
 * 1 ステップの操作を実行する。正常完了なら null、異常終了なら終了コードを返す。
 * 接続未確立の事前判定は呼び出し側（runScenario）が済ませている。
 */
async function runStep(
  step: ScenarioStep,
  connection: ProbeConnection,
  log: OperationLogSink,
  channel: AwaitChannel,
): Promise<number | null> {
  switch (step.op) {
    case "start":
      return sendStep(connection, log, {
        type: "start",
        slotIds: [step.slotId],
        noodleType: step.noodleType,
        boilSeconds: step.boilSeconds,
      });

    case "cancel":
      return sendStep(connection, log, { type: "cancel", timerId: step.timerId });

    case "wait":
      // 要件3.3: wait 中はコマンドを送らない。受信記録は recordReceivedMessages の配線が継続する。
      await delay(step.durationMs);
      return null;

    case "await-done": {
      const outcome = await awaitDone(step, channel);
      if (outcome === "timeout") {
        // 要件3.6: タイムアウト記録を追記し、ログ保持のまま非ゼロ終了する（接続は閉じない）。
        await log.record(buildAwaitTimeoutEntry(Date.now(), step.timerId, step.timeoutMs));
        return EXIT_FAILURE;
      }
      return null;
    }
  }
}

/**
 * ClientMessage を送信し、送信記録を Operation_Log へ追記する。
 * 成功なら null。送信失敗は理由と種別を記録し、ログ保持のまま非ゼロ終了コードを返す（要件1.6）。
 */
async function sendStep(
  connection: ProbeConnection,
  log: OperationLogSink,
  message: ClientMessage,
): Promise<number | null> {
  const sentAt = Date.now();
  const outcome = await connection.send(message);
  if (!outcome.ok) {
    await log.record(buildSendFailureEntry(Date.now(), outcome.reason, outcome.messageType));
    return EXIT_FAILURE;
  }
  await log.record(buildSentEntry(message, sentAt));
  return null;
}

/**
 * 指定 timerId の done を受信するか、上限待機時間に達するまで待つ（要件3.4 / 3.5 / 3.6）。
 *
 * 待機は単一の setTimeout（必ず解決する）と受信監視ハンドラの settle で表現する。done 一致なら "matched"、
 * 上限待機時間到達なら "timeout" を返す。不一致の done を含む受信全件の記録は別配線が担うため、ここでは
 * 待機の終了条件だけを見る。timer と await 登録は決着時に必ず片付ける（抱えない）。
 */
function awaitDone(
  step: Extract<ScenarioStep, { op: "await-done" }>,
  channel: AwaitChannel,
): Promise<"matched" | "timeout"> {
  return new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      channel.clear();
      resolve("timeout");
    }, step.timeoutMs);

    channel.register({
      targetTimerId: step.timerId,
      onMatched: () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        channel.clear();
        resolve("matched");
      },
    });
  });
}

// ── 実時間の遅延（単一 setTimeout・必ず解決する） ──────────────────────────────

/** 指定ミリ秒だけ待つ。負値は 0 に丸める。必ず解決する単一の setTimeout（抱えない）。 */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/** 指定エポックミリ秒に達するまで待つ。既に過ぎていれば即時解決する。 */
function delayUntil(targetEpochMs: number): Promise<void> {
  return delay(targetEpochMs - Date.now());
}

// ── 受信の純粋解析（待機判定用・本文記録は probe 側が担う） ────────────────────

/**
 * 受信生文字列を ServerMessage として解釈する。JSON でない／type を持たない／type が非文字列なら null。
 * shouldStopAwaiting は done 以外を false にするため、ここでは type が文字列であることだけを確かめれば足りる。
 */
function parseServerMessage(raw: string): ServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "type" in parsed &&
    typeof (parsed as Record<string, unknown>).type === "string"
  ) {
    return parsed as ServerMessage;
  }
  return null;
}

// ── ランナー診断記録（Operation_Log の send/recv 枠に観測条件を残す） ──────────
//
// Operation_Log の direction は send / recv に限られる。タイムアウト・接続未確立は「期待した受信が
// 来なかった／接続が無かった」というランナーが観測した条件であり、recv（観測）として記録する。
// messageType は既存ワイヤ種別と衝突しない診断名とし、Correlator の検証（done 等の種別を見る）には
// 不活性なまま証跡として残る。

/** 接続未確立の診断記録（要件3.7）。どのステップ操作で観測したかを payload に残す。 */
function buildConnectionNotEstablishedEntry(at: number, op: ScenarioStep["op"]): UnsequencedOperationEntry {
  return {
    at,
    atIso: new Date(at).toISOString(),
    direction: "recv",
    messageType: "connection-not-established",
    payload: { op },
  };
}

/** await-done タイムアウトの診断記録（要件3.6）。対象 timerId と上限待機時間を残す。 */
function buildAwaitTimeoutEntry(at: number, timerId: string, timeoutMs: number): UnsequencedOperationEntry {
  return {
    at,
    atIso: new Date(at).toISOString(),
    direction: "recv",
    messageType: "await-timeout",
    payload: { timerId, timeoutMs },
  };
}

/** 送信失敗の診断記録（要件1.6）。失敗理由と対象メッセージ種別を残す。 */
function buildSendFailureEntry(at: number, reason: string, messageType: ClientMessage["type"]): UnsequencedOperationEntry {
  return {
    at,
    atIso: new Date(at).toISOString(),
    direction: "send",
    messageType: "send-failed",
    payload: { reason, messageType },
  };
}
