// tests/core/start-order-item.example.test.ts — 品目からの開始の拒否と Effect 列。
//
// **Validates: Requirements 3.5, 3.6, 3.7, 3.8（slot-suggested-start）／ 1.1, 1.5, 7.6（order-lifecycle）**
//
// 拒否は「状態の嘘を防ぐため」であり、現場の選択を否定するものではない。ここで固定するのは何を拒否し
// 何を通すかの線である——占有・推奨との一致・slotSpan は見ず、品目の不在・調理中・麺種の不在だけを見る。
// 開始は品目を消費しない（order-lifecycle AC 1.1）——照合は未調理の品目（pendingOrders）に対して行い、
// 調理中は OrderItemCooking、done・期限切れ・不在は OrderItemNotFound で拒否する（AC 1.5）。

import { describe, expect, it } from "vitest";
import { EMPTY_STATE } from "../../src/engine/state";
import { decide } from "../../src/engine/decide";
import { DEFAULT_NOODLE_PRESETS } from "../../src/domain/store";
import {
  itemStatusOf,
  ORDER_LIFETIME_MS,
  orderItemsToBroadcast,
  type OrderItem,
} from "../../src/domain/order";
import type { EpochMillis, TimerId } from "../../src/engine/types";
import type { TimerState } from "../../src/engine/state";
import { settleParams } from "../settleParams";
import { nonEmpty } from "../nonEmpty";

const NOW = 1_700_000_000_000 as EpochMillis;
const PARAMS = settleParams({ arms: 2, toleranceRatio: 10 });

const ORDER: OrderItem = {
  externalOrderId: "o-1",
  itemIndex: 0,
  noodleType: DEFAULT_NOODLE_PRESETS[0].noodleType,
  firmness: "hard",
  tableId: "t-3",
  arrivalTime: NOW - 60_000,
  slotSpan: 1,
  itemName: "プレ塩",
  sizeName: "中盛",
  completedAt: null,
  interruptedAt: null,
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
    const state: TimerState = { ...EMPTY_STATE, orderItems: [ORDER] };
    // 他端末が直前に開始した場合に起こりうる正常な競合である（推奨との不一致ではない）。
    const outcome = start(state, { externalOrderId: "o-1", itemIndex: 9 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejection.code).toBe("OrderItemNotFound");
  });

  it("鍵の片方が一致しても拒否する（externalOrderId と itemIndex の組で 1 品目を指す）", () => {
    const state: TimerState = { ...EMPTY_STATE, orderItems: [ORDER] };
    expect(start(state, { externalOrderId: "o-other", itemIndex: 0 }).ok).toBe(false);
    expect(start(state, { externalOrderId: "o-1", itemIndex: 1 }).ok).toBe(false);
  });

  it("調理中の品目（自分を指す生きた Timer が在る）への開始は OrderItemCooking で拒否し、状態は不変（order-lifecycle AC 1.5）", () => {
    const first = start({ ...EMPTY_STATE, orderItems: [ORDER] }, ORDER);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // 品目は消費されず残り、状態は cooking。
    expect(first.state.orderItems).toEqual([ORDER]);
    expect(itemStatusOf(ORDER, first.state.timers)).toBe("cooking");
    // 他端末が直前に開始した品目をもう一度始める——二重調理を防ぐ。
    const again = decide(
      first.state,
      {
        type: "StartOrderItem",
        slotIds: ["1"],
        externalOrderId: ORDER.externalOrderId,
        itemIndex: ORDER.itemIndex,
        newTimerId: "t-again" as TimerId,
        now: NOW,
      },
      PARAMS,
    );
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.rejection.code).toBe("OrderItemCooking");
    expect(first.state.timers).toHaveLength(1);
  });

  it("調理済み（done）の品目への開始は OrderItemNotFound で拒否する（調理中だけを分ける）", () => {
    const done: OrderItem = { ...ORDER, completedAt: NOW - 1_000 };
    const outcome = start({ ...EMPTY_STATE, orderItems: [done] }, done);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejection.code).toBe("OrderItemNotFound");
  });

  it("中断された品目（interruptedAt）は未調理として再び開始できる（性質 7.3′）", () => {
    const interrupted: OrderItem = { ...ORDER, interruptedAt: NOW - 1_000 };
    const outcome = start({ ...EMPTY_STATE, orderItems: [interrupted] }, interrupted);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 記録は保たれる（再開始で消えない）。
    expect(outcome.state.orderItems[0]!.interruptedAt).toBe(NOW - 1_000);
  });

  it("品目の麺種がプリセットに無ければ既存の InvalidSlotOrNoodle で拒否する", () => {
    const retired: OrderItem = { ...ORDER, noodleType: "Retired" };
    const outcome = start({ ...EMPTY_STATE, orderItems: [retired] }, retired);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // 新しい code を足さない——設定に麺種が無いことは既存の拒否事由である。
    expect(outcome.rejection.code).toBe("InvalidSlotOrNoodle");
  });

  it("空の slotIds は InvalidSlotOrNoodle で拒否する（validateStart の共有）", () => {
    const outcome = start({ ...EMPTY_STATE, orderItems: [ORDER] }, ORDER, []);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejection.code).toBe("InvalidSlotOrNoodle");
  });
});

describe("Feature: slot-suggested-start — 検査しないもの（要件 3.7）", () => {
  it("走行中の釜へ重ねても拒否しない（占有を検査しない）", () => {
    // 提案からの重畳は「押す場所が idle にしかない」ことで client 側の構造が防ぐ。engine は見ない。
    const first = start({ ...EMPTY_STATE, orderItems: [ORDER] }, ORDER);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second: OrderItem = { ...ORDER, externalOrderId: "o-2" };
    const outcome = decide(
      { ...first.state, orderItems: [ORDER, second] },
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
    const wide: OrderItem = { ...ORDER, slotSpan: 2 };
    // slotSpan 2 の品目を 1 釜で開始する。
    expect(start({ ...EMPTY_STATE, orderItems: [wide] }, wide, ["0"]).ok).toBe(true);
    // 逆（slotSpan 1 を 2 釜で）も通る。
    expect(start({ ...EMPTY_STATE, orderItems: [ORDER] }, ORDER, ["0", "1"]).ok).toBe(true);
  });
});

describe("Feature: slot-suggested-start — Effect 列は既存 start と同一（要件 3.8）", () => {
  it("Persist が先頭に立ち、Broadcast は snapshot ちょうど 1 件である", () => {
    const outcome = start({ ...EMPTY_STATE, orderItems: [ORDER] }, ORDER);
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
      { ...EMPTY_STATE, orderItems: [ORDER] },
      {
        externalOrderId: "missing",
        itemIndex: 0,
      },
    );
    expect(outcome.ok).toBe(false);
  });
});

describe("Feature: lift-group-planning — 走行中の Timer は由来する卓を持つ（要件 3.1 / 3.2 / 3.6）", () => {
  it("品目からの開始は OrderItem の卓を orderItem の内側へ写す", () => {
    const state: TimerState = { ...EMPTY_STATE, orderItems: [ORDER] };
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
    const state: TimerState = { ...EMPTY_STATE, orderItems: [ORDER] };
    const started = start(state, ORDER);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    // 同じ注文が卓を変えて再送される。開始済みの品目も注文属性（卓）は更新されるが（order-lifecycle AC 2.1）、
    // 走行中 Timer は旧卓のまま（判断 7・性質 7.8）。
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
    // 再送で届いた未着手の品目（itemIndex 1）は新しい卓の群に入る。開始済みの itemIndex 0 も正本に残り
    // （卓は新しい値・状態は cooking のまま）、未調理には戻らない。
    expect(moved.state.orderItems.map((order) => [order.itemIndex, order.tableId])).toEqual([
      [0, "t-9"],
      [1, "t-9"],
    ]);
    expect(itemStatusOf(moved.state.orderItems[0]!, moved.state.timers)).toBe("cooking");
    expect(itemStatusOf(moved.state.orderItems[1]!, moved.state.timers)).toBe("unstarted");
  });
});

describe("Feature: pending-order-expiry — 期限切れの品目への開始は品目不在で拒否する（AC 2.5）", () => {
  /** 2 時間前に届いた品目。now がちょうど寿命なら期限切れ、1 ms 手前なら期限内。 */
  const OLD: OrderItem = {
    ...ORDER,
    externalOrderId: "o-old",
    arrivalTime: NOW - ORDER_LIFETIME_MS,
  };

  function startOldAt(state: TimerState, now: EpochMillis) {
    return decide(
      state,
      {
        type: "StartOrderItem",
        slotIds: ["0"],
        externalOrderId: OLD.externalOrderId,
        itemIndex: OLD.itemIndex,
        newTimerId: "t-old" as TimerId,
        now,
      },
      PARAMS,
    );
  }

  it("期限切れ（arrivalTime + 寿命 = now）の品目は、待ち行列に無い品目と同じ OrderItemNotFound で拒否し、状態は不変", () => {
    const state: TimerState = { ...EMPTY_STATE, orderItems: [OLD] };
    const outcome = startOldAt(state, NOW);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // 新しい拒否事由は足さない。
    expect(outcome.rejection.code).toBe("OrderItemNotFound");
    expect(state.orderItems).toEqual([OLD]);
  });

  it("同じ品目でも now が 1 ms 手前なら期限内で、開始できる（now だけが違う 2 本）", () => {
    const state: TimerState = { ...EMPTY_STATE, orderItems: [OLD] };
    const outcome = startOldAt(state, (NOW - 1) as EpochMillis);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.timers[0]!.orderItem?.externalOrderId).toBe("o-old");
    // 品目は消費されず正本に残る（order-lifecycle AC 1.1）。
    expect(outcome.state.orderItems).toEqual([OLD]);
  });

  it("開始は正本に触れない：生きている品目を始めても期限切れの未調理品目は正本に残り、snapshot には載らない", () => {
    const state: TimerState = { ...EMPTY_STATE, orderItems: [OLD, ORDER] };
    const outcome = start(state, ORDER);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.orderItems).toBe(state.orderItems);
    const broadcast = outcome.effects.find((effect) => effect.type === "Broadcast");
    if (broadcast?.type !== "Broadcast" || broadcast.message.type !== "snapshot") {
      throw new Error("snapshot が無い");
    }
    // 配信は「期限内 ∨ 生きた Timer の参照先」——期限切れの未調理 OLD は載らず、調理中の ORDER は載る（AC 4.2）。
    expect(broadcast.message.pendingOrders).toEqual(
      orderItemsToBroadcast(outcome.state.orderItems, outcome.state.timers, NOW),
    );
    expect(broadcast.message.pendingOrders).toEqual([ORDER]);
  });
});
