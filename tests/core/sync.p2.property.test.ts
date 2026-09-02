import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { synchronize, type SyncParams } from "../../src/engine/sync";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { nonEmpty } from "../nonEmpty";

interface TimerSeed {
  readonly duration: number;
  readonly seq: number;
  readonly adjustment: number;
}

type EndTimeLayout = "near" | "separate" | "same";

interface SyncCase {
  readonly seeds: readonly TimerSeed[];
  readonly params: SyncParams;
  readonly layout: EndTimeLayout;
}

const BASE_TIME = 2_000_000_000;
const SEPARATE_GAP = 1_000_001;

const genDuration = fc.oneof(
  fc.constantFrom(100, 1_000, 10_000, 60_000, 500_000),
  fc.integer({ min: 100, max: 500_000 }),
);

const genStaleAdjustment = fc.oneof(
  fc.integer({ min: -1_000_000, max: -1 }),
  fc.integer({ min: 1, max: 1_000_000 }),
);

const genSyncParams = fc.record({
  arms: fc.integer({ min: 1, max: 10 }),
  toleranceRatio: fc.integer({ min: 1, max: 50 }),
});

const genEndTimeLayout = fc.constantFrom<EndTimeLayout>("near", "separate", "same");

function genTimerSeeds(minLength: number): fc.Arbitrary<readonly TimerSeed[]> {
  return fc.uniqueArray(
    fc.record({
      duration: genDuration,
      seq: fc.integer({ min: 0, max: 1_000_000 }),
      adjustment: genStaleAdjustment,
    }),
    { minLength, maxLength: 30, selector: (seed) => seed.seq },
  );
}

function genSyncCase(minLength: number): fc.Arbitrary<SyncCase> {
  return fc.record({
    seeds: genTimerSeeds(minLength),
    params: genSyncParams,
    layout: genEndTimeLayout,
  });
}

const genPossiblyEmptyCase = genSyncCase(0);
const genNonEmptyCase = genSyncCase(1);

function endOffsets(
  seeds: readonly TimerSeed[],
  params: SyncParams,
  layout: EndTimeLayout,
): readonly number[] {
  if (layout === "same") return seeds.map(() => 0);
  if (layout === "separate") return seeds.map((_, index) => index * SEPARATE_GAP);

  const offsets: number[] = [];
  for (const [index, seed] of seeds.entries()) {
    if (index === 0) {
      offsets.push(0);
      continue;
    }

    const previous = seeds[index - 1];
    const previousOffset = offsets[index - 1];
    if (previous === undefined || previousOffset === undefined)
      throw new Error("近接時刻の生成に失敗した");

    // 隣接する窓の半幅合計より小さい正の差を使い、連鎖する近接時刻を作る。
    const overlappingGap = Math.max(
      1,
      Math.floor(((previous.duration + seed.duration) * params.toleranceRatio) / 400),
    );
    offsets.push(previousOffset + overlappingGap);
  }
  return offsets;
}

function timersFromCase(syncCase: SyncCase): readonly Timer[] {
  const offsets = endOffsets(syncCase.seeds, syncCase.params, syncCase.layout);
  return syncCase.seeds.map((seed, index) => {
    const endTime = BASE_TIME + (offsets[index] ?? 0);
    return createTimer({
      id: `timer-${index}-${seed.seq}` as TimerId,
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

function expectEveryTimerWithinOriginalWindow(timers: readonly Timer[], params: SyncParams): void {
  const originalById = new Map(timers.map((timer) => [timer.id, timer]));
  const synchronized = synchronize(timers, params);

  expect(new Set(timers.map((timer) => timer.id)).size).toBe(timers.length);
  expect(new Set(timers.map((timer) => timer.seq)).size).toBe(timers.length);
  expect(synchronized).toHaveLength(timers.length);

  for (const timer of synchronized) {
    const original = originalById.get(timer.id);
    expect(original).toBeDefined();
    if (original === undefined) throw new Error(`同期結果に未知の Timer ${timer.id} が存在する`);

    const halfWidth = ((original.endTime - original.startTime) * params.toleranceRatio) / 100;
    const windowStart = original.endTime - halfWidth;
    const windowEnd = original.endTime + halfWidth;
    const effectiveEndTime = timer.endTime + timer.adjustment;

    expect(timer.startTime).toBe(original.startTime);
    expect(timer.endTime).toBe(original.endTime);
    expect(timer.adjustment).toBeGreaterThanOrEqual(-halfWidth);
    expect(timer.adjustment).toBeLessThanOrEqual(halfWidth);
    expect(effectiveEndTime).toBeGreaterThanOrEqual(windowStart);
    expect(effectiveEndTime).toBeLessThanOrEqual(windowEnd);
  }
}

// Feature: synchronized-boil-adjustment, Property 2: Adjustment は許容調整窓内に収まる
// **Validates: Requirements 3.3, 3.7, 4.3**
describe("engine/sync — tolerance window convergence", () => {
  it("Property 2: 0〜30 本の全 running Timer を各自の許容調整窓内へ収める", () => {
    fc.assert(
      fc.property(genPossiblyEmptyCase, (syncCase) => {
        expectEveryTimerWithinOriginalWindow(timersFromCase(syncCase), syncCase.params);
      }),
      { numRuns: 300 },
    );
  });

  it("Property 2: 非空の running 集合では各 Timer の Adjustment と実効 endTime を必ず検証する", () => {
    fc.assert(
      fc.property(genNonEmptyCase, (syncCase) => {
        const timers = timersFromCase(syncCase);
        expect(timers.length).toBeGreaterThan(0);
        expectEveryTimerWithinOriginalWindow(timers, syncCase.params);
      }),
      { numRuns: 300 },
    );
  });
});
