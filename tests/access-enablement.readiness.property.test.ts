// tests/access-enablement.readiness.property.test.ts — 有効化ガード（src/access-enablement.ts）の
// 合成判定と不正変数診断の property test。
//
// 対象は Correctness Property 2（有効化ガードの合成判定と不正変数の診断）ただ一点。
//   - Property 2 : enablementReadiness の (teamDomain, policyAud) 合成判定と診断の過不足なさ  ← 本タスク（2.3）
//
// Property 1（tests/access-enablement.property.test.ts）が TEAM_DOMAIN 形式適合を単独で検証するのに対し、
// 本 test は 2 変数の合成——「両者が有効なとき、かつそのときに限り有効化可」——と、有効化不可のときに返す
// 診断が不正変数（空・未設定・プレースホルダ一致・形式不適合）を過不足なく（過剰も不足もなく）含むことを検証する。
//
// enablementReadiness は cloudflare:workers・I/O に依存しない純粋述語ゆえ既定 pool（node）で走る。
// 実装の正規表現・分岐に依らない独立 oracle を test 内に組み、返る診断集合とを完全一致で突き合わせる。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { enablementReadiness, type InvalidVariable } from "../src/access-enablement";

// ── 判定の固定辺・プレースホルダ（要件5.1〜5.3・design Property 2 の定義そのもの）──
const SCHEME = "https://";
const SUFFIX = ".cloudflareaccess.com";
const TEAM_DOMAIN_PLACEHOLDER = "https://<team>.cloudflareaccess.com";
const POLICY_AUD_PLACEHOLDER = "<access-app-aud>";

/** `https://` + サブドメイン + `.cloudflareaccess.com` に組み立てる。 */
function wrap(subdomain: string): string {
  return `${SCHEME}${subdomain}${SUFFIX}`;
}

// ── 独立 oracle（実装の DNS_LABEL 正規表現を再利用せず、文字単位で DNS ラベル規則を綴る）──
// 妥当な DNS ラベル: 文字集合 [a-z0-9-]・長さ 1〜63・先頭/末尾ハイフン不可。
function isAlnum(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "0" && c <= "9");
}
function isAlnumOrHyphen(c: string): boolean {
  return isAlnum(c) || c === "-";
}
function isValidDnsLabel(sub: string): boolean {
  const n = sub.length;
  if (n < 1 || n > 63) return false;
  if (!isAlnum(sub[0]!) || !isAlnum(sub[n - 1]!)) return false;
  for (let i = 1; i < n - 1; i++) {
    if (!isAlnumOrHyphen(sub[i]!)) return false;
  }
  return true;
}

/** TEAM_DOMAIN の不正理由（適合なら null）を独立に判定する oracle。プレースホルダ一致を形式判定より先に寄せる。 */
function teamDomainReasonOracle(s: string): "empty" | "placeholder" | "format" | null {
  if (s.length === 0) return "empty";
  if (s === TEAM_DOMAIN_PLACEHOLDER) return "placeholder";
  if (!s.startsWith(SCHEME) || !s.endsWith(SUFFIX)) return "format";
  const sub = s.slice(SCHEME.length, s.length - SUFFIX.length);
  return isValidDnsLabel(sub) ? null : "format";
}

/** POLICY_AUD の不正理由（適合なら null）を独立に判定する oracle。非空かつプレースホルダ不一致のみ実値。 */
function policyAudReasonOracle(s: string): "empty" | "placeholder" | null {
  if (s.length === 0) return "empty";
  if (s === POLICY_AUD_PLACEHOLDER) return "placeholder";
  return null;
}

/** (teamDomain, policyAud) から「過不足なき不正変数集合」を独立に組み立てる oracle。 */
function expectedInvalidOracle(teamDomain: string, policyAud: string): InvalidVariable[] {
  const expected: InvalidVariable[] = [];
  const teamReason = teamDomainReasonOracle(teamDomain);
  if (teamReason !== null) expected.push({ variable: "TEAM_DOMAIN", reason: teamReason });
  const policyReason = policyAudReasonOracle(policyAud);
  if (policyReason !== null) expected.push({ variable: "POLICY_AUD", reason: policyReason });
  return expected;
}

/** 診断集合を順序非依存で比較するための正準キー。過剰・不足の双方を捉える。 */
function canonicalKey(entries: readonly InvalidVariable[]): string {
  return entries
    .map((entry) => `${entry.variable}:${entry.reason}`)
    .sort()
    .join("|");
}

// ── 生成の母集団 ──
const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789".split("");
const ALNUM_HYPHEN = [...ALNUM, "-"];
const genAlnum = fc.constantFrom(...ALNUM);
const genAlnumHyphen = fc.constantFrom(...ALNUM_HYPHEN);

/** 妥当な DNS ラベル（1〜63・先頭末尾英数字・中間のみハイフン可）。 */
const genValidLabel: fc.Arbitrary<string> = fc.oneof(
  genAlnum, // 長さ1（単独英数字）
  fc
    .tuple(genAlnum, fc.array(genAlnumHyphen, { minLength: 0, maxLength: 61 }), genAlnum)
    .map(([head, middle, tail]) => head + middle.join("") + tail), // 長さ2〜63
);

/** DNS ラベル文字集合外の不正サブドメイン（大文字・記号・先頭/末尾ハイフン）。 */
const genInvalidLabel: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom("MyTeam", "TEAM", "aB"), // 大文字
  fc.constantFrom("te_am", "te.am", "te am", "te@m", "*"), // 記号・空白
  fc.constantFrom("-team", "team-", "-", "--"), // 先頭/末尾ハイフン
);

// TEAM_DOMAIN の生成カテゴリ（有効・空・プレースホルダ・境界長・スキーム欠如・末尾不一致・擬似プレースホルダ・
// 文字集合外・任意文字列）を漏れなく織り込む。
const genTeamDomain: fc.Arbitrary<string> = fc.oneof(
  genValidLabel.map(wrap), // 正しい形式（可変ラベル）
  fc.constant(wrap("a")), // サブドメイン長 1
  fc.constant(wrap("a".repeat(63))), // サブドメイン長 63
  fc.constant(""), // 空
  fc.constant(TEAM_DOMAIN_PLACEHOLDER), // 既定プレースホルダ一致
  fc.constant(wrap("")), // サブドメイン長 0
  fc.constant(wrap("a".repeat(64))), // サブドメイン長 64
  genValidLabel.map((label) => `http://${label}${SUFFIX}`), // スキーム欠如（http://）
  genValidLabel.map((label) => `${label}${SUFFIX}`), // スキームなし
  genValidLabel.map((label) => `${SCHEME}${label}.example.com`), // 末尾ドメイン不一致
  genValidLabel.map((label) => `${SCHEME}${label}.cloudflareaccess.org`),
  fc.constantFrom("myteam", "team", "acme").map((label) => wrap(`<${label}>`)), // 擬似プレースホルダ
  genInvalidLabel.map(wrap), // 文字集合外
  fc.string(), // 任意文字列
);

// POLICY_AUD の生成カテゴリ（空・プレースホルダ一致・任意の非空文字列）を織り込む。
const genPolicyAud: fc.Arbitrary<string> = fc.oneof(
  fc.constant(""), // 空
  fc.constant(POLICY_AUD_PLACEHOLDER), // 既定プレースホルダ一致
  fc.constantFrom("real-access-app-audience-id", "abc123", "a"), // 妥当な非空値
  fc.string({ minLength: 1 }), // 任意の非空文字列
);

describe("access-enablement — enablementReadiness（合成判定と不正変数の診断）", () => {
  // Feature: cloudflare-access-enablement, Property 2: 有効化ガードの合成判定と不正変数の診断
  // **Validates: Requirements 5.2, 5.3**
  //
  // 任意の (teamDomain, policyAud) について、enablementReadiness は「teamDomain が形式適合し、かつ policyAud が
  // 非空・非プレースホルダ」であるとき、かつそのときに限り ready:true を返す。それ以外は ready:false を返し、
  // その invalid は不正変数（空・未設定・プレースホルダ一致・形式不適合）を過不足なく含む——独立 oracle が
  // 組み立てた期待集合と、返る診断集合とを順序非依存で完全一致（過剰・不足の双方が失敗）で突き合わせる。
  it("Property 2: 両変数が有効なときのみ有効化可、かつ有効化不可の診断は不正変数を過不足なく含む（iff）", () => {
    fc.assert(
      fc.property(genTeamDomain, genPolicyAud, (teamDomain, policyAud) => {
        const result = enablementReadiness(teamDomain, policyAud);
        const expectedInvalid = expectedInvalidOracle(teamDomain, policyAud);

        if (expectedInvalid.length === 0) {
          // 両変数が有効 ⇒ 有効化可。
          expect(result.ready).toBe(true);
        } else {
          // いずれかが不正 ⇒ 有効化不可。診断集合が期待集合と完全一致（過不足なし）。
          expect(result.ready).toBe(false);
          if (!result.ready) {
            expect(canonicalKey(result.invalid)).toBe(canonicalKey(expectedInvalid));
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
