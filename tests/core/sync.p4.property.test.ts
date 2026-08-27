import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formSyncSets } from "../../src/engine/sync";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { nonEmpty } from "../nonEmpty";
import { referenceSyncSets } from "./sync.reference";

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

function canonicalMembership(sets: readonly (readonly Timer[])[]): readonly (readonly string[])[] {
  return sets
    .map((set) => set.map((timer) => timer.id as string).sort(compareText))
    .sort((a, b) => compareText(a.join("\u0000"), b.join("\u0000")));
}

function canonicalOrderedSets(sets: readonly (readonly Timer[])[]): readonly (readonly string[])[] {
  return sets
    .map((set) => {
      const orderedIds = set.map((timer) => timer.id as string);
      return { membership: [...orderedIds].sort(compareText).join("\u0000"), orderedIds };
    })
    .sort((a, b) => compareText(a.membership, b.membership))
    .map(({ orderedIds }) => orderedIds);
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sameEndTimeTimers(seqOrder: readonly number[]): readonly Timer[] {
  return timersFromSeeds(seqOrder.map((seq) => ({ duration: 10_000, endOffset: 10_000, seq })));
}

// Feature: synchronized-boil-adjustment, Property 4: Sync_Set は Running_Timer 集合の分割である
// **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**
describe("engine/sync — Sync_Set partition", () => {
  it("Property 4: 独立参照モデルの昇順チャンクと一致し、全 Timer を重複なく被覆する", () => {
    fc.assert(
      fc.property(genTimerSeeds, genSyncParams, (seeds, params) => {
        const timers = timersFromSeeds(seeds);
        const expected = referenceSyncSets(timers, params);
        const actual = formSyncSets(timers, params);
        const inputIds = timers.map((timer) => timer.id as string).sort(compareText);
        const actualIds = actual.flatMap((set) => set.map((timer) => timer.id as string));

        expect(canonicalMembership(actual)).toEqual(canonicalMembership(expected));
        expect(canonicalOrderedSets(actual)).toEqual(canonicalOrderedSets(expected));
        expect([...actualIds].sort(compareText)).toEqual(inputIds);
        expect(new Set(actualIds).size).toBe(inputIds.length);
        for (const set of actual) {
          expect(set.length).toBeGreaterThanOrEqual(1);
          expect(set.length).toBeLessThanOrEqual(params.arms);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("arms=1 では同着 Timer を seq 昇順の singleton に分ける", () => {
    const timers = sameEndTimeTimers([3, 1, 2]);

    expect(formSyncSets(timers, { arms: 1, toleranceRatio: 10 }).map((set) => set.map((timer) => timer.seq))).toEqual([
      [1],
      [2],
      [3],
    ]);
  });

  it("クラスタサイズが arms の整数倍なら満杯のセットだけを作る", () => {
    const timers = sameEndTimeTimers([4, 1, 3, 2]);

    expect(formSyncSets(timers, { arms: 2, toleranceRatio: 10 }).map((set) => set.map((timer) => timer.seq))).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("クラスタサイズが arms の整数倍でなければ残余を最後のセットへ置く", () => {
    const timers = sameEndTimeTimers([5, 1, 4, 2, 3]);

    expect(formSyncSets(timers, { arms: 2, toleranceRatio: 10 }).map((set) => set.map((timer) => timer.seq))).toEqual([
      [1, 2],
      [3, 4],
      [5],
    ]);
  });
});
