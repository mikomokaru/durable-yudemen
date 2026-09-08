// tests/core/truncate-order-items.example.test.ts — order-item-truncation の境界と場面。
//
// Feature: order-item-truncation, Requirement 1
// **Validates: Requirements 1.1〜1.6, 3.1**
//
// 性質（truncate-order-items.property）が「どの入力でも成り立つこと」を守るのに対し、ここは境界と、
// 判断が現れる具体の場面を固定する——上限ちょうど / +1、同着を第 2 の鍵で断つこと、そして
// **何も守らない**（生きた Timer の参照先も落ちる）こと。

import { describe, expect, it } from "vitest";
import { ORDER_ITEM_LIMIT, truncateOrderItems } from "../../src/engine/pending";
import { itemKeyOf, orderItemOf, type OrderItem } from "../../src/domain/order";
import { uniqueOrderItems } from "./generators";

/** `uniqueOrderItems` を、より新しい起点へずらして組む（「これらは全部あの 1 件より新しい」を作るため）。 */
function newerThan(count: number, shiftMs: number): readonly OrderItem[] {
  const base = uniqueOrderItems(count);
  return Array.from({ length: count }, (_unused, index) =>
    item(base[index]!.externalOrderId, base[index]!.itemIndex, base[index]!.arrivalTime + shiftMs),
  );
}

/** 素の 1 品目（鍵と arrivalTime 以外は主張に関与しない）。 */
function item(externalOrderId: string, itemIndex: number, arrivalTime: number): OrderItem {
  return {
    externalOrderId,
    itemIndex,
    noodleType: "thin",
    firmness: "normal",
    tableId: null,
    arrivalTime,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
  };
}

describe("truncateOrderItems — 境界", () => {
  it("空は空のまま（同じ参照）", () => {
    const empty: readonly OrderItem[] = [];
    expect(truncateOrderItems(empty)).toBe(empty);
  });

  it("ちょうど上限は一件も落とさない（同じ参照）", () => {
    const items = uniqueOrderItems(ORDER_ITEM_LIMIT);
    expect(truncateOrderItems(items)).toBe(items);
  });

  it("上限 +1 は最も古い 1 件だけを落とす", () => {
    const items = uniqueOrderItems(ORDER_ITEM_LIMIT + 1);
    const kept = truncateOrderItems(items);
    expect(kept.length).toBe(ORDER_ITEM_LIMIT);
    // 生成器は「添字の順 ＝ compareArrival の順」なので、落ちるのは先頭の 1 件。
    expect(kept).toEqual(items.slice(1));
    expect(kept).not.toBe(items);
  });

  it("大量超過でも上限ちょうどに収まり、残るのは新しい側", () => {
    const items = uniqueOrderItems(ORDER_ITEM_LIMIT * 3);
    const kept = truncateOrderItems(items);
    expect(kept.length).toBe(ORDER_ITEM_LIMIT);
    expect(kept).toEqual(items.slice(ORDER_ITEM_LIMIT * 2));
  });
});

describe("truncateOrderItems — 断ち方と守らないこと", () => {
  it("arrivalTime が同着なら externalOrderId で断つ（第 2 の鍵が効く）", () => {
    // 全件が同じ arrivalTime。第 1 の鍵だけでは順が決まらない。
    const items = Array.from({ length: ORDER_ITEM_LIMIT + 2 }, (_unused, index) =>
      item(`o-${String(index).padStart(6, "0")}`, 0, 5_000),
    );
    const kept = truncateOrderItems(items);
    expect(kept.map((each) => each.externalOrderId).slice(0, 2)).toEqual(["o-000002", "o-000003"]);
    expect(kept.length).toBe(ORDER_ITEM_LIMIT);
  });

  it("並びが到着順でなくても、落ちるのは最も古い側で、残りの並びは入力のまま", () => {
    const oldest = item("o-old", 0, 1_000);
    const rest = newerThan(ORDER_ITEM_LIMIT, 10_000);
    // 最も古い品目を**末尾**に置く。集合の並びは到着順ではない（upsertOrder は位置を保つ）。
    const items = [...rest, oldest];
    const kept = truncateOrderItems(items);
    expect(kept).toEqual(rest);
  });

  it("生きた Timer の参照先でも落ちる——何も守らない（判断 3）", () => {
    const cooking = item("o-cooking", 0, 0); // 最も古い
    const items = [cooking, ...newerThan(ORDER_ITEM_LIMIT, 10_000)];
    const timer = { orderItem: { externalOrderId: "o-cooking", itemIndex: 0 } };

    expect(orderItemOf(timer, items)).toBe(cooking);

    const kept = truncateOrderItems(items);
    expect(kept.some((each) => itemKeyOf(each) === itemKeyOf(cooking))).toBe(false);
    // 落ちた先は既に在る「参照先なし」の経路（新しい経路も拒否事由も要らない・AC 3.1）。
    expect(orderItemOf(timer, kept)).toBeNull();
  });
});
