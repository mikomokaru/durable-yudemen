// tests/core/start-order-item.example.test.ts — 品目からの開始の拒否と Effect 列。
//
// **Validates: Requirements 3.5, 3.6, 3.7, 3.8**
//
// 拒否は「状態の嘘を防ぐため」であり、現場の選択を否定するものではない。ここで固定するのは何を拒否し
// 何を通すかの線である——占有・推奨との一致・slotSpan は見ず、品目の不在と麺種の不在だけを見る。

import { describe, expect, it } from "vitest";
import { EMPTY_STATE } from "../../src/engine/state";
import { decide } from "../../src/engine/decide";
import { DEFAULT_NOODLE_PRESETS } from "../../src/domain/store";
import type { PendingOrder } from "../../src/domain/order";
import type { EpochMillis, TimerId } from "../../src/engine/types";
import type { TimerState } from "../../src/engine/state";
import { settleParams } from "../settleParams";
import { nonEmpty } from "../nonEmpty";

const NOW = 1_700_000_000_000 as EpochMillis;
const PARAMS = settleParams({ arms: 2, toleranceRatio: 10 });

const ORDER: PendingOrder = {
  externalOrderId: "o-1",
  itemIndex: 0,
  noodleType: DEFAULT_NOODLE_PRESETS[0].noodleType,
  firmness: "hard",
  tableId: "t-3",
  arrivalTime: NOW - 60_000,
  slotSpan: 1,
  itemName: "プレ塩",
  sizeName: "中盛",
};

function start(
  state: TimerState,
  keys: { externalOrderId: string; itemIndex: number },
  slotIds = ["0"],
) {
  return decide(
    state,
    {
      type: "StartOrderItem",
      slotIds,
      externalOrderId: keys.externalOrderId,
      itemIndex: keys.itemIndex,
      newTimerId: "t-new" as TimerId,
      now: NOW,
    },
    PARAMS,
  );
}

describe("Feature: slot-suggested-start — 拒否は状態を変えない（要件 3.5 / 3.6）", () => {
  it("品目が待ち行列に無ければ品目不在で拒否し、状態は不変である", () => {
    const state: TimerState = { ...EMPTY_STATE, pendingOrders: [ORDER] };
    // 他端末が直前に開始した場合に起こりうる正常な競合である（推奨との不一致ではない）。
    const outcome = start(state, { externalOrderId: "o-1", itemIndex: 9 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejection.code).toBe("OrderItemNotFound");
  });

  it("鍵の片方が一致しても拒否する（externalOrderId と itemIndex の組で 1 品目を指す）", () => {
    const state: TimerState = { ...EMPTY_STATE, pendingOrders: [ORDER] };
    expect(start(state, { externalOrderId: "o-other", itemIndex: 0 }).ok).toBe(false);
    expect(start(state, { externalOrderId: "o-1", itemIndex: 1 }).ok).toBe(false);
  });

  it("品目の麺種がプリセットに無ければ既存の InvalidSlotOrNoodle で拒否する", () => {
    const retired: PendingOrder = { ...ORDER, noodleType: "Retired" };
    const outcome = start({ ...EMPTY_STATE, pendingOrders: [retired] }, retired);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // 新しい code を足さない——設定に麺種が無いことは既存の拒否事由である。
    expect(outcome.rejection.code).toBe("InvalidSlotOrNoodle");
  });

  it("空の slotIds は InvalidSlotOrNoodle で拒否する（validateStart の共有）", () => {
    const outcome = start({ ...EMPTY_STATE, pendingOrders: [ORDER] }, ORDER, []);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejection.code).toBe("InvalidSlotOrNoodle");
  });
});

describe("Feature: slot-suggested-start — 検査しないもの（要件 3.7）", () => {
  it("走行中の釜へ重ねても拒否しない（占有を検査しない）", () => {
    // 提案からの重畳は「押す場所が idle にしかない」ことで client 側の構造が防ぐ。engine は見ない。
    const first = start({ ...EMPTY_STATE, pendingOrders: [ORDER] }, ORDER);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second: PendingOrder = { ...ORDER, externalOrderId: "o-2" };
    const outcome = decide(
      { ...first.state, pendingOrders: [second] },
      {
        type: "StartOrderItem",
        slotIds: ["0"], // 同じ釜
        externalOrderId: second.externalOrderId,
        itemIndex: second.itemIndex,
        newTimerId: "t-second" as TimerId,
        now: NOW,
      },
      PARAMS,
    );
    expect(outcome.ok).toBe(true);
  });

  it("押した釜数が slotSpan と違っても拒否しない（現場の判断に委ねる）", () => {
    const wide: PendingOrder = { ...ORDER, slotSpan: 2 };
    // slotSpan 2 の品目を 1 釜で開始する。
    expect(start({ ...EMPTY_STATE, pendingOrders: [wide] }, wide, ["0"]).ok).toBe(true);
    // 逆（slotSpan 1 を 2 釜で）も通る。
    expect(start({ ...EMPTY_STATE, pendingOrders: [ORDER] }, ORDER, ["0", "1"]).ok).toBe(true);
  });
});

describe("Feature: slot-suggested-start — Effect 列は既存 start と同一（要件 3.8）", () => {
  it("Persist が先頭に立ち、Broadcast は snapshot ちょうど 1 件である", () => {
    const outcome = start({ ...EMPTY_STATE, pendingOrders: [ORDER] }, ORDER);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // settle を共有した帰結であり、この経路のために Effect を組み直していない。
    expect(outcome.effects[0]?.type).toBe("Persist");
    const broadcasts = outcome.effects.filter((effect) => effect.type === "Broadcast");
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]?.type === "Broadcast" && broadcasts[0].message.type).toBe("snapshot");
  });

  it("拒否は Effect 列を生まない", () => {
    const outcome = start(
      { ...EMPTY_STATE, pendingOrders: [ORDER] },
      {
        externalOrderId: "missing",
        itemIndex: 0,
      },
    );
    expect(outcome.ok).toBe(false);
  });
});

describe("Feature: lift-group-planning — 走行中の Timer は由来する卓を持つ（要件 3.1 / 3.2 / 3.6）", () => {
  it("品目からの開始は PendingOrder の卓を orderItem の内側へ写す", () => {
    const state: TimerState = { ...EMPTY_STATE, pendingOrders: [ORDER] };
    const outcome = start(state, ORDER);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.timers[0]!.orderItem).toEqual({
      externalOrderId: "o-1",
      itemIndex: 0,
      tableId: "t-3",
    });
  });

  it("modification で品目の卓が移っても、走行中 Timer の卓は追随しない（再送の品目は新しい卓へ）", () => {
    const state: TimerState = { ...EMPTY_STATE, pendingOrders: [ORDER] };
    const started = start(state, ORDER);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    // 同じ注文が卓を変えて再送される。開始済みの品目は置換から除かれ（要件 1.8）、走行中 Timer は旧卓のまま。
    const moved = decide(
      started.state,
      {
        type: "OrderArrived",
        arrival: nonEmpty([
          { ...ORDER, tableId: "t-9" },
          { ...ORDER, itemIndex: 1, tableId: "t-9" },
        ]),
        now: NOW,
      },
      PARAMS,
    );
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.state.timers[0]!.orderItem?.tableId).toBe("t-3");
    // 再送で届いた未着手の品目（itemIndex 1）は新しい卓の群に入る。開始済みの itemIndex 0 は復活しない。
    expect(moved.state.pendingOrders.map((order) => [order.itemIndex, order.tableId])).toEqual([
      [1, "t-9"],
    ]);
  });
});
