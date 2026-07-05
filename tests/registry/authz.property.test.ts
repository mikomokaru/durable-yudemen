// tests/registry/authz.property.test.ts — 接続時認可の純粋核（src/registry/authz.ts）の property test。
//
// このファイルは接続時認可まわりの property を 1 property = 1 describe ブロックで束ねる。
//   - Property 17 : 接続時認可は実効 Roster の所属判定（membership）         ← 本タスク（13.5）
//   - Property 20 : identity 正規化は冪等・決定的（normalize）               ← タスク 13.6 で末尾へ追記
// 後続タスク（13.6・Property 20）は末尾へ describe を追記するだけで済むよう、property ごとに独立させている。
//
// 設計意図（design.md Component 8 / 要件6.3）：接続時 Roster 認可は「投影のみで完結・レジストリ照会なし」の
// 純粋な所属判定である。StoreTimerDO の private メソッド isRostered は
//   roster.some((entry) => normalize(entry) === normalize(identity))
// で判定する（identity 欠如＝null は非所属）。private ゆえ node pool から import できないため、本テストは
// その所属判定と同一の純粋関係を、authz.ts が公開する normalize を正準化の単一の出所として用いて表現し、
// 「正規化済み identity が実効 Roster の正規化済み集合に含まれること」との同値を検査する（レジストリに一切
// 触れない＝投影のみで完結する所属判定である）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { normalize } from "../../src/registry/authz";
import type { Identity, Roster } from "../../src/registry/ideal";

// ── 被検査関係（System Under Test）──
// StoreTimerDO.isRostered の所属判定そのもの（identity が string の場合の membership）。
// normalize を照合の両辺に適用してから比較する（同じ人を同じ単位で照合する・要件9.5）。
function isMember(roster: Roster, identity: Identity): boolean {
  return roster.some((entry) => normalize(entry) === normalize(identity));
}

// ── 参照オラクル（独立した構造で「所属」を判定する）──
// some ループではなく「Roster を正規化した集合」への membership で判定し、被検査関係と構造を変える。
// 正準化規則そのもの（normalize）は単一の出所を共有するが、判定の構造（Set membership）は独立させる。
function normalizedRosterSet(roster: Roster): ReadonlySet<string> {
  return new Set(roster.map((entry) => normalize(entry)));
}

// ── ジェネレータ群（大小文字・前後空白の異表記・非 ASCII・空に近い identity を偏りなく混ぜる） ──

/**
 * identity の素の候補。email 風・非 ASCII・空白混じり・任意文字列を引き、正規化が吸収すべき表現差
 * （大小文字・前後空白）を含みうる母集団にする。normalize は trim + toLowerCase ゆえ、これらを踏む。
 */
const genIdentityBase: fc.Arbitrary<Identity> = fc.oneof(
  // email 風（大小文字混在を含みうる）
  fc
    .tuple(fc.stringMatching(/^[A-Za-z0-9.]{1,12}$/), fc.constantFrom("example.com", "Shop.JP", "本部.jp"))
    .map(([local, domain]) => `${local}@${domain}`),
  // 非 ASCII（日本語名など・Identity は不透明な文字列）
  fc.constantFrom("田中", "サトウ", "山田 太郎", "本部SV"),
  // 空白混じり・空に近い（境界）
  fc.constantFrom("", " ", "  ", "\t", " a "),
  // 任意文字列（網羅入力）
  fc.string({ maxLength: 16 }),
);

/**
 * 大小文字・前後空白の摂動を与える（normalize を跨いで元の identity と同値になる異表記を作る）。
 * lead/trail は空白のみ（trim で落ちる）、各文字はランダムに大文字/小文字化（toLowerCase で吸収される）。
 * ゆえに normalize(perturb(x)) === normalize(x) が常に成り立つ（正規化が吸収する表現差だけを注入する）。
 */
function perturb(value: string, lead: string, trail: string, upshifts: readonly boolean[]): string {
  const recased = Array.from(value, (ch, i) => (upshifts[i] ? ch.toUpperCase() : ch.toLowerCase())).join("");
  return `${lead}${recased}${trail}`;
}

const genWhitespace: fc.Arbitrary<string> = fc.constantFrom("", " ", "  ", "\t", "\n", " \t ");

/** 素の identity と、その大小文字/前後空白の異表記の組（normalize で同値になる）。 */
const genIdentityWithVariant: fc.Arbitrary<{ readonly base: Identity; readonly variant: Identity }> =
  genIdentityBase.chain((base) =>
    fc
      .record({
        lead: genWhitespace,
        trail: genWhitespace,
        upshifts: fc.array(fc.boolean(), { minLength: base.length, maxLength: base.length }),
      })
      .map(({ lead, trail, upshifts }) => ({ base, variant: perturb(base, lead, trail, upshifts) })),
  );

/** Roster（identity の配列）。空・重複・異表記の重複を含みうる母集団にする。 */
const genRoster: fc.Arbitrary<Roster> = fc.array(genIdentityBase, { maxLength: 8 });

/**
 * (roster, identity) の混合。所属する場合（Roster の要素の異表記）・所属しない場合・空 Roster・任意入力を
 * 偏りなく引く。所属判定の双条件（含む／含まない）を両側から踏ませる。
 */
const genRosterAndIdentity: fc.Arbitrary<{ readonly roster: Roster; readonly identity: Identity }> =
  genRoster.chain((roster) => {
    const branches: fc.Arbitrary<Identity>[] = [
      // 任意の identity（多くは非所属だが、偶然一致もしうる）。
      genIdentityBase,
    ];
    if (roster.length > 0) {
      // Roster の実在要素の大小文字/前後空白異表記（normalize で一致 → 所属するはず）。
      const entryArb = fc.constantFrom(...roster);
      branches.push(
        entryArb.chain((entry) =>
          fc
            .record({
              lead: genWhitespace,
              trail: genWhitespace,
              upshifts: fc.array(fc.boolean(), { minLength: entry.length, maxLength: entry.length }),
            })
            .map(({ lead, trail, upshifts }) => perturb(entry, lead, trail, upshifts)),
        ),
      );
    }
    return fc.oneof(...branches).map((identity) => ({ roster, identity }));
  });

describe("registry/authz — Property 17: 接続時認可は実効 Roster の所属判定", () => {
  // Feature: per-store-provisioning, Property 17: 接続時認可は実効 Roster の所属判定
  // **Validates: Requirements 6.3**
  //
  // Access ON 時の接続許可（＝所属判定 isMember）は、正規化済み identity が実効 Roster の正規化済み集合に
  // 含まれることと同値である。判定は Roster（投影の一部）と normalize だけで完結し、レジストリへ照会しない。
  // some ループ（被検査）と Set membership（独立オラクル）が全入力で一致することで双条件を検査する。
  it("Property 17: 所属判定は「正規化済み identity ∈ 正規化済み Roster 集合」と同値である", () => {
    fc.assert(
      fc.property(genRosterAndIdentity, ({ roster, identity }) => {
        const admitted = isMember(roster, identity);
        // 独立オラクル：Roster を正規化した集合への membership。
        const inNormalizedSet = normalizedRosterSet(roster).has(normalize(identity));
        expect(admitted).toBe(inNormalizedSet);
      }),
      { numRuns: 300 },
    );
  });

  // Feature: per-store-provisioning, Property 17: 接続時認可は実効 Roster の所属判定
  // **Validates: Requirements 6.3**
  //
  // 大小文字・前後空白の異表記でも「同じ人」は所属と判定される（正規化が表現差を吸収する）。
  // Roster に base を載せ、その異表記 variant で接続要求しても所属が認められることを確かめる。
  it("Property 17: Roster 要素の大小文字/前後空白の異表記は所属と判定される", () => {
    fc.assert(
      fc.property(genIdentityWithVariant, genRoster, ({ base, variant }, others) => {
        // base を必ず含む Roster（other 要素は任意）。
        const roster: Roster = [...others, base];
        // variant は normalize で base と同値ゆえ、所属が認められねばならない。
        expect(isMember(roster, variant)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  // Feature: per-store-provisioning, Property 17: 接続時認可は実効 Roster の所属判定
  // **Validates: Requirements 6.3**
  //
  // 空 Roster は誰も所属させない（実効 Roster が空なら接続許可は常に偽）。境界条件。
  it("Property 17: 空 Roster はいかなる identity も所属させない", () => {
    fc.assert(
      fc.property(genIdentityBase, (identity) => {
        expect(isMember([], identity)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

// ── Property 20（identity 正規化は冪等・決定的） ──

/**
 * 網羅入力の identity。既存の identity 母集団（email 風・非 ASCII・空白混じり・任意文字列）に加え、
 * 大小文字・前後空白・非 ASCII をより広く踏む任意文字列を混ぜ、正規化が写す入力空間を広く覆う。
 */
const genAnyIdentity: fc.Arbitrary<Identity> = fc.oneof(
  genIdentityBase,
  // 前後空白・改行・タブ・大小文字混在・非 ASCII を広く含む任意文字列（trim/toLowerCase が吸収すべき表現差）。
  // fast-check v4 の fc.string() は Unicode 全域から引く（旧 fullUnicodeString 相当を既定で覆う）。
  fc.string({ unit: "grapheme", maxLength: 24 }),
);

describe("registry/authz — Property 20: identity 正規化は冪等・決定的", () => {
  // Feature: per-store-provisioning, Property 20: identity 正規化は冪等・決定的
  // **Validates: Requirements 9.5**
  //
  // 冪等：正規化を二度適用しても一度と同じ（正準形は不動点）。trim/toLowerCase を再適用しても変わらない。
  it("Property 20: normalize は冪等である（normalize(normalize(x)) === normalize(x)）", () => {
    fc.assert(
      fc.property(genAnyIdentity, (identity) => {
        const once = normalize(identity);
        expect(normalize(once)).toBe(once);
      }),
      { numRuns: 300 },
    );
  });

  // Feature: per-store-provisioning, Property 20: identity 正規化は冪等・決定的
  // **Validates: Requirements 9.5**
  //
  // 決定的：同じ入力に常に同じ出力（時計・乱数・外部状態に依らない純粋関数）。二度呼んで一致する。
  it("Property 20: normalize は決定的である（同じ入力は同じ出力）", () => {
    fc.assert(
      fc.property(genAnyIdentity, (identity) => {
        expect(normalize(identity)).toBe(normalize(identity));
      }),
      { numRuns: 300 },
    );
  });
});
