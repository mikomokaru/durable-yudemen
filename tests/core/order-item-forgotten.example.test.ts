// tests/core/order-item-forgotten.example.test.ts — 忘れられた品目の帰結（Requirement 3）。
//
// Feature: order-item-truncation, Requirement 3
// **Validates: Requirements 3.1, 3.2, 3.4, 3.5, 4.6**
//
// **新しいコードは無い。** 上限で品目が落ちたとき、engine が通るのは既に在る経路である——参照先の無い Timer
// （アドホック開始・v12 由来の Timer が既に通っている道・order-lifecycle 判断 13）と、集合に無い品目への開始
// （`OrderItemNotFound`）。ここはそれを回帰として固定する。
//
// 場面は**実際に truncation を通して**作る。状態を手で組んで「参照先が無い」形を置くのではなく、満杯の集合へ
// 新しい注文が届いて最も古い品目が落ちる、という本物の経路で作る——手で組めば「上限がその状態を生む」ことは
// 検査されない。

import { describe, expect, it } from "vitest";
import { decide } from "../../src/engine/decide";
import { completeTimer } from "../../src/engine/complete";
import { cancelTimer } from "../../src/engine/cancel";
import { ORDER_ITEM_LIMIT, upsertOrder } from "../../src/engine/pending";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { Effect } from "../../src/engine/effect";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { itemKeyOf, orderItemOf, type OrderItem } from "../../src/domain/order";
import { DEFAULT_NOODLE_PRESETS } from "../../src/domain/store";
import { settleParams } from "../settleParams";
import { nonEmpty } from "../nonEmpty";

const PARAMS = settleParams({ arms: 2, toleranceRatio: 0.1 });
const NOW = 1_700_000_000_000 as EpochMillis;
const NOODLE = DEFAULT_NOODLE_PRESETS[0]!.noodleType;

function item(externalOrderId: string, itemIndex: number, arrivalTime: number): OrderItem {
  return {
    externalOrderId,
    itemIndex,
    noodleType: NOODLE,
    firmness: "normal",
    tableId: "t-1",
    arrivalTime,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
  };
}

/** 満杯 −1 件の「新しい側」の集合（最も古い 1 件は呼び出し側が前に足す）。 */
function newerFill(count: number): readonly OrderItem[] {
  return Array.from({ length: count }, (_unused, index) =>
    item(`fill-${String(index).padStart(6, "0")}`, 0, 10_000 + index),
  );
}

function timerFor(target: OrderItem): Timer {
  return createTimer({
    id: "t-cooking" as TimerId,
    slotIds: nonEmpty(["0" as SlotId]),
    noodleType: NOODLE as NoodleType,
    firmness: "normal",
    startTime: NOW,
    endTime: (NOW + 120_000) as EpochMillis,
    seq: 0,
    orderItem: {
      externalOrderId: target.externalOrderId,
      itemIndex: target.itemIndex,
      tableId: target.tableId,
    },
  });
}

/**
 * 「最も古い 1 件が調理中のまま忘れられた」状態を、本物の経路（`upsertOrder` の出口の上限）で作る。
 *
 * 何も守らない（判断 3）ので、生きた Timer の参照先でも落ちる。
 */
function forgetCookingItem(): { state: TimerState; forgotten: OrderItem; timer: Timer } {
  const forgotten = item("o-forgotten", 0, 1_000);
  const before = [forgotten, ...newerFill(ORDER_ITEM_LIMIT - 1)];
  const timer = timerFor(forgotten);
  const arriving = item("o-new", 0, 99_000_000);

  const after = upsertOrder(before, [timer], nonEmpty([arriving]));

  // 前提の確認——満杯だった集合に 1 件届き、最も古い（＝調理中の参照先）が落ちた。
  expect(before.length).toBe(ORDER_ITEM_LIMIT);
  expect(after.length).toBe(ORDER_ITEM_LIMIT);
  expect(after.some((each) => itemKeyOf(each) === itemKeyOf(forgotten))).toBe(false);

  return {
    state: { ...EMPTY_STATE, orderItems: after, timers: [timer], nextSeq: 1 },
    forgotten,
    timer,
  };
}

describe("忘れられた参照先を持つ Timer は既存の経路を通る（AC 3.1）", () => {
  it("orderItemOf は null を返す——参照先の無い Timer を扱う経路は一つ", () => {
    const { state, timer } = forgetCookingItem();

    expect(orderItemOf(timer, state.orderItems)).toBeNull();
  });

  it("Complete は Timer を閉じ、品目には何も書かない（completedAt の書き先が無い）", () => {
    const { state, timer } = forgetCookingItem();

    const outcome = completeTimer(state, timer.id, NOW, PARAMS);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.timers).toHaveLength(0);
    // 集合は同一インスタンスのまま（書き先が無いので写しも作らない）。
    expect(outcome.state.orderItems).toBe(state.orderItems);
    expect(outcome.state.orderItems.some((each) => each.completedAt !== null)).toBe(false);
  });

  it("Cancel は Timer を閉じ、品目には何も書かない（interruptedAt の書き先が無い）", () => {
    const { state, timer } = forgetCookingItem();

    const outcome = cancelTimer(state, timer.id, NOW, PARAMS);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.timers).toHaveLength(0);
    expect(outcome.state.orderItems).toBe(state.orderItems);
    expect(outcome.state.orderItems.some((each) => each.interruptedAt !== null)).toBe(false);
  });
});

describe("忘れられた未調理の品目への開始は既存の拒否事由（AC 3.2）", () => {
  it("StartOrderItem は OrderItemNotFound——新しい拒否事由は足さない", () => {
    // 未調理のまま落ちる場面（Timer は持たせない）。
    const forgotten = item("o-forgotten", 0, 1_000);
    const before = [forgotten, ...newerFill(ORDER_ITEM_LIMIT - 1)];
    const after = upsertOrder(before, [], nonEmpty([item("o-new", 0, 99_000_000)]));
    expect(after.some((each) => itemKeyOf(each) === itemKeyOf(forgotten))).toBe(false);
    const state: TimerState = { ...EMPTY_STATE, orderItems: after };

    const outcome = decide(
      state,
      {
        type: "StartOrderItem",
        slotIds: ["0"],
        externalOrderId: forgotten.externalOrderId,
        itemIndex: forgotten.itemIndex,
        newTimerId: "t-new" as TimerId,
        now: NOW,
      },
      PARAMS,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejection.code).toBe("OrderItemNotFound");
  });
});

describe("忘れられた注文の後着は新しい arrivalTime で入り直す（AC 3.4）", () => {
  it("引き継ぐ起点が無いので生き返る——本 spec は「生き返らない」を保証しない", () => {
    const forgotten = item("o-forgotten", 0, 1_000);
    const before = [forgotten, ...newerFill(ORDER_ITEM_LIMIT - 1)];
    const after = upsertOrder(before, [], nonEmpty([item("o-new", 0, 99_000_000)]));
    expect(after.some((each) => each.externalOrderId === "o-forgotten")).toBe(false);

    // 同じ注文の後着。`earliestArrival` の起点（同じ externalOrderId の品目）はもう集合に無い。
    const late = item("o-forgotten", 0, 99_500_000);
    const revived = upsertOrder(after, [], nonEmpty([late]));

    const found = revived.find((each) => each.externalOrderId === "o-forgotten");
    expect(found).toBeDefined();
    // **元の 1_000 ではなく、到着の値がそのまま入る。** 引き継ぎは「集合に残っている間」だけ効く
    // （pending-order-expiry AC 2.8 と同じ立場）。4096 件先の後着は現実の運用に無いので保証しない。
    expect(found!.arrivalTime).toBe(99_500_000);
  });
});

describe("忘れられた品目は Broadcast にも wire にも現れない（AC 3.5 / 4.6）", () => {
  const snapshotOf = (effects: readonly Effect[]) => {
    const broadcast = effects.find(
      (effect) => effect.type === "Broadcast" && effect.message.type === "snapshot",
    );
    if (broadcast?.type !== "Broadcast" || broadcast.message.type !== "snapshot") {
      throw new Error("snapshot の Broadcast が無い");
    }
    return broadcast.message;
  };

  it("正本に無いものは orderItems に載らない。その品目を指す Timer は TimerFact として載り続ける", () => {
    const { state, forgotten, timer } = forgetCookingItem();

    // 確定変化を 1 つ起こして snapshot を出させる（内容の違う後着）。
    const outcome = decide(
      state,
      { type: "OrderArrived", arrival: nonEmpty([item("o-trigger", 0, 99_900_000)]), now: NOW },
      PARAMS,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const snapshot = snapshotOf(outcome.effects);

    // 忘れられた品目は載らない——`orderItemsToBroadcast` は正本を絞るので、正本に無いものは載らない。
    expect(snapshot.orderItems.some((each) => itemKeyOf(each) === itemKeyOf(forgotten))).toBe(
      false,
    );
    // Timer は載り続ける（参照は解けないが Timer は開始時に写した値だけで成立する）。
    const fact = snapshot.timers.find((each) => each.id === timer.id);
    expect(fact).toBeDefined();
    expect(fact!.orderItem).toEqual({
      externalOrderId: forgotten.externalOrderId,
      itemIndex: forgotten.itemIndex,
    });
    // client 側の解決も null（釜のカードは麺種だけで出す）。
    expect(orderItemOf(fact!, snapshot.orderItems)).toBeNull();
  });
});
