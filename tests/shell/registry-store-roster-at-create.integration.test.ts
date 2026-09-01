import { describe, it, expect, afterEach } from "vitest";
import { env, runInDurableObject, reset } from "cloudflare:test";
import {
  REGISTRY_NAME,
  REVISION_KEY,
  type StoreRegistryDO,
} from "../../src/shell/store-registry-do";

// registry-store-roster-at-create.integration.test.ts — 作成時に storeRoster を同梱できることの統合テスト（Workers pool）。
//
// _Validates: Requirements 3.5, 4.6_
//
// 検証する不変：POST /admin/stores は店舗の定義（config/override）と店舗 Roster を 1 リクエストで自己完結
// させられる。storeRoster を同梱すると当該店の storeRoster として確定し（updateStore を待たない）、省略時は
// 従来どおり空名簿で作成される（後方互換）。不正な storeRoster（updateStore と同一の roster 検証に反する値）は
// 400・イデア不変で拒否する（黙って畳まない・要件4.6）。名簿の値検証ロジック自体は既存 PBT が担うため再検証せず、
// 「作成経路が storeRoster を受理し・検証し・確定する」という配線のみを実 DO・実 storage で確かめる。

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/** レジストリ（シングルトン）のスタブを fetch で叩ける形で得る。 */
function registryStub(): DurableObjectStub<StoreRegistryDO> {
  const id = env.STORE_REGISTRY_DO.idFromName(REGISTRY_NAME);
  return env.STORE_REGISTRY_DO.get(id) as unknown as DurableObjectStub<StoreRegistryDO>;
}

/** JSON ボディの PUT/POST リクエストを組む（Provisioning_API の実経路と同じ Content-Type）。 */
function jsonRequest(url: string, method: "PUT" | "POST", body: unknown): Request {
  return new Request(url, {
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

/** GET /admin/stores/{id} で店舗イデアを読む（不在は 404）。 */
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

describe("POST /admin/stores — storeRoster の作成時同梱（Requirements 3.5, 4.6）", () => {
  afterEach(async () => {
    await reset();
  });

  it("正当な storeRoster を同梱すると受理され、当該店の storeRoster として確定する", async () => {
    const stub = registryStub();
    const storeId = "roster-at-create";

    const response = await stub.fetch(
      jsonRequest("https://registry/admin/stores", "POST", {
        storeId,
        chainId: "yamaokaya",
        name: "1263 つくば中央店",
        storeCode: "1263",
        storeRoster: ["staff-1263@yamaokaya.com"],
      }),
    );

    // 受理（2xx）。作成経路が storeRoster を読み飛ばさず受け付ける。
    expect(response.ok).toBe(true);
    const store = await getStore(stub, storeId);
    expect(store.status).toBe(200);
    // 同梱した名簿が [] ではなくそのまま確定している（updateStore を待たない）。
    expect(store.body?.storeRoster).toEqual(["staff-1263@yamaokaya.com"]);
  });

  it("storeRoster を省略すると従来どおり空名簿で作成される（後方互換）", async () => {
    const stub = registryStub();
    const storeId = "roster-omitted";

    const response = await stub.fetch(
      jsonRequest("https://registry/admin/stores", "POST", {
        storeId,
        chainId: "yamaokaya",
        name: "空名簿店",
      }),
    );

    expect(response.ok).toBe(true);
    const store = await getStore(stub, storeId);
    expect(store.status).toBe(200);
    expect(store.body?.storeRoster).toEqual([]);
  });

  it("不正な storeRoster（空文字列要素）は 400・店舗イデア不在・revision 不変で拒否する", async () => {
    const stub = registryStub();
    const storeId = "roster-invalid";
    const revisionBefore = await readRevision(stub);

    const response = await stub.fetch(
      jsonRequest("https://registry/admin/stores", "POST", {
        storeId,
        chainId: "yamaokaya",
        name: "不正名簿店",
        // roster 検証（updateStore と同一）に反する空文字列要素。黙って落とさず拒否する（要件4.6）。
        storeRoster: ["valid@example.com", ""],
      }),
    );

    expect(response.status).toBe(400);
    // 拒否は commitIdeal より前ゆえ店舗は書かれない。
    expect((await getStore(stub, storeId)).status).toBe(404);
    expect(await readRevision(stub)).toBe(revisionBefore);
  });
});
