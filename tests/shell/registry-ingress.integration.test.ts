import { describe, it, expect, afterEach } from "vitest";
import { env, runInDurableObject, reset } from "cloudflare:test";
import {
  REGISTRY_NAME,
  REVISION_KEY,
  chainKey,
  policyKey,
  type StoreRegistryDO,
} from "../../src/shell/store-registry-do";
import { UNIT_COUNT_MAX } from "../../src/domain/store";

// registry-ingress.integration.test.ts — 入口拒否の HTTP 400・イデア不変の統合テスト（Workers pool）。
//
// _Validates: Requirements 4.6_
//
// 検証する不変：Provisioning_API へ未知フィールド・型不一致・値域外の投入を送ったとき、StoreRegistryDO の
// 入口（validateProvisioningInput を用いる Chain / Policy / Store 経路）は HTTP 400 を返し、イデア
// （chain:* / policy:* / store:* / meta:revision）を一切変更しない——「黙って既定へ畳まない」という
// design-philosophy「真」の帰結（要件4.6）。domain の to*（toUnitCount ほか）が不正値を DEFAULT_* へ
// クランプするのに対し、機械間 API では畳み込みが投入元の誤りを隠蔽するため、入口は拒否して put を行わない。
//
// この配線は composeEffectiveConfig の既定 pool 例示テスト（tests/registry/compose.example.test.ts）や
// validateProvisioningInput の純粋テスト（tests/registry/validate.example.test.ts）では観測できない
// 「HTTP 表面（400）と put 不変」を、workerd 上の実 DO・実 storage で確かめる（純粋層の判定は責務外）。
//
// 駆動：レジストリの fetch を叩いて HTTP 入口（ルート解釈 → JSON パース → 拒否型検証 → 400 写像）を通す。
// これが Worker が素通しする実経路そのもの（Worker は ADMIN_TOKEN 認可のみで、ルート・検証・400 は
// レジストリ fetch に閉じる・design.md Component 7）。
//
// イデア不変の観測：runInDurableObject で対象キー（chain:/policy:/store:）と meta:revision を put の前後で
// 読み、変わっていないことを確かめる。各テストは afterEach の reset() で隔離する（シングルトンゆえ）。

/** レジストリ（シングルトン）のスタブを、fetch で HTTP 入口を叩ける形で得る（converge テストと同じ絞り込み）。 */
function registryStub(): DurableObjectStub<StoreRegistryDO> {
  const id = env.STORE_REGISTRY_DO.idFromName(REGISTRY_NAME);
  // STORE_REGISTRY_DO は型生成上まだ素の DurableObjectNamespace（クラス型未反映）ゆえ class 型へ絞り込む。
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

/** 現在の revision を読む（不在は undefined＝イデア未書き込みの初期状態）。 */
async function readRevision(stub: DurableObjectStub<StoreRegistryDO>): Promise<unknown> {
  return runInDurableObject(stub, (_instance, state) => state.storage.get(REVISION_KEY));
}

/** 指定キーの永続値を読む（不在は undefined）。 */
async function readKey(stub: DurableObjectStub<StoreRegistryDO>, key: string): Promise<unknown> {
  return runInDurableObject(stub, (_instance, state) => state.storage.get(key));
}

describe("入口拒否: 不正投入は HTTP 400・イデア不変（Requirements 4.6）", () => {
  // シングルトンのレジストリは storage を跨いで残るため、各テスト後に永続を掃除して隔離する。
  afterEach(async () => {
    await reset();
  });

  describe("PUT /admin/chains/{id} — チェーン Roster の値検証", () => {
    it("chainRoster が非配列（型不一致）なら 400・chain イデア不変・revision 不変", async () => {
      const stub = registryStub();
      const chainId = "chain-badroster";
      const revisionBefore = await readRevision(stub);

      const response = await stub.fetch(
        jsonRequest(`https://registry/admin/chains/${chainId}`, "PUT", {
          name: "Bad Roster Chain",
          chainRoster: "not-an-array",
        }),
      );

      expect(response.status).toBe(400);
      // イデア不変：チェーンは書かれず、revision も進まない（黙って畳まない）。
      expect(await readKey(stub, chainKey(chainId))).toBeUndefined();
      expect(await readRevision(stub)).toBe(revisionBefore);
    });

    it("chainRoster に空文字列要素（値域外）があれば 400・chain イデア不変", async () => {
      const stub = registryStub();
      const chainId = "chain-emptyid";

      const response = await stub.fetch(
        jsonRequest(`https://registry/admin/chains/${chainId}`, "PUT", {
          name: "Empty Identity Chain",
          chainRoster: ["valid@example.com", ""],
        }),
      );

      expect(response.status).toBe(400);
      expect(await readKey(stub, chainKey(chainId))).toBeUndefined();
      expect(await readRevision(stub)).toBeUndefined();
    });
  });

  describe("PUT /admin/policies/{id} — PolicyFields の mode/値検証", () => {
    it("fields.unitCount.value が値域外なら 400・policy イデア不変・revision 不変", async () => {
      const stub = registryStub();
      const policyId = "policy-oob";
      const revisionBefore = await readRevision(stub);

      const response = await stub.fetch(
        jsonRequest(`https://registry/admin/policies/${policyId}`, "PUT", {
          name: "Out Of Range Policy",
          chainId: "chain-1",
          priority: 10,
          // UNIT_COUNT_MAX を 1 超える値域外。to* によるクランプではなく拒否されるべき（要件4.6）。
          fields: { unitCount: { mode: "enforced", value: UNIT_COUNT_MAX + 1 } },
        }),
      );

      expect(response.status).toBe(400);
      expect(await readKey(stub, policyKey(policyId))).toBeUndefined();
      expect(await readRevision(stub)).toBe(revisionBefore);
    });

    it("fields に未知フィールドがあれば 400・policy イデア不変", async () => {
      const stub = registryStub();
      const policyId = "policy-unknown";

      const response = await stub.fetch(
        jsonRequest(`https://registry/admin/policies/${policyId}`, "PUT", {
          name: "Unknown Field Policy",
          chainId: "chain-1",
          priority: 10,
          // 許可集合（unitCount / arms / toleranceRatio / noodlePresets）に無いフィールドは黙って捨てず拒否する。
          fields: { surprise: { mode: "default", value: 1 } },
        }),
      );

      expect(response.status).toBe(400);
      expect(await readKey(stub, policyKey(policyId))).toBeUndefined();
      expect(await readRevision(stub)).toBeUndefined();
    });
  });

  describe("POST /admin/stores — Store_Override の値検証", () => {
    it("override.unitCount が値域外なら 400・店舗イデア不在・revision 不変", async () => {
      const stub = registryStub();
      const revisionBefore = await readRevision(stub);

      const response = await stub.fetch(
        jsonRequest("https://registry/admin/stores", "POST", {
          chainId: "chain-1",
          name: "Out Of Range Store",
          override: { unitCount: UNIT_COUNT_MAX + 1 },
        }),
      );

      expect(response.status).toBe(400);
      // 拒否は storeId 採番より前ゆえ、いかなる store: キーも書かれない（no store written）。
      const storeKeys = await runInDurableObject(stub, async (_instance, state) =>
        [...(await state.storage.list({ prefix: "store:" })).keys()],
      );
      expect(storeKeys).toEqual([]);
      expect(await readRevision(stub)).toBe(revisionBefore);
    });

    it("override に未知フィールドがあれば 400・店舗イデア不在", async () => {
      const stub = registryStub();

      const response = await stub.fetch(
        jsonRequest("https://registry/admin/stores", "POST", {
          chainId: "chain-1",
          name: "Unknown Override Store",
          override: { surprise: 1 },
        }),
      );

      expect(response.status).toBe(400);
      const storeKeys = await runInDurableObject(stub, async (_instance, state) =>
        [...(await state.storage.list({ prefix: "store:" })).keys()],
      );
      expect(storeKeys).toEqual([]);
      expect(await readRevision(stub)).toBeUndefined();
    });

    it("override.unitCount が文字列（型不一致）なら 400・店舗イデア不在", async () => {
      const stub = registryStub();

      const response = await stub.fetch(
        jsonRequest("https://registry/admin/stores", "POST", {
          chainId: "chain-1",
          name: "Type Mismatch Store",
          // 整数期待の値に文字列。to* の Number() 変換に流さず、型不一致として拒否されるべき。
          override: { unitCount: "3" },
        }),
      );

      expect(response.status).toBe(400);
      const storeKeys = await runInDurableObject(stub, async (_instance, state) =>
        [...(await state.storage.list({ prefix: "store:" })).keys()],
      );
      expect(storeKeys).toEqual([]);
      expect(await readRevision(stub)).toBeUndefined();
    });
  });
});
