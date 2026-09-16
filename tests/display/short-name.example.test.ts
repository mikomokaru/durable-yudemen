// tests/display/short-name.example.test.ts — 札の関門の例テスト。
//
// 復号（`toShortNameCandidate`）が `null` を返す各分岐と、検査（`toShortName`）の境界を、実データの名前で踏む。
// 架空の商品名（`プレ塩` / `ﾈｷﾞ丼` / `特盛` / `かけ`）は使わない——それらは実データに存在せず、
// 本 spec のテストは実在する名前だけで書く（requirements の作業項目）。

import { describe, expect, it } from "vitest";
import { toShortName, toShortNameCandidate } from "../../src/display/short-name";

/** 正しい形の応答（OpenAI 形）。`content` は JSON schema を指定していても文字列で返る。 */
const response = (content: unknown): unknown => ({
  choices: [{ index: 0, message: { role: "assistant", content } }],
});

describe("応答の復号", () => {
  it("正しい形から札の候補を取り出す", () => {
    expect(toShortNameCandidate(response(JSON.stringify({ short: "特味噌ネギ" })))).toBe(
      "特味噌ネギ",
    );
  });

  it("content が null なら候補なし", () => {
    expect(toShortNameCandidate(response(null))).toBeNull();
  });

  it("refusal が付いた応答は候補なし（content が null になる）", () => {
    const refused = {
      choices: [
        { index: 0, message: { role: "assistant", content: null, refusal: "I cannot comply." } },
      ],
    };
    expect(toShortNameCandidate(refused)).toBeNull();
  });

  it("content が JSON として壊れていれば候補なし", () => {
    expect(toShortNameCandidate(response('{"short": '))).toBeNull();
  });

  it("content がオブジェクトを指さなければ候補なし", () => {
    expect(toShortNameCandidate(response('"特味噌ネギ"'))).toBeNull();
  });

  it("short が文字列でなければ候補なし", () => {
    expect(toShortNameCandidate(response(JSON.stringify({ short: 5 })))).toBeNull();
  });

  it("choices が空・欠落なら候補なし", () => {
    expect(toShortNameCandidate({ choices: [] })).toBeNull();
    expect(toShortNameCandidate({})).toBeNull();
  });

  it("応答そのものが非オブジェクトなら候補なし", () => {
    expect(toShortNameCandidate(null)).toBeNull();
    expect(toShortNameCandidate("特味噌ネギ")).toBeNull();
  });

  it("`{ response: ... }` の形は候補なし（Workers AI は OpenAI 形で返す）", () => {
    expect(toShortNameCandidate({ response: { short: "特味噌ネギ" } })).toBeNull();
  });
});

describe("札の検査", () => {
  it("元名から削った候補を通す", () => {
    expect(toShortName("特味噌ネギ", "特味噌ネギラーメン")).toBe("特味噌ネギ");
    expect(toShortName("特ネギチャ", "特味噌ネギチャー")).toBe("特ネギチャ");
    expect(toShortName("特味噌ラA", "特味噌ラーメンAセット")).toBe("特味噌ラA");
  });

  it("半角カナの候補は正規化して通し、**正規化後の札**を返す", () => {
    // 生は 9 コードポイントで、生のままでは元名の部分列でもない。真偽値を返す関門ではこれを
    // 生のまま保存できてしまう（design Component 2）。
    expect(toShortName("特味噌ﾈｷﾞﾗｰﾒ", "特味噌ネギラーメン")).toBe("特味噌ネギラーメ");
  });

  it("半角カナの元名も正規化して突き合わせる", () => {
    expect(toShortName("旨辛スタミナ", "旨辛ｽﾀﾐﾅﾗｰﾒﾝ")).toBe("旨辛スタミナ");
  });

  it("境界：8 字は通り、9 字は落ちる", () => {
    expect(toShortName("特味噌ネギラーメ", "特味噌ネギラーメン")).toBe("特味噌ネギラーメ");
    expect(toShortName("特味噌ネギラーメン", "特味噌ネギラーメン")).toBeNull();
  });

  it("空文字は落ちる", () => {
    expect(toShortName("", "特味噌ネギラーメン")).toBeNull();
  });

  it("元名に無い文字を含む候補は落ちる（これが取り違えを潰す芯）", () => {
    expect(toShortName("醤油ネギ", "特味噌ネギラーメン")).toBeNull();
    expect(toShortName("特味噌🍜", "特味噌ネギラーメン")).toBeNull();
  });

  it("**並び替えた候補は通る**（セット種別を先頭へ動かす形が要る・判断 33）", () => {
    expect(toShortName("ネギ特味噌", "特味噌ネギラーメン")).toBe("ネギ特味噌");
    expect(toShortName("A味噌", "味噌ラーメンAセット")).toBe("A味噌");
  });

  it("同じ文字を元名にある回数より多く使う候補は落ちる（多重度を数える）", () => {
    // `特` は元名に 1 つしかない。
    expect(toShortName("特特味噌", "特味噌ネギラーメン")).toBeNull();
  });

  it("一意性は検査しない——別の商品と同じ札になる候補もそのまま通る", () => {
    // `特味噌ラーメン` は 7 字ゆえ plain（全名表示）だが、関門はそれを知らない。
    // 衝突の許容は設計の判断であり、ここで拒めば退けたはずの保証を要求することになる。
    expect(toShortName("特味噌ラーメン", "特味噌ラーメンAセット")).toBe("特味噌ラーメン");
  });
});
