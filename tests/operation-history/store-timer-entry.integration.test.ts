import { afterEach, describe, expect, it, vi } from "vitest";
import { env, evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { decide } from "../../src/engine/decide";
import type { Effect } from "../../src/engine/effect";
import type { SettleParams } from "../../src/engine/settle";
import type { StoreSnapshot } from "../../src/engine/snapshot";
import type { TimerState } from "../../src/engine/state";
import type { EpochMillis } from "../../src/engine/types";
import type { StoreTimerDO } from "../../src/shell/store-timer-do";

declare module "cloudflare:test" { interface ProvidedEnv extends Env {} }

const EVENT_TIME = 1_700_000_000_000;
const SNAPSHOT_KEY = "activeTimers";

function stub(storeId: string): DurableObjectStub<StoreTimerDO> {
  return env.STORE_TIMER_DO.getByName(storeId) as DurableObjectStub<StoreTimerDO>;
}

function setHistory(instance: StoreTimerDO, enabled: boolean): void {
  const runtime = instance as unknown as { env: { OPERATION_HISTORY_ENABLED: string } };
  runtime.env.OPERATION_HISTORY_ENABLED = enabled ? "1" : "0";
}

function setHistoryBinding(enabled: boolean): void {
  const bindings = env as unknown as { OPERATION_HISTORY_ENABLED: string };
  bindings.OPERATION_HISTORY_ENABLED = enabled ? "1" : "0";
}

async function startTimer(
  instance: StoreTimerDO,
  slotId: string,
  boilSeconds: number,
): Promise<void> {
  const ws = new WebSocketPair()[0];
  await instance.webSocketMessage(ws, JSON.stringify({
    type: "start",
    slotIds: [slotId],
    noodleType: "Thin",
    boilSeconds,
  }));
}

afterEach(async () => {
  setHistoryBinding(false);
  vi.restoreAllMocks();
  await reset();
});

describe("StoreTimerDO Operation History 入口", () => {
  it("WebSocket Persist と Alarm Persist の通常完了後だけ同じ now で出力する", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const clock = vi.spyOn(Date, "now").mockReturnValue(EVENT_TIME);
    const storeId = `history-${crypto.randomUUID()}`;
    await runInDurableObject(stub(storeId), async (instance) => {
      setHistory(instance, true);
      await startTimer(instance, "1", 1);
      clock.mockReturnValue(EVENT_TIME + 2_000);
      await instance.alarm();
    });
    const records = log.mock.calls.map(([line]) => JSON.parse(line as string) as Record<string, unknown>);
    expect(records.map(({ storeId: id, operationKind, eventTime }) => [id, operationKind, eventTime])).toEqual([
      [storeId, "boil-started", EVENT_TIME],
      [storeId, "boiled", EVENT_TIME + 2_000],
    ]);
  });

  it("OFF、rejection 相当の不正 message、Persist 不在の Alarm は出力しない", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runInDurableObject(stub(`history-off-${crypto.randomUUID()}`), async (instance) => {
      setHistory(instance, false);
      await startTimer(instance, "1", 60);
      setHistory(instance, true);
      const ws = new WebSocketPair()[0];
      await instance.webSocketMessage(ws, "not-json");
      await instance.alarm();
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("fresh constructor の Reconcile だけが独自 now で boiled を出力し、後続 message は別 now を使う", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const clock = vi.spyOn(Date, "now").mockReturnValue(EVENT_TIME);
    const storeId = `history-reconcile-${crypto.randomUUID()}`;
    const object = stub(storeId);

    setHistoryBinding(false);
    await runInDurableObject(object, async (instance) => {
      await startTimer(instance, "1", 1);
    });

    setHistoryBinding(true);
    clock.mockReturnValue(EVENT_TIME + 2_000);
    await evictDurableObject(object, { webSockets: "close" });
    await runInDurableObject(object, async (instance) => {
      clock.mockReturnValue(EVENT_TIME + 3_000);
      setHistory(instance, true);
      await startTimer(instance, "2", 60);
    });

    const records = log.mock.calls.map(([line]) => JSON.parse(line as string) as Record<string, unknown>);
    expect(records.map(({ storeId: id, operationKind, eventTime }) => [id, operationKind, eventTime])).toEqual([
      [storeId, "boiled", EVENT_TIME + 2_000],
      [storeId, "boil-started", EVENT_TIME + 3_000],
    ]);
  });

  it("Reconcile の差分なしと running 再同期だけの Persist は出力しない", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const clock = vi.spyOn(Date, "now").mockReturnValue(EVENT_TIME);

    const unchangedObject = stub(`history-reconcile-noop-${crypto.randomUUID()}`);
    await runInDurableObject(unchangedObject, async (instance) => {
      await startTimer(instance, "1", 60);
    });
    setHistoryBinding(true);
    clock.mockReturnValue(EVENT_TIME + 1_000);
    await evictDurableObject(unchangedObject, { webSockets: "close" });
    await runInDurableObject(unchangedObject, () => undefined);

    setHistoryBinding(false);
    clock.mockReturnValue(EVENT_TIME);
    const resyncObject = stub(`history-reconcile-resync-${crypto.randomUUID()}`);
    await runInDurableObject(resyncObject, async (instance, state) => {
      await startTimer(instance, "1", 60);
      clock.mockReturnValue(EVENT_TIME + 10_000);
      await startTimer(instance, "2", 60);
      const snapshot = await state.storage.get<StoreSnapshot>(SNAPSHOT_KEY);
      if (snapshot === undefined) throw new Error("activeTimers が永続されていない");
      await state.storage.put(SNAPSHOT_KEY, {
        ...snapshot,
        timers: snapshot.timers.map((timer) => ({ ...timer, adjustment: 0 })),
      });
    });

    setHistoryBinding(true);
    clock.mockReturnValue(EVENT_TIME + 20_000);
    await evictDurableObject(resyncObject, { webSockets: "close" });
    const reconciled = await runInDurableObject(resyncObject, (_instance, state) =>
      state.storage.get<StoreSnapshot>(SNAPSHOT_KEY));

    expect(reconciled?.timers.some((timer) => timer.adjustment !== 0)).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  it("constructor と同じ Reconcile 境界で Persist が失敗すると確定せず出力しない", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const clock = vi.spyOn(Date, "now").mockReturnValue(EVENT_TIME);
    const object = stub(`history-reconcile-persist-failure-${crypto.randomUUID()}`);

    await runInDurableObject(object, async (instance, state) => {
      await startTimer(instance, "1", 1);
      const runtime = instance as unknown as {
        workingCopy: TimerState;
        // decide へ渡す値の束は DO 自身が組む（本番経路と同じ値で Reconcile を再現する）。
        settleParams: () => SettleParams;
        runEffects: (effects: readonly Effect[]) => Promise<{ readonly persisted: boolean }>;
        tryWriteCommittedOperation: (
          eventKind: "Reconcile",
          eventTime: EpochMillis,
          before: TimerState,
          effects: readonly Effect[],
          result: { readonly persisted: boolean },
        ) => void;
      };
      const now = (EVENT_TIME + 2_000) as EpochMillis;
      const before = runtime.workingCopy;
      const outcome = decide(before, { type: "Reconcile", now }, runtime.settleParams());
      if (!outcome.ok) throw new Error("Reconcile が拒否された");

      const originalPut = state.storage.put.bind(state.storage);
      (state.storage as { put: unknown }).put = () => Promise.reject(new Error("put failed"));
      try {
        setHistory(instance, true);
        const result = await runtime.runEffects(outcome.effects);
        runtime.tryWriteCommittedOperation("Reconcile", now, before, outcome.effects, result);
        expect(result.persisted).toBe(false);
        expect(runtime.workingCopy).toBe(before);
      } finally {
        (state.storage as { put: unknown }).put = originalPut;
      }
    });

    const persisted = await runInDurableObject(object, (_instance, state) =>
      state.storage.get<StoreSnapshot>(SNAPSHOT_KEY));
    expect(persisted?.timers[0]?.boiledAt).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });
});


describe("StoreTimerDO Operation History 複数 Reconcile", () => {
  it("複数 running → boiled を一差分一行で出力し、後続 message と Event Time を分ける", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const clock = vi.spyOn(Date, "now").mockReturnValue(EVENT_TIME);
    const storeId = `history-multiple-reconcile-${crypto.randomUUID()}`;
    const object = stub(storeId);

    setHistoryBinding(false);
    const expectedTimerIds = await runInDurableObject(object, async (instance, state) => {
      await startTimer(instance, "1", 1);
      await startTimer(instance, "2", 1);
      const snapshot = await state.storage.get<StoreSnapshot>(SNAPSHOT_KEY);
      if (snapshot === undefined) throw new Error("activeTimers が永続されていない");
      return snapshot.timers.map(({ id }) => id);
    });

    setHistoryBinding(true);
    clock.mockReturnValue(EVENT_TIME + 2_000);
    await evictDurableObject(object, { webSockets: "close" });
    await runInDurableObject(object, async (instance) => {
      clock.mockReturnValue(EVENT_TIME + 3_000);
      setHistory(instance, true);
      await startTimer(instance, "3", 60);
    });

    const records = log.mock.calls.map(([line]) => JSON.parse(line as string) as {
      readonly timerId: string;
      readonly operationKind: string;
      readonly eventTime: number;
    });
    const reconciled = records.filter(({ operationKind }) => operationKind === "boiled");
    expect(reconciled).toHaveLength(2);
    expect(reconciled.map(({ timerId }) => timerId)).toEqual(expectedTimerIds);
    expect(reconciled.map(({ eventTime }) => eventTime)).toEqual([
      EVENT_TIME + 2_000,
      EVENT_TIME + 2_000,
    ]);
    expect(records.at(-1)).toMatchObject({
      operationKind: "boil-started",
      eventTime: EVENT_TIME + 3_000,
    });
    expect(log).toHaveBeenCalledTimes(3);
  });
});