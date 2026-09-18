// tests/core/assign-table.example.test.ts — 店が品目の卓を決める遷移（AssignTable・order-flow・2026-09-17）。
//
// 固定するのは 4 つ——
//   1. 品目の tableId と tableAssignedAt が書かれ、確定変化として Persist / Broadcast が出る
//   2. 調理中の品目なら、参照する走行中 Timer の卓（計画の錨）も同じ値になる
//   3. 店が決めた卓は POS の後着で上書きされない（決めていない品目は従来どおり POS に従う）
//   4. 集合に無い品目は OrderItemNotFound で状態不変

import { describe, expect, it } from "vitest";
import { decide } from "../../src/engine/decide";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import type { Effect } from "../../src/engine/effect";
import type { Event } from "../../src/engine/event";
import type { EpochMillis, TimerId } from "../../src/engine/types";
import { DEFAULT_NOODLE_PRESETS } from "../../src/domain/store";
import type { OrderItem } from "../../src/domain/order";
import { settleParams } from "../settleParams";
import { nonEmpty } from "../nonEmpty";

const NOW = 1_700_000_000_000 as EpochMillis;
const PARAMS = settleParams({ arms: 2, toleranceRatio: 10 });

function item(externalOrderId: string, tableId: string | null = "1"): OrderItem {
  return {
    externalOrderId,
    itemIndex: 0,
    noodleType: DEFAULT_NOODLE_PRESETS[0].noodleType,
    firmness: "normal",
    tableId,
    arrivalTime: NOW - 60_000,
    portions: 1,
    itemName: "かけ",
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
    tableAssignedAt: null,
  };
}

function step(state: TimerState, event: Event): { state: TimerState; effects: readonly Effect[] } {
  const outcome = decide(state, event, PARAMS);
  if (!outcome.ok) throw new Error(`rejected ${event.type}: ${outcome.rejection.code}`);
  return outcome;
}

function assign(target: OrderItem, tableId: string | null, now: EpochMillis = NOW): Event {
  return {
    type: "AssignTable",
    externalOrderId: target.externalOrderId,
    itemIndex: target.itemIndex,
    tableId,
    now,
  };
}

function itemOf(state: TimerState, target: OrderItem): OrderItem {
  const found = state.orderItems.find(
    (candidate) => candidate.externalOrderId === target.externalOrderId,
  );
  if (found === undefined) throw new Error(`missing ${target.externalOrderId}`);
  return found;
}

describe("AssignTable — 店が品目の卓を決める", () => {
  const A = item("o-a");
  const B = item("o-b");
  const base: TimerState = { ...EMPTY_STATE, orderItems: [A, B] };

  it("未調理の品目の卓を書き、tableAssignedAt = now を刻み、Persist 先頭で Broadcast する", () => {
    const { state, effects } = step(base, assign(A, "5"));
    expect(itemOf(state, A)).toEqual({ ...A, tableId: "5", tableAssignedAt: NOW });
    expect(itemOf(state, B)).toEqual(B);
    expect(effects[0]?.type).toBe("Persist");
    expect(effects.some((effect) => effect.type === "Broadcast")).toBe(true);
  });

  it("null で卓なしへ戻せる（それも店の判断として刻む）", () => {
    const { state } = step(base, assign(A, null));
    expect(itemOf(state, A)).toEqual({ ...A, tableId: null, tableAssignedAt: NOW });
  });

  it("調理中の品目なら、参照する走行中 Timer の卓（計画の錨）も同じ値になる", () => {
    const started = step(base, {
      type: "StartOrderItem",
      slotIds: ["0"],
      externalOrderId: B.externalOrderId,
      itemIndex: B.itemIndex,
      newTimerId: "t-b" as TimerId,
      now: NOW,
    });
    expect(started.state.timers[0]?.orderItem?.tableId).toBe("1");
    const { state } = step(started.state, assign(B, "9", (NOW + 1_000) as EpochMillis));
    expect(itemOf(state, B).tableId).toBe("9");
    expect(state.timers[0]?.orderItem).toEqual({
      externalOrderId: "o-b",
      itemIndex: 0,
      tableId: "9",
    });
    // 計時には触れない。
    expect(state.timers[0]?.endTime).toBe(started.state.timers[0]?.endTime);
  });

  it("店が決めた卓は POS の後着で上書きされず、決めていない品目は POS に従う", () => {
    const assigned = step(base, assign(A, "5")).state;
    const { state } = step(assigned, {
      type: "OrderArrived",
      arrival: nonEmpty([{ ...item("o-a", "2"), itemName: "特製" }, { ...item("o-b", "3") }]),
      now: (NOW + 5_000) as EpochMillis,
    });
    // A: 卓は店の 5 のまま、他の POS 属性（名称）は更新される。
    expect(itemOf(state, A)).toMatchObject({
      tableId: "5",
      tableAssignedAt: NOW,
      itemName: "特製",
    });
    // B: 店は決めていないので POS の 3 に従う。
    expect(itemOf(state, B)).toMatchObject({ tableId: "3", tableAssignedAt: null });
  });

  it("集合に無い品目は OrderItemNotFound で状態不変", () => {
    const outcome = decide(base, assign(item("o-x"), "5"), PARAMS);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejection.code).toBe("OrderItemNotFound");
  });
});
