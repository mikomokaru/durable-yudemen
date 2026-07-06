// tests/access-enablement.property.test.ts — 有効化ガード（src/access-enablement.ts）の TEAM_DOMAIN 形式判定の property test。
//
// 対象は Correctness Property 1（TEAM_DOMAIN 形式適合の判定）ただ一点。
//   - Property 1 : enablementReadiness の TEAM_DOMAIN 形式適合判定  ← 本タスク（2.2）
//
// enablementReadiness は cloudflare:workers・I/O に依存しない純粋述語ゆえ既定 pool（node）で走る。
// モジュールは合成述語 enablementReadiness のみを公開するため、POLICY_AUD を既知の妥当値に固定して
// 「readiness が TEAM_DOMAIN 形式適合を反映するか」を観測する（POLICY_AUD 側は常に適合＝診断に現れない）。
// 形式適合の可否と不正理由（empty / placeholder / format）を、実装の正規表現に依らない独立 oracle と突き合わせる。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { enablementReadiness } from "../src/access-enablement";

// ── 形式判定の固定辺（要件5.1・design Property 1 の定義そのもの）──
const SCHEME = "https://";
const SUFFIX = ".cloudflareaccess.com";
const TEAM_DOMAIN_PLACEHOLDER = "https://<team>.cloudflareaccess.com";

// POLICY_AUD を常に適合させる既知の妥当値（非空・プレースホルダ `<access-app-aud>` と不一致）。
// これにより enablementReadiness の可否は TEAM_DOMAIN の形式適合だけで決まる。
const VALID_POLICY_AUD = "real-access-app-audience-id";

/** `https://` + サブドメイン + `.cloudflareaccess.com` に組み立てる（生成カテゴリの共通土台）。 */
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

/**
 * TEAM_DOMAIN の不正理由（適合なら null）を独立に判定する oracle。
 * プレースホルダ一致は形式判定より先に「placeholder」へ寄せる（実装・要件5.3 の診断方針）。
 * これ以外の不適合はすべて「format」に集約される（空は「empty」）。
 */
function teamDomainReasonOracle(s: string): "empty" | "placeholder" | "format" | null {
  if (s.length === 0) return "empty";
  if (s === TEAM_DOMAIN_PLACEHOLDER) return "placeholder";
  if (!s.startsWith(SCHEME) || !s.endsWith(SUFFIX)) return "format";
  const sub = s.slice(SCHEME.length, s.length - SUFFIX.length);
  return isValidDnsLabel(sub) ? null : "format";
}

// ── 生成の母集団（design / task 2.2 が要求するカテゴリを漏れなく織り込む）──
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

// 各カテゴリを均等に踏むよう oneof で束ねる。
const genTeamDomain: fc.Arbitrary<string> = fc.oneof(
  // 正しい形式（可変ラベル ＋ 境界長 1 / 63）
  genValidLabel.map(wrap),
  fc.constant(wrap("a")), // サブドメイン長 1
  fc.constant(wrap("a".repeat(63))), // サブドメイン長 63
  // 空
  fc.constant(""),
  // 既定プレースホルダ一致
  fc.constant(TEAM_DOMAIN_PLACEHOLDER),
  // サブドメイン長 0 / 64
  fc.constant(wrap("")), // 長 0
  fc.constant(wrap("a".repeat(64))), // 長 64
  // スキーム欠如（http:// ・スキームなし）
  genValidLabel.map((label) => `http://${label}${SUFFIX}`),
  genValidLabel.map((label) => `${label}${SUFFIX}`),
  // 末尾ドメイン不一致
  genValidLabel.map((label) => `${SCHEME}${label}.example.com`),
  genValidLabel.map((label) => `${SCHEME}${label}.cloudflareaccess.org`),
  // `<` `>` を含む擬似プレースホルダ
  fc.constantFrom("myteam", "team", "acme").map((label) => wrap(`<${label}>`)),
  // DNS ラベル文字集合外
  genInvalidLabel.map(wrap),
  // 任意文字列（想定外入力の網羅）
  fc.string(),
);

describe("access-enablement — enablementReadiness（TEAM_DOMAIN 形式適合）", () => {
  // Feature: cloudflare-access-enablement, Property 1: TEAM_DOMAIN 形式適合の判定
  // **Validates: Requirements 5.1**
  //
  // 任意の文字列 s について、TEAM_DOMAIN 形式判定は「https:// + 妥当な DNS ラベル 1〜63 + .cloudflareaccess.com、
  // かつ既定プレースホルダと不一致」であるとき、かつそのときに限り適合する。POLICY_AUD を既知の妥当値に固定するため、
  // enablementReadiness の可否は TEAM_DOMAIN 形式適合と一致し、不適合時の診断は TEAM_DOMAIN の不正理由を正しく載せる。
  it("Property 1: readiness は TEAM_DOMAIN 形式適合を反映し、不適合時に正しい理由を診断する（iff）", () => {
    fc.assert(
      fc.property(genTeamDomain, (teamDomain) => {
        const result = enablementReadiness(teamDomain, VALID_POLICY_AUD);
        const expectedReason = teamDomainReasonOracle(teamDomain);

        if (expectedReason === null) {
          // 形式適合 ⇒ POLICY_AUD も適合ゆえ有効化可。
          expect(result.ready).toBe(true);
        } else {
          // 形式不適合 ⇒ 有効化不可。診断は TEAM_DOMAIN の不正理由を過不足なく載せ、
          // POLICY_AUD（適合）は診断に現れない。
          expect(result.ready).toBe(false);
          if (!result.ready) {
            const teamEntry = result.invalid.find((entry) => entry.variable === "TEAM_DOMAIN");
            expect(teamEntry).toEqual({ variable: "TEAM_DOMAIN", reason: expectedReason });
            expect(result.invalid.some((entry) => entry.variable === "POLICY_AUD")).toBe(false);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
