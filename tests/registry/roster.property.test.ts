// tests/registry/roster.property.test.ts — 実効名簿（src/registry/roster.ts）の property test。
//
// このファイルは effectiveRoster の property を 1 property = 1 describe ブロックで束ねる。
//   - Property 7 : 実効 Roster は和集合であり冪等・順序非依存  ← 本タスク（12.4）
//
// effectiveRoster はチェーン Roster と店舗 Roster の和集合（重複排除）であり、priority / enforced の
// 統制意味論も deny 手段も持たない（要件3.5）。ゆえに次の三つを同時に検査する：
//   1. 和集合（deny なし） : 結果を集合として見ると chain ∪ store に等しく、いずれの入力要素も除外されない。
//   2. 冪等               : effectiveRoster(a, effectiveRoster(a, b)) は effectiveRoster(a, b) に（集合として）等しい。
//   3. 順序非依存         : 入力の並び（引数の入れ替え・各 Roster 内の置換）に依らず集合として一意。
// identity は非 ASCII・空に近い・重複を含む文字列で生成する（Roster は不透明な identity 文字列の集合）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { effectiveRoster } from "../../src/registry/roster";
import type { Roster } from "../../src/registry/ideal";

// ────────────────────────────────────────────────────────────────────────────
// 生成器（モジュールスコープ）
//
// identity の入力空間を賢く跨ぐ：
//   ・非 ASCII      — 日本語・アクセント付き・絵文字・半角カナ・合成/単体の記号（Access のクレームは不透明文字列ゆえ
//                     どんな Unicode でも来うる。和集合が文字列同一性で正しく重複排除することを検査する）。
//   ・空に近い      — 空文字・空白・1 文字（境界。Roster は空文字も要素として区別なく扱う）。
//   ・重複を含む    — 小さなプールから採り自然な衝突を誘発し、さらに部分集合を明示的に連結して重複を必ず混ぜる
//                     （集合として重複が同一視されることを検査する）。
// ────────────────────────────────────────────────────────────────────────────

/** 単一 identity を生成する。非 ASCII・空に近い文字列を跨ぐ。 */
const genIdentity: fc.Arbitrary<string> = fc.oneof(
  // 空に近い境界（空文字・空白・1 文字）。
  fc.constantFrom("", " ", "a", "1", "-"),
  // 非 ASCII の代表例（日本語・アクセント付き・絵文字・半角カナ・記号）。
  fc.constantFrom(
    "田中",
    "山田太郎",
    "café",
    "naïve",
    "Ω",
    "😀",
    "😀😀",
    "北海道-店長",
    "ﾃｽﾄ",
    "staff@例え.jp",
  ),
  // ASCII を含む一般文字列（空も含む）。
  fc.string({ maxLength: 12 }),
  // Unicode grapheme 文字列（非 ASCII を確率的に多く含む）。
  fc.string({ unit: "grapheme", maxLength: 6 }),
);

/**
 * genRoster — identity の列を生成する。小さなプール由来の自然な衝突に加え、部分集合を連結して重複を必ず混ぜる。
 * Roster は順序に意味を持たせない集合ゆえ、重複・順序は結果（集合）に影響しないことを検査対象に含める。
 */
const genRoster: fc.Arbitrary<Roster> = fc
  .array(genIdentity, { maxLength: 10 })
  .chain((base) =>
    fc
      .shuffledSubarray([...base], { minLength: 0, maxLength: base.length })
      .map((dupes) => [...base, ...dupes] as Roster),
  );

/** 二つの Roster と、その各々の置換（順序非依存の検査用）を束ねる。 */
const genScenario = fc.tuple(genRoster, genRoster).chain(([chainRoster, storeRoster]) =>
  fc.record({
    chainRoster: fc.constant(chainRoster),
    storeRoster: fc.constant(storeRoster),
    chainShuffled: fc.shuffledSubarray([...chainRoster], {
      minLength: chainRoster.length,
      maxLength: chainRoster.length,
    }),
    storeShuffled: fc.shuffledSubarray([...storeRoster], {
      minLength: storeRoster.length,
      maxLength: storeRoster.length,
    }),
  }),
);

/** 二つの列を集合として比較する（要素の有無のみを見る。順序・重複は無視）。 */
function sameSet(a: Roster, b: Roster): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

describe("registry/roster — effectiveRoster", () => {
  // Feature: per-store-provisioning, Property 7: 実効 Roster は和集合であり冪等・順序非依存
  // **Validates: Requirements 3.5**
  //
  // effectiveRoster の結果は両 Roster の和集合（集合として）に等しく、いずれの要素も除外されず（deny なし）、
  // effectiveRoster(a, effectiveRoster(a, b)) は effectiveRoster(a, b) に等しく入力順序に依らない。
  it("Property 7: 結果は chain ∪ store（deny なし）であり冪等・順序非依存", () => {
    fc.assert(
      fc.property(genScenario, ({ chainRoster, storeRoster, chainShuffled, storeShuffled }) => {
        const result = effectiveRoster(chainRoster, storeRoster);
        const union: Roster = [...chainRoster, ...storeRoster];

        // 1. 和集合（deny なし）：結果集合 = chain ∪ store。
        expect(sameSet(result, union)).toBe(true);
        // いずれの入力要素も結果から除外されない（deny 手段を持たない）。
        for (const id of union) expect(result).toContain(id);
        // 結果は重複を持たない（集合として一意）。
        expect(result.length).toBe(new Set(result).size);

        // 2. 冪等：effectiveRoster(a, effectiveRoster(a, b)) は effectiveRoster(a, b) に（集合として）等しい。
        const again = effectiveRoster(chainRoster, result);
        expect(sameSet(again, result)).toBe(true);

        // 3. 順序非依存（引数の入れ替え）：swap しても結果集合は和集合のまま。
        const swapped = effectiveRoster(storeRoster, chainRoster);
        expect(sameSet(swapped, union)).toBe(true);

        // 3. 順序非依存（各 Roster 内の置換）：入力を並べ替えても結果集合は不変。
        const reordered = effectiveRoster(chainShuffled, storeShuffled);
        expect(sameSet(reordered, result)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
