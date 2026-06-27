import { StoreTimerDO } from "./shell/store-timer-do";

// Durable Object クラスは Worker から re-export してランタイムに公開する
export { StoreTimerDO };

// 既定の店舗 ID（パイロットは 1 テナント 1 店舗）。
const DEFAULT_STORE_ID = "default";

/**
 * Worker 本体 — 極薄のエントリポイント（tasks.md タスク 14）。
 *
 * WebSocket アップグレード要求のみ対象の DO へ委譲する。それ以外は
 * Static Assets（React）に委ねる（wrangler.jsonc の assets 設定）。
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

    // 静的アセット（React SPA）へフォールバック
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
