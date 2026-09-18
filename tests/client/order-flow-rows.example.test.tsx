// tests/client/order-flow-rows.example.test.tsx — 横時系列・縦積みの実験版（OrderFlowRows）の描画スモーク。
// 導出は縦レーン版と共有するので、ここでは 4 つの行が描かれ、盛りつけ中の丼がドックで Done にできることだけを問う。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { OrderFlowRows } from "../../src/client/components/OrderFlowRows";
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

describe("OrderFlowRows（実験）", () => {
  it("Waiting / Boiling / Bowls / Done の行が描かれ、盛りつけ中の丼はドックで Done にできる", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    try {
      const waiting = order("W", T - 10_000);
      const cooking = order("C", T - 60_000);
      const plating = order("P", T - 120_000, { completedAt: T - 5_000 });
      const up: ClientTimer = {
        id: "up",
        slotIds: ["1"],
        noodleType: "Thin",
        firmness: "normal",
        startTime: T - 90_000,
        endTime: T - 10_000,
        orderItem: null,
        origin: "server",
      };
      const running: ClientTimer = {
        ...up,
        id: "run",
        slotIds: ["4"],
        endTime: T + 30_000,
        orderItem: { externalOrderId: "C", itemIndex: 0 },
      };
      const farTimer: ClientTimer = { ...up, id: "far", slotIds: ["5"], endTime: T + 600_000 };
      const view: ClientView = {
        ...EMPTY_VIEW,
        sync: "synced",
        connectivity: "up",
        noodlePresets: DEFAULT_NOODLE_PRESETS,
        orderItems: [waiting, cooking, plating],
        timers: [up, running, farTimer],
      };
      const onAck = vi.fn<(key: string) => void>();
      render(
        <OrderFlowRows
          connection={connectionOf(view)}
          acked={new Set()}
          onAck={onAck}
          onAssignTable={() => {}}
        />,
      );
      expect(
        within(screen.getByRole("region", { name: "Waiting" })).getByText("Item W"),
      ).toBeTruthy();
      const boiling = screen.getByRole("region", { name: "Boiling" });
      expect(within(boiling).getByText("Item C")).toBeTruthy();
      expect(within(boiling).getByText("UP +00:10")).toBeTruthy();
      expect(within(boiling).getByText("10:00")).toBeTruthy(); // 7m+ の帯
      const dock = screen.getByRole("region", { name: "Bowls" });
      fireEvent.click(within(dock).getByRole("button", { name: "Mark done — Item P" }));
      expect(onAck).toHaveBeenCalledWith(itemKeyOf(plating));
      expect(screen.getByRole("region", { name: "Done" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
