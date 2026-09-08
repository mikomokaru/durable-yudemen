// tests/core/truncate-order-items.property.test.ts — order-item-truncation の性質 5.1〜5.7。
//
// Feature: order-item-truncation, Properties 5.1〜5.7
// **Validates: Requirements 1.1〜1.6, 5.1〜5.7**
//
// 対象は engine/pending の truncateOrderItems。`items` だけに依存する純粋関数ゆえ、時刻も Timer も
// 設定も渡さない——それが期限（読む側の述語・now に依存する）と保持（正本の性質・now に依存しない）を
// 分ける線である（design 原則 2）。
//
// 入力は 2 帯に分ける。**上限以下**（即時脱出の経路）と**上限超過**（整列して落とす経路）で、
// 通る道が違うためである。上限超過の帯は 1 件あたり 4096 件超の配列を組むので、runs を絞る代わりに
// 超過分 k を 1〜8 で振る——定常状態の k は一つの到着の品目数に留まる（design Component 1）ので、
// そこが実際に踏まれる範囲である。
//
// 生成器（genUniqueOrderItems）は鍵の一意性を尊重する。これは truncateOrderItems の**事前条件**であり
// （AC 1.6）、破れうるのは永続からの復元だけなので、そこには別に関門が要る（migrate・task 3）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ORDER_ITEM_LIMIT, truncateOrderItems } from "../../src/engine/pending";
import { compareArrival, itemKeyOf, type ItemKey, type OrderItem } from "../../src/domain/order";
import { genUniqueOrderItems, shuffleBySeed } from "./generators";

/** 上限以下の帯（即時脱出）。空・単独・上限ちょうどを含む。 */
const genUnderLimit = fc.oneof(
  genUniqueOrderItems({ minLength: 0, maxLength: 40 }),
  genUniqueOrderItems({ minLength: ORDER_ITEM_LIMIT, maxLength: ORDER_ITEM_LIMIT }),
);

/** 上限超過の帯（整列して落とす）。超過分 k は 1〜8。 */
const genOverLimit = genUniqueOrderItems({
  minLength: ORDER_ITEM_LIMIT + 1,
  maxLength: ORDER_ITEM_LIMIT + 8,
});

const keysOf = (items: readonly OrderItem[]): ReadonlySet<ItemKey> =>
  new Set(items.map((item) => itemKeyOf(item)));

/** 上限超過の帯は 1 件が 4KiB 超の配列ゆえ runs を絞る（k の範囲は 8 通りしかない）。 */
const OVER = { numRuns: 40 };

describe("truncateOrderItems の性質（order-item-truncation 5.1〜5.7）", () => {
  it("5.1 有界：どの入力でも結果は ORDER_ITEM_LIMIT 以下", () => {
    fc.assert(
      fc.property(fc.oneof(genUnderLimit, genOverLimit), (items) => {
        expect(truncateOrderItems(items).length).toBeLessThanOrEqual(ORDER_ITEM_LIMIT);
      }),
      OVER,
    );
  });

  it("5.2 冪等：二度当てても一度と同じ", () => {
    fc.assert(
      fc.property(genOverLimit, (items) => {
        const once = truncateOrderItems(items);
        expect(truncateOrderItems(once)).toBe(once);
      }),
      OVER,
    );
  });

  it("5.3 部分集合：要素の内容を変えず、入力に在るものだけを返す", () => {
    fc.assert(
      fc.property(genOverLimit, (items) => {
        const kept = truncateOrderItems(items);
        const source = new Map(items.map((item) => [itemKeyOf(item), item] as const));
        for (const item of kept) expect(source.get(itemKeyOf(item))).toBe(item);
        expect(new Set(kept.map((item) => itemKeyOf(item))).size).toBe(kept.length);
      }),
      OVER,
    );
  });

  it("5.4 並び保存：生き残った品目の相対順序は入力のまま", () => {
    fc.assert(
      fc.property(genOverLimit, (items) => {
        const kept = truncateOrderItems(items);
        const keys = keysOf(kept);
        expect(kept).toEqual(items.filter((item) => keys.has(itemKeyOf(item))));
      }),
      OVER,
    );
  });

  it("5.5 恒等：上限以下なら入力と同じ参照", () => {
    fc.assert(
      fc.property(genUnderLimit, (items) => {
        expect(truncateOrderItems(items)).toBe(items);
      }),
      OVER,
    );
  });

  it("5.6 落ちるのは最も古い k 件：落ちた品目はいずれも残った品目のすべてより真に古い", () => {
    fc.assert(
      fc.property(genOverLimit, (items) => {
        const kept = truncateOrderItems(items);
        const keys = keysOf(kept);
        const dropped = items.filter((item) => !keys.has(itemKeyOf(item)));
        expect(dropped.length).toBe(items.length - ORDER_ITEM_LIMIT);
        for (const gone of dropped) {
          for (const stay of kept) expect(compareArrival(gone, stay)).toBeLessThan(0);
        }
      }),
      OVER,
    );
  });

  it("5.7 決定性：入力の並びを変えても落ちる集合は同じ（鍵が一意な入力に対して）", () => {
    fc.assert(
      fc.property(genOverLimit, fc.integer({ min: 0, max: 0x7fff_ffff }), (items, seed) => {
        const kept = keysOf(truncateOrderItems(items));
        const reordered = keysOf(truncateOrderItems(shuffleBySeed(items, seed)));
        expect([...reordered].sort()).toEqual([...kept].sort());
      }),
      OVER,
    );
  });
});
