// tests/core/order-item-bound.example.test.ts — 実走での有界性（性質 5.9）。
//
// Feature: order-item-truncation, Property 5.9
// **Validates: Requirements 2.4, 5.9**
//
// 閉包性（`order-item-bound.property`・性質 5.8）は**変換ごとに独立して**件数の動きを検査する。それは
// 「現在存在する変換の列挙」であって網羅ではない（design の既知の限界）。ここはその二重の網——engine を
// **実走**させ、任意の系列の到着・開始・完了・キャンセル・後着・外部計画の受領・hydration を与えて、
// `TimerState.orderItems.length ≤ ORDER_ITEM_LIMIT` が**どの時点でも**成り立つことを確かめる。
//
// 実走ゆえ `decide` という公開の口だけを通す。どこかの変換が上限を迂回すれば、列挙に載っていなくてもここで落ちる。

import { describe, expect, it } from "vitest";
import { decide } from "../../src/engine/decide";
import { migrate } from "../../src/engine/migrate";
import { fromSnapshot, toSnapshot } from "../../src/engine/snapshot";
import { ORDER_ITEM_LIMIT } from "../../src/engine/pending";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import type { Event } from "../../src/engine/event";
import type { EpochMillis, TimerId } from "../../src/engine/types";
import type { OrderItem } from "../../src/domain/order";
import { DEFAULT_NOODLE_PRESETS } from "../../src/domain/store";
import { settleParams } from "../settleParams";
import { nonEmpty } from "../nonEmpty";

const PARAMS = settleParams({ arms: 2, toleranceRatio: 0.1 });
const T0 = 1_700_000_000_000;
const at = (seconds: number) => (T0 + seconds * 1000) as EpochMillis;

/** POS が送ってくる 1 注文（1 品目）。麺種はプリセットに在るものを使う。 */
function arrival(index: number, arrivalTime: number): OrderItem {
  return {
    externalOrderId: `o-${String(index).padStart(6, "0")}`,
    itemIndex: 0,
    noodleType: DEFAULT_NOODLE_PRESETS[0]!.noodleType,
    firmness: "normal",
    tableId: `t-${index % 20}`,
    arrivalTime,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
  };
}

/** 一手進める。拒否は「その操作が今は成立しない」だけなので状態を据え置いて続ける。 */
function step(state: TimerState, event: Event): TimerState {
  const outcome = decide(state, event, PARAMS);
  return outcome.ok ? outcome.state : state;
}

describe("実走での有界性（order-item-truncation 性質 5.9）", () => {
  it("到着・開始・完了・キャンセル・後着・hydration を混ぜて回しても、どの時点でも上限を超えない", () => {
    let state: TimerState = EMPTY_STATE;
    let timerSeq = 0;
    let issued = 0;
    // 上限の 2 倍以上を投入して、上限に達した後の定常状態を十分に踏む。到着は 1 遷移に BATCH 件を
    // まとめる——1 品ずつだと遷移が 8000 回を超え、毎回の計画の組み直しで実行時間が数分に伸びる。
    // 検査したいのは「遷移を何度通しても件数が上限を超えない」ことであって、遷移の細かさではない。
    const BATCH = 64;
    const ROUNDS = Math.ceil((ORDER_ITEM_LIMIT * 2 + 50) / BATCH);

    for (let round = 0; round < ROUNDS; round++) {
      const now = at(round);

      // 1. 到着（毎回・BATCH 件）。
      const batch = Array.from({ length: BATCH }, () => arrival(issued++, now));
      state = step(state, { type: "OrderArrived", arrival: nonEmpty(batch), now });

      // 2. ときどき開始する。開始できた Timer は次の周で完了・キャンセルの対象になる。
      if (round % 7 === 0) {
        const target = state.orderItems.at(-1);
        if (target !== undefined) {
          state = step(state, {
            type: "StartOrderItem",
            slotIds: [String(timerSeq % 6)],
            externalOrderId: target.externalOrderId,
            itemIndex: target.itemIndex,
            newTimerId: `t-${timerSeq++}` as TimerId,
            now,
          });
        }
      }

      // 3. ときどき完了・キャンセルする（厨房の事実を品目へ書く経路）。
      const live = state.timers[0];
      if (live !== undefined && round % 11 === 0) {
        state = step(state, { type: "Complete", timerId: live.id, now });
      }
      if (live !== undefined && round % 13 === 0) {
        state = step(state, { type: "Cancel", timerId: live.id, now });
      }

      // 4. ときどき後着（同じ注文の属性更新）と POS 取消を混ぜる。
      const existing = state.orderItems[0];
      if (existing !== undefined && round % 17 === 0) {
        state = step(state, {
          type: "OrderArrived",
          arrival: nonEmpty([{ ...existing, tableId: "t-moved" }]),
          now,
        });
      }
      if (existing !== undefined && round % 19 === 0) {
        state = step(state, {
          type: "OrderCancelled",
          externalOrderId: existing.externalOrderId,
          now,
        });
      }

      // 5. ときどき hydration を挟む（永続を経由して状態を組み直す）。
      if (round % 23 === 0) {
        const revived = migrate(structuredClone(toSnapshot(state)) as unknown);
        expect(revived.ok).toBe(true);
        if (revived.ok) state = fromSnapshot(revived.snapshot);
      }

      // **どの時点でも**上限を超えない。
      expect(state.orderItems.length).toBeLessThanOrEqual(ORDER_ITEM_LIMIT);
    }

    // 十分に投入したので、終状態は上限に張り付いている（この場面が上限の経路を実際に踏んだ証拠）。
    expect(state.orderItems.length).toBe(ORDER_ITEM_LIMIT);
  });
});
