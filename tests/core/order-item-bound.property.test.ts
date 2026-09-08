// tests/core/order-item-bound.property.test.ts — 正本の件数が有界であることの閉包性（性質 5.8）。
//
// Feature: order-item-truncation, Property 5.8
// **Validates: Requirements 2.4, 5.8**
//
// `truncate-order-items.property` が `truncateOrderItems` 単体の性質を守るのに対し、ここは
// **`orderItems` を返すすべての変換**を横断して「件数がどう動くか」を一覧にする。
//
//   (a) 件数を**増やしうる**変換は `upsertOrder` ただ一つ
//   (b) `upsertOrder` と `migrate` の出力は `ORDER_ITEM_LIMIT` 以下
//   (c) `completeTimer` / `cancelTimer` / `fromSnapshot` / `toSnapshot` は入力と**同数**、`removeOrder` は**以下**
//   (d) `EMPTY_STATE.orderItems` は 0 件
//
// **「代入の箇所を数える」形にはしない**（design Component 5）——`complete` / `cancel` は `map` で新しい配列を
// 作り、`fromSnapshot` / `toSnapshot` は写すので、字面としての構築点を数えても不変条件にならない。
//
// **既知の限界：これは現在存在する変換の列挙であって網羅ではない。** 将来 `orderItems` を返す変換が増えれば、
// その性質は自動では守られない。実走での有界性（性質 5.9・`order-item-bound.example`）が二重の網になる。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ORDER_ITEM_LIMIT,
  removeOrder,
  truncateOrderItems,
  upsertOrder,
} from "../../src/engine/pending";
import { completeTimer } from "../../src/engine/complete";
import { cancelTimer } from "../../src/engine/cancel";
import { fromSnapshot, toSnapshot } from "../../src/engine/snapshot";
import { migrate } from "../../src/engine/migrate";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { OrderItem } from "../../src/domain/order";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { genUniqueOrderItems, uniqueOrderItems } from "./generators";
import { nonEmpty } from "../nonEmpty";
import { settleParams } from "../settleParams";

const PARAMS = settleParams({ arms: 2, toleranceRatio: 0.1 });
const NOW = 1_700_000_000_000 as EpochMillis;

/** 正本に載っている品目を指す生きた Timer（complete / cancel の対象）。 */
function timerFor(item: OrderItem): Timer {
  return createTimer({
    id: "t-1" as TimerId,
    slotIds: nonEmpty(["0" as SlotId]),
    noodleType: "thin" as NoodleType,
    firmness: "normal",
    startTime: NOW as EpochMillis,
    endTime: (NOW + 120_000) as EpochMillis,
    seq: 0,
    orderItem: { externalOrderId: item.externalOrderId, itemIndex: item.itemIndex, tableId: null },
  });
}

const stateWith = (
  orderItems: readonly OrderItem[],
  timers: readonly Timer[] = [],
): TimerState => ({
  ...EMPTY_STATE,
  orderItems,
  timers,
});

/** 上限より十分小さい帯（空・単独・少数を含む）。 */
const genSmall = genUniqueOrderItems({ minLength: 0, maxLength: 40 });
/** 上限ちょうど〜上限超過の帯。 */
const genLarge = genUniqueOrderItems({
  minLength: ORDER_ITEM_LIMIT,
  maxLength: ORDER_ITEM_LIMIT + 4,
});

const OPTIONS = { numRuns: 25 };

/**
 * **両帯を各 run で必ず検査する。** `fc.oneof` で 1 つ選ぶ形にすると、どの run がどちらの帯を踏んだかが
 * 抽選任せになり、「上限をまたいで成り立つ」という主張が確率的にしか裏づけられない（同じ穴を
 * migrate.property の重複 property で踏んだ）。帯ごとに引数を分ければ、どの run も両側を通る。
 */
function forBothBands(check: (items: readonly OrderItem[]) => void) {
  fc.assert(
    fc.property(genSmall, genLarge, (small, large) => {
      expect(small.length).toBeLessThan(ORDER_ITEM_LIMIT);
      expect(large.length).toBeGreaterThanOrEqual(ORDER_ITEM_LIMIT);
      check(small);
      check(large);
    }),
    OPTIONS,
  );
}

describe("(d) 空の初期状態", () => {
  it("EMPTY_STATE.orderItems は 0 件", () => {
    expect(EMPTY_STATE.orderItems.length).toBe(0);
  });
});

describe("(a)(b) 件数を増やしうるのは upsertOrder だけで、その出力は上限以下", () => {
  it("upsertOrder は上限以下を返す（入力が上限ちょうどでも、到着が何件あっても）", () => {
    fc.assert(
      fc.property(genSmall, genLarge, fc.integer({ min: 1, max: 5 }), (small, large, arriving) => {
        const fresh = Array.from({ length: arriving }, (_unused, index) => ({
          ...uniqueOrderItems(1)[0]!,
          externalOrderId: `arriving-${index}`,
          arrivalTime: 99_000_000 + index,
        }));

        for (const items of [small, large]) {
          expect(upsertOrder(items, [], nonEmpty(fresh)).length).toBeLessThanOrEqual(
            ORDER_ITEM_LIMIT,
          );
        }
      }),
      OPTIONS,
    );
  });

  it("migrate の出力は上限以下（永続から値が入ってくる唯一の口）", () => {
    forBothBands((items) => {
      const raw = {
        version: 13,
        timers: [],
        nextSeq: 0,
        orderItems: items,
        acceptedSlices: [],
        requestedDigest: null,
        lastSequenceByTerminal: {},
        shownPlan: [],
      };

      const result = migrate(structuredClone(raw));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.snapshot.orderItems.length).toBeLessThanOrEqual(ORDER_ITEM_LIMIT);
    });
  });
});

describe("(c) それ以外の変換は件数を増やさない", () => {
  it("removeOrder は入力以下", () => {
    forBothBands((items) => {
      const target = items[0]?.externalOrderId ?? "absent";
      expect(removeOrder(items, [], target).length).toBeLessThanOrEqual(items.length);
    });
  });

  it("completeTimer は入力と同数（厨房の事実を書くだけで件数を動かさない）", () => {
    forBothBands((items) => {
      if (items.length === 0) return;
      const timer = timerFor(items[0]!);

      const outcome = completeTimer(stateWith(items, [timer]), timer.id, NOW, PARAMS);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.state.orderItems.length).toBe(items.length);
    });
  });

  it("cancelTimer は入力と同数", () => {
    forBothBands((items) => {
      if (items.length === 0) return;
      const timer = timerFor(items[0]!);

      const outcome = cancelTimer(stateWith(items, [timer]), timer.id, NOW, PARAMS);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.state.orderItems.length).toBe(items.length);
    });
  });

  it("toSnapshot / fromSnapshot の往復は入力と同数（写すだけ）", () => {
    forBothBands((items) => {
      const state = stateWith(items);
      expect(toSnapshot(state).orderItems.length).toBe(items.length);
      expect(fromSnapshot(toSnapshot(state)).orderItems.length).toBe(items.length);
    });
  });

  it("truncateOrderItems は入力以下かつ上限以下", () => {
    forBothBands((items) => {
      const kept = truncateOrderItems(items);
      expect(kept.length).toBeLessThanOrEqual(items.length);
      expect(kept.length).toBeLessThanOrEqual(ORDER_ITEM_LIMIT);
    });
  });
});
