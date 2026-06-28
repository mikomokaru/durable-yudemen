// tools/offline/link-gate.ts — リンク遮断ゲート（ライブ縮退 CLI の端・Node ランタイム）。
//
// 本番の SocketOpener 継ぎ目（src/client/connection.ts）にちょうど嵌まる Node 実装で、
// 「ネットワーク断」を実機に近い形で擬似する。本番実装は一切変更せず、openTimerConnection の
// options.openSocket にこのオープナを注入するだけで縮退をライブに起こせる。
//
// なぜ ping blackhole ではなくリンク遮断か:
//   要件14 の withPingBlackhole は「送信 ping のみ破棄」(ping-only) であり、受信も再接続も素通しする。
//   実サーバ相手では silent-loss で一度 down になっても、Connectivity_Watch がすぐ再接続し、
//   accept 時の全量 snapshot 受信で up に戻ってしまう（degraded が 1 秒程度の瞬きになる）。
//   degraded 中に落ち着いて操作し、その後の復帰を観測するには「断の間は接続自体が確立しない」
//   安定した窓が要る。そこで本ゲートは、遮断中は (a) 生きている接続を能動的に閉じ（明示的切断・要件2.1）、
//   (b) 以後の再接続試行も即座に失敗させることで、復旧するまで down を維持する。
//
// hibernation 規律「待つなら寝かせる、抱えると漏れる」に従い、setInterval も終わらない setTimeout も
// 持ち込まない。遮断中の接続失敗通知は、必ず解決する一度きりの setTimeout(0) のみで表す。

import { WebSocket, type RawData } from "ws";

import type { Socket, SocketOpener } from "../../src/client/connection";

/** リンク遮断ゲート。本番の SocketOpener を注入点に差し込み、断/復旧をランタイムで切り替える。 */
export interface LinkGate {
  /** openTimerConnection の options.openSocket に渡す注入オープナ。 */
  readonly opener: SocketOpener;
  /** リンクを遮断する（生接続を閉じ、以後の接続も失敗させて down を維持する）。 */
  cut(): void;
  /** リンクを復旧する（次の再接続から実接続が確立し、snapshot で up へ戻る）。 */
  restore(): void;
  /** 現在遮断中か。 */
  isCut(): boolean;
}

/** リンク遮断ゲートを生成する。実 WebSocket（ws）を裏側に持つ。 */
export function createLinkGate(): LinkGate {
  let cut = false;
  // 現在生きている実接続。cut() のとき能動的に閉じて明示的切断を発火させる。
  let activeWs: WebSocket | null = null;

  const opener: SocketOpener = (url, listeners) => {
    if (cut) {
      // 遮断中: 接続を確立させない。connect() が socket を代入し終えた後に切断を通知するため、
      // 同期呼び出しを避けて次イベントループで onError を一度だけ起こす（down を維持させる）。
      let closed = false;
      const failTimer = setTimeout(() => {
        if (!closed) listeners.onError();
      }, 0);
      return {
        send: () => {}, // 遮断中の送信は破棄する
        close: () => {
          closed = true;
          clearTimeout(failTimer);
        },
      } satisfies Socket;
    }

    const ws = new WebSocket(url);
    activeWs = ws;
    ws.on("open", () => listeners.onOpen());
    ws.on("message", (data: RawData) => listeners.onMessage(rawToString(data)));
    ws.on("close", () => {
      if (activeWs === ws) activeWs = null;
      listeners.onClose();
    });
    ws.on("error", () => {
      if (activeWs === ws) activeWs = null;
      listeners.onError();
    });
    return {
      send: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      },
      close: () => ws.close(),
    } satisfies Socket;
  };

  return {
    opener,
    cut() {
      cut = true;
      // 生きている接続を能動的に閉じ、Connectivity_Watch に明示的切断（要件2.1）を観測させる。
      const ws = activeWs;
      activeWs = null;
      ws?.close();
    },
    restore() {
      cut = false;
    },
    isCut() {
      return cut;
    },
  };
}

/** ws の RawData（Buffer / Buffer[] / ArrayBuffer）を UTF-8 文字列へ。本文は改変しない。 */
function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}
