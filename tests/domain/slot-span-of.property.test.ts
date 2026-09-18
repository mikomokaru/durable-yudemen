// tests/domain/slot-span-of.property.test.ts — 玉数から釜数を導く唯一の規則（`slotSpanOf`・noodle-portions）の性質。
//
// _Validates: noodle-portions Requirements 2.1〜2.5, 9.1〜9.4_
//
// 釜数は設定にも状態にも保持しない導出値である。ここで固定するのは、導出が Portions の全値域で整数かつ値域内で
// あること（性質 2）、玉数に対して単調であること（性質 1）、天井の意味（性質 3）、そして半玉単位の整数演算が
// 有理数の天井と一致すること（性質 4・浮動小数の丸めで 1 ずれない）。観測事実 7 の表（麺量マスタ 490 行）は example。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  isPortions,
  PORTIONS_MAX,
  PORTIONS_MIN,
  PORTIONS_PER_SLOT,
  SLOT_SPAN_MAX,
  SLOT_SPAN_MIN,
  slotSpanOf,
} from "../../src/domain/store";

/** Portions の全値（0.5 刻み・PORTIONS_MIN〜PORTIONS_MAX）。半玉単位の整数から導く。 */
const genPortions: fc.Arbitrary<number> = fc
  .integer({ min: PORTIONS_MIN * 2, max: PORTIONS_MAX * 2 })
  .map((half) => half / 2);

/** Portions の全値の列挙（18 値）。全数で回すための材料。 */
const ALL_PORTIONS: readonly number[] = Array.from(
  { length: PORTIONS_MAX * 2 - PORTIONS_MIN * 2 + 1 },
  (_unused, index) => (PORTIONS_MIN * 2 + index) / 2,
);

describe("slotSpanOf — 玉数から釜数を導く唯一の規則", () => {
  it("性質 2: Portions の全値で整数を返し、SLOT_SPAN_MIN〜SLOT_SPAN_MAX に収まる", () => {
    fc.assert(
      fc.property(genPortions, (portions) => {
        expect(isPortions(portions)).toBe(true);
        const span = slotSpanOf(portions);
        expect(Number.isInteger(span)).toBe(true);
        expect(span).toBeGreaterThanOrEqual(SLOT_SPAN_MIN);
        expect(span).toBeLessThanOrEqual(SLOT_SPAN_MAX);
      }),
      { numRuns: 100 },
    );
  });

  it("性質 1: 玉数に対して単調非減少（多い玉数が少ない釜数を要ることは無い）", () => {
    fc.assert(
      fc.property(genPortions, genPortions, (a, b) => {
        const [less, more] = a <= b ? [a, b] : [b, a];
        expect(slotSpanOf(less)).toBeLessThanOrEqual(slotSpanOf(more));
      }),
      { numRuns: 100 },
    );
  });

  it("性質 3: 天井の意味——(span − 1) × 1.5 < portions ≤ span × 1.5", () => {
    fc.assert(
      fc.property(genPortions, (portions) => {
        const span = slotSpanOf(portions);
        expect((span - 1) * PORTIONS_PER_SLOT).toBeLessThan(portions);
        expect(portions).toBeLessThanOrEqual(span * PORTIONS_PER_SLOT);
      }),
      { numRuns: 100 },
    );
  });

  it("性質 4: 全 18 値で、半玉単位の整数演算は有理数の天井と一致する（浮動小数の丸めで 1 ずれない）", () => {
    expect(ALL_PORTIONS).toHaveLength(18);
    for (const portions of ALL_PORTIONS) {
      // 有理数の天井を整数だけで組む：2p / 3 の天井 = floor((2p + 2) / 3)。
      const half = portions * 2;
      const exact = Math.floor((half + 2) / 3);
      expect(slotSpanOf(portions), `portions=${portions}`).toBe(exact);
    }
  });

  it("観測事実 7 の表を再現する——0.5→1・1→1・1.5→1・2→2・2.5→2（中盛 1.5 玉は 1 釜）", () => {
    expect([0.5, 1, 1.5, 2, 2.5].map(slotSpanOf)).toEqual([1, 1, 1, 2, 2]);
    // 上限：9 玉はちょうど 6 釜（1 ユニット）。
    expect(slotSpanOf(PORTIONS_MAX)).toBe(SLOT_SPAN_MAX);
    expect(slotSpanOf(PORTIONS_MIN)).toBe(SLOT_SPAN_MIN);
  });

  it("規則は定数で、値域は既存の釜数の上限から導かれる（PORTIONS_MAX = SLOT_SPAN_MAX × PORTIONS_PER_SLOT）", () => {
    expect(PORTIONS_PER_SLOT).toBe(1.5);
    expect(PORTIONS_MAX).toBe(SLOT_SPAN_MAX * PORTIONS_PER_SLOT);
    // 刻み外・値域外は Portions ではない。
    for (const value of [0, 1.25, PORTIONS_MAX + 0.5, -0.5, Number.NaN, "1"]) {
      expect(isPortions(value), String(value)).toBe(false);
    }
  });
});
