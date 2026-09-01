// tests/core/pending.example.test.ts — 待ち行列の集合操作が現場の 2 つの形をどう扱うかの回帰テスト（要件1.6 / 1.8）。
//
// 1 つは事故の形：3 品の注文のうち 1 品を茹で始めた後で、POS が 3 品すべてを含む modification を再送する。
// 除外を怠れば茹でている品が待ち行列へ戻り、同じ麺が二度茹でられる。
// もう 1 つは静けさの形：知らない注文のキャンセルが届いても、何も起きない。

import { describe, expect, it } from "vitest";
import { consumeOrder, removeOrder, upsertOrder } from "../../src/engine/pending";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { PendingOrder } from "../../src/domain/order";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { nonEmpty } from "../nonEmpty";

/** 注文の受理時刻（Wait_Time の起点）。modification はこれより 5 分後に届く。 */
const ARRIVED_AT = 1_000_000;
const MODIFIED_AT = ARRIVED_AT + 300_000;

/** 3 品の注文 o-1（同卓 t-7）。品目 0 を人が茹で始めた、という場面を組む。 */
function item(itemIndex: number, noodleType: string, arrivalTime: number): PendingOrder {
  return {
    externalOrderId: "o-1",
    itemIndex,
    noodleType,
    firmness: "normal",
    tableId: "t-7",
    arrivalTime,
    slotSpan: 1,
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
  orderItem: { externalOrderId: "o-1", itemIndex: 0 },
});

describe("upsertOrder — 一部開始済みの注文への modification", () => {
  // 開始で品目 0 は待ち行列から消えている（consumeOrder の帰結）。残るのは 1 と 2。
  const pending: readonly PendingOrder[] = [
    item(1, "thick", ARRIVED_AT),
    item(2, "curly", ARRIVED_AT),
  ];

  it("全品目を含む再送でも開始済み品目は待ち行列へ戻らず、起点は元の受理時刻を保つ", () => {
    // POS は注文の全体像（3 品）を送ってくる。受理時刻は今（MODIFIED_AT）。
    const arrival = nonEmpty([
      item(0, "thin", MODIFIED_AT),
      item(1, "thick", MODIFIED_AT),
      item(2, "curly", MODIFIED_AT),
    ]);

    const next = upsertOrder(pending, [started], arrival);

    // 品目 0 は茹でている最中——復活させれば二重調理になる。
    expect(next.map((order) => order.itemIndex)).toEqual([1, 2]);
    // 待ち時間の起点は元の受理時刻。変更が待ち行列の並びを不当に若返らせない（AC 1.8）。
    expect(next.every((order) => order.arrivalTime === ARRIVED_AT)).toBe(true);
  });

  it("内容が同じ再送は集合を変えない（同じ配列インスタンスが返る）", () => {
    const resend = nonEmpty([item(1, "thick", MODIFIED_AT), item(2, "curly", MODIFIED_AT)]);

    expect(upsertOrder(pending, [started], resend)).toBe(pending);
  });

  it("到着に含まれない品目は当該注文から消える（modification のキャンセル分）", () => {
    // 品目 2 を取り消し、品目 1 の麺を替えた modification。
    const arrival = nonEmpty([item(1, "curly", MODIFIED_AT)]);

    const next = upsertOrder(pending, [started], arrival);

    expect(next).toEqual([item(1, "curly", ARRIVED_AT)]);
  });
});

describe("removeOrder / consumeOrder — キャンセルと開始による除去", () => {
  const pending: readonly PendingOrder[] = [
    item(1, "thick", ARRIVED_AT),
    item(2, "curly", ARRIVED_AT),
  ];

  it("存在しない externalOrderId のキャンセルは no-op（集合を変えない）", () => {
    // 未到達・既に除去済み・既に開始済みを区別しない（AC 1.6）。
    expect(removeOrder(pending, "o-unknown")).toBe(pending);
  });

  it("キャンセルは当該注文の全品目を除き、開始済み Timer には触れない", () => {
    expect(removeOrder(pending, "o-1")).toEqual([]);
    // Timer 集合はこの関数の関心事ではない——自動キャンセルの経路が存在しないこと自体が保証である。
    expect(started.orderItem).toEqual({ externalOrderId: "o-1", itemIndex: 0 });
  });

  it("人の開始は 1 品目だけを除く", () => {
    expect(consumeOrder(pending, "o-1", 1)).toEqual([item(2, "curly", ARRIVED_AT)]);
    // 開始済み・不在の品目に対する消費は集合を変えない。
    expect(consumeOrder(pending, "o-1", 0)).toBe(pending);
  });
});
