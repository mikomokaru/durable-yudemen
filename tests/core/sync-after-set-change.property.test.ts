import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide } from "../../src/engine/decide";
import type { Event } from "../../src/engine/event";
import { adjustedEndTime } from "../../src/engine/project";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import { synchronize, type SyncParams } from "../../src/engine/sync";
import type { EpochMillis, TimerId } from "../../src/engine/types";
import { settleParams } from "../settleParams";

interface StartOperation {
  readonly kind: "start";
  readonly boilSeconds: number;
  readonly slotIndex: number;
  readonly delayMillis: number;
}

interface CancelOperation {
  readonly kind: "cancel";
  readonly targetIndex: number;
}

interface AlarmOperation {
  readonly kind: "alarm";
}

type AbstractOperation = StartOperation | CancelOperation | AlarmOperation;

interface SequencePosition {
  readonly state: TimerState;
  readonly now: EpochMillis;
}

const BASE_TIME = 1_700_000_000_000 as EpochMillis;

const genSyncParams = fc.record({
  arms: fc.integer({ min: 1, max: 10 }),
  toleranceRatio: fc.integer({ min: 1, max: 50 }),
});

const genOperation = fc.oneof(
  fc.record({
    kind: fc.constant("start" as const),
    boilSeconds: fc.integer({ min: 1, max: 1_800 }),
    slotIndex: fc.integer({ min: 0, max: 17 }),
    delayMillis: fc.integer({ min: 0, max: 2_000 }),
  }),
  fc.record({
    kind: fc.constant("cancel" as const),
    targetIndex: fc.nat(),
  }),
  fc.record({ kind: fc.constant("alarm" as const) }),
);

const genOperations = fc.array(genOperation, { minLength: 1, maxLength: 30 });

function runningOf(state: TimerState) {
  return state.timers.filter((timer) => timer.boiledAt === null);
}

function expectCurrentRunningSynchronization(state: TimerState, params: SyncParams): void {
  const running = runningOf(state);
  const boiledIds = new Set(
    state.timers.filter((timer) => timer.boiledAt !== null).map((timer) => timer.id as string),
  );
  const direct = synchronize(running, params);
  const confirmedById = new Map(running.map((timer) => [timer.id as string, timer.adjustment]));
  const directById = new Map(direct.map((timer) => [timer.id as string, timer.adjustment]));

  expect([...confirmedById.keys()].sort()).toEqual([...directById.keys()].sort());
  expect([...directById.keys()].some((id) => boiledIds.has(id))).toBe(false);
  for (const [id, adjustment] of directById) {
    expect(confirmedById.get(id)).toBe(adjustment);
  }
}

function startEvent(operation: StartOperation, step: number, now: EpochMillis): Event {
  return {
    type: "Start",
    slotIds: [String(operation.slotIndex)],
    noodleType: "ramen",
    boilSeconds: operation.boilSeconds,
    newTimerId: `property-timer-${step}` as TimerId,
    now,
  };
}

function fallbackStart(step: number, now: EpochMillis): Event {
  return startEvent({ kind: "start", boilSeconds: 60, slotIndex: step % 18, delayMillis: 0 }, step, now);
}

function resolveEvent(
  operation: AbstractOperation,
  step: number,
  position: SequencePosition,
): { readonly event: Event; readonly now: EpochMillis } {
  const running = runningOf(position.state);

  if (operation.kind === "start") {
    const now = (position.now + operation.delayMillis) as EpochMillis;
    return { event: startEvent(operation, step, now), now };
  }

  if (running.length === 0) {
    return { event: fallbackStart(step, position.now), now: position.now };
  }

  if (operation.kind === "cancel") {
    const target = running[operation.targetIndex % running.length];
    if (target === undefined) throw new Error("Cancel対象のrunning Timerを解決できない");
    return {
      event: { type: "Cancel", timerId: target.id as string, now: position.now },
      now: position.now,
    };
  }

  const earliestDue = Math.min(...running.map((timer) => adjustedEndTime(timer) as number));
  const now = Math.max(position.now as number, earliestDue) as EpochMillis;
  return { event: { type: "AlarmFired", now }, now };
}

function applyAndAssert(
  position: SequencePosition,
  event: Event,
  params: SyncParams,
): SequencePosition {
  const outcome = decide(position.state, event, settleParams(params));
  if (!outcome.ok) {
    throw new Error(`${event.type}が拒否された: ${outcome.rejection.code}`);
  }

  expectCurrentRunningSynchronization(outcome.state, params);
  return { state: outcome.state, now: event.now };
}

function runOperations(operations: readonly AbstractOperation[], params: SyncParams): TimerState {
  let position: SequencePosition = { state: EMPTY_STATE, now: BASE_TIME };

  for (const [step, operation] of operations.entries()) {
    const resolved = resolveEvent(operation, step, position);
    position = applyAndAssert(position, resolved.event, params);
  }

  return position.state;
}

// Feature: synchronized-boil-adjustment, Property 12: 集合変化後の確定結果は現在の running 集合の純粋な関数である
// Validates: Requirements 7.1, 7.2, 7.3
describe("engine/decide — synchronization after running set changes", () => {
  it("Property 12: 各Start・Cancel・AlarmFired成功直後のAdjustment全体が現在のrunning集合の直接同期結果に一致する", () => {
    fc.assert(
      fc.property(genOperations, genSyncParams, (operations, params) => {
        runOperations(operations, params);
      }),
      { numRuns: 250 },
    );
  });

  it("Start・Cancel・AlarmFiredの3経路で各集合変化直後に同じoracleを満たし、boiledを同期対象から除外する", () => {
    const params = { arms: 2, toleranceRatio: 10 } satisfies SyncParams;
    let position: SequencePosition = { state: EMPTY_STATE, now: 1_000_000 as EpochMillis };

    position = applyAndAssert(
      position,
      startEvent({ kind: "start", boilSeconds: 60, slotIndex: 0, delayMillis: 0 }, 0, position.now),
      params,
    );
    const secondStartAt = (position.now + 1_000) as EpochMillis;
    position = applyAndAssert(
      position,
      startEvent({ kind: "start", boilSeconds: 60, slotIndex: 1, delayMillis: 0 }, 1, secondStartAt),
      params,
    );
    expect(runningOf(position.state).some((timer) => timer.adjustment !== 0)).toBe(true);

    const firstId = position.state.timers[0]?.id;
    if (firstId === undefined) throw new Error("固定シナリオのCancel対象が存在しない");
    position = applyAndAssert(
      position,
      { type: "Cancel", timerId: firstId as string, now: position.now },
      params,
    );
    expect(runningOf(position.state)).toHaveLength(1);
    expect(runningOf(position.state)[0]?.adjustment).toBe(0);

    const thirdStartAt = (position.now + 1_000) as EpochMillis;
    position = applyAndAssert(
      position,
      startEvent({ kind: "start", boilSeconds: 60, slotIndex: 2, delayMillis: 0 }, 2, thirdStartAt),
      params,
    );
    const alarmAt = Math.min(...runningOf(position.state).map((timer) => adjustedEndTime(timer) as number)) as EpochMillis;
    position = applyAndAssert(position, { type: "AlarmFired", now: alarmAt }, params);

    const boiled = position.state.timers.filter((timer) => timer.boiledAt !== null);
    const finalRunningIds = new Set(runningOf(position.state).map((timer) => timer.id as string));
    expect(boiled.length).toBeGreaterThan(0);
    expect(boiled.every((timer) => !finalRunningIds.has(timer.id as string))).toBe(true);
  });
});
