// tests/worker/access-enablement-guard.property.test.ts — 有効化ガードの合成判定と不正変数診断の property テスト（Property 2）。
//
// enablementReadiness は cloudflare:workers・wrangler・I/O に依存しない純粋述語として src/access-enablement.ts に
// 隔離されている（worker-auth.ts / worker-entry.ts と同型・構造の主権）。ゆえに本テストは DO ランタイムを起こさず
// 既定 pool（node）で直接 import して検証できる。
//
// 本ファイルは Property 2（有効化ガードの合成判定と不正変数の診断）ただ一点を扱う。Property 1（TEAM_DOMAIN 形式）は
// 別タスク（2.2）が別ファイルで扱うため、ここでは重複させない。
//
// 検証の要は独立オラクル: 実装の命令的構造を写経せず、仕様（design.md Property 2・requirements 5.2/5.3）が述べる規則を
// 素直に符号化した参照判定を組み、(a)「両変数が有効なとき、かつそのときに限り有効化可」という双条件（iff）と、
// (b) 有効化不可のとき診断が不正変数（空・未設定・プレースホルダ一致・形式不適合）を過不足なく含むこと、を突き合わせる。
//
// Validates: Requirements 5.2, 5.3

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  enablementReadiness,
  type EnablementReadiness,
  type InvalidVariable,
} from "../../src/access-enablement";

// ── 仕様が定める固定辺・プレースホルダの正本（独立オラクルが照合する既定値）──
// 実装の private 定数を輸入せず、design.md / requirements の記述値をここに素直に置く（独立オラクル）。
const SCHEME = "https://";
const SUFFIX = ".cloudflareaccess.com";
const TEAM_DOMAIN_PLACEHOLDER = "https://<team>.cloudflareaccess.com";
const POLICY_AUD_PLACEHOLDER = "<access-app-aud>";

/** 妥当な DNS ラベル（[a-z0-9-]・1〜63 文字・先頭/末尾ハイフン不可）。仕様の文字集合規則を独立に符号化する。 */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// ── 独立オラクル（仕様の規則をそのまま符号化。実装の imperative 構造を写経しない）──

/** TEAM_DOMAIN 形式適合（固定辺を剥がし、残るサブドメインが妥当な DNS ラベルか）。 */
function isTeamDomainWellFormed(teamDomain: string): boolean {
  if (!teamDomain.startsWith(SCHEME) || !teamDomain.endsWith(SUFFIX)) return false;
  const subdomain = teamDomain.slice(SCHEME.length, teamDomain.length - SUFFIX.length);
  return DNS_LABEL.test(subdomain);
}

/** TEAM_DOMAIN の不正理由（適合なら null）。空 → プレースホルダ一致 → 形式不適合 の順で分類する。 */
function teamDomainDefect(teamDomain: string): "empty" | "placeholder" | "format" | null {
  if (teamDomain.length === 0) return "empty";
  if (teamDomain === TEAM_DOMAIN_PLACEHOLDER) return "placeholder";
  return isTeamDomainWellFormed(teamDomain) ? null : "format";
}

/** POLICY_AUD の不正理由（適合なら null）。非空かつプレースホルダ不一致のみを実値とみなす。 */
function policyAudDefect(policyAud: string): "empty" | "placeholder" | null {
  if (policyAud.length === 0) return "empty";
  if (policyAud === POLICY_AUD_PLACEHOLDER) return "placeholder";
  return null;
}

/** 診断集合を variable で正準順に並べ、順序差に依存せず「過不足なく含む」を集合として突き合わせる。 */
function sortInvalid(invalid: readonly InvalidVariable[]): InvalidVariable[] {
  return [...invalid].sort((a, b) => a.variable.localeCompare(b.variable));
}

// ── ジェネレータ群 ──

const LOWER = "abcdefghijklmnopqrstuvwxyz0123456789"; // [a-z0-9]
const LABEL = "abcdefghijklmnopqrstuvwxyz0123456789-"; // [a-z0-9-]
const genLower: fc.Arbitrary<string> = fc.constantFrom(...LOWER.split(""));
const genLabelChar: fc.Arbitrary<string> = fc.constantFrom(...LABEL.split(""));

/** 妥当な DNS ラベル 1〜63 文字（先頭/末尾は英数字、中間のみハイフンを許す）。 */
const genValidLabel: fc.Arbitrary<string> = fc.integer({ min: 1, max: 63 }).chain((len) => {
  if (len === 1) return genLower;
  return fc
    .tuple(genLower, fc.array(genLabelChar, { minLength: len - 2, maxLength: len - 2 }), genLower)
    .map(([first, middle, last]) => first + middle.join("") + last);
});

/** 適合する TEAM_DOMAIN（`https://` + 妥当ラベル + `.cloudflareaccess.com`）。 */
const genValidTeamDomain: fc.Arbitrary<string> = genValidLabel.map((sub) => SCHEME + sub + SUFFIX);

/** サブドメイン長 64（境界超過）。文字集合は妥当だが長さで弾かれる。 */
const genTooLong: fc.Arbitrary<string> = fc
  .array(genLower, { minLength: 64, maxLength: 64 })
  .map((chars) => SCHEME + chars.join("") + SUFFIX);

/** スキーム欠如（`http://`・スキームなし）。 */
const genMissingScheme: fc.Arbitrary<string> = fc.oneof(
  genValidLabel.map((sub) => "http://" + sub + SUFFIX),
  genValidLabel.map((sub) => sub + SUFFIX),
);

/** 末尾ドメイン不一致。 */
const genWrongSuffix: fc.Arbitrary<string> = genValidLabel.map((sub) => SCHEME + sub + ".example.com");

/** `<` `>` を含む擬似プレースホルダ（長さ判定だけでは通過しうるが文字集合で弾かれる）。 */
const genAngleBracket: fc.Arbitrary<string> = fc.oneof(
  fc.constant("https://<myteam>.cloudflareaccess.com"),
  genValidLabel.map((sub) => SCHEME + "<" + sub + ">" + SUFFIX),
);

/** DNS ラベル文字集合外（大文字・記号・先頭/末尾ハイフン・ドット混入）。 */
const genCharsetViolation: fc.Arbitrary<string> = fc.oneof(
  genValidLabel.map((sub) => SCHEME + sub.toUpperCase() + "A" + SUFFIX), // 大文字を必ず含める
  genValidLabel.map((sub) => SCHEME + "-" + sub + SUFFIX), // 先頭ハイフン
  genValidLabel.map((sub) => SCHEME + sub + "-" + SUFFIX), // 末尾ハイフン
  genValidLabel.map((sub) => SCHEME + sub + "_x" + SUFFIX), // アンダースコア
  genValidLabel.map((sub) => SCHEME + sub + "." + sub + SUFFIX), // サブドメインにドット混入
);

/** TEAM_DOMAIN 入力空間（適合・空・プレースホルダ・境界長・スキーム欠如・末尾不一致・擬似プレースホルダ・文字集合外・任意）を織り込む。 */
const genTeamDomain: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: genValidTeamDomain },
  { weight: 1, arbitrary: fc.constant("") }, // 空・未設定
  { weight: 1, arbitrary: fc.constant(TEAM_DOMAIN_PLACEHOLDER) }, // プレースホルダ一致
  { weight: 1, arbitrary: fc.constant(SCHEME + SUFFIX) }, // サブドメイン長 0
  { weight: 1, arbitrary: genTooLong }, // サブドメイン長 64
  { weight: 1, arbitrary: genMissingScheme },
  { weight: 1, arbitrary: genWrongSuffix },
  { weight: 1, arbitrary: genAngleBracket },
  { weight: 2, arbitrary: genCharsetViolation },
  { weight: 1, arbitrary: fc.string({ maxLength: 50 }) }, // 任意文字列（広い空間）
);

/** POLICY_AUD 入力空間（空・プレースホルダ一致・任意の非空文字列）を織り込む。 */
const genPolicyAud: fc.Arbitrary<string> = fc.oneof(
  { weight: 1, arbitrary: fc.constant("") }, // 空・未設定
  { weight: 1, arbitrary: fc.constant(POLICY_AUD_PLACEHOLDER) }, // プレースホルダ一致
  { weight: 3, arbitrary: fc.string({ minLength: 1, maxLength: 40 }) }, // 任意の非空文字列
);

describe("access-enablement — Property 2: 有効化ガードの合成判定と不正変数の診断", () => {
  // Feature: cloudflare-access-enablement, Property 2: 有効化ガードの合成判定と不正変数の診断
  // (teamDomain, policyAud) の 2 文字列に対し、独立オラクルで期待値を組み:
  //   (a) 「teamDomain が形式適合 かつ policyAud が非空・非プレースホルダ」であるとき、かつそのときに限り ready:true（iff）。
  //   (b) ready:false のとき、診断 invalid が不正変数（空・未設定・プレースホルダ一致・形式不適合）を過不足なく含む。
  // **Validates: Requirements 5.2, 5.3**
  it("両変数が有効なときかつそのときに限り有効化可、不可時は不正変数を過不足なく診断する（要件5.2/5.3）", () => {
    fc.assert(
      fc.property(genTeamDomain, genPolicyAud, (teamDomain, policyAud) => {
        const result: EnablementReadiness = enablementReadiness(teamDomain, policyAud);

        // 独立オラクル: 各変数の不正理由（null なら適合）。
        const teamReason = teamDomainDefect(teamDomain);
        const policyReason = policyAudDefect(policyAud);
        const expectedReady = teamReason === null && policyReason === null;

        // (a) 合成判定の双条件（iff）: 両者が適合するとき、かつそのときに限り ready:true。
        expect(result.ready).toBe(expectedReady);

        if (result.ready) {
          // 適合時は不正診断を伴わない（判別可能型ゆえ invalid フィールド自体を持たない）。
          expect("invalid" in result).toBe(false);
        } else {
          // (b) 不可時: 期待される不正変数集合を独立に組み、過不足なく一致することを集合として検証する。
          const expectedInvalid: InvalidVariable[] = [];
          if (teamReason !== null) expectedInvalid.push({ variable: "TEAM_DOMAIN", reason: teamReason });
          if (policyReason !== null) expectedInvalid.push({ variable: "POLICY_AUD", reason: policyReason });

          expect(sortInvalid(result.invalid)).toEqual(sortInvalid(expectedInvalid));
          // 「不可なら理由あり」を実値でも確認する（型の NonEmptyArray 表明の実地確認）。
          expect(result.invalid.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 300 },
    );
  });
});
