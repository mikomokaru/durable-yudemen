import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { adjustedEndTime, toWireTimer } from "../../src/engine/project";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { nonEmpty } from "../nonEmpty";

const BASE_TIME = 1_700_000_000_000;

const genTimer: fc.Arbitrary<Timer> = fc
  .record({
    startOffset: fc.integer({ min: 0, max: 86_400_000 }),
    duration: fc.integer({ min: 1, max: 3_600_000 }),
    seq: fc.integer({ min: 0, max: 100_000 }),
  })
  .chain((seed) => {
    const halfDuration = Math.floor(seed.duration / 2);
    return fc.integer({ min: -halfDuration, max: halfDuration }).map((adjustment) => {
      const startTime = BASE_TIME + seed.startOffset;
      return createTimer({
        id: `timer-${seed.seq}-${seed.startOffset}` as TimerId,
        slotIds: nonEmpty([String(seed.seq % 18) as SlotId]),
        noodleType: "ramen" as NoodleType,
        firmness: "normal",
        startTime: startTime as EpochMillis,
        endTime: (startTime + seed.duration) as EpochMillis,
        seq: seed.seq,
        adjustment,
      });
    });
  });

const genUnadjustedTimer: fc.Arbitrary<Timer> = genTimer.map((timer) =>
  createTimer({ ...timer, adjustment: 0 }),
);

// Feature: synchronized-boil-adjustment, Property 10: 射影は実効endTimeを載せアンカーを変えない
// Validates: Requirements 4.2, 4.5, 4.7
describe("engine/project — effective endTime projection and anchor invariance", () => {
  it("Property 10: 実効 endTime を射影しても入力 Timer と不変アンカーを変更しない", () => {
    fc.assert(
      fc.property(genTimer, (timer) => {
        const originalStartTime = timer.startTime;
        const originalEndTime = timer.endTime;
        const originalTimer = { ...timer, slotIds: [...timer.slotIds] };

        const effectiveEndTime = adjustedEndTime(timer);
        const wireTimer = toWireTimer(timer);

        expect(effectiveEndTime as number).toBe((originalEndTime as number) + timer.adjustment);
        expect(wireTimer.endTime as number).toBe((originalEndTime as number) + timer.adjustment);
        expect(wireTimer.startTime).toBe(originalStartTime);
        expect(timer.startTime).toBe(originalStartTime);
        expect(timer.endTime).toBe(originalEndTime);
        expect(timer).toEqual(originalTimer);
      }),
      { numRuns: 200 },
    );
  });

  it("Property 10: Adjustment 0 の wire endTime はオリジナル endTime と一致する", () => {
    fc.assert(
      fc.property(genUnadjustedTimer, (timer) => {
        const wireTimer = toWireTimer(timer);

        expect(timer.adjustment).toBe(0);
        expect(wireTimer.endTime).toBe(timer.endTime);
      }),
      { numRuns: 200 },
    );
  });
});
