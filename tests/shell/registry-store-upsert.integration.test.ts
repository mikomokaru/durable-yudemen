import { describe, it, expect, afterEach } from "vitest";
import { env, runInDurableObject, reset } from "cloudflare:test";
import { REGISTRY_NAME, REVISION_KEY, type StoreRegistryDO } from "../../src/shell/store-registry-do";

// registry-store-upsert.integration.test.ts — PUT /admin/stores/{id} の冪等 upsert の統合テスト（Workers pool）。
//
// _Validates: Requirements 2.8, 3.5_
//
// 検証する不変：PUT /admin/stores/{storeId} は create-or-replace の冪等 upsert である。
//   - 対象が不在なら作成（createStore へ委譲・path の storeId を採用）。
//   - 対象が存在すれば更新。
//   - 同じボディの再送は同じイデアへ収束する（冪等）——一括投入の再実行安全性の土台。
// 作成の検証・既定は createStore に一元化されているため（重複の根絶）、ここでは「PUT が不在で作成し、
// 存在で更新し、再送で状態が変わらない」という配線のみを実 DO・実 storage で確かめる。

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function registryStub(): DurableObjectStub<StoreRegistryDO> {
  const id = env.STORE_REGISTRY_DO.idFromName(REGISTRY_NAME);
  return env.STORE_REGISTRY_DO.get(id) as unknown as DurableObjectStub<StoreRegistryDO>;
}

function putStore(storeId: string, body: unknown): Request {
  return new Request(`https://registry/admin/stores/${storeId}`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

async function getStore(
  stub: DurableObjectStub<StoreRegistryDO>,
  storeId: string,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await stub.fetch(new Request(`https://registry/admin/stores/${storeId}`, { method: "GET" }));
  const body = res.status === 200 ? ((await res.json()) as Record<string, unknown>) : null;
  return { status: res.status, body };
}

async function readRevision(stub: DurableObjectStub<StoreRegistryDO>): Promise<unknown> {
  return runInDurableObject(stub, (_instance, state) => state.storage.get(REVISION_KEY));
}

describe("PUT /admin/stores/{id} — 冪等 upsert（Requirements 2.8, 3.5）", () => {
  afterEach(async () => {
    await reset();
  });

  it("不在の storeId への PUT は作成として成立する（create-or-replace）", async () => {
    const stub = registryStub();
    const storeId = "upsert-new";

    const res = await stub.fetch(
      putStore(storeId, {
        chainId: "yamaokaya",
        name: "1263 つくば中央店",
        storeCode: "1263",
        storeRoster: ["staff-1263@yamaokaya.com"],
      }),
    );

    expect(res.ok).toBe(true);
    const store = await getStore(stub, storeId);
    expect(store.status).toBe(200);
    expect(store.body?.name).toBe("1263 つくば中央店");
    expect(store.body?.storeRoster).toEqual(["staff-1263@yamaokaya.com"]);
    expect(store.body?.active).toBe(true);
  });

  it("同じボディの再 PUT は冪等（イデア内容が変わらない・再実行安全）", async () => {
    const stub = registryStub();
    const storeId = "upsert-idempotent";
    const body = {
      chainId: "yamaokaya",
      name: "1102 南2条店",
      storeCode: "1102",
      override: { unitCount: 2, arms: 2, toleranceRatio: 3 },
      storeRoster: ["staff-1102@yamaokaya.com"],
    };

    const first = await stub.fetch(putStore(storeId, body));
    expect(first.ok).toBe(true);
    const afterFirst = await getStore(stub, storeId);

    const second = await stub.fetch(putStore(storeId, body));
    expect(second.ok).toBe(true);
    const afterSecond = await getStore(stub, storeId);

    // updatedAt（再送で必ず進む監査時刻）を除くイデア内容が一致する（同じボディの再送は同じ状態へ収束する）。
    const stripBody = (s: Record<string, unknown> | null) => {
      if (s?.body == null) return null;
      const { updatedAt: _updatedAt, ...rest } = s.body as Record<string, unknown>;
      return rest;
    };
    expect(stripBody(afterSecond)).toEqual(stripBody(afterFirst));
    expect(afterSecond.body?.storeRoster).toEqual(["staff-1102@yamaokaya.com"]);
  });

  it("既存の storeId への PUT は更新として作用する（storeRoster を差し替え）", async () => {
    const stub = registryStub();
    const storeId = "upsert-existing";

    // 1st PUT: 作成（名簿 A）。
    await stub.fetch(
      putStore(storeId, { chainId: "yamaokaya", name: "更新対象店", storeRoster: ["a@example.com"] }),
    );
    // 2nd PUT: 更新（名簿 B へ差し替え）。
    const res = await stub.fetch(putStore(storeId, { storeRoster: ["b@example.com"] }));

    expect(res.ok).toBe(true);
    const store = await getStore(stub, storeId);
    expect(store.status).toBe(200);
    // storeRoster は送った配列で置換され、name は部分更新で既存を保持する。
    expect(store.body?.storeRoster).toEqual(["b@example.com"]);
    expect(store.body?.name).toBe("更新対象店");
  });

  it("upsert-作成でも不正な storeRoster は 400・店舗イデア不在・revision 不変", async () => {
    const stub = registryStub();
    const storeId = "upsert-invalid";
    const revisionBefore = await readRevision(stub);

    const res = await stub.fetch(
      putStore(storeId, { chainId: "yamaokaya", name: "不正名簿店", storeRoster: ["ok@example.com", ""] }),
    );

    expect(res.status).toBe(400);
    expect((await getStore(stub, storeId)).status).toBe(404);
    expect(await readRevision(stub)).toBe(revisionBefore);
  });
});
