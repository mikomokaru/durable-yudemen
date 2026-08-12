// tests/worker/roster-gate-synthetic-nonmatch.integration.test.ts
// 合成 email 非一致 → 403（既存 Roster ゲートの帰結）の作動確認（Workers pool）。
//
// _Validates: Requirements 4.2, 6.5_
//
// 確認する不変（要件4.2 / 6.5・design.md「Error Handling B」/ Correctness Properties 冒頭の引き算方針）：
//   ACCESS_REQUIRED="1" の本番構成下で、合成 email 形式（`staff-{店舗コード}@yamaokaya.com`）でない
//   identity ——すなわちどの Roster 正準形にも一致しない email——を載せた有効な JWT による
//   `/s/{storeId}/ws` 接続は、既存の Roster ゲート（store-timer-do.ts の isRostered）の帰結として 403 で
//   拒否され、店舗 DO の状態を一切変えない。
//
// この 403 は Worker の JWT 検証失敗による 403（access-jwt.integration.test.ts が担う）ではない。JWT は
// 正規鍵・正 issuer・正 audience で「検証に成功」し、Worker は検証済み identity を IDENTITY_HEADER に載せて
// 店舗 DO へ転送する。403 を返すのは店舗 DO 側の Roster ゲートである——検証済み identity（非合成 email）が
// 実効 Roster（合成 email の集合）のどの正準形にも一致しないため isRostered が false を返す。
//
// 新たな形式バリデーションは足さない（要件10.1・引き算）。壊れた／非合成の email が「どの Roster にも
// 一致しない」という帰結を既存ゲートがそのまま拒否することを、end-to-end の HTTP 結果（403）と DO 状態の
// 不変で確認するのみ。normalize / isRostered のロジック自体は per-store-provisioning で PBT 済みゆえ再検証しない。
//
// なぜ Workers pool で end-to-end に通すか：Roster ゲートは店舗 DO（StoreTimerDO）の実 fetch 経路に宿り、
// 実 storage・実 acceptWebSocket 前段の判定として作動する。Worker → 店舗 DO の実配線（idFromName → get →
// stub.fetch）を workerd 上で通して初めて「非合成 email の JWT が 403 に落ち、DO へ書き込みも WS 収容も
// 起こさない」という本番構成の帰結を確かめられる。
//
// ACCESS_REQUIRED の env override について：worker.fetch に渡す env と、店舗 DO の this.env は
// vitest-pool-workers の単一 isolate 上で同一の bindings オブジェクトを参照する。Worker 端の JWT 検証も
// 店舗 DO 端の Roster 判定も同じ ACCESS_REQUIRED を読むため、共有 env を "1"（本番 ON）へその場で書き換えて
// 両端を同時に本番構成にする（テスト後に元値へ戻す）。JWT/JWKS の据え付けは access-jwt.integration.test.ts の
// 確立手法（実 RS256 鍵ペア＋certs エンドポイントへの fetch 差し替え）を踏襲する（crypto は偽装しない）。

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env, reset, runInDurableObject } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import worker from "../../src/worker";
import type { StoreTimerDO } from "../../src/shell/store-timer-do";
import type { StoreProjection } from "../../src/registry/projection";
import type { StoreSnapshot } from "../../src/engine/snapshot";
import type { NonEmptyArray } from "../../src/domain/timer";
import type { NoodlePreset, StoreConfig } from "../../src/domain/store";
import { schedulingDefaults } from "../storeConfigDefaults";

// cloudflare:test の env を本 Worker の Env 型で解決する（STORE_TIMER_DO を型付きで引く）。
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// ── Access アプリの audience（JWT の aud 検証に用いる固定値）。TEAM_DOMAIN はケースごとに一意採番する。──
const POLICY_AUD = "yudemen-access-app-aud";
// Access 署名鍵の kid（JWKS に載る正規鍵）。
const SIGNING_KID = "access-signing-key";
// JWKS エンドポイントのパス（worker.ts の ACCESS_CERTS_PATH と一致）。stub はこのパスにだけ応答する。
const CERTS_PATH_SUFFIX = "/cdn-cgi/access/certs";

// 店舗 DO の永続キー（store-timer-do.ts の private 定数と一致させる。状態不変の直接観測に用いる）。
const PROJECTION_KEY = "projection";
const SNAPSHOT_KEY = "activeTimers";

// プロビジョニングする店舗の実効 Roster。すべて合成 email 形式（`staff-{店舗コード}@yamaokaya.com`）で構成する。
// これに対し、非合成 email の JWT はどの正準形にも一致せず 403 になる（本テストの主眼）。
const SYNTHETIC_ROSTER = ["staff-1263@yamaokaya.com", "staff-9920@yamaokaya.com"] as const;

// 合成 email 形式でない（＝どの Roster 正準形にも一致しない）identity 群。有効な JWT の email クレームに載る。
//   - 実 email 風だが非合成（EntraID 系の未登録ユーザー相当）
//   - 合成のローカル部だがドメイン不一致（yamaokaya.com でない）
//   - @ を欠く壊れた文字列
//   - 合成風だが店舗コードを欠く壊れたローカル部
// いずれも「非合成 email はどの Roster にも一致しない」という既存ゲートの帰結を突く（新規検証は足さない）。
const NON_SYNTHETIC_IDENTITIES = [
  "manager@corp.example",
  "staff-1263@example.com",
  "broken-not-an-email",
  "staff-@yamaokaya.com",
] as const;

// ── 実の RS256 鍵ペア。正規鍵の公開 JWK だけを JWKS に載せる（Access が公開する署名鍵集合の模型）。──
let signingKey: CryptoKey;
let jwks: { readonly keys: readonly unknown[] };

// 本番 ON へ書き換える前の env 値を退避し、全ケース終了後に復元する（共有 env を汚したまま残さない）。
let originalAccessRequired: unknown;
let originalTeamDomain: unknown;
let originalPolicyAud: unknown;

beforeAll(async () => {
  const signing = await generateKeyPair("RS256", { extractable: true });
  signingKey = signing.privateKey;
  const publicJwk = await exportJWK(signing.publicKey);
  jwks = { keys: [{ ...publicJwk, kid: SIGNING_KID, alg: "RS256", use: "sig" }] };

  // 共有 env を本番 ON 構成へ書き換える。ACCESS_REQUIRED / POLICY_AUD は全ケース共通ゆえここで一度だけ。
  // TEAM_DOMAIN はケースごとに一意採番する（JWKS memo と jose 内部キャッシュの持ち越しを断つ）。
  // vars は wrangler types 上 literal 型（"0" 等）ゆえ、実行時 string としての書き換えを unknown 経由で行う。
  const mutableEnv = env as unknown as Record<string, unknown>;
  originalAccessRequired = mutableEnv.ACCESS_REQUIRED;
  originalTeamDomain = mutableEnv.TEAM_DOMAIN;
  originalPolicyAud = mutableEnv.POLICY_AUD;
  mutableEnv.ACCESS_REQUIRED = "1";
  mutableEnv.POLICY_AUD = POLICY_AUD;
});

afterAll(() => {
  const mutableEnv = env as unknown as Record<string, unknown>;
  mutableEnv.ACCESS_REQUIRED = originalAccessRequired;
  mutableEnv.TEAM_DOMAIN = originalTeamDomain;
  mutableEnv.POLICY_AUD = originalPolicyAud;
});

// ケースごとに一意の TEAM_DOMAIN を採番し、worker.ts の JWKS memo（TEAM_DOMAIN キー）と jose の内部
// キャッシュ・cooldown の持ち越しを断つ。issuer 検証もこの値に一致させる。
function freshTeamDomain(): string {
  return `https://team-${crypto.randomUUID()}.cloudflareaccess.test`;
}

// 共有 env の TEAM_DOMAIN をケースの値へ差し替える（Worker の JWT 検証がこの issuer/JWKS を引く）。
function setTeamDomain(teamDomain: string): void {
  (env as unknown as Record<string, unknown>).TEAM_DOMAIN = teamDomain;
}

// run 間で DO 状態が持ち越さないよう storeId を一意採番する（[a-z0-9-]・長さ 1..64 を満たす・要件1.2）。
function freshStoreId(): string {
  return `roster-nonmatch-${crypto.randomUUID()}`;
}

/** mintToken — 本物の RS256 署名で有効な JWT を発行する（crypto は偽装しない）。email クレームを任意に振る。 */
async function mintToken(params: {
  readonly issuer: string;
  readonly audience: string;
  readonly email: string;
}): Promise<string> {
  return new SignJWT({ email: params.email })
    .setProtectedHeader({ alg: "RS256", kid: SIGNING_KID })
    .setIssuer(params.issuer)
    .setAudience(params.audience)
    .setIssuedAt()
    .setExpirationTime("2h")
    .sign(signingKey);
}

/** stubJwksFetch — グローバル fetch を差し替え、certs エンドポイントへの GET にだけ JWKS を返す（他は例外）。 */
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

/** 値域内の完全な StoreConfig（プロビジョニング用・接続可否には依らないが健全な値を置く）。 */
function config(): StoreConfig {
  return {
    unitCount: 3,
    arms: 3,
    toleranceRatio: 10,
    noodlePresets: [
      { noodleType: "thin", boilSeconds: { extraHard: 45, hard: 52, normal: 60, soft: 75 } },
    ] as NonEmptyArray<NoodlePreset>,
    ...schedulingDefaults(3),
  };
}

/** 指定 storeId の店舗 DO スタブ（applyProjection RPC・runInDurableObject の両方で使う）。 */
function storeStub(storeId: string): DurableObjectStub<StoreTimerDO> {
  const id = env.STORE_TIMER_DO.idFromName(storeId);
  return env.STORE_TIMER_DO.get(id) as unknown as DurableObjectStub<StoreTimerDO>;
}

/** 合成 email の実効 Roster を持つ活性投影（version 1）を applyProjection で押し込みプロビジョニングする。 */
async function provisionStore(storeId: string, roster: readonly string[]): Promise<void> {
  const projection: StoreProjection = { config: config(), roster, active: true, version: 1 };
  await storeStub(storeId).applyProjection(projection);
}

/** ACCESS ON の Worker 経路で WS 接続を試みる（JWT 検証は Worker 端、Roster 判定は店舗 DO 端で走る）。 */
async function connect(storeId: string, token: string): Promise<Response> {
  const headers = new Headers({ Upgrade: "websocket" });
  headers.set("Cf-Access-Jwt-Assertion", token);
  const request = new Request(`https://access.invalid/s/${storeId}/ws`, { headers });
  // 共有 env は本番 ON 構成（ACCESS_REQUIRED="1"・実 TEAM_DOMAIN / POLICY_AUD）へ書き換え済み。
  // 店舗 DO バインディングも同じ env から解決され、DO 端も同じ ACCESS_REQUIRED を読む。
  return worker.fetch(request, env);
}

/**
 * 接続拒否後の店舗 DO 状態が「一切変わっていない」ことを直接観測する（要件6.5「状態を一切変更しない」）。
 *   - 投影は provision 時のまま（active=true・version=1・実効 Roster は合成 email の集合）。
 *   - タイマー SSOT（activeTimers）は未書き込み（Roster ゲートは acceptWebSocket・書き込み経路の前段で拒否する）。
 *   - Alarm は張られていない。
 *   - hibernation 収容 WS は 0（WS 昇格に至っていない）。
 */
async function expectStoreUnchanged(storeId: string): Promise<void> {
  await runInDurableObject(storeStub(storeId), async (_instance, state) => {
    const projection = (await state.storage.get(PROJECTION_KEY)) as StoreProjection | undefined;
    expect(projection).toBeDefined();
    expect(projection?.active).toBe(true);
    expect(projection?.version).toBe(1);
    expect(projection?.roster).toEqual([...SYNTHETIC_ROSTER]);

    const snapshot = (await state.storage.get(SNAPSHOT_KEY)) as StoreSnapshot | undefined;
    expect(snapshot).toBeUndefined();

    expect(await state.storage.getAlarm()).toBeNull();
    expect(state.getWebSockets()).toHaveLength(0);
  });
}

describe("worker → 店舗 DO：非合成 email の有効 JWT は Roster ゲートで 403・状態不変（Requirements 4.2, 6.5）", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await reset();
  });

  for (const identity of NON_SYNTHETIC_IDENTITIES) {
    it(`非合成 email "${identity}" の有効 JWT は 403 で拒否され、店舗 DO は WS へ到達させず状態も変えない`, async () => {
      const storeId = freshStoreId();
      const teamDomain = freshTeamDomain();
      setTeamDomain(teamDomain);
      // 合成 email の実効 Roster でプロビジョニング（非合成 identity はここに一致しない）。
      await provisionStore(storeId, [...SYNTHETIC_ROSTER]);
      stubJwksFetch();
      // JWT 自体は正規鍵・正 issuer・正 audience で「検証に成功」する（Worker 端の 403 ではない）。
      const token = await mintToken({ issuer: teamDomain, audience: POLICY_AUD, email: identity });

      const response = await connect(storeId, token);

      // 店舗 DO の Roster ゲートが 403 を返す（isRostered が false・acceptWebSocket に至らない）。
      expect(response.status).toBe(403);
      expect(response.webSocket).toBeNull();
      // 拒否は店舗 DO の状態を一切変えない（書き込みゼロ・WS 収容ゼロ）。
      await expectStoreUnchanged(storeId);
    });
  }

  it("対照：合成 email（Roster 登録済み）の有効 JWT は Roster ゲートを通過し店舗 DO へ到達（101）する", async () => {
    // 403 が「Roster 非一致の帰結」であって「常に 403」ではないことを示す対照。登録済み合成 email は通過する。
    const storeId = freshStoreId();
    const teamDomain = freshTeamDomain();
    setTeamDomain(teamDomain);
    const rosteredIdentity = SYNTHETIC_ROSTER[0];
    await provisionStore(storeId, [...SYNTHETIC_ROSTER]);
    stubJwksFetch();
    const token = await mintToken({ issuer: teamDomain, audience: POLICY_AUD, email: rosteredIdentity });

    const response = await connect(storeId, token);

    // 実効 Roster に一致するため Roster ゲートを通過し、店舗 DO が WS 昇格（101）で応じる。
    expect(response.status).toBe(101);
    expect(response.webSocket).not.toBeNull();
    // client 端を accept してから閉じる（未 accept の WebSocket は close 前に送受信できず TypeError になる）。
    response.webSocket?.accept();
    response.webSocket?.close();
  });
});
