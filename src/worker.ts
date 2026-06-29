import { StoreTimerDO } from "./shell/store-timer-do";

// Durable Object クラスは Worker から re-export してランタイムに公開する
export { StoreTimerDO };

// 既定の店舗 ID（パイロットは 1 テナント 1 店舗）。
const DEFAULT_STORE_ID = "default";

/**
 * 定数時間の文字列比較。タイミング差から正解トークンを推測されないよう、長さの一致・不一致に関わらず
 * 全文字を走査して差分を畳む。認証トークンの照合という、漏れたら全店舗設定を奪われる経路で用いる。
 */
function timingSafeEqual(a: string, b: string): boolean {
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
function isAdminAuthorized(request: Request, env: Env): boolean {
  // ADMIN_TOKEN は secret。wrangler types は .dev.vars 非依存の CI では Env に含めないため、
  // 生成 Env への依存を避けてローカルにキャストする（未設定なら undefined → 下で不許可へ畳む）。
  const expected = (env as { readonly ADMIN_TOKEN?: string }).ADMIN_TOKEN ?? "";
  if (expected.length === 0) return false;
  const header = request.headers.get("Authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return timingSafeEqual(header.slice(prefix.length), expected);
}

/**
 * Worker 本体 — 極薄のエントリポイント（tasks.md タスク 14）。
 *
 * WebSocket アップグレード要求（/ws）と運用エンドポイント（PUT /admin/config）を対象店舗の DO へ委譲する。
 * それ以外は Static Assets（React）に委ねる（wrangler.jsonc の assets 設定）。
 * 配置を APAC（日本向けは apac-ne）へ寄せるため、名前引きは idFromName → get で行う。
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }
      // 名前から DO の ID を引き、locationHint で APAC 北東（日本向け）へ配置を寄せる。
      // getByName は locationHint を受け取れないため idFromName → get の二段で引く。
      const id = env.STORE_TIMER_DO.idFromName(DEFAULT_STORE_ID);
      const stub = env.STORE_TIMER_DO.get(id, { locationHint: "apac-ne" });
      return stub.fetch(request);
    }

    // 運用エンドポイント — サーバ権威の店舗設定（StoreConfig）の外部投入。認可は edge で済ませ、
    // 未認可要求は DO へ到達させない（書き込み口を広く晒さない）。許可後に対象店舗の DO へ委譲する。
    if (url.pathname === "/admin/config") {
      if (request.method !== "PUT") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "PUT" } });
      }
      if (!isAdminAuthorized(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const id = env.STORE_TIMER_DO.idFromName(DEFAULT_STORE_ID);
      const stub = env.STORE_TIMER_DO.get(id, { locationHint: "apac-ne" });
      return stub.fetch(request);
    }

    // 静的アセット（React SPA）へフォールバック
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
