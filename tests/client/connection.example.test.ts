// tests/client/connection.example.test.ts — WS 接続コントローラの example テスト（タスク19.2）。
//
// reduceView の純粋性は別途検証できるが、ここでは作用の端（openTimerConnection）の振る舞いを
// 具体例で確認する。確認対象は次の三つ:
//   1. snapshot 全置換と、含まれない Timer / 処理済み記録の刈り取り（要件4.2 / 4.5）
//   2. 接続確立から 2 秒で snapshot 未受信なら同期失敗を表面化し、既存表示を保持する（要件4.6 / 5.5）
//   3. 切断中も offset を固定したままローカル再算出ティックが継続し、サーバ通信が発生しない
//      （要件5.2 / 5.3）
//
// WebSocket グローバルには触れず、SocketOpener / now を注入して決定的に駆動する。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { remainingMs } from "../../src/client/clock";
import {
  mode,
  openTimerConnection,
  type Connectivity,
  type ConnectionOptions,
  type Socket,
  type SocketListeners,
} from "../../src/client/connection";
import type { ConnectivityWatch } from "../../src/client/connectivity";
import type { ClientMessage, ServerMessage } from "../../src/domain/messages";
import type { TimerFact } from "../../src/domain/timer";

/** 1 回の接続試行で生成された偽 Socket（送信・切断のモック）とそのリスナの組。 */
interface OpenedSocket {
  readonly listeners: SocketListeners;
  readonly send: ReturnType<typeof vi.fn<(data: string) => void>>;
  readonly close: ReturnType<typeof vi.fn<() => void>>;
}

const START_NOW = 1_000_000; // 任意の固定エポックミリ秒。受信時刻の基準。

/**
 * 接続コントローラと偽 Socket 環境を組み立てる。
 *
 * now は可変参照で制御し、切断中の時間経過（ローカル再算出）を表現できるようにする。
 * openSocket は接続試行のたびに新しい偽 Socket を sockets へ積む（再接続も追跡できる）。
 */
function setup(overrides: Partial<ConnectionOptions> = {}) {
  const sockets: OpenedSocket[] = [];
  let currentNow = START_NOW;

  const connection = openTimerConnection({
    url: "wss://test/ws",
    now: () => currentNow,
    openSocket: (_url, listeners) => {
      const send = vi.fn<(data: string) => void>();
      const close = vi.fn<() => void>();
      sockets.push({ listeners, send, close });
      const socket: Socket = { send, close };
      return socket;
    },
    ...overrides,
  });

  return {
    connection,
    sockets,
    /** 直近に開かれた Socket（再接続後は最新を指す）。未生成なら明示的に失敗する。 */
    latest: (): OpenedSocket => {
      const last = sockets[sockets.length - 1];
      if (last === undefined) throw new Error("Socket がまだ開かれていない");
      return last;
    },
    setNow: (next: number) => {
      currentNow = next;
    },
  };
}

/** テスト用 TimerFact 生成。endTime は START_NOW から十分先に置く。startTime は START_NOW（開始時刻の事実）。 */
function makeTimer(id: string, endTime = START_NOW + 180_000): TimerFact {
  return { id, slotIds: [`slot-${id}`], noodleType: "ramen", firmness: "normal", startTime: START_NOW, endTime };
}

/** JSON 文字列としてサーバメッセージを受信させる。 */
function receive(opened: OpenedSocket, message: unknown): void {
  opened.listeners.onMessage(JSON.stringify(message));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("client/connection — 状態同期と切断継続", () => {
  it("snapshot は表示中 Timer 集合を全置換し、含まれない Timer と処理済み記録を刈り取る（要件4.2 / 4.5）", () => {
    const { connection, latest } = setup();
    latest().listeners.onOpen();

    // 最初の snapshot で A・B を保持し synced になる。A は endTime が過去（クライアントで boiled として導出される）。
    receive(latest(), {
      type: "snapshot",
      serverTime: START_NOW,
      timers: [makeTimer("A", START_NOW - 1000), makeTimer("B")],
    });
    expect(connection.getView().sync).toBe("synced");
    expect(connection.getView().timers.map((t) => t.id)).toEqual(["A", "B"]);

    // 茹で上がりアラートはクライアントのローカル導出（endTime ≤ 補正後現在）で鳴り、A を処理済みに記録する
    // （server の boiled メッセージは撤去済み。dedup は endTime 導出＋ LocalDone 記録で担う）。
    vi.advanceTimersByTime(1000);
    expect(connection.getView().processedIds.has("A")).toBe(true);

    // 次の snapshot は B・C のみ。A は表示から除去され、処理済み記録からも刈り取られる。
    receive(latest(), {
      type: "snapshot",
      serverTime: START_NOW + 20,
      timers: [makeTimer("B"), makeTimer("C")],
    });
    expect(connection.getView().timers.map((t) => t.id)).toEqual(["B", "C"]);
    expect(connection.getView().processedIds.has("A")).toBe(false);

    connection.close();
  });

  it("接続確立から 2 秒 snapshot 未受信なら同期失敗を表面化し、既存表示を保持する（要件4.6 / 5.5）", () => {
    const { connection, latest } = setup();

    // 初回接続で snapshot を受け、A を表示中 synced にしておく。
    latest().listeners.onOpen();
    receive(latest(), {
      type: "snapshot",
      serverTime: START_NOW,
      timers: [makeTimer("A")],
    });
    expect(connection.getView().sync).toBe("synced");

    // 切断 → 再接続猶予（既定 1000ms）後に再接続が試みられ、新しい Socket が開く。
    latest().listeners.onClose();
    const beforeReconnect = latest();
    vi.advanceTimersByTime(1000);
    expect(latest()).not.toBe(beforeReconnect); // 再接続で別 Socket が開いている

    // 再接続が確立しても 2 秒以内に snapshot が来なければ同期失敗。
    latest().listeners.onOpen();
    vi.advanceTimersByTime(2000);

    expect(connection.getView().sync).toBe("syncFailed");
    // 既存表示（A）は失われない（瞬断で表示は死なない・要件4.6）。
    expect(connection.getView().timers.map((t) => t.id)).toEqual(["A"]);

    connection.close();
  });

  it("切断中は offset を固定したままローカル再算出ティックが継続し、サーバ通信は発生しない（要件5.2 / 5.3）", () => {
    const { connection, latest, setNow } = setup();

    // 接続中に snapshot を受け、offset を確立する（serverTime と受信時刻 START_NOW の差）。
    latest().listeners.onOpen();
    const endTime = START_NOW + 60_000; // 受信時点で残り 60 秒
    receive(latest(), {
      type: "snapshot",
      serverTime: START_NOW + 5_000, // サーバはローカルより 5 秒進んでいる
      timers: [{ id: "A", slotIds: ["slot-A"], noodleType: "ramen", endTime }],
    });
    const fixedOffset = connection.getView().offset;
    expect(fixedOffset).toBe(5_000);

    // 切断。以降サーバからの受信はない。
    const disconnected = latest();
    disconnected.listeners.onClose();

    // 再描画（ローカル再算出）の継続をティック購読で確認する。
    let renders = 0;
    const unsubscribe = connection.subscribe(() => {
      renders += 1;
    });

    // ローカル時刻を 10 秒進めつつ、再算出ティック（既定 1000ms）を進める。
    setNow(START_NOW + 10_000);
    vi.advanceTimersByTime(3_000);
    expect(renders).toBeGreaterThanOrEqual(3); // 切断中もティックが止まらない

    // offset は固定のまま（新しい serverTime を受け取っていないので再確立されない）。
    expect(connection.getView().offset).toBe(fixedOffset);

    // 固定 offset（5s）と進んだローカル時刻だけで残りがローカル導出され、経過分だけ減り続ける。
    // 受信時点（START_NOW）: 補正後現在は +5s 進むため remaining 55s、10 秒経過後は 45s。サーバ問い合わせなし。
    expect(remainingMs(endTime, fixedOffset, START_NOW)).toBe(55_000);
    expect(remainingMs(endTime, fixedOffset, START_NOW + 10_000)).toBe(45_000);

    // 切断中の操作はサーバへ送られない（送信は connected を満たす時だけ）。
    connection.start(["slot-X"], "udon", 120);
    connection.cancel("A");
    expect(disconnected.send).not.toHaveBeenCalled();

    unsubscribe();
    connection.close();
  });
});

describe("client/connection — provisional への操作は origin で経路分けする（幽霊タイマー解消）", () => {
  /**
   * Connectivity を直接駆動できる偽 Watch で接続を組む。default watchConnectivity の ping/pong に依存せず、
   * degraded→live の遷移と送信有無を決定的に検証する。openSocket は偽 Watch が無視する。
   */
  function setupWithWatch(overrides: Partial<ConnectionOptions> = {}) {
    const send = vi.fn<(message: ClientMessage) => void>();
    let connectivityHandler: ((status: Connectivity) => void) | null = null;
    let serverMessageHandler: ((message: ServerMessage, receivedAt: number) => void) | null = null;
    const watch: ConnectivityWatch = {
      onConnectivity: (handler) => {
        connectivityHandler = handler;
      },
      send,
      onServerMessage: (handler) => {
        serverMessageHandler = handler;
      },
      close: vi.fn(),
    };
    let idCounter = 0;
    const connection = openTimerConnection({
      url: "wss://test/ws",
      now: () => START_NOW,
      newId: () => `local-${(idCounter += 1)}`,
      connectivity: () => watch,
      ...overrides,
    });
    return {
      connection,
      send,
      setConnectivity: (status: Connectivity) => connectivityHandler?.(status),
      receiveMessage: (message: ServerMessage) => serverMessageHandler?.(message, START_NOW),
    };
  }

  it("degraded で開始した provisional を live で Cancel するとサーバへ送らずローカル除去する（TimerNotFound 回避）", () => {
    const { connection, send, setConnectivity } = setupWithWatch();

    // boot は connectivity down（degraded）。ここで開始すると provisional（origin:"local"）が生まれ、送信はしない。
    connection.start(["slot-5"], "ramen", 180);
    const provisional = connection.getView().timers.find((t) => t.origin === "local");
    expect(provisional).toBeDefined();
    expect(send).not.toHaveBeenCalled();

    // 回線復帰（live）。provisional は保持される。
    setConnectivity("up");
    expect(mode(connection.getView())).toBe("live");

    // live でも provisional の Cancel はサーバへ送らず、ローカルで除去する（幽霊タイマーにならない）。
    connection.cancel(provisional!.id);
    expect(send).not.toHaveBeenCalled();
    expect(connection.getView().timers.some((t) => t.id === provisional!.id)).toBe(false);

    connection.close();
  });

  it("live で server-confirmed な Timer の Cancel は従来どおりサーバへ送る", () => {
    const { connection, send, setConnectivity, receiveMessage } = setupWithWatch();

    setConnectivity("up");
    receiveMessage({ type: "snapshot", serverTime: START_NOW, timers: [makeTimer("S")] });
    expect(mode(connection.getView())).toBe("live");

    connection.cancel("S");
    expect(send).toHaveBeenCalledWith({ type: "cancel", timerId: "S" });

    connection.close();
  });

  it("live で provisional の Complete もサーバへ送らずローカル除去する", () => {
    const { connection, send, setConnectivity } = setupWithWatch();

    connection.start(["slot-3"], "udon", 120);
    const provisional = connection.getView().timers.find((t) => t.origin === "local");
    expect(provisional).toBeDefined();

    setConnectivity("up");
    connection.complete(provisional!.id);
    expect(send).not.toHaveBeenCalled();
    expect(connection.getView().timers.some((t) => t.id === provisional!.id)).toBe(false);

    connection.close();
  });
});
