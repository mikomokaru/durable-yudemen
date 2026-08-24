// tests/worker/support/accessJwt.ts — Access JWT / JWKS の据え付けを共有する。
//
// Worker 端の Access 検証（verifyAccessIdentity）を実経路で通すテストは、いずれも同じ据え付けを要する
// ——実の RS256 鍵ペアを jose で発行し、`${TEAM_DOMAIN}/cdn-cgi/access/certs` への GET にだけ公開鍵 JWKS を
// 返すようグローバル fetch を差し替える（crypto は一切偽装せず、本物の署名を本物の公開鍵で検証させる）。
// 同じ据え付けが四つの統合テストに写されていたため、写しを作らずここ一箇所に置く。
//
// 利用者:
//   - tests/worker/access-jwt.integration.test.ts（要件8.6・JWKS 署名検証そのもの）
//   - tests/worker/identity-header.integration.test.ts（要件7.2 / 7.3・IDENTITY_HEADER の除去と付与）
//   - tests/worker/roster-gate-synthetic-nonmatch.integration.test.ts（要件4.2 / 6.5・Roster ゲートの帰結）
//   - tests/worker/entry-redirect.integration.test.ts（要件1.5 / 4.5 / 4.6・`/entry/` 配下のリダイレクト）
//
// JWKS 取得を fetch 差し替えで押さえる理由：worker.ts の `accessJwks` は `createRemoteJWKSet(new URL(...))` を
// customFetch 無しで生成するため、jose は既定のグローバル `fetch` で JWKS を取りに行く（jose v6 fetchJwks の
// 既定 fetchImpl）。@cloudflare/vitest-pool-workers は `fetchMock` を公開しないため、`vi.stubGlobal` で
// グローバル fetch を差し替える。

import { vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

/** Access アプリの audience（JWT の aud 検証に用いる固定値）。 */
export const POLICY_AUD = "yudemen-access-app-aud";

/** JWKS エンドポイントのパス（worker.ts の ACCESS_CERTS_PATH と一致）。stub はこのパスにだけ応答する。 */
export const CERTS_PATH_SUFFIX = "/cdn-cgi/access/certs";

/** JWKS に載る正規署名鍵の kid。 */
const SIGNING_KID = "access-signing-key";

/** JWKS に載らない鍵の kid（署名検証を失敗させるトークンに用いる）。 */
const ROGUE_KID = "rogue-key";

/**
 * ケースごとに一意の TEAM_DOMAIN を採番する。
 *
 * **なぜ一意採番するか：** worker.ts は JWKS を TEAM_DOMAIN キーでモジュールスコープに memo 化し、jose も
 * JWKS の内部キャッシュと再取得 cooldown を鍵集合ごとに抱える。TEAM_DOMAIN を固定すると、あるケースで
 * 取得された鍵集合と cooldown が次のケースへ持ち越され、fetch 差し替えが効かなくなる（あるいは前ケースの
 * 鍵で検証されてしまう）。ケース毎に別ドメインを名乗ることで、その持ち越しを断ち各ケースを独立させる。
 * issuer 検証もこの値に一致させる。
 */
export function freshTeamDomain(): string {
  return `https://team-${crypto.randomUUID()}.cloudflareaccess.test`;
}

/** どの鍵で署名するか。`access` は JWKS に載る正規鍵、`rogue` は JWKS に載らない鍵（署名検証は失敗する）。 */
export type SigningKeyChoice = "access" | "rogue";

/** Access の署名鍵集合を据えた上で、トークン発行と JWKS 応答の差し替えを供する。 */
export interface AccessSigning {
  /**
   * 本物の RS256 署名で JWT を発行する（crypto は偽装しない）。iss / aud / email クレームを任意に振り、
   * 検証の各経路を作り分ける。`signedBy` 既定は JWKS に載る正規鍵（`access`）。
   */
  readonly mintToken: (params: {
    readonly issuer: string;
    readonly audience: string;
    readonly email: string;
    readonly signedBy?: SigningKeyChoice;
  }) => Promise<string>;

  /**
   * グローバル fetch を差し替え、`${TEAM_DOMAIN}/cdn-cgi/access/certs` への GET にだけ JWKS JSON（200）を
   * 返す。それ以外の外部 fetch は不許可（例外）で、想定外の越境を検出する。
   * 呼び出し側は afterEach で `vi.unstubAllGlobals()` により戻す。
   */
  readonly stubCertsFetch: () => void;
}

/**
 * 実の RS256 鍵ペアを 2 組発行し、正規鍵の公開 JWK だけを載せた JWKS を構える
 * （Access が公開する署名鍵集合の模型）。もう 1 組は JWKS に載せず、署名検証失敗の生成に用いる。
 *
 * 鍵発行は非同期ゆえ、呼び出し側は `beforeAll` で一度確立して戻り値を保持する。
 */
export async function establishAccessSigning(): Promise<AccessSigning> {
  // 公開鍵を JWK へ書き出すため extractable で発行する。
  const signing = await generateKeyPair("RS256", { extractable: true });
  const rogue = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = await exportJWK(signing.publicKey);
  const jwks = { keys: [{ ...publicJwk, kid: SIGNING_KID, alg: "RS256", use: "sig" }] };

  return {
    async mintToken(params) {
      const rogueSigned = params.signedBy === "rogue";
      // 鍵と kid は常に対で選ぶ。鍵だけ／kid だけを差し替えた中間状態は作れない。
      return new SignJWT({ email: params.email })
        .setProtectedHeader({ alg: "RS256", kid: rogueSigned ? ROGUE_KID : SIGNING_KID })
        .setIssuer(params.issuer)
        .setAudience(params.audience)
        .setIssuedAt()
        .setExpirationTime("2h")
        .sign(rogueSigned ? rogue.privateKey : signing.privateKey);
    },

    stubCertsFetch() {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const href =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : (input as Request).url;
          if (href.endsWith(CERTS_PATH_SUFFIX)) {
            return new Response(JSON.stringify(jwks), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          throw new Error(`予期しない外部 fetch: ${href}`);
        }),
      );
    },
  };
}
