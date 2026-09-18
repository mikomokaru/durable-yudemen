// tests/core/received-order.example.test.ts — 受領イベント（RecordsReceived）と ReceivedOrder の形（pos-order-ingress AC 6.9 / 13.5）、
// および後着が品目の生涯をどう扱うかの回帰（order-lifecycle Requirement 2）。
//
// 検査するのは 3 つ。`items` が空配列を受け付けること（空は「キャンセル、または麺を含まない注文」という
// 正常な入力であり、型で禁じてはならない）、イベントが判別可能な和型の一員として網羅されること、そして
// 後着（RecordsReceived の再送）が状態にかかわらず注文属性だけを更新し、厨房の事実と生きた Timer を保つこと。
// 前提（POS の取消は発生しない）を理由に受理を黙って変えないことを、実際の入口で固定する（AC 2.6）。
//
// **Validates: order-lifecycle Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 7.5**

import { describe, expect, it } from "vitest";
import { decide } from "../../src/engine/decide";
import type { Event, ReceivedOrder } from "../../src/engine/event";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import type { EpochMillis, TimerId } from "../../src/engine/types";
import { DEFAULT_NOODLE_PRESETS } from "../../src/domain/store";
import { itemStatusOf, type OrderItem } from "../../src/domain/order";
import type { NonEmptyArray } from "../../src/domain/timer";
import { settleParams } from "../settleParams";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type RecordsReceivedEvent = Extract<Event, { readonly type: "RecordsReceived" }>;

type ReceivedShapeAssertions = [
  // イベント種別の網羅。slot-suggested-start が StartOrderItem を足した（既存は動かさない）。
  Assert<
    Equal<
      Event["type"],
      | "Start"
      | "StartOrderItem"
      | "Cancel"
      | "Complete"
      | "Adjust"
      // order-flow（2026-09-17）が店の卓の指定 AssignTable を足した（既存は動かさない）。
      | "AssignTable"
      | "AlarmFired"
      | "Reconcile"
      | "OrderArrived"
      | "OrderCancelled"
      | "PlanArrived"
      | "RecordsReceived"
    >
  >,
  Assert<Equal<keyof RecordsReceivedEvent, "type" | "received" | "now">>,
  Assert<Equal<keyof ReceivedOrder, "externalOrderId" | "terminalId" | "sequenceNumber" | "items">>,
  // **items は NonEmptyArray ではない。** 非空を型で要求するのは 1 つの到着だけを扱う OrderArrived の側で、
  // 受領単位では空が意味を持つ（0 件は除去または無変更）。両者が別の基数を持つことをここで固定する。
  Assert<Equal<ReceivedOrder["items"], readonly OrderItem[]>>,
  Assert<
    Equal<Extract<Event, { readonly type: "OrderArrived" }>["arrival"], NonEmptyArray<OrderItem>>
  >,
];
const receivedShapeAssertions: ReceivedShapeAssertions = [true, true, true, true, true];

const PARAMS = settleParams({ arms: 2, toleranceRatio: 0.1 });
const NOW = 1_700_000_000_000 as EpochMillis;

describe("engine/event — RecordsReceived と ReceivedOrder", () => {
  it("items が空配列の受領単位を構築できる（キャンセル・麺を含まない注文）", () => {
    const cancelled: ReceivedOrder = {
      externalOrderId: "1%3A2%3A3%3A2026-08-17T20%3A52%3A19",
      terminalId: "2",
      sequenceNumber: "49590338271490256608027716141221070800233838749102571522",
      items: [],
    };
    expect(cancelled.items).toEqual([]);
    expect(receivedShapeAssertions).toEqual([true, true, true, true, true]);
  });

  it("判別可能な和型の一員として decide へ渡せる（種別で分岐できる）", () => {
    const event: Event = { type: "RecordsReceived", received: [], now: NOW };
    expect(event.type === "RecordsReceived" && event.received).toEqual([]);
    // 受領を状態へどう畳むかは engine/receive.ts の担当。ここで見るのは配線が型として成立することだけ。
    expect(decide(EMPTY_STATE, event, PARAMS).ok).toBe(true);
  });
});

// ── 後着と品目の生涯（order-lifecycle Requirement 2 の回帰 6 件） ──────────────────────────────────

const MINUTE = 60_000;
const ORDER_ID = "o-1";

function item(
  itemIndex: number,
  arrivalTime: number,
  overrides: Partial<OrderItem> = {},
): OrderItem {
  return {
    externalOrderId: ORDER_ID,
    itemIndex,
    noodleType: DEFAULT_NOODLE_PRESETS[0].noodleType,
    firmness: "normal",
    tableId: "t-1",
    arrivalTime,
    portions: 1,
    itemName: null,
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
    tableAssignedAt: null,
    ...overrides,
  };
}

function at(minutes: number): EpochMillis {
  return (NOW + minutes * MINUTE) as EpochMillis;
}

/** 受領（同じ端末の seq を進めながら再送する）。 */
let sequence = 0;
function receive(state: TimerState, items: readonly OrderItem[], now: EpochMillis): TimerState {
  sequence += 1;
  const received: ReceivedOrder = {
    externalOrderId: ORDER_ID,
    terminalId: "pos-1",
    sequenceNumber: String(sequence).padStart(56, "0"),
    items,
  };
  return apply(state, { type: "RecordsReceived", received: [received], now });
}

function apply(state: TimerState, event: Event): TimerState {
  const outcome = decide(state, event, PARAMS);
  if (!outcome.ok) throw new Error(`rejected ${event.type}: ${outcome.rejection.code}`);
  return outcome.state;
}

function start(state: TimerState, itemIndex: number, now: EpochMillis, id: string): TimerState {
  return apply(state, {
    type: "StartOrderItem",
    slotIds: [String(itemIndex)],
    externalOrderId: ORDER_ID,
    itemIndex,
    newTimerId: id as TimerId,
    now,
  });
}

function itemAt(state: TimerState, itemIndex: number): OrderItem {
  const found = state.orderItems.find(
    (each) => each.externalOrderId === ORDER_ID && each.itemIndex === itemIndex,
  );
  if (found === undefined) throw new Error(`品目が無い: ${ORDER_ID}#${itemIndex}`);
  return found;
}

describe("後着は注文属性だけを更新し、厨房の事実と生きた Timer を保つ（order-lifecycle Requirement 2）", () => {
  const A = item(0, NOW);
  const B = item(1, NOW);

  it("回帰 1：A を調理中に {A, B} が再送されても A は正本に残り、参照が解ける（AC 2.1 / 2.2・性質 7.2）", () => {
    const s1 = receive(EMPTY_STATE, [A, B], NOW);
    const s2 = start(s1, 0, at(1), "t-a");
    const s3 = receive(s2, [item(0, at(2), { tableId: "t-9" }), item(1, at(2))], at(2));
    expect(s3.orderItems.map((each) => each.itemIndex)).toEqual([0, 1]);
    expect(itemStatusOf(itemAt(s3, 0), s3.timers)).toBe("cooking");
    // 注文属性（卓）は更新され、起点は引き継がれ、Timer は旧卓のまま（性質 7.8）。
    expect(itemAt(s3, 0)).toEqual({ ...A, tableId: "t-9" });
    expect(s3.timers[0]!.orderItem).toEqual({
      externalOrderId: ORDER_ID,
      itemIndex: 0,
      tableId: "t-1",
    });
  });

  it("回帰 2：done の品目は再送で unstarted に戻らない（completedAt を保つ）", () => {
    const s1 = receive(EMPTY_STATE, [A, B], NOW);
    const s2 = start(s1, 0, at(1), "t-a");
    const s3 = apply(s2, { type: "Complete", timerId: "t-a" as TimerId, now: at(9) });
    const s4 = receive(s3, [item(0, at(10)), item(1, at(10))], at(10));
    expect(itemAt(s4, 0).completedAt).toBe(at(9));
    expect(itemStatusOf(itemAt(s4, 0), s4.timers)).toBe("done");
  });

  it("回帰 3：Cancel → 再送でも interruptedAt を保持する（POS は厨房の中断時刻を持たない）", () => {
    const s1 = receive(EMPTY_STATE, [A, B], NOW);
    const s2 = start(s1, 0, at(1), "t-a");
    const s3 = apply(s2, { type: "Cancel", timerId: "t-a" as TimerId, now: at(2) });
    const s4 = receive(s3, [item(0, at(3), { itemName: "かけ" }), item(1, at(3))], at(3));
    expect(itemAt(s4, 0)).toEqual({ ...A, interruptedAt: at(2), itemName: "かけ" });
    expect(itemStatusOf(itemAt(s4, 0), s4.timers)).toBe("unstarted");
  });

  it("回帰 4：再開始 → 完了で done になっても interruptedAt は保持される", () => {
    const s1 = receive(EMPTY_STATE, [A], NOW);
    const s2 = start(s1, 0, at(1), "t-a");
    const s3 = apply(s2, { type: "Cancel", timerId: "t-a" as TimerId, now: at(2) });
    const s4 = start(s3, 0, at(3), "t-a2");
    const s5 = apply(s4, { type: "Complete", timerId: "t-a2" as TimerId, now: at(12) });
    expect(itemAt(s5, 0)).toEqual({ ...A, interruptedAt: at(2), completedAt: at(12) });
    expect(itemStatusOf(itemAt(s5, 0), s5.timers)).toBe("done");
  });

  it("回帰 5：interruptedAt は次の Cancel でだけ上書きされる（再送・再開始・完了では動かない）", () => {
    const s1 = receive(EMPTY_STATE, [A], NOW);
    const s2 = start(s1, 0, at(1), "t-a");
    const s3 = apply(s2, { type: "Cancel", timerId: "t-a" as TimerId, now: at(2) });
    const s4 = receive(s3, [item(0, at(3))], at(3));
    expect(itemAt(s4, 0).interruptedAt).toBe(at(2));
    const s5 = start(s4, 0, at(4), "t-a2");
    expect(itemAt(s5, 0).interruptedAt).toBe(at(2));
    const s6 = apply(s5, { type: "Cancel", timerId: "t-a2" as TimerId, now: at(5) });
    expect(itemAt(s6, 0).interruptedAt).toBe(at(5));
  });

  it("回帰 6：後着に無い品目は unstarted だけ除き、cooking / done は残す。0 件（除去）も同じ規則（AC 2.5 / 2.6）", () => {
    const C = item(2, NOW);
    const s1 = receive(EMPTY_STATE, [A, B, C], NOW);
    const s2 = start(s1, 0, at(1), "t-a");
    const s3 = start(s2, 1, at(1), "t-b");
    const s4 = apply(s3, { type: "Complete", timerId: "t-b" as TimerId, now: at(9) });
    // A は cooking・B は done・C は unstarted。後着は D だけを含む。
    const D = item(3, at(10));
    const s5 = receive(s4, [D], at(10));
    expect(s5.orderItems.map((each) => each.itemIndex)).toEqual([0, 1, 3]);
    expect(itemStatusOf(itemAt(s5, 0), s5.timers)).toBe("cooking");
    expect(itemStatusOf(itemAt(s5, 1), s5.timers)).toBe("done");
    // 新しい品目は厨房の事実 null・起点は注文の最早（NOW）を引き継ぐ（AC 2.3 / 2.4）。
    expect(itemAt(s5, 3)).toEqual(item(3, NOW));
    // 0 件の後着（除去）は未調理の D だけを除く。
    const s6 = receive(s5, [], at(11));
    expect(s6.orderItems.map((each) => each.itemIndex)).toEqual([0, 1]);
    // 受理は前提を理由に変わらない——同じ内容の再送は no-op。
    expect(receive(s6, [], at(12)).orderItems).toBe(s6.orderItems);
  });
});
