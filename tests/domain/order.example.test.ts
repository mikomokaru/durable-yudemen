// Feature: pending-order-expiry, Component 1 / **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
//
// tests/domain/order.example.test.ts — 生きている待ち行列（Live_Orders）の境界を名指しで固定する。
//
// 期限は状態を書き換える出来事ではなく、`now` から導く述語である。ここで固定するのは線そのもの——半開区間の境界
// （ちょうど寿命は含まない・1 ms 手前は含む）、並びを保つこと、入力を変えないこと、全件が期限内なら同じ配列を
// 返すこと（client の参照同値による再描画の抑制を壊さない）——で、どこがこの述語を呼ぶかは engine / client の側の主張。

import { describe, expect, it } from "vitest";
import { liveOrders, ORDER_LIFETIME_MS, type PendingOrder } from "../../src/domain/order";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

function order(externalOrderId: string, arrivalTime: number): PendingOrder {
  return {
    externalOrderId,
    itemIndex: 0,
    noodleType: "Thin",
    firmness: "normal",
    tableId: "t-1",
    arrivalTime,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
  };
}

describe("ORDER_LIFETIME_MS — 注文の寿命は 2 時間の定数（AC 1.3）", () => {
  it("2 時間（ミリ秒）である", () => {
    expect(ORDER_LIFETIME_MS).toBe(2 * HOUR);
  });
});

describe("liveOrders — 半開区間の境界（AC 1.4）", () => {
  it("arrivalTime + 寿命 がちょうど now の品目は含まない", () => {
    const boundary = order("o-boundary", NOW - ORDER_LIFETIME_MS);
    expect(liveOrders([boundary], NOW)).toEqual([]);
  });

  it("arrivalTime + 寿命 が now の 1 ms 後の品目は含む", () => {
    const justInside = order("o-inside", NOW - ORDER_LIFETIME_MS + 1);
    expect(liveOrders([justInside], NOW)).toEqual([justInside]);
  });

  it("同じ品目でも now が 1 ms 進めば切れる（境界の 1 ms を二度定義しない）", () => {
    const item = order("o-1", NOW - ORDER_LIFETIME_MS + 1);
    expect(liveOrders([item], NOW)).toEqual([item]);
    expect(liveOrders([item], NOW + 1)).toEqual([]);
  });

  it("arrivalTime が now より未来（上流の時計が進んでいる）なら期限内として扱う", () => {
    const future = order("o-future", NOW + 5 * 60_000);
    expect(liveOrders([future], NOW)).toEqual([future]);
  });
});

describe("liveOrders — 並びと入力（AC 1.1）", () => {
  const expiredA = order("o-a", NOW - 3 * HOUR);
  const liveB = order("o-b", NOW - 90 * 60_000);
  const expiredC = order("o-c", NOW - ORDER_LIFETIME_MS);
  const liveD = order("o-d", NOW - 1);
  const liveE = order("o-e", NOW);

  it("期限内の品目だけを、入力の並びのまま返す（並び替えない）", () => {
    // 到着順ではない並びを渡しても、残る品目の相対順序はそのまま。
    expect(liveOrders([liveD, expiredA, liveB, expiredC, liveE], NOW)).toEqual([
      liveD,
      liveB,
      liveE,
    ]);
  });

  it("入力の配列を変えない", () => {
    const input = [expiredA, liveB, expiredC];
    const before = [...input];
    liveOrders(input, NOW);
    expect(input).toEqual(before);
  });

  it("全件が期限内なら入力と同じ配列を返す（新しい配列を作らない）", () => {
    const input = [liveB, liveD, liveE];
    expect(liveOrders(input, NOW)).toBe(input);
  });

  it("空の待ち行列は空のまま（同じ参照）", () => {
    const empty: readonly PendingOrder[] = [];
    expect(liveOrders(empty, NOW)).toBe(empty);
  });

  it("全件が期限切れなら空", () => {
    expect(liveOrders([expiredA, expiredC], NOW)).toEqual([]);
  });

  it("1 件でも切れれば新しい配列で、切れた品目だけが欠ける", () => {
    const input = [liveB, expiredA];
    const result = liveOrders(input, NOW);
    expect(result).not.toBe(input);
    expect(result).toEqual([liveB]);
  });
});

describe("liveOrders — now と pending だけに依存する（AC 1.2）", () => {
  it("同じ入力からは同じ結果が出る（決定的）", () => {
    const input = [order("o-1", NOW - 3 * HOUR), order("o-2", NOW - 60_000)];
    expect(liveOrders(input, NOW)).toEqual(liveOrders(input, NOW));
  });

  it("判定は arrivalTime だけで、麺種・卓・幅・名前には依らない", () => {
    const expired: PendingOrder = {
      ...order("o-x", NOW - 3 * HOUR),
      noodleType: "Thick",
      tableId: null,
      slotSpan: 2,
      itemName: "特盛",
      sizeName: "大",
    };
    const live: PendingOrder = { ...expired, externalOrderId: "o-y", arrivalTime: NOW - 60_000 };
    expect(liveOrders([expired, live], NOW)).toEqual([live]);
  });
});
