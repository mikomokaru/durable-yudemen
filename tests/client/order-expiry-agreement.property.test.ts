// tests/client/order-expiry-agreement.property.test.ts — client の入口が同じ生きている待ち行列を読む性質
// （pending-order-expiry Requirement 3・性質 5.8・design Component 5 の一致）。
//
// **Validates: Requirements 3.1, 3.2, 3.3, 5.8**
//
// 左レール（orderQueueEntries・ローカル時計 `now` を受けて境界で 1 回補正する）と釜の提案（liftGroups →
// slotSuggestions・補正済み `corrected` を受ける）は、同じ品目集合を「生きている」とみなさなければならない。
// 片方だけが先に消えれば、レールに無い品目が釜に「now」で出るか、釜に出ない品目がレールに提案付きで残る。
// ここでは群の場面（genLiftScene）に任意の offset と、寿命の境界を跨ぐ到着時刻、そして品目の状態（調理中＝
// 自分を指す生きた Timer・調理済み＝completedAt・中断済み＝interruptedAt・order-lifecycle）を混ぜ、`now`・`offset` を
// どう振っても両者の集合が一致し、wire の全量に対する絞り込みが domain の pendingOrders（期限内 ∧ unstarted・
// liveOrders を内側に畳む）そのものであることを見る。時刻はすべて引数で運び、Date.now は用いない（純粋層の規律）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ClientTimer, ClientView } from "../../src/client/connection";
import { correctedNow } from "../../src/client/clock";
import { liftGroups, slotSuggestions, visibleGroups } from "../../src/client/components/liftGroups";
import { orderQueueEntries, suggestedItemOf } from "../../src/client/components/queueDisplay";
import {
  itemKeyOf,
  ORDER_LIFETIME_MS,
  pendingOrders,
  type OrderItem,
} from "../../src/domain/order";
import { SLOTS_PER_UNIT } from "../../src/domain/store";
import { genLiftScene } from "./generators";

const NUM_RUNS = 200;

/** クロックオフセット。負・0・正をまたぎ、分単位のずれも踏む。 */
const genOffset: fc.Arbitrary<number> = fc.oneof(
  fc.constant(0),
  fc.integer({ min: -600_000, max: 600_000 }),
);

/**
 * 到着時刻の寿命に対する位置。`corrected` を基準に、ちょうど寿命（切れる）・1 ms 手前（生きている）・
 * 1 ms 過ぎ（切れる）・元のまま（生きている）を品目ごとに振る。
 */
const genAging: fc.Arbitrary<"exact" | "before" | "after" | "keep"> = fc.constantFrom(
  "exact",
  "before",
  "after",
  "keep",
);

/**
 * 品目の状態（order-lifecycle）。unstarted のまま・調理中（自分を指す生きた Timer を足す）・調理済み（completedAt）・
 * 中断済み（interruptedAt・状態には効かない）。
 */
const genStatus: fc.Arbitrary<"unstarted" | "cooking" | "done" | "interrupted"> = fc.constantFrom(
  "unstarted",
  "cooking",
  "done",
  "interrupted",
);

/** 品目を指す生きた Timer（走行中・boiled とも「生きた」）。釜は場面の釜と重なってよい（占有は提案を減らすだけ）。 */
function cookingTimerOf(
  order: OrderItem,
  index: number,
  corrected: number,
  boiled: boolean,
): ClientTimer {
  const endTime = boiled ? corrected - 1 : corrected + 60_000;
  return {
    id: `t-cooking-${index}`,
    slotIds: ["0"],
    noodleType: order.noodleType,
    firmness: order.firmness,
    startTime: endTime - 120_000,
    endTime,
    orderItem: { externalOrderId: order.externalOrderId, itemIndex: order.itemIndex },
    origin: "server",
  };
}

/**
 * 場面に offset と、品目ごとの寿命の位置・状態を足す。`now` はローカル時計で、補正すると場面の `corrected` に戻る。
 * 調理中の品目には自分を指す Timer を view.timers に足す（品目の集合は wire のまま）。
 */
const genAgedScene = genLiftScene.chain(({ view, corrected }) =>
  fc
    .record({
      offset: genOffset,
      agings: fc.array(genAging, {
        minLength: view.orderItems.length,
        maxLength: view.orderItems.length,
      }),
      statuses: fc.array(fc.tuple(genStatus, fc.boolean()), {
        minLength: view.orderItems.length,
        maxLength: view.orderItems.length,
      }),
    })
    .map(({ offset, agings, statuses }) => {
      const cooking: ClientTimer[] = [];
      const orderItems: readonly OrderItem[] = view.orderItems.map((order, index) => {
        const aging = agings[index] ?? "keep";
        const delta = aging === "exact" ? 0 : aging === "before" ? 1 : -1;
        const aged =
          aging === "keep"
            ? order
            : { ...order, arrivalTime: corrected - ORDER_LIFETIME_MS + delta };
        const [status, boiled] = statuses[index] ?? ["unstarted", false];
        if (status === "cooking") cooking.push(cookingTimerOf(aged, index, corrected, boiled));
        if (status === "done") return { ...aged, completedAt: corrected - 1 };
        if (status === "interrupted") return { ...aged, interruptedAt: corrected - 1 };
        return aged;
      });
      const agedView: ClientView = {
        ...view,
        offset,
        orderItems,
        timers: [...view.timers, ...cooking],
      };
      return { view: agedView, corrected, now: corrected - offset };
    }),
);

/** 全釜の担当（レールの提案を絞らない）。 */
function allUnits(view: ClientView): readonly number[] {
  return Array.from({ length: view.unitCount }, (_, unit) => unit);
}

describe("Feature: pending-order-expiry, Property 5.8: client の一致", () => {
  it("左レールが並べる集合は wire の orderItems を corrected で pendingOrders（期限内 ∧ unstarted）に通した集合そのもので、offset を足したローカル時計から 1 回の補正で導かれる", () => {
    fc.assert(
      // Feature: pending-order-expiry, Property 5.8: client の一致（order-lifecycle 性質 7.6：左レールは pendingOrders）
      // Validates: Requirements 3.1, 3.2, 5.8
      fc.property(genAgedScene, ({ view, corrected, now }) => {
        expect(correctedNow(view.offset, now)).toBe(corrected);
        const rail = orderQueueEntries(view, allUnits(view), now).map((entry) =>
          itemKeyOf(entry.order),
        );
        const live = pendingOrders(view.orderItems, view.timers, corrected).map(itemKeyOf);
        expect(new Set(rail)).toEqual(new Set(live));
        expect(rail).toHaveLength(live.length);
        // 絞った値を view に持たない（wire のまま）。調理中・調理済みの品目も集合には残る。
        expect(view.orderItems).toHaveLength(rail.length + (view.orderItems.length - live.length));
        // 調理中（自分を指す生きた Timer）と調理済み（completedAt）はレールに無い。
        for (const order of view.orderItems) {
          const cooking = view.timers.some(
            (timer) =>
              timer.orderItem !== null &&
              timer.orderItem.externalOrderId === order.externalOrderId &&
              timer.orderItem.itemIndex === order.itemIndex,
          );
          if (cooking || order.completedAt !== null) expect(rail).not.toContain(itemKeyOf(order));
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("釜の提案（群）に現れる品目はすべて左レールに在り、レールに在って開始できる推奨を持つ品目はすべて群に在る——非ゼロの offset でも同じ 1 ms で切り替わる", () => {
    fc.assert(
      // Feature: pending-order-expiry, Property 5.8: client の一致（レールと釜の提案）
      // Validates: Requirements 3.1, 3.3, 5.8
      fc.property(genAgedScene, ({ view, corrected, now }) => {
        const rail = new Set(
          orderQueueEntries(view, allUnits(view), now).map((entry) => itemKeyOf(entry.order)),
        );
        const groups = liftGroups(view, corrected);
        const grouped = new Set(
          groups.flatMap((group) => group.items.map((item) => itemKeyOf(item.order))),
        );
        // 群 ⊆ レール。
        for (const key of grouped) expect(rail.has(key)).toBe(true);
        // レールに在り、麺種がプリセットに在る推奨は群に在る（suggestedItemOf を同じ corrected で呼べば非 null）。
        for (const recommendation of view.recommendations) {
          const key = itemKeyOf(recommendation);
          const known = view.orderItems.some(
            (order) =>
              itemKeyOf(order) === key &&
              view.noodlePresets.some((preset) => preset.noodleType === order.noodleType),
          );
          const expected = rail.has(key) && known;
          expect(grouped.has(key)).toBe(expected);
          expect(suggestedItemOf(view, recommendation, corrected) !== null).toBe(expected);
        }
        // 釜ごとの提案に出る品目も群の部分集合（釜の提案が別の集合を読んでいない）。
        const bySlot = slotSuggestions(visibleGroups(groups), view, corrected);
        for (const list of bySlot.values()) {
          for (const suggestion of list)
            expect(rail.has(itemKeyOf(suggestion.item.order))).toBe(true);
        }
        expect(bySlot.size).toBeLessThanOrEqual(view.unitCount * SLOTS_PER_UNIT);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
