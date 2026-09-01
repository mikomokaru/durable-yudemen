// access-enablement.ts — Cloudflare Access 本番有効化の前提を判定する純粋述語（要件5.1〜5.3）。
//
// 「プレースホルダのまま ACCESS_REQUIRED を "1" にする」事故を、切替の前段で構造的に防ぐ。
// 構造の主権（design-philosophy.md）に従い、判定を cloudflare:workers・wrangler・I/O から切り離した
// プラットフォーム非依存の純粋関数としてここに閉じる（worker-auth.ts / worker-entry.ts と同型・端に寄せる）。
// これにより既定 pool（node）での property 検証が DO ランタイムを起こさず行え、作用（デプロイ中止・
// エラー提示・非ゼロ終了）は呼び出す CLI 側（tasks.md 3.1・tools/check-access-enablement.ts）へ寄る。
//
// 名は naming ゲート通過済みの確定シンボル（enablementReadiness / EnablementReadiness）をそのまま保つ。

import { isNonEmpty, type NonEmptyArray } from "./domain/timer";

/**
 * リポジトリ既定のプレースホルダ（wrangler.jsonc vars の正本）。実値投入前はこの文字列が残っており、
 * これと一致する限り「未投入」とみなして有効化を阻む。判定の唯一の出所としてここに一度だけ宣言する。
 */
const TEAM_DOMAIN_PLACEHOLDER = "https://<team>.cloudflareaccess.com";
const POLICY_AUD_PLACEHOLDER = "<access-app-aud>";

/** TEAM_DOMAIN 形式の固定辺（スキームと末尾ドメイン）。この2つに挟まれた部分がサブドメイン（実チーム名）。 */
const TEAM_DOMAIN_SCHEME = "https://";
const TEAM_DOMAIN_SUFFIX = ".cloudflareaccess.com";

/**
 * 妥当な DNS ラベル（サブドメイン部）の規則。文字集合 [a-z0-9-]・1〜63 文字・先頭/末尾ハイフン不可。
 * 長さ 1 は単独の英数字、長さ 2〜63 は英数字で挟み中間のみハイフンを許す（先頭 + 中間 ≤61 + 末尾 = 最大 63）。
 * タイポ版プレースホルダ `https://<myteam>.cloudflareaccess.com` の `<myteam>` は `<` `>` を含むため
 * この文字集合検査で弾かれる（長さ判定だけでは通過しうるため文字集合で縛るのが要点・要件5.1）。
 */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * InvalidVariable — 有効化不可のとき、どの変数がどう不正かを過不足なく示す診断の 1 単位（要件5.3）。
 *
 * 変数を判別子にした判別可能型で「あり得ない組み合わせ」を構築不能にする（不正な状態を表現可能にしない）:
 *   TEAM_DOMAIN は 空・プレースホルダ一致・形式不適合 の 3 通り、POLICY_AUD は 空・プレースホルダ一致 の 2 通り
 *   （POLICY_AUD に「形式不適合」はない）。empty は空文字・未設定（未投入）の双方を表す。
 */
export type InvalidVariable =
  | { readonly variable: "TEAM_DOMAIN"; readonly reason: "empty" | "placeholder" | "format" }
  | { readonly variable: "POLICY_AUD"; readonly reason: "empty" | "placeholder" };

/**
 * EnablementReadiness — 本番有効化に足る実値かの判定結果（判別可能型）。
 *
 * ready:false は必ず 1 件以上の不正変数を伴う（NonEmptyArray で型が強制する）。「有効化不可なのに理由なし」
 * という嘘を構築不能にし、不正変数を過不足なく含むという要件5.3 を型で表明する。
 */
export type EnablementReadiness =
  | { readonly ready: true }
  | { readonly ready: false; readonly invalid: NonEmptyArray<InvalidVariable> };

/**
 * enablementReadiness — TEAM_DOMAIN / POLICY_AUD が本番有効化に足る実値かを判定する純粋述語（要件5.1〜5.3）。
 *
 * TEAM_DOMAIN は「`https://` + DNS ラベル 1〜63 文字 + `.cloudflareaccess.com`・かつ既定プレースホルダと不一致」
 * のとき、かつそのときに限り適合。POLICY_AUD は「非空・既定プレースホルダ `<access-app-aud>` と不一致」のとき適合。
 * 両者が適合すれば ready、そうでなければ不正変数を診断に載せて not ready を返す。純粋・決定的（作用は端）。
 */
export function enablementReadiness(teamDomain: string, policyAud: string): EnablementReadiness {
  const invalid: InvalidVariable[] = [];

  const teamDomainReason = teamDomainDefect(teamDomain);
  if (teamDomainReason !== null)
    invalid.push({ variable: "TEAM_DOMAIN", reason: teamDomainReason });

  const policyAudReason = policyAudDefect(policyAud);
  if (policyAudReason !== null) invalid.push({ variable: "POLICY_AUD", reason: policyAudReason });

  return isNonEmpty(invalid) ? { ready: false, invalid } : { ready: true };
}

/** TEAM_DOMAIN の不正理由（適合なら null）。プレースホルダ一致は形式不適合より先に判定し、診断を「一致」に寄せる。 */
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

/** TEAM_DOMAIN の形式適合（スキーム・末尾ドメインの固定辺を剥がし、残るサブドメインが妥当な DNS ラベルか）。 */
function isTeamDomainWellFormed(teamDomain: string): boolean {
  if (!teamDomain.startsWith(TEAM_DOMAIN_SCHEME) || !teamDomain.endsWith(TEAM_DOMAIN_SUFFIX))
    return false;
  const subdomain = teamDomain.slice(
    TEAM_DOMAIN_SCHEME.length,
    teamDomain.length - TEAM_DOMAIN_SUFFIX.length,
  );
  return DNS_LABEL.test(subdomain);
}
