// src/worker-auth.ts — Provisioning_API の認可に用いる純粋なトークン照合ロジック。
//
// 構造の主権（design-philosophy.md）に従い、認可判定を Worker エントリ（cloudflare:workers を
// DO の re-export 経由で引き込む src/worker.ts）から切り離し、プラットフォーム非依存の純粋関数として
// ここに閉じる。これにより既定 pool（node）での property 検証が、DO ランタイムを起こさずに行える。
// 名は naming ゲート通過済みの確定シンボル（timingSafeEqual / isAdminAuthorized）をそのまま保つ。

/**
 * 認可判定が依存する env の最小面。ADMIN_TOKEN は secret であり、wrangler types が .dev.vars 非依存の
 * CI では生成 Env に含めないため、生成 Env への依存を避けて「任意の ADMIN_TOKEN を持つ何か」に緩める。
 * 完全な Env はこの形へ構造的に代入可能（余剰プロパティは許容される）。
 */
export interface AdminAuthEnv {
  readonly ADMIN_TOKEN?: string;
}

/**
 * 定数時間の文字列比較。タイミング差から正解トークンを推測されないよう、長さの一致・不一致に関わらず
 * 全文字を走査して差分を畳む。認証トークンの照合という、漏れたら全店舗設定を奪われる経路で用いる。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  // 長さが異なっても早期 return せず、固定長（a 基準）を走査して長さ差自体も不一致へ織り込む。
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i % b.length);
  }
  return mismatch === 0;
}

/**
 * 運用エンドポイントの認可。env シークレット ADMIN_TOKEN と Authorization: Bearer <token> を定数時間で照合する。
 * トークン未設定（空）の環境では常に不許可（誤って無認証で公開しない安全側の既定）。
 */
export function isAdminAuthorized(request: Request, env: AdminAuthEnv): boolean {
  const expected = env.ADMIN_TOKEN ?? "";
  if (expected.length === 0) return false;
  const header = request.headers.get("Authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return timingSafeEqual(header.slice(prefix.length), expected);
}
