// tests/client/order-flow-board.example.test.tsx — オーダーの流れ（KANBAN）盤面の実描画テスト（プロトタイプ）。
//
// 描くのは OrderFlowBoard 単体である。接続は `getView` が固定のビューを返す作り物で、送信の口は持たない
// （この盤面はサーバへ何も送らない）。並び・残り・経過の導出は flow-lanes.example.test.ts が持つので、
// ここでは組んだビューが 4 レーンの DOM へ写ること、Plating の札のタップが確認（onAck）に写ること、Done が
// 既定で折りたたまれていることだけを問う。問い方は支援技術が見るもの（role / accessible name）に寄せる。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { OrderFlowBoard } from "../../src/client/components/OrderFlowBoard";
import {
  EMPTY_VIEW,
  type ClientTimer,
  type ClientView,
  type TimerConnection,
} from "../../src/client/connection";
import { itemKeyOf, type OrderItem } from "../../src/domain/order";
import { DEFAULT_NOODLE_PRESETS } from "../../src/domain/store";

afterEach(cleanup);

const T = 1_700_000_000_000;

function order(id: string, arrivalTime: number, overrides: Partial<OrderItem> = {}): OrderItem {
  return {
    externalOrderId: id,
    itemIndex: 0,
    noodleType: "Thin",
    firmness: "normal",
    tableId: "3",
    arrivalTime,
    portions: 1,
    itemName: `Item ${id}`,
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
    tableAssignedAt: null,
    ...overrides,
  };
}

function connectionOf(view: ClientView): TimerConnection {
  return {
    getView: () => view,
    subscribe: () => () => {},
    start: vi.fn<TimerConnection["start"]>(),
    startOrderItem: vi.fn<TimerConnection["startOrderItem"]>(),
    cancel: vi.fn<TimerConnection["cancel"]>(),
    complete: vi.fn<TimerConnection["complete"]>(),
    adjust: vi.fn<TimerConnection["adjust"]>(),
    assignTable: vi.fn<TimerConnection["assignTable"]>(),
    close: vi.fn<TimerConnection["close"]>(),
  };
}

describe("OrderFlowBoard", () => {
  it("4 レーンへ品目が段階どおりに写り、Plating のタップが確認に写る", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    try {
      const waiting = order("W", T - 10_000);
      const cooking = order("C", T - 60_000);
      const plating = order("P", T - 120_000, { completedAt: T - 5_000 });
      const done = order("D", T - 180_000, { completedAt: T - 60_000 });
      const timer: ClientTimer = {
        id: "t1",
        slotIds: ["4"],
        noodleType: "Thin",
        firmness: "normal",
        startTime: T - 30_000,
        endTime: T + 30_000,
        orderItem: { externalOrderId: "C", itemIndex: 0 },
        origin: "server",
      };
      // 準備猶予の外（残り 2 分）の Timer。棚には出ないが Boiling には出る。
      const far = order("F", T - 20_000, { sizeName: "大盛" });
      const farTimer: ClientTimer = {
        ...timer,
        id: "t2",
        slotIds: ["5"],
        endTime: T + 120_000,
        orderItem: { externalOrderId: "F", itemIndex: 0 },
      };
      const view: ClientView = {
        ...EMPTY_VIEW,
        sync: "synced",
        connectivity: "up",
        noodlePresets: DEFAULT_NOODLE_PRESETS,
        orderItems: [waiting, cooking, plating, done, far],
        timers: [timer, farTimer],
      };
      const onAck = vi.fn<(key: string) => void>();
      render(
        <OrderFlowBoard
          connection={connectionOf(view)}
          acked={new Set([itemKeyOf(done)])}
          onAck={onAck}
          onAssignTable={() => {}}
        />,
      );

      expect(
        within(screen.getByRole("region", { name: "Waiting" })).getByText("Item W"),
      ).toBeTruthy();
      const boiling = screen.getByRole("region", { name: "Boiling" });
      expect(within(boiling).getByText("Item C")).toBeTruthy();
      expect(within(boiling).getAllByText("00:30").length).toBeGreaterThan(0);
      expect(within(boiling).getByRole("img", { name: "Slot 4" })).toBeTruthy();
      const platingLane = screen.getByRole("region", { name: "Plating" });
      const ackButton = within(platingLane).getByRole("button", {
        name: "Mark plated — Item P",
      });
      fireEvent.click(ackButton);
      expect(onAck).toHaveBeenCalledWith(itemKeyOf(plating));
      // ドック：残り 30 秒の C は出る（サイズ未申告は —・タレは品名）、残り 2 分の F は出ない。盛りつけ中の P は
      // Done まで残り、確認済みの D は出ない。盛りつけ中の札だけが押せて同じ口へ写る（準備中の C は押せない）。
      const shelf = screen.getByRole("region", { name: "Bowls" });
      expect(within(shelf).getByText("Item C")).toBeTruthy();
      expect(within(shelf).queryByText("Item F")).toBeNull();
      expect(within(shelf).queryByText("Item D")).toBeNull();
      fireEvent.click(within(shelf).getByRole("button", { name: "Mark done — Item P" }));
      expect(onAck).toHaveBeenCalledTimes(2);
      expect(within(shelf).queryByRole("button", { name: /Item C/ })).toBeNull();
      expect(shelf.getAttribute("aria-expanded")).toBe("true");

      // Done は既定で折りたたまれ、件数だけが出る。見出しを押すと札が現れる。
      const doneLane = screen.getByRole("region", { name: "Done" });
      expect(within(doneLane).queryByText("Item D")).toBeNull();
      const toggle = within(doneLane).getByRole("button", { expanded: false });
      expect(toggle.textContent).toContain("1");
      fireEvent.click(toggle);
      expect(within(doneLane).getByText("Item D")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("degraded では品目のレーンは空で、Boiling の秒読みだけが出て案内が出る", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    try {
      const view: ClientView = {
        ...EMPTY_VIEW,
        connectivity: "down",
        orderItems: [order("W", T - 10_000)],
        timers: [
          {
            id: "t",
            slotIds: ["0"],
            noodleType: "Thin",
            firmness: "normal",
            startTime: T - 70_000,
            endTime: T - 10_000,
            orderItem: null,
            origin: "server",
          },
        ],
      };
      render(
        <OrderFlowBoard
          connection={connectionOf(view)}
          acked={new Set()}
          onAck={() => {}}
          onAssignTable={() => {}}
        />,
      );
      expect(screen.getByRole("status").textContent).toMatch(/Waiting for the latest orders/);
      // degraded でも Timer 由来の丼はドックに出る（上がり待ちの 1 杯）。
      const dock = screen.getByRole("region", { name: "Bowls" });
      expect(dock.getAttribute("aria-expanded")).toBe("true");
      expect(within(dock).getByText("UP +00:10")).toBeTruthy();
      expect(
        within(screen.getByRole("region", { name: "Waiting" })).queryByText("Item W"),
      ).toBeNull();
      expect(
        within(screen.getByRole("region", { name: "Boiling" })).getByText("UP +00:10"),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
