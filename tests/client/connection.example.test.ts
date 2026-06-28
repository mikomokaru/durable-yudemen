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
  openTimerConnection,
  type ConnectionOptions,
  type Socket,
  type SocketListeners,
} from "../../src/client/connection";
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

/** テスト用 TimerFact 生成。endTime は START_NOW から十分先に置く。 */
function makeTimer(id: string, endTime = START_NOW + 180_000): TimerFact {
  return { id, slotIds: [`slot-${id}`], noodleType: "ramen", endTime };
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

    // 最初の snapshot で A・B を保持し synced になる。
    receive(latest(), {
      type: "snapshot",
      serverTime: START_NOW,
      timers: [makeTimer("A"), makeTimer("B")],
    });
    expect(connection.getView().sync).toBe("synced");
    expect(connection.getView().timers.map((t) => t.id)).toEqual(["A", "B"]);

    // A を done として処理済みに記録する（A は次の snapshot まで集合に残る）。
    receive(latest(), { type: "done", serverTime: START_NOW + 10, timerId: "A" });
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
