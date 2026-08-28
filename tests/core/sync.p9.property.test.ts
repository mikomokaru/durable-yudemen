import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { synchronize, type SyncParams } from "../../src/engine/sync";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { nonEmpty } from "../nonEmpty";

interface TimerSeed {
  readonly duration: number;
  readonly endOffset: number;
  readonly seq: number;
  readonly adjustment: number;
}

const BASE_TIME = 2_000_000;

const genDuration = fc.oneof(
  fc.constantFrom(100, 1_000, 10_000, 60_000, 500_000),
  fc.integer({ min: 100, max: 500_000 }),
);

const genEndOffset = fc.oneof(
  fc.constantFrom(0, 500, 1_000, 10_000, 100_000, 1_000_000),
  fc.integer({ min: 0, max: 1_000_000 }),
  fc.integer({ min: 0, max: 2_000 }).map((offset) => Math.floor(offset / 100) * 100),
);

const genStaleAdjustment = fc.oneof(
  fc.integer({ min: -500_000, max: -1 }),
  fc.constant(0),
  fc.integer({ min: 1, max: 500_000 }),
);

const genTimerSeeds = fc.uniqueArray(
  fc.record({
    duration: genDuration,
    endOffset: genEndOffset,
    seq: fc.integer({ min: 0, max: 100_000 }),
    adjustment: genStaleAdjustment,
  }),
  { minLength: 1, maxLength: 30, selector: (seed) => seed.seq },
);

const genSyncParams = fc.record({
  arms: fc.integer({ min: 1, max: 10 }),
  toleranceRatio: fc.integer({ min: 1, max: 50 }),
});

function timersFromSeeds(seeds: readonly TimerSeed[]): readonly Timer[] {
  return seeds.map((seed, index) => {
    const endTime = BASE_TIME + seed.endOffset;
    return createTimer({
      id: `timer-${index}` as TimerId,
      slotIds: nonEmpty([String(index % 18) as SlotId]),
      noodleType: "ramen" as NoodleType,
      firmness: "normal",
      startTime: (endTime - seed.duration) as EpochMillis,
      endTime: endTime as EpochMillis,
      seq: seed.seq,
      boiledAt: null,
      adjustment: seed.adjustment,
    });
  });
}

function invariantFields(timer: Timer): Omit<Timer, "adjustment"> {
  const { adjustment: _adjustment, ...fields } = timer;
  return fields;
}

function expectStableById(once: readonly Timer[], twice: readonly Timer[]): void {
  const twiceById = new Map(twice.map((timer) => [timer.id, timer]));

  expect(twiceById.size).toBe(once.length);
  for (const first of once) {
    const second = twiceById.get(first.id);
    expect(second).toBeDefined();
    if (second === undefined) throw new Error(`再同期結果に ${first.id} が存在しない`);

    expect(second.adjustment).toBe(first.adjustment);
    expect(second.endTime + second.adjustment).toBe(first.endTime + first.adjustment);
    expect(invariantFields(second)).toEqual(invariantFields(first));
  }
}

function expectIdempotent(timers: readonly Timer[], params: SyncParams): void {
  const once = synchronize(timers, params);
  const twice = synchronize(once, params);
  expectStableById(once, twice);
}

function mixedSynchronizationCase(): readonly Timer[] {
  return timersFromSeeds([
    { duration: 30_000, endOffset: 0, seq: 11, adjustment: 700 },
    { duration: 20_000, endOffset: 1_000, seq: 12, adjustment: -900 },
    { duration: 10_000, endOffset: 10_000, seq: 21, adjustment: 1_300 },
    { duration: 10_000, endOffset: 11_500, seq: 22, adjustment: -1_700 },
    { duration: 10_000, endOffset: 13_000, seq: 23, adjustment: 2_100 },
    { duration: 10_000, endOffset: 30_000, seq: 31, adjustment: -2_500 },
  ]);
}

// Feature: synchronized-boil-adjustment, Property 9: 冪等性
// **Validates: Requirements 7.5, 7.7**
describe("engine/sync — idempotence", () => {
  it("Property 9: 再同期後の Adjustment は id 別に一回目の確定結果と完全一致する", () => {
    fc.assert(
      fc.property(genTimerSeeds, genSyncParams, (seeds, params) => {
        expectIdempotent(timersFromSeeds(seeds), params);
      }),
      { numRuns: 200 },
    );
  });

  it("全 Timer が非ゼロの stale Adjustment を持つ混合集合でも再同期は no-op になる", () => {
    const timers = mixedSynchronizationCase();
    expect(timers.every((timer) => timer.adjustment !== 0)).toBe(true);

    expectIdempotent(timers, { arms: 3, toleranceRatio: 10 });
  });
});
