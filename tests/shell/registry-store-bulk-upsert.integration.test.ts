import { describe, it, expect, afterEach } from "vitest";
import { env, runInDurableObject, reset } from "cloudflare:test";
import {
  REGISTRY_NAME,
  REVISION_KEY,
  type StoreRegistryDO,
} from "../../src/shell/store-registry-do";

// registry-store-bulk-upsert.integration.test.ts — PUT /admin/stores（配列）の一括冪等 upsert の統合テスト（Workers pool）。
//
// _Validates: Requirements 2.16 系（一括冪等 upsert・all-or-nothing・delete-missing なし）_
//
// 検証する不変：
//   - 配列を受けて各要素を storeId キーで upsert（不在なら作成・存在なら更新）。
//   - all-or-nothing：1 要素でも不正なら 400・failures 全列挙・イデア一切不変（部分適用しない）。
//   - 冪等：同じ配列の再送は同じイデアへ収束する。
//   - delete-missing なし：列挙外の既存店舗は削除されない（宣言集合の upsert であって全置換ではない）。
//   - storeId 必須：storeId を欠く／不正な要素は拒否。バッチ内 storeId 重複も拒否。

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function registryStub(): DurableObjectStub<StoreRegistryDO> {
  const id = env.STORE_REGISTRY_DO.idFromName(REGISTRY_NAME);
  return env.STORE_REGISTRY_DO.get(id) as unknown as DurableObjectStub<StoreRegistryDO>;
}

function bulk(body: unknown): Request {
  return new Request("https://registry/admin/stores", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

async function getStore(
  stub: DurableObjectStub<StoreRegistryDO>,
  storeId: string,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await stub.fetch(
    new Request(`https://registry/admin/stores/${storeId}`, { method: "GET" }),
  );
  const body = res.status === 200 ? ((await res.json()) as Record<string, unknown>) : null;
  return { status: res.status, body };
}

async function readRevision(stub: DurableObjectStub<StoreRegistryDO>): Promise<unknown> {
  return runInDurableObject(stub, (_instance, state) => state.storage.get(REVISION_KEY));
}

const el = (storeId: string, extra: Record<string, unknown> = {}) => ({
  storeId,
  chainId: "yamaokaya",
  name: `店舗 ${storeId}`,
  storeRoster: [`staff-${storeId}@yamaokaya.com`],
  ...extra,
});

describe("PUT /admin/stores（配列）— 一括冪等 upsert（Requirements 2.16 系）", () => {
  afterEach(async () => {
    await reset();
  });

  it("複数の新規店舗を一括作成し、200・count・各店の storeRoster を確定する", async () => {
    const stub = registryStub();

    const res = await stub.fetch(bulk([el("1102"), el("1105"), el("1107")]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true, count: 3 });

    const codes = ["1102", "1105", "1107"];
    const stores = await Promise.all(codes.map((code) => getStore(stub, code)));
    codes.forEach((code, i) => {
      expect(stores[i]?.status).toBe(200);
      expect(stores[i]?.body?.storeRoster).toEqual([`staff-${code}@yamaokaya.com`]);
    });
  });

  it("同一配列の再送は冪等（再度 200・count 同一・イデア内容不変）", async () => {
    const stub = registryStub();
    const batch = [el("1102"), el("1105")];

    await stub.fetch(bulk(batch));
    const firstA = await getStore(stub, "1102");

    const res2 = await stub.fetch(bulk(batch));
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ accepted: true, count: 2 });

    const secondA = await getStore(stub, "1102");
    const strip = (s: Record<string, unknown> | null) => {
      if (s === null) return null;
      const { updatedAt: _u, ...rest } = s;
      return rest;
    };
    expect(strip(secondA.body)).toEqual(strip(firstA.body));
  });

  it("all-or-nothing：1 要素でも不正なら 400・失敗列挙・妥当分も含め一切書き込まない", async () => {
    const stub = registryStub();
    const revisionBefore = await readRevision(stub);

    // 2 番目は空文字列 identity で roster 検証違反。
    const res = await stub.fetch(
      bulk([el("1102"), el("1105", { storeRoster: ["ok@example.com", ""] }), el("1107")]),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      accepted: boolean;
      failures: { index: number; storeId?: string }[];
    };
    expect(body.accepted).toBe(false);
    expect(body.failures.some((f) => f.index === 1 && f.storeId === "1105")).toBe(true);

    // 妥当だった 1102・1107 も含め、一切書かれていない（イデア不変）。
    expect((await getStore(stub, "1102")).status).toBe(404);
    expect((await getStore(stub, "1107")).status).toBe(404);
    expect(await readRevision(stub)).toBe(revisionBefore);
  });

  it("既存店舗を含む混在バッチは、不在=作成・存在=更新（部分更新で storeRoster 差し替え）", async () => {
    const stub = registryStub();
    // 先に 1102 を作成。
    await stub.fetch(bulk([el("1102")]));

    // 1102 は更新（roster 差し替え）、1105 は新規作成。
    const res = await stub.fetch(
      bulk([{ storeId: "1102", storeRoster: ["updated@yamaokaya.com"] }, el("1105")]),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true, count: 2 });

    const s1102 = await getStore(stub, "1102");
    expect(s1102.body?.storeRoster).toEqual(["updated@yamaokaya.com"]);
    expect(s1102.body?.name).toBe("店舗 1102"); // 部分更新ゆえ name は保持
    expect((await getStore(stub, "1105")).status).toBe(200);
  });

  it("delete-missing なし：列挙外の既存店舗は一括 upsert で削除されない", async () => {
    const stub = registryStub();
    await stub.fetch(bulk([el("1102")])); // 既存

    await stub.fetch(bulk([el("1105")])); // 1105 だけを宣言

    // 1102 は列挙外だが残っている（全置換ではない）。
    expect((await getStore(stub, "1102")).status).toBe(200);
    expect((await getStore(stub, "1105")).status).toBe(200);
  });

  it("非配列ボディ・storeId 欠落・バッチ内重複はいずれも 400・イデア不変", async () => {
    const stub = registryStub();

    // 非配列。
    const notArray = await stub.fetch(bulk({ storeId: "1102", chainId: "yamaokaya", name: "x" }));
    expect(notArray.status).toBe(400);

    // storeId 欠落。
    const noId = await stub.fetch(bulk([{ chainId: "yamaokaya", name: "no id" }]));
    expect(noId.status).toBe(400);

    // バッチ内 storeId 重複。
    const dup = await stub.fetch(bulk([el("1102"), el("1102", { name: "重複" })]));
    expect(dup.status).toBe(400);

    // いずれも何も作られていない。
    expect((await getStore(stub, "1102")).status).toBe(404);
    expect(await readRevision(stub)).toBeUndefined();
  });
});
