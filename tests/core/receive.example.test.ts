// tests/core/receive.example.test.ts — 受領遷移（engine/receive の arriveRecords）が畳む 5 通りを固定する
// （pos-order-ingress AC 6.7 / 6.10〜6.13 / 10.1 / 10.2）。
//
// 固定するのは design §7-a の畳み方そのもの——重複の読み飛ばし、非空での置換、0 件での除去、0 件かつ
// 既存なしでの無変更、そして同一受領内で同一端末の判定材料が到着順に進むこと。Property 側（receive.property）が
// 任意の受領列で不変を主張するのに対し、ここは「後着で品目が 3 → 1 に減る」のような具体の形を残す。

import { describe, expect, it } from "vitest";
import { decide } from "../../src/engine/decide";
import type { Event, ReceivedOrder } from "../../src/engine/event";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import type { Effect } from "../../src/engine/effect";
import type { EpochMillis } from "../../src/engine/types";
import type { PendingOrder } from "../../src/domain/order";
import { settleParams } from "../settleParams";

const PARAMS = settleParams({ arms: 2, toleranceRatio: 0.1 });
const NOW = 1_700_000_000_000 as EpochMillis;
const ARRIVAL = NOW - 30_000;

/** KDS が採番する実際の形（56 桁）。3 つは同じ桁数ゆえ辞書順が数値順に一致する。 */
const SEQ_1 = "49590338271490256608027716141221070800233838749102571521";
const SEQ_2 = "49590338271490256608027716141221070800233838749102571522";
const SEQ_3 = "49590338271490256608027716141221070800233838749102571523";

const ORDER_ID = "1%3A2%3A3%3A2026-08-17T20%3A52%3A19";
const TERMINAL = "2";

function item(itemIndex: number, externalOrderId: string = ORDER_ID): PendingOrder {
  return {
    externalOrderId,
    itemIndex,
    noodleType: "Thin",
    firmness: "normal",
    tableId: "3",
    arrivalTime: ARRIVAL,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
  };
}

function received(
  sequenceNumber: string,
  items: readonly PendingOrder[],
  externalOrderId: string = ORDER_ID,
  terminalId: string = TERMINAL,
): ReceivedOrder {
  return { externalOrderId, terminalId, sequenceNumber, items };
}

function event(...order: readonly ReceivedOrder[]): Event {
  return { type: "RecordsReceived", received: order, now: NOW };
}

/** 待ち行列に品目を据え、判定材料は当該端末について seq を進めた状態。 */
function stateWith(
  pendingOrders: readonly PendingOrder[],
  lastSequenceNumber?: string,
): TimerState {
  return {
    ...EMPTY_STATE,
    pendingOrders,
    lastSequenceByTerminal:
      lastSequenceNumber === undefined ? {} : { [TERMINAL]: lastSequenceNumber },
  };
}

const persists = (effects: readonly Effect[]): readonly Effect[] =>
  effects.filter((e) => e.type === "Persist");

describe("engine/receive — 受領を 1 つの遷移へ畳む", () => {
  it("後着で品目が減る（3 品目が 1 品目へ置換される・AC 6.7）", () => {
    const before = stateWith([item(0), item(1), item(2)], SEQ_1);

    const outcome = decide(before, event(received(SEQ_2, [item(1)])), PARAMS);

    // 追加ではなく置換——同一 Unique_Key の後着はそれまでの品目群を丸ごと置き換える。
    expect(outcome.ok && outcome.state.pendingOrders).toEqual([item(1)]);
    expect(outcome.ok && outcome.state.lastSequenceByTerminal).toEqual({ [TERMINAL]: SEQ_2 });
    expect(outcome.ok && persists(outcome.effects)).toHaveLength(1);
  });

  it("翻訳結果 0 件かつ既存ありは除去に写り、判定材料は進む（AC 6.11）", () => {
    const before = stateWith([item(0), item(1)], SEQ_1);

    const outcome = decide(before, event(received(SEQ_2, [])), PARAMS);

    expect(outcome.ok && outcome.state.pendingOrders).toEqual([]);
    expect(outcome.ok && outcome.state.lastSequenceByTerminal).toEqual({ [TERMINAL]: SEQ_2 });
    expect(outcome.ok && persists(outcome.effects)).toHaveLength(1);
  });

  it("翻訳結果 0 件かつ既存なしは集合を変えず、判定材料だけを進める（AC 6.12）", () => {
    const before = stateWith([item(0, "other-order")], SEQ_1);

    const outcome = decide(before, event(received(SEQ_2, [])), PARAMS);

    // 集合は同一インスタンスのまま——麺を含まない注文は正常な入力であり、他の注文を巻き込まない。
    expect(outcome.ok && outcome.state.pendingOrders).toBe(before.pendingOrders);
    // それでも材料は進む。進めなければ同じ注文が再送のたびに翻訳をやり直される。
    expect(outcome.ok && outcome.state.lastSequenceByTerminal).toEqual({ [TERMINAL]: SEQ_2 });
    expect(outcome.ok && persists(outcome.effects)).toHaveLength(1);
  });

  it("判定材料以下の seq は読み飛ばし、集合も材料も動かさない（AC 10.1 / 10.2）", () => {
    const before = stateWith([item(0)], SEQ_2);

    // 同値（再送そのもの）と、それより古い seq の 2 つを同じ受領に混ぜる。
    const outcome = decide(before, event(received(SEQ_2, [item(9)]), received(SEQ_1, [])), PARAMS);

    expect(outcome.ok && outcome.state).toBe(before);
    expect(outcome.ok && outcome.effects).toEqual([]);
  });

  it("同一受領内の同一端末は到着順に材料が進む（最後の seq が残る）", () => {
    const outcome = decide(
      stateWith([]),
      event(received(SEQ_1, [item(0)]), received(SEQ_3, [item(0)]), received(SEQ_2, [item(0)])),
      PARAMS,
    );

    // 3 件目（SEQ_2）は 2 件目で進んだ材料に照らして古い——畳んだ途中の値と突き合わせている証拠。
    expect(outcome.ok && outcome.state.lastSequenceByTerminal).toEqual({ [TERMINAL]: SEQ_3 });
    expect(outcome.ok && persists(outcome.effects)).toHaveLength(1);
  });

  it("端末ごとに独立して進む（別端末の古い seq は重複にならない）", () => {
    const before = stateWith([], SEQ_3);

    const outcome = decide(before, event(received(SEQ_1, [item(0)], ORDER_ID, "9")), PARAMS);

    expect(outcome.ok && outcome.state.lastSequenceByTerminal).toEqual({
      [TERMINAL]: SEQ_3,
      "9": SEQ_1,
    });
    expect(outcome.ok && outcome.state.pendingOrders).toHaveLength(1);
  });
});
