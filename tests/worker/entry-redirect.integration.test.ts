// tests/worker/entry-redirect.integration.test.ts — `/entry/` 配下のリダイレクト挙動の統合テスト（Workers pool）。
//
// _Validates: Requirements 1.5, 4.5, 4.6_
//
// **2 つの経路を同じファイルで並べる。** 一方は 3xx を返してはならず（`/entry/stores`）、他方は 302 を
// 返さなければならない（`/entry/signin/{storeId}`）。**同じ `/entry/` 配下で要求が正反対である**ため、
// 両者を並べて示すことが「新しい通し口が AC 1.5 の不変と衝突しない」ことの証明そのものになる。
//
// 検証する不変（要件1.5・design.md「判断 4」/ V-3）：
//   Worker は `GET /entry/stores` に対して **3xx を返さない**。ACCESS_REQUIRED の別・JWT の有無と妥当性を
//   問わず成り立つ。
//
// なぜこれを固定するか：Reachability_Probe は `fetch("/entry/stores", { redirect: "manual" })` の
// Opaque_Redirect（`type === "opaqueredirect"`）を Access_Redirect と見なして `signInRequired` を返す
// （要件1.3）。Opaque_Redirect は `Location` を読めず、かつオリジンを問わずあらゆる 3xx が同じ形になるため、
// Worker 自身がこの経路で 3xx を返し始めれば、それが黙って `signInRequired` へ化ける。分類の正しさが
// Worker 側の挙動に依存するという spec を跨いだ結合がここに在り、暗黙の前提を明示の防具へ格上げする。
//
// なぜ静的検査ではなく integration か（design 判断 4）：`src/worker.ts` の分岐を読む静的検査はリファクタで
// 壊れ、しかも**挙動を見ていない**。分類が依存しているのは挙動であって分岐の字面ではない。
//
// **主張は「3xx でないこと」に絞る。** 特定の status（404 / 403 / 200）の再検証は既存テストの仕事
// （access-jwt.integration.test.ts・entry.example.test.ts ほか）であり、ここが守るのは AC 1.3 が依存する
// 不変だけである。範囲を広げれば、既存の意味論を変えたときに本テストも巻き込んで落ちる。
//
// JWT／JWKS の据え付けは tests/worker/support/accessJwt.ts が供する（実の RS256 鍵ペアを jose で発行し、
// certs エンドポイントへの GET にだけ公開鍵 JWKS を返すようグローバル fetch を差し替える。crypto は偽装しない）。

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env, reset } from "cloudflare:test";
import worker from "../../src/worker";
import { establishAccessSigning, freshTeamDomain, POLICY_AUD, type AccessSigning } from "./support/accessJwt";

// cloudflare:test の env を本 Worker の Env 型で解決する。
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// 分類 fetch が叩く唯一の経路（要件1.4）。probeReachability の URL と同一である。
const STORES_PATH = "/entry/stores";

// Sign_In_Affordance の遷移先（要件4.5 / 4.6）。worker.ts の SIGNIN_ENTRY_PATH と一致する。
const SIGNIN_PATH = "/entry/signin/";

// 要求の起点。Location の絶対 URL を解決する基準にも用いる。
const ORIGIN = "https://entry.invalid";

// Access の署名鍵集合（正規鍵は JWKS に載り、rogue 鍵は載らない）。鍵発行は非同期ゆえ beforeAll で確立する。
let access: AccessSigning;

beforeAll(async () => {
  access = await establishAccessSigning();
});

/** 3xx か否か（本テストが唯一関心を持つ述語）。 */
function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/**
 * testEnv — vars の literal 型（ACCESS_REQUIRED "0" / POLICY_AUD 等）を実値へ差し替える
 * （worker は実行時に string として読む）。DO バインディングは実 env から継承する。
 */
function testEnv(accessRequired: string, teamDomain: string): Env {
  return { ...env, ACCESS_REQUIRED: accessRequired, TEAM_DOMAIN: teamDomain, POLICY_AUD } as unknown as Env;
}

/** トークンの与え方。妥当は JWKS 上の正規鍵、不正は JWKS に無い別鍵で署名する。 */
type TokenKind = "none" | "valid" | "invalid";

/** 分類 fetch と同じ形（Accept: application/json）で `GET /entry/stores` を Worker へ通す。 */
async function getStores(accessRequired: string, tokenKind: TokenKind): Promise<Response> {
  const teamDomain = freshTeamDomain();
  access.stubCertsFetch();
  const headers = new Headers({ Accept: "application/json" });
  if (tokenKind !== "none") {
    const token = await access.mintToken({
      // 妥当は JWKS 上の正規鍵、不正は JWKS に無い別鍵で署名する（鍵と kid は対で選ばれる）。
      signedBy: tokenKind === "valid" ? "access" : "rogue",
      issuer: teamDomain,
      audience: POLICY_AUD,
      email: "cook@store.example",
    });
    headers.set("Cf-Access-Jwt-Assertion", token);
  }
  const request = new Request(`${ORIGIN}${STORES_PATH}`, { headers });
  return worker.fetch(request, testEnv(accessRequired, teamDomain));
}

/**
 * getSignInEntry — `GET /entry/signin/{segment}` を Worker へ通す。
 *
 * JWT を与えない。この分岐は Access の検証も Roster も見ない通し口であり（design 判断 3）、認証は
 * Access がこのパスへの遷移そのものに課す。テスト側でトークンを据えれば、見ていないものを見ているかの
 * ように読めてしまう。
 */
async function getSignInEntry(accessRequired: string, segment: string): Promise<Response> {
  const request = new Request(`${ORIGIN}${SIGNIN_PATH}${segment}`);
  return worker.fetch(request, testEnv(accessRequired, freshTeamDomain()));
}

describe("worker fetch — GET /entry/stores は 3xx を返さない（Requirements 1.5）", () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await reset();
  });

  // 4 組合せ（design 判断 4 の表）。実測 status は 404 / 403 / 200 / 403 だが、ここで主張するのは
  // 「3xx でないこと」のみ——個々の status の意味論は per-store-provisioning 側のテストが守る。
  const cases: readonly { readonly accessRequired: string; readonly token: TokenKind }[] = [
    { accessRequired: "0", token: "none" },
    { accessRequired: "1", token: "none" },
    { accessRequired: "1", token: "valid" },
    { accessRequired: "1", token: "invalid" },
  ];

  for (const { accessRequired, token } of cases) {
    // **Validates: Requirements 1.5**
    it(`ACCESS_REQUIRED="${accessRequired}" / JWT ${token} でも 3xx を返さない`, async () => {
      const response = await getStores(accessRequired, token);

      expect(isRedirect(response.status)).toBe(false);
    });
  }
});

describe("worker fetch — GET /entry/signin/{storeId} は店舗画面へ 302 する（Requirements 4.5, 4.6）", () => {
  afterEach(async () => {
    await reset();
  });

  // ACCESS_REQUIRED を見ない分岐であることを、両値で同じ結果になることで示す（design 判断 3）。
  for (const accessRequired of ["0", "1"] as const) {
    // **Validates: Requirements 4.5, 4.6**
    it(`ACCESS_REQUIRED="${accessRequired}" でも /s/{storeId}/ へ 302 する`, async () => {
      const response = await getSignInEntry(accessRequired, "yamaokaya-1263");

      expect(response.status).toBe(302);
      expect(new URL(response.headers.get("Location") ?? "", ORIGIN).pathname).toBe("/s/yamaokaya-1263/");
    });
  }

  // 形式検証は既存の `/s/{storeId}/` 分岐と同じ関門（isValidStoreId）を通る。ゆえに拒む形も同一である
  // ——許容文字集合の外・長さ上限超え・空・入れ子のパス断片。
  const invalid: readonly { readonly label: string; readonly segment: string }[] = [
    { label: "空", segment: "" },
    { label: "大文字", segment: "Yamaokaya" },
    { label: "許容外の文字", segment: "store_1263" },
    { label: "長さ上限超え", segment: "a".repeat(65) },
    { label: "入れ子のパス断片", segment: "yamaokaya-1263/ws" },
  ];

  for (const { label, segment } of invalid) {
    // **Validates: Requirements 4.5**
    it(`不正な storeId（${label}）を 400 で拒み、リダイレクトしない`, async () => {
      const response = await getSignInEntry("1", segment);

      expect(response.status).toBe(400);
      expect(isRedirect(response.status)).toBe(false);
    });
  }

  // **Validates: Requirements 1.5, 4.5**
  // AC 1.5 の不変（`/entry/stores` は 3xx を返さない）と新しい通し口（302 する）が同一の Worker で
  // 同時に成り立つこと。Opaque_Redirect は宛先を観測できないため、分類 fetch が叩く経路だけが 3xx を
  // 返さないという非対称が保たれていることを、1 つのテストで並べて示す。
  it("同一の Worker で /entry/stores は 3xx を返さず、/entry/signin/{storeId} は 302 する", async () => {
    const stores = await getStores("1", "valid");
    const signin = await getSignInEntry("1", "yamaokaya-1263");

    expect(isRedirect(stores.status)).toBe(false);
    expect(isRedirect(signin.status)).toBe(true);
  });
});
