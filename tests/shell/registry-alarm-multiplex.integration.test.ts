// tests/shell/registry-alarm-multiplex.integration.test.ts — Alarm 1 本での多重化の統合テスト
// （Workers pool）。
//
// _Validates: Requirements 11.11_
//
// DO の Alarm は 1 本しかない。ゆえに収束（converge:residual）と再生（replay:residual）は同一ハンドラで
// 捌かれ、3 つの不変が同時に成り立たなければならない（design §9-a）。
//
//   (1) ハンドラは両方の残作業を見る（片方だけ見て早期 return すれば、もう片方が永久に残る）
//   (2) setAlarm は両者の要求の最小値（後から張る側が先の要求を後ろへずらさない）
//   (3) 再生の失敗が収束の retryCount を消費しない（再生は throw せず残作業に残す）
//
// (3) が要るのは、`retryCount` が収束の「上限近傍なら throw せず張り直す」判断に使う唯一の材料だからである。
// 再生がこれを食えば、収束は自動リトライを使い切った状態で失敗しうる。

import { afterEach, describe, expect, it } from "vitest";
import { env, reset, runInDurableObject } from "cloudflare:test";
import {
  REGISTRY_NAME,
  REPLAY_RESIDUAL_KEY,
  RESIDUAL_KEY,
  convergedVersionKey,
  unroutedKey,
  type StoreRegistryDO,
} from "../../src/shell/store-registry-do";
import type { HeldRecord } from "../../src/registry/held-record";
import type { ArrivalRecord } from "../../src/ingress/batch";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

/** 上流の KDS が採る桁数。桁が揃っていれば辞書順が数値順に一致する。 */
function seq(n: number): string {
  return String(n).padStart(56, "0");
}

function registryStub(): DurableObjectStub<StoreRegistryDO> {
  const id = env.STORE_REGISTRY_DO.idFromName(REGISTRY_NAME);
  return env.STORE_REGISTRY_DO.get(id) as unknown as DurableObjectStub<StoreRegistryDO>;
}

/** 店舗を登録する（登録の確定で投影が押し込まれ、再生の宛先が生きる）。 */
async function registerStore(
  stub: DurableObjectStub<StoreRegistryDO>,
  storeId: string,
  storeCode: string,
): Promise<void> {
  const res = await stub.fetch(
    new Request("https://registry/admin/stores", {
      method: "POST",
      body: JSON.stringify({ storeId, chainId: "yamaokaya", name: `${storeCode} 店`, storeCode }),
      headers: { "Content-Type": "application/json" },
    }),
  );
  expect(res.status).toBe(201);
}

function arrivalRecord(sequenceNumber: string, arrivalTimestampMs: number): ArrivalRecord {
  return {
    path: "/lio/order",
    payload: {
      store_id: "R",
      terminal_id: "1",
      bill_no: sequenceNumber,
      datetime: "2026-08-17T20:52:19",
      order_items: [],
    },
    arrivalTimestampMs,
    sequenceNumber,
  };
}

function heldRecord(sequenceNumber: string): HeldRecord {
  const now = Date.now();
  return { kind: "unrouted", heldAt: now, record: arrivalRecord(sequenceNumber, now - 1_000) };
}

/** 収束の残作業を直に置く（イデアの変更を経ずに「継続すべき状態」だけを作る）。 */
async function seedConvergeResidual(
  stub: DurableObjectStub<StoreRegistryDO>,
  storeIds: readonly string[],
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => state.storage.put(RESIDUAL_KEY, storeIds));
}

/** 再生の残作業と保留を直に置く（保留の書き込み経路が張る Alarm を混ぜないため直に置く）。 */
async function seedReplayResidual(
  stub: DurableObjectStub<StoreRegistryDO>,
  storeCode: string,
  held: readonly HeldRecord[],
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put(unroutedKey(storeCode), held);
    await state.storage.put(REPLAY_RESIDUAL_KEY, [storeCode]);
  });
}

async function readKey<T>(
  stub: DurableObjectStub<StoreRegistryDO>,
  key: string,
): Promise<T | undefined> {
  return runInDurableObject(stub, (_instance, state) => state.storage.get<T>(key));
}

async function readAlarm(stub: DurableObjectStub<StoreRegistryDO>): Promise<number | null> {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

/**
 * ハンドラの内側（private）へ触るための窓。
 *
 * `converge` と `armAlarm` を直に呼ぶのは、**Alarm 要求の畳み方だけを取り出して観測するため**である
 * （イデアの変更経路を通せば、畳む前の要求が何秒後だったかが観測から消える）。
 */
interface AlarmInternals {
  converge(): Promise<void>;
  armAlarm(at: number): Promise<void>;
  drainUnrouted(
    storeCode: string,
  ): Promise<{ readonly kind: string; readonly windowExpired: number }>;
}

function internals(instance: StoreRegistryDO): AlarmInternals {
  return instance as unknown as AlarmInternals;
}

afterEach(async () => {
  await reset();
});

describe("ハンドラは両方の残作業を見る（Requirements 11.11）", () => {
  it("収束と再生が同時に在るとき、1 回の alarm() で両方が進む", async () => {
    const stub = registryStub();
    await registerStore(stub, "mux-both", "7001");
    await seedConvergeResidual(stub, ["mux-both"]);
    await seedReplayResidual(stub, "7001", [heldRecord(seq(1))]);

    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.deleteAlarm();
      await instance.alarm();
    });

    // 収束が進んだ（残作業が空になり、受領 version が台帳へ入った）。
    expect(await readKey(stub, RESIDUAL_KEY)).toEqual([]);
    expect(await readKey(stub, convergedVersionKey("mux-both"))).toBeDefined();
    // 再生も同じ回で進んだ（保留が空・残作業も空）。
    expect(await readKey(stub, unroutedKey("7001"))).toBeUndefined();
    expect(await readKey(stub, REPLAY_RESIDUAL_KEY)).toEqual([]);
    // 両方が空になったので張り直さない（作業があるときだけ張る）。
    expect(await readAlarm(stub)).toBeNull();
  });

  it("収束だけが在るときも進む（再生の不在で早期 return しない）", async () => {
    const stub = registryStub();
    await registerStore(stub, "mux-converge-only", "7002");
    await seedConvergeResidual(stub, ["mux-converge-only"]);

    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.deleteAlarm();
      await instance.alarm();
    });

    expect(await readKey(stub, RESIDUAL_KEY)).toEqual([]);
    expect(await readAlarm(stub)).toBeNull();
  });

  it("再生だけが在るときも進む（収束の不在で早期 return しない）", async () => {
    const stub = registryStub();
    await registerStore(stub, "mux-replay-only", "7003");
    await seedReplayResidual(stub, "7003", [heldRecord(seq(2))]);

    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.deleteAlarm();
      await instance.alarm();
    });

    expect(await readKey(stub, unroutedKey("7003"))).toBeUndefined();
    expect(await readKey(stub, REPLAY_RESIDUAL_KEY)).toEqual([]);
    expect(await readAlarm(stub)).toBeNull();
  });

  it("両方の残作業が空なら Alarm を張り直さない", async () => {
    const stub = registryStub();
    await registerStore(stub, "mux-idle", "7004");

    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.deleteAlarm();
      await instance.alarm();
    });

    expect(await readAlarm(stub)).toBeNull();
  });
});

describe("再生の失敗は収束の retryCount を消費しない（Requirements 11.11）", () => {
  it("再生が失敗しても alarm() は throw せず、収束はその回で捌かれる", async () => {
    const stub = registryStub();
    await registerStore(stub, "mux-replay-fail", "7005");
    await seedConvergeResidual(stub, ["mux-replay-fail"]);
    await seedReplayResidual(stub, "7005", [heldRecord(seq(3))]);

    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.deleteAlarm();
      const original = internals(instance).drainUnrouted.bind(instance);
      internals(instance).drainUnrouted = () =>
        Promise.reject(new Error("injected replay failure"));
      try {
        // throw しない＝Cloudflare の自動リトライを起こさない＝retryCount を消費しない。
        await expect(instance.alarm()).resolves.toBeUndefined();
      } finally {
        internals(instance).drainUnrouted = original;
      }
    });

    // 収束は同じ回で捌かれた（再生の失敗に巻き込まれない）。
    expect(await readKey(stub, RESIDUAL_KEY)).toEqual([]);
    // 再生は残作業に残り、保留は 1 件も削られていない（送れていないものを送ったとしない）。
    expect(await readKey(stub, REPLAY_RESIDUAL_KEY)).toEqual(["7005"]);
    expect(await readKey<readonly HeldRecord[]>(stub, unroutedKey("7005"))).toHaveLength(1);
    // 次の契機は失われていない。
    expect(await readAlarm(stub)).not.toBeNull();

    // 障害が解けた次の回で再生は完了する（残作業に残していたものが捌かれる）。
    await runInDurableObject(stub, (instance) => instance.alarm());
    expect(await readKey(stub, unroutedKey("7005"))).toBeUndefined();
    expect(await readKey(stub, REPLAY_RESIDUAL_KEY)).toEqual([]);
  });

  it("収束が失敗しても再生は同じ回で走る（片方の失敗でもう片方を止めない）", async () => {
    const stub = registryStub();
    await registerStore(stub, "mux-converge-fail", "7006");
    // イデアに無い storeId は recomposeProjection の前提違反ゆえ収束本体が throw する。
    await seedConvergeResidual(stub, ["ghost-store"]);
    await seedReplayResidual(stub, "7006", [heldRecord(seq(4))]);

    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.deleteAlarm();
      // 収束は durable な進捗を残せず失敗ゆえ throw（自動リトライへ委ねる）。
      await expect(instance.alarm()).rejects.toThrow();
    });

    // 再生は収束の失敗に巻き込まれず完走した。
    expect(await readKey(stub, unroutedKey("7006"))).toBeUndefined();
    expect(await readKey(stub, REPLAY_RESIDUAL_KEY)).toEqual([]);
    // 収束の残作業は残る（何も確定していない）。
    expect(await readKey(stub, RESIDUAL_KEY)).toEqual(["ghost-store"]);
  });
});

describe("setAlarm は両者の要求の最小値（Requirements 11.11）", () => {
  it("先に張られた要求より早い要求だけが張り直す", async () => {
    const stub = registryStub();
    const base = Date.now();

    const observed = await runInDurableObject(stub, async (instance, state) => {
      // 収束が 2 秒後を要求している状態を作る。
      await state.storage.setAlarm(base + 2_000);
      // 再生がより早い要求をしたら、早い方が残る。
      await internals(instance).armAlarm(base + 500);
      const earlier = await state.storage.getAlarm();
      // 逆に遅い要求は先の要求を後ろへずらさない。
      await internals(instance).armAlarm(base + 5_000);
      return { earlier, afterLater: await state.storage.getAlarm() };
    });

    expect(observed.earlier).toBe(base + 500);
    expect(observed.afterLater).toBe(base + 500);
  });

  it("converge() の Alarm 要求も畳まれる（先の早い要求を後ろへずらさない）", async () => {
    const stub = registryStub();
    const base = Date.now();
    // 収束本体を失敗させる（converge は catch で継続の Alarm を張る）。
    await seedConvergeResidual(stub, ["ghost-store"]);

    const alarm = await runInDurableObject(stub, async (instance, state) => {
      // 再生が既に 500ms 後を要求している状態。
      await state.storage.setAlarm(base + 500);
      await internals(instance).converge();
      return state.storage.getAlarm();
    });

    expect(alarm).toBe(base + 500);
  });

  it("alarm() の張り直し（retryCount 上限近傍）も先の早い要求を後ろへずらさない", async () => {
    const stub = registryStub();
    const base = Date.now();
    await seedConvergeResidual(stub, ["ghost-store"]);

    const alarm = await runInDurableObject(stub, async (instance, state) => {
      await state.storage.setAlarm(base + 500);
      // 上限近傍ゆえ throw せず継続を予約する経路。
      await instance.alarm({ retryCount: 5, isRetry: true, scheduledTime: base });
      return state.storage.getAlarm();
    });

    expect(alarm).toBe(base + 500);
  });
});
