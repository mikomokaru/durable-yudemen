import { describe, it, expect, afterEach } from "vitest";
import { env, runInDurableObject, reset } from "cloudflare:test";
import { REGISTRY_NAME, REVISION_KEY, type StoreRegistryDO } from "../../src/shell/store-registry-do";

// registry-store-code.integration.test.ts — Store_Code の一意性と不変性の統合テスト（Workers pool）。
//
// _Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 3.8, 3.9_
//
// 検証する不変：
//   - 他店舗が使用中の Store_Code を主張する登録・更新は 400（store-code-in-use）でイデア不変（要件3.2）。
//   - 既存と異なる Store_Code への変更要求は 400（store-code-immutable）で、**変更前の値が残る**——
//     黙って無視して「受理」と応答しない（要件3.3 / 3.7）。
//   - 既存が未設定なら付与を受理し、StoreId は変わらない（要件3.8。後から POS 連携を始める店舗に新規作成を
//     強いれば StoreId が変わり、既存の画面 URL と WS 接続が切れる）。
//   - 同値の再指定は受理（同一ボディの再送を拒否しない・冪等・要件3.4）。
//   - 一括 upsert のバッチ内で同一コードを複数要素が主張すれば、バッチ全体を 400 で拒否し失敗要素を列挙し、
//     イデアを一切変更しない（要件3.5）。
//   - 非活性店舗の Store_Code も一意性の対象（閉店した店舗のコードを別店舗が再利用できない・要件3.1）。

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

describe("Store_Code の一意性と不変性（Requirements 3.1〜3.5, 3.7, 3.8）", () => {
  afterEach(async () => {
    await reset();
  });

  it("他店舗が使用中の Store_Code を指定した登録は 400（store-code-in-use）でイデア不変", async () => {
    const stub = registryStub();
    await stub.fetch(postStore({ storeId: "code-owner", chainId: "yamaokaya", name: "先着店", storeCode: "1263" }));
    const revisionBefore = await readRevision(stub);

    const res = await stub.fetch(
      postStore({ storeId: "code-latecomer", chainId: "yamaokaya", name: "後着店", storeCode: "1263" }),
    );

    expect(res.status).toBe(400);
    expect((await res.json() as Record<string, unknown>).error).toBe("store-code-in-use");
    // 拒否時はイデアを一切変更しない（commitIdeal より前に判定する）。
    expect((await getStore(stub, "code-latecomer")).status).toBe(404);
    expect(await readRevision(stub)).toBe(revisionBefore);
    // 宛先は先着のまま動かない。
    expect(await stub.resolveStoreCode("1263")).toBe("code-owner");
  });

  it("他店舗が使用中の Store_Code への更新は 400（store-code-in-use）でイデア不変", async () => {
    const stub = registryStub();
    await stub.fetch(postStore({ storeId: "code-held", chainId: "yamaokaya", name: "保有店", storeCode: "1102" }));
    await stub.fetch(postStore({ storeId: "code-empty", chainId: "yamaokaya", name: "未連携店" }));
    const revisionBefore = await readRevision(stub);

    const res = await stub.fetch(putStore("code-empty", { storeCode: "1102" }));

    expect(res.status).toBe(400);
    expect((await res.json() as Record<string, unknown>).error).toBe("store-code-in-use");
    expect((await getStore(stub, "code-empty")).body?.storeCode).toBeUndefined();
    expect(await readRevision(stub)).toBe(revisionBefore);
    expect(await stub.resolveStoreCode("1102")).toBe("code-held");
  });

  it("既存と異なる Store_Code への変更要求は 400（store-code-immutable）で、変更前の値が残る（黙殺しない）", async () => {
    const stub = registryStub();
    await stub.fetch(postStore({ storeId: "code-fixed", chainId: "yamaokaya", name: "対応済み店", storeCode: "1263" }));
    const revisionBefore = await readRevision(stub);

    const res = await stub.fetch(putStore("code-fixed", { storeCode: "9999" }));

    // 黙って無視して 200 を返さない（呼び出し元の意図を偽らない）。
    expect(res.status).toBe(400);
    expect((await res.json() as Record<string, unknown>).error).toBe("store-code-immutable");
    // かつ変更前の値が残る（拒否とイデア不変の両方を確かめる）。
    expect((await getStore(stub, "code-fixed")).body?.storeCode).toBe("1263");
    expect(await readRevision(stub)).toBe(revisionBefore);
    expect(await stub.resolveStoreCode("9999")).toBeUndefined();
  });

  it("一括 upsert でも異なる Store_Code への変更要求は 400 で、変更前の値が残る", async () => {
    const stub = registryStub();
    await stub.fetch(postStore({ storeId: "code-bulk-fixed", chainId: "yamaokaya", name: "一括対象店", storeCode: "2001" }));
    const revisionBefore = await readRevision(stub);

    const res = await stub.fetch(putStores([{ storeId: "code-bulk-fixed", storeCode: "2002" }]));

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      failures: readonly { index: number; storeId: string; failure: { kind: string } }[];
    };
    expect(body.failures).toHaveLength(1);
    expect(body.failures[0]?.failure.kind).toBe("store-code-immutable");
    expect((await getStore(stub, "code-bulk-fixed")).body?.storeCode).toBe("2001");
    expect(await readRevision(stub)).toBe(revisionBefore);
  });

  it("既存が未設定の店舗への Store_Code 付与は受理され、StoreId は変わらない", async () => {
    const stub = registryStub();
    await stub.fetch(postStore({ storeId: "code-later", chainId: "yamaokaya", name: "後から連携する店" }));

    const res = await stub.fetch(putStore("code-later", { storeCode: "1263" }));

    expect(res.ok).toBe(true);
    const store = await getStore(stub, "code-later");
    // StoreId が変わらないこと（新規作成に落とさない）——画面 URL と WS 接続が切れない根拠。
    expect(store.body?.storeId).toBe("code-later");
    expect(store.body?.storeCode).toBe("1263");
    expect(await stub.resolveStoreCode("1263")).toBe("code-later");
  });

  it("同値の Store_Code の再指定は受理される（同一ボディの再送・冪等）", async () => {
    const stub = registryStub();
    await stub.fetch(postStore({ storeId: "code-same", chainId: "yamaokaya", name: "再送店", storeCode: "1102" }));

    const single = await stub.fetch(putStore("code-same", { name: "再送店（改称）", storeCode: "1102" }));
    const bulk = await stub.fetch(putStores([{ storeId: "code-same", storeCode: "1102" }]));

    expect(single.ok).toBe(true);
    expect(bulk.ok).toBe(true);
    const store = await getStore(stub, "code-same");
    expect(store.body?.storeCode).toBe("1102");
    expect(await stub.resolveStoreCode("1102")).toBe("code-same");
  });

  it("一括 upsert のバッチ内で同一 Store_Code を主張すれば全体が 400・失敗要素を列挙・イデア不変", async () => {
    const stub = registryStub();
    const revisionBefore = await readRevision(stub);

    const res = await stub.fetch(
      putStores([
        { storeId: "code-dup-a", chainId: "yamaokaya", name: "A 店", storeCode: "3001" },
        { storeId: "code-dup-b", chainId: "yamaokaya", name: "B 店", storeCode: "3001" },
      ]),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { failures: readonly { index: number; storeId: string }[] };
    // 衝突に関与する 2 要素がいずれも元の位置つきで列挙される。
    expect(body.failures.map((f) => f.index).sort()).toEqual([0, 1]);
    expect(body.failures.map((f) => f.storeId).sort()).toEqual(["code-dup-a", "code-dup-b"]);
    // イデアを一切変更しない（all-or-nothing）。
    expect((await getStore(stub, "code-dup-a")).status).toBe(404);
    expect((await getStore(stub, "code-dup-b")).status).toBe(404);
    expect(await readRevision(stub)).toBe(revisionBefore);
    expect(await stub.resolveStoreCode("3001")).toBeUndefined();
  });

  it("非活性（閉店）店舗の Store_Code も一意性の対象——別店舗が再利用できない", async () => {
    const stub = registryStub();
    await stub.fetch(postStore({ storeId: "code-closed", chainId: "yamaokaya", name: "閉店店", storeCode: "4001" }));
    await stub.fetch(putStore("code-closed", { active: false }));

    const res = await stub.fetch(
      postStore({ storeId: "code-reuse", chainId: "yamaokaya", name: "再利用しようとする店", storeCode: "4001" }),
    );

    expect(res.status).toBe(400);
    expect((await res.json() as Record<string, unknown>).error).toBe("store-code-in-use");
    expect((await getStore(stub, "code-reuse")).status).toBe(404);
    // 閉店前に届いた保留分の宛先が後から変わらない（逆引きは閉店店舗を指し続ける）。
    expect(await stub.resolveStoreCode("4001")).toBe("code-closed");
  });
});
