// tests/worker/identity-header.integration.test.ts — クライアント由来 IDENTITY_HEADER 偽装除去／検証済み付与の作動確認（Workers pool）。
//
// _Validates: Requirements 7.2, 7.3_
//
// 検証する不変（要件7.2 / 7.3・design.md「Architecture HDR」/ Error Handling B / Integration 表 7.4(b)）：
//   7.2  `/s/{storeId}/ws` の受理時、ACCESS_REQUIRED が "0" / "1" のいずれであっても、Worker は
//        クライアント由来の `X-Yudemen-Identity`（IDENTITY_HEADER）を、送信された大小文字表記を問わず
//        店舗 DO への転送前に無条件除去する（偽装値が DO 受信ヘッダに現れない）。
//   7.3  ACCESS_REQUIRED が "1" かつ JWT 検証成功時に限り、Worker は検証済みクレームから導出した
//        identity のみを IDENTITY_HEADER に設定して DO へ転送する（クライアント偽装値ではない）。
//
// この作動は per-store-provisioning で実装・検証済みの休眠経路であり、本 spec は本番構成での作動を
// 確認するのみ（再実装しない・要件10.1）。
//
// 観測手法（DO 受信ヘッダの直接観測）：本テストの関心は「Worker が DO へ何を転送するか」であって
// DO 内部の Roster 判定ではない。ゆえに worker.fetch の env に、転送先 `STORE_TIMER_DO` を横取りして
// 受信 Request を記録する capturing namespace を差し込み、DO が実際に受け取ったヘッダをそのまま観測する
// （要件7.4(b)「偽装 X-Yudemen-Identity 値が店舗 DO の受信ヘッダに現れない」の直接検証）。DO 本体の
// Roster ゲート（要件6.4 / 6.5）は別タスクの関心事ゆえここでは起こさない。
//
// JWT／JWKS の据え付けは tests/worker/support/accessJwt.ts が供する（実の RS256 鍵ペアを jose で発行し、
// certs エンドポイントへの GET にだけ公開鍵 JWKS を返すようグローバル fetch を差し替える。crypto は偽装しない）。

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/worker";
import { IDENTITY_HEADER } from "../../src/shell/store-timer-do";
import {
  establishAccessSigning,
  freshTeamDomain,
  POLICY_AUD,
  type AccessSigning,
} from "./support/accessJwt";
// 転送先 DO を横取りする観測ハーネス。同じ観測を要する Upgrade 拒否のテストと共有する（重複を作らない）。
import {
  capturingStoreNamespace,
  emptyForwardSink,
  type ForwardSink,
} from "./support/storeTimerSink";

// cloudflare:test の env を本 Worker の Env 型で解決する。
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// クライアントが送りうる IDENTITY_HEADER の各種大小文字表記。HTTP ヘッダ名は大小文字非依存ゆえ、
// Worker の無条件除去（Headers.delete）はいずれの表記でも効く——その作動をケースとして固める。
const IDENTITY_HEADER_CASINGS = [
  "x-yudemen-identity",
  "X-Yudemen-Identity",
  "X-YUDEMEN-IDENTITY",
  "x-YuDeMeN-iDeNtItY",
] as const;

// クライアントが偽装して送り込む identity 値（決して DO へ透過してはならない）。
const FORGED_IDENTITY = "attacker@evil.example";
// JWT 検証成功時に載る検証済み identity（email クレーム由来）。
const VERIFIED_IDENTITY = "cook@store.example";

// Access の署名鍵集合。鍵発行は非同期ゆえ beforeAll で確立する。
let access: AccessSigning;

beforeAll(async () => {
  access = await establishAccessSigning();
});

// run 間で衝突しない storeId を採番する（[a-z0-9-]・長さ 1..64 を満たす・要件1.2）。
function freshStoreId(): string {
  return `identity-header-${crypto.randomUUID()}`;
}

/**
 * driveWs — capturing namespace を差し込んだ env で `/s/{storeId}/ws` を Worker に通し、
 * 応答と「DO が受信した Request」を返す。ACCESS_REQUIRED / TEAM_DOMAIN / POLICY_AUD は実行時の
 * string 値だけが意味を持つため unknown 経由で Env へ写す（DO 以外のバインディングは実 env を継承）。
 */
async function driveWs(params: {
  readonly storeId: string;
  readonly accessRequired: "0" | "1";
  readonly teamDomain: string;
  readonly clientIdentityCasing?: string;
  readonly token?: string | null;
}): Promise<{ readonly response: Response; readonly forwarded: Request | null }> {
  const sink: ForwardSink = emptyForwardSink();
  const headers = new Headers({ Upgrade: "websocket" });
  // クライアント由来の偽装ヘッダ（指定の大小文字表記で）。
  if (params.clientIdentityCasing !== undefined) {
    headers.set(params.clientIdentityCasing, FORGED_IDENTITY);
  }
  if (params.token) {
    headers.set("Cf-Access-Jwt-Assertion", params.token);
  }
  const request = new Request(`https://access.invalid/s/${params.storeId}/ws`, { headers });
  const testEnv = {
    ...env,
    STORE_TIMER_DO: capturingStoreNamespace(sink),
    ACCESS_REQUIRED: params.accessRequired,
    TEAM_DOMAIN: params.teamDomain,
    POLICY_AUD,
  } as unknown as Env;
  const response = await worker.fetch(request, testEnv);
  return { response, forwarded: sink.forwarded };
}

describe("worker fetch — クライアント由来 IDENTITY_HEADER の無条件除去（ON/OFF 共通・Requirements 7.2）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const casing of IDENTITY_HEADER_CASINGS) {
    it(`ACCESS_REQUIRED="0"：クライアント由来 "${casing}" は DO 転送前に除去され受信ヘッダに現れない`, async () => {
      const { response, forwarded } = await driveWs({
        storeId: freshStoreId(),
        accessRequired: "0",
        teamDomain: freshTeamDomain(),
        clientIdentityCasing: casing,
      });

      // OFF は JWT 検証・identity 付与を行わず素通しするが、偽装ヘッダの除去は作動する（要件7.2）。
      expect(response.status).toBe(200);
      expect(forwarded).not.toBeNull();
      // DO 受信ヘッダに IDENTITY_HEADER は一切現れない（偽装値が透過していない）。
      expect(forwarded?.headers.get(IDENTITY_HEADER)).toBeNull();
    });
  }

  for (const casing of IDENTITY_HEADER_CASINGS) {
    it(`ACCESS_REQUIRED="1"（JWT 検証成功）：クライアント由来 "${casing}" の偽装値は DO 受信ヘッダに現れない`, async () => {
      const teamDomain = freshTeamDomain();
      access.stubCertsFetch();
      const token = await access.mintToken({
        issuer: teamDomain,
        audience: POLICY_AUD,
        email: VERIFIED_IDENTITY,
      });

      const { response, forwarded } = await driveWs({
        storeId: freshStoreId(),
        accessRequired: "1",
        teamDomain,
        clientIdentityCasing: casing,
        token,
      });

      // 検証成功で DO へ到達する。偽装値は除去済みで、DO 受信ヘッダには載らない（要件7.2）。
      expect(response.status).toBe(200);
      expect(forwarded).not.toBeNull();
      expect(forwarded?.headers.get(IDENTITY_HEADER)).not.toBe(FORGED_IDENTITY);
    });
  }
});

describe("worker fetch — 検証済み identity の付与は ON かつ JWT 検証成功時のみ（Requirements 7.3）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ACCESS_REQUIRED="1"（JWT 検証成功）：偽装ヘッダがあっても DO 受信 IDENTITY_HEADER は検証済み identity になる', async () => {
    const teamDomain = freshTeamDomain();
    access.stubCertsFetch();
    const token = await access.mintToken({
      issuer: teamDomain,
      audience: POLICY_AUD,
      email: VERIFIED_IDENTITY,
    });

    const { response, forwarded } = await driveWs({
      storeId: freshStoreId(),
      accessRequired: "1",
      teamDomain,
      // クライアントは偽装値を送るが、Worker はそれを捨てて検証済みクレーム由来の値のみを載せ直す。
      clientIdentityCasing: "X-Yudemen-Identity",
      token,
    });

    expect(response.status).toBe(200);
    expect(forwarded).not.toBeNull();
    // 検証済みクレーム（email）由来の identity が設定される（要件7.3）。偽装値ではない。
    expect(forwarded?.headers.get(IDENTITY_HEADER)).toBe(VERIFIED_IDENTITY);
  });

  it('ACCESS_REQUIRED="0"：JWT があっても identity を付与しない（OFF は付与元でない・要件7.3 の対偶）', async () => {
    const teamDomain = freshTeamDomain();
    access.stubCertsFetch();
    const token = await access.mintToken({
      issuer: teamDomain,
      audience: POLICY_AUD,
      email: VERIFIED_IDENTITY,
    });

    const { response, forwarded } = await driveWs({
      storeId: freshStoreId(),
      accessRequired: "0",
      teamDomain,
      token,
    });

    // OFF は検証も付与も行わない。除去後、いかなる IDENTITY_HEADER も載らない。
    expect(response.status).toBe(200);
    expect(forwarded).not.toBeNull();
    expect(forwarded?.headers.get(IDENTITY_HEADER)).toBeNull();
  });

  it('ACCESS_REQUIRED="1"（JWT 欠如）：偽装ヘッダがあっても 403 で DO に到達させない（付与元は検証成功のみ）', async () => {
    const teamDomain = freshTeamDomain();
    access.stubCertsFetch();

    const { response, forwarded } = await driveWs({
      storeId: freshStoreId(),
      accessRequired: "1",
      teamDomain,
      // JWT なしで偽装ヘッダのみを送る直叩き。検証失敗ゆえ 403 で DO へ到達しない（バイパス防御）。
      clientIdentityCasing: "x-yudemen-identity",
      token: null,
    });

    expect(response.status).toBe(403);
    // DO へ一切転送していない（偽装値は DO 受信ヘッダに現れようがない）。
    expect(forwarded).toBeNull();
  });
});
