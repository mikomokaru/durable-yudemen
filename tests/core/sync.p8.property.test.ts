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

interface OrderCase {
  readonly timers: readonly Timer[];
  readonly permutation: readonly Timer[];
  readonly params: SyncParams;
}

interface ObservedTiming {
  readonly adjustment: number;
  readonly adjustedEndTime: number;
}

const BASE_TIME = 2_000_000;

const genTimerSeeds = fc.uniqueArray(
  fc.record({
    duration: fc.integer({ min: 100, max: 500_000 }),
    endOffset: fc.integer({ min: 0, max: 1_000_000 }),
    seq: fc.integer({ min: 0, max: 100_000 }),
    adjustment: fc.integer({ min: -500_000, max: 500_000 }),
  }),
  { minLength: 2, maxLength: 30, selector: (seed) => seed.seq },
);

const genSyncParams = fc.record({
  arms: fc.integer({ min: 1, max: 10 }),
  toleranceRatio: fc.integer({ min: 1, max: 50 }),
});

const genOrderCase: fc.Arbitrary<OrderCase> = fc
  .tuple(genTimerSeeds, genSyncParams)
  .chain(([seeds, params]) => {
    const timers = timersFromSeeds(seeds);
    return fc
      .shuffledSubarray([...timers], { minLength: timers.length, maxLength: timers.length })
      .map((permutation) => ({ timers, permutation, params }));
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
      adjustment: seed.adjustment,
    });
  });
}

function observedTimingById(timers: readonly Timer[]): ReadonlyMap<TimerId, ObservedTiming> {
  return new Map(
    timers.map((timer) => [
      timer.id,
      { adjustment: timer.adjustment, adjustedEndTime: timer.endTime + timer.adjustment },
    ]),
  );
}

function expectSameTimingById(
  originalOrder: readonly Timer[],
  permutedOrder: readonly Timer[],
  params: SyncParams,
): void {
  const originalById = observedTimingById(synchronize(originalOrder, params));
  const permutedById = observedTimingById(synchronize(permutedOrder, params));

  expect(permutedById.size).toBe(originalById.size);
  for (const timer of originalOrder) {
    const original = originalById.get(timer.id);
    const permuted = permutedById.get(timer.id);
    expect(original).toBeDefined();
    expect(permuted).toBeDefined();
    if (original === undefined || permuted === undefined) {
      throw new Error(`同期結果に ${timer.id} が存在しない`);
    }
    expect(permuted.adjustment).toBe(original.adjustment);
    expect(permuted.adjustedEndTime).toBe(original.adjustedEndTime);
  }
}

function sameEndTimePartitionCase(): readonly Timer[] {
  return timersFromSeeds([
    { duration: 30_000, endOffset: 10_000, seq: 1, adjustment: 700 },
    { duration: 10_000, endOffset: 10_000, seq: 2, adjustment: -500 },
    { duration: 20_000, endOffset: 10_000, seq: 3, adjustment: 300 },
  ]);
}

// Feature: synchronized-boil-adjustment, Property 8: 順序非依存
// **Validates: Requirements 3.5, 7.5**
describe("engine/sync — order independence", () => {
  it("Property 8: 任意の全長置換でも id 別の Adjustment が完全一致する", () => {
    fc.assert(
      fc.property(genOrderCase, ({ timers, permutation, params }) => {
        expect(permutation).toHaveLength(timers.length);
        expectSameTimingById(timers, permutation, params);
      }),
      { numRuns: 200 },
    );
  });

  it("同着 endTime を seq で arms 分割する結果は逆順入力でも変わらない", () => {
    const timers = sameEndTimePartitionCase();
    const reversed = [...timers].reverse();
    const params: SyncParams = { arms: 2, toleranceRatio: 10 };

    expect(reversed.map((timer) => timer.id)).not.toEqual(timers.map((timer) => timer.id));
    expectSameTimingById(timers, reversed, params);

    const adjustments = synchronize(timers, params).map((timer) => timer.adjustment);
    expect(new Set(adjustments).size).toBeGreaterThan(1);
  });
});
