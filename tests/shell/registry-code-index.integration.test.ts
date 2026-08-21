import { describe, it, expect, afterEach } from "vitest";
import { env, runInDurableObject, reset } from "cloudflare:test";
import { REGISTRY_NAME, CODE_INDEX_KEY, type StoreRegistryDO } from "../../src/shell/store-registry-do";

// registry-code-index.integration.test.ts — Code_Index の書き込みと resolveStoreCode の統合テスト（Workers pool）。
//
// _Validates: Requirements 2.1, 2.3, 2.5, 2.8, 2.9_
//
// 検証する不変：
//   - createStore / updateStore / upsertStores の 3 経路すべてで index:code が書かれる（1 つでも漏らせば
//     「登録したのに宛先が引けない」店舗が生まれる）。
//   - 非活性店舗も逆引きできる（索引を活性で絞らない・要件2.7）。
//   - storeCode を持たない店舗は索引に載らない（要件3.8）。
//   - 未知の Store_Code は未知として応答し、いかなる店舗へもフォールバックしない（要件2.6）。
//   - 索引は導出値である——捨てて店舗の書き込みで再導出しても結果が変わらない（要件2.1 / 2.3）。

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

function registryStub(): DurableObjectStub<StoreRegistryDO> {
  const id = env.STORE_REGISTRY_DO.idFromName(REGISTRY_NAME);
  return env.STORE_REGISTRY_DO.get(id) as unknown as DurableObjectStub<StoreRegistryDO>;
}

function postStore(body: unknown): Request {
  return new Request("https://registry/admin/stores", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function putStore(storeId: string, body: unknown): Request {
  return new Request(`https://registry/admin/stores/${storeId}`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function putStores(body: unknown): Request {
  return new Request("https://registry/admin/stores", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

/** 永続の index:code を生のまま読む（導出値が put で確定していることの確認）。 */
async function readCodeIndex(stub: DurableObjectStub<StoreRegistryDO>): Promise<readonly [string, string][]> {
  const raw = await runInDurableObject(stub, (_instance, state) => state.storage.get(CODE_INDEX_KEY));
  return Array.isArray(raw) ? (raw as readonly [string, string][]) : [];
}

describe("Code_Index の書き込みと resolveStoreCode（Requirements 2.1, 2.3, 2.5, 2.8, 2.9）", () => {
  afterEach(async () => {
    await reset();
  });

  it("createStore（POST /admin/stores）で索引が書かれ、storeCode から storeId が引ける", async () => {
    const stub = registryStub();

    const res = await stub.fetch(
      postStore({ storeId: "code-create", chainId: "yamaokaya", name: "1263 つくば中央店", storeCode: "1263" }),
    );

    expect(res.status).toBe(201);
    expect(await stub.resolveStoreCode("1263")).toBe("code-create");
  });

  it("updateStore（PUT /admin/stores/{id}）で索引が書かれる — 索引を捨てても書き込みで再導出される", async () => {
    const stub = registryStub();
    await stub.fetch(
      postStore({ storeId: "code-update", chainId: "yamaokaya", name: "1102 南2条店", storeCode: "1102" }),
    );
    const beforeIndex = await readCodeIndex(stub);

    // 索引だけを捨てる（導出値ゆえイデアからいつでも再導出できることの表明）。
    await runInDurableObject(stub, (_instance, state) => state.storage.delete(CODE_INDEX_KEY));
    expect(await stub.resolveStoreCode("1102")).toBeUndefined();

    const res = await stub.fetch(putStore("code-update", { name: "1102 南2条店（改称）" }));

    expect(res.ok).toBe(true);
    expect(await stub.resolveStoreCode("1102")).toBe("code-update");
    // 再導出した索引は捨てる前と同一（正本が同じなら結果が変わらない）。
    expect(await readCodeIndex(stub)).toEqual(beforeIndex);
  });

  it("upsertStores（PUT /admin/stores・配列）で全要素の索引が書かれる", async () => {
    const stub = registryStub();

    const res = await stub.fetch(
      putStores([
        { storeId: "code-bulk-a", chainId: "yamaokaya", name: "A 店", storeCode: "2001" },
        { storeId: "code-bulk-b", chainId: "yamaokaya", name: "B 店", storeCode: "2002" },
      ]),
    );

    expect(res.ok).toBe(true);
    expect(await stub.resolveStoreCode("2001")).toBe("code-bulk-a");
    expect(await stub.resolveStoreCode("2002")).toBe("code-bulk-b");
  });

  it("非活性（active=false）の店舗も逆引きできる（索引を活性で絞らない）", async () => {
    const stub = registryStub();
    await stub.fetch(
      postStore({ storeId: "code-closed", chainId: "yamaokaya", name: "閉店予定店", storeCode: "3001" }),
    );

    const res = await stub.fetch(putStore("code-closed", { active: false }));

    expect(res.ok).toBe(true);
    expect(await stub.resolveStoreCode("3001")).toBe("code-closed");
  });

  it("storeCode を持たない店舗は索引に載らない", async () => {
    const stub = registryStub();

    await stub.fetch(postStore({ storeId: "code-absent", chainId: "yamaokaya", name: "POS 未連携店" }));

    expect(await readCodeIndex(stub)).toEqual([]);
  });

  it("未知の Store_Code は未知として応答する（他店舗へフォールバックしない）", async () => {
    const stub = registryStub();
    await stub.fetch(
      postStore({ storeId: "code-known", chainId: "yamaokaya", name: "既知店", storeCode: "4001" }),
    );

    expect(await stub.resolveStoreCode("9999")).toBeUndefined();
  });
});
