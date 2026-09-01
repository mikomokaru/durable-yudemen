import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Effect } from "../../src/engine/effect";
import { settle } from "../../src/engine/settle";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import { synchronize, type SyncParams } from "../../src/engine/sync";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { nonEmpty } from "../nonEmpty";
import { settleParams } from "../settleParams";

interface TimerSeed {
  readonly offset: number;
  readonly duration: number;
}

const BASE_TIME = 1_700_000_000_000;

const genSyncParams: fc.Arbitrary<SyncParams> = fc.record({
  arms: fc.integer({ min: 1, max: 10 }),
  toleranceRatio: fc.integer({ min: 1, max: 50 }),
});

const genTimerSeed: fc.Arbitrary<TimerSeed> = fc.record({
  offset: fc.integer({ min: 0, max: 1_800_000 }),
  duration: fc.integer({ min: 1_000, max: 1_800_000 }),
});

const genChangedScene = fc.record({
  params: genSyncParams,
  seeds: fc.array(genTimerSeed, { minLength: 1, maxLength: 29 }),
  added: genTimerSeed,
  targetIndex: fc.nat(),
  nowOffset: fc.integer({ min: 0, max: 1_800_000 }),
});

const genAdjustedNoOpScene = fc
  .record({
    arms: fc.integer({ min: 2, max: 10 }),
    toleranceRatio: fc.integer({ min: 1, max: 50 }),
    duration: fc.integer({ min: 60_000, max: 600_000 }),
  })
  .chain(({ arms, toleranceRatio, duration }) => {
    const overlapLimit = Math.max(2, Math.floor((2 * duration * toleranceRatio) / 100));
    return fc.integer({ min: 2, max: Math.min(5_000, overlapLimit) }).map((gap) => ({
      params: { arms, toleranceRatio } satisfies SyncParams,
      duration,
      gap,
    }));
  });

function timerFromSeed(seed: TimerSeed, index: number, idPrefix = "timer"): Timer {
  const startTime = BASE_TIME + seed.offset;
  return createTimer({
    id: `${idPrefix}-${index}` as TimerId,
    slotIds: nonEmpty([`slot-${index}` as SlotId]),
    noodleType: "ramen" as NoodleType,
    firmness: "normal",
    startTime: startTime as EpochMillis,
    endTime: (startTime + seed.duration) as EpochMillis,
    seq: index,
  });
}

function confirmedState(timers: readonly Timer[], params: SyncParams): TimerState {
  return {
    ...EMPTY_STATE,
    timers: synchronize(timers, params),
    nextSeq: timers.length,
    lastSequenceByTerminal: { terminal: "42" },
  };
}

function confirmedTimers(state: TimerState) {
  return state.timers
    .map((timer) => ({
      id: timer.id,
      endTime: timer.endTime,
      firmness: timer.firmness,
      adjustment: timer.adjustment,
      boiledAt: timer.boiledAt,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function expectPersistFirstEffects(state: TimerState, effects: readonly Effect[]): void {
  expect(effects.length).toBeGreaterThan(0);
  expect(effects[0]?.type).toBe("Persist");

  const broadcastIndices: number[] = [];
  const alarmIndices: number[] = [];
  effects.forEach((effect, index) => {
    if (effect.type === "Broadcast") broadcastIndices.push(index);
    if (effect.type === "SetAlarm" || effect.type === "ClearAlarm") alarmIndices.push(index);
    if (effect.type === "Broadcast" || effect.type === "SetAlarm" || effect.type === "ClearAlarm") {
      expect(index).toBeGreaterThan(0);
    }
  });

  expect(broadcastIndices.length).toBeGreaterThanOrEqual(1);
  expect(alarmIndices).toHaveLength(1);
  const alarmIndex = alarmIndices[0];
  const firstBroadcastIndex = broadcastIndices[0];
  if (alarmIndex === undefined || firstBroadcastIndex === undefined) {
    throw new Error("基本Effect列のAlarmまたはBroadcastが存在しない");
  }

  const hasRunning = state.timers.some((timer) => timer.boiledAt === null);
  expect(effects[alarmIndex]?.type).toBe(hasRunning ? "SetAlarm" : "ClearAlarm");
  expect(alarmIndex).toBeGreaterThan(0);
  expect(alarmIndex).toBeLessThan(firstBroadcastIndex);
  expect(broadcastIndices.every((index) => index > alarmIndex)).toBe(true);
  expect(effects.some((effect) => effect.type === "RequestPlan")).toBe(false);
}

function cloneConfirmedState(state: TimerState): TimerState {
  return {
    ...state,
    timers: state.timers.map((timer) => ({
      ...timer,
      slotIds: nonEmpty([...timer.slotIds]),
      orderItem: timer.orderItem === null ? null : { ...timer.orderItem },
    })),
    pendingOrders: [...state.pendingOrders],
    acceptedSlices: [...state.acceptedSlices],
    lastSequenceByTerminal: { ...state.lastSequenceByTerminal },
  };
}

function expectChangedSettlement(
  prev: TimerState,
  moved: TimerState,
  params: SyncParams,
  now: EpochMillis,
): void {
  const outcome = settle(prev, moved, settleParams(params), now, false);
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;

  expect(confirmedTimers(outcome.state)).not.toEqual(confirmedTimers(prev));
  expectPersistFirstEffects(outcome.state, outcome.effects);
}

// Feature: synchronized-boil-adjustment, Property 14: 確定結果が変化するときのみ Persist 先頭の Effect 列を出す
// Validates: Requirements 5.2, 7.6, 7.7
describe("engine/settle — Effect列順序とno-op抑止", () => {
  it("Start・Cancel・boiled相当の確定変化はPersist先頭・Alarm・Broadcast順のEffect列を出す", () => {
    fc.assert(
      fc.property(genChangedScene, ({ params, seeds, added, targetIndex, nowOffset }) => {
        const prev = confirmedState(
          seeds.map((seed, index) => timerFromSeed(seed, index)),
          params,
        );
        const now = (BASE_TIME + nowOffset) as EpochMillis;
        const target = prev.timers[targetIndex % prev.timers.length];
        if (target === undefined) throw new Error("集合変化対象のTimerが存在しない");

        const started: TimerState = {
          ...prev,
          timers: [...prev.timers, timerFromSeed(added, prev.nextSeq, "added")],
          nextSeq: prev.nextSeq + 1,
        };
        const cancelled: TimerState = {
          ...prev,
          timers: prev.timers.filter((timer) => timer.id !== target.id),
        };
        const boiled: TimerState = {
          ...prev,
          timers: prev.timers.map((timer) =>
            timer.id === target.id ? { ...timer, boiledAt: now } : timer,
          ),
        };

        expectChangedSettlement(prev, started, params, now);
        expectChangedSettlement(prev, cancelled, params, now);
        expectChangedSettlement(prev, boiled, params, now);
      }),
      { numRuns: 120 },
    );
  });

  it("非ゼロAdjustmentを含む同内容の別配列・別オブジェクトはeffects空でprevを返す", () => {
    fc.assert(
      fc.property(genAdjustedNoOpScene, ({ params, duration, gap }) => {
        const timers = [
          timerFromSeed({ offset: 0, duration }, 0),
          timerFromSeed({ offset: gap, duration }, 1),
        ];
        const prev = confirmedState(timers, params);
        expect(prev.timers.some((timer) => timer.boiledAt === null && timer.adjustment !== 0)).toBe(
          true,
        );

        const movedEquivalent = cloneConfirmedState(prev);
        expect(movedEquivalent).not.toBe(prev);
        expect(movedEquivalent.timers).not.toBe(prev.timers);
        expect(movedEquivalent.timers[0]).not.toBe(prev.timers[0]);

        const outcome = settle(
          prev,
          movedEquivalent,
          settleParams(params),
          BASE_TIME as EpochMillis,
          false,
        );
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;

        expect(outcome.effects).toEqual([]);
        expect(outcome.state).toBe(prev);
      }),
      { numRuns: 100 },
    );
  });
});
