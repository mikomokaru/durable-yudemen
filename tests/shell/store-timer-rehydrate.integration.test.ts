// tests/shell/store-timer-rehydrate.integration.test.ts — rehydrate 配線のうち、他所で覆われていない
// 2 節だけを受け持つ統合テスト（Workers pool）。
//
// _Validates: Requirements 7.4, 7.5, 8.6_
//
// **本ファイルが主張しないこと（既に他所が固めているため、ここでは繰り返さない）。**
//   - `get → migrate → fromSnapshot` の順序そのもの：
//       `tests/operation-history/no-wake.static.test.ts`（起動経路の呼び出し順を AST で固定）
//       `tests/shell/cook-scheduling.integration.test.ts`（v6 → v7 を実際の起動経路で通す）
//       `tests/operation-history/store-timer-observation-fault.integration.test.ts`
//       （construct 1 / rehydrate 1 / storageReads 2 の runtime カウンタ）
//   - snapshot 不在での起動が空状態を配信すること：
//       `tests/shell/hot-path.integration.test.ts` / `tests/shell/autonomy.integration.test.ts`
//       （接続直後の hydration snapshot が timers 0 件）
//
// **ゆえに本ファイルの関心は 2 節に絞る。**
//   (1) `storage.get` の失敗で Working_Copy を確定せず throw する（要件7.5 / 8.6）。永続層への注入は
//       これまで `put` にしか行われておらず、読み出し側の失敗経路は suite 全体で未到達だった。
//   (2) snapshot 不在の新規起動で Alarm を設定しない（要件7.4）。空 snapshot の配信は既存が主張済みだが、
//       「Alarm が張られていないこと」は誰も観測していない。
//
// **(1) で用いる継ぎ目と、それが誠実である理由。** 注入先は `runInDurableObject` が渡す実 instance の
// `ctx.storage`（既存の `put` 注入と同一の storage）で、起点は **エントリポイントの前段 `ensureLoaded`**
// である。constructor の `blockConcurrencyWhile` は handle が渡る時点で走り終えており、そこへは注入できない。
// 一方 `ensureLoaded` は要件7.1 の通り fetch / WebSocket メッセージ / alarm の各前段にも置かれ、`loaded`
// が false の instance（hibernate 復帰直後）でそこを通るのは実装が想定する本番経路そのものである
// （store-timer-do.ts の `loaded` フィールドのコメント：「hibernate 復帰ごとに false へ戻る」）。ゆえに
// `loaded` を false へ戻して同じ前件を作り、実 workerd・実 storage の上で読み出し失敗を通す。差し替えるのは
// storage の応答だけで、SUT（`ensureLoaded` 本体）は本物のまま走る。
//
// (1) の「確定していない」を観測可能にするため、走行中 Timer を 1 件確定させた上で読み出しを失敗させる。
// 失敗が空の Working_Copy を作ってしまうなら timers は 0 件へ潰れ、Alarm も解除されるはずで、その差が出る。

import { afterEach, describe, expect, it } from "vitest";
import { env, reset, runInDurableObject } from "cloudflare:test";
import type { StoreTimerDO } from "../../src/shell/store-timer-do";
import type { StoreProjection } from "../../src/registry/projection";
import type { NoodlePreset, StoreConfig } from "../../src/domain/store";
import type { NonEmptyArray } from "../../src/domain/timer";
import type { TimerState } from "../../src/engine/state";
import { configResidualDefaults } from "../storeConfigDefaults";

// cloudflare:test の env を本 Worker の Env 型で解決する（STORE_TIMER_DO バインディングを型付きで引く）。
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/** タイマー SSOT の単一キー。store-timer-do.ts の SNAPSHOT_KEY（private 定数）と一致させる。 */
const SNAPSHOT_KEY = "activeTimers";

/** 本テストが用いる麺種。プリセットに無い品目は start 時に解決できないため config と同じ値を使う。 */
const NOODLE = "RehydrateRamen";

/** ユニット 1 台（= 6 釜）。関心は rehydrate であり釜数ではないため最小構成で足りる。 */
const UNIT_COUNT = 1;

/** テスト中に発火しない茹で秒（発火は本ファイルの関心事ではない）。 */
const BOIL_SECONDS = 600;

const storeConfig: StoreConfig = {
  unitCount: UNIT_COUNT,
  arms: 3,
  toleranceRatio: 10,
  noodlePresets: [
    { noodleType: NOODLE, boilSeconds: { extraHard: 45, hard: 52, normal: 60, soft: 75 } },
  ] as NonEmptyArray<NoodlePreset>,
  ...configResidualDefaults(UNIT_COUNT),
};

/** 活性の「最後に受領した投影」。ACCESS OFF 期ゆえ roster は空でよい（関心は認可ではない）。 */
const lastProjection: StoreProjection = {
  config: storeConfig,
  roster: [],
  active: true,
  version: 1,
};

/** ensureLoaded の前件（未ロード）を作るために覗く runtime。private だが実装の設計上の状態そのもの。 */
interface RehydrateRuntime {
  loaded: boolean;
  workingCopy: TimerState;
}

/** run 間で DO 状態が持ち越さないよう storeId を一意に採番する（[a-z0-9-]・長さ ≤64 を満たす）。 */
function freshStoreId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/** 指定 storeId の店舗 DO スタブを、applyProjection（型付き RPC）を呼べる形で得る。 */
function storeStub(storeId: string): DurableObjectStub<StoreTimerDO> {
  const id = env.STORE_TIMER_DO.idFromName(storeId);
  // STORE_TIMER_DO は型生成上まだ素の DurableObjectNamespace ゆえ、RPC を呼ぶために class 型へ絞り込む。
  return env.STORE_TIMER_DO.get(id) as unknown as DurableObjectStub<StoreTimerDO>;
}

/** 投影を押し込んでプロビジョニングする（レジストリを介さない・design.md の推奨経路）。 */
async function provision(storeId: string): Promise<DurableObjectStub<StoreTimerDO>> {
  const stub = storeStub(storeId);
  await stub.applyProjection(lastProjection);
  return stub;
}

/** WS メッセージ経路で Timer を 1 件開始する（確定＝put 成功まで進む本番経路）。 */
async function startTimer(instance: StoreTimerDO, slotId: string): Promise<void> {
  const ws = new WebSocketPair()[0];
  await instance.webSocketMessage(
    ws,
    JSON.stringify({
      type: "start",
      slotIds: [slotId],
      noodleType: NOODLE,
      boilSeconds: BOIL_SECONDS,
    }),
  );
}

describe("rehydrate 配線の未到達節（要件7.4 / 7.5 / 8.6）", () => {
  // 店舗 DO の storage はテストを跨いで残るため、各テスト後に掃除して独立させる。
  afterEach(async () => {
    await reset();
  });

  it("storage.get の失敗で Working_Copy を確定せず throw し、永続層も Alarm も変えない（要件7.5 / 8.6）", async () => {
    const storeId = freshStoreId("rehydrate-read-failure");
    const stub = await provision(storeId);

    const observed = await runInDurableObject(stub, async (instance, state) => {
      // (1) 走行中 Timer を 1 件確定させる。以後の「潰れていないこと」を観測可能にするための足場。
      await startTimer(instance, "1");
      const runtime = instance as unknown as RehydrateRuntime;
      const copyBefore = runtime.workingCopy;
      const persistedBefore = await state.storage.get(SNAPSHOT_KEY);
      const alarmBefore = await state.storage.getAlarm();

      // (2) 要件7.1 の前件を作る：未ロードのままエントリポイントを起こす（hibernate 復帰の instance と同じ状態）。
      runtime.loaded = false;
      const originalGet = state.storage.get.bind(state.storage);
      (state.storage as { get: unknown }).get = () => Promise.reject(new Error("get failed"));

      let failure: unknown;
      try {
        // ensureLoaded が前段に立つ入口を通す。読み出しが失敗するため、start は core へ届かない。
        await startTimer(instance, "2");
      } catch (thrown) {
        failure = thrown;
      } finally {
        // 後続の観測（永続値・Alarm の読み出し）は本物の get で行う。
        (state.storage as { get: unknown }).get = originalGet;
      }

      return {
        failure,
        // 確定していない証左：loaded は false のまま（再初期化に委ねる）。
        loadedAfter: runtime.loaded,
        // Working_Copy は差し替えられていない（同一参照・件数も不変）。
        copyUntouched: runtime.workingCopy === copyBefore,
        timerCount: runtime.workingCopy.timers.length,
        persistedBefore,
        persistedAfter: await state.storage.get(SNAPSHOT_KEY),
        alarmBefore,
        alarmAfter: await state.storage.getAlarm(),
      };
    });

    // 失敗は握り潰されず呼び出し元へ伝播する（空の Working_Copy を黙って作らない）。
    expect(observed.failure).toBeInstanceOf(Error);
    expect((observed.failure as Error).message).toBe("get failed");

    // 状態を確定していない：ロード済みへ進めず、在メモリの 1 件も潰れていない。
    expect(observed.loadedAfter).toBe(false);
    expect(observed.copyUntouched).toBe(true);
    expect(observed.timerCount).toBe(1);

    // 永続層を変更していない（読み出し失敗は書き込みを一切起こさない）。
    expect(observed.persistedBefore).toBeDefined();
    expect(observed.persistedAfter).toEqual(observed.persistedBefore);

    // Alarm も触っていない（空状態からの ClearAlarm が走っていない証左）。
    expect(observed.alarmBefore).not.toBeNull();
    expect(observed.alarmAfter).toBe(observed.alarmBefore);
  });

  it("snapshot 不在の新規起動では Alarm を設定しない（要件7.4）", async () => {
    const storeId = freshStoreId("rehydrate-empty-start");
    // provision の applyProjection が初回接触＝この DO の cold start。constructor の rehydrate は
    // snapshot 不在（activeTimers キーなし）を空スナップショットへ写し、reconcile は no-op になる。
    const stub = await provision(storeId);

    const observed = await runInDurableObject(stub, async (instance, state) => ({
      // ロードは完了している（Alarm の不在が「まだ読んでいないだけ」ではないことの担保）。
      loaded: (instance as unknown as RehydrateRuntime).loaded,
      // 前件：タイマー SSOT の単一キーは不在（投影だけが永続されている）。
      snapshot: await state.storage.get(SNAPSHOT_KEY),
      alarm: await state.storage.getAlarm(),
    }));

    expect(observed.loaded).toBe(true);
    expect(observed.snapshot).toBeUndefined();
    // 要件7.4 の核：不在からの空初期化では Alarm を張らない。
    expect(observed.alarm).toBeNull();
  });
});
