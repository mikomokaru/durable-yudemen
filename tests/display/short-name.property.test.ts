// tests/display/short-name.property.test.ts — 札の関門（src/display/short-name.ts）の property test。
//
// 検査するのは**返り値の性質**であって、生の候補の性質ではない。`toShortName` が真偽値ではなく値を返す形に
// なっている理由がそこに在る——正規化してはじめて通る候補（`特味噌ﾈｷﾞﾗｰﾒ`）を生のまま保存すれば、検査した
// 性質が表示値に成立しない。ゆえに全 property を「返り値について」書く。
//
// **一意性・味の系統・セット種別の保持は検査しない**（requirements 判断 7・21）。それらは生成の指示が担い、
// 機械検査には持ち込まない。期待値に足せば、退けたはずの保証をテストが要求することになる。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  SHORT_NAME_MAX_LENGTH,
  usesOnlyCharactersOf,
  toShortName,
  toShortNameCandidate,
} from "../../src/display/short-name";

/** 実データの親品目名（`docs/data_samples/` の distinct 48 件から、長短と表記ゆれを代表する 8 件）。 */
const REAL_NAMES = [
  "特味噌ネギラーメン",
  "特味噌ラーメンAセット",
  "辛味噌ネギチャー",
  "お子様ラーメン醤油",
  "新ウルトラ激辛ラーメン",
  "旨辛ｽﾀﾐﾅﾗｰﾒﾝ", // 半角カナ。NFKC で 旨辛スタミナラーメン になる唯一の実データ
  "新プレ塩",
  "醤油つけ麺",
] as const;

const genName = fc.constantFrom(...REAL_NAMES);

/** 元名から文字を抜いて作った候補（部分列）。抜く位置は添字の部分集合で、順序は保つ。 */
const genSubsequenceOf = (name: string): fc.Arbitrary<string> => {
  const characters = [...name];
  return fc
    .array(fc.boolean(), { minLength: characters.length, maxLength: characters.length })
    .map((keep) => characters.filter((_, index) => keep[index] === true).join(""));
};

/** 正しい形の Workers AI 応答（OpenAI 形）を組む。`short` の値だけが可変。 */
const asResponse = (short: string): unknown => ({
  choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ short }) } }],
});

describe("札の関門", () => {
  // Feature: item-display-abbreviation, Property 1: toShortName が返した札は、非空であり、
  // SHORT_NAME_MAX_LENGTH 以下のコードポイント長を持ち、正規化後の元名の文字だけで組まれている。
  // 生の候補についてではなく**返り値について**成り立つ（Requirement 5.1〜5.3・5.7）。
  it("返した札は、非空・上限以下・元名の文字だけで組まれている", () => {
    fc.assert(
      fc.property(genName, fc.string({ maxLength: 12 }), (name, candidate) => {
        const label = toShortName(candidate, name);
        if (label === null) return;
        const length = [...label].length;
        expect(length).toBeGreaterThan(0);
        expect(length).toBeLessThanOrEqual(SHORT_NAME_MAX_LENGTH);
        expect(usesOnlyCharactersOf(label, name.normalize("NFKC"))).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  // Feature: item-display-abbreviation, Property 2: 元名から文字を抜いて作った候補は、非空かつ上限以下で
  // ある限り必ず通り、返り値は正規化後の候補に一致する。関門は「削っただけの候補」を落とさない。
  it("元名から文字を抜いて作った候補は通り、返り値は正規化後の候補に一致する", () => {
    fc.assert(
      fc.property(
        genName.chain((name) =>
          genSubsequenceOf(name.normalize("NFKC")).map((c): [string, string] => [name, c]),
        ),
        ([name, candidate]) => {
          const normalized = candidate.normalize("NFKC");
          const length = [...normalized].length;
          const label = toShortName(candidate, name);
          if (length === 0 || length > SHORT_NAME_MAX_LENGTH) {
            expect(label).toBeNull();
            return;
          }
          expect(label).toBe(normalized);
        },
      ),
      { numRuns: 1000 },
    );
  });

  // Feature: item-display-abbreviation, Property 3: 入力をあらかじめ NFKC 正規化して渡しても結果は変わらない。
  // 表記ゆれ（半角カナ）は関門の内側で吸収され、判定も返り値も正規化後の世界に閉じる（Requirement 5.7）。
  it("入力を先に正規化しても結果が変わらない", () => {
    fc.assert(
      fc.property(genName, fc.string({ maxLength: 12 }), (name, candidate) => {
        const direct = toShortName(candidate, name);
        const preNormalized = toShortName(candidate.normalize("NFKC"), name.normalize("NFKC"));
        expect(direct).toBe(preNormalized);
      }),
      { numRuns: 1000 },
    );
  });

  // Feature: item-display-abbreviation, Property 4: 正しい形の応答からは、埋め込んだ文字列がそのまま
  // 取り出される。復号は値を変えない——正規化も切り詰めも次段（toShortName）の仕事である（Requirement 5.8）。
  it("正しい形の応答からは埋め込んだ文字列がそのまま戻る", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), (short) => {
        expect(toShortNameCandidate(asResponse(short))).toBe(short);
      }),
      { numRuns: 1000 },
    );
  });

  // Feature: item-display-abbreviation, Property 5: usesOnlyCharactersOf は反射的で、多重度を数える。
  // 「元名に無い文字を使わせない」という芯が、並び替えを許しても保たれることを固定する。
  it("元名の文字だけを、元名にある回数まで使える（並び替えは許す）", () => {
    fc.assert(
      fc.property(genName, (name) => {
        const normalized = name.normalize("NFKC");
        expect(usesOnlyCharactersOf(normalized, normalized)).toBe(true);
        // 並び替えは通る（セット種別を先頭へ動かす形が要る・判断 33）。
        expect(usesOnlyCharactersOf([...normalized].reverse().join(""), normalized)).toBe(true);
        // 1 文字増やせば落ちる（多重度を数えている）。
        const doubled = normalized + [...normalized][0];
        expect(usesOnlyCharactersOf(doubled, normalized)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
