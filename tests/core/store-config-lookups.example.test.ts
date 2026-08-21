// tests/core/store-config-lookups.example.test.ts — POS の対応表 2 枚の境界を固定する回帰テスト。
//
// 固定するのは 2 点。「サイズ 0 個のメニュー」が構築されないこと（茹でるのか茹でないのか判らない状態を
// 表現可能にしない）と、slotSpan の値域（SLOT_SPAN_MIN〜SLOT_SPAN_MAX）が境界ちょうどで切れること。
// 値域外をクランプで寄せないのは、投入されていない対応（この商品コードは何スロット要るか）を作らないためである。

import { describe, expect, it } from "vitest";
import { SLOT_SPAN_MAX, SLOT_SPAN_MIN, toFirmnessCodes, toMenuItems } from "../../src/domain/store";

/** 実データの帯に合わせた麺量 1 件（「普通」19401）。 */
function size(slotSpan: number) {
  return { code: 19_401, slotSpan };
}

/** 麺量群だけを差し替えられるメニュー 1 件（親品目 11421 = 特味噌ネギラーメン）。 */
function menu(sizes: readonly unknown[]) {
  return { productCode: 11_421, noodleType: "Thin", sizes };
}

describe("toMenuItems — サイズ 0 個のメニューは立たない", () => {
  it("sizes が空配列のメニューは表へ載らない", () => {
    expect(toMenuItems([menu([])])).toEqual([]);
  });

  it("全ての麺量が不正なメニューは表へ載らない（残ったサイズが 0 個になる形を作らない）", () => {
    expect(toMenuItems([menu([size(0), { code: 0, slotSpan: 1 }])])).toEqual([]);
  });

  it("一部の麺量が不正なら、その麺量だけが落ちてメニューは残る", () => {
    expect(toMenuItems([menu([size(0), size(1)])])).toEqual([
      { productCode: 11_421, noodleType: "Thin", sizes: [size(1)] },
    ]);
  });
});

describe("toMenuItems — slotSpan の値域", () => {
  it("境界ちょうど（1 と 6）は通る", () => {
    const sizes = [size(SLOT_SPAN_MIN), { code: 19_603, slotSpan: SLOT_SPAN_MAX }];
    expect(toMenuItems([menu(sizes)])).toEqual([{ productCode: 11_421, noodleType: "Thin", sizes }]);
  });

  it("0・負値・上限超過・非整数はクランプせず拒否する", () => {
    for (const slotSpan of [0, -1, SLOT_SPAN_MAX + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(toMenuItems([menu([size(slotSpan)])])).toEqual([]);
    }
  });
});

describe("対応表の正規化", () => {
  it("余剰フィールドを落とす（設定へ混ぜ物を残さない）", () => {
    expect(toFirmnessCodes([{ code: 10_010, firmness: "hard", label: "かため" }])).toEqual([
      { code: 10_010, firmness: "hard" },
    ]);
    expect(toMenuItems([{ ...menu([{ ...size(1), name: "普通" }]), category: "ramen" }])).toEqual([
      { productCode: 11_421, noodleType: "Thin", sizes: [size(1)] },
    ]);
  });

  it("配列でない生値は既定（空の表）へ畳む", () => {
    for (const raw of [undefined, null, {}, "not-json", 0, true]) {
      expect(toFirmnessCodes(raw)).toEqual([]);
      expect(toMenuItems(raw)).toEqual([]);
    }
  });
});
