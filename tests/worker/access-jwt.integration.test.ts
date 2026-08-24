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
// JWKS 取得の差し替えと鍵ペアの発行は tests/worker/support/accessJwt.ts が供する（据え付けの理由と
// TEAM_DOMAIN を一意採番する理由はそこに一箇所だけ書いてある）。
//
// 二段で押さえる：
//   1) verifyAccessIdentity（純粋な検証境界）を直接叩き、有効→identity（email）、無効（署名／aud／iss）・欠如→null。
//   2) Worker の default fetch（実経路・ACCESS ON）で `/s/{storeId}/ws` を通し、有効→店舗 DO へ到達（101・
//      identity 引き渡し成立）、無効・欠如→403（DO へ到達させない）。

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env, reset } from "cloudflare:test";
import worker, { verifyAccessIdentity } from "../../src/worker";
import type { StoreTimerDO } from "../../src/shell/store-timer-do";
import type { StoreProjection } from "../../src/registry/projection";
import type { NonEmptyArray } from "../../src/domain/timer";
import type { NoodlePreset, StoreConfig } from "../../src/domain/store";
import { configResidualDefaults } from "../storeConfigDefaults";
import { establishAccessSigning, freshTeamDomain, POLICY_AUD, type AccessSigning } from "./support/accessJwt";

// cloudflare:test の env を本 Worker の Env 型で解決する（STORE_TIMER_DO を型付きで引く）。
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// run 間で DO 状態が持ち越さないよう storeId を一意採番する（[a-z0-9-]・長さ 1..64 を満たす・要件1.2）。
function freshStoreId(): string {
  return `access-jwt-${crypto.randomUUID()}`;
}

// Access の署名鍵集合（正規鍵は JWKS に載り、rogue 鍵は載らない）。鍵発行は非同期ゆえ beforeAll で確立する。
let access: AccessSigning;

beforeAll(async () => {
  access = await establishAccessSigning();
});

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
    ...configResidualDefaults(3),
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
    access.stubCertsFetch();
    const token = await access.mintToken({
      issuer: teamDomain,
      audience: POLICY_AUD,
      email: "cook@store.example",
    });

    const identity = await verifyAccessIdentity(requestWithToken(token), accessEnv(teamDomain));

    expect(identity).toBe("cook@store.example");
  });

  it("無効トークン（JWKS に無い別鍵で署名＝署名検証失敗）は null を返す", async () => {
    const teamDomain = freshTeamDomain();
    access.stubCertsFetch();
    // rogue 鍵で署名する（kid も JWKS に無いものになる）→ 一致鍵なし／署名検証失敗で拒否。
    const token = await access.mintToken({
      signedBy: "rogue",
      issuer: teamDomain,
      audience: POLICY_AUD,
      email: "cook@store.example",
    });

    const identity = await verifyAccessIdentity(requestWithToken(token), accessEnv(teamDomain));

    expect(identity).toBeNull();
  });

  it("無効トークン（audience 不一致）は null を返す", async () => {
    const teamDomain = freshTeamDomain();
    access.stubCertsFetch();
    const token = await access.mintToken({
      issuer: teamDomain,
      audience: "someone-elses-app", // POLICY_AUD と異なる → aud 検証失敗
      email: "cook@store.example",
    });

    const identity = await verifyAccessIdentity(requestWithToken(token), accessEnv(teamDomain));

    expect(identity).toBeNull();
  });

  it("無効トークン（issuer 不一致）は null を返す", async () => {
    const teamDomain = freshTeamDomain();
    access.stubCertsFetch();
    const token = await access.mintToken({
      issuer: "https://attacker.cloudflareaccess.test", // TEAM_DOMAIN と異なる → iss 検証失敗
      audience: POLICY_AUD,
      email: "cook@store.example",
    });

    const identity = await verifyAccessIdentity(requestWithToken(token), accessEnv(teamDomain));

    expect(identity).toBeNull();
  });

  it("トークン欠如（Cf-Access-Jwt-Assertion ヘッダ無し）は null を返す", async () => {
    const teamDomain = freshTeamDomain();
    access.stubCertsFetch();

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
    access.stubCertsFetch();
    const token = await access.mintToken({
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
    access.stubCertsFetch();
    const token = await access.mintToken({
      signedBy: "rogue",
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
    access.stubCertsFetch();

    const response = await connect(storeId, teamDomain, null);

    expect(response.status).toBe(403);
    expect(response.webSocket).toBeNull();
  });
});
