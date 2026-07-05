import { describe, it, expect, afterEach } from "vitest";
import { env, runInDurableObject, reset } from "cloudflare:test";
import {
  REGISTRY_NAME,
  REVISION_KEY,
  RESIDUAL_KEY,
  storeKey,
  type StoreRegistryDO,
} from "../../src/shell/store-registry-do";

// registry-converge.integration.test.ts — put-first の統合テスト（Workers pool）。
//
// _Validates: Requirements 5.1_
//
// 検証する不変：イデアの storage.put（確定の起点）が失敗したとき、後続の fan-out（影響店舗の
// StoreTimerDO への applyProjection 押し込み）は一切行われず、イデア（store:* / meta:revision /
// converge:residual）も一切変わらない。「put 成功の前に外部へ真実を主張しない」という SSOT 規律
// （design-philosophy「真」・要件5.1）が StoreRegistryDO.commitIdeal → converge の順序で守られていることを、
// workerd 上の実 DO・実 storage で確かめる。
//
// 注入点：commitIdeal は fan-out（converge）より前に「イデア＋revision＋残作業」を一度の storage.put で
// 確定する。ここで put を失敗させれば、createStore は commitIdeal の時点で reject し converge へ到達しない。
// これが put-first の crux——put が落ちれば fan-out は始まらない。put のみを差し替え、判定に使う get は
// 素通しさせることで「イデアが書かれていない＝不変」を同一 storage で観測する。
//
// 投影が一切押し込まれていないことの直接の証左は、対象 StoreTimerDO の投影キー（"projection"）が未永続で
// あること。applyProjection は成功時に必ず投影を put する（store-timer-do.ts）ため、その不在は
// 「applyProjection が一度も届いていない」ことと同値。

/** StoreTimerDO が投影を永続する単一キー（store-timer-do.ts の PROJECTION_KEY と同値。private ゆえ literal で参照する）。 */
const STORE_PROJECTION_KEY = "projection";

/** レジストリ（シングルトン）のスタブを、createStore などの型付き RPC を呼べる形で得る。 */
function registryStub(): DurableObjectStub<StoreRegistryDO> {
  const id = env.STORE_REGISTRY_DO.idFromName(REGISTRY_NAME);
  // STORE_REGISTRY_DO は型生成上まだ素の DurableObjectNamespace（クラス型未反映）ゆえ、
  // インスタンスメソッドを呼ぶために class 型へ絞り込む。実体は再 export 済みの StoreRegistryDO。
  return env.STORE_REGISTRY_DO.get(id) as unknown as DurableObjectStub<StoreRegistryDO>;
}

describe("put-first: イデアの put 失敗時は fan-out せずイデア不変（Requirements 5.1）", () => {
  // シングルトンのレジストリと店舗 DO は storage を跨いで残るため、各テスト後に永続を掃除する。
  afterEach(async () => {
    await reset();
  });

  it("イデアの put が失敗すると createStore は reject し、投影押し込みもイデア書き込みも起きない", async () => {
    const storeId = "putfail-store";
    const stub = registryStub();

    await runInDurableObject(stub, async (instance, state) => {
      const originalPut = state.storage.put.bind(state.storage);
      // イデアの put（確定の起点）に失敗を注入する。commitIdeal はここで throw し、converge へ進めない。
      // 判定に使う get は素通しさせる（put のみ差し替え）ので「書かれていない」ことを同一 storage で観測できる。
      (state.storage as { put: unknown }).put = () =>
        Promise.reject(new Error("injected ideal put failure"));
      try {
        await expect(
          instance.createStore({ storeId, chainId: "chain-1", name: "Put Fail Store" }),
        ).rejects.toThrow();
      } finally {
        // 後続アサーションの読み出し（get）は本物のままだが、put も復旧して DO を健全な状態へ戻す。
        (state.storage as { put: unknown }).put = originalPut;
      }
    });

    // ── イデア不変（put 成功が無いので何も確定していない）──
    await runInDurableObject(stub, async (_instance, state) => {
      // 店舗イデアは書かれていない。
      expect(await state.storage.get(storeKey(storeId))).toBeUndefined();
      // revision は増えていない（イデア未書き込みの初期状態＝未永続）。
      expect(await state.storage.get(REVISION_KEY)).toBeUndefined();
      // 残作業も確定していない（converge の駆動源が生まれていない）。
      expect(await state.storage.get(RESIDUAL_KEY)).toBeUndefined();
    });

    // ── fan-out ゼロ（対象店舗 DO に投影が一切押し込まれていない）──
    const storeStub = env.STORE_TIMER_DO.get(env.STORE_TIMER_DO.idFromName(storeId));
    await runInDurableObject(storeStub, async (_instance, state) => {
      // applyProjection は成功時に必ず "projection" を put する。その不在 = 一度も届いていない。
      expect(await state.storage.get(STORE_PROJECTION_KEY)).toBeUndefined();
    });
  });

  it("正常系（put 失敗なし）では同じ登録がイデアを確定し投影を押し込む（注入の効きの対照）", async () => {
    // put 失敗が無ければ fan-out が確かに起きることを示し、上のテストの「投影不在」が put 失敗に
    // 帰属することを担保する（対照実験）。put-first の順序そのものではなく、注入の妥当性の裏取り。
    const storeId = "ok-store";
    const stub = registryStub();

    const result = await runInDurableObject(stub, (instance) =>
      instance.createStore({ storeId, chainId: "chain-1", name: "OK Store" }),
    );
    expect(result.accepted).toBe(true);

    // イデアが確定している（store イデア・revision が書かれた）。
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get(storeKey(storeId))).toBeDefined();
      expect(await state.storage.get(REVISION_KEY)).toBe(1);
    });

    // 対象店舗 DO へ投影が押し込まれ、version がレジストリ revision（1）に一致する。
    const storeStub = env.STORE_TIMER_DO.get(env.STORE_TIMER_DO.idFromName(storeId));
    await runInDurableObject(storeStub, async (_instance, state) => {
      const projection = await state.storage.get(STORE_PROJECTION_KEY);
      expect(projection).toBeDefined();
      expect((projection as { version: number }).version).toBe(1);
    });
  });
});
