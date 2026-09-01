// Feature: synchronized-boil-adjustment, Integration: Persist failure suppresses broadcast
// Validates: Requirements 5.3, 7.8

import { afterEach, describe, expect, it, vi } from "vitest";
import { env, evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import type { ServerMessage } from "../../src/domain/messages";
import type { NoodlePreset, StoreConfig } from "../../src/domain/store";
import type { NonEmptyArray } from "../../src/domain/timer";
import type { StoreSnapshot } from "../../src/engine/snapshot";
import type { TimerState } from "../../src/engine/state";
import type { StoreProjection } from "../../src/registry/projection";
import type { StoreTimerDO } from "../../src/shell/store-timer-do";
import { configResidualDefaults } from "../storeConfigDefaults";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const SNAPSHOT_KEY = "activeTimers";
const EVENT_TIME = 1_700_000_000_000;
const NOODLE = "BoilSyncRamen";
const UNIT_COUNT = 1;

type SnapshotMessage = Extract<ServerMessage, { readonly type: "snapshot" }>;

const storeConfig: StoreConfig = {
  unitCount: UNIT_COUNT,
  arms: 2,
  toleranceRatio: 10,
  noodlePresets: [
    { noodleType: NOODLE, boilSeconds: { extraHard: 90, hard: 100, normal: 110, soft: 120 } },
  ] as NonEmptyArray<NoodlePreset>,
  ...configResidualDefaults(UNIT_COUNT),
};

interface WsProbe {
  readonly messages: readonly ServerMessage[];
  waitForSnapshot(
    predicate: (message: SnapshotMessage) => boolean,
    timeoutMs?: number,
  ): Promise<SnapshotMessage>;
  send(message: unknown): void;
  close(): void;
}

function freshStoreId(): string {
  return `boil-sync-persist-failure-${crypto.randomUUID()}`;
}

function storeStub(storeId: string): DurableObjectStub<StoreTimerDO> {
  return env.STORE_TIMER_DO.getByName(storeId) as DurableObjectStub<StoreTimerDO>;
}

async function provision(storeId: string): Promise<DurableObjectStub<StoreTimerDO>> {
  const stub = storeStub(storeId);
  const projection: StoreProjection = { config: storeConfig, roster: [], active: true, version: 1 };
  await stub.applyProjection(projection);
  return stub;
}

async function connect(stub: DurableObjectStub<StoreTimerDO>): Promise<WsProbe> {
  const upgrade = await stub.fetch("https://do.invalid/s/store/ws", {
    headers: { Upgrade: "websocket" },
  });
  const ws = upgrade.webSocket;
  if (ws === null) throw new Error(`WS 接続が確立されなかった（status=${upgrade.status}）`);

  const messages: ServerMessage[] = [];
  const waiters: {
    readonly predicate: (message: SnapshotMessage) => boolean;
    readonly resolve: (message: SnapshotMessage) => void;
  }[] = [];
  ws.accept();
  ws.addEventListener("message", (event: MessageEvent) => {
    const message = JSON.parse(event.data as string) as ServerMessage;
    messages.push(message);
    if (message.type !== "snapshot") return;
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter !== undefined && waiter.predicate(message)) {
        waiter.resolve(message);
        waiters.splice(index, 1);
      }
    }
  });

  return {
    messages,
    waitForSnapshot(predicate, timeoutMs = 5_000) {
      const received = messages.find(
        (message): message is SnapshotMessage => message.type === "snapshot" && predicate(message),
      );
      if (received !== undefined) return Promise.resolve(received);
      return new Promise<SnapshotMessage>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("snapshot の待機がタイムアウトした")),
          timeoutMs,
        );
        waiters.push({
          predicate,
          resolve: (message) => {
            clearTimeout(timeout);
            resolve(message);
          },
        });
      });
    },
    send: (message: unknown) => ws.send(JSON.stringify(message)),
    close: () => ws.close(),
  };
}

function idle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readSnapshot(stub: DurableObjectStub<StoreTimerDO>): Promise<StoreSnapshot> {
  const snapshot = await runInDurableObject(stub, (_instance, state) =>
    state.storage.get<StoreSnapshot>(SNAPSHOT_KEY),
  );
  if (snapshot === undefined) throw new Error("activeTimers が永続されていない");
  return snapshot;
}

function effectiveEndTimes(snapshot: StoreSnapshot): Readonly<Record<string, number>> {
  return Object.fromEntries(
    snapshot.timers.map((timer) => [timer.id, timer.endTime + timer.adjustment]),
  );
}

function projectedEndTimes(snapshot: SnapshotMessage): Readonly<Record<string, number>> {
  return Object.fromEntries(snapshot.timers.map((timer) => [timer.id, timer.endTime]));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("Feature: synchronized-boil-adjustment, Integration: Persist failure suppresses broadcast", () => {
  it("Persist失敗では集合変更後のsnapshotを配信せず、直前のAdjustmentをSSOTとhydrationへ保つ", async () => {
    vi.spyOn(Date, "now").mockReturnValue(EVENT_TIME);
    const stub = await provision(freshStoreId());
    const client = await connect(stub);
    await client.waitForSnapshot((message) => message.timers.length === 0);

    client.send({ type: "start", slotIds: ["0"], noodleType: NOODLE, boilSeconds: 100 });
    await client.waitForSnapshot((message) => message.timers.length === 1);
    client.send({ type: "start", slotIds: ["1"], noodleType: NOODLE, boilSeconds: 110 });
    const confirmedBroadcast = await client.waitForSnapshot(
      (message) => message.timers.length === 2,
    );
    await idle(200);

    const confirmed = await readSnapshot(stub);
    expect(confirmed.timers).toHaveLength(2);
    expect(confirmed.timers.map(({ endTime }) => endTime)).toEqual([
      EVENT_TIME + 100_000,
      EVENT_TIME + 110_000,
    ]);
    expect(confirmed.timers.map(({ adjustment }) => adjustment)).toEqual([4_500, -5_500]);
    const confirmedEffectiveEndTimes = effectiveEndTimes(confirmed);
    expect(projectedEndTimes(confirmedBroadcast)).toEqual(confirmedEffectiveEndTimes);

    const cancelledTimerId = confirmed.timers[0]?.id;
    if (cancelledTimerId === undefined) throw new Error("取消対象 Timer がない");
    const messagesBeforeFailure = client.messages.length;

    const workingCopies = await runInDurableObject(stub, async (instance, state) => {
      const runtime = instance as unknown as { workingCopy: TimerState };
      const before = runtime.workingCopy;
      const originalPut = state.storage.put.bind(state.storage);
      (state.storage as { put: unknown }).put = () => Promise.reject(new Error("put failed"));
      try {
        const commandSocket = new WebSocketPair()[0];
        await instance.webSocketMessage(
          commandSocket,
          JSON.stringify({ type: "cancel", timerId: cancelledTimerId }),
        );
        return { before, after: runtime.workingCopy };
      } finally {
        (state.storage as { put: unknown }).put = originalPut;
      }
    });

    await idle(200);
    expect(client.messages).toHaveLength(messagesBeforeFailure);
    expect(await readSnapshot(stub)).toEqual(confirmed);
    expect(workingCopies.after).toBe(workingCopies.before);
    expect(workingCopies.after.timers).toEqual(confirmed.timers);
    expect(workingCopies.after.timers.find(({ id }) => id === cancelledTimerId)).toBeDefined();
    expect(workingCopies.after.timers.every((timer) => timer.adjustment !== 0)).toBe(true);

    client.close();
    await evictDurableObject(stub, { webSockets: "close" });
    const reconnected = await connect(stub);
    const hydrated = await reconnected.waitForSnapshot((message) => message.timers.length === 2);
    expect(projectedEndTimes(hydrated)).toEqual(confirmedEffectiveEndTimes);

    reconnected.close();
  });
});
