// client/connectivity.ts — WebSocket 生存検出の端（Connectivity_Watch）。
//
// 設計哲学「計算と作用の分離」をクライアントへ徹底する。本ファイルは作用の端であり、
// WebSocket の開閉・ping/pong による到達性検出・close/error の観測という「世界を観る手続き」
// だけを担う。ビューの決定（decideView）は一切行わない（要件4.6）。Connectivity（up/down）の
// 確定だけを導き、購読者（後続の Sync_Mediator）へ通知する。
//
// 到達性検出の心拍は auto-response 経路（PING_REQUEST 文字列）に限る。これは素の文字列フレームであり、
// ServerMessage / ClientMessage（ワイヤ形式）ではない。DO 側は state.setWebSocketAutoResponse により
// ランタイムが直接 pong を返すため、webSocketMessage ハンドラを起動せず hibernate からの wake を
// 伴わない（要件1.5 / 12.3）。この常駐ループは DO を wake させる通常メッセージを送らない（要件1.6）。
//
// 二段階の down 検出を独立した二系統として持つ（要件2.3）。
//   - 静かな喪失（half-open）: ping 送信後 PONG_TIMEOUT_MS 以内に pong 無しが SILENT_LOSS_MISSES 回連続（要件1.4）
//   - 明示的切断: WS の close / error（要件2.1）
// いずれか一方の成立で down を確定する。

import { PING_REQUEST, PONG_RESPONSE } from "../transport/heartbeat";
import type { ClientMessage, ServerMessage } from "../domain/messages";
import type { Connectivity, Socket, SocketOpener } from "./connection";

// 心拍フレーム（PING_REQUEST / PONG_RESPONSE）は client と shell で同一の確定値を共有するため
// src/transport/heartbeat.ts に一箇所だけ定義する（二重定義の根絶・要件1.1）。ここでは取り込んで
// 内部で使い、従来この経路から参照していた利用者のため公開も保つ。
export { PING_REQUEST, PONG_RESPONSE };

/** ping 送信間隔（ミリ秒）。この間隔以下で ping を送る（要件1.2: ≤15000）。 */
export const PING_INTERVAL_MS = 4_000;
/** 1 回の ping に対する pong 待ち受けタイムアウト（ミリ秒）。PONG_TIMEOUT_MS < PING_INTERVAL_MS を保つ。 */
export const PONG_TIMEOUT_MS = 2_000;
/**
 * 静かな喪失（half-open）と確定する連続未応答回数（要件1.4）。
 * down 確定までの目安は SILENT_LOSS_MISSES × PING_INTERVAL_MS + PONG_TIMEOUT_MS ≈ 10 秒
 * （単発のパケット欠落で誤検知しないよう 2 回連続を要求する頑健性は保つ）。
 */
export const SILENT_LOSS_MISSES = 2;

/**
 * 切断（明示的切断・静かな喪失のいずれか）の後、再接続を試みるまでの遅延（ミリ秒）。
 *
 * Connectivity_Watch は WS のライフサイクルを所有する以上、down 確定後も到達性回復のために
 * 再接続を試み続ける。回復は再接続＋全量 snapshot 受信で up へ確定し、購読者（Sync_Mediator）が
 * down→up 遷移を Reconcile の契機として捉える（要件2.4）。これは内部の配線値であり公開しない。
 */
const RECONNECT_DELAY_MS = 1_000;

/**
 * Connectivity_Watch — WS 生存検出の端。
 *
 * Connectivity の確定（up/down）の購読・live 経路の ClientMessage 送信・受信 ServerMessage の購読・
 * 切断のみを公開する。ビューの決定はしない（要件4.6）。
 */
export interface ConnectivityWatch {
  /** Connectivity の確定（up/down）を購読する。最後に登録したハンドラを保持する。 */
  onConnectivity(handler: (status: Connectivity) => void): void;
  /** live 経路の ClientMessage を WS へ送る（Sync_Mediator が経路選択して呼ぶ）。 */
  send(message: ClientMessage): void;
  /** 受信した ServerMessage を購読する（Sync_Mediator が decideView へ畳み込む）。 */
  onServerMessage(handler: (message: ServerMessage, receivedAt: number) => void): void;
  /** 接続・ping/pong ループ・再接続予約を停止する。 */
  close(): void;
}

/** Connectivity_Watch を生成する関数。既定の WS 生存検出を差し替え可能にする継ぎ目。 */
export type ConnectivityWatchFactory = (
  url: string,
  openSocket: SocketOpener,
  now: () => number,
) => ConnectivityWatch;

/**
 * 受信文字列を ServerMessage へ。不正形式・未知 type は null（無視させる）。
 *
 * pong は素の文字列フレームとして別経路で扱うため、ここへは到達しない（呼び出し側で先に判定する）。
 * type と serverTime を検証した上で信頼境界として確定する。形は messages.ts の定義に従う。
 */
function parseServerMessage(data: string): ServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as { type?: unknown; serverTime?: unknown };
  if (typeof candidate.serverTime !== "number") return null;
  switch (candidate.type) {
    case "snapshot":
    case "started":
    case "cancelled":
    case "boiled":
    case "completed":
    case "adjusted":
    case "config":
    case "error":
      return parsed as ServerMessage;
    default:
      return null;
  }
}

/**
 * 既定の生存検出。WebSocket を開き、ping/pong と close/error から Connectivity を導く（タスク6.1 / 6.2）。
 *
 * 作用の端。WS の開閉・PING_INTERVAL_MS 以下での ping 送信・pong / snapshot 受信での up 確定・
 * 二段階の down 検出・live 経路の ClientMessage 送信を担う。既存 Socket / SocketOpener 注入の継ぎ目を
 * 再利用し、新しい WS 抽象を発明しない。now は受信時刻の採取に用い、Date.now() を関数内に持ち込まない
 * （テストで決定的に駆動できるようにする）。
 */
export function watchConnectivity(
  url: string,
  openSocket: SocketOpener,
  now: () => number,
): ConnectivityWatch {
  let socket: Socket | null = null;
  let disposed = false;

  // 購読ハンドラ（最後に登録されたものを保持する）。
  let connectivityHandler: ((status: Connectivity) => void) | null = null;
  let serverMessageHandler: ((message: ServerMessage, receivedAt: number) => void) | null = null;

  // 直近に発行した Connectivity。同値の連続発行を抑え、down→up 遷移の観測を明瞭に保つ。
  let lastEmitted: Connectivity | null = null;

  // ping 送信間隔ループ。WS open 中のみ走る。
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  // 1 回の ping に対する pong 待ち受けタイムアウト。同時に高々 1 つ（PONG_TIMEOUT_MS < PING_INTERVAL_MS）。
  let pongTimer: ReturnType<typeof setTimeout> | null = null;
  // 連続未応答回数（静かな喪失の計数）。pong / snapshot 受信・再接続でリセットする。
  let consecutiveMisses = 0;
  // 再接続予約。二重予約を防ぐ。
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // 現接続が既に喪失確定済みか。close と error の二重通知・静かな喪失との競合を冪等にする。
  let connectionLost = false;

  function emit(status: Connectivity): void {
    if (lastEmitted === status) return;
    lastEmitted = status;
    connectivityHandler?.(status);
  }

  function clearPingTimer(): void {
    if (pingTimer !== null) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function clearPongTimer(): void {
    if (pongTimer !== null) {
      clearTimeout(pongTimer);
      pongTimer = null;
    }
  }

  /** pong 受信または全量 snapshot 受信で up を確定し、静かな喪失の計数をリセットする（要件1.3 / 2.2）。 */
  function confirmUp(): void {
    consecutiveMisses = 0;
    clearPongTimer();
    emit("up");
  }

  /** 切断（明示的切断・静かな喪失の合流点）。down を確定し、停止したソケットを畳んで再接続を予約する。 */
  function loseConnection(): void {
    if (connectionLost) return;
    connectionLost = true;
    clearPingTimer();
    clearPongTimer();
    const dead = socket;
    socket = null;
    emit("down");
    // half-open のソケットを明示的に閉じる。既に閉じていても idempotent。
    dead?.close();
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (disposed || reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_DELAY_MS);
  }

  /** 1 回分の ping を送り、その pong を PONG_TIMEOUT_MS だけ待つ。未応答ならミスを 1 加算する（要件1.2 / 1.4）。 */
  function sendPing(): void {
    if (disposed || socket === null) return;
    // 素の文字列フレーム。auto-response 経路のみを通り、DO を wake させない（要件1.6）。
    socket.send(PING_REQUEST);
    clearPongTimer();
    pongTimer = setTimeout(() => {
      pongTimer = null;
      consecutiveMisses += 1;
      // 静かな喪失（half-open）。明示的切断とは独立した系統で、連続 SILENT_LOSS_MISSES 回で down（要件1.4 / 2.3）。
      if (consecutiveMisses >= SILENT_LOSS_MISSES) {
        loseConnection();
      }
    }, PONG_TIMEOUT_MS);
  }

  function connect(): void {
    if (disposed) return;
    // 新しい接続試行ごとに喪失フラグと静かな喪失計数をリセットする。
    connectionLost = false;
    consecutiveMisses = 0;
    socket = openSocket(url, {
      onOpen: () => {
        // ping 送信ループを開始する（PING_INTERVAL_MS 以下の間隔・要件1.2）。
        // up は snapshot か pong の受信で確定する。open 単独では確定しない（要件2.2）。
        clearPingTimer();
        pingTimer = setInterval(sendPing, PING_INTERVAL_MS);
      },
      onMessage: (data) => {
        // pong は素の文字列フレーム（auto-response）。ServerMessage として parse しない（要件1.3）。
        if (data === PONG_RESPONSE) {
          confirmUp();
          return;
        }
        const message = parseServerMessage(data);
        if (message === null) return; // 不正形式は破棄する
        const receivedAt = now();
        // 全量 snapshot の受信は接続確立の確証 → up を確定する（要件2.2）。
        if (message.type === "snapshot") {
          confirmUp();
        }
        serverMessageHandler?.(message, receivedAt);
      },
      onClose: () => {
        // 明示的切断（要件2.1）。静かな喪失とは独立した系統だが down の合流点は一つ。
        loseConnection();
      },
      onError: () => {
        // error も明示的切断として扱う（要件2.1）。close が続かない実装でも down 確定を保証する。
        loseConnection();
      },
    });
  }

  connect();

  return {
    onConnectivity: (handler) => {
      connectivityHandler = handler;
    },
    send: (message) => {
      // live 経路の ClientMessage 送信。切断中は送らない（socket が null）。
      if (socket === null) return;
      socket.send(JSON.stringify(message));
    },
    onServerMessage: (handler) => {
      serverMessageHandler = handler;
    },
    close: () => {
      disposed = true;
      clearPingTimer();
      clearPongTimer();
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      socket?.close();
      socket = null;
    },
  };
}

// ---------------------------------------------------------------------------
// dev/test 限定フォルトインジェクション — ping blackhole（要件14）。
//
// 回線を物理的に切らずに「静かな喪失（half-open）」を擬似再現するための足場。既存のトランスポート
// 注入継ぎ目（SocketOpener）の上に薄く被せ、送信される ping のみを破棄する。pong が返らないことで
// watchConnectivity の silent-loss 検知（PONG_TIMEOUT_MS × SILENT_LOSS_MISSES・要件1.4）がそのまま
// 発火し、Connectivity を down へ確定する。Mode は依然 mode(view) の導出値であり、ここで独立状態として
// 書き換えない（本物の検知経路を経て degraded に入る・要件14.2 / 14.5）。
//
// 本番バンドルからの除外は import.meta.env.DEV ゲートで行う。本番ビルドでは DEV が false 定数へ畳まれ、
// 以下の能動的な配線は dead-code として tree-shaking される。デバッグフラグは OBSERVE_DEBUG と同じ規律
// （既定無効・"1" で有効）に揃え、dev/test でのみフォルトインジェクションを提供する（要件14.4）。
// ---------------------------------------------------------------------------

/**
 * ping blackhole のデバッグフラグ。OBSERVE_DEBUG と同じ規律（既定無効・"1" で有効）に揃える。
 *
 * 本番の既定では false を返し、フォルトインジェクションの切替手段をユーザー向け UI へ露出させない
 * （要件14.4）。クライアントは Vite の import.meta.env（VITE_ 接頭辞の公開設定）経由でフラグを読む。
 * import.meta.env.DEV は本番ビルドで false 定数へ畳まれ、フラグ評価ごと dead-code 除去される。
 */
export function pingBlackholeDebugEnabled(): boolean {
  if (!import.meta.env.DEV) return false;
  return import.meta.env.VITE_PING_BLACKHOLE_DEBUG === "1";
}

/**
 * ping blackhole のランタイム可逆スイッチ（dev/test 限定・要件14.3）。
 *
 * フォルトインジェクションの有効 / 無効を実行時に切り替える唯一の可変点。dev のトグル UI が
 * setPingBlackholeActive を呼び、Socket オープナ側の判定（withPingBlackhole の isEnabled）が
 * isPingBlackholeActive を読む——両者が同じ値を見ることで「一つのスイッチ」を成立させる。
 * Mode はあくまで mode(view) の導出値であり、このスイッチは Mode を書き換えない。送信 ping を
 * 落とすことで本物の silent-loss 検知経路（要件1.4）を通して degraded に入る（要件14.2 / 14.5）。
 * 本番では pingBlackholeDebugEnabled() が false ゆえ配線されず、この状態も参照されない（要件14.4）。
 */
let pingBlackholeActive = false;

/** ping blackhole が作動中か（withPingBlackhole の isEnabled として渡す・要件14.3）。 */
export function isPingBlackholeActive(): boolean {
  return pingBlackholeActive;
}

/** ping blackhole の作動を切り替える（dev トグルから呼ぶ・ランタイム可逆・要件14.3）。 */
export function setPingBlackholeActive(active: boolean): void {
  pingBlackholeActive = active;
}

/**
 * 送信 ping のみを破棄するフォルトインジェクションデコレータ（dev/test 限定・要件14.1）。
 *
 * inner（既定の SocketOpener）の上に被せ、返す Socket の send が message === PING_REQUEST かつ
 * isEnabled() のときだけ送信を捨てる。それ以外（通常メッセージ）は inner へ素通しし、受信・close /
 * error の観測経路（listeners）は inner のまま一切変えない（ping-only・要件14.1）。isEnabled は
 * ランタイムで可逆に切り替えられる（false に戻すと ping 送信が再開する・要件14.3）。
 *
 * 本番ビルドでは import.meta.env.DEV が false 定数へ畳まれ、この関数は inner を素通しする恒等関数に
 * なり、blackhole の配線ごと tree-shaking で除外される（要件14.4）。
 */
export function withPingBlackhole(inner: SocketOpener, isEnabled: () => boolean): SocketOpener {
  if (!import.meta.env.DEV) return inner;

  return (url, listeners) => {
    // 受信・close / error の観測経路は inner のまま。listeners をそのまま渡し、観測を変えない。
    const socket = inner(url, listeners);
    return {
      send: (data) => {
        // 送信 ping のみ破棄（ping-only）。pong が返らず silent-loss 検知（要件1.4）が発火し down へ。
        if (data === PING_REQUEST && isEnabled()) return;
        // 通常メッセージ（ClientMessage の JSON 等）は inner へ素通しする。
        socket.send(data);
      },
      close: () => socket.close(),
    };
  };
}
