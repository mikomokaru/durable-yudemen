// tests/core/store-config-lookups.example.test.ts — POS の対応表 2 枚の境界を固定する回帰テスト。
//
// 固定するのは 2 点。「サイズ 0 個のメニュー」が構築されないこと（茹でるのか茹でないのか判らない状態を
// 表現可能にしない）と、玉数の値域（PORTIONS_MIN〜PORTIONS_MAX・0.5 刻み）が境界ちょうどで切れること。
// 値域外をクランプで寄せないのは、投入されていない対応（この商品コードは何玉か）を作らないためである。

import { describe, expect, it } from "vitest";
import { PORTIONS_MAX, PORTIONS_MIN, toFirmnessCodes, toMenuItems } from "../../src/domain/store";

/** 実データの帯に合わせた麺量 1 件（「普通」19401）。 */
function size(portions: number) {
  return { code: 19_401, portions };
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
    expect(toMenuItems([menu([size(0), { code: 0, portions: 1 }])])).toEqual([]);
  });

  it("一部の麺量が不正なら、その麺量だけが落ちてメニューは残る", () => {
    expect(toMenuItems([menu([size(0), size(1)])])).toEqual([
      { productCode: 11_421, noodleType: "Thin", sizes: [size(1)] },
    ]);
  });
});

describe("toMenuItems — 玉数の値域", () => {
  it("境界ちょうど（0.5 と 9）と半玉刻みは通る", () => {
    const sizes = [
      size(PORTIONS_MIN),
      { code: 19_402, portions: 1.5 },
      { code: 19_603, portions: PORTIONS_MAX },
    ];
    expect(toMenuItems([menu(sizes)])).toEqual([
      { productCode: 11_421, noodleType: "Thin", sizes },
    ]);
  });

  it("0・負値・上限超過・刻み外・非数はクランプせず拒否する", () => {
    for (const portions of [
      0,
      -1,
      PORTIONS_MAX + 0.5,
      1.25,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(toMenuItems([menu([size(portions)])])).toEqual([]);
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
