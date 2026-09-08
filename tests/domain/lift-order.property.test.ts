// Feature: lift-order-numbering, Component 1 / **Validates: Requirements 3.1, 3.2, 3.2′, 3.3, 3.4, 3.5**
//
// tests/domain/lift-order.property.test.ts — 上がり順（Lift_Order）の性質。
//
// 生成器は endTime と startTime を少数の値から引き、注文の識別子も少数（＋ null）から引く——同じ endTime・同じ注文・
// 同じ startTime の衝突を高い頻度で作り、単位の束ねと断ち方（3.2 / 3.2′）を踏ませるため。id は位置から振り、
// 一意である。slotIds は導出が読まない事実として同乗させ、複数釜でも 1 本として数えることを鍵の集合で問う（3.5）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { liftOrderOf } from "../../src/domain/lift-order";

const NOW = 1_700_000_000_000;
const SECOND = 1000;

interface SceneTimer {
  readonly id: string;
  readonly slotIds: readonly string[];
  readonly startTime: number;
  readonly endTime: number;
  readonly orderItem: { readonly externalOrderId: string; readonly itemIndex: number } | null;
}

/** 実効 endTime。走行中（NOW より後）と茹で上がり（NOW 以前）を混ぜ、同値が頻出する粗い刻みにする。 */
const genEndTime: fc.Arbitrary<number> = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 1, max: 6 }).map((k) => NOW + k * 30 * SECOND) },
  { weight: 1, arbitrary: fc.integer({ min: -3, max: 0 }).map((k) => NOW + k * 30 * SECOND) },
);

const genTimerBody = fc.record({
  endTime: genEndTime,
  /** 開始は endTime の 10〜120 秒前を粗い刻みで（同値を作る）。 */
  boilSteps: fc.integer({ min: 1, max: 12 }),
  order: fc.oneof(
    { weight: 3, arbitrary: fc.constantFrom("o-1", "o-2", "o-3") },
    { weight: 1, arbitrary: fc.constant(null) },
  ),
  itemIndex: fc.integer({ min: 0, max: 2 }),
  slots: fc.integer({ min: 1, max: 2 }),
});

const genTimers: fc.Arbitrary<readonly SceneTimer[]> = fc
  .array(genTimerBody, { maxLength: 10 })
  .map((bodies) =>
    bodies.map((body, index) => ({
      id: `t-${index}`,
      slotIds: body.slots === 1 ? [String(index)] : [String(index), String(index + 100)],
      startTime: body.endTime - body.boilSteps * 10 * SECOND,
      endTime: body.endTime,
      orderItem:
        body.order === null ? null : { externalOrderId: body.order, itemIndex: body.itemIndex },
    })),
  );

/** 走行中の Timer（導出と同じ線：endTime > now）。 */
function runningOf(timers: readonly SceneTimer[], now: number): readonly SceneTimer[] {
  return timers.filter((timer) => timer.endTime > now);
}

/** 単位の鍵（テスト側の独立な定義——同じ endTime かつ同じ注文。アドホックは id）。 */
function unitKeyOf(timer: SceneTimer): string {
  const order = timer.orderItem === null ? `#${timer.id}` : timer.orderItem.externalOrderId;
  return `${timer.endTime}|${order}`;
}

function numberOf(order: ReadonlyMap<string, number>, id: string): number {
  const n = order.get(id);
  if (n === undefined) throw new Error(`走行中の Timer ${id} に番号が無い`);
  return n;
}

describe("Feature: lift-order-numbering — 上がり順の性質（Requirement 3）", () => {
  it("3.1 順序：番号 i < j なら実効 endTime(i) ≤ endTime(j)", () => {
    fc.assert(
      fc.property(genTimers, (timers) => {
        const order = liftOrderOf(timers, NOW);
        const running = runningOf(timers, NOW);
        for (const a of running) {
          for (const b of running) {
            if (numberOf(order, a.id) < numberOf(order, b.id)) {
              expect(a.endTime).toBeLessThanOrEqual(b.endTime);
            }
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("3.2 同時・同注文：同じ endTime かつ同じ注文は同じ番号、同じ endTime でも注文が違えば（アドホック同士も）別の番号", () => {
    fc.assert(
      fc.property(genTimers, (timers) => {
        const order = liftOrderOf(timers, NOW);
        const running = runningOf(timers, NOW);
        for (const a of running) {
          for (const b of running) {
            if (a.id === b.id) continue;
            const sameUnit = unitKeyOf(a) === unitKeyOf(b);
            expect(numberOf(order, a.id) === numberOf(order, b.id)).toBe(sameUnit);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("3.2′ 注文の順：同じ endTime の中では、単位内の最早 startTime が早い注文が小さい番号", () => {
    fc.assert(
      fc.property(genTimers, (timers) => {
        const order = liftOrderOf(timers, NOW);
        const running = runningOf(timers, NOW);
        // 単位ごとの最早 startTime。
        const earliest = new Map<string, number>();
        for (const timer of running) {
          const key = unitKeyOf(timer);
          earliest.set(key, Math.min(earliest.get(key) ?? Infinity, timer.startTime));
        }
        for (const a of running) {
          for (const b of running) {
            if (a.endTime !== b.endTime || unitKeyOf(a) === unitKeyOf(b)) continue;
            const startA = earliest.get(unitKeyOf(a)) ?? Infinity;
            const startB = earliest.get(unitKeyOf(b)) ?? Infinity;
            if (startA < startB) {
              expect(numberOf(order, a.id)).toBeLessThan(numberOf(order, b.id));
            }
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("3.3 密：出ている番号の集合は 1..k の連続（k は Lift_Unit の数）", () => {
    fc.assert(
      fc.property(genTimers, (timers) => {
        const order = liftOrderOf(timers, NOW);
        const units = new Set(runningOf(timers, NOW).map(unitKeyOf));
        const numbers = [...new Set(order.values())].sort((a, b) => a - b);
        expect(numbers).toEqual(Array.from({ length: units.size }, (_, index) => index + 1));
      }),
      { numRuns: 300 },
    );
  });

  it("3.4 店舗全体：番号は Timer 集合全体の関数——入力の並びに依らず、単位を丸ごと落として導き直せば番号は押し上がるだけで相対順序は変わらない", () => {
    // 担当ユニットを変えても同じ Timer の番号が変わらないのは、読む側が常に店舗全体の Map から引くからである
    // （client の slotDisplay.example が担当外の Timer による押し上げを固定する）。ここで問うのは、その Map が
    // 集合全体の関数であること——(a) 入力の並びに依らない、(b) 単位（同じ endTime かつ同じ注文）を丸ごと落とした
    // 部分集合で導き直しても、残った単位の相対順序は同じで番号は減るだけ。単位を割って落とせば最早 startTime が
    // 変わり同じ endTime の中の順が入れ替わりうるので、丸ごと落とす（担当分の表示は店舗全体から引くのが規律）。
    fc.assert(
      fc.property(
        genTimers,
        fc.array(fc.boolean(), { minLength: 32, maxLength: 32 }),
        (timers, mask) => {
          const full = liftOrderOf(timers, NOW);
          expect(liftOrderOf([...timers].reverse(), NOW)).toEqual(full);
          const unitKeys = [...new Set(timers.map(unitKeyOf))];
          const kept = timers.filter((timer) => mask[unitKeys.indexOf(unitKeyOf(timer))] ?? false);
          const partial = liftOrderOf(kept, NOW);
          const running = runningOf(kept, NOW);
          for (const a of running) {
            expect(numberOf(partial, a.id)).toBeLessThanOrEqual(numberOf(full, a.id));
            for (const b of running) {
              expect(Math.sign(numberOf(partial, a.id) - numberOf(partial, b.id))).toBe(
                Math.sign(numberOf(full, a.id) - numberOf(full, b.id)),
              );
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("3.5 複数釜と茹で上がり：鍵の集合は走行中の id とちょうど一致する（複数釜の Timer も 1 本・boiled は無い）", () => {
    fc.assert(
      fc.property(genTimers, (timers) => {
        const order = liftOrderOf(timers, NOW);
        expect(new Set(order.keys())).toEqual(new Set(runningOf(timers, NOW).map((t) => t.id)));
        // slotIds は読まない——釜の数を変えても同じ Map。
        const singleSlot = timers.map((timer) => ({
          ...timer,
          slotIds: [timer.slotIds[0] ?? "0"],
        }));
        expect(liftOrderOf(singleSlot, NOW)).toEqual(order);
      }),
      { numRuns: 300 },
    );
  });

  it("決定性：同じ入力から同じ Map。時間が進んでも走行中の相対順序は変わらない（先頭が上がると繰り上がるだけ）", () => {
    fc.assert(
      fc.property(genTimers, fc.integer({ min: 0, max: 200 * SECOND }), (timers, elapsed) => {
        const before = liftOrderOf(timers, NOW);
        expect(liftOrderOf(timers, NOW)).toEqual(before);
        const after = liftOrderOf(timers, NOW + elapsed);
        for (const a of runningOf(timers, NOW + elapsed)) {
          expect(numberOf(after, a.id)).toBeLessThanOrEqual(numberOf(before, a.id));
          for (const b of runningOf(timers, NOW + elapsed)) {
            expect(Math.sign(numberOf(after, a.id) - numberOf(after, b.id))).toBe(
              Math.sign(numberOf(before, a.id) - numberOf(before, b.id)),
            );
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
