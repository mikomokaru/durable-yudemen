// tests/check-access-enablement.example.test.ts — デプロイ前検査 CLI の純粋核 accessEnablementPreflight の example test。
//
// 対象は tools/check-access-enablement.ts が公開する純粋関数 accessEnablementPreflight ただ一点（要件5.3 / 5.5）。
// CLI 本体（main）は import.meta.url とエントリ判定でガードされ、import しても I/O・spawn を起こさない。
// ゆえに「値の解決 → 判定 → 提示・終了コード」のうち中核の「判定」だけを、作用を起こさずに具体例で固められる。
//
// この test は node:fs / node:child_process 等に依存する CLI モジュールを import するため、既定 pool（node）で走る。
// PBT（Property 1/2）は enablementReadiness を網羅的に検証済みゆえ、ここは合成層（typegen 結果 × 有効化の意図 ×
// プレースホルダ判定）の分岐と「ユーザー向け出力が英語であること」を代表例で確かめる（過剰なエッジ網羅はしない）。

import { describe, expect, it } from "vitest";
import {
  accessEnablementPreflight,
  type PreflightInput,
  type PreflightVerdict,
} from "../tools/check-access-enablement";

// ── 具体値（要件5.1〜5.3 の定義そのもの）──
const TEAM_DOMAIN_PLACEHOLDER = "https://<team>.cloudflareaccess.com";
const POLICY_AUD_PLACEHOLDER = "<access-app-aud>";
const VALID_TEAM_DOMAIN = "https://acme.cloudflareaccess.com";
const VALID_POLICY_AUD = "real-access-app-audience-id";

/** ユーザー向け出力が英語（＝非 ASCII の日本語文字を含まない ASCII 文字列）であることを表明する。 */
function isEnglishAscii(message: string): boolean {
  // 制御文字を除く印字可能 ASCII のみ許す（日本語コメントが混ざれば非 ASCII で弾かれる）。
  return /^[\x20-\x7E]*$/.test(message);
}

/** proceed:false の verdict から英語エラー配列を取り出す（型を狭める小さなヘルパ）。 */
function errorsOf(verdict: PreflightVerdict): readonly string[] {
  expect(verdict.proceed).toBe(false);
  if (verdict.proceed) throw new Error("expected proceed:false");
  return verdict.errors;
}

describe("check-access-enablement — accessEnablementPreflight（デプロイ前検査の純粋核）", () => {
  it("プレースホルダ残存: proceed:false で TEAM_DOMAIN と POLICY_AUD の両方を英語で提示する（要件5.3）", () => {
    const input: PreflightInput = {
      accessRequired: "1",
      teamDomain: TEAM_DOMAIN_PLACEHOLDER,
      policyAud: POLICY_AUD_PLACEHOLDER,
      typegen: { ran: true, ok: true },
    };

    const verdict = accessEnablementPreflight(input);
    const errors = errorsOf(verdict);

    // 両変数を名指しする（不正変数を過不足なく含む）。
    expect(errors).toHaveLength(2);
    expect(errors.some((e) => e.includes("TEAM_DOMAIN") && e.includes("placeholder"))).toBe(true);
    expect(errors.some((e) => e.includes("POLICY_AUD") && e.includes("placeholder"))).toBe(true);
    // すべて英語。
    for (const error of errors) expect(isEnglishAscii(error)).toBe(true);
  });

  it("形式不適合の TEAM_DOMAIN: proceed:false で TEAM_DOMAIN を名指しし整形ガイダンスを英語で示す（要件5.3）", () => {
    const input: PreflightInput = {
      accessRequired: "1",
      teamDomain: "http://acme.example.com", // スキーム欠如＋末尾ドメイン不一致
      policyAud: VALID_POLICY_AUD,
      typegen: { ran: true, ok: true },
    };

    const verdict = accessEnablementPreflight(input);
    const errors = errorsOf(verdict);

    // TEAM_DOMAIN の形式エラーのみ（POLICY_AUD は適合ゆえ現れない）。
    expect(errors).toHaveLength(1);
    const [error] = errors;
    expect(error).toContain("TEAM_DOMAIN");
    expect(error).toContain("malformed");
    // 正しい形の手引きを含む。
    expect(error).toContain("cloudflareaccess.com");
    expect(errors.some((e) => e.includes("POLICY_AUD"))).toBe(false);
    expect(isEnglishAscii(error!)).toBe(true);
  });

  it("型再生成失敗: 有効な値でも proceed:false で Env 再生成失敗を英語で提示する（要件5.5）", () => {
    const input: PreflightInput = {
      accessRequired: "1",
      teamDomain: VALID_TEAM_DOMAIN,
      policyAud: VALID_POLICY_AUD,
      typegen: { ran: true, ok: false, detail: "pnpm cf-typegen exited with code 1." },
    };

    const verdict = accessEnablementPreflight(input);
    const errors = errorsOf(verdict);

    // 値は適合ゆえ、型再生成失敗のエラーのみ。
    expect(errors).toHaveLength(1);
    const [error] = errors;
    expect(error).toContain("cf-typegen");
    expect(error).toContain("Env type");
    // detail が末尾に連結される。
    expect(error).toContain("exited with code 1");
    expect(isEnglishAscii(error!)).toBe(true);
  });

  it("正常値 + 型再生成成功: proceed:true を返し英語の注記を伴う（要件5.3）", () => {
    const input: PreflightInput = {
      accessRequired: "1",
      teamDomain: VALID_TEAM_DOMAIN,
      policyAud: VALID_POLICY_AUD,
      typegen: { ran: true, ok: true },
    };

    const verdict = accessEnablementPreflight(input);

    expect(verdict.proceed).toBe(true);
    if (verdict.proceed) {
      expect(verdict.notes.length).toBeGreaterThan(0);
      for (const note of verdict.notes) expect(isEnglishAscii(note)).toBe(true);
    }
  });

  it('OFF（accessRequired="0"）: 検査を課さず proceed:true と安全側の既定を示す英語注記を返す（要件5.3）', () => {
    // OFF のときはプレースホルダ・型再生成未実行でも有効化前提を課さない（安全側の既定）。
    const input: PreflightInput = {
      accessRequired: "0",
      teamDomain: TEAM_DOMAIN_PLACEHOLDER,
      policyAud: POLICY_AUD_PLACEHOLDER,
      typegen: { ran: false },
    };

    const verdict = accessEnablementPreflight(input);

    expect(verdict.proceed).toBe(true);
    if (verdict.proceed) {
      expect(verdict.notes.length).toBeGreaterThan(0);
      // 「OFF に留まる／前提条件を課さない（安全側の既定）」旨の英語注記。
      expect(verdict.notes.some((n) => n.includes("OFF") && n.includes("safe default"))).toBe(true);
      for (const note of verdict.notes) expect(isEnglishAscii(note)).toBe(true);
    }
  });
});
