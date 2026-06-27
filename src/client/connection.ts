// client/connection.ts — WebSocket 接続管理と、サーバ状態を映すビューの同期。
//
// このモジュールは二層に分かれる。設計哲学「計算と作用の分離」をそのまま構造にする。
//
//   1. reduceView — 純粋な計算。ServerMessage を受信ビューへ畳み込むだけの決定的関数。
//      WS にも DOM にも時計にも触れない（受信時刻 receivedAt は引数で受け取る）。
//      snapshot 全置換・offset 再確立・処理済み記録の刈り取り・通知冪等性は、すべて
//      既存の純粋関数（clock / notification）へ通してここに集約する。
//   2. openTimerConnection — 作用の端。WebSocket の確立・受信・再接続・同期失敗タイムアウト・
//      秒読みティックという「世界を変える手続き」だけを担い、状態の決定は reduceView に委ねる。
//
// 導出値（残り秒）は状態に昇格させない。ビューが保持する事実は endTime を含む Timer 集合・
// クロックオフセット・処理済み timerId 集合・同期フェーズだけであり、残り秒はクライアント側の
// 描画のたびに clock.ts の純粋導出で算出する（要件10.1 の思想をクライアントへ延長）。
// ティックはビューを変えない。再描画を促して remaining を導出し直させるためだけにある（要件10.5）。

import type { ClientMessage, ServerMessage, WireTimer } from "../shared/messages";
import { clockOffset } from "./clock";
import { markProcessed, shouldHandleDone } from "./notification";

/** 同期フェーズ — サーバ状態への追随状況。残り秒のような導出値ではなく、接続の事実。 */
export type SyncPhase = "connecting" | "synced" | "syncFailed";

/**
 * 受信ビュー — サーバ状態を映す、クライアントが保持する事実の集合。
 *
 * 残り秒は持たない（描画のたびに clock.ts で導出）。担当スコープによる絞り込みも持たない
 * （表示時に assignment.ts の純粋導出で射影する。保持は全量・表示は導出）。
 */
export interface TimerView {
  /** アクティブな全 Timer（全量保持）。snapshot で全置換される（要件4.2 / 4.5）。 */
  readonly timers: readonly WireTimer[];
  /** 最新のクロックオフセット。serverTime を伴う受信のたびに再確立する（要件10.3 / 10.6）。 */
  readonly offset: number;
  /** done / cancelled を処理済みとして記録した timerId 集合（表示制御用・SSOT のコピーではない）。 */
  readonly processedIds: ReadonlySet<string>;
  /** 同期フェーズ。 */
  readonly sync: SyncPhase;
  /** 直近のサーバエラー（拒否・失敗）。snapshot 受信で解消する。 */
  readonly error: { readonly code: string; readonly message: string } | null;
}

/** 初期ビュー。まだ何も受信しておらず接続中。 */
export const EMPTY_VIEW: TimerView = {
  timers: [],
  offset: 0,
  processedIds: new Set<string>(),
  sync: "connecting",
  error: null,
};

/**
 * 純粋な畳み込み — 受信した ServerMessage を現在ビューへ適用する。
 *
 * receivedAt は受信時点のローカル時刻（エポックミリ秒）。offset 算出に用いるため引数で受け取り、
 * Date.now() を関数内に持ち込まない（純粋性を保ち、任意時刻で検証可能にする）。
 * 同じ入力に同じ出力を返し、副作用を一切持たない。
 */
export function reduceView(view: TimerView, message: ServerMessage, receivedAt: number): TimerView {
  // すべての server → client メッセージは serverTime を伴う。受信のたびに offset を最新化する（要件10.3）。
  const offset = clockOffset(message.serverTime, receivedAt);

  switch (message.type) {
    case "snapshot": {
      // 表示中 Timer 集合を全置換（要件4.2）。含まれない Timer は自然に除去される（要件4.5 / 6.7）。
      // 処理済み記録から、snapshot に含まれない（＝非アクティブ）timerId を刈り取る（記録を有界に保つ）。
      const liveIds = new Set(message.timers.map((timer) => timer.id));
      const prunedProcessed = new Set<string>();
      for (const id of view.processedIds) {
        if (liveIds.has(id)) prunedProcessed.add(id);
      }
      return {
        timers: message.timers,
        offset,
        processedIds: prunedProcessed,
        sync: "synced",
        error: null,
      };
    }

    case "started": {
      // 当該 Timer のカウントダウンを開始（要件1.4）。同一 id の重複 started は最新で置き換える。
      const withoutDuplicate = view.timers.filter((timer) => timer.id !== message.timer.id);
      return { ...view, offset, timers: [...withoutDuplicate, message.timer] };
    }

    case "cancelled": {
      // 既に処理済み（＝除去済み）の重複 cancelled は冪等に無視する（要件6.8）。offset のみ最新化。
      if (!shouldHandleDone(message.timerId, view.processedIds)) {
        return { ...view, offset };
      }
      // 当該 Slot の表示を除去し（要件6.7）、処理済みとして記録する。
      return {
        ...view,
        offset,
        timers: view.timers.filter((timer) => timer.id !== message.timerId),
        processedIds: markProcessed(view.processedIds, message.timerId),
      };
    }

    case "done": {
      // 処理済み / 除去済みの timerId は冪等に無視（音・通知・表示変更を行わない・要件2.12）。
      if (!shouldHandleDone(message.timerId, view.processedIds)) {
        return { ...view, offset };
      }
      // 未処理の timerId のみ処理済みとして記録する（要件2.11）。茹で上がり表示は processedIds 所属から
      // 導出するため、Timer 自体は集合に残す（次の snapshot で全置換され除去される）。
      return { ...view, offset, processedIds: markProcessed(view.processedIds, message.timerId) };
    }

    case "error": {
      return { ...view, offset, error: { code: message.code, message: message.message } };
    }
  }
}

/** 最小の WebSocket 抽象 — 送信と切断のみ。作用の端をテスト可能な継ぎ目に保つ。 */
export interface Socket {
  send(data: string): void;
  close(): void;
}

/** Socket からの受信反応。作用の端が呼び出す。 */
export interface SocketListeners {
  readonly onOpen: () => void;
  readonly onMessage: (data: string) => void;
  readonly onClose: () => void;
  readonly onError: () => void;
}

/** Socket を開く関数。既定はブラウザ WebSocket。テストでは差し替える。 */
export type SocketOpener = (url: string, listeners: SocketListeners) => Socket;

/** 接続のコントローラ。UI（タスク20）はこれを通してビューを購読し、操作を送る。 */
export interface TimerConnection {
  /** 現在のビューを取得する（描画のたびに残りを導出する元）。 */
  getView(): TimerView;
  /** ビュー更新（受信・接続状態変化・秒読みティック）を購読する。戻り値で解除する。 */
  subscribe(listener: () => void): () => void;
  /** タイマー開始操作を送る（担当スコープの制限は UI の責務）。 */
  start(slotId: string, noodleType: string, boilSeconds: number): void;
  /** タイマーキャンセル操作を送る。 */
  cancel(timerId: string): void;
  /** 接続を閉じ、再接続・ティックを停止する。 */
  close(): void;
}

/** openTimerConnection のオプション。時計と Socket を注入可能にしてテスト容易性を保つ。 */
export interface ConnectionOptions {
  /** 接続先 WS URL（例: wss://host/ws）。 */
  readonly url: string;
  /** 現在時刻の採取。既定 Date.now（offset 算出・受信時刻に用いる）。 */
  readonly now?: () => number;
  /** Socket を開く関数。既定はブラウザ WebSocket。 */
  readonly openSocket?: SocketOpener;
  /** 接続確立から snapshot 受信までの猶予（ミリ秒）。既定 2000（要件4.1 / 4.6）。 */
  readonly syncTimeoutMs?: number;
  /** 切断後に再接続を試みるまでの遅延（ミリ秒）。既定 1000。 */
  readonly reconnectDelayMs?: number;
  /** 残り再算出を促すティック間隔（ミリ秒）。既定 1000。1000ms 以下に保つ（要件10.5 / 5.1）。 */
  readonly tickMs?: number;
}

/** 既定の Socket オープナ — ブラウザ WebSocket を SocketListeners へ配線する。 */
function browserSocketOpener(url: string, listeners: SocketListeners): Socket {
  const ws = new WebSocket(url);
  ws.onopen = () => listeners.onOpen();
  ws.onmessage = (event: MessageEvent) => {
    // サーバは JSON 文字列のみ送る。文字列以外は破棄相当（空文字を渡し parse 失敗で無視させる）。
    listeners.onMessage(typeof event.data === "string" ? event.data : "");
  };
  ws.onclose = () => listeners.onClose();
  ws.onerror = () => listeners.onError();
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
  };
}

/** 受信文字列を ServerMessage へ。不正形式・未知 type は null（無視させる）。 */
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
    case "done":
    case "error":
      // type と serverTime を検証した上で信頼境界として確定。形は messages.ts の定義に従う。
      return parsed as ServerMessage;
    default:
      return null;
  }
}

/**
 * WebSocket 接続を開き、サーバ状態に追随するコントローラを返す（タスク19.1）。
 *
 * 作用の端。接続確立・受信・再接続・同期失敗タイムアウト・秒読みティックを担い、ビューの決定は
 * reduceView（純粋）に委ねる。同期失敗時は既存表示を保持したまま再接続を試みる（要件4.6）。
 */
export function openTimerConnection(options: ConnectionOptions): TimerConnection {
  const now = options.now ?? (() => Date.now());
  const openSocket = options.openSocket ?? browserSocketOpener;
  const syncTimeoutMs = options.syncTimeoutMs ?? 2000;
  const reconnectDelayMs = options.reconnectDelayMs ?? 1000;
  const tickMs = options.tickMs ?? 1000;

  let view: TimerView = EMPTY_VIEW;
  let socket: Socket | null = null;
  let connected = false;
  let disposed = false;
  let syncTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function update(next: TimerView): void {
    if (next === view) return;
    view = next;
    notify();
  }

  function clearSyncTimer(): void {
    if (syncTimer !== null) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
  }

  function scheduleReconnect(): void {
    if (disposed || reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
  }

  function connect(): void {
    if (disposed) return;
    // 既存ビュー（timers / offset / processedIds / sync）は保持したまま再接続する（要件4.6）。
    socket = openSocket(options.url, {
      onOpen: () => {
        connected = true;
        // 接続確立から syncTimeoutMs 以内に snapshot が来なければ同期失敗（要件4.1 / 4.6）。
        clearSyncTimer();
        syncTimer = setTimeout(() => {
          syncTimer = null;
          // 同期失敗表示。既存表示は保持し、接続を切って再接続を促す。
          update({ ...view, sync: "syncFailed" });
          socket?.close();
        }, syncTimeoutMs);
      },
      onMessage: (data) => {
        const message = parseServerMessage(data);
        if (message === null) return; // 不正形式は破棄（要件9.7 相当のクライアント側無視）
        if (message.type === "snapshot") clearSyncTimer();
        update(reduceView(view, message, now()));
      },
      onClose: () => {
        connected = false;
        clearSyncTimer();
        scheduleReconnect();
      },
      onError: () => {
        // エラーは閉鎖に倒して再接続経路へ寄せる。
        socket?.close();
      },
    });
  }

  // 秒読みティック。ビューは変えず、再描画を促して残りを導出し直させるだけ（要件10.5 / 5.1）。
  // 切断中も止めない。最新 offset を使い続けてローカル再算出を継続する（要件5.2 / 5.3）。
  const tickTimer: ReturnType<typeof setInterval> = setInterval(notify, tickMs);

  connect();

  function sendMessage(message: ClientMessage): void {
    if (!connected || socket === null) return;
    socket.send(JSON.stringify(message));
  }

  return {
    getView: () => view,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: (slotId, noodleType, boilSeconds) => {
      sendMessage({ type: "start", slotId, noodleType, boilSeconds });
    },
    cancel: (timerId) => {
      sendMessage({ type: "cancel", timerId });
    },
    close: () => {
      disposed = true;
      clearSyncTimer();
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      clearInterval(tickTimer);
      socket?.close();
      socket = null;
      connected = false;
      listeners.clear();
    },
  };
}
