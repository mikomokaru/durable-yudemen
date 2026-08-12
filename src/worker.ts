import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { isValidStoreId } from "./registry/slug";
import type { Identity } from "./registry/ideal";
import { isAdminAuthorized, isOrderIngressAuthorized } from "./worker-auth";
import { type EntryDestination, resolveEntryDestination } from "./worker-entry";
import { REGISTRY_NAME, StoreRegistryDO } from "./shell/store-registry-do";
import { IDENTITY_HEADER, StoreTimerDO } from "./shell/store-timer-do";

// Durable Object クラスは Worker から re-export してランタイムに公開する（登録の唯一の出所）
export { StoreRegistryDO, StoreTimerDO };

// 店舗宛先パス（Store_Path）— 宛先はパスのみで運ぶ（identity から導出しない・要件1.1）。
//   /s/{storeId}/ws  … WebSocket 接続
//   /s/{storeId}/    … 画面・SPA（配下の client ルートを含む）
// storeId 断片は生のまま切り出し、ルーティング前段で isValidStoreId により検証する。
// Order_Ingress（POST /s/{storeId}/orders・online-cook-scheduling 要件1）。POS がオーダーの到着・キャンセルを
// 届ける認可付き経路。画面パターンより前に照合する（STORE_SCREEN_PATTERN はこのパスにも当たるため）。
const STORE_WS_PATTERN = /^\/s\/([^/]+)\/ws$/;
const STORE_ORDERS_PATTERN = /^\/s\/([^/]+)\/orders$/;
const STORE_SCREEN_PATTERN = /^\/s\/([^/]+)(?:\/.*)?$/;

// 認可の純粋ロジック（isAdminAuthorized / timingSafeEqual）は src/worker-auth.ts へ隔離した。
// Worker エントリは cloudflare:workers を DO の re-export 経由で引き込むため、既定 pool での純粋な
// property 検証（Property 21）が DO ランタイムに阻まれないよう、判定ロジックを端に寄せる（構造の主権）。

// Access JWT 検証（jose・Cloudflare 前提 4 / 要件8.5・8.6）。ACCESS_REQUIRED が ON のときのみ経路に入る。
// JWKS のエンドポイント（Access が公開する署名鍵）。TEAM_DOMAIN 配下の固定パス。
const ACCESS_CERTS_PATH = "/cdn-cgi/access/certs";

// createRemoteJWKSet は内部に署名鍵のキャッシュを持つ。跨リクエストで再利用するためモジュールスコープに保持する
// （毎リクエストで新規生成すると鍵取得が走りキャッシュが効かない）。env は module load 時には手に入らないため、
// TEAM_DOMAIN をキーに遅延生成・メモ化する（team が変われば張り直す）。
let cachedJwks: { readonly teamDomain: string; readonly jwks: ReturnType<typeof createRemoteJWKSet> } | null = null;

function accessJwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  if (cachedJwks?.teamDomain !== teamDomain) {
    cachedJwks = { teamDomain, jwks: createRemoteJWKSet(new URL(`${teamDomain}${ACCESS_CERTS_PATH}`)) };
  }
  return cachedJwks.jwks;
}

// 正準 identity クレームの選定は設計時確定事項（要件9.5・[Q7] の申し送り）。IdP 固有差を Access が JWT に
// 正規化して載せるため、人間可読で Roster の運用単位に一致する email を正準クレームとし、email を持たない
// サービス／端末アカウントは sub にフォールバックする。いずれも空・非文字列なら identity 不成立（null）。
function canonicalIdentity(payload: JWTPayload): Identity | null {
  const email = payload.email;
  if (typeof email === "string" && email.length > 0) {
    return email;
  }
  if (typeof payload.sub === "string" && payload.sub.length > 0) {
    return payload.sub;
  }
  return null;
}

/**
 * verifyAccessIdentity — `Cf-Access-Jwt-Assertion` を JWKS 署名検証し、正準 identity を返す（要件8.5 / 8.6）。
 *
 * ACCESS_REQUIRED が ON の経路でのみ呼ばれる。ヘッダ欠如・署名/issuer/audience/期限のいずれかの検証失敗・
 * 正準クレーム欠落はすべて null を返し、呼び出し元が 403 に落とす。未検証ヘッダを信用しないことが、
 * Worker 直叩きによる Access バイパスへの防御そのものである（真実は署名検証を通した identity のみ）。
 */
export async function verifyAccessIdentity(request: Request, env: Env): Promise<Identity | null> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    return null;
  }
  const teamDomain = env.TEAM_DOMAIN;
  try {
    const { payload } = await jwtVerify(token, accessJwks(teamDomain), {
      issuer: teamDomain,
      audience: env.POLICY_AUD,
    });
    return canonicalIdentity(payload);
  } catch {
    // 署名・issuer・audience・期限のいずれかが不正 → 未検証として扱う（呼び出し元が 403）
    return null;
  }
}

// Entry の行き先解決（EntryDestination / resolveEntryDestination）は cloudflare:workers・jose に依存しない
// 純粋ロジックゆえ src/worker-entry.ts へ隔離した（既定 pool での Property 18 検証を DO ランタイムに阻ませない）。
// 既存の公開シンボルとの互換のため、ここから re-export する（worker.ts が唯一の公開面である契約を保つ）。
export { type EntryDestination, resolveEntryDestination };

/**
 * Worker 本体 — 極薄のエントリポイント。
 *
 * 宛先は URL パスで運ぶ（要件1.1）。店舗宛先 `/s/{storeId}/ws`（WebSocket）と `/s/{storeId}/`（画面・SPA）を
 * 対象店舗の DO へ委譲し、運用の Provisioning_API（`/admin/*`）は認可の上でシングルトンのレジストリへ素通しする。
 * それ以外は Entry（`/`）を含め Static Assets（React SPA）に委ねる（wrangler.jsonc の assets 設定）。
 * 設定投入は Provisioning_API → StoreRegistryDO → StoreTimerDO.applyProjection の一本に集約する（要件2.8）。
 * 配置を APAC（日本向けは apac-ne）へ寄せるため、名前引きは idFromName → get で行う。
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 店舗宛先（新経路・要件1.1）: /s/{storeId}/ws（WS）。storeId 検証をルーティングの前段に置き、
    // 不正・導出不能は 400 で DO へ到達させない（DEFAULT_STORE_ID へ落とさない・要件1.2）。
    const wsMatch = STORE_WS_PATTERN.exec(url.pathname);
    if (wsMatch) {
      const storeId = wsMatch[1] ?? "";
      if (!isValidStoreId(storeId)) {
        return new Response("Invalid storeId", { status: 400 });
      }
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }
      // 内部 identity ヘッダの偽装防御（要件8.6）: 店舗 DO へ検証済み identity を運ぶ内部ヘッダ
      // （IDENTITY_HEADER）は、クライアントが Worker へ直接送って Roster 認可を迂回しうる攻撃面である。
      // ゆえに転送前に「無条件で」除去する（ON / OFF のいずれでも・クライアント由来の同名ヘッダを決して透過しない）。
      // 除去後に Worker だけが、ON かつ署名検証成功時に限り、検証済み identity で付け直す（真実は署名を通した値のみ）。
      const forwarded = new Headers(request.headers);
      forwarded.delete(IDENTITY_HEADER);
      // Access バイパス防御（要件8.5 / 8.6）: ACCESS_REQUIRED が ON のときのみ Cf-Access-Jwt-Assertion を
      // JWKS 署名検証し、未検証（ヘッダ欠如・署名/issuer/audience 不正）は 403 で DO へ到達させない。
      // OFF（既定 "0"）は合鍵 URL のみで接続でき、この経路では identity を付与しない（DO 側 Roster ゲートは走らない）。
      if ((env.ACCESS_REQUIRED as string) === "1") {
        const identity = await verifyAccessIdentity(request, env);
        if (identity === null) {
          return new Response("Forbidden", { status: 403 });
        }
        // 検証済み identity のみを内部ヘッダへ載せ直す（この経路が唯一の付与元）。
        forwarded.set(IDENTITY_HEADER, identity);
      }
      // ヘッダは Request のままでは書き換えられないため、除去／付与済みヘッダで新しい Request を構成する。
      // `new Request(request, { headers })` は method / body を引き継ぎ、Upgrade ヘッダも保つため WS 昇格として有効なまま。
      const forwardedRequest = new Request(request, { headers: forwarded });
      // 名前から DO の ID を引き、locationHint で APAC 北東（日本向け）へ配置を寄せる（要件1.4）。
      // getByName は locationHint を受け取れないため idFromName → get の二段で引く。
      const id = env.STORE_TIMER_DO.idFromName(storeId);
      const stub = env.STORE_TIMER_DO.get(id, { locationHint: "apac-ne" });
      return stub.fetch(forwardedRequest);
    }

    // Order_Ingress（POST /s/{storeId}/orders・online-cook-scheduling AC 1.1）。POS からのオーダー到着・
    // キャンセルを受ける。Worker は認可（ORDER_INGRESS_TOKEN の定数時間照合）だけを担い、ボディの解釈・
    // 検証・400 応答は店舗 DO の receiveOrder に閉じる（Worker 極薄・/admin/* と同じ置き方）。
    // 鍵は ADMIN_TOKEN とは別の secret である——POS へ運用系の書き込み口（Provisioning_API）を開かない。
    // 不一致・欠如は 401 で DO へ到達させず、状態を一切変更しない。
    const ordersMatch = STORE_ORDERS_PATTERN.exec(url.pathname);
    if (ordersMatch) {
      if (!isOrderIngressAuthorized(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (request.method !== "POST") {
        return new Response("Expected POST", { status: 405 });
      }
      const storeId = ordersMatch[1] ?? "";
      if (!isValidStoreId(storeId)) {
        return new Response("Invalid storeId", { status: 400 });
      }
      // 内部 identity ヘッダは、この経路でも無条件で除去する（per-store-provisioning 要件8.6）。
      // POS は identity を運ばないため付け直しもしない。「クライアント由来の同名ヘッダを決して透過しない」は
      // 経路ごとの例外を作らないことで守られる不変であり、店舗 DO へ委譲するすべての経路がこれに従う。
      const forwarded = new Headers(request.headers);
      forwarded.delete(IDENTITY_HEADER);
      // WS 経路と同じく idFromName → get（locationHint）で APAC 北東へ配置を寄せる。
      const id = env.STORE_TIMER_DO.idFromName(storeId);
      const stub = env.STORE_TIMER_DO.get(id, { locationHint: "apac-ne" });
      return stub.fetch(new Request(request, { headers: forwarded }));
    }

    // 店舗宛先（新経路・要件1.1 / 1.3）: /s/{storeId}/（画面・SPA）。storeId を検証し、不正は 400。
    // 正当な storeId は静的アセット（React SPA）へフォールバックし、SPA が URL から storeId を読む。
    const screenMatch = STORE_SCREEN_PATTERN.exec(url.pathname);
    if (screenMatch) {
      const storeId = screenMatch[1] ?? "";
      if (!isValidStoreId(storeId)) {
        return new Response("Invalid storeId", { status: 400 });
      }
      return env.ASSETS.fetch(request);
    }

    // Provisioning_API（新経路・要件2.8 / 2.9 / 8.1〜8.4）: チェーン・Policy・店舗イデアの外部投入と読み出し。
    //   PUT /admin/chains/{id}・PUT /admin/policies/{id}・POST /admin/stores・PUT /admin/stores/{id}・GET /admin/*
    // Worker は認可（ADMIN_TOKEN の定数時間比較）のみを担い、許可した Request をシングルトンのレジストリへ
    // 素通し委譲する（Worker 極薄）。ルート解釈・JSON パース・拒否型 400 応答はレジストリ fetch に閉じる。
    // 未設定（空）・不一致は 401 でレジストリへ到達させない（書き込み口を広く晒さない・要件8.2 / 8.3）。
    // 設定投入経路は Provisioning_API → StoreRegistryDO → StoreTimerDO の一本（要件2.8）。旧 /admin/config の
    // 直接委譲は撤去済みで、未定義のルートはレジストリ fetch が 404 を返す（レジストリが唯一の解釈者）。
    if (url.pathname.startsWith("/admin/")) {
      if (!isAdminAuthorized(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }
      // シングルトンゆえ locationHint 非対応の getByName で一意に addressing する（magic string は使わない）。
      const stub = env.STORE_REGISTRY_DO.getByName(REGISTRY_NAME);
      return stub.fetch(request);
    }

    // 店舗切替リストの受け渡し（GET /entry/stores・要件7.4）。複数店舗担当（SV・本部）向けの切替 UI が
    // SPA から取得する。302（Entry のリダイレクト）はボディを運べないため、切替の選択肢はこの JSON 経路で渡す。
    // Access ON のときだけ JWT 検証 → 逆引きで identity の接続可能店舗を (storeId, name)[] で返す（低頻度・
    // ホットパス分離・要件7.7）。OFF（既定 "0"）は Entry の行き先解決を提供しない（要件7.8）ため、切替リストも
    // 供さず 404 を返す（Entry `/` の OFF 挙動と揃える）。表示は name を使う——storeId はスラッグゆえ（要件7.4）。
    if (url.pathname === "/entry/stores") {
      if ((env.ACCESS_REQUIRED as string) !== "1") {
        return new Response("Not found", { status: 404 });
      }
      const identity = await verifyAccessIdentity(request, env);
      if (identity === null) {
        // 未検証（ヘッダ欠如・署名/issuer/audience 不正）は 403（要件8.6・Access バイパス防御）。
        return new Response("Forbidden", { status: 403 });
      }
      // レジストリの逆引き（保持済みインデックスの単一読み出し・低頻度・要件7.4 / 7.7）。
      const stub = env.STORE_REGISTRY_DO.getByName(REGISTRY_NAME);
      const choices = await stub.storeChoicesForIdentity(identity);
      return Response.json(choices);
    }

    // Entry（共通 URL `/`・要件7.1〜7.5）。PWA の start_url はこの 1 個に固定する（配布単位は店舗数に依存しない）。
    // ACCESS_REQUIRED が ON のときのみ、認証済み identity の行き先を逆引きで解決してリダイレクトする（要件7.2）。
    // OFF（既定 "0"）は Entry の行き先解決を提供せず、SPA へフォールバックする（前回使用店のクライアント側直行に
    // 委ねる・要件7.8。タスク 6.6）。逆引き RPC は Entry（起動時・低頻度）に限り、WS 経路（高頻度）では呼ばない
    // （ホットパス分離・要件7.7）。
    if (url.pathname === "/" && (env.ACCESS_REQUIRED as string) === "1") {
      const identity = await verifyAccessIdentity(request, env);
      if (identity === null) {
        // 未検証（ヘッダ欠如・署名/issuer/audience 不正）は 403（要件8.6・Access バイパス防御）。
        return new Response("Forbidden", { status: 403 });
      }
      // レジストリの逆引き（保持済みインデックスの単一読み出し・低頻度・要件7.2 / 7.7）。
      const stub = env.STORE_REGISTRY_DO.getByName(REGISTRY_NAME);
      const stores = await stub.storesForIdentity(identity);
      const destination = resolveEntryDestination(stores);
      if (destination.kind === "none") {
        // 0 店舗 → 接続先なし。いかなる店舗へもフォールバックしない（要件7.5）。
        return new Response("No store", { status: 404 });
      }
      // 1 店舗・複数店舗（既定店＝登録順の先頭）いずれも当該 Store_Path へリダイレクトする（要件7.3 / 7.4）。
      return Response.redirect(new URL(`/s/${destination.storeId}/`, url), 302);
    }

    // 静的アセット（React SPA）へフォールバック
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
