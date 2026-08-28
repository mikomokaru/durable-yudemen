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
  readonly boiled: boolean;
  readonly boiledAtOffset: number;
  readonly adjustment: number;
}

const BASE_TIME = 2_000_000;

const genStaleAdjustment = fc.oneof(
  fc.integer({ min: -500_000, max: -1 }),
  fc.integer({ min: 1, max: 500_000 }),
);

const genTimerSeeds = fc.uniqueArray(
  fc.record({
    duration: fc.integer({ min: 100, max: 500_000 }),
    endOffset: fc.integer({ min: 0, max: 1_000_000 }),
    seq: fc.integer({ min: 0, max: 100_000 }),
    boiled: fc.boolean(),
    boiledAtOffset: fc.integer({ min: 0, max: 1_500_000 }),
    adjustment: genStaleAdjustment,
  }),
  { minLength: 1, maxLength: 30, selector: (seed) => seed.seq },
);

const genSyncParams: fc.Arbitrary<SyncParams> = fc.record({
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
      boiledAt: seed.boiled ? ((BASE_TIME + seed.boiledAtOffset) as EpochMillis) : null,
      adjustment: seed.adjustment,
    });
  });
}

function expectRunningMatchesIsolatedSynchronization(
  input: readonly Timer[],
  actual: readonly Timer[],
  params: SyncParams,
): void {
  const expectedRunning = synchronize(
    input.filter((timer) => timer.boiledAt === null),
    params,
  );
  const expectedById = new Map(expectedRunning.map((timer) => [timer.id, timer]));

  for (const timer of actual.filter((candidate) => candidate.boiledAt === null)) {
    const expected = expectedById.get(timer.id);
    expect(expected).toBeDefined();
    if (expected === undefined) throw new Error(`running の同期結果に ${timer.id} が存在しない`);
    expect(timer.adjustment).toBe(expected.adjustment);
  }
}

function expectBoiledFrozen(input: readonly Timer[], actual: readonly Timer[]): void {
  const actualById = new Map(actual.map((timer) => [timer.id, timer]));

  for (const before of input.filter((timer) => timer.boiledAt !== null)) {
    const after = actualById.get(before.id);
    expect(after).toBeDefined();
    if (after === undefined) throw new Error(`boiled の同期結果に ${before.id} が存在しない`);

    expect(after.adjustment).toBe(before.adjustment);
    expect(after.boiledAt).toBe(before.boiledAt);
    expect(after.endTime).toBe(before.endTime);
    expect(after).toEqual(before);
  }
}

// Feature: synchronized-boil-adjustment, Property 1: 同期は Running_Timer のみに作用し boiled を凍結する
// **Validates: Requirements 1.1, 7.3**
describe("engine/sync — running 限定と boiled 凍結", () => {
  it("Property 1: running だけを再同期し boiled の値と入力集合の形を保持する", () => {
    fc.assert(
      fc.property(genTimerSeeds, genSyncParams, (seeds, params) => {
        const input = timersFromSeeds(seeds);
        const actual = synchronize(input, params);
        const inputIds = input.map((timer) => timer.id);
        const actualIds = actual.map((timer) => timer.id);

        expect(actual).toHaveLength(input.length);
        expect(actualIds).toEqual(inputIds);
        expect(new Set(actualIds)).toEqual(new Set(inputIds));
        expectRunningMatchesIsolatedSynchronization(input, actual, params);
        expectBoiledFrozen(input, actual);
      }),
      { numRuns: 300 },
    );
  });
});
