// tests/ingress/unique-key.example.test.ts — Unique_Key のエンコード規則を点で固定する example test。
//
// 規則の正本は上流の Python `urllib.parse.quote(value, safe="/")` である（design §2-a）。本経路が導く値は
// 上流の `seen:{unique_key}:{hash}` の `unique_key` 部と同一の文字列になり、障害時に上下流の突き合わせが
// できる（AC 6.2）。ゆえに `encodeURIComponent` との差分をここで固定する——あれは `! * ' ( )` を素通しし
// `/` を `%2F` へ写すため、上流と 6 文字で食い違う。

import { describe, expect, it } from "vitest";
import { toUniqueKey } from "../../src/ingress/unique-key";

/** 4 要素だけを差し替えるための土台（実データ形）。 */
function payloadWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    store_id: 1001,
    terminal_id: 41,
    bill_no: 7,
    datetime: "2026-08-17T20:52:19",
    ...overrides,
  };
}

describe("ingress/unique-key — 実データ形", () => {
  it("提示された実データ形の 4 要素から上流と同一の識別子を得る", () => {
    // 3 要素は数値で届き、`datetime` の `:` は `%3A` へ写る（`:` は無予約でも safe でもない）。
    expect(toUniqueKey(payloadWith())).toBe("1001:41:7:2026-08-17T20%3A52%3A19");
  });

  it("実データ形の範囲では encodeURIComponent と差が出ない", () => {
    const byEncodeURIComponent = ["1001", "41", "7", "2026-08-17T20:52:19"].map(encodeURIComponent).join(":");
    expect(toUniqueKey(payloadWith())).toBe(byEncodeURIComponent);
  });

  it("order_id を置換・削除しても識別子が変わらない（AC 6.3）", () => {
    const expected = "1001:41:7:2026-08-17T20%3A52%3A19";
    expect(toUniqueKey(payloadWith({ order_id: "A-0001" }))).toBe(expected);
    expect(toUniqueKey(payloadWith({ order_id: 99 }))).toBe(expected);
    expect(toUniqueKey(payloadWith({ order_id: null }))).toBe(expected);
    expect(toUniqueKey(payloadWith())).toBe(expected);
  });
});

describe("ingress/unique-key — 上流のエンコード規則（quote の safe='/'）", () => {
  it("`/` はエンコードしない（既定の safe）", () => {
    expect(toUniqueKey(payloadWith({ store_id: "a/b/c" }))).toBe("a/b/c:41:7:2026-08-17T20%3A52%3A19");
    // encodeURIComponent はここで食い違う（`%2F` へ写す）。
    expect(encodeURIComponent("a/b/c")).toBe("a%2Fb%2Fc");
  });

  it("`! * ' ( )` はエンコードする（encodeURIComponent は素通しする）", () => {
    expect(toUniqueKey(payloadWith({ terminal_id: "!*'()" }))).toBe("1001:%21%2A%27%28%29:7:2026-08-17T20%3A52%3A19");
    expect(encodeURIComponent("!*'()")).toBe("!*'()");
  });

  it("`~` はエンコードしない（Python 3.7 以降の quote は無予約文字として扱う）", () => {
    expect(toUniqueKey(payloadWith({ bill_no: "~" }))).toBe("1001:41:~:2026-08-17T20%3A52%3A19");
  });

  it("英数字と `- _ . ~` はそのまま通る", () => {
    expect(toUniqueKey(payloadWith({ store_id: "aZ09-_.~" }))).toBe("aZ09-_.~:41:7:2026-08-17T20%3A52%3A19");
  });

  it("それ以外は UTF-8 バイト列の大文字 16 進 `%XX` へ写る", () => {
    // 麺 = U+9EBA → E9 BA BA。小文字 16 進にしない（上流は大文字で出す）。
    expect(toUniqueKey(payloadWith({ store_id: "麺" }))).toBe("%E9%BA%BA:41:7:2026-08-17T20%3A52%3A19");
    // 空白は `+` ではなく `%20`（quote は quote_plus と違う）。
    expect(toUniqueKey(payloadWith({ terminal_id: "a b" }))).toBe("1001:a%20b:7:2026-08-17T20%3A52%3A19");
    // `%` 自身も写る（生の `%2F` が `/` に化けない）。
    expect(toUniqueKey(payloadWith({ bill_no: "%2F" }))).toBe("1001:41:%252F:2026-08-17T20%3A52%3A19");
  });

  it("要素内の `:` は `%3A` へ写り、区切りと混ざらない", () => {
    // 区切りの `:` はちょうど 3 つに保たれる（識別子の分解が一意である）。
    const key = toUniqueKey(payloadWith({ store_id: "a:b" })) as string;
    expect(key).toBe("a%3Ab:41:7:2026-08-17T20%3A52%3A19");
    expect(key.split(":").length - 1).toBe(3);
  });
});

describe("ingress/unique-key — 導出できない payload", () => {
  it("4 要素のいずれかが欠落・null なら null を返す（AC 6.18）", () => {
    for (const field of ["store_id", "terminal_id", "bill_no", "datetime"]) {
      const missing = payloadWith();
      delete missing[field];
      expect(toUniqueKey(missing)).toBeNull();
      expect(toUniqueKey(payloadWith({ [field]: null }))).toBeNull();
    }
  });

  it("空文字は読み出せない値として null を返す（AC 14.5）", () => {
    expect(toUniqueKey(payloadWith({ store_id: "" }))).toBeNull();
    // 0 は空文字にならないため受理される（数値の 0 を欠落と読み替えない）。
    expect(toUniqueKey(payloadWith({ bill_no: 0 }))).toBe("1001:41:0:2026-08-17T20%3A52%3A19");
  });

  it('有限でない数値は読み出せない（"NaN" を識別子の一部にしない）', () => {
    expect(toUniqueKey(payloadWith({ bill_no: Number.NaN }))).toBeNull();
    expect(toUniqueKey(payloadWith({ terminal_id: Number.POSITIVE_INFINITY }))).toBeNull();
  });

  it("文字列と数値はどちらの要素でも同一の関門を通る（Pass_Through・Requirement 14）", () => {
    // 実データは `bill_no` が数値・`datetime` が文字列で届くが、要素ごとに規則を変えない。
    expect(toUniqueKey(payloadWith({ bill_no: "7" }))).toBe("1001:41:7:2026-08-17T20%3A52%3A19");
    expect(toUniqueKey(payloadWith({ datetime: 20260817 }))).toBe("1001:41:7:20260817");
    expect(toUniqueKey(payloadWith({ store_id: "1001" }))).toBe("1001:41:7:2026-08-17T20%3A52%3A19");
  });

  it("オブジェクト・配列・真偽値は読み出せず毒になる（Store_Code の読み出しと同一の規則）", () => {
    // Pass_Through は payload の中身を拒否事由にしない原則だが、Unique_Key の 4 要素は「処理を進める
    // ために要る構造」であり AC 6.18 が既に例外として定めている。ここは AC の文言（欠落・null・文字列化
    // した結果が空文字）より厳しい側へ寄せた判断である——`[object Object]` や `"true"` を識別子・宛先と
    // して成立させれば、原因が「宛先未登録の 2 時間保留」に化けて失効とともに消える。毒として扱えば
    // `poisonRecord` のカウンタと診断ログに残り、観測できる。
    expect(toUniqueKey(payloadWith({ terminal_id: true }))).toBeNull();
    expect(toUniqueKey(payloadWith({ store_id: {} }))).toBeNull();
    expect(toUniqueKey(payloadWith({ bill_no: [] }))).toBeNull();
    expect(toUniqueKey(payloadWith({ bill_no: [7] }))).toBeNull();
  });
});
