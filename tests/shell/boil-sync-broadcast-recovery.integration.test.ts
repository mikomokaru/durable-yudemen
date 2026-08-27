// Feature: synchronized-boil-adjustment, Integration: hydration repairs missed broadcast
// Validates: Requirements 5.6

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
  readonly messages: readonly ServerMessage[];
  waitForSnapshot(predicate: (message: SnapshotMessage) => boolean, timeoutMs?: number): Promise<SnapshotMessage>;
  send(message: unknown): void;
  close(): void;
}

interface SocketAccess {
  getWebSockets(tag?: string): WebSocket[];
}

function freshStoreId(): string {
  return `boil-sync-broadcast-recovery-${crypto.randomUUID()}`;
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
  const upgrade = await stub.fetch("https://do.invalid/s/store/ws", { headers: { Upgrade: "websocket" } });
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
    messages,
    waitForSnapshot(predicate, timeoutMs = 5_000) {
      const received = messages.find(
        (message): message is SnapshotMessage => message.type === "snapshot" && predicate(message),
      );
      if (received !== undefined) return Promise.resolve(received);
      return new Promise<SnapshotMessage>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("snapshot の待機がタイムアウトした")), timeoutMs);
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

function snapshots(probe: WsProbe): readonly SnapshotMessage[] {
  return probe.messages.filter((message): message is SnapshotMessage => message.type === "snapshot");
}

function idle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readSnapshot(stub: DurableObjectStub<StoreTimerDO>): Promise<StoreSnapshot> {
  const snapshot = await runInDurableObject(stub, (_instance, state) =>
    state.storage.get<StoreSnapshot>(SNAPSHOT_KEY));
  if (snapshot === undefined) throw new Error("activeTimers が永続されていない");
  return snapshot;
}

function effectiveEndTimes(snapshot: StoreSnapshot): Readonly<Record<string, number>> {
  return Object.fromEntries(snapshot.timers.map((timer) => [timer.id, timer.endTime + timer.adjustment]));
}

function projectedEndTimes(snapshot: SnapshotMessage): Readonly<Record<string, number>> {
  return Object.fromEntries(snapshot.timers.map((timer) => [timer.id, timer.endTime]));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("Feature: synchronized-boil-adjustment, Integration: hydration repairs missed broadcast", () => {
  it("一端末のsend失敗後もSSOTと正常端末は確定し、失敗端末は再接続hydrationで回復する", async () => {
    vi.spyOn(Date, "now").mockReturnValue(EVENT_TIME);
    const stub = await provision(freshStoreId());
    const first = await connect(stub);
    const second = await connect(stub);
    await Promise.all([
      first.waitForSnapshot((message) => message.timers.length === 0),
      second.waitForSnapshot((message) => message.timers.length === 0),
    ]);

    first.send({ type: "start", slotIds: ["0"], noodleType: NOODLE, boilSeconds: 100 });
    await Promise.all([
      first.waitForSnapshot((message) => message.timers.length === 1),
      second.waitForSnapshot((message) => message.timers.length === 1),
    ]);
    const firstSnapshotsBeforeFailure = snapshots(first).length;
    const secondSnapshotsBeforeFailure = snapshots(second).length;

    const failureObserved = await runInDurableObject(stub, async (instance) => {
      const runtime = instance as unknown as { readonly ctx: DurableObjectState };
      const socketAccess: SocketAccess = runtime.ctx;
      const originalGetWebSockets = socketAccess.getWebSockets;
      const connected = originalGetWebSockets.call(socketAccess);
      if (connected.length !== 2 || connected[0] === undefined || connected[1] === undefined) {
        throw new Error(`注入には接続中 WebSocket が2本必要（actual=${connected.length}）`);
      }

      const injectedFailure = new Error("injected WebSocket send failure");
      const failedSocket = new Proxy(connected[1], {
        get(target, property) {
          if (property === "send") {
            return () => {
              throw injectedFailure;
            };
          }
          return Reflect.get(target, property, target);
        },
      });

      // 正常端末への送信後、もう一端末だけで send を失敗させる。production へフックは足さない。
      socketAccess.getWebSockets = () => [connected[0] as WebSocket, failedSocket];
      try {
        const commandSocket = new WebSocketPair()[0];
        try {
          await instance.webSocketMessage(
            commandSocket,
            JSON.stringify({ type: "start", slotIds: ["1"], noodleType: NOODLE, boilSeconds: 110 }),
          );
          return false;
        } catch (error) {
          if (error !== injectedFailure) throw error;
          return true;
        }
      } finally {
        socketAccess.getWebSockets = originalGetWebSockets;
      }
    });

    expect(failureObserved).toBe(true);
    await idle(200);

    const firstUpdate = snapshots(first).find((message) => message.timers.length === 2);
    const secondUpdate = snapshots(second).find((message) => message.timers.length === 2);
    expect([firstUpdate, secondUpdate].filter((message) => message !== undefined)).toHaveLength(1);

    const normalSnapshot = firstUpdate ?? secondUpdate;
    if (normalSnapshot === undefined) throw new Error("正常端末が確定 snapshot を受信しなかった");
    const failed = firstUpdate === undefined ? first : second;
    if (failed === first) {
      expect(snapshots(first)).toHaveLength(firstSnapshotsBeforeFailure);
      expect(snapshots(second)).toHaveLength(secondSnapshotsBeforeFailure + 1);
    } else {
      expect(snapshots(second)).toHaveLength(secondSnapshotsBeforeFailure);
      expect(snapshots(first)).toHaveLength(firstSnapshotsBeforeFailure + 1);
    }
    expect(snapshots(failed).at(-1)?.timers).toHaveLength(1);

    const ssot = await readSnapshot(stub);
    expect(ssot.timers).toHaveLength(2);
    expect(ssot.timers.map(({ endTime }) => endTime)).toEqual([
      EVENT_TIME + 100_000,
      EVENT_TIME + 110_000,
    ]);
    expect(ssot.timers.map(({ adjustment }) => adjustment)).toEqual([4_500, -5_500]);
    expect(ssot.timers.every(({ adjustment }) => adjustment !== 0)).toBe(true);
    const ssotEffectiveEndTimes = effectiveEndTimes(ssot);
    expect(projectedEndTimes(normalSnapshot)).toEqual(ssotEffectiveEndTimes);

    failed.close();
    await idle(50);
    const reconnected = await connect(stub);
    const hydrated = await reconnected.waitForSnapshot((message) => message.timers.length === 2);
    expect(projectedEndTimes(hydrated)).toEqual(ssotEffectiveEndTimes);
    expect(projectedEndTimes(hydrated)).toEqual(projectedEndTimes(normalSnapshot));

    first.close();
    second.close();
    reconnected.close();
  });
});
