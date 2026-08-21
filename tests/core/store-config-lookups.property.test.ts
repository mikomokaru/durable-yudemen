// tests/core/store-config-lookups.property.test.ts — POS の対応表 2 枚（firmnessCodes / menuItems）の
// 検証関数（src/domain/store.ts）の property test。
//
// 対象は pos-order-ingress で足した toFirmnessCodes / toMenuItems。既存 to* と同形（生値 → 検証済みの形）で、
// workerd に依らない純粋関数である。主張は 3 つ——全域（任意の生値で例外を投げず妥当域内の表だけを返す）、
// 素通し（妥当な表は生値のまま保たれる）、要素独立（不正な要素だけが落ち、妥当な要素を巻き込まない）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FIRMNESS_ORDER } from "../../src/domain/firmness";
import type { NonEmptyArray } from "../../src/domain/timer";
import {
  DEFAULT_FIRMNESS_CODES,
  DEFAULT_MENU_ITEMS,
  SLOT_SPAN_MAX,
  SLOT_SPAN_MIN,
  toFirmnessCodes,
  toMenuItems,
  type FirmnessCode,
  type MenuItem,
  type NoodleSize,
} from "../../src/domain/store";

// ── 生成器 ──

/** 券売機の商品コード（採番された正の整数）。実データの帯（10010・19401・116051）を含む範囲で振る。 */
const genProductCode: fc.Arbitrary<number> = fc.integer({ min: 1, max: 999_999 });

const genFirmnessCode: fc.Arbitrary<FirmnessCode> = fc.record({
  code: genProductCode,
  firmness: fc.constantFrom(...FIRMNESS_ORDER),
});

const genNoodleSize: fc.Arbitrary<NoodleSize> = fc.record({
  code: genProductCode,
  slotSpan: fc.integer({ min: SLOT_SPAN_MIN, max: SLOT_SPAN_MAX }),
});

/** 非空の麺量群（NonEmptyArray を型で担保する。先頭 1 件と残りを別に生成して組む）。 */
const genNoodleSizes: fc.Arbitrary<NonEmptyArray<NoodleSize>> = fc
  .tuple(genNoodleSize, fc.array(genNoodleSize, { maxLength: 2 }))
  .map(([head, tail]) => [head, ...tail] as NonEmptyArray<NoodleSize>);

const genMenuItem: fc.Arbitrary<MenuItem> = fc.record({
  productCode: genProductCode,
  noodleType: fc.string({ minLength: 1, maxLength: 12 }),
  sizes: genNoodleSizes,
});

/**
 * 妥当な硬さ対応の要素にはなりえない生値。
 *
 * fc.anything() を使わないのは、偶然妥当な要素を引いたときに「不正な要素だけが落ちる」の主張が崩れるため。
 */
const genInvalidFirmnessCode: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.constant(42),
  fc.constant("10010"),
  fc.constant({}),
  fc.constant({ code: 10_010 }), // firmness 欠落
  fc.constant({ firmness: "normal" }), // code 欠落
  fc.constant({ code: 0, firmness: "normal" }), // 商品コードは正の整数
  fc.constant({ code: -1, firmness: "normal" }),
  fc.constant({ code: 1.5, firmness: "normal" }),
  fc.constant({ code: 10_010, firmness: "veryHard" }), // 未知の茹で加減
);

/** 妥当なメニューの要素にはなりえない生値（サイズ 0 個・値域外の slotSpan を含む）。 */
const genInvalidMenuItem: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.constant("11421"),
  fc.constant({}),
  fc.constant({ productCode: 11_421, noodleType: "Thin" }), // sizes 欠落
  fc.constant({ productCode: 11_421, noodleType: "Thin", sizes: [] }), // サイズ 0 個
  fc.constant({ productCode: 11_421, noodleType: "", sizes: [{ code: 19_401, slotSpan: 1 }] }),
  fc.constant({ productCode: 0, noodleType: "Thin", sizes: [{ code: 19_401, slotSpan: 1 }] }),
  fc.constant({ productCode: 11_421, noodleType: "Thin", sizes: [{ code: 19_401, slotSpan: 0 }] }),
  fc.constant({
    productCode: 11_421,
    noodleType: "Thin",
    sizes: [{ code: 19_401, slotSpan: SLOT_SPAN_MAX + 1 }],
  }),
  fc.constant({ productCode: 11_421, noodleType: "Thin", sizes: [{ slotSpan: 1 }] }), // code 欠落
);

// ── 妥当域の判定（domain の定数を正本とする）──

function isValidFirmnessCode(entry: FirmnessCode): boolean {
  return Number.isInteger(entry.code) && entry.code > 0 && FIRMNESS_ORDER.includes(entry.firmness);
}

function isValidMenuItem(item: MenuItem): boolean {
  return (
    Number.isInteger(item.productCode) &&
    item.productCode > 0 &&
    item.noodleType.length > 0 &&
    item.sizes.length > 0 &&
    item.sizes.every(
      (size) =>
        Number.isInteger(size.code) &&
        size.code > 0 &&
        Number.isInteger(size.slotSpan) &&
        size.slotSpan >= SLOT_SPAN_MIN &&
        size.slotSpan <= SLOT_SPAN_MAX,
    )
  );
}

describe("domain/store — POS 対応表の検証", () => {
  // Feature: pos-order-ingress, Property: 対応表の検証は全域であり、返る表は常に妥当域内に収まる
  // **Validates: Requirements 6.30, 6.31, 6.32**
  it("Property: 任意の生値に対し例外を投げず、妥当域内の対応表だけを返す", () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        const codes = toFirmnessCodes(raw);
        const items = toMenuItems(raw);
        expect(codes.every(isValidFirmnessCode)).toBe(true);
        expect(items.every(isValidMenuItem)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  // Feature: pos-order-ingress, Property: 妥当な対応表は素通りする（JSON 文字列を経ても同一）
  // **Validates: Requirements 6.29, 6.32**
  it("Property: 妥当な対応表は生値のまま保たれる", () => {
    fc.assert(
      fc.property(fc.array(genFirmnessCode), fc.array(genMenuItem), (codes, items) => {
        expect(toFirmnessCodes(codes)).toEqual(codes);
        expect(toMenuItems(items)).toEqual(items);
        // 投入経路は env の JSON 文字列も取る（既存 to* と同形）。表現を跨いでも同じ表が立つ。
        expect(toFirmnessCodes(JSON.stringify(codes))).toEqual(codes);
        expect(toMenuItems(JSON.stringify(items))).toEqual(items);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: pos-order-ingress, Property: 不正な要素だけが落ち、妥当な要素を巻き込まない
  // **Validates: Requirements 6.30, 6.31, 6.32**
  //
  // 対応表は「関心事ごとに分けた 1 枚ごとが単一の出所」である。1 件の投入ミスで表が丸ごと空へ落ちれば、
  // 茹で対象が静かに 0 件になる。ゆえに畳む単位は要素であって表ではない。
  it("Property: 妥当な要素と不正な要素が混ざっても、妥当な要素だけが順序を保って残る", () => {
    fc.assert(
      fc.property(
        fc.array(genFirmnessCode, { minLength: 1, maxLength: 4 }),
        fc.array(genInvalidFirmnessCode, { minLength: 1, maxLength: 4 }),
        fc.array(genMenuItem, { minLength: 1, maxLength: 4 }),
        fc.array(genInvalidMenuItem, { minLength: 1, maxLength: 4 }),
        (codes, junkCodes, items, junkItems) => {
          expect(toFirmnessCodes([...junkCodes, ...codes, ...junkCodes])).toEqual(codes);
          expect(toMenuItems([...junkItems, ...items, ...junkItems])).toEqual(items);
          // 不正だけなら空になる（既定そのものが空ゆえ「1 件も妥当でない」と「未投入」は同じ状態）。
          expect(toFirmnessCodes(junkCodes)).toEqual(DEFAULT_FIRMNESS_CODES);
          expect(toMenuItems(junkItems)).toEqual(DEFAULT_MENU_ITEMS);
        },
      ),
      { numRuns: 200 },
    );
  });
});
