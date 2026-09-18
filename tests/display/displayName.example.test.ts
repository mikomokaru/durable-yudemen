// tests/display/displayName.example.test.ts — 表示名の組み立て（`displayName`）。
//
// _Validates: item-display-abbreviation Requirements 1.1〜1.10_
//
// 実データの商品名で踏む（`docs/data_samples/` の distinct 48 件から）。架空の名前（`プレ塩` / `ﾈｷﾞ丼` /
// `特盛` / `かけ`）は使わない——本 spec のテストは実在する名前だけで書く。
//
// 芯は 1 つ。**札はサーバが品目へ被せて送るもので、client は辞書を持たない。** 引数は品目 1 つだけであり、
// `shortName` が無ければ本 spec 以前と同じ全名が返る。札は上書きであって前提ではない。

import { describe, expect, it } from "vitest";
import { displayName, portionsLabel } from "../../src/client/components/queueDisplay";
import type { WireOrderItem } from "../../src/domain/order";

function item(fields: Partial<WireOrderItem>): WireOrderItem {
  return {
    externalOrderId: "o-1",
    itemIndex: 0,
    noodleType: "REG",
    firmness: "normal",
    tableId: "12",
    arrivalTime: 1_789_000_000_000,
    portions: 1,
    itemName: null,
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
    tableAssignedAt: null,
    ...fields,
  };
}

describe("商品名の位置", () => {
  it("品目が札を持てばそれを置く", () => {
    const order = item({ itemName: "特味噌ネギラーメン", shortName: "特味噌ネギ" });
    expect(displayName(order)).toBe("特味噌ネギ 1玉");
  });

  it("札を持たなければ全名を置く", () => {
    const order = item({ itemName: "辛味噌ネギラーメン" });
    expect(displayName(order)).toBe("辛味噌ネギラーメン 1玉");
  });

  it("札が無いときの申告名は NFKC 正規化して置く", () => {
    const order = item({ itemName: "旨辛ｽﾀﾐﾅﾗｰﾒﾝ" });
    expect(displayName(order)).toBe("旨辛スタミナラーメン 1玉");
  });

  it("申告名が null なら麺種名で代替する（札は付かない）", () => {
    expect(displayName(item({ itemName: null }))).toBe("REG 1玉");
  });

  it("異なる品目が同じ札を持っていても扱いを変えない（一意性を前提にしない）", () => {
    const a = item({ itemName: "特味噌ネギラーメン", shortName: "特味噌" });
    const b = item({ itemName: "特味噌チャーシュー", shortName: "特味噌" });
    expect(displayName(a)).toBe("特味噌 1玉");
    expect(displayName(b)).toBe("特味噌 1玉");
  });
});

describe("麺量", () => {
  it("`普通` は区切りごと消える（実データの 61.7%）", () => {
    const order = item({
      itemName: "特味噌ネギラーメン",
      shortName: "特味噌ネギ",
      sizeName: "普通",
    });
    expect(displayName(order)).toBe("特味噌ネギ 1玉");
    // 末尾に空白が残らないこと（卓番との間隔が品目によってずれる）。
    expect(displayName(order)).not.toMatch(/\s$/);
  });

  it("`中盛` / `大盛` / `半玉` は語のまま出し、区切りを置かない", () => {
    const base = { itemName: "特味噌ネギラーメン", shortName: "特味噌ネギ" };
    expect(displayName(item({ ...base, sizeName: "中盛", portions: 1.5 }))).toBe(
      "特味噌ネギ中盛 1.5玉",
    );
    expect(displayName(item({ ...base, sizeName: "大盛", portions: 2 }))).toBe(
      "特味噌ネギ大盛 2玉",
    );
    expect(displayName(item({ ...base, sizeName: "半玉", portions: 0.5 }))).toBe(
      "特味噌ネギ半玉 0.5玉",
    );
  });

  it("札が無くても麺量は語のまま付く（2 つの軸は独立している）", () => {
    const order = item({ itemName: "辛味噌ネギラーメン", sizeName: "大盛" });
    expect(displayName(order)).toBe("辛味噌ネギラーメン大盛 1玉");
  });

  it("表に無い麺量は空白区切りで添える（表に在る語だけが区切り無しで付く）", () => {
    // 区切りの有無が「表に在る語か」を示す。知らない値を区切り無しで繋ぐと、品名の一部に見える。
    const order = item({
      itemName: "特味噌ネギラーメン",
      shortName: "特味噌ネギ",
      sizeName: "特盛",
    });
    expect(displayName(order)).toBe("特味噌ネギ 特盛 1玉");
  });

  it("麺量の申告が null なら語は添えず、玉数だけが付く", () => {
    const order = item({ itemName: "特味噌ネギラーメン", shortName: "特味噌ネギ", sizeName: null });
    expect(displayName(order)).toBe("特味噌ネギ 1玉");
  });
});

describe("玉数の札（noodle-portions 判断 7）", () => {
  it("整数は小数点なし、半端は 1 桁、単位は「玉」", () => {
    expect(portionsLabel(1)).toBe("1玉");
    expect(portionsLabel(2)).toBe("2玉");
    expect(portionsLabel(1.5)).toBe("1.5玉");
    expect(portionsLabel(0.5)).toBe("0.5玉");
    expect(portionsLabel(2.5)).toBe("2.5玉");
  });

  it("玉数は麺量の語と独立に、常に末尾へ空白区切りで付く", () => {
    // つけ麺の中盛は 2 玉——語（中盛）だけでは釜へ落とす量が読めない（麺種で玉数が違う）。
    const order = item({ itemName: "つけ麺", sizeName: "中盛", portions: 2 });
    expect(displayName(order)).toBe("つけ麺中盛 2玉");
  });
});

describe("セットと本体", () => {
  it("札があれば区別が付く", () => {
    const set = item({ itemName: "特味噌ラーメンAセット", shortName: "特味噌ラA" });
    expect(displayName(set)).toBe("特味噌ラA 1玉");
  });

  it("札が無い側は全名のまま（混在しても表示は成立する）", () => {
    expect(displayName(item({ itemName: "特味噌ラーメン" }))).toBe("特味噌ラーメン 1玉");
  });
});
