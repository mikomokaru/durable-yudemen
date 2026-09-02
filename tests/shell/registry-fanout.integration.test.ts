import { describe, it, expect, afterEach } from "vitest";
import { env, runInDurableObject, runDurableObjectAlarm, reset } from "cloudflare:test";
import {
  REGISTRY_NAME,
  REVISION_KEY,
  RESIDUAL_KEY,
  type StoreRegistryDO,
} from "../../src/shell/store-registry-do";

// registry-fanout.integration.test.ts — 100 店 fan-out の Alarm 継続の統合テスト（Workers pool）。
//
// _Validates: Requirements 5.5_
//
// 検証する不変：チェーン規模（100 店）のイデア変更が、1 回の converge 実行に閉じず、残作業を永続して
// Alarm 継続で全店へ収束する（at-least-once・last-write-wins）。StoreRegistryDO は 1 回の実行で
// CONVERGE_MAX_PUSHES_PER_RUN（25）店までしか押し込まず、残りを converge:residual に永続して Alarm を張る
// （要件5.8）。Alarm を繰り返し駆動すると残作業がドレインし、最終的に全 100 店の投影 version が
// レジストリの meta:revision（合成時点の revision）に一致する（要件5.5・5.4・5.9）。
//
// 収束シナリオ（設計に忠実）：
//   1. 1 チェーンに 100 店を createStore で登録する。各 createStore は当該 1 店だけを収束させる
//      （residual=[storeId]・25 未満ゆえ 1 回でドレイン）。この時点で各店の投影 version は登録時 revision。
//   2. チェーンを 1 回更新（createOrUpdateChain）する。affectedStores（chain 変種）が全 100 店を返し、
//      residual=100 店として put-first で確定する。続く converge() は先頭 25 店だけを押し込み、残り 75 店を
//      residual に残して Alarm を張る——ここが「1 回の実行に閉じない」crux。
//   3. runDurableObjectAlarm を残作業が尽きるまで繰り返す。各 Alarm が次の 25 店を押し、25 未満になれば
//      張り直さない。最終的に全店の投影 version がチェーン更新後の meta:revision に一致する（last-write-wins）。
//
// 100 店それぞれが登録時に別 version を持っていたにもかかわらず、チェーン更新後は全店が同一の最新 revision へ
// 揃う——これが last-write-wins（常に最新イデアから再合成・履歴順序を持たない・要件5.4）の直接の証左。

/** StoreTimerDO が投影を永続する単一キー（store-timer-do.ts の PROJECTION_KEY と同値。private ゆえ literal で参照）。 */
const STORE_PROJECTION_KEY = "projection";

/** 収束させるチェーン規模。設計が「100 店程度の fan-out」を Alarm 継続で捌く前提ゆえ 100 で振る（要件5.5）。 */
const STORE_COUNT = 100;

/** テスト対象チェーンの識別子。affectedStores（chain 変種）が chainId 一致で全店を逆引きする。 */
const CHAIN_ID = "chain-fanout";

/** レジストリ（シングルトン）のスタブを、型付き RPC（createStore / createOrUpdateChain）を呼べる形で得る。 */
function registryStub(): DurableObjectStub<StoreRegistryDO> {
  const id = env.STORE_REGISTRY_DO.idFromName(REGISTRY_NAME);
  // STORE_REGISTRY_DO は型生成上まだ素の DurableObjectNamespace（クラス型未反映）ゆえ、
  // インスタンスメソッドを RPC で呼ぶために class 型へ絞り込む（実体は再 export 済みの StoreRegistryDO）。
  return env.STORE_REGISTRY_DO.get(id) as unknown as DurableObjectStub<StoreRegistryDO>;
}

/** 決定的な storeId（[a-z0-9-]・長さ ≤64 を満たす）を採番せず明示指定して、投影の突き合わせを一意にする。 */
function storeIdAt(index: number): string {
  return `fanout-store-${String(index).padStart(3, "0")}`;
}

describe("100 店 fan-out の Alarm 継続で全店が最終収束する（Requirements 5.5）", () => {
  // シングルトンのレジストリと 100 店の店舗 DO は storage を跨いで残るため、各テスト後に永続を掃除する。
  afterEach(async () => {
    await reset();
  });

  it("チェーン更新の収束は 1 回に閉じず残作業を Alarm 継続でドレインし、全店の投影が最新 revision に揃う", async () => {
    const stub = registryStub();
    const storeIds = Array.from({ length: STORE_COUNT }, (_unused, i) => storeIdAt(i));

    // ── 1. 100 店を登録する（各 createStore は当該 1 店だけを収束させ、1 回でドレインする）。──
    for (const storeId of storeIds) {
      // 直列に登録する（レジストリはシングルトン DO 内で直列化される。RPC は都度スタブで足りる）。
      // oxlint-disable-next-line no-await-in-loop
      const created = await stub.createStore({
        storeId,
        chainId: CHAIN_ID,
        name: `Store ${storeId}`,
      });
      expect(created.accepted).toBe(true);
    }

    // 100 回のイデア書き込みで revision は 100（狭義単調・要件5.6）。この時点では各店の version は登録時 revision。
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get(REVISION_KEY)).toBe(STORE_COUNT);
      // 各 createStore の収束は 1 回でドレインするため、残作業は空（Alarm 継続の駆動源は未だ生まれていない）。
      expect(await state.storage.get(RESIDUAL_KEY)).toEqual([]);
    });

    // ── 2. チェーンを 1 回更新する。affectedStores が全 100 店を返し、residual=100 として確定する。──
    // これが fan-out の起点。converge() は同期に先頭 25 店だけ押し、残り 75 店を residual に残して Alarm を張る。
    const chainResult = await stub.createOrUpdateChain(CHAIN_ID, { name: "Fanout Chain" });
    expect(chainResult.accepted).toBe(true);

    // チェーン更新でイデアがもう 1 度書かれ revision は 101（= STORE_COUNT + 1）。全店はこの revision へ収束すべき。
    const finalRevision = await runInDurableObject(stub, async (_instance, state) => {
      return (await state.storage.get(REVISION_KEY)) as number;
    });
    expect(finalRevision).toBe(STORE_COUNT + 1);

    // crux：1 回の converge 実行では全店を捌けず、残作業が永続されている（0 < 残り < 100）。
    // これが「1 回の実行に閉じず残作業を永続して Alarm 継続する」ことの直接の証左（要件5.5 / 5.8）。
    const residualAfterFirstRun = await runInDurableObject(stub, async (_instance, state) => {
      return (await state.storage.get(RESIDUAL_KEY)) as readonly string[];
    });
    expect(residualAfterFirstRun.length).toBeGreaterThan(0);
    expect(residualAfterFirstRun.length).toBeLessThan(STORE_COUNT);

    // ── 3. 残作業が尽きるまで Alarm を駆動する（Alarm 継続）。──
    // runDurableObjectAlarm は予約済み Alarm を 1 回走らせて true を返し、予約が無ければ false。
    // alarm() は残作業がある間だけ次の Alarm を張り直すため、false が返るまで回せばドレイン完了。
    let alarmRuns = 0;
    // 上限は安全網（各 Alarm が最低 1 店は押す前提で、店舗数を超える反復は起こり得ない）。
    for (let i = 0; i < STORE_COUNT + 1; i++) {
      // oxlint-disable-next-line no-await-in-loop
      const ran = await runDurableObjectAlarm(stub);
      if (!ran) break;
      alarmRuns++;
    }
    // 少なくとも 1 回は Alarm 継続が起きた（初回同期 converge だけでは終わらなかった＝実行境界を跨いだ）。
    expect(alarmRuns).toBeGreaterThan(0);

    // 残作業は空へドレインした（収束完了・要件5.8）。
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get(RESIDUAL_KEY)).toEqual([]);
    });

    // ── 全 100 店の投影が最終 revision に一致する（last-write-wins・要件5.4 / 5.9）。──
    // 登録時にバラバラの version を持っていた全店が、チェーン更新後の同一 revision へ揃うことを確認する。
    for (const storeId of storeIds) {
      const storeStub = env.STORE_TIMER_DO.get(env.STORE_TIMER_DO.idFromName(storeId));
      // oxlint-disable-next-line no-await-in-loop
      await runInDurableObject(storeStub, async (_instance, state) => {
        const projection = (await state.storage.get(STORE_PROJECTION_KEY)) as
          | { version: number }
          | undefined;
        // 投影が押し込まれ、version がレジストリの meta:revision に一致する（全店が最終収束）。
        expect(projection).toBeDefined();
        expect(projection?.version).toBe(finalRevision);
      });
    }
  });
});
