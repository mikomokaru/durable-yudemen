// Feature: synchronized-boil-adjustment, Integration: all clients share adjusted end times
// Validates: Requirements 5.4, 5.5

import { afterEach, describe, expect, it, vi } from "vitest";
import { env, reset, runInDurableObject } from "cloudflare:test";
import type { ServerMessage } from "../../src/domain/messages";
import type { NoodlePreset, StoreConfig } from "../../src/domain/store";
import type { NonEmptyArray } from "../../src/domain/timer";
import type { StoreSnapshot } from "../../src/engine/snapshot";
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
  waitForSnapshot(
    predicate: (message: SnapshotMessage) => boolean,
    timeoutMs?: number,
  ): Promise<SnapshotMessage>;
  send(message: unknown): void;
  close(): void;
}

function freshStoreId(): string {
  return `boil-sync-multi-client-${crypto.randomUUID()}`;
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
  ws.accept();

  return {
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

function timerIds(snapshot: SnapshotMessage): readonly string[] {
  return snapshot.timers.map(({ id }) => id).sort();
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("Feature: synchronized-boil-adjustment, Integration: all clients share adjusted end times", () => {
  it("2端末の確定snapshotと後続端末のhydrationがSSOTの実効endTimeへ完全一致する", async () => {
    vi.spyOn(Date, "now").mockReturnValue(EVENT_TIME);
    const stub = await provision(freshStoreId());
    const clients: WsProbe[] = [];

    try {
      const first = await connect(stub);
      clients.push(first);
      const second = await connect(stub);
      clients.push(second);
      await Promise.all([
        first.waitForSnapshot((message) => message.timers.length === 0),
        second.waitForSnapshot((message) => message.timers.length === 0),
      ]);

      first.send({ type: "start", slotIds: ["0"], noodleType: NOODLE, boilSeconds: 100 });
      await Promise.all([
        first.waitForSnapshot((message) => message.timers.length === 1),
        second.waitForSnapshot((message) => message.timers.length === 1),
      ]);

      second.send({ type: "start", slotIds: ["1"], noodleType: NOODLE, boilSeconds: 110 });
      const [firstConfirmed, secondConfirmed] = await Promise.all([
        first.waitForSnapshot((message) => message.timers.length === 2),
        second.waitForSnapshot((message) => message.timers.length === 2),
      ]);

      const ssot = await readSnapshot(stub);
      expect(ssot.timers).toHaveLength(2);
      expect(ssot.timers.map(({ endTime }) => endTime)).toEqual([
        EVENT_TIME + 100_000,
        EVENT_TIME + 110_000,
      ]);
      expect(ssot.timers.map(({ adjustment }) => adjustment)).toEqual([4_500, -5_500]);
      expect(ssot.timers.every(({ adjustment }) => adjustment !== 0)).toBe(true);

      const ssotIds = ssot.timers.map(({ id }) => id).sort();
      const ssotEffectiveEndTimes = effectiveEndTimes(ssot);
      expect(timerIds(firstConfirmed)).toEqual(ssotIds);
      expect(timerIds(secondConfirmed)).toEqual(ssotIds);
      expect(projectedEndTimes(firstConfirmed)).toEqual(ssotEffectiveEndTimes);
      expect(projectedEndTimes(secondConfirmed)).toEqual(ssotEffectiveEndTimes);
      expect(projectedEndTimes(firstConfirmed)).toEqual(projectedEndTimes(secondConfirmed));

      const third = await connect(stub);
      clients.push(third);
      const hydrated = await third.waitForSnapshot((message) => message.timers.length === 2);
      expect(timerIds(hydrated)).toEqual(ssotIds);
      expect(projectedEndTimes(hydrated)).toEqual(ssotEffectiveEndTimes);
      expect(projectedEndTimes(hydrated)).toEqual(projectedEndTimes(firstConfirmed));
    } finally {
      for (const client of clients) client.close();
    }
  });
});
