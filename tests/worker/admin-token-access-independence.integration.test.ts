// tests/worker/admin-token-access-independence.integration.test.ts
// ADMIN_TOKEN 認可判定の ACCESS_REQUIRED 非依存の作動確認（Workers pool）。
//
// _Validates: Requirements 10.3, 10.6_
//
// 確認する不変（要件10.6・design.md「変えないもの」/ Error Handling B）：
//   Provisioning_API（`/admin/*`）の認可は Cloudflare Access とは独立した別系統であり、
//   Access 有効化フラグ `ACCESS_REQUIRED` の切替（"0" ↔ "1"）に一切影響されない。すなわち
//     - Bearer が ADMIN_TOKEN と一致 → 401 を返さず Worker が Registry DO へ透過（ログイン誘導も Access
//       ブロックもされない）。
//     - Bearer が不一致・欠如（空 Authorization） → 401。
//   の判定が、ACCESS_REQUIRED が "0" の構成と "1" の構成で「完全に同一」であること。
//
// なぜ Workers pool か：確認対象は Worker の `/admin/*` ルーティング（isAdminAuthorized の帰結で 401 か
// 透過かが決まり、透過時は Registry DO へ委譲する）という実経路であり、DO バインディングを要する。
//
// なぜ isAdminAuthorized を再検証しないか：定数時間 Bearer 照合ロジックそのものの正当性は
// per-store-provisioning の Property 21（tests/worker/admin-auth.property.test.ts）で PBT 済みである。
// 本テストはそのロジックを作り直さず、「別系統が Access 有効化の切替に影響されない」という結線のみを確認する
// （設計哲学：二度書かれた概念は二つの真実になりかけている）。

import { afterEach, describe, expect, it } from "vitest";
import { env, reset } from "cloudflare:test";
import worker from "../../src/worker";

// cloudflare:test の env を本 Worker の Env 型で解決する（ADMIN_TOKEN / STORE_REGISTRY_DO を型付きで引く）。
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

// 透過（認可成功）の確認に用いる副作用のない読み出し経路。Registry DO は空状態でも 200 と空配列を返すため、
// プロビジョニングなしで「401 でない＝Access に阻まれず Worker が DO へ透過した」ことを一意に示せる。
const ADMIN_PROBE_PATH = "/admin/chains";

// ACCESS_REQUIRED を任意の値に差し替えた env で `/admin/*` を Worker に通す。
// vars は wrangler types が既定値の literal 型（"0" 等）で生成するため、実行時値の差し替えは unknown 経由で写す
// （Worker は実行時に env.ACCESS_REQUIRED を string として読む）。ADMIN_TOKEN・DO バインディングは実 env を継承する。
async function callAdmin(accessRequired: string, authorization: string | null): Promise<Response> {
  const headers = new Headers();
  if (authorization !== null) headers.set("Authorization", authorization);
  const request = new Request(`https://admin.invalid${ADMIN_PROBE_PATH}`, { method: "GET", headers });
  const testEnv = { ...env, ACCESS_REQUIRED: accessRequired } as unknown as Env;
  return worker.fetch(request, testEnv);
}

describe("worker/admin — ADMIN_TOKEN 認可判定は ACCESS_REQUIRED の切替に依存しない（Requirements 10.3, 10.6）", () => {
  afterEach(async () => {
    await reset();
  });

  // 実 ADMIN_TOKEN（.dev.vars 由来の secret）を用いる。照合ロジックを再実装せず、実 env の値で駆動する。
  const adminToken = env.ADMIN_TOKEN ?? "";
  const matching = `Bearer ${adminToken}`;
  const mismatching = `Bearer ${adminToken}-not-the-token`;

  it("ADMIN_TOKEN 一致の Bearer は OFF/ON いずれの構成でも 401 を返さず透過する（同一結果）", async () => {
    // 前提：secret が読めていること（空だと isAdminAuthorized が常に false になり確認が無意味化する）。
    expect(adminToken.length).toBeGreaterThan(0);

    const off = await callAdmin("0", matching);
    const on = await callAdmin("1", matching);

    // 透過＝ログイン誘導も Access ブロックもされず、Registry DO の応答（空チェーン一覧＝200）が返る。
    expect(off.status).not.toBe(401);
    expect(off.status).toBe(200);
    // ACCESS_REQUIRED の切替で判定が変わらない（別系統が Access 有効化に影響されない・要件10.6）。
    expect(on.status).toBe(off.status);
  });

  it("ADMIN_TOKEN 不一致の Bearer は OFF/ON いずれの構成でも 401（同一結果）", async () => {
    const off = await callAdmin("0", mismatching);
    const on = await callAdmin("1", mismatching);

    expect(off.status).toBe(401);
    expect(on.status).toBe(401);
  });

  it("Authorization 欠如（空トークン相当）は OFF/ON いずれの構成でも 401（同一結果）", async () => {
    const off = await callAdmin("0", null);
    const on = await callAdmin("1", null);

    expect(off.status).toBe(401);
    expect(on.status).toBe(401);
  });
});
