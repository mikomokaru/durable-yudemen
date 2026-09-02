// tests/ingress/noodle-spec.property.test.ts — 品目 1 件の解釈（src/ingress/noodle-spec.ts）の property test。
//
// Property 4: 判定と翻訳は同じ入力から導かれる。
//   toNoodleSpec が非 null を返すことと、当該品目が麺量の商品コードを持つことは同値である。ゆえに
//   「茹で対象でありながら slotSpan が定まらない」状態も「茹でないのに slotSpan が定まる」状態も存在しない。
//   同値性の右辺（麺量コードを持つか）はテスト側で入力から独立に導く——実装を呼び直せば同値ではなく
//   同一の言い換えになり、何も検証しない。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FIRMNESS_ORDER, type Firmness } from "../../src/domain/firmness";
import { isNonEmpty, type NonEmptyArray } from "../../src/domain/timer";
import {
  SLOT_SPAN_MAX,
  SLOT_SPAN_MIN,
  type FirmnessCode,
  type MenuItem,
  type NoodleSize,
} from "../../src/domain/store";
import { toNoodleSpec, type NoodleLookup } from "../../src/ingress/noodle-spec";

// 商品コードの帯を軸ごとに分けて生成する（実データの帯に倣う——硬さは 10010 台、麺量は 19000 台、
// 親品目は 11000 台）。帯を分けるのは、同一コードが 2 つの軸を同時に指す状態が実在しないためである。
const genFirmnessCodeValue = fc.integer({ min: 10_000, max: 10_099 });
const genSizeCodeValue = fc.integer({ min: 19_000, max: 19_999 });
const genProductCodeValue = fc.integer({ min: 11_000, max: 11_999 });
/** どの軸にも属さないコード（油の量・味の濃さ・トッピングの指定がここに落ちる）。 */
const genUnrelatedCodeValue = fc.integer({ min: 90_000, max: 99_999 });

const genFirmness: fc.Arbitrary<Firmness> = fc.constantFrom(...FIRMNESS_ORDER);

const genFirmnessCodes: fc.Arbitrary<readonly FirmnessCode[]> = fc.uniqueArray(
  fc.record({ code: genFirmnessCodeValue, firmness: genFirmness }),
  { selector: (entry) => entry.code, maxLength: 4 },
);

const genNoodleSizes: fc.Arbitrary<NonEmptyArray<NoodleSize>> = fc
  .uniqueArray(
    fc.record({
      code: genSizeCodeValue,
      slotSpan: fc.integer({ min: SLOT_SPAN_MIN, max: SLOT_SPAN_MAX }),
    }),
    { selector: (size) => size.code, minLength: 1, maxLength: 3 },
  )
  // sizes は型で非空（麺量を持たない品目は茹でないため MenuItem は必ず 1 つ以上のサイズを持つ）。
  .map((sizes) =>
    isNonEmpty(sizes) ? sizes : ([{ code: 19_401, slotSpan: 1 }] as NonEmptyArray<NoodleSize>),
  );

const genMenuItems: fc.Arbitrary<readonly MenuItem[]> = fc.uniqueArray(
  fc.record({
    productCode: genProductCodeValue,
    noodleType: fc.constantFrom("Thin", "Medium", "Thick"),
    sizes: genNoodleSizes,
  }),
  { selector: (menuItem) => menuItem.productCode, maxLength: 4 },
);

const genLookup: fc.Arbitrary<NoodleLookup> = fc.record({
  firmnessCodes: genFirmnessCodes,
  menuItems: genMenuItems,
});

/**
 * 品目 1 件。`child_items` には 4 帯（麺量・硬さ・無関係・非数値）を混ぜ、`item_type` / `qty` /
 * `s_class_code` / 余剰フィールドも載せる（判定がこれらに依らないことを面で押さえる）。
 */
const genOrderItem: fc.Arbitrary<Record<string, unknown>> = fc.record({
  plu_no: fc.oneof(genProductCodeValue, genUnrelatedCodeValue, fc.constant(null), fc.string()),
  item_type: fc.integer({ min: 0, max: 9 }),
  qty: fc.integer({ min: 1, max: 3 }),
  child_items: fc.array(
    fc.oneof(
      fc.record({ plu_no: genSizeCodeValue, s_class_code: fc.integer({ min: 0, max: 99 }) }),
      fc.record({ plu_no: genFirmnessCodeValue, s_class_code: fc.integer({ min: 0, max: 99 }) }),
      fc.record({ plu_no: genUnrelatedCodeValue, s_class_code: fc.integer({ min: 0, max: 99 }) }),
      // 素通し原則の面（想定外の形の要素は無視され、Record の拒否事由にならない）。
      fc.record({ plu_no: fc.string() }),
      fc.constant(null),
      fc.string(),
    ),
    { maxLength: 5 },
  ),
});

describe("ingress/noodle-spec — 判定と翻訳", () => {
  // Feature: pos-order-ingress, Property 4: 判定と翻訳は同じ入力から導かれる
  // **Validates: Requirements 6.21, 6.22, 6.24**
  it("Property 4: 非 null を返すことと麺量コードを持つことが同値である", () => {
    fc.assert(
      fc.property(genOrderItem, genLookup, (orderItem, lookup) => {
        const spec = toNoodleSpec(orderItem, lookup);
        expect(spec !== null).toBe(hasNoodleSizeCode(orderItem, lookup));
      }),
      { numRuns: 1000 },
    );
  });

  // Feature: pos-order-ingress, Property 4: 判定と翻訳は同じ入力から導かれる
  // **Validates: Requirements 6.21, 6.24**
  it("Property 4: 茹で対象なら slotSpan が必ず定まり、当該メニューの麺量が定めた値に一致する", () => {
    fc.assert(
      fc.property(genOrderItem, genLookup, (orderItem, lookup) => {
        const spec = toNoodleSpec(orderItem, lookup);
        if (spec === null) return;
        // 「茹で対象でありながら slotSpan が定まらない」状態が存在しないことの表明。
        expect(Number.isInteger(spec.slotSpan)).toBe(true);
        expect(spec.slotSpan).toBeGreaterThanOrEqual(SLOT_SPAN_MIN);
        expect(spec.slotSpan).toBeLessThanOrEqual(SLOT_SPAN_MAX);
        // 値の出所は当該品目の麺量ただ一つである（推測で埋めていない）。
        expect(designatedSlotSpans(orderItem, lookup)).toContain(spec.slotSpan);
        expect(designatedNoodleTypes(orderItem, lookup)).toContain(spec.noodleType);
      }),
      { numRuns: 1000 },
    );
  });

  // Feature: pos-order-ingress, Property 4: 判定と翻訳は同じ入力から導かれる
  // **Validates: Requirements 6.22, 6.24**
  it("Property 4: 茹でない品目は slotSpan を一切持たない（null のみを返す）", () => {
    fc.assert(
      fc.property(genOrderItem, genLookup, (orderItem, lookup) => {
        if (hasNoodleSizeCode(orderItem, lookup)) return;
        // 「茹でないのに slotSpan が定まる」状態が存在しないことの表明。null は幅を運べない。
        expect(toNoodleSpec(orderItem, lookup)).toBeNull();
      }),
      { numRuns: 1000 },
    );
  });

  // Feature: pos-order-ingress, Property 4: 判定と翻訳は同じ入力から導かれる
  // **Validates: Requirements 6.24**
  it("Property 4: 同一入力から常に同一の NoodleSpec を得る（決定的）", () => {
    fc.assert(
      fc.property(genOrderItem, genLookup, (orderItem, lookup) => {
        expect(toNoodleSpec(orderItem, lookup)).toEqual(toNoodleSpec(orderItem, lookup));
      }),
      { numRuns: 500 },
    );
  });
});

/**
 * 同値性の右辺——当該品目が麺量の商品コードを持つか。実装を呼ばず入力から独立に導く。
 *
 * 麺量は親メニューが定めるため、親商品コードが対応表に無い品目は麺量コードを 1 つも持ちえない。
 */
function hasNoodleSizeCode(orderItem: Record<string, unknown>, lookup: NoodleLookup): boolean {
  return designatedSlotSpans(orderItem, lookup).length > 0;
}

/** 当該品目に指定されている麺量の slotSpan を列挙する（0 件なら茹でない）。 */
function designatedSlotSpans(
  orderItem: Record<string, unknown>,
  lookup: NoodleLookup,
): readonly number[] {
  const menuItem = lookup.menuItems.find((item) => item.productCode === orderItem.plu_no);
  if (menuItem === undefined) return [];
  const childCodes = childProductCodes(orderItem);
  return menuItem.sizes
    .filter((size) => childCodes.includes(size.code))
    .map((size) => size.slotSpan);
}

/** 当該品目が茹で対象であるときの麺種（親メニューがただ 1 つ定める）。 */
function designatedNoodleTypes(
  orderItem: Record<string, unknown>,
  lookup: NoodleLookup,
): readonly string[] {
  return lookup.menuItems
    .filter((item) => item.productCode === orderItem.plu_no)
    .map((item) => item.noodleType);
}

/** `child_items` の各要素が運ぶ商品コードを列挙する（位置は捨てる）。 */
function childProductCodes(orderItem: Record<string, unknown>): readonly number[] {
  const children = orderItem.child_items;
  if (!Array.isArray(children)) return [];
  const codes: number[] = [];
  for (const child of children) {
    if (typeof child !== "object" || child === null) continue;
    const code = (child as Record<string, unknown>).plu_no;
    if (typeof code === "number") codes.push(code);
  }
  return codes;
}
