// tests/registry/slug.property.test.ts — storeId のスラッグ純粋関数の property テスト。
//
// 本ファイルは per-store-provisioning の slug 群（src/registry/slug.ts）の property を集める。
// Property 1（isValidStoreId の許容文字集合・長さ同値）を先に置き、後続で Property 4
// （mintStoreId の採番妥当性）を独立した describe として追記できる構成にする。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isValidStoreId, mintStoreId } from "../../src/registry/slug";

// ── 参照オラクル（isValidStoreId とは独立に判定する。regex 実装への依存を持たない） ──
// isValidStoreId は /^[a-z0-9-]{1,64}$/ 相当。ここでは UTF-16 コード単位を直接走査して
// 「長さ 1〜64」かつ「各文字が [a-z0-9-]」を判定し、実装と同値であるべき真偽を独立に導く。
function referenceValid(raw: string): boolean {
  if (raw.length < 1 || raw.length > 64) return false;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const isLower = code >= 97 && code <= 122; // a-z
    const isDigit = code >= 48 && code <= 57; // 0-9
    const isHyphen = code === 45; // -
    if (!isLower && !isDigit && !isHyphen) return false;
  }
  return true;
}

// ── ジェネレータ群（許容内・境界長・違反文字を偏りなく混ぜる） ──

/** 許容文字集合 [a-z0-9-] の 1 文字。 */
const genAllowedChar: fc.Arbitrary<string> = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyz0123456789-".split(""),
);

/** 許容文字のみ・長さ 1〜64 の妥当スラッグ（境界長 1・64 を含む）。 */
const genValidSlug: fc.Arbitrary<string> = fc
  .array(genAllowedChar, { minLength: 1, maxLength: 64 })
  .map((chars) => chars.join(""));

/** 許容文字のみだが 65 文字以上（長さ違反。文字集合は満たすが長すぎる）。 */
const genTooLong: fc.Arbitrary<string> = fc
  .array(genAllowedChar, { minLength: 65, maxLength: 96 })
  .map((chars) => chars.join(""));

/** 大文字・記号・空白などを含みうる任意 ASCII 文字列（文字集合違反を狙う）。 */
const genWithUppercaseOrSymbol: fc.Arbitrary<string> = fc.stringMatching(
  /^[A-Za-z0-9 _.@/!#$%-]{0,70}$/,
);

/** 全くの任意文字列（非 ASCII・制御文字・空も含む網羅入力）。 */
const genArbitrary: fc.Arbitrary<string> = fc.string({ maxLength: 70 });

/**
 * 検証入力の混合。妥当スラッグ・長さ超過・大文字/記号混じり・空・任意文字列を偏りなく引く。
 * 大文字（許容外）・記号（許容外）・空（長さ 0）・65 文字（長さ超過）・境界長（1/64）を全て踏む。
 */
const genCandidate: fc.Arbitrary<string> = fc.oneof(
  genValidSlug,
  genTooLong,
  genWithUppercaseOrSymbol,
  genArbitrary,
  fc.constant(""), // 空（長さ違反）を必ず踏む
);

describe("registry/slug — Property 1: storeId 検証は許容文字集合・長さに一致する", () => {
  // Feature: per-store-provisioning, Property 1: storeId 検証は許容文字集合・長さに一致する
  // 任意文字列 s について、isValidStoreId(s) が真であることと、s が [a-z0-9-] のみ・長さ 1〜64 で
  // あることが同値。regex 実装から独立した参照オラクルと突き合わせて双条件を検証する。
  // **Validates: Requirements 1.2, 2.3**
  it("Property 1: isValidStoreId(s) は「[a-z0-9-] のみ かつ 長さ 1〜64」と同値である", () => {
    fc.assert(
      fc.property(genCandidate, (raw) => {
        expect(isValidStoreId(raw)).toBe(referenceValid(raw));
      }),
      { numRuns: 300 },
    );
  });
});

describe("registry/slug — Property 4: 採番スラッグは常に妥当", () => {
  // Feature: per-store-provisioning, Property 4: 採番スラッグは常に妥当
  // 任意の乱数バイト列（非空）について mintStoreId(bytes) の出力は常に isValidStoreId を満たす。
  // mintStoreId の前提は非空バイト列（shell が固定長バッファを供給する・タスク 1.3 の note）。
  // ゆえに minLength: 1 で生成し、符号化表が [a-z0-9] のみ・長さ上限 64 で頭打ちにする実装が
  // 常に許容形（[a-z0-9-]・1..64）を満たすことを確かめる。
  // **Validates: Requirements 2.2**
  it("Property 4: mintStoreId(bytes) は常に isValidStoreId を満たす", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1 }), (bytes) => {
        expect(isValidStoreId(mintStoreId(bytes))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
