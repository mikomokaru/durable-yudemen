import { afterEach, describe, expect, it, vi } from "vitest";
import { env, evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import type { ServerMessage } from "../../src/domain/messages";
import type { NonEmptyArray } from "../../src/domain/timer";
import type { Effect } from "../../src/engine/effect";
import { toSnapshot, type StoreSnapshot } from "../../src/engine/snapshot";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import type { OperationObservation } from "../../src/operation-history/derive";
import type { StoreProjection } from "../../src/registry/projection";
import { StoreTimerDO } from "../../src/shell/store-timer-do";
import { nonEmpty } from "../nonEmpty";
import { configResidualDefaults } from "../storeConfigDefaults";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

type ObservationMode = "off" | "success" | "record-throw" | "printer-throw" | "console-throw";
type RunResult = { readonly persisted: boolean };
type ExistingException = { readonly name: string; readonly message: string };

type TimerTrace = {
  readonly effects: Effect[][];
  readonly actions: unknown[];
  readonly workingCopies: TimerState[];
  readonly messages: { readonly label: string; readonly values: ServerMessage[] }[];
  readonly returns: { readonly label: string; readonly value: "undefined" }[];
  finalWorkingCopy?: TimerState;
  finalSnapshot?: StoreSnapshot;
  finalAlarm?: number | null;
  existingException?: ExistingException;
};

// O7 の runtime counter。観測 ON/OFF で 0 差分でなければならない観測由来の起動・読み出し件数。
type RuntimeCounters = {
  // 新しい in-memory instance の生成回数（cold start / hibernation wake）。
  construct: number;
  // ensureLoaded が実際に永続から Working_Copy を復元した回数（rehydrate）。
  rehydrate: number;
  // DO 自身が起こした storage.get の回数（rehydrate 読み + provision 読み）。
  storageReads: number;
};

type ObservationTrace = {
  readonly mode: ObservationMode;
  readonly consoleAttempts: string[];
  readonly consoleLines: string[];
  recordFaultAttempts: number;
  printerFaultAttempts: number;
  consoleFaultAttempts: number;
  activeEvent: OperationObservation["eventKind"] | null;
  readonly timer: TimerTrace;
  readonly runtime: RuntimeCounters;
  // construct 検出用。既に観測した instanceId は再カウントしない。
  readonly seenInstances: Set<string>;
};

interface RuntimeStoreTimer {
  readonly ctx: DurableObjectState;
  readonly instanceId: string;
  loaded: boolean;
  provisionChecked: boolean;
  workingCopy: TimerState;
  ensureLoaded(): Promise<void>;
  ensureProvisioned(): Promise<unknown>;
  runEffects(effects: readonly Effect[]): Promise<RunResult>;
  applySideEffect(effect: Exclude<Effect, { readonly type: "Persist" }>): void;
  tryWriteCommittedOperation(
    eventKind: OperationObservation["eventKind"],
    eventTime: EpochMillis,
    before: TimerState,
    effects: readonly Effect[],
    result: RunResult,
  ): void;
}

type MutableStorage = {
  put(key: string, value: unknown): Promise<void>;
  setAlarm(at: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
};

interface WsHarness {
  readonly next: () => Promise<ServerMessage>;
  readonly close: () => void;
}

const SNAPSHOT_KEY = "activeTimers";
const PROJECTION_KEY = "projection";
const STORE_ID = "history-fault-trace";
const RECONCILE_TIME = 1_700_000_000_000;
const START_TIME = RECONCILE_TIME + 10_000;
const ADJUST_TIME = RECONCILE_TIME + 20_000;
const CANCEL_START_TIME = RECONCILE_TIME + 30_000;
const CANCEL_TIME = RECONCILE_TIME + 40_000;
const ALARM_TIME = RECONCILE_TIME + 1_000_000;
const COMPLETE_TIME = ALARM_TIME + 1_000;
const EXCEPTION_TIME = COMPLETE_TIME + 1_000;

const projection: StoreProjection = {
  active: true,
  version: 1,
  roster: [],
  config: {
    unitCount: 3,
    arms: 2,
    toleranceRatio: 10,
    noodlePresets: [
      { noodleType: "Thin", boilSeconds: { extraHard: 45, hard: 52, normal: 60, soft: 75 } },
    ],
    ...configResidualDefaults(3),
  },
};

function initialTimer(
  id: string,
  slotId: string,
  startTime: number,
  endTime: number,
  seq: number,
): Timer {
  return createTimer({
    id: id as TimerId,
    slotIds: nonEmpty([slotId as SlotId]),
    noodleType: "Thin" as NoodleType,
    firmness: "normal",
    startTime: startTime as EpochMillis,
    endTime: endTime as EpochMillis,
    seq,
  });
}

const initialSnapshot = toSnapshot({
  ...EMPTY_STATE,
  timers: [
    initialTimer(
      "reconcile-due",
      "initial-due",
      RECONCILE_TIME - 60_000,
      RECONCILE_TIME - 1_000,
      0,
    ),
    initialTimer(
      "alarm-due",
      "initial-running",
      RECONCILE_TIME - 10_000,
      RECONCILE_TIME + 200_000,
      1,
    ),
  ],
  nextSeq: 2,
});

function stub(): DurableObjectStub<StoreTimerDO> {
  return env.STORE_TIMER_DO.getByName(STORE_ID) as DurableObjectStub<StoreTimerDO>;
}

function setHistoryBinding(enabled: boolean): void {
  (env as unknown as { OPERATION_HISTORY_ENABLED: string }).OPERATION_HISTORY_ENABLED = enabled
    ? "1"
    : "0";
}

async function openWs(object: DurableObjectStub<StoreTimerDO>): Promise<WsHarness> {
  const response = await object.fetch(`https://do.invalid/s/${STORE_ID}/ws`, {
    headers: { Upgrade: "websocket" },
  });
  const ws = response.webSocket;
  if (ws === null) throw new Error(`WebSocket 接続に失敗した: ${response.status}`);

  const queue: ServerMessage[] = [];
  const waiters: ((message: ServerMessage) => void)[] = [];
  ws.addEventListener("message", (event: MessageEvent) => {
    const message = JSON.parse(event.data as string) as ServerMessage;
    const waiter = waiters.shift();
    if (waiter === undefined) queue.push(message);
    else waiter(message);
  });
  ws.accept();

  return {
    next: () =>
      new Promise<ServerMessage>((resolve) => {
        const buffered = queue.shift();
        if (buffered === undefined) waiters.push(resolve);
        else resolve(buffered);
      }),
    close: () => ws.close(),
  };
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function exceptionOf(error: unknown): ExistingException {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: typeof error, message: String(error) };
}

function operationKinds(lines: readonly string[]): string[] {
  return lines.map((line) => (JSON.parse(line) as { operationKind: string }).operationKind);
}

function installTraceHooks(controls: Map<string, ObservationTrace>): void {
  const prototype = StoreTimerDO.prototype as unknown as RuntimeStoreTimer;
  const originalRunEffects = prototype.runEffects;
  const originalWrite = prototype.tryWriteCommittedOperation;
  const originalEnsureLoaded = prototype.ensureLoaded;
  const originalEnsureProvisioned = prototype.ensureProvisioned;
  let activeControl: ObservationTrace | undefined;

  // O7: construct・wake・rehydrate・storage read を runtime で数える。観測 ON/OFF で 0 差分でなければならない。
  // ensureLoaded は各 instance が最初に触れる経路（constructor の blockConcurrencyWhile と各入口の前段）ゆえ、
  // ここで instanceId の初出を construct、実ロードを rehydrate、SNAPSHOT_KEY 読みを storage read として数える。
  vi.spyOn(prototype, "ensureLoaded").mockImplementation(
    async function (this: RuntimeStoreTimer): Promise<void> {
      const control = controls.get(this.ctx.id.name ?? "");
      if (control !== undefined) {
        if (!control.seenInstances.has(this.instanceId)) {
          control.seenInstances.add(this.instanceId);
          control.runtime.construct += 1;
        }
        if (!this.loaded) {
          control.runtime.rehydrate += 1;
          control.runtime.storageReads += 1;
        }
      }
      return originalEnsureLoaded.call(this);
    },
  );

  // ensureProvisioned は投影を PROJECTION_KEY から一度だけ読む。観測はこの読み出しを増やさない。
  vi.spyOn(prototype, "ensureProvisioned").mockImplementation(
    async function (this: RuntimeStoreTimer): Promise<unknown> {
      const control = controls.get(this.ctx.id.name ?? "");
      if (control !== undefined && !this.provisionChecked) {
        control.runtime.storageReads += 1;
      }
      return originalEnsureProvisioned.call(this);
    },
  );

  vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
    if (activeControl === undefined) return;
    const line = String(value);
    activeControl.consoleAttempts.push(line);
    if (
      activeControl.mode === "console-throw" &&
      activeControl.activeEvent === "AlarmFired" &&
      activeControl.consoleFaultAttempts === 0
    ) {
      activeControl.consoleFaultAttempts += 1;
      throw new Error("injected console failure");
    }
    activeControl.consoleLines.push(line);
  });

  vi.spyOn(prototype, "runEffects").mockImplementation(async function (
    this: RuntimeStoreTimer,
    effects: readonly Effect[],
  ): Promise<RunResult> {
    const control = controls.get(this.ctx.id.name ?? "");
    if (control === undefined || effects.length === 0) {
      return originalRunEffects.call(this, effects);
    }

    control.timer.effects.push(copy([...effects]));
    const storage = this.ctx.storage as unknown as MutableStorage;
    const originalPut = storage.put;
    const originalSetAlarm = storage.setAlarm;
    const originalDeleteAlarm = storage.deleteAlarm;
    const originalApplySideEffect = this.applySideEffect;

    storage.put = async (key, value) => {
      control.timer.actions.push({ type: "Persist", phase: "attempt", key, payload: copy(value) });
      try {
        await originalPut.call(storage, key, value);
        control.timer.actions.push({ type: "Persist", phase: "success", key });
      } catch (error) {
        control.timer.actions.push({
          type: "Persist",
          phase: "failure",
          key,
          error: exceptionOf(error),
        });
        throw error;
      }
    };
    storage.setAlarm = (at) => {
      control.timer.actions.push({ type: "SetAlarm", at: at instanceof Date ? at.getTime() : at });
      return originalSetAlarm.call(storage, at);
    };
    storage.deleteAlarm = () => {
      control.timer.actions.push({ type: "ClearAlarm" });
      return originalDeleteAlarm.call(storage);
    };
    this.applySideEffect = (effect) => {
      if (effect.type === "Broadcast") {
        const targets = this.ctx.getWebSockets().map((_ws, index) => `ws-${index}`);
        control.timer.actions.push({ type: "Broadcast", message: copy(effect.message), targets });
      }
      originalApplySideEffect.call(this, effect);
    };

    try {
      const result = await originalRunEffects.call(this, effects);
      control.timer.workingCopies.push(copy(this.workingCopy));
      return result;
    } finally {
      storage.put = originalPut;
      storage.setAlarm = originalSetAlarm;
      storage.deleteAlarm = originalDeleteAlarm;
      this.applySideEffect = originalApplySideEffect;
    }
  });

  vi.spyOn(prototype, "tryWriteCommittedOperation").mockImplementation(function (
    this: RuntimeStoreTimer,
    eventKind: OperationObservation["eventKind"],
    eventTime: EpochMillis,
    before: TimerState,
    effects: readonly Effect[],
    result: RunResult,
  ): void {
    const control = controls.get(this.ctx.id.name ?? "");
    if (control === undefined) {
      originalWrite.call(this, eventKind, eventTime, before, effects, result);
      return;
    }

    activeControl = control;
    control.activeEvent = eventKind;
    try {
      if (control.mode === "record-throw" && eventKind === "Adjust") {
        control.recordFaultAttempts += 1;
        originalWrite.call(this, eventKind, 0 as EpochMillis, before, effects, result);
        return;
      }

      if (control.mode === "printer-throw" && eventKind === "AlarmFired") {
        const committed = this.workingCopy;
        const firstBoiled = committed.timers.findIndex((timer) => {
          const prior = before.timers.find(({ id }) => id === timer.id);
          return prior?.boiledAt === null && timer.boiledAt !== null;
        });
        if (firstBoiled >= 0) {
          const throwingSlot = {
            toJSON: () => {
              control.printerFaultAttempts += 1;
              throw new Error("injected printer failure");
            },
          };
          const timers = committed.timers.map((timer, index) =>
            index === firstBoiled
              ? { ...timer, slotIds: [throwingSlot] as unknown as NonEmptyArray<SlotId> }
              : timer,
          );
          this.workingCopy = { ...committed, timers };
          try {
            originalWrite.call(this, eventKind, eventTime, before, effects, result);
          } finally {
            this.workingCopy = committed;
          }
          return;
        }
      }

      originalWrite.call(this, eventKind, eventTime, before, effects, result);
    } finally {
      control.activeEvent = null;
      activeControl = undefined;
    }
  });
}

async function receivePair(
  trace: TimerTrace,
  label: string,
  first: WsHarness,
  second: WsHarness,
): Promise<ServerMessage[]> {
  const values = await Promise.all([first.next(), second.next()]);
  trace.messages.push({ label, values: copy(values) });
  return values;
}

async function invokeMessage(
  object: DurableObjectStub<StoreTimerDO>,
  trace: TimerTrace,
  label: string,
  now: number,
  command: unknown,
  first: WsHarness,
  second: WsHarness,
): Promise<ServerMessage[]> {
  vi.mocked(Date.now).mockReturnValue(now);
  const value = await runInDurableObject(object, (instance, state) => {
    const requestSocket = state.getWebSockets()[0];
    if (requestSocket === undefined) throw new Error("要求元 WebSocket が存在しない");
    return instance.webSocketMessage(requestSocket, JSON.stringify(command));
  });
  expect(value).toBeUndefined();
  trace.returns.push({ label, value: "undefined" });
  return receivePair(trace, label, first, second);
}

function timerIdAtSlot(messages: readonly ServerMessage[], slotId: string): string {
  const snapshot = messages[0];
  if (snapshot?.type !== "snapshot") throw new Error(`${slotId} の snapshot がない`);
  const timer = snapshot.timers.find(({ slotIds }) => slotIds.includes(slotId));
  if (timer === undefined) throw new Error(`${slotId} の Timer がない`);
  return timer.id;
}

async function runScenario(
  mode: ObservationMode,
  controls: Map<string, ObservationTrace>,
): Promise<ObservationTrace> {
  await reset();
  setHistoryBinding(false);
  vi.mocked(Date.now).mockReturnValue(RECONCILE_TIME - 100_000);
  let uuidSequence = 0;
  vi.mocked(crypto.randomUUID).mockImplementation(() => {
    uuidSequence += 1;
    return `00000000-0000-4000-8000-${String(uuidSequence).padStart(12, "0")}`;
  });

  const object = stub();
  await runInDurableObject(object, async (_instance, state) => {
    await state.storage.put(PROJECTION_KEY, projection);
    await state.storage.put(SNAPSHOT_KEY, initialSnapshot);
  });

  const control: ObservationTrace = {
    mode,
    consoleAttempts: [],
    consoleLines: [],
    recordFaultAttempts: 0,
    printerFaultAttempts: 0,
    consoleFaultAttempts: 0,
    activeEvent: null,
    timer: { effects: [], actions: [], workingCopies: [], messages: [], returns: [] },
    runtime: { construct: 0, rehydrate: 0, storageReads: 0 },
    seenInstances: new Set<string>(),
  };
  controls.set(STORE_ID, control);
  setHistoryBinding(mode !== "off");
  vi.mocked(Date.now).mockReturnValue(RECONCILE_TIME);
  await evictDurableObject(object, { webSockets: "close" });

  const first = await openWs(object);
  const second = await openWs(object);
  control.timer.messages.push({
    label: "hydrate",
    values: copy([
      await first.next(),
      await first.next(),
      await second.next(),
      await second.next(),
    ]),
  });

  const started = await invokeMessage(
    object,
    control.timer,
    "Start",
    START_TIME,
    { type: "start", slotIds: ["started"], noodleType: "Thin", boilSeconds: 60 },
    first,
    second,
  );
  const startedId = timerIdAtSlot(started, "started");

  await invokeMessage(
    object,
    control.timer,
    "Adjust",
    ADJUST_TIME,
    { type: "adjust", timerId: startedId, firmness: "hard" },
    first,
    second,
  );

  const cancelledStart = await invokeMessage(
    object,
    control.timer,
    "StartForCancel",
    CANCEL_START_TIME,
    { type: "start", slotIds: ["cancelled"], noodleType: "Thin", boilSeconds: 500 },
    first,
    second,
  );
  const cancelledId = timerIdAtSlot(cancelledStart, "cancelled");
  await invokeMessage(
    object,
    control.timer,
    "Cancel",
    CANCEL_TIME,
    { type: "cancel", timerId: cancelledId },
    first,
    second,
  );

  vi.mocked(Date.now).mockReturnValue(ALARM_TIME);
  const alarmReturn = await runInDurableObject(object, (instance) => instance.alarm());
  expect(alarmReturn).toBeUndefined();
  control.timer.returns.push({ label: "AlarmFired", value: "undefined" });
  const alarmMessages = await receivePair(control.timer, "AlarmFired", first, second);
  const completedId = timerIdAtSlot(alarmMessages, "started");

  await invokeMessage(
    object,
    control.timer,
    "Complete",
    COMPLETE_TIME,
    { type: "complete", timerId: completedId },
    first,
    second,
  );

  vi.mocked(Date.now).mockReturnValue(EXCEPTION_TIME);
  control.timer.existingException = await runInDurableObject(object, async (instance) => {
    const throwingSocket = {
      send: () => {
        throw new TypeError("existing response send failed");
      },
    } as unknown as WebSocket;
    try {
      await instance.webSocketMessage(
        throwingSocket,
        JSON.stringify({
          type: "adjust",
          timerId: "missing-timer",
          firmness: "hard",
        }),
      );
      throw new Error("既存例外が発生しなかった");
    } catch (error) {
      return exceptionOf(error);
    }
  });

  const final = await runInDurableObject(object, async (instance, state) => {
    const runtime = instance as unknown as RuntimeStoreTimer;
    return {
      workingCopy: copy(runtime.workingCopy),
      snapshot: await state.storage.get<StoreSnapshot>(SNAPSHOT_KEY),
      alarm: await state.storage.getAlarm(),
    };
  });
  control.timer.finalWorkingCopy = final.workingCopy;
  if (final.snapshot === undefined) throw new Error("最終 StoreSnapshot が永続されていない");
  control.timer.finalSnapshot = final.snapshot;
  control.timer.finalAlarm = final.alarm;
  first.close();
  second.close();
  controls.delete(STORE_ID);
  return control;
}

afterEach(async () => {
  setHistoryBinding(false);
  vi.restoreAllMocks();
  await reset();
});

describe("StoreTimerDO Operation History 非干渉 trace", () => {
  it("OFF・成功・三種 fault で Timer trace を一致させ、失敗を各 record に局所化する", async () => {
    const controls = new Map<string, ObservationTrace>();
    vi.spyOn(Date, "now").mockReturnValue(RECONCILE_TIME);
    vi.spyOn(crypto, "randomUUID");
    installTraceHooks(controls);

    const off = await runScenario("off", controls);
    const success = await runScenario("success", controls);
    const recordThrow = await runScenario("record-throw", controls);
    const printerThrow = await runScenario("printer-throw", controls);
    const consoleThrow = await runScenario("console-throw", controls);

    for (const candidate of [success, recordThrow, printerThrow, consoleThrow]) {
      expect(candidate.timer).toEqual(off.timer);
    }

    // O7: 観測に由来する construct・wake・rehydrate・storage read が全て 0 差分であること（Requirements 1.8）。
    // trace 比較は Effect/Persist/Alarm/Broadcast の内容一致を保証するが、DO lifecycle の起動・復元・読み出し
    // 回数（Effect 列には現れない）は runtime counter でのみ観測できる。観測は evict 後の instance を 1 回だけ
    // 生成し、1 回だけ rehydrate し、SNAPSHOT_KEY と PROJECTION_KEY をそれぞれ 1 回だけ読む——これに何も足さない。
    expect(off.runtime).toEqual({ construct: 1, rehydrate: 1, storageReads: 2 });
    for (const candidate of [success, recordThrow, printerThrow, consoleThrow]) {
      expect(candidate.runtime).toEqual(off.runtime);
    }

    // O7: Alarm 予定（SetAlarm）件数も観測に依存しない（Requirements 1.8）。
    const alarmSchedules = (trace: TimerTrace): number =>
      trace.actions.filter((action) => (action as { type?: string }).type === "SetAlarm").length;
    for (const candidate of [success, recordThrow, printerThrow, consoleThrow]) {
      expect(alarmSchedules(candidate.timer)).toBe(alarmSchedules(off.timer));
    }

    // O7 / Requirements 1.10: invocation 終了時に観測由来の live resource（追加 Alarm など）が残らない。
    // 最終 Alarm 状態が観測なし基準と一致し、観測が余分な Alarm 予定を残していないことを確認する。
    for (const candidate of [success, recordThrow, printerThrow, consoleThrow]) {
      expect(candidate.timer.finalAlarm).toBe(off.timer.finalAlarm);
    }

    expect(off.consoleAttempts).toHaveLength(0);
    expect(operationKinds(success.consoleLines)).toEqual([
      "boiled",
      "boil-started",
      "adjusted",
      "boil-started",
      "cancelled",
      "boiled",
      "boiled",
      "completed",
    ]);

    expect(recordThrow.recordFaultAttempts).toBe(1);
    expect(recordThrow.consoleAttempts).toHaveLength(success.consoleAttempts.length - 1);
    expect(operationKinds(recordThrow.consoleLines)).not.toContain("adjusted");

    expect(printerThrow.printerFaultAttempts).toBe(1);
    expect(printerThrow.consoleAttempts).toHaveLength(success.consoleAttempts.length - 1);
    expect(
      operationKinds(printerThrow.consoleLines).filter((kind) => kind === "boiled"),
    ).toHaveLength(2);

    expect(consoleThrow.consoleFaultAttempts).toBe(1);
    expect(consoleThrow.consoleAttempts).toHaveLength(success.consoleAttempts.length);
    expect(consoleThrow.consoleLines).toHaveLength(success.consoleLines.length - 1);

    // Effect 列の形（OFF 基準）。観測の有無に依存しない事実なので、この主張の意図は変わらない。
    // **調理順スケジューリングの要求（RequestPlan）はこの筋書きでは一度も乗らない。** この筋書きは
    // POS 由来のオーダーを一切注入せず、開始はすべてアドホック麺茹でである——計画対象の Pending_Order が
    // 空のままなので、要求は抑制される（online-cook-scheduling AC 5.6：計画する対象が無い要求は
    // 改善しうるものが存在しないため出さない）。ゆえに列は Timer 本体の 3 作用で尽きる。
    expect(off.timer.effects.map((effects) => effects.map(({ type }) => type))).toEqual([
      ["Persist", "SetAlarm", "Broadcast"],
      ["Persist", "SetAlarm", "Broadcast"],
      ["Persist", "SetAlarm", "Broadcast"],
      ["Persist", "SetAlarm", "Broadcast"],
      ["Persist", "SetAlarm", "Broadcast"],
      ["Persist", "ClearAlarm", "Broadcast"],
      ["Persist", "ClearAlarm", "Broadcast"],
    ]);
    expect(
      off.timer.actions.filter(
        (action) =>
          (action as { type?: string; phase?: string }).type === "Persist" &&
          (action as { phase?: string }).phase === "success",
      ),
    ).toHaveLength(7);
    // 主張は「Working_Copy が最終 snapshot と一致する」ただ一つ。調理順スケジューリングの 3 フィールドも
    // 永続（v7）に載るため、期待値は snapshot 側から引く（待ち行列は空、指紋は未要求のまま null になる）。
    expect(off.timer.finalWorkingCopy).toEqual({
      timers: off.timer.finalSnapshot?.timers,
      nextSeq: off.timer.finalSnapshot?.nextSeq,
      pendingOrders: off.timer.finalSnapshot?.pendingOrders,
      acceptedSlices: off.timer.finalSnapshot?.acceptedSlices,
      requestedDigest: off.timer.finalSnapshot?.requestedDigest,
      lastSequenceByTerminal: off.timer.finalSnapshot?.lastSequenceByTerminal,
    });
    expect(off.timer.finalAlarm).toBeNull();
    expect(off.timer.existingException).toEqual({
      name: "TypeError",
      message: "existing response send failed",
    });
  });
});

describe("StoreTimerDO Operation History 既存例外", () => {
  const fixedUuid = "00000000-0000-4000-8000-000000000001";

  async function runPersistFailure(enabled: boolean): Promise<{
    readonly returned: "undefined";
    readonly before: TimerState;
    readonly after: TimerState;
    readonly snapshot: StoreSnapshot | undefined;
  }> {
    await reset();
    setHistoryBinding(enabled);
    const object = env.STORE_TIMER_DO.getByName(
      `history-persist-failure-${enabled}`,
    ) as DurableObjectStub<StoreTimerDO>;
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValue(fixedUuid);
    try {
      return await runInDurableObject(object, async (instance, state) => {
        (
          instance as unknown as { env: { OPERATION_HISTORY_ENABLED: string } }
        ).env.OPERATION_HISTORY_ENABLED = enabled ? "1" : "0";
        const runtime = instance as unknown as RuntimeStoreTimer;
        const before = copy(runtime.workingCopy);
        const storage = state.storage as unknown as MutableStorage;
        const originalPut = storage.put;
        storage.put = () => Promise.reject(new Error("injected persist failure"));
        try {
          const value = await instance.webSocketMessage(
            new WebSocketPair()[0],
            JSON.stringify({
              type: "start",
              slotIds: ["persist-failure"],
              noodleType: "Thin",
              boilSeconds: 60,
            }),
          );
          expect(value).toBeUndefined();
          return {
            returned: "undefined" as const,
            before,
            after: copy(runtime.workingCopy),
            snapshot: await state.storage.get<StoreSnapshot>(SNAPSHOT_KEY),
          };
        } finally {
          storage.put = originalPut;
        }
      });
    } finally {
      uuid.mockRestore();
    }
  }

  type SideEffectFault = "SetAlarm" | "ClearAlarm" | "Broadcast.stringify" | "Broadcast.send";

  async function runSideEffectFault(
    enabled: boolean,
    fault: SideEffectFault,
  ): Promise<ExistingException> {
    await reset();
    setHistoryBinding(enabled);
    const object = env.STORE_TIMER_DO.getByName(
      `history-existing-${fault}-${enabled}`,
    ) as DurableObjectStub<StoreTimerDO>;
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValue(fixedUuid);
    try {
      return await runInDurableObject(object, async (instance, state) => {
        const runtime = instance as unknown as RuntimeStoreTimer & {
          env: { OPERATION_HISTORY_ENABLED: string };
        };
        const storage = state.storage as unknown as MutableStorage;
        const sentinel = new TypeError(`existing ${fault} failed`);
        const originalSetAlarm = storage.setAlarm;
        const originalDeleteAlarm = storage.deleteAlarm;
        const originalStringify = JSON.stringify;
        let sockets: ReturnType<typeof vi.spyOn> | undefined;

        runtime.env.OPERATION_HISTORY_ENABLED = "0";
        let command: unknown = {
          type: "start",
          slotIds: [`fault-${fault}`],
          noodleType: "Thin",
          boilSeconds: 60,
        };
        if (fault === "ClearAlarm") {
          await instance.webSocketMessage(new WebSocketPair()[0], JSON.stringify(command));
          const timerId = runtime.workingCopy.timers[0]?.id;
          if (timerId === undefined) throw new Error("取消対象 Timer がない");
          command = { type: "cancel", timerId };
        }
        const encoded = JSON.stringify(command);
        runtime.env.OPERATION_HISTORY_ENABLED = enabled ? "1" : "0";

        if (fault === "SetAlarm") {
          storage.setAlarm = () => {
            throw sentinel;
          };
        } else if (fault === "ClearAlarm") {
          storage.deleteAlarm = () => {
            throw sentinel;
          };
        } else if (fault === "Broadcast.stringify") {
          JSON.stringify = ((value: unknown, ...args: unknown[]) => {
            if (
              typeof value === "object" &&
              value !== null &&
              (value as { type?: unknown }).type === "snapshot"
            )
              throw sentinel;
            return (originalStringify as (...parameters: unknown[]) => string)(value, ...args);
          }) as typeof JSON.stringify;
        } else {
          const throwingSocket = {
            send: () => {
              throw sentinel;
            },
          } as unknown as WebSocket;
          sockets = vi.spyOn(runtime.ctx, "getWebSockets").mockReturnValue([throwingSocket]);
        }

        try {
          await instance.webSocketMessage(new WebSocketPair()[0], encoded);
          throw new Error(`${fault} の既存例外が発生しなかった`);
        } catch (error) {
          expect(error).toBe(sentinel);
          return exceptionOf(error);
        } finally {
          storage.setAlarm = originalSetAlarm;
          storage.deleteAlarm = originalDeleteAlarm;
          JSON.stringify = originalStringify;
          sockets?.mockRestore();
        }
      });
    } finally {
      uuid.mockRestore();
    }
  }

  async function runAlarmPersistFailure(
    enabled: boolean,
    retryCount: number,
  ): Promise<{
    readonly exception: ExistingException | undefined;
    readonly alarmBefore: number | null;
    readonly alarmAfter: number | null;
    readonly rearmDelay: number | undefined;
    readonly before: TimerState;
    readonly after: TimerState;
    readonly snapshotBefore: StoreSnapshot | undefined;
    readonly snapshotAfter: StoreSnapshot | undefined;
  }> {
    await reset();
    setHistoryBinding(false);
    const storeId = `history-alarm-persist-${retryCount}`;
    const object = env.STORE_TIMER_DO.getByName(storeId) as DurableObjectStub<StoreTimerDO>;
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValue(fixedUuid);
    try {
      return await runInDurableObject(object, async (instance, state) => {
        const runtime = instance as unknown as RuntimeStoreTimer & {
          env: { OPERATION_HISTORY_ENABLED: string };
        };
        runtime.env.OPERATION_HISTORY_ENABLED = "0";
        const dueState: TimerState = {
          ...EMPTY_STATE,
          timers: [initialTimer("alarm-persist-failure", "alarm-persist-failure", 1, 2, 0)],
          nextSeq: 1,
        };
        runtime.workingCopy = dueState;
        await state.storage.put(SNAPSHOT_KEY, toSnapshot(dueState));
        await state.storage.setAlarm(Date.now() + 1_000);

        const before = copy(runtime.workingCopy);
        const snapshotBefore = await state.storage.get<StoreSnapshot>(SNAPSHOT_KEY);
        const alarmBefore = await state.storage.getAlarm();
        runtime.env.OPERATION_HISTORY_ENABLED = enabled ? "1" : "0";
        const storage = state.storage as unknown as MutableStorage;
        const originalPut = storage.put;
        const originalSetAlarm = storage.setAlarm;
        let rearmDelay: number | undefined;
        storage.put = () => Promise.reject(new Error("injected alarm persist failure"));
        storage.setAlarm = (at) => {
          const alarmAt = at instanceof Date ? at.getTime() : at;
          rearmDelay = alarmAt - Date.now();
          return originalSetAlarm.call(storage, at);
        };
        let exception: ExistingException | undefined;
        try {
          await instance.alarm({
            isRetry: retryCount > 0,
            retryCount,
            scheduledTime: alarmBefore ?? Date.now(),
          });
        } catch (error) {
          exception = exceptionOf(error);
        } finally {
          storage.put = originalPut;
          storage.setAlarm = originalSetAlarm;
        }
        return {
          exception,
          alarmBefore,
          alarmAfter: await state.storage.getAlarm(),
          rearmDelay,
          before,
          after: copy(runtime.workingCopy),
          snapshotBefore,
          snapshotAfter: await state.storage.get<StoreSnapshot>(SNAPSHOT_KEY),
        };
      });
    } finally {
      uuid.mockRestore();
    }
  }

  it("Persist 失敗は確定・例外・console を増やさず ON/OFF で一致する", async () => {
    vi.spyOn(Date, "now").mockReturnValue(RECONCILE_TIME);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const off = await runPersistFailure(false);
    const enabled = await runPersistFailure(true);

    expect(enabled).toEqual(off);
    expect(enabled.after).toEqual(enabled.before);
    expect(enabled.snapshot).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it.each(["SetAlarm", "ClearAlarm", "Broadcast.stringify", "Broadcast.send"] as const)(
    "%s の同期 throw を同じ位置から伝播し、console は 0 件に保つ",
    async (fault) => {
      vi.spyOn(Date, "now").mockReturnValue(RECONCILE_TIME);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

      const off = await runSideEffectFault(false, fault);
      const enabled = await runSideEffectFault(true, fault);

      expect(enabled).toEqual(off);
      expect(enabled).toEqual({ name: "TypeError", message: `existing ${fault} failed` });
      expect(log).not.toHaveBeenCalled();
    },
  );

  it("Alarm Persist 失敗の retry throw と rearm を ON/OFF で維持し、console は 0 件に保つ", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const retryOff = await runAlarmPersistFailure(false, 4);
    const retryEnabled = await runAlarmPersistFailure(true, 4);
    expect(retryEnabled.exception).toEqual(retryOff.exception);
    expect(retryEnabled.exception).toEqual({
      name: "Error",
      message: "alarm persist failed (store=history-alarm-persist-4, retryCount=4)",
    });
    for (const retry of [retryOff, retryEnabled]) {
      expect(retry.alarmAfter).toBe(retry.alarmBefore);
      expect(retry.rearmDelay).toBeUndefined();
      expect(retry.after).toEqual(retry.before);
      expect(retry.snapshotAfter).toEqual(retry.snapshotBefore);
    }

    const rearmOff = await runAlarmPersistFailure(false, 5);
    const rearmEnabled = await runAlarmPersistFailure(true, 5);
    expect(rearmEnabled.exception).toBe(rearmOff.exception);
    for (const rearm of [rearmOff, rearmEnabled]) {
      expect(rearm.exception).toBeUndefined();
      expect(rearm.rearmDelay).toBeGreaterThanOrEqual(29_990);
      expect(rearm.rearmDelay).toBeLessThanOrEqual(30_000);
      expect(rearm.alarmAfter).toBeGreaterThan(rearm.alarmBefore ?? 0);
      expect(rearm.after).toEqual(rearm.before);
      expect(rearm.snapshotAfter).toEqual(rearm.snapshotBefore);
      expect(rearm.after.timers[0]?.boiledAt).toBeNull();
      expect(rearm.snapshotAfter?.timers[0]?.boiledAt).toBeNull();
    }
    expect(log).not.toHaveBeenCalled();
  });
});
