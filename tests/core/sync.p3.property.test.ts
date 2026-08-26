import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formProximityClusters } from "../../src/engine/sync";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { nonEmpty } from "../nonEmpty";

interface TimerSeed {
  readonly duration: number;
  readonly endOffset: number;
}

interface ReferenceWindow {
  readonly left: number;
  readonly right: number;
}

const BASE_TIME = 1_000_000;

const genTimerSeeds = fc.array(
  fc.record({
    duration: fc.integer({ min: 100, max: 500_000 }),
    endOffset: fc.integer({ min: 0, max: 500_000 }),
  }),
  { maxLength: 30 },
);

const genToleranceRatio = fc.integer({ min: 1, max: 50 });

const genBoundaryCase = fc
  .record({
    durationUnitsA: fc.integer({ min: 1, max: 5_000 }),
    durationUnitsB: fc.integer({ min: 1, max: 5_000 }),
    toleranceRatio: genToleranceRatio,
  })
  .map(({ durationUnitsA, durationUnitsB, toleranceRatio }) => {
    const durationA = durationUnitsA * 100;
    const durationB = durationUnitsB * 100;
    const touchingDistance = (durationUnitsA + durationUnitsB) * toleranceRatio;
    return {
      timers: timersFromSeeds([
        { duration: durationA, endOffset: 0 },
        { duration: durationB, endOffset: touchingDistance },
      ]),
      toleranceRatio,
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
      seq: index,
    });
  });
}

function referenceClusters(timers: readonly Timer[], toleranceRatio: number): readonly (readonly Timer[])[] {
  const windows: readonly ReferenceWindow[] = timers.map((timer) => {
    const half = ((timer.endTime - timer.startTime) * toleranceRatio) / 100;
    return { left: timer.endTime - half, right: timer.endTime + half };
  });
  const visited = new Set<number>();
  const clusters: Timer[][] = [];

  // Production の区間掃引と同じ欠陥を共有しないため、全対の辺から到達可能性を直接たどる。
  for (let origin = 0; origin < timers.length; origin++) {
    if (visited.has(origin)) continue;
    visited.add(origin);
    const pending = [origin];
    const cluster: Timer[] = [];

    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) continue;
      const timer = timers[current];
      const currentWindow = windows[current];
      if (timer === undefined || currentWindow === undefined) continue;
      cluster.push(timer);

      for (let candidate = 0; candidate < timers.length; candidate++) {
        if (visited.has(candidate)) continue;
        const candidateWindow = windows[candidate];
        if (candidateWindow === undefined) continue;
        const overlaps = currentWindow.left <= candidateWindow.right && candidateWindow.left <= currentWindow.right;
        if (!overlaps) continue;
        visited.add(candidate);
        pending.push(candidate);
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}

function canonicalMembership(clusters: readonly (readonly Timer[])[]): readonly (readonly string[])[] {
  return clusters
    .map((cluster) => cluster.map((timer) => timer.id as string).sort())
    .sort((a, b) => compareText(a.join("\u0000"), b.join("\u0000")));
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

describe("engine/sync — Proximity_Cluster", () => {
  // Feature: synchronized-boil-adjustment, Property 3: Proximity_Cluster は窓重なりの連結成分に一致する
  // **Validates: Requirements 1.3, 1.4, 1.5, 1.6**
  it("Property 3: 全対の窓重なりグラフが作る極大連結成分と一致する", () => {
    fc.assert(
      fc.property(genTimerSeeds, genToleranceRatio, (seeds, toleranceRatio) => {
        const timers = timersFromSeeds(seeds);
        const expected = canonicalMembership(referenceClusters(timers, toleranceRatio));
        const actual = canonicalMembership(formProximityClusters(timers, toleranceRatio));

        expect(actual).toEqual(expected);
      }),
      { numRuns: 200 },
    );
  });

  it("Property 3: 閉区間の境界が一点で接する二本を同じ連結成分に含める", () => {
    fc.assert(
      fc.property(genBoundaryCase, ({ timers, toleranceRatio }) => {
        const [first, second] = timers;
        expect(first).toBeDefined();
        expect(second).toBeDefined();
        if (first === undefined || second === undefined) return;

        const halfFirst = ((first.endTime - first.startTime) * toleranceRatio) / 100;
        const halfSecond = ((second.endTime - second.startTime) * toleranceRatio) / 100;
        expect(Math.abs(second.endTime - first.endTime)).toBe(halfFirst + halfSecond);
        expect(canonicalMembership(formProximityClusters(timers, toleranceRatio))).toEqual([
          [first.id as string, second.id as string],
        ]);
      }),
      { numRuns: 100 },
    );
  });
});
