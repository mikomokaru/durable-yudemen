import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fireDueTimers } from "../../src/engine/fire";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import { synchronize, type SyncParams } from "../../src/engine/sync";
import { createTimer, type Timer } from "../../src/engine/timer";
import { EPSILON_MS, type EpochMillis, type NoodleType, type SlotId, type TimerId } from "../../src/engine/types";
import { nonEmpty } from "../nonEmpty";
import { settleParams } from "../settleParams";

interface AdjustedFireCase {
  readonly params: SyncParams;
  readonly timers: readonly Timer[];
  readonly boundary: "before" | "equal" | "after";
}

const BOIL_DURATION_MS = 10_000;

const adjustedFireCaseArb: fc.Arbitrary<AdjustedFireCase> = fc
  .integer({ min: 1, max: 50 })
  .chain((toleranceRatio) =>
    fc
      .record({
        firstEndTime: fc.integer({ min: 1_000_000, max: 2_000_000_000 }),
        halfGap: fc.integer({ min: 1, max: toleranceRatio * 100 }),
        boundary: fc.constantFrom<AdjustedFireCase["boundary"]>("before", "equal", "after"),
      })
      .map(({ firstEndTime, halfGap, boundary }) => {
        const secondEndTime = firstEndTime + halfGap * 2;
        return {
          params: { arms: 2, toleranceRatio },
          timers: [
            runningTimer("positive-adjustment", "0", firstEndTime, 0),
            runningTimer("negative-adjustment", "1", secondEndTime, 1),
          ],
          boundary,
        };
      }),
  );

function runningTimer(id: string, slotId: string, endTime: number, seq: number): Timer {
  return createTimer({
    id: id as TimerId,
    slotIds: nonEmpty([slotId as SlotId]),
    noodleType: "ramen" as NoodleType,
    firmness: "normal",
    startTime: (endTime - BOIL_DURATION_MS) as EpochMillis,
    endTime: endTime as EpochMillis,
    seq,
    boiledAt: null,
  });
}

function confirmedState(timers: readonly Timer[], params: SyncParams): TimerState {
  return { ...EMPTY_STATE, timers: synchronize(timers, params) };
}

function commonAdjustedBoilTime(timers: readonly Timer[]): number {
  const targets = timers.map((timer) => timer.endTime + timer.adjustment);
  expect(new Set(targets).size).toBe(1);
  const target = targets[0];
  if (target === undefined) throw new Error("同期済みセットにTimerが存在しない");
  return target;
}

function nowAtBoundary(target: number, boundary: AdjustedFireCase["boundary"]): EpochMillis {
  const offset = boundary === "before" ? -1 : boundary === "after" ? 1 : 0;
  return (target - EPSILON_MS + offset) as EpochMillis;
}

function expectedDueIds(timers: readonly Timer[], now: EpochMillis): readonly string[] {
  const threshold = (now as number) + EPSILON_MS;
  return timers
    .filter((timer) => timer.boiledAt === null && timer.endTime + timer.adjustment <= threshold)
    .map((timer) => timer.id as string)
    .sort();
}

function newlyBoiledIds(before: readonly Timer[], after: readonly Timer[]): readonly string[] {
  const alreadyBoiled = new Set(
    before.filter((timer) => timer.boiledAt !== null).map((timer) => timer.id as string),
  );
  return after
    .filter((timer) => timer.boiledAt !== null && !alreadyBoiled.has(timer.id as string))
    .map((timer) => timer.id as string)
    .sort();
}

function fireFromConfirmedState(state: TimerState, now: EpochMillis, params: SyncParams): readonly string[] {
  const outcome = fireDueTimers(state, now, settleParams(params));
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error(`発火が拒否された: ${outcome.rejection.code}`);
  return newlyBoiledIds(state.timers, outcome.state.timers);
}

function dedicatedPairState(): TimerState {
  const timers = [
    runningTimer("delayed-positive", "0", 10_000, 0),
    runningTimer("advanced-negative", "1", 12_000, 1),
  ];
  return confirmedState(timers, { arms: 2, toleranceRatio: 10 });
}

// Feature: synchronized-boil-adjustment, Property 11: 発火は Adjusted_Boil_Time を基準にする
// Validates: Requirements 4.4
describe("engine/fire — Adjusted_Boil_Time membership", () => {
  it("Property 11: 新たにboiledになる集合は実効endTimeがnow+ε以下の集合と完全一致する", () => {
    fc.assert(
      fc.property(adjustedFireCaseArb, ({ timers, params, boundary }) => {
        const state = confirmedState(timers, params);
        expect(state.timers.some((timer) => timer.adjustment < 0)).toBe(true);
        expect(state.timers.some((timer) => timer.adjustment > 0)).toBe(true);

        const target = commonAdjustedBoilTime(state.timers);
        const now = nowAtBoundary(target, boundary);
        const expected = expectedDueIds(state.timers, now);
        const received = fireFromConfirmedState(state, now, params);

        expect(received).toEqual(expected);
        expect(expected).toHaveLength(boundary === "before" ? 0 : state.timers.length);
      }),
      { numRuns: 300 },
    );
  });

  it("負AdjustmentはオリジナルendTimeより前でもAdjusted_Boil_Time到達時に発火する", () => {
    const params = { arms: 2, toleranceRatio: 10 } satisfies SyncParams;
    const state = dedicatedPairState();
    const advanced = state.timers.find((timer) => timer.id === "advanced-negative");
    if (advanced === undefined) throw new Error("前倒しTimerが存在しない");
    const target = commonAdjustedBoilTime(state.timers);
    const now = (target - EPSILON_MS) as EpochMillis;
    const threshold = (now as number) + EPSILON_MS;

    expect(advanced.adjustment).toBeLessThan(0);
    expect(advanced.endTime <= threshold).toBe(false);
    expect(advanced.endTime + advanced.adjustment <= threshold).toBe(true);
    expect(fireFromConfirmedState(state, now, params)).toContain(advanced.id as string);
  });

  it("正AdjustmentはオリジナルendTime到達後でもAdjusted_Boil_Time未到達なら発火しない", () => {
    const params = { arms: 2, toleranceRatio: 10 } satisfies SyncParams;
    const state = dedicatedPairState();
    const delayed = state.timers.find((timer) => timer.id === "delayed-positive");
    if (delayed === undefined) throw new Error("後ろ倒しTimerが存在しない");
    const now = delayed.endTime as EpochMillis;
    const threshold = (now as number) + EPSILON_MS;

    expect(delayed.adjustment).toBeGreaterThan(0);
    expect(delayed.endTime <= threshold).toBe(true);
    expect(delayed.endTime + delayed.adjustment <= threshold).toBe(false);
    expect(fireFromConfirmedState(state, now, params)).not.toContain(delayed.id as string);
  });

  it("Adjusted_Boil_Timeがnow+EPSILON_MSと等しい境界を発火に含める", () => {
    const params = { arms: 2, toleranceRatio: 10 } satisfies SyncParams;
    const state = dedicatedPairState();
    const target = commonAdjustedBoilTime(state.timers);
    const now = (target - EPSILON_MS) as EpochMillis;

    expect(target).toBe((now as number) + EPSILON_MS);
    expect(fireFromConfirmedState(state, now, params)).toEqual(
      state.timers.map((timer) => timer.id as string).sort(),
    );
  });
});
