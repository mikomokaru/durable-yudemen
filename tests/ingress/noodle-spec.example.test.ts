// tests/ingress/noodle-spec.example.test.ts — 品目 1 件の解釈の example test。
//
// property test（noodle-spec.property.test.ts）が判定と翻訳の同値性を面で押さえるのに対し、ここでは
// 4 つの境界を点で固定する——`child_items` の位置に依らないこと、硬さの指定が無ければ既定へ畳むこと、
// 対応表が空なら常に茹でないこと、`item_type` が判定に関与しないこと。
//
// **実データの完全な形は手元に無い。** 判明している商品コード（親品目 11421＝特味噌ネギラーメン・
// 116051＝新プレ塩、麺量 19401＝普通・19603＝大盛、硬さ 10010＝かため・10011＝ふつう）と `child_items` の
// 形だけを用い、5 品目（麺 2 件・非麺 3 件）の注文として構造を模した。対応表の値（`[Q8]`）が提示された
// 時点で、この lookup を実値へ差し替える。

import { describe, expect, it } from "vitest";
import type { NonEmptyArray } from "../../src/domain/timer";
import type { NoodleSize } from "../../src/domain/store";
import { toNoodleSpec, type NoodleLookup } from "../../src/ingress/noodle-spec";

/** 判明している商品コードで組んだ対応表。値の正本は店舗設定であり、ここは形の固定に用いる。 */
const lookup: NoodleLookup = {
  firmnessCodes: [
    { code: 10_010, firmness: "hard" },
    { code: 10_011, firmness: "normal" },
  ],
  menuItems: [
    {
      productCode: 11_421,
      noodleType: "Medium",
      sizes: [
        { code: 19_401, slotSpan: 1 },
        { code: 19_603, slotSpan: 2 },
      ] as NonEmptyArray<NoodleSize>,
    },
    {
      productCode: 116_051,
      noodleType: "Thin",
      sizes: [{ code: 19_401, slotSpan: 1 }] as NonEmptyArray<NoodleSize>,
    },
  ],
};

describe("ingress/noodle-spec — 麺量の有無が茹で対象を決める", () => {
  it("実データの形を模した 5 品目で、茹で対象が麺 2 件・非麺 3 件になる（AC 6.21・6.22）", () => {
    const orderItems: readonly Record<string, unknown>[] = [
      // 麺 1: 特味噌ネギラーメン（普通・かため）。油の量の指定は写さない（AC 6.33）。
      {
        plu_no: 11_421,
        item_type: 1,
        qty: 1,
        child_items: [
          { plu_no: 19_401, s_class_code: 65 },
          { plu_no: 10_010, s_class_code: 66 },
          { plu_no: 90_001, s_class_code: 67 },
        ],
      },
      // 麺 2: 新プレ塩（普通・硬さの指定なし）。
      {
        plu_no: 116_051,
        item_type: 1,
        qty: 1,
        child_items: [{ plu_no: 19_401, s_class_code: 65 }],
      },
      // 非麺 1: 餃子（child_items を持たない）。
      { plu_no: 20_001, item_type: 1, qty: 1 },
      // 非麺 2: 丼（トッピングの指定だけを持つ——麺量ではない）。
      { plu_no: 20_002, item_type: 1, qty: 1, child_items: [{ plu_no: 90_002, s_class_code: 70 }] },
      // 非麺 3: 飲料（child_items が空）。
      { plu_no: 20_003, item_type: 2, qty: 1, child_items: [] },
    ];

    const specs = orderItems.map((orderItem) => toNoodleSpec(orderItem, lookup));

    expect(specs).toEqual([
      { noodleType: "Medium", firmness: "hard", slotSpan: 1, sizeName: null },
      { noodleType: "Thin", firmness: "normal", slotSpan: 1, sizeName: null },
      null,
      null,
      null,
    ]);
    expect(specs.filter((spec) => spec !== null)).toHaveLength(2);
  });

  it("大盛の麺量は slotSpan を 2 にし、茹で加減は変えない（AC 6.24）", () => {
    const spec = toNoodleSpec(
      { plu_no: 11_421, child_items: [{ plu_no: 19_603 }, { plu_no: 10_011 }] },
      lookup,
    );
    expect(spec).toEqual({ noodleType: "Medium", firmness: "normal", slotSpan: 2, sizeName: null });
  });
});

describe("ingress/noodle-spec — 判定が依らないもの", () => {
  it("child_items の位置を入れ替えても結果が変わらない（AC 6.20）", () => {
    const forward = toNoodleSpec(
      { plu_no: 11_421, child_items: [{ plu_no: 19_603 }, { plu_no: 10_010 }, { plu_no: 90_003 }] },
      lookup,
    );
    const reversed = toNoodleSpec(
      { plu_no: 11_421, child_items: [{ plu_no: 90_003 }, { plu_no: 10_010 }, { plu_no: 19_603 }] },
      lookup,
    );
    expect(reversed).toEqual(forward);
    expect(forward).toEqual({
      noodleType: "Medium",
      firmness: "hard",
      slotSpan: 2,
      sizeName: null,
    });
  });

  it("s_class_code の値に依らない（軸の識別は商品コードで行う・AC 6.20）", () => {
    const withClassCode = toNoodleSpec(
      { plu_no: 11_421, child_items: [{ plu_no: 19_401, s_class_code: 65 }] },
      lookup,
    );
    const withoutClassCode = toNoodleSpec(
      { plu_no: 11_421, child_items: [{ plu_no: 19_401 }] },
      lookup,
    );
    const withOtherClassCode = toNoodleSpec(
      { plu_no: 11_421, child_items: [{ plu_no: 19_401, s_class_code: 999 }] },
      lookup,
    );
    expect(withoutClassCode).toEqual(withClassCode);
    expect(withOtherClassCode).toEqual(withClassCode);
  });

  it("item_type を変えても結果が変わらない（AC 6.23）", () => {
    const child_items = [{ plu_no: 19_401 }, { plu_no: 10_010 }];
    const expected = { noodleType: "Medium", firmness: "hard", slotSpan: 1, sizeName: null };
    for (const item_type of [0, 1, 2, 9]) {
      expect(toNoodleSpec({ plu_no: 11_421, item_type, child_items }, lookup)).toEqual(expected);
    }
    // 麺量を持たない品目は item_type が何であれ茹でない（判定基準は麺量の有無ただ一つ）。
    for (const item_type of [0, 1, 2, 9]) {
      expect(toNoodleSpec({ plu_no: 20_001, item_type, child_items: [] }, lookup)).toBeNull();
    }
  });

  it("qty が 2 以上でも 1 品目 1 件の解釈は変わらない（AC 6.35）", () => {
    const single = toNoodleSpec(
      { plu_no: 11_421, qty: 1, child_items: [{ plu_no: 19_401 }] },
      lookup,
    );
    const multiple = toNoodleSpec(
      { plu_no: 11_421, qty: 3, child_items: [{ plu_no: 19_401 }] },
      lookup,
    );
    expect(multiple).toEqual(single);
  });
});

describe("ingress/noodle-spec — 硬さの既定と空の対応表", () => {
  it("硬さの指定が無い品目は normal へ畳む（POS が指定を送っていない入力の形に対する既定）", () => {
    const spec = toNoodleSpec({ plu_no: 11_421, child_items: [{ plu_no: 19_401 }] }, lookup);
    expect(spec?.firmness).toBe("normal");
  });

  it("対応表に無い硬さコードは指定として解釈せず normal へ畳む", () => {
    const spec = toNoodleSpec(
      { plu_no: 11_421, child_items: [{ plu_no: 19_401 }, { plu_no: 10_099 }] },
      lookup,
    );
    expect(spec?.firmness).toBe("normal");
  });

  it("対応表が空なら常に茹でない（茹で対象が 0 件になるだけで構造は成立する・[Q8]）", () => {
    const empty: NoodleLookup = { firmnessCodes: [], menuItems: [] };
    const orderItems: readonly Record<string, unknown>[] = [
      { plu_no: 11_421, child_items: [{ plu_no: 19_401 }, { plu_no: 10_010 }] },
      { plu_no: 116_051, child_items: [{ plu_no: 19_603 }] },
      { plu_no: 20_001, child_items: [] },
      {},
    ];
    for (const orderItem of orderItems) {
      expect(toNoodleSpec(orderItem, empty)).toBeNull();
    }
  });

  it("硬さ表だけが空でも麺量の解釈は成立する（既定の茹で加減へ畳む）", () => {
    const withoutFirmnessTable: NoodleLookup = { firmnessCodes: [], menuItems: lookup.menuItems };
    const spec = toNoodleSpec(
      { plu_no: 11_421, child_items: [{ plu_no: 19_401 }, { plu_no: 10_010 }] },
      withoutFirmnessTable,
    );
    expect(spec).toEqual({ noodleType: "Medium", firmness: "normal", slotSpan: 1, sizeName: null });
  });
});

describe("ingress/noodle-spec — 素通し原則（想定外の形で例外を投げない）", () => {
  it("child_items が配列でない・要素が想定外の形でも例外を投げず、麺量が無いものとして扱う", () => {
    const malformed: readonly Record<string, unknown>[] = [
      { plu_no: 11_421 },
      { plu_no: 11_421, child_items: null },
      { plu_no: 11_421, child_items: "19401" },
      { plu_no: 11_421, child_items: [null, "19401", 19_401, {}] },
      { plu_no: 11_421, child_items: [{ plu_no: "19401" }] },
      { plu_no: "11421", child_items: [{ plu_no: 19_401 }] },
      { plu_no: null, child_items: [{ plu_no: 19_401 }] },
      {},
    ];
    for (const orderItem of malformed) {
      expect(toNoodleSpec(orderItem, lookup)).toBeNull();
    }
  });

  it("未知フィールドが混ざっても解釈は変わらない（Pass_Through）", () => {
    const plain = toNoodleSpec({ plu_no: 11_421, child_items: [{ plu_no: 19_401 }] }, lookup);
    const noisy = toNoodleSpec(
      {
        plu_no: 11_421,
        child_items: [{ plu_no: 19_401, vendor_extra: { nested: true } }],
        oil_amount: 3,
        taste_strength: "rich",
        unknown_field: [1, 2, 3],
      },
      lookup,
    );
    expect(noisy).toEqual(plain);
  });
});
