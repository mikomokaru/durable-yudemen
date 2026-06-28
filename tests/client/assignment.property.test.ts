// tests/client/assignment.property.test.ts — Property 15（担当絞り込みは健全かつ完全）。
// assignment.ts は WS も DOM も触れない純粋導出のため、Workers pool 不要のプレーン Vitest で検証する。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assignedTimers, isAssigned, slotOf, slotsOfUnits } from "../../src/client/assignment";
import type { TimerFact } from "../../src/domain/timer";

// ユニット 1 つが担当する連続スロット数。unit u は slot 6u..6u+5（要件12.5）。
const SLOTS_PER_UNIT = 6;

// slotId は担当範囲（ユニット 0..5 → スロット 0..35）に着地する数値文字列と、
// 範囲外・非数値の任意文字列を混ぜ、被担当・非担当の双方を誘発する。
const genSlotId: fc.Arbitrary<string> = fc.oneof(
  fc.integer({ min: 0, max: 35 }).map(String),
  fc.string({ minLength: 1, maxLength: 6 }),
);

// 一件の TimerFact。id は射影の同一性追跡用に index で決定的に付与する（buildTimers 内）。
const genTimerSpec: fc.Arbitrary<Omit<TimerFact, "id">> = fc.record({
  slotId: genSlotId,
  noodleType: fc.constantFrom("thin", "thick", "curly", "ramen", "soba", "udon"),
  endTime: fc.integer({ min: 0, max: 2000 }),
});

// 0〜30 件の TimerFact 集合（空・単一・多数を境界として含む）。id は一意。
const genTimers: fc.Arbitrary<readonly TimerFact[]> = fc
  .array(genTimerSpec, { maxLength: 30 })
  .map((specs) => specs.map((spec, index) => ({ id: `timer-${index}`, ...spec })));

// 担当ユニット集合。小さめの非負整数（重複・空集合を含む）でスロット範囲を可制御に保つ。
const genUnits: fc.Arbitrary<readonly number[]> = fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 6 });

describe("client/assignment", () => {
  // Feature: yude-men-timer, Property 15: 担当絞り込みは健全かつ完全（クライアント表示スコープ）
  // 任意の TimerFact 集合と担当ユニット集合について、assignedTimers が部分集合性・担当性・完全性を
  // 同時に満たし、slotsOfUnits([u]) == {6u..6u+5}・isAssigned(slot, units) == (slot ∈ slotsOfUnits(units))
  // が成り立つことを単一テストで検証する（要件12.2・12.5）。
  it("Property 15: 担当絞り込みは健全かつ完全（部分集合性・担当性・完全性＋スロット写像の一致）", () => {
    fc.assert(
      fc.property(genTimers, genUnits, fc.integer({ min: 0, max: 5 }), fc.integer({ min: -5, max: 40 }), (all, units, u, slot) => {
        const assigned = assignedTimers(all, units);
        const assignedSlots = slotsOfUnits(units);

        // (a) 部分集合性（健全性）: 出力は入力の部分集合（同一参照＝Timer を増殖・変質させない）。
        for (const timer of assigned) {
          expect(all.includes(timer)).toBe(true);
        }

        // (b) 担当性: 出力の各 Timer のスロットは必ず担当スロット集合に属する。
        for (const timer of assigned) {
          expect(assignedSlots.has(slotOf(timer.slotId))).toBe(true);
        }

        // (c) 完全性（漏れなし）: 入力のうちスロットが担当スロット集合に属する Timer は、すべて出力に含まれる。
        for (const timer of all) {
          if (assignedSlots.has(slotOf(timer.slotId))) {
            expect(assigned.includes(timer)).toBe(true);
          }
        }

        // slotsOfUnits([u]) == {6u, 6u+1, …, 6u+5}（0 始まり・連続 6 スロット）。
        const single = slotsOfUnits([u]);
        const expected = new Set<number>();
        for (let offset = 0; offset < SLOTS_PER_UNIT; offset++) {
          expected.add(u * SLOTS_PER_UNIT + offset);
        }
        expect([...single].sort((a, b) => a - b)).toEqual([...expected].sort((a, b) => a - b));

        // isAssigned(slot, units) は slot ∈ slotsOfUnits(units) と一致する。
        expect(isAssigned(slot, units)).toBe(assignedSlots.has(slot));
      }),
      { numRuns: 200 },
    );
  });
});
