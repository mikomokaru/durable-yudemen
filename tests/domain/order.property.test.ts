// Feature: pending-order-expiry, Component 1 / **Validates: Requirements 1.1, 1.2, 1.4, 5.1, 5.2, 5.3**
// Feature: order-lifecycle, Component 1 / **Validates: Requirements 1.2, 3.1, 3.2, 7.1, 7.3′**
//
// tests/domain/order.property.test.ts — 生きている待ち行列（Live_Orders）と、品目の状態の導出の性質。
//
// 述語は一つで、読む側の入口が各自の now で呼ぶ。ゆえに「二度絞っても変わらない」（冪等）、「時間が進んで
// 生き返らない」（単調）、「入力の相対順序を保つ」（並び）が、入口の組み合わせに依らず成り立つことが要る。
// 生成器は寿命の境界（ちょうど・1 ms 手前・1 ms 後）を高い頻度で踏むように到着時刻を振る。
//
// 状態の導出（order-lifecycle）は「任意の品目はちょうど一つの状態」（性質 7.1）、「中断は状態に効かない」（7.3′）、
// 「計画と左レールの集合 ⊆ snapshot の集合」（判断 5）、「参照先は必ず snapshot に載る」（性質 7.2 の domain 側）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  itemStatusOf,
  liveOrders,
  orderItemsToBroadcast,
  ORDER_LIFETIME_MS,
  pendingOrders,
  type OrderItem,
} from "../../src/domain/order";

const NOW = 1_700_000_000_000;

/** 到着時刻の生成。寿命の境界の前後 1 ms と、境界そのもの、遠い過去・未来を混ぜる。 */
const genArrivalTime: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: NOW - 4 * ORDER_LIFETIME_MS, max: NOW + ORDER_LIFETIME_MS }),
  fc.constantFrom(
    NOW - ORDER_LIFETIME_MS - 1,
    NOW - ORDER_LIFETIME_MS,
    NOW - ORDER_LIFETIME_MS + 1,
    NOW - 1,
    NOW,
    NOW + 1,
  ),
);

/** 品目。鍵は位置から振る（重複を作らないため生成器では鍵を振らず、配列にしてから付ける）。 */
const genOrderBody = fc.record({
  arrivalTime: genArrivalTime,
  noodleType: fc.constantFrom("Thin", "Medium", "Thick"),
  tableId: fc.oneof(fc.constantFrom("t-1", "t-2"), fc.constant(null)),
  slotSpan: fc.constantFrom(1, 2),
});

const genPending: fc.Arbitrary<readonly OrderItem[]> = fc
  .array(genOrderBody, { maxLength: 12 })
  .map((bodies) =>
    bodies.map((body, index) => ({
      externalOrderId: `o-${index}`,
      itemIndex: 0,
      noodleType: body.noodleType,
      firmness: "normal" as const,
      tableId: body.tableId,
      arrivalTime: body.arrivalTime,
      slotSpan: body.slotSpan,
      itemName: null,
      sizeName: null,
      completedAt: null,
      interruptedAt: null,
    })),
  );

/** 厨房の事実を振った品目集合（完了・中断とも null と時刻を混ぜる）。 */
const genItems: fc.Arbitrary<readonly OrderItem[]> = genPending.chain((items) =>
  fc
    .array(
      fc.record({
        completedAt: fc.option(fc.integer({ min: NOW - ORDER_LIFETIME_MS, max: NOW }), {
          nil: null,
        }),
        interruptedAt: fc.option(fc.integer({ min: NOW - ORDER_LIFETIME_MS, max: NOW }), {
          nil: null,
        }),
      }),
      { minLength: items.length, maxLength: items.length },
    )
    .map((facts) => items.map((item, index) => ({ ...item, ...facts[index]! }))),
);

/** Timer 集合——集合の品目の一部を指す参照と、集合に無い参照、アドホック（null）を混ぜる。 */
function genTimersFor(
  items: readonly OrderItem[],
): fc.Arbitrary<readonly { readonly orderItem: OrderItem | null }[]> {
  const refs: fc.Arbitrary<{ readonly orderItem: OrderItem | null }>[] = [
    fc.constant({ orderItem: null }),
    fc.constant({
      orderItem: { ...items[0]!, externalOrderId: "o-absent", itemIndex: 3 } as OrderItem,
    }),
    ...items.map((item) => fc.constant({ orderItem: item })),
  ];
  return fc.array(fc.oneof(...refs), { maxLength: items.length + 2 });
}

/** 品目集合とそれを指す Timer 集合の組。 */
const genItemsWithTimers = genItems
  .filter((items) => items.length > 0)
  .chain((items) => fc.tuple(fc.constant(items), genTimersFor(items)));

/** 判定の時点。NOW の周りに寿命の幅で振り、境界も踏む。 */
const genNow: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: NOW - ORDER_LIFETIME_MS, max: NOW + 2 * ORDER_LIFETIME_MS }),
  fc.constant(NOW),
);

/** 深い写し（入力が変わらないことの比較用）。 */
function copyOf(pending: readonly OrderItem[]): readonly OrderItem[] {
  return pending.map((order) => ({ ...order }));
}

describe("Feature: pending-order-expiry — Live_Orders の性質", () => {
  // Feature: pending-order-expiry, Property 5.1: 冪等——Live_Orders(Live_Orders(p, t), t) = Live_Orders(p, t)
  it("Property 5.1: 冪等——二度絞っても同じ値で、二度目は同じ参照", () => {
    fc.assert(
      fc.property(genPending, genNow, (pending, now) => {
        const once = liveOrders(pending, now);
        const twice = liveOrders(once, now);
        expect(twice).toEqual(once);
        // 一度絞った値は全件が期限内ゆえ、二度目は新しい配列を作らない。
        expect(twice).toBe(once);
      }),
      { numRuns: 300 },
    );
  });

  // Feature: pending-order-expiry, Property 5.2: 単調——t1 ≤ t2 なら Live_Orders(p, t2) ⊆ Live_Orders(p, t1)
  it("Property 5.2: 単調——時間が進んで生き返らない", () => {
    fc.assert(
      fc.property(
        genPending,
        genNow,
        fc.integer({ min: 0, max: 3 * ORDER_LIFETIME_MS }),
        (pending, t1, gap) => {
          const t2 = t1 + gap;
          const earlier = new Set(liveOrders(pending, t1).map((order) => order.externalOrderId));
          for (const order of liveOrders(pending, t2)) {
            expect(earlier.has(order.externalOrderId)).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: pending-order-expiry, Property 5.3: 並び——Live_Orders は入力の相対順序を保つ
  it("Property 5.3: 並び——結果は入力の部分列（相対順序を保ち、重複を作らない）", () => {
    fc.assert(
      fc.property(genPending, genNow, (pending, now) => {
        const live = liveOrders(pending, now);
        // 部分列：入力を前から走査して順に一致する。
        let cursor = 0;
        for (const order of live) {
          const position = pending.indexOf(order, cursor);
          expect(position).toBeGreaterThanOrEqual(cursor);
          cursor = position + 1;
        }
        expect(new Set(live).size).toBe(live.length);
      }),
      { numRuns: 300 },
    );
  });

  // Feature: pending-order-expiry, Component 1 / AC 1.1・1.4 — 述語そのもの（半開区間）と入力の不変
  it("述語：品目が残るのは arrivalTime + 寿命 > now のときに限る（半開区間）。入力は変わらない", () => {
    fc.assert(
      fc.property(genPending, genNow, (pending, now) => {
        const before = copyOf(pending);
        const live = liveOrders(pending, now);
        const kept = new Set(live);
        for (const order of pending) {
          expect(kept.has(order)).toBe(order.arrivalTime + ORDER_LIFETIME_MS > now);
        }
        expect(pending).toEqual(before);
      }),
      { numRuns: 300 },
    );
  });

  // Feature: pending-order-expiry, Component 1 — 全件期限内なら同じ参照
  it("全件が期限内なら入力と同じ配列を返し、1 件でも切れれば新しい配列を返す", () => {
    fc.assert(
      fc.property(genPending, genNow, (pending, now) => {
        const allLive = pending.every((order) => order.arrivalTime + ORDER_LIFETIME_MS > now);
        const live = liveOrders(pending, now);
        if (allLive) expect(live).toBe(pending);
        else expect(live).not.toBe(pending);
      }),
      { numRuns: 300 },
    );
  });
});

describe("Feature: order-lifecycle — 状態の導出の性質", () => {
  // Feature: order-lifecycle, Property 7.1: 状態の排他——任意の品目は unstarted / cooking / done のちょうど一つ
  it("Property 7.1: 状態はちょうど一つで、参照する Timer が在れば cooking、無ければ completedAt の有無で done / unstarted", () => {
    fc.assert(
      fc.property(genItemsWithTimers, ([items, timers]) => {
        for (const item of items) {
          const status = itemStatusOf(item, timers);
          const referenced = timers.some(
            (timer) =>
              timer.orderItem !== null &&
              timer.orderItem.externalOrderId === item.externalOrderId &&
              timer.orderItem.itemIndex === item.itemIndex,
          );
          const expected = referenced
            ? "cooking"
            : item.completedAt !== null
              ? "done"
              : "unstarted";
          expect(status).toBe(expected);
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: order-lifecycle, Property 7.3′: 中断は状態に効かない
  it("Property 7.3′: interruptedAt を付けても外しても itemStatusOf と pendingOrders は変わらない", () => {
    fc.assert(
      fc.property(genItemsWithTimers, genNow, ([items, timers], now) => {
        const cleared = items.map((item) => ({ ...item, interruptedAt: null }));
        const marked = items.map((item) => ({ ...item, interruptedAt: now }));
        for (const [index, item] of items.entries()) {
          const status = itemStatusOf(item, timers);
          expect(itemStatusOf(cleared[index]!, timers)).toBe(status);
          expect(itemStatusOf(marked[index]!, timers)).toBe(status);
        }
        const keys = (list: readonly OrderItem[]) => list.map((item) => item.externalOrderId);
        expect(keys(pendingOrders(cleared, timers, now))).toEqual(
          keys(pendingOrders(items, timers, now)),
        );
        expect(keys(pendingOrders(marked, timers, now))).toEqual(
          keys(pendingOrders(items, timers, now)),
        );
      }),
      { numRuns: 300 },
    );
  });

  // Feature: order-lifecycle, Requirement 3.1 / 3.2 — 二つの読む集合の関係
  it("pendingOrders = liveOrders ∩ unstarted（並びを保つ）、pendingOrders ⊆ orderItemsToBroadcast、参照先は必ず配信される", () => {
    fc.assert(
      fc.property(genItemsWithTimers, genNow, ([items, timers], now) => {
        const pending = pendingOrders(items, timers, now);
        expect(pending).toEqual(
          liveOrders(items, now).filter((item) => itemStatusOf(item, timers) === "unstarted"),
        );
        const broadcast = new Set(orderItemsToBroadcast(items, timers, now));
        for (const item of pending) expect(broadcast.has(item)).toBe(true);
        for (const item of items) {
          const status = itemStatusOf(item, timers);
          // 期限内 ∨ cooking が配信の条件。done / unstarted は期限で消える。
          expect(broadcast.has(item)).toBe(
            item.arrivalTime + ORDER_LIFETIME_MS > now || status === "cooking",
          );
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: order-lifecycle, Component 1 — 全件が通れば同じ参照・二度当てても冪等
  it("全件が通れば入力と同じ参照を返し、二度当てても同じ参照（冪等）", () => {
    fc.assert(
      fc.property(genItemsWithTimers, genNow, ([items, timers], now) => {
        const pending = pendingOrders(items, timers, now);
        if (pending.length === items.length) expect(pending).toBe(items);
        else expect(pending).not.toBe(items);
        expect(pendingOrders(pending, timers, now)).toBe(pending);
        const broadcast = orderItemsToBroadcast(items, timers, now);
        if (broadcast.length === items.length) expect(broadcast).toBe(items);
        expect(orderItemsToBroadcast(broadcast, timers, now)).toBe(broadcast);
      }),
      { numRuns: 300 },
    );
  });
});
