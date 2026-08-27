import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { synchronize, type SyncParams } from "../../src/engine/sync";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { nonEmpty } from "../nonEmpty";
import { referenceSyncSets, referenceWindowIntersection } from "./sync.reference";

interface TimerSeed {
  readonly duration: number;
  readonly endOffset: number;
  readonly seq: number;
}

const BASE_TIME = 1_000_000;

const genTimerSeeds = fc.uniqueArray(
  fc.record({
    duration: fc.integer({ min: 100, max: 500_000 }),
    endOffset: fc.integer({ min: 0, max: 500_000 }),
    seq: fc.integer({ min: 0, max: 10_000 }),
  }),
  { maxLength: 30, selector: (seed) => seed.seq },
);

const genSyncParams = fc.record({
  arms: fc.integer({ min: 1, max: 10 }),
  toleranceRatio: fc.integer({ min: 1, max: 50 }),
});

const genGuaranteedConfirmedSet = fc
  .record({
    durationUnitsA: fc.integer({ min: 1, max: 5_000 }),
    durationUnitsB: fc.integer({ min: 1, max: 5_000 }),
    distanceSeed: fc.integer({ min: 0, max: 1_000_000 }),
    seqA: fc.integer({ min: 0, max: 10_000 }),
    seqGap: fc.integer({ min: 1, max: 10_000 }),
    arms: fc.integer({ min: 2, max: 10 }),
    toleranceRatio: fc.integer({ min: 1, max: 50 }),
  })
  .map(({ durationUnitsA, durationUnitsB, distanceSeed, seqA, seqGap, arms, toleranceRatio }) => {
    const maximumOverlapDistance = (durationUnitsA + durationUnitsB) * toleranceRatio;
    const distance = distanceSeed % (maximumOverlapDistance + 1);
    return {
      timers: timersFromSeeds([
        { duration: durationUnitsA * 100, endOffset: 0, seq: seqA },
        { duration: durationUnitsB * 100, endOffset: distance, seq: seqA + seqGap },
      ]),
      params: { arms, toleranceRatio },
    };
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
    });
  });
}

function independentlyConfirmedSets(timers: readonly Timer[], params: SyncParams): readonly (readonly Timer[])[] {
  return referenceSyncSets(timers, params).filter((set) => {
    if (set.length < 2) return false;
    const intersection = referenceWindowIntersection(set, params.toleranceRatio);
    return intersection.left <= intersection.right;
  });
}

function expectEffectiveEndTimesToMatch(
  timers: readonly Timer[],
  params: SyncParams,
  confirmedSets: readonly (readonly Timer[])[],
): void {
  const synchronizedById = new Map(synchronize(timers, params).map((timer) => [timer.id, timer]));

  for (const set of confirmedSets) {
    const effectiveEndTimes = set.map((inputTimer) => {
      const synchronized = synchronizedById.get(inputTimer.id);
      expect(synchronized).toBeDefined();
      if (synchronized === undefined) throw new Error(`同期結果に ${inputTimer.id} が存在しない`);
      return synchronized.endTime + synchronized.adjustment;
    });
    expect(new Set(effectiveEndTimes).size).toBe(1);
  }
}

// Feature: synchronized-boil-adjustment, Property 5: 同期確定セットのメンバーは実効 endTime が完全一致する
// **Validates: Requirements 2.6**
describe("engine/sync — confirmed Sync_Set effective endTime", () => {
  it("Property 5: 独立参照モデルが同期確定と判定した複数メンバーの実効 endTime が一致する", () => {
    fc.assert(
      fc.property(genTimerSeeds, genSyncParams, (seeds, params) => {
        const timers = timersFromSeeds(seeds);
        const confirmedSets = independentlyConfirmedSets(timers, params);

        expectEffectiveEndTimesToMatch(timers, params, confirmedSets);
      }),
      { numRuns: 200 },
    );
  });

  it("Property 5: 同期確定する複数メンバー集合を必ず含む入力でも実効 endTime が一致する", () => {
    fc.assert(
      fc.property(genGuaranteedConfirmedSet, ({ timers, params }) => {
        const confirmedSets = independentlyConfirmedSets(timers, params);

        expect(confirmedSets.some((set) => set.length >= 2)).toBe(true);
        expectEffectiveEndTimesToMatch(timers, params, confirmedSets);
      }),
      { numRuns: 100 },
    );
  });
});
