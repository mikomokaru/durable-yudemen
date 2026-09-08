// tests/client/slotDisplay.example.test.ts — 釜のカードが品目を引く口（order-lifecycle AC 4.6・Requirement 5.2）。
//
// **Validates: Requirements 4.6, 5.2**
//
// running / boiled の SlotDisplay は `orderItem`＝`orderItemOf(timer, view.orderItems)` を持つ。参照が null（アドホック
// 開始）でも、参照先が集合に無くても（v12 由来・判断 14）null で、呼び手は「注文なし」と同じ経路を通る（判断 13）。
// 何を出すか（番号・卓・品名・中断の色分け）は lift-order-numbering の関心事で、ここでは引けることだけを固定する。

import { describe, expect, it } from "vitest";
import { EMPTY_VIEW, type ClientTimer, type ClientView } from "../../src/client/connection";
import { assignedSlotDisplays } from "../../src/client/components/slotDisplay";
import type { OrderItem } from "../../src/domain/order";

const NOW = 1_700_000_000_000;

const ITEM: OrderItem = {
  externalOrderId: "o-1",
  itemIndex: 1,
  noodleType: "Thin",
  firmness: "normal",
  tableId: "12",
  arrivalTime: NOW - 60_000,
  slotSpan: 1,
  itemName: "かけ",
  sizeName: null,
  completedAt: null,
  interruptedAt: null,
};

function timer(
  overrides: Partial<ClientTimer> & {
    readonly id: string;
    readonly slotIds: ClientTimer["slotIds"];
  },
): ClientTimer {
  return {
    noodleType: "Thin",
    firmness: "normal",
    startTime: NOW - 30_000,
    endTime: NOW + 30_000,
    orderItem: null,
    origin: "server",
    ...overrides,
  };
}

const VIEW: ClientView = {
  ...EMPTY_VIEW,
  connectivity: "up",
  sync: "synced",
  orderItems: [ITEM],
  timers: [
    // 釜 0：ITEM を指す走行中。
    timer({
      id: "running-ref",
      slotIds: ["0"],
      orderItem: { externalOrderId: "o-1", itemIndex: 1 },
    }),
    // 釜 1：ITEM を指す boiled（Complete 待ち）。
    timer({
      id: "boiled-ref",
      slotIds: ["1"],
      endTime: NOW - 1_000,
      orderItem: { externalOrderId: "o-1", itemIndex: 1 },
    }),
    // 釜 2：アドホック（参照なし）。
    timer({ id: "adhoc", slotIds: ["2"] }),
    // 釜 3：参照先が集合に無い（v12 由来・同じ注文の別の品目）。
    timer({ id: "orphan", slotIds: ["3"], orderItem: { externalOrderId: "o-1", itemIndex: 0 } }),
  ],
};

function orderItemAt(slot: number) {
  const display = assignedSlotDisplays(VIEW, [0], NOW).find((each) => each.slot === slot);
  if (display === undefined || (display.kind !== "running" && display.kind !== "boiled")) {
    throw new Error(`釜 ${slot} は running / boiled でない`);
  }
  return { kind: display.kind, orderItem: display.orderItem };
}

describe("Feature: order-lifecycle — running / boiled の SlotDisplay は orderItemOf で品目を引ける（AC 4.6）", () => {
  it("参照が集合の品目を指せば、その品目（同じ参照）が載る——走行中も boiled も", () => {
    expect(orderItemAt(0)).toEqual({ kind: "running", orderItem: ITEM });
    expect(orderItemAt(0).orderItem).toBe(ITEM);
    expect(orderItemAt(1)).toEqual({ kind: "boiled", orderItem: ITEM });
  });

  it("参照が null（アドホック）でも、参照先が集合に無くても（v12 由来）null——注文なしと同じ経路（判断 13 / 14）", () => {
    expect(orderItemAt(2)).toEqual({ kind: "running", orderItem: null });
    expect(orderItemAt(3)).toEqual({ kind: "running", orderItem: null });
  });

  it("後着で卓が変われば、次の snapshot のカードは新しい卓を引く（品目は最新の注文情報・Timer は開始時点の記録・性質 7.8）", () => {
    const moved: ClientView = { ...VIEW, orderItems: [{ ...ITEM, tableId: "7" }] };
    const display = assignedSlotDisplays(moved, [0], NOW).find((each) => each.slot === 0);
    expect(display?.kind === "running" ? display.orderItem?.tableId : null).toBe("7");
  });
});
