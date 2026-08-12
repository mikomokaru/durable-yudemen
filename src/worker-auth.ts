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
 * Order_Ingress の認可が依存する env の最小面。ADMIN_TOKEN とは**別の secret** である（要件1 の確定注記）。
 *
 * POS は設定を投入する主体ではない。Provisioning_API の鍵を POS ベンダへ渡せば、オーダーを届けるだけの
 * 相手に運用系の書き込み口（チェーン・Policy・店舗イデアの全置換）まで開いてしまう。ゆえに鍵を分ける。
 */
export interface OrderIngressAuthEnv {
  readonly ORDER_INGRESS_TOKEN?: string;
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
 * `Authorization: Bearer <token>` を期待値と定数時間で照合する芯。公開しない。
 *
 * トークン未設定（空）の環境では常に不許可（誤って無認証で公開しない安全側の既定）。
 * 抽出の判断（design-philosophy「抽象は重複が実在してから入れる」）：鍵の異なる 2 経路
 * （Provisioning_API と Order_Ingress）が同じ照合を要し、重複が実在した時点で芯を寄せた。公開シンボルは
 * 経路ごとの述語のまま残す——呼び出し側が「どの鍵で守られた経路か」を名前で読めることが認可の可読性の芯である。
 */
function isBearerAuthorized(request: Request, expected: string): boolean {
  if (expected.length === 0) return false;
  const header = request.headers.get("Authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return timingSafeEqual(header.slice(prefix.length), expected);
}

/**
 * 運用エンドポイントの認可。env シークレット ADMIN_TOKEN と Authorization: Bearer <token> を定数時間で照合する。
 */
export function isAdminAuthorized(request: Request, env: AdminAuthEnv): boolean {
  return isBearerAuthorized(request, env.ADMIN_TOKEN ?? "");
}

/**
 * Order_Ingress の認可（AC 1.1）。env シークレット ORDER_INGRESS_TOKEN と Bearer トークンを定数時間で照合する。
 * 不一致・欠如は呼び出し側が 401 に写し、店舗 DO へ一切到達させない（認可されない要求は状態を変更しない）。
 */
export function isOrderIngressAuthorized(request: Request, env: OrderIngressAuthEnv): boolean {
  return isBearerAuthorized(request, env.ORDER_INGRESS_TOKEN ?? "");
}
