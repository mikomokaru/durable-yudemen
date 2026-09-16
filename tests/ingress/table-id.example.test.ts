// tests/ingress/table-id.example.test.ts — 上流の `table_no` の読み方を固定する。
//
// **Validates: pos-order-ingress R6.26**
//
// 主張は 1 つ。**`1` は卓ではない。** 上流の POS は卓が特定できない受注（券売機・カウンター・
// 持ち帰り）に既定値を入れて送る。実在の卓として読むと、店の全注文が 1 つの Table_Group に
// 畳まれ、同卓同時提供の項が**互いに無関係な杯を揃えようとする**——実データは全行が `1` なので
// 誤読は全局面に及ぶ（2026-09-13 に実測で判明・総費用の 28% が架空の圧力だった）。
//
// **番兵は取り込みで消す。** ここで `null` へ正規化するので、下流（DO・engine・評価器）は
// 誰も番兵値を知らない。知る場所が 2 つ以上あれば、片方だけが直されて黙ってずれる。
import { describe, expect, it } from "vitest";
import { toTableId } from "../../src/ingress/table-id";

describe("payload.table_no の読み方", () => {
  it("**`1` は卓ではない**（卓が分からない受注の既定値）", () => {
    expect(toTableId(1)).toBeNull();
    expect(toTableId("1")).toBeNull();
  });

  it("`0` と欠落も同じく卓なし", () => {
    expect(toTableId(0)).toBeNull();
    expect(toTableId("0")).toBeNull();
    expect(toTableId(undefined)).toBeNull();
    expect(toTableId(null)).toBeNull();
  });

  it("実在の卓はそのまま読む（数値でも文字列でも同じ識別子へ）", () => {
    expect(toTableId(2)).toBe("2");
    expect(toTableId("2")).toBe("2");
    expect(toTableId("A-3")).toBe("A-3");
  });

  it('**番兵の判定は文字列化のあと**——数値の 1 と文字列の "1" で扱いが分かれない', () => {
    expect(toTableId(1)).toBe(toTableId("1"));
    expect(toTableId(0)).toBe(toTableId("0"));
  });
});
