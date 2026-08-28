import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { synchronize, type SyncParams } from "../../src/engine/sync";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { nonEmpty } from "../nonEmpty";
import {
  referenceProximityClusters,
  referenceSyncSets,
  referenceWindowIntersection,
} from "./sync.reference";

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
    const timer = createTimer({
      id: `timer-${index}` as TimerId,
      slotIds: nonEmpty([String(index % 18) as SlotId]),
      noodleType: "ramen" as NoodleType,
      firmness: "normal",
      startTime: (endTime - seed.duration) as EpochMillis,
      endTime: endTime as EpochMillis,
      seq: seed.seq,
    });

    return { ...timer, adjustment: index % 2 === 0 ? 17_000 : -17_000 };
  });
}

function expectAdjustmentZeroById(
  synchronizedById: ReadonlyMap<TimerId, Timer>,
  expected: readonly Timer[],
): void {
  for (const inputTimer of expected) {
    const synchronized = synchronizedById.get(inputTimer.id);
    expect(synchronized).toBeDefined();
    if (synchronized === undefined) throw new Error(`同期結果に ${inputTimer.id} が存在しない`);
    expect(inputTimer.adjustment).not.toBe(0);
    expect(synchronized.adjustment).toBe(0);
  }
}

// Feature: synchronized-boil-adjustment, Property 6: 同期可能性とフォールバック
// **Validates: Requirements 1.7, 3.2, 3.6, 7.4**
describe("engine/sync — synchronization fallback", () => {
  it("Property 6: 窓の積が空の Sync_Set と単独 Proximity_Cluster を Adjustment 0 へ全体置換する", () => {
    fc.assert(
      fc.property(genTimerSeeds, genSyncParams, (seeds, params) => {
        const timers = timersFromSeeds(seeds);
        const unsyncableSets = referenceSyncSets(timers, params).filter((set) => {
          const intersection = referenceWindowIntersection(set, params.toleranceRatio);
          return set.length >= 2 && intersection.left > intersection.right;
        });
        const isolatedTimers = referenceProximityClusters(timers, params.toleranceRatio)
          .filter((cluster) => cluster.length === 1)
          .flatMap((cluster) => cluster);
        const synchronizedById = new Map(synchronize(timers, params).map((timer) => [timer.id, timer]));

        for (const set of unsyncableSets) {
          expectAdjustmentZeroById(synchronizedById, set);
        }
        expectAdjustmentZeroById(synchronizedById, isolatedTimers);
      }),
      { numRuns: 200 },
    );
  });

  it("連鎖重なりだが三者共通部分が空のセットと孤立 Timer を確実に無調整へ戻す", () => {
    const params: SyncParams = { arms: 3, toleranceRatio: 10 };
    const timers = timersFromSeeds([
      { duration: 10_000, endOffset: 0, seq: 0 },
      { duration: 10_000, endOffset: 1_500, seq: 1 },
      { duration: 10_000, endOffset: 3_000, seq: 2 },
      { duration: 10_000, endOffset: 10_000, seq: 3 },
    ]);
    const clusters = referenceProximityClusters(timers, params.toleranceRatio);
    const chainedCluster = clusters.find((cluster) => cluster.length === 3);
    const isolatedCluster = clusters.find((cluster) => cluster.length === 1);

    expect(chainedCluster).toBeDefined();
    expect(isolatedCluster).toBeDefined();
    if (chainedCluster === undefined || isolatedCluster === undefined) {
      throw new Error("専用ケースの独立参照モデルが期待したクラスタを形成しなかった");
    }

    const [chainedSet] = referenceSyncSets(chainedCluster, params);
    expect(chainedSet).toBeDefined();
    if (chainedSet === undefined) throw new Error("連鎖クラスタから Sync_Set を形成できなかった");
    const intersection = referenceWindowIntersection(chainedSet, params.toleranceRatio);
    expect(intersection.left).toBeGreaterThan(intersection.right);

    const synchronizedById = new Map(synchronize(timers, params).map((timer) => [timer.id, timer]));
    expectAdjustmentZeroById(synchronizedById, chainedSet);
    expectAdjustmentZeroById(synchronizedById, isolatedCluster);
  });
});
