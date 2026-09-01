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

interface MaximinCase {
  readonly timers: readonly Timer[];
  readonly params: SyncParams;
  readonly setCount: number;
}

interface ConfirmedSet {
  readonly timers: readonly Timer[];
  readonly interval: { readonly left: number; readonly right: number };
}

const BASE_TIME = 1_000_000;
const TOLERANCE_RATIO = 10;

const genMaximinCase: fc.Arbitrary<MaximinCase> = fc.integer({ min: 2, max: 4 }).chain((setCount) =>
  fc
    .record({
      halfWidths: fc.array(fc.integer({ min: 1, max: 3 }), {
        minLength: setCount,
        maxLength: setCount,
      }),
      overlapSeeds: fc.array(fc.integer({ min: 0, max: 1_000 }), {
        minLength: setCount - 1,
        maxLength: setCount - 1,
      }),
      firstEndOffset: fc.integer({ min: 0, max: 100 }),
    })
    .map(({ halfWidths, overlapSeeds, firstEndOffset }) => {
      const endOffsets = [firstEndOffset];
      for (let index = 1; index < setCount; index++) {
        const previousHalf = halfWidths[index - 1];
        const currentHalf = halfWidths[index];
        const overlapSeed = overlapSeeds[index - 1];
        if (previousHalf === undefined || currentHalf === undefined || overlapSeed === undefined) {
          throw new Error("生成した許容半幅または重なりシードが不足している");
        }
        const maximumOverlappingDistance = previousHalf + currentHalf;
        const previousEndOffset = endOffsets[index - 1];
        if (previousEndOffset === undefined) throw new Error("直前の終了時刻が存在しない");
        endOffsets.push(previousEndOffset + (overlapSeed % (maximumOverlappingDistance + 1)));
      }

      const timers = halfWidths.map((halfWidth, index) => {
        const endOffset = endOffsets[index];
        if (endOffset === undefined) throw new Error("生成した終了時刻が不足している");
        const endTime = BASE_TIME + endOffset;
        const duration = halfWidth * 10;
        return createTimer({
          id: `timer-${index}` as TimerId,
          slotIds: nonEmpty([String(index) as SlotId]),
          noodleType: "ramen" as NoodleType,
          firmness: "normal",
          startTime: (endTime - duration) as EpochMillis,
          endTime: endTime as EpochMillis,
          seq: index,
        });
      });

      return {
        timers,
        params: { arms: 1, toleranceRatio: TOLERANCE_RATIO },
        setCount,
      };
    }),
);

function confirmedSetsInSingleCluster(
  timers: readonly Timer[],
  params: SyncParams,
): readonly ConfirmedSet[] {
  const clusters = referenceProximityClusters(timers, params.toleranceRatio);
  expect(clusters).toHaveLength(1);
  const cluster = clusters[0];
  if (cluster === undefined) throw new Error("同一 Proximity_Cluster が形成されなかった");

  return referenceSyncSets(cluster, params)
    .map((set) => ({
      timers: set,
      interval: referenceWindowIntersection(set, params.toleranceRatio),
    }))
    .filter(({ interval }) => interval.left <= interval.right);
}

function maximumMinimumGapByEnumeration(
  intervals: readonly { readonly left: number; readonly right: number }[],
): number {
  let maximum = Number.NEGATIVE_INFINITY;
  const targets: number[] = [];

  function visit(index: number): void {
    if (index === intervals.length) {
      let minimum = Number.POSITIVE_INFINITY;
      for (let targetIndex = 1; targetIndex < targets.length; targetIndex++) {
        const previous = targets[targetIndex - 1];
        const current = targets[targetIndex];
        if (previous === undefined || current === undefined)
          throw new Error("配置の要素が不足している");
        minimum = Math.min(minimum, current - previous);
      }
      maximum = Math.max(maximum, minimum);
      return;
    }

    const interval = intervals[index];
    if (interval === undefined) throw new Error("列挙対象の区間が不足している");
    const previous = targets[index - 1];
    for (let candidate = interval.left; candidate <= interval.right; candidate++) {
      if (previous !== undefined && candidate < previous) continue;
      targets.push(candidate);
      visit(index + 1);
      targets.pop();
    }
  }

  visit(0);
  if (!Number.isFinite(maximum)) throw new Error("実行可能な整数ミリ秒配置が存在しない");
  return maximum;
}

function observedTarget(
  set: readonly Timer[],
  synchronizedById: ReadonlyMap<TimerId, Timer>,
): number {
  const targets = set.map((inputTimer) => {
    const synchronized = synchronizedById.get(inputTimer.id);
    if (synchronized === undefined) throw new Error(`同期結果に ${inputTimer.id} が存在しない`);
    return synchronized.endTime + synchronized.adjustment;
  });
  expect(new Set(targets).size).toBe(1);
  const target = targets[0];
  if (target === undefined) throw new Error("同期確定セットに Timer が存在しない");
  return target;
}

function minimumGap(targets: readonly number[]): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < targets.length; index++) {
    const previous = targets[index - 1];
    const current = targets[index];
    if (previous === undefined || current === undefined)
      throw new Error("観測 target が不足している");
    minimum = Math.min(minimum, current - previous);
  }
  return minimum;
}

// Feature: synchronized-boil-adjustment, Property 7: maximin 最適性
// **Validates: Requirements 3.4**
describe("engine/sync — maximin optimality", () => {
  it("Property 7: 小規模クラスタの観測最小 gap が整数 ms 全配置の最大値に一致する", () => {
    fc.assert(
      fc.property(genMaximinCase, ({ timers, params, setCount }) => {
        const confirmedSets = confirmedSetsInSingleCluster(timers, params);
        expect(confirmedSets).toHaveLength(setCount);
        expect(setCount).toBeGreaterThanOrEqual(2);
        expect(setCount).toBeLessThanOrEqual(4);

        const intervals = confirmedSets.map(({ interval }) => interval);
        for (const interval of intervals) {
          expect(Number.isInteger(interval.left)).toBe(true);
          expect(Number.isInteger(interval.right)).toBe(true);
        }

        const synchronizedById = new Map(
          synchronize(timers, params).map((timer) => [timer.id, timer]),
        );
        const observedTargets = confirmedSets.map(({ timers: set }) =>
          observedTarget(set, synchronizedById),
        );

        observedTargets.forEach((target, index) => {
          const interval = intervals[index];
          if (interval === undefined) throw new Error("観測 target に対応する区間が存在しない");
          expect(target).toBeGreaterThanOrEqual(interval.left);
          expect(target).toBeLessThanOrEqual(interval.right);
          const previous = observedTargets[index - 1];
          if (previous !== undefined) expect(target).toBeGreaterThanOrEqual(previous);
        });

        expect(minimumGap(observedTargets)).toBe(maximumMinimumGapByEnumeration(intervals));
      }),
      { numRuns: 200 },
    );
  });
});
