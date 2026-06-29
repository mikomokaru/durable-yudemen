// tests/client/complete.example.test.ts — boiled → 明示完了（complete）→ completed → idle の遷移検証。
// 接続レベル（openTimerConnection）と表示導出（assignedSlotDisplays）で、complete 後にスロットが
// idle へ戻ること、boiled の Complete 対象 timer が正しく拾えることを確認する（直前結果の表示そのものは
// SlotBoard の React state で、ここでは扱わない）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openTimerConnection,
  type ConnectionOptions,
  type Socket,
  type SocketListeners,
} from "../../src/client/connection";
import { assignedSlotDisplays } from "../../src/client/components/slotDisplay";

const START_NOW = 1_000_000;

interface OpenedSocket {
  readonly listeners: SocketListeners;
  readonly send: ReturnType<typeof vi.fn<(data: string) => void>>;
  readonly close: ReturnType<typeof vi.fn<() => void>>;
}

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
    latest: (): OpenedSocket => {
      const last = sockets[sockets.length - 1];
      if (last === undefined) throw new Error("Socket not opened");
      return last;
    },
    setNow: (n: number) => {
      currentNow = n;
    },
  };
}

function receive(opened: OpenedSocket, message: unknown): void {
  opened.listeners.onMessage(JSON.stringify(message));
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("client/connection — 茹で上がりの明示完了", () => {
  it("boiled スロットを complete すると completed 受信で除去され idle へ戻る", () => {
    const { connection, latest } = setup();
    latest().listeners.onOpen();

    // endTime が過去の Timer を hydration で受け取る（クライアントでは boiled として導出される）。
    receive(latest(), {
      type: "snapshot",
      serverTime: START_NOW,
      timers: [{ id: "T", slotIds: ["3"], noodleType: "Medium", endTime: START_NOW - 1000 }],
    });

    // boiled として在席し、表示導出も boiled（Complete 対象 timer を保持）になる。
    const view1 = connection.getView();
    expect(view1.timers.map((t) => t.id)).toEqual(["T"]);
    const displays1 = assignedSlotDisplays(view1, [0], START_NOW);
    const slot3 = displays1.find((d) => d.slot === 3);
    expect(slot3?.kind).toBe("boiled");
    expect(slot3 && slot3.kind === "boiled" ? slot3.timer.noodleType : null).toBe("Medium");

    // 明示完了を送る（live 経路）。
    connection.complete("T");
    const sent = latest().send.mock.calls.map(([d]) => JSON.parse(d));
    expect(sent).toContainEqual({ type: "complete", timerId: "T" });

    // サーバが completed をブロードキャスト → Timer 除去 → スロットは idle へ。直前結果が記録される。
    receive(latest(), { type: "completed", serverTime: START_NOW + 5, timerId: "T" });
    const view2 = connection.getView();
    expect(view2.timers.some((t) => t.id === "T")).toBe(false);
    const displays2 = assignedSlotDisplays(view2, [0], START_NOW);
    expect(displays2.find((d) => d.slot === 3)?.kind).toBe("idle");
    // 直前結果（残滓）が当該スロット（slotId "3"）に記録されている。at は client 受信時刻（receivedAt = now()）。
    expect(view2.lastResults.get("3")).toEqual({ noodleType: "Medium", at: START_NOW });

    connection.close();
  });

  it("当該スロットで新規開始すると直前結果（残滓）は解除される（要件13.7）", () => {
    const { connection, latest } = setup();
    latest().listeners.onOpen();
    receive(latest(), {
      type: "snapshot",
      serverTime: START_NOW,
      timers: [{ id: "T", slotIds: ["3"], noodleType: "Medium", endTime: START_NOW - 1000 }],
    });
    connection.complete("T");
    receive(latest(), { type: "completed", serverTime: START_NOW + 5, timerId: "T" });
    expect(connection.getView().lastResults.has("3")).toBe(true);

    // スロット 3 で新規開始（started 受信）→ 残滓は解除される。
    receive(latest(), {
      type: "started",
      serverTime: START_NOW + 10,
      timer: { id: "U", slotIds: ["3"], noodleType: "Thin", endTime: START_NOW + 70_000 },
    });
    expect(connection.getView().lastResults.has("3")).toBe(false);

    connection.close();
  });
});
