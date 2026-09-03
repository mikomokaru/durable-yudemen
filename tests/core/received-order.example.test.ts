// tests/core/received-order.example.test.ts — 受領イベント（RecordsReceived）と ReceivedOrder の形（pos-order-ingress AC 6.9 / 13.5）。
//
// 検査するのは 2 つ。`items` が空配列を受け付けること（空は「キャンセル、または麺を含まない注文」という
// 正常な入力であり、型で禁じてはならない）、そしてイベントが判別可能な和型の一員として網羅されること。
// 遷移の本体（受領をどう畳むか）は engine/receive.ts の担当ゆえ、ここでは主張しない。

import { describe, expect, it } from "vitest";
import { decide } from "../../src/engine/decide";
import type { Event, ReceivedOrder } from "../../src/engine/event";
import { EMPTY_STATE } from "../../src/engine/state";
import type { EpochMillis } from "../../src/engine/types";
import type { PendingOrder } from "../../src/domain/order";
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
  Assert<Equal<ReceivedOrder["items"], readonly PendingOrder[]>>,
  Assert<
    Equal<Extract<Event, { readonly type: "OrderArrived" }>["arrival"], NonEmptyArray<PendingOrder>>
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
