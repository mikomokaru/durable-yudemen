// tests/core/start-order-item.property.test.ts — 品目からの開始（slot-suggested-start Property 4 / 5）。
//
// **Validates: Requirements 3.3, 3.4**
//
// 品目を指す開始が「サーバの事実から導く」ことを問う。client は麺種も茹で加減も茹で秒も送らないため、
// Timer に載る値の出所は待ち行列の品目と麺種プリセットの 2 つだけである。ここが破れれば、現に壊れていた
// 「茹で加減が届かず既定で作られる」に戻る。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EMPTY_STATE } from "../../src/engine/state";
import { decide } from "../../src/engine/decide";
import { DEFAULT_NOODLE_PRESETS } from "../../src/domain/store";
import { FIRMNESS_ORDER } from "../../src/domain/firmness";
import type { Firmness } from "../../src/domain/firmness";
import type { PendingOrder } from "../../src/domain/order";
import type { EpochMillis, TimerId } from "../../src/engine/types";
import type { TimerState } from "../../src/engine/state";
import { settleParams } from "../settleParams";

const NOW = 1_700_000_000_000 as EpochMillis;
const PARAMS = settleParams({ arms: 2, toleranceRatio: 10 });
/** プリセットが持つ麺種（茹で秒が引ける）。 */
const NOODLES = DEFAULT_NOODLE_PRESETS.map((preset) => preset.noodleType);

const genFirmness: fc.Arbitrary<Firmness> = fc.constantFrom(...FIRMNESS_ORDER);

/** 待ち行列の 1 品目。麺種と茹で加減を振り、Timer へ写る値の出所を問えるようにする。 */
const genOrder: fc.Arbitrary<PendingOrder> = fc
  .tuple(
    fc.string({ minLength: 1, maxLength: 6 }),
    fc.nat({ max: 3 }),
    fc.constantFrom(...NOODLES),
    genFirmness,
  )
  .map(([externalOrderId, itemIndex, noodleType, firmness]) => ({
    externalOrderId,
    itemIndex,
    noodleType,
    firmness,
    tableId: null,
    arrivalTime: (NOW - 60_000) as number,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
  }));

/** 当該品目を待ち行列に持つ状態。 */
function stateWith(orders: readonly PendingOrder[]): TimerState {
  return { ...EMPTY_STATE, pendingOrders: orders };
}

/** 品目を指す開始を 1 件流す。 */
function start(state: TimerState, order: PendingOrder, slotIds: readonly string[] = ["0"]) {
  return decide(
    state,
    {
      type: "StartOrderItem",
      slotIds,
      externalOrderId: order.externalOrderId,
      itemIndex: order.itemIndex,
      newTimerId: "t-new" as TimerId,
      now: NOW,
    },
    PARAMS,
  );
}

describe("Feature: slot-suggested-start, Property 4: 品目からの開始は品目の事実を写す", () => {
  it("Timer の noodleType と firmness が品目と一致し、茹で秒はプリセットから引かれる", () => {
    fc.assert(
      fc.property(genOrder, (order) => {
        const outcome = start(stateWith([order]), order);
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        const timer = outcome.state.timers.find((candidate) => candidate.id === "t-new");
        expect(timer).toBeDefined();
        if (timer === undefined) return;
        // 麺種と茹で加減は品目の事実そのまま（既定へ畳まない——畳めば伝票の指定が消える）。
        expect(timer.noodleType).toBe(order.noodleType);
        expect(timer.firmness).toBe(order.firmness);
        // 茹で秒は noodleType × firmness からの導出。client は送っていない。
        const preset = DEFAULT_NOODLE_PRESETS.find((p) => p.noodleType === order.noodleType);
        expect(preset).toBeDefined();
        expect(timer.endTime - timer.startTime).toBe(preset!.boilSeconds[order.firmness] * 1000);
      }),
      { numRuns: 200 },
    );
  });

  it("茹で加減が違う品目は endTime も違う（既定へ畳んでいないことの対照）", () => {
    fc.assert(
      fc.property(fc.constantFrom(...NOODLES), (noodleType) => {
        const preset = DEFAULT_NOODLE_PRESETS.find((p) => p.noodleType === noodleType)!;
        // 硬さ別の秒数が全て同じプリセットでは対照にならない（既定のプリセットは 4 値が異なる）。
        fc.pre(new Set(Object.values(preset.boilSeconds)).size > 1);
        const durations = FIRMNESS_ORDER.map((firmness) => {
          const order: PendingOrder = {
            externalOrderId: "o-1",
            itemIndex: 0,
            noodleType,
            firmness,
            tableId: null,
            arrivalTime: NOW - 60_000,
            slotSpan: 1,
            itemName: null,
            sizeName: null,
          };
          const outcome = start(stateWith([order]), order);
          if (!outcome.ok) throw new Error("受理されるはず");
          const timer = outcome.state.timers.find((candidate) => candidate.id === "t-new")!;
          return timer.endTime - timer.startTime;
        });
        expect(new Set(durations).size).toBeGreaterThan(1);
      }),
      { numRuns: 50 },
    );
  });
});

describe("Feature: slot-suggested-start, Property 5: 待ち行列の消費は当該品目だけ", () => {
  it("受理後、指した品目だけが消え他の品目は変わらない", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(genOrder, {
          minLength: 2,
          maxLength: 5,
          selector: (order) => `${order.externalOrderId}#${order.itemIndex}`,
        }),
        fc.nat({ max: 4 }),
        (orders, pick) => {
          const target = orders[pick % orders.length]!;
          const outcome = start(stateWith(orders), target);
          expect(outcome.ok).toBe(true);
          if (!outcome.ok) return;
          const remaining = outcome.state.pendingOrders;
          // 指した品目は消える。
          expect(
            remaining.some(
              (order) =>
                order.externalOrderId === target.externalOrderId &&
                order.itemIndex === target.itemIndex,
            ),
          ).toBe(false);
          // 他は写しのまま（順序も含めて）。
          expect(remaining).toEqual(orders.filter((order) => order !== target));
        },
      ),
      { numRuns: 200 },
    );
  });

  it("Timer は由来した品目を持つ（modification の再送で待ち行列へ復活させないための手掛かり）", () => {
    fc.assert(
      fc.property(genOrder, (order) => {
        const outcome = start(stateWith([order]), order);
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        const timer = outcome.state.timers.find((candidate) => candidate.id === "t-new")!;
        expect(timer.orderItem).toEqual({
          externalOrderId: order.externalOrderId,
          itemIndex: order.itemIndex,
        });
      }),
      { numRuns: 200 },
    );
  });
});
