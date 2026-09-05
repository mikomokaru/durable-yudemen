// engine/timer の createTimer が TimerFact.orderItem（OrderItemOrigin）をどう確立するかの回帰テスト。
//
// orderItem は「どの注文品目から始まったか」の事実で、null はアドホック麺茹で（POS を経ない開始）。
// 開始済み品目を Pending_Order の置換から除く判定がこの事実だけに依るため、構築の一点で
// 省略が null に落ちること・渡した参照がそのまま残ることを固定する（要件8.4）。

import { describe, it, expect } from "vitest";
import { createTimer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { nonEmpty } from "../nonEmpty";

const base = {
  id: "t1" as TimerId,
  slotIds: nonEmpty(["0" as SlotId]),
  noodleType: "Thin" as NoodleType,
  firmness: "normal",
  startTime: 0 as EpochMillis,
  endTime: 60_000 as EpochMillis,
  seq: 0,
} as const;

describe("createTimer — orderItem の確立", () => {
  it("orderItem を省略すると null（アドホック麺茹で）で生まれる", () => {
    expect(createTimer({ ...base }).orderItem).toBeNull();
  });

  it("orderItem を渡すとその注文品目参照を保持する", () => {
    const orderItem = { externalOrderId: "order-7", itemIndex: 2, tableId: null } as const;

    expect(createTimer({ ...base, orderItem }).orderItem).toEqual(orderItem);
  });
});
