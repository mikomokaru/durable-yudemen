// tools/observe/probe.ts — Probe_Client（観測クライアントの端・Node ランタイム）。
//
// この層は workerd ではなく Node 上で動く「端」である。WebSocket（`ws`）と JSONL ファイル IO
// （`node:fs/promises`）という作用はここに閉じ、純粋層（src/observe）へは漏らさない。
// 本モジュールが担うのは I/O とログ書き込みだけであり、判定（confirmed / fail 等）は一切行わない
// ——突き合わせと検証条件判定は Correlator（src/observe/correlate.ts）の責務である。
//
// 設計の不変点（hibernation 規律「待つなら寝かせる、抱えると漏れる」）に従い、`setInterval` も
// 終わらない `setTimeout` も持ち込まない。接続タイムアウトは成功/失敗で必ず clear する単一の
// `setTimeout` のみで表現する。

import { Buffer } from "node:buffer";
import { appendFile } from "node:fs/promises";

import { WebSocket, type RawData } from "ws";

import { serializeOperationEntry } from "../../src/observe/log";
import type { OperationLogEntry, UnsequencedOperationEntry } from "../../src/observe/log";
import type { ClientMessage } from "../../src/domain/messages";

// ── 接続確立 ─────────────────────────────────────────────────────────────────

/** 接続タイムアウト（要件1.3）。確立試行開始からこの時間内に open しなければ失敗とする。 */
export const CONNECT_TIMEOUT_MS = 10_000;

/**
 * メッセージ送信の結果（要件1.4 / 1.5 / 1.6）。
 * 成功は ok:true のみ。失敗は理由と対象メッセージ種別を伴い、呼び出し側が記録して非ゼロ終了できる。
 * 失敗を例外でなく戻り値で表すことで、全ての送信パスを構造で表現する（握り潰さない）。
 */
export type SendOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly messageType: ClientMessage["type"] };

/**
 * 確立済みの WebSocket 接続。送受信の I/O だけを提供し、判定は持たない。
 *  - onMessage: サーバ受信を受信順・本文不改変でコールバックへ渡す（要件1.7）。受信時刻（epoch ms）を併せて渡す。
 *  - send: ClientMessage を既存ワイヤ形式で送る。失敗は SendOutcome で表す（要件1.4〜1.6）。
 *  - isOpen: 接続が確立され送受信可能な状態か（要件3.7 の「操作実行時点で接続未確立か」を端で問うための観測点）。
 *  - close: 接続を閉じる。
 */
export interface ProbeConnection {
  readonly onMessage: (handler: (raw: string, receivedAt: number) => void) => void;
  readonly send: (message: ClientMessage) => Promise<SendOutcome>;
  readonly isOpen: () => boolean;
  readonly close: () => Promise<void>;
}

/**
 * `wss://` エンドポイントの `/ws` パスへ WebSocket 接続を確立する（要件1.2 / 1.3）。
 *
 * 確立試行開始から CONNECT_TIMEOUT_MS（10,000ms）以内に open しない、または確立が失敗したら、
 * 理由を持つ Error で reject する。呼び出し側（CLI エントリ）はその理由を Operation_Log に記録し
 * 非ゼロ終了する（要件1.3）。endpoint / storeId は事前に validateProbeArgs で検証済みである前提
 * （wss スキーム・非空店舗識別子）だが、接続そのものの失敗はここで端の作用として扱う。
 *
 * 店舗識別子は `/ws` の query（`store`）として運ぶ。ワイヤ上のメッセージ形式は一切拡張しない
 * （新メッセージ種別・フィールドを足さない・要件9.6）——これは接続先の選択であってプロトコルではない。
 */
export function connectProbe(endpoint: string, storeId: string): Promise<ProbeConnection> {
  return new Promise<ProbeConnection>((resolve, reject) => {
    const url = new URL(endpoint);
    url.pathname = "/ws";
    url.searchParams.set("store", storeId);

    const socket = new WebSocket(url.toString());
    const handlers: Array<(raw: string, receivedAt: number) => void> = [];

    // 確立の成否はこの settled で一度だけ確定する。タイムアウトと open/error が競合しても
    // 二重に resolve/reject しない。
    let settled = false;

    // 単一の setTimeout。open / error のいずれでも必ず clear する（抱えない）。
    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // 確立できなかった接続は確実に破棄する。
      socket.terminate();
      reject(new Error(`WebSocket connection was not established within ${CONNECT_TIMEOUT_MS}ms`));
    }, CONNECT_TIMEOUT_MS);

    socket.on("open", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);

      // 受信を登録順の全ハンドラへ、サーバからの受信順のまま渡す（要件1.7）。本文は改変しない。
      socket.on("message", (data: RawData) => {
        const receivedAt = Date.now();
        const raw = rawDataToString(data);
        for (const handler of handlers) {
          handler(raw, receivedAt);
        }
      });

      resolve(makeConnection(socket, handlers));
    });

    socket.on("error", (error: Error) => {
      if (settled) {
        // 確立後の error はここで握る（リスナー不在による Node のクラッシュを防ぐ）。
        // 送信失敗は send の SendOutcome で別途表現される。
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      reject(new Error(`WebSocket connection failed: ${error.message}`));
    });
  });
}

/** 確立済み socket と受信ハンドラ列から ProbeConnection を組み立てる。 */
function makeConnection(
  socket: WebSocket,
  handlers: Array<(raw: string, receivedAt: number) => void>,
): ProbeConnection {
  return {
    onMessage(handler) {
      handlers.push(handler);
    },

    send(message) {
      return new Promise<SendOutcome>((resolve) => {
        if (socket.readyState !== WebSocket.OPEN) {
          resolve({ ok: false, reason: "socket is not open", messageType: message.type });
          return;
        }
        // 既存の ClientMessage 形式のみを送る（要件1.4 / 1.5 / 9.6）。新フィールドは足さない。
        socket.send(JSON.stringify(message), (error?: Error) => {
          if (error) {
            resolve({ ok: false, reason: error.message, messageType: message.type });
          } else {
            resolve({ ok: true });
          }
        });
      });
    },

    isOpen() {
      return socket.readyState === WebSocket.OPEN;
    },

    close() {
      return new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.once("close", () => resolve());
        socket.close();
      });
    },
  };
}

/** ws の RawData（Buffer / Buffer[] / ArrayBuffer）を UTF-8 文字列へ変換する。本文は改変しない。 */
function rawDataToString(data: RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

// ── Operation_Log への逐次追記（JSONL ファイル IO・端） ────────────────────────

/**
 * Operation_Log（JSONL ファイル）への逐次追記口。送受信の事実（seq を除く）を 1 件受け取り、
 * seq を 0 から採番して 1 行追記する。判定は行わない——記録だけが責務。
 */
export interface OperationLogSink {
  /** 1 記録を追記する。seq は内部で 0 から +1 に採番される（欠番・重複なし・要件2.3）。 */
  readonly record: (entry: UnsequencedOperationEntry) => Promise<void>;
}

/**
 * 指定パスへ追記する Operation_Log sink を開く（要件1.7 / 2.x）。
 *
 * seq は起動時 0 から記録順に +1 で採番する（src/observe/log.ts の付番規律と一致）。採番は record の
 * 呼び出し順（＝送受信順）に同期的に行うため、ファイルへの書き込みが非同期でも seq は順序を正しく表す。
 * さらに書き込みを直列の鎖（writeChain）に繋ぎ、JSONL の物理行順も記録順と一致させる（受信順保持・要件1.7）。
 * 直前の書き込み失敗は後続を止めない（順序だけ保ち、各記録は自身の失敗のみを呼び出し側へ surface する）。
 */
export function openOperationLog(filePath: string): OperationLogSink {
  let nextSeq = 0;
  let writeChain: Promise<void> = Promise.resolve();

  return {
    record(entry) {
      const sequenced: OperationLogEntry = { seq: nextSeq, ...entry };
      nextSeq += 1;
      const line = `${serializeOperationEntry(sequenced)}\n`;

      const previous = writeChain;
      const current = (async () => {
        // 直前の書き込みの完了だけを待ち、その成否は問わない（順序の保証のため）。
        await previous.catch(() => undefined);
        await appendFile(filePath, line, "utf8");
      })();
      writeChain = current;
      return current;
    },
  };
}

/**
 * 送信した ClientMessage から Operation_Log の記録候補（送信）を組み立てる（要件2.1）。
 * messageType は種別、payload はメッセージ本文そのもの。本文は改変しない。
 */
export function buildSentEntry(message: ClientMessage, sentAt: number): UnsequencedOperationEntry {
  return {
    at: sentAt,
    atIso: new Date(sentAt).toISOString(),
    direction: "send",
    messageType: message.type,
    payload: message,
  };
}

/**
 * 受信した生メッセージから Operation_Log の記録候補（受信）を組み立てる（要件1.7 / 2.2）。
 *
 * 本文は改変しない——JSON として解釈できればその値を payload に、できなければ生文字列を payload に置く。
 * messageType は本文の `type` フィールド（文字列）から導出する。判定はしない（種別の構造化のみ）。
 * `type` を持たない／非文字列なら空文字とし、生の受信を失わずに記録する。
 */
export function buildReceivedEntry(raw: string, receivedAt: number): UnsequencedOperationEntry {
  let payload: unknown = raw;
  let messageType = "";

  try {
    const parsed: unknown = JSON.parse(raw);
    payload = parsed;
    if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
      const type = (parsed as Record<string, unknown>).type;
      if (typeof type === "string") {
        messageType = type;
      }
    }
  } catch {
    // JSON でなければ生文字列をそのまま payload とする（本文不改変）。
  }

  return {
    at: receivedAt,
    atIso: new Date(receivedAt).toISOString(),
    direction: "recv",
    messageType,
    payload,
  };
}

/**
 * 接続が受信する全メッセージを、受信順・本文不改変で sink へ逐次記録するよう配線する（要件1.7）。
 * 受信ハンドラは同期的に sink.record を呼び（seq を受信順に採番）、書き込み自体は sink 内で直列化される。
 */
export function recordReceivedMessages(connection: ProbeConnection, sink: OperationLogSink): void {
  connection.onMessage((raw, receivedAt) => {
    void sink.record(buildReceivedEntry(raw, receivedAt));
  });
}
