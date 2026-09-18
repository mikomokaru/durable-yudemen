// tests/core/pending.example.test.ts — 品目集合の操作（後着の upsert・注文単位の除去）が現場の形をどう扱うかの回帰テスト
// （pos-order-ingress 要件1.6 / 1.8・order-lifecycle Requirement 2）。
//
// **Validates: order-lifecycle Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 7.5**
//
// 後着の規則は一つ——同じ品目は状態にかかわらず POS 由来の注文属性だけを更新し、厨房の事実（completedAt / interruptedAt）と
// 生きた Timer と arrivalTime の引継ぎは保つ。かつての「生きた Timer を持つ品目は置換の結果から除く」規則は撤去した：
// A を調理中に同じ注文 {A, B} が再送されるだけで正本が {B} に置き換わり、A の参照先が消えていた（判断 8）。
// 前提（POS の取消は発生しない）を理由に受理を黙って変えないことも、ここで回帰として固定する（AC 2.6）。

import { describe, expect, it } from "vitest";
import {
  isSameOrderItems,
  ORDER_ITEM_LIMIT,
  removeOrder,
  upsertOrder,
} from "../../src/engine/pending";
import { createTimer, type Timer } from "../../src/engine/timer";
import { itemStatusOf, type OrderItem } from "../../src/domain/order";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { nonEmpty } from "../nonEmpty";
import { uniqueOrderItems } from "./generators";

/** 注文の受理時刻（Wait_Time の起点）。modification はこれより 5 分後に届く。 */
const ARRIVED_AT = 1_000_000;
const MODIFIED_AT = ARRIVED_AT + 300_000;

/** 3 品の注文 o-1（同卓 t-7）。品目 0 を人が茹で始めた、という場面を組む。 */
function item(itemIndex: number, noodleType: string, arrivalTime: number): OrderItem {
  return {
    externalOrderId: "o-1",
    itemIndex,
    noodleType,
    firmness: "normal",
    tableId: "t-7",
    arrivalTime,
    portions: 1,
    itemName: null,
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
    tableAssignedAt: null,
  };
}

/** 注文品目 0 から始まった走行中の Timer。 */
const started: Timer = createTimer({
  id: "t-a" as TimerId,
  slotIds: nonEmpty(["0" as SlotId]),
  noodleType: "thin" as NoodleType,
  firmness: "normal",
  startTime: (ARRIVED_AT + 60_000) as EpochMillis,
  endTime: (ARRIVED_AT + 180_000) as EpochMillis,
  seq: 0,
  orderItem: { externalOrderId: "o-1", itemIndex: 0, tableId: "t-7" },
});

describe("upsertOrder — 一部開始済みの注文への modification（AC 2.1 / 2.2 / 2.3）", () => {
  // 開始で品目 0 は消えない（order-lifecycle AC 1.1）。3 品とも正本に在り、品目 0 は Timer の参照で cooking。
  const items: readonly OrderItem[] = [
    item(0, "thin", ARRIVED_AT),
    item(1, "thick", ARRIVED_AT),
    item(2, "curly", ARRIVED_AT),
  ];

  it("回帰：A を調理中に {A, B, C} が再送されても A は正本に残り、参照が解ける。起点は元の受理時刻を保つ", () => {
    // POS は注文の全体像（3 品）を送ってくる。受理時刻は今（MODIFIED_AT）。
    const arrival = nonEmpty([
      item(0, "thin", MODIFIED_AT),
      item(1, "thick", MODIFIED_AT),
      item(2, "curly", MODIFIED_AT),
    ]);

    const next = upsertOrder(items, [started], arrival);

    expect(next.map((order) => order.itemIndex)).toEqual([0, 1, 2]);
    expect(itemStatusOf(next[0]!, [started])).toBe("cooking");
    // 待ち時間の起点は元の受理時刻。変更が待ち行列の並びを不当に若返らせない（AC 1.8 / 2.3）。
    expect(next.every((order) => order.arrivalTime === ARRIVED_AT)).toBe(true);
  });

  it("内容が同じ再送は集合を変えない（同じ配列インスタンスが返る）——調理中の品目を含んでも", () => {
    const resend = nonEmpty([
      item(0, "thin", MODIFIED_AT),
      item(1, "thick", MODIFIED_AT),
      item(2, "curly", MODIFIED_AT),
    ]);

    expect(upsertOrder(items, [started], resend)).toBe(items);
  });

  it("調理中の品目も注文属性（麺種・茹で加減・卓・盛り・名称）だけは更新され、Timer には触れない（AC 2.1 / 7.8）", () => {
    const arrival = nonEmpty([
      { ...item(0, "thick", MODIFIED_AT), firmness: "hard" as const, tableId: "t-9", portions: 2 },
      { ...item(1, "thick", MODIFIED_AT), itemName: "特盛", sizeName: "大" },
      item(2, "curly", MODIFIED_AT),
    ]);

    const next = upsertOrder(items, [started], arrival);

    expect(next[0]).toEqual({
      ...item(0, "thick", ARRIVED_AT),
      firmness: "hard",
      tableId: "t-9",
      portions: 2,
    });
    expect(next[1]).toEqual({ ...item(1, "thick", ARRIVED_AT), itemName: "特盛", sizeName: "大" });
    // Timer は調理を開始した時点の情報のまま（卓も麺種も追随しない）。
    expect(started.orderItem).toEqual({ externalOrderId: "o-1", itemIndex: 0, tableId: "t-7" });
    expect(started.noodleType).toBe("thin");
  });

  it("到着に無い未調理の品目は当該注文から消える（modification の削除分・既存どおり）", () => {
    // 品目 2 を取り消し、品目 1 の麺を替えた modification。品目 0 は調理中ゆえ残る。
    const arrival = nonEmpty([item(0, "thin", MODIFIED_AT), item(1, "curly", MODIFIED_AT)]);

    const next = upsertOrder(items, [started], arrival);

    expect(next).toEqual([item(0, "thin", ARRIVED_AT), item(1, "curly", ARRIVED_AT)]);
  });

  it("回帰：到着に無い品目でも cooking / done は残し、unstarted だけ除く（AC 2.5・前提の外でも壊さない）", () => {
    const done: OrderItem = { ...item(1, "thick", ARRIVED_AT), completedAt: ARRIVED_AT + 200_000 };
    const current = [item(0, "thin", ARRIVED_AT), done, item(2, "curly", ARRIVED_AT)];
    // 品目 2（未調理）だけを含まない再送——{0, 1} を送り直す形ではなく、3 品とも無い「別の品目だけの再送」。
    const arrival = nonEmpty([item(3, "soba", MODIFIED_AT)]);

    const next = upsertOrder(current, [started], arrival);

    expect(next.map((order) => order.itemIndex)).toEqual([0, 1, 3]);
    expect(itemStatusOf(next[0]!, [started])).toBe("cooking");
    expect(itemStatusOf(next[1]!, [started])).toBe("done");
    // 新しく現れた品目は厨房の事実を null で持ち、起点は注文の最早を引き継ぐ（AC 2.4）。
    expect(next[2]).toEqual(item(3, "soba", ARRIVED_AT));
  });

  it("回帰：done の品目は同じ注文の再送で unstarted に戻らない（completedAt を保つ・AC 2.2）", () => {
    const done: OrderItem = { ...item(0, "thin", ARRIVED_AT), completedAt: ARRIVED_AT + 200_000 };
    const current = [done, item(1, "thick", ARRIVED_AT)];
    const arrival = nonEmpty([item(0, "thin", MODIFIED_AT), item(1, "thick", MODIFIED_AT)]);

    const next = upsertOrder(current, [], arrival);

    expect(next).toBe(current);
    expect(itemStatusOf(next[0]!, [])).toBe("done");
  });

  it("回帰：Cancel で中断された品目（interruptedAt）は再送で保持される（AC 2.2・性質 7.5）", () => {
    const interrupted: OrderItem = {
      ...item(0, "thin", ARRIVED_AT),
      interruptedAt: ARRIVED_AT + 100,
    };
    const arrival = nonEmpty([{ ...item(0, "thin", MODIFIED_AT), tableId: "t-9" }]);

    const next = upsertOrder([interrupted], [], arrival);

    expect(next).toEqual([{ ...interrupted, tableId: "t-9" }]);
    expect(itemStatusOf(next[0]!, [])).toBe("unstarted");
  });

  it("v12 由来で参照先の無い Timer が残る中で POS がその品目を再送すると、品目は cooking として加わる（AC 2.4・性質 7.9′）", () => {
    // 正本は空（旧実装が開始時に消費していた）。Timer だけが品目 0 を指している。
    const next = upsertOrder([], [started], nonEmpty([item(0, "thin", MODIFIED_AT)]));

    expect(next).toEqual([item(0, "thin", MODIFIED_AT)]);
    expect(itemStatusOf(next[0]!, [started])).toBe("cooking");
  });

  it("初回到着は末尾へ、再送の新しい品目は当該注文の末尾へ置く（並びを揺らさない）", () => {
    const other: OrderItem = { ...item(0, "udon", ARRIVED_AT - 1), externalOrderId: "o-0" };
    const current = [item(0, "thin", ARRIVED_AT), other];
    const arrival = nonEmpty([item(0, "thin", MODIFIED_AT), item(1, "thick", MODIFIED_AT)]);

    const next = upsertOrder(current, [], arrival);

    expect(next.map((order) => `${order.externalOrderId}#${order.itemIndex}`)).toEqual([
      "o-1#0",
      "o-1#1",
      "o-0#0",
    ]);
    // 到着内の重複は初出だけを採る。
    const duplicated = nonEmpty([item(2, "curly", MODIFIED_AT), item(2, "soba", MODIFIED_AT)]);
    expect(upsertOrder([], [], duplicated)).toEqual([item(2, "curly", MODIFIED_AT)]);
  });
});

describe("removeOrder — 注文単位の除去（0 件の後着・OrderCancelled・AC 2.5）", () => {
  const items: readonly OrderItem[] = [
    item(0, "thin", ARRIVED_AT),
    item(1, "thick", ARRIVED_AT),
    { ...item(2, "curly", ARRIVED_AT), completedAt: ARRIVED_AT + 200_000 },
  ];

  it("存在しない externalOrderId の除去は no-op（集合を変えない）", () => {
    // 未到達・既に除去済み・全品目が開始済みを区別しない（AC 1.6）。
    expect(removeOrder(items, [started], "o-unknown")).toBe(items);
  });

  it("未調理の品目だけを除き、cooking / done と開始済み Timer には触れない", () => {
    expect(removeOrder(items, [started], "o-1")).toEqual([items[0], items[2]]);
    // Timer 集合はこの関数の関心事ではない——自動キャンセルの経路が存在しないこと自体が保証である。
    expect(started.orderItem).toEqual({ externalOrderId: "o-1", itemIndex: 0, tableId: "t-7" });
    // Timer が無ければ品目 0 は未調理ゆえ除かれる（同じ規則から出る）。
    expect(removeOrder(items, [], "o-1")).toEqual([items[2]]);
  });
});

describe("isSameOrderItems — 全フィールドの一致（厨房の事実を含む）", () => {
  it("completedAt / interruptedAt / 申告名 / slotSpan が違えば別の集合", () => {
    const base = [item(0, "thin", ARRIVED_AT)];
    expect(isSameOrderItems(base, [item(0, "thin", ARRIVED_AT)])).toBe(true);
    expect(isSameOrderItems(base, [{ ...base[0]!, completedAt: 1 }])).toBe(false);
    expect(isSameOrderItems(base, [{ ...base[0]!, interruptedAt: 1 }])).toBe(false);
    expect(isSameOrderItems(base, [{ ...base[0]!, itemName: "x" }])).toBe(false);
    expect(isSameOrderItems(base, [{ ...base[0]!, portions: 2 }])).toBe(false);
    expect(isSameOrderItems(base, [])).toBe(false);
  });
});

describe("upsertOrder — 上限で忘れる（order-item-truncation Requirement 2）", () => {
  /** 満杯の集合。生成器の起点をずらして「到着より新しい」側に揃える。 */
  function fullSet(): readonly OrderItem[] {
    const base = uniqueOrderItems(ORDER_ITEM_LIMIT);
    return Array.from({ length: ORDER_ITEM_LIMIT }, (_unused, index) => ({
      externalOrderId: base[index]!.externalOrderId,
      itemIndex: base[index]!.itemIndex,
      noodleType: "thin",
      firmness: "normal" as const,
      tableId: null,
      arrivalTime: base[index]!.arrivalTime + 10_000_000,
      portions: 1,
      itemName: null,
      sizeName: null,
      completedAt: null,
      interruptedAt: null,
      tableAssignedAt: null,
    }));
  }

  it("満杯に新しい注文が届くと、最も古い分だけが落ちて件数は上限のまま", () => {
    const items = fullSet();
    const arriving: OrderItem = { ...item(0, "thin", 99_000_000), externalOrderId: "o-new" };

    const next = upsertOrder(items, [], nonEmpty([arriving]));

    expect(next.length).toBe(ORDER_ITEM_LIMIT);
    // 届いた品目は最も新しいので残り、最も古い 1 件が落ちる。
    expect(next.at(-1)).toEqual(arriving);
    expect(next[0]).toEqual(items[1]);
  });

  it("届いた品目がそのまま忘れられるなら、元の集合インスタンスを返す（truncate してから同一性を判定する）", () => {
    const items = fullSet();
    // 集合のどれよりも古い到着。upsert で末尾に付いた直後、truncate に真っ先に落とされる。
    const arriving: OrderItem = { ...item(0, "thin", 1), externalOrderId: "o-late" };

    const next = upsertOrder(items, [], nonEmpty([arriving]));

    // 判定順が逆（同一性 → truncate）だと、内容の同じ**別インスタンス**が返り、
    // settle が空振りの Persist / Broadcast を出す。参照同値がその回帰である。
    expect(next).toBe(items);
  });
});
