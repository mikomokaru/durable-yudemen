// Feature: lift-order-numbering, Component 1 / **Validates: Requirements 1.1, 1.3, 1.4, 3.1, 3.2, 3.2′, 3.3, 3.5**
//
// tests/domain/lift-order.example.test.ts — 上がり順（Lift_Order）の導出を場面で固定する。
//
// 番号の単位は「同じ実効 endTime かつ同じ注文」（判断 2）。同じ Sync_Set でも注文が違えば別の番号、同じ注文の同じ
// endTime（大盛の 2 釜・同じ注文の 2 品）は同じ番号で、番号は密に振る。茹で上がり（endTime ≤ now）は番号を持たず、
// アドホック（orderItem null）は 1 本 1 単位。同じ endTime の中の注文の順は最早 startTime → externalOrderId。

import { describe, expect, it } from "vitest";
import { liftOrderOf, type LiftTimer } from "../../src/domain/lift-order";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { nonEmpty } from "../nonEmpty";

const NOW = 1_700_000_000_000;
const SECOND = 1000;

/** 走行中の Timer（既定は NOW の 60 秒後に上がる・30 秒前に始めた・注文 o-1）。 */
function timer(
  id: string,
  overrides: Partial<LiftTimer> & { readonly order?: string | null } = {},
): LiftTimer {
  const { order, ...rest } = overrides;
  return {
    id,
    startTime: NOW - 30 * SECOND,
    endTime: NOW + 60 * SECOND,
    orderItem: order === null ? null : { externalOrderId: order ?? "o-1" },
    ...rest,
  };
}

/** 結果を id → 番号の素の object に写す（toEqual で読みやすくするため）。 */
function numbersOf(timers: readonly LiftTimer[], now = NOW): Record<string, number> {
  return Object.fromEntries(liftOrderOf(timers, now));
}

describe("Feature: lift-order-numbering — 番号は実効 endTime の昇順の密な順位（AC 1.1・性質 3.1 / 3.3）", () => {
  it("endTime の早い順に 1 から振る（入力の並びには依らない）", () => {
    const timers = [
      timer("late", { endTime: NOW + 90 * SECOND, order: "o-3" }),
      timer("early", { endTime: NOW + 30 * SECOND, order: "o-1" }),
      timer("mid", { endTime: NOW + 60 * SECOND, order: "o-2" }),
    ];
    expect(numbersOf(timers)).toEqual({ early: 1, mid: 2, late: 3 });
    expect(numbersOf([...timers].reverse())).toEqual({ early: 1, mid: 2, late: 3 });
  });

  it("走行中が無ければ空", () => {
    expect(numbersOf([])).toEqual({});
    expect(numbersOf([timer("done", { endTime: NOW })])).toEqual({});
  });
});

describe("Feature: lift-order-numbering — 単位は同じ実効 endTime かつ同じ注文（判断 2・性質 3.2）", () => {
  it("同じ endTime でも注文が違えば別の番号（同じ Sync_Set は一括で上がるが、盛り付けは注文ごと）", () => {
    const timers = [
      timer("a", { order: "o-1" }),
      timer("b", { order: "o-2" }),
      timer("c", { endTime: NOW + 120 * SECOND, order: "o-3" }),
    ];
    expect(numbersOf(timers)).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("同じ注文の同じ endTime（同じ注文の 2 品）は同じ番号で、番号は密（1・1・2 であって 1・1・3 ではない）", () => {
    const timers = [
      timer("a", { order: "o-1" }),
      timer("b", { order: "o-1" }),
      timer("c", { endTime: NOW + 120 * SECOND, order: "o-2" }),
    ];
    expect(numbersOf(timers)).toEqual({ a: 1, b: 1, c: 2 });
  });

  it("同じ注文でも endTime が違えば別の単位（後で上がる方が後の番号）", () => {
    const timers = [
      timer("first", { endTime: NOW + 30 * SECOND, order: "o-1" }),
      timer("second", { endTime: NOW + 90 * SECOND, order: "o-1" }),
    ];
    expect(numbersOf(timers)).toEqual({ first: 1, second: 2 });
  });

  it("アドホック（orderItem null）は 1 本 1 単位——同じ endTime のアドホック 2 本は別の番号", () => {
    const timers = [timer("adhoc-1", { order: null }), timer("adhoc-2", { order: null })];
    const numbers = numbersOf(timers);
    expect(new Set(Object.values(numbers))).toEqual(new Set([1, 2]));
    expect(numbers["adhoc-1"]).not.toBe(numbers["adhoc-2"]);
  });
});

describe("Feature: lift-order-numbering — 同じ endTime の中の注文の順（判断 2・性質 3.2′）", () => {
  it("単位内の最早 startTime が早い注文が小さい番号（先に始めた注文が先）", () => {
    const timers = [
      // o-2 は 1 本目が o-1 より早く始まっている。
      timer("o2-a", { order: "o-2", startTime: NOW - 50 * SECOND }),
      timer("o1-a", { order: "o-1", startTime: NOW - 40 * SECOND }),
      timer("o2-b", { order: "o-2", startTime: NOW - 10 * SECOND }),
    ];
    expect(numbersOf(timers)).toEqual({ "o2-a": 1, "o2-b": 1, "o1-a": 2 });
  });

  it("最早 startTime も同値なら externalOrderId の符号単位順で断つ（決定的）", () => {
    const timers = [timer("b", { order: "o-b" }), timer("a", { order: "o-a" })];
    expect(numbersOf(timers)).toEqual({ a: 1, b: 2 });
    expect(numbersOf([...timers].reverse())).toEqual({ a: 1, b: 2 });
  });
});

describe("Feature: lift-order-numbering — 茹で上がりは番号を持たない（判断 3・AC 1.4）", () => {
  it("endTime ≤ now の Timer は Map に無く、走行中だけが 1 から詰めて振られる", () => {
    const timers = [
      timer("boiled", { endTime: NOW - 5 * SECOND, order: "o-0" }),
      timer("just-now", { endTime: NOW, order: "o-0" }),
      timer("running", { endTime: NOW + 1, order: "o-1" }),
    ];
    const order = liftOrderOf(timers, NOW);
    expect(order.has("boiled")).toBe(false);
    expect(order.has("just-now")).toBe(false);
    expect(order.get("running")).toBe(1);
  });

  it("時間が進んで先頭が上がると、残りの番号は繰り上がる（描画のたびに now から導く・判断 6）", () => {
    const timers = [
      timer("first", { endTime: NOW + 30 * SECOND, order: "o-1" }),
      timer("second", { endTime: NOW + 60 * SECOND, order: "o-2" }),
    ];
    expect(numbersOf(timers, NOW)).toEqual({ first: 1, second: 2 });
    expect(numbersOf(timers, NOW + 30 * SECOND)).toEqual({ second: 1 });
  });
});

describe("Feature: lift-order-numbering — 複数釜を駆動する Timer は 1 本（判断 5・AC 1.3・性質 3.5）", () => {
  it("engine の Timer（slotIds を 2 つ持つ大盛）をそのまま渡しても 1 本として数え、番号は id に 1 つ付く", () => {
    const large: Timer = createTimer({
      id: "large" as TimerId,
      slotIds: nonEmpty(["0" as SlotId, "1" as SlotId]),
      noodleType: "Thin" as NoodleType,
      firmness: "normal",
      startTime: (NOW - 30 * SECOND) as EpochMillis,
      endTime: (NOW + 60 * SECOND) as EpochMillis,
      seq: 1,
      orderItem: { externalOrderId: "o-1", itemIndex: 0, tableId: "12" },
    });
    const single: Timer = createTimer({
      id: "single" as TimerId,
      slotIds: nonEmpty(["2" as SlotId]),
      noodleType: "Thin" as NoodleType,
      firmness: "normal",
      startTime: (NOW - 30 * SECOND) as EpochMillis,
      endTime: (NOW + 90 * SECOND) as EpochMillis,
      seq: 2,
    });
    // 駆動する釜の数（2）は番号に効かない——single は 3 ではなく 2。
    expect(Object.fromEntries(liftOrderOf([large, single], NOW))).toEqual({ large: 1, single: 2 });
  });
});
