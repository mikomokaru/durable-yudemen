// tests/worker/access-jwt.integration.test.ts — Access JWT 検証の統合テスト（Workers pool）。
//
// _Validates: Requirements 8.6_
//
// 検証する不変（要件8.6・design.md「Cloudflare 前提 4」/ Component 9）：
//   ACCESS_REQUIRED が ON のとき、Worker は `Cf-Access-Jwt-Assertion` を JWKS（`${TEAM_DOMAIN}/cdn-cgi/access/certs`）
//   で署名検証し、検証済み identity のみを店舗 DO へ引き渡す。トークン欠如・無効（署名／issuer／audience の
//   いずれかの不正）は 403 で DO へ到達させない（Worker 直叩きによる Access バイパスへの防御）。
//
// なぜ Workers pool か：この検証は jose/JWKS の外部挙動——リモート JWKS の取得と RS256 署名検証——を
// 実際に走らせて初めて意味を持つ（純粋関数では代替できない）。ゆえに実の鍵ペアを jose で発行し、
// verifyAccessIdentity が引く JWKS 取得（グローバル fetch）を、その公開鍵で構成した JWKS へ差し替える。
// crypto は一切偽装せず、本物の RS256 署名を本物の公開鍵で検証する。
//
// JWKS 取得の差し替え方針：worker.ts の `accessJwks` は `createRemoteJWKSet(new URL(...))` を customFetch
// 無しで生成するため、jose は既定のグローバル `fetch` で JWKS を取りに行く（jose v6 fetchJwks の既定 fetchImpl）。
// 本 pool 版（@cloudflare/vitest-pool-workers）は `fetchMock` を公開しないため、`vi.stubGlobal("fetch", …)` で
// グローバル fetch を差し替え、`${TEAM_DOMAIN}/cdn-cgi/access/certs` への GET にだけ JWKS JSON を返す
// （それ以外の外部 fetch は不許可＝例外）。worker.ts は JWKS を TEAM_DOMAIN でモジュールスコープに memo 化する
// ため、テストごとに一意の TEAM_DOMAIN を用いて memo・jose 内部キャッシュの持ち越しを断つ。
//
// 二段で押さえる：
//   1) verifyAccessIdentity（純粋な検証境界）を直接叩き、有効→identity（email）、無効（署名／aud／iss）・欠如→null。
//   2) Worker の default fetch（実経路・ACCESS ON）で `/s/{storeId}/ws` を通し、有効→店舗 DO へ到達（101・
//      identity 引き渡し成立）、無効・欠如→403（DO へ到達させない）。

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env, reset } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import worker, { verifyAccessIdentity } from "../../src/worker";
import type { StoreTimerDO } from "../../src/shell/store-timer-do";
import type { StoreProjection } from "../../src/registry/projection";
import type { NonEmptyArray } from "../../src/domain/timer";
import type { NoodlePreset, StoreConfig } from "../../src/domain/store";

// cloudflare:test の env を本 Worker の Env 型で解決する（STORE_TIMER_DO を型付きで引く）。
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// ── Access アプリの audience（JWT の aud 検証に用いる固定値）。TEAM_DOMAIN はテストごとに一意採番する。──
const POLICY_AUD = "yudemen-access-app-aud";
// Access 署名鍵の kid（JWKS に載る正規鍵）。無効署名テストは JWKS に載せない別鍵で署名する。
const SIGNING_KID = "access-signing-key";
const ROGUE_KID = "rogue-key";
// JWKS エンドポイントのパス（worker.ts の ACCESS_CERTS_PATH と一致）。stub はこのパスにだけ応答する。
const CERTS_PATH_SUFFIX = "/cdn-cgi/access/certs";

// テストごとに一意の TEAM_DOMAIN を採番し、worker.ts の JWKS memo（TEAM_DOMAIN キー）と jose の内部
// キャッシュ・cooldown の持ち越しを断つ（各ケースを独立させる）。issuer 検証もこの値に一致させる。
function freshTeamDomain(): string {
  return `https://team-${crypto.randomUUID()}.cloudflareaccess.test`;
}

// run 間で DO 状態が持ち越さないよう storeId を一意採番する（[a-z0-9-]・長さ 1..64 を満たす・要件1.2）。
function freshStoreId(): string {
  return `access-jwt-${crypto.randomUUID()}`;
}

// ── 実の RS256 鍵ペア。正規鍵は JWKS に載せ、rogue 鍵は載せない（無効署名の生成に使う）。──
let signingKey: CryptoKey; // JWKS に載る正規署名鍵の秘密鍵
let rogueKey: CryptoKey; // JWKS に載らない秘密鍵（署名検証を失敗させる）
let jwks: { readonly keys: readonly unknown[] }; // { keys: [ signingKey の公開 JWK ] }

beforeAll(async () => {
  // 本物の RS256 鍵ペアを 2 組発行する（公開鍵は JWK へ書き出すため extractable）。
  const signing = await generateKeyPair("RS256", { extractable: true });
  const rogue = await generateKeyPair("RS256", { extractable: true });
  signingKey = signing.privateKey;
  rogueKey = rogue.privateKey;
  // 正規鍵の公開 JWK だけを JWKS に載せる（Access が公開する署名鍵集合の模型）。
  const publicJwk = await exportJWK(signing.publicKey);
  jwks = { keys: [{ ...publicJwk, kid: SIGNING_KID, alg: "RS256", use: "sig" }] };
});

/**
 * mintToken — 本物の RS256 署名で JWT を発行する（crypto は偽装しない）。
 * kid で JWKS 内の鍵と対応づける。iss / aud / claim を任意に振り、検証の各失敗経路を作り分ける。
 */
async function mintToken(params: {
  readonly key: CryptoKey;
  readonly kid: string;
  readonly issuer: string;
  readonly audience: string;
  readonly email?: string;
  readonly sub?: string;
}): Promise<string> {
  const claims: Record<string, unknown> = {};
  if (params.email !== undefined) claims.email = params.email;
  const builder = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: params.kid })
    .setIssuer(params.issuer)
    .setAudience(params.audience)
    .setIssuedAt()
    .setExpirationTime("2h");
  if (params.sub !== undefined) builder.setSubject(params.sub);
  return builder.sign(params.key);
}

/**
 * stubJwksFetch — グローバル fetch を差し替え、`${TEAM_DOMAIN}/cdn-cgi/access/certs` への GET にだけ
 * JWKS JSON（200）を返す。それ以外の外部 fetch は不許可（例外）で、想定外の越境を検出する。
 */
function stubJwksFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const href =
        typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (href.endsWith(CERTS_PATH_SUFFIX)) {
        return new Response(JSON.stringify(jwks), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`予期しない外部 fetch: ${href}`);
    }),
  );
}

/** verifyAccessIdentity 用の Env を、TEAM_DOMAIN / POLICY_AUD だけ差し替えて構成する（他バインディングは実 env を継承）。 */
function accessEnv(teamDomain: string): Env {
  // wrangler types は vars を既定値の literal 型（"0" / "<access-app-aud>" 等）で生成するため、実値へ
  // 差し替えると literal が重ならず as Env が弾かれる。worker は実行時に string として読む（env.X as string）
  // ため、テストでは unknown 経由で Env へ写す（実行時の値だけが意味を持つ）。
  return { ...env, TEAM_DOMAIN: teamDomain, POLICY_AUD } as unknown as Env;
}

/** Cf-Access-Jwt-Assertion を任意で載せた Request（unit 検証用・宛先は検証に無関係）。 */
function requestWithToken(token: string | null): Request {
  const headers = new Headers();
  if (token !== null) headers.set("Cf-Access-Jwt-Assertion", token);
  return new Request("https://do.invalid/", { headers });
}

/** 値域内の完全な StoreConfig（プロビジョニング用）。 */
function config(): StoreConfig {
  return {
    unitCount: 3,
    arms: 3,
    toleranceRatio: 10,
    noodlePresets: [
      { noodleType: "thin", boilSeconds: { extraHard: 45, hard: 52, normal: 60, soft: 75 } },
    ] as NonEmptyArray<NoodlePreset>,
  };
}

/** 指定 identity を Roster に持つ活性投影を applyProjection で押し込み、店舗をプロビジョニングする。 */
async function provisionStore(storeId: string, roster: readonly string[]): Promise<void> {
  const id = env.STORE_TIMER_DO.idFromName(storeId);
  const stub = env.STORE_TIMER_DO.get(id) as unknown as DurableObjectStub<StoreTimerDO>;
  const projection: StoreProjection = { config: config(), roster, active: true, version: 1 };
  await stub.applyProjection(projection);
}

describe("worker/verifyAccessIdentity — JWKS 署名検証（Requirements 8.6）", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await reset();
  });

  it("有効トークン（正規鍵・正 issuer・正 audience・email あり）は検証済み identity（email）を返す", async () => {
    const teamDomain = freshTeamDomain();
    stubJwksFetch();
    const token = await mintToken({
      key: signingKey,
      kid: SIGNING_KID,
      issuer: teamDomain,
      audience: POLICY_AUD,
      email: "cook@store.example",
    });

    const identity = await verifyAccessIdentity(requestWithToken(token), accessEnv(teamDomain));

    expect(identity).toBe("cook@store.example");
  });

  it("無効トークン（JWKS に無い別鍵で署名＝署名検証失敗）は null を返す", async () => {
    const teamDomain = freshTeamDomain();
    stubJwksFetch();
    // rogue 鍵で署名し、kid も JWKS に無いものにする → 一致鍵なし／署名検証失敗で拒否。
    const token = await mintToken({
      key: rogueKey,
      kid: ROGUE_KID,
      issuer: teamDomain,
      audience: POLICY_AUD,
      email: "cook@store.example",
    });

    const identity = await verifyAccessIdentity(requestWithToken(token), accessEnv(teamDomain));

    expect(identity).toBeNull();
  });

  it("無効トークン（audience 不一致）は null を返す", async () => {
    const teamDomain = freshTeamDomain();
    stubJwksFetch();
    const token = await mintToken({
      key: signingKey,
      kid: SIGNING_KID,
      issuer: teamDomain,
      audience: "someone-elses-app", // POLICY_AUD と異なる → aud 検証失敗
      email: "cook@store.example",
    });

    const identity = await verifyAccessIdentity(requestWithToken(token), accessEnv(teamDomain));

    expect(identity).toBeNull();
  });

  it("無効トークン（issuer 不一致）は null を返す", async () => {
    const teamDomain = freshTeamDomain();
    stubJwksFetch();
    const token = await mintToken({
      key: signingKey,
      kid: SIGNING_KID,
      issuer: "https://attacker.cloudflareaccess.test", // TEAM_DOMAIN と異なる → iss 検証失敗
      audience: POLICY_AUD,
      email: "cook@store.example",
    });

    const identity = await verifyAccessIdentity(requestWithToken(token), accessEnv(teamDomain));

    expect(identity).toBeNull();
  });

  it("トークン欠如（Cf-Access-Jwt-Assertion ヘッダ無し）は null を返す", async () => {
    const teamDomain = freshTeamDomain();
    stubJwksFetch();

    const identity = await verifyAccessIdentity(requestWithToken(null), accessEnv(teamDomain));

    expect(identity).toBeNull();
  });
});

describe("worker fetch — ACCESS ON の /s/{storeId}/ws は有効時のみ店舗 DO へ到達し、無効・欠如は 403（Requirements 8.6）", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await reset();
  });

  /** ACCESS ON の Worker 経路で WS 接続を試みる。JWT 検証は Worker 端（testEnv）で走る。 */
  async function connect(storeId: string, teamDomain: string, token: string | null): Promise<Response> {
    const headers = new Headers({ Upgrade: "websocket" });
    if (token !== null) headers.set("Cf-Access-Jwt-Assertion", token);
    const request = new Request(`https://access.invalid/s/${storeId}/ws`, { headers });
    // ACCESS_REQUIRED を "1" に上書きし、実 TEAM_DOMAIN / POLICY_AUD を差し込んだ env で Worker を駆動する
    // （DO バインディングは実 env から継承）。JWT 検証は Worker 端で完結する（要件8.6 の防御点）。
    // vars の literal 型（ACCESS_REQUIRED "0" / POLICY_AUD 等）を実値へ差し替えるため unknown 経由で写す
    // （worker は実行時に string として読む）。DO バインディングは実 env から継承する。
    const testEnv = { ...env, ACCESS_REQUIRED: "1", TEAM_DOMAIN: teamDomain, POLICY_AUD } as unknown as Env;
    return worker.fetch(request, testEnv);
  }

  it("有効トークンは店舗 DO へ到達し WS 昇格（101）する（検証済み identity の引き渡しが成立）", async () => {
    const storeId = freshStoreId();
    const teamDomain = freshTeamDomain();
    // 店舗をプロビジョニング（active・Roster は本経路の到達可否には影響しないが、健全な投影で materialize する）。
    await provisionStore(storeId, ["cook@store.example"]);
    stubJwksFetch();
    const token = await mintToken({
      key: signingKey,
      kid: SIGNING_KID,
      issuer: teamDomain,
      audience: POLICY_AUD,
      email: "cook@store.example",
    });

    const response = await connect(storeId, teamDomain, token);

    // 有効時のみ Worker は検証済み identity を内部ヘッダへ載せて店舗 DO へ引き渡す。DO は WS 昇格で応じる。
    expect(response.status).toBe(101);
    expect(response.webSocket).not.toBeNull();
    // client 端を accept してから閉じる（未 accept の WebSocket は close 前に送受信できず TypeError になる）。
    response.webSocket?.accept();
    response.webSocket?.close();
  });

  it("無効トークン（署名検証失敗）は 403 で店舗 DO へ到達させない", async () => {
    const storeId = freshStoreId();
    const teamDomain = freshTeamDomain();
    await provisionStore(storeId, ["cook@store.example"]);
    stubJwksFetch();
    const token = await mintToken({
      key: rogueKey,
      kid: ROGUE_KID,
      issuer: teamDomain,
      audience: POLICY_AUD,
      email: "cook@store.example",
    });

    const response = await connect(storeId, teamDomain, token);

    expect(response.status).toBe(403);
    expect(response.webSocket).toBeNull();
  });

  it("トークン欠如は 403 で店舗 DO へ到達させない", async () => {
    const storeId = freshStoreId();
    const teamDomain = freshTeamDomain();
    await provisionStore(storeId, ["cook@store.example"]);
    stubJwksFetch();

    const response = await connect(storeId, teamDomain, null);

    expect(response.status).toBe(403);
    expect(response.webSocket).toBeNull();
  });
});
