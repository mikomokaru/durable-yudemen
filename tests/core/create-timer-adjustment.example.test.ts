// Feature: synchronized-boil-adjustment, Example: createTimer Adjustment
// Validates: Requirements 4.1, 4.5

import { describe, expect, it } from "vitest";
import { createTimer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { nonEmpty } from "../nonEmpty";

const START_TIME = 1_000_000 as EpochMillis;
const END_TIME = 1_180_000 as EpochMillis;
const base = {
  id: "timer-adjustment" as TimerId,
  slotIds: nonEmpty(["0" as SlotId]),
  noodleType: "Thin" as NoodleType,
  firmness: "normal",
  startTime: START_TIME,
  endTime: END_TIME,
  seq: 0,
} as const;

describe("createTimer — Adjustment の構築境界", () => {
  it("adjustment を省略すると 0 で生まれ、時刻アンカーを保持する", () => {
    const timer = createTimer(base);

    expect(timer.adjustment).toBe(0);
    expect(timer.startTime).toBe(START_TIME);
    expect(timer.endTime).toBe(END_TIME);
  });

  it.each([
    ["負", -30_000],
    ["0", 0],
    ["正", 45_000],
  ] as const)(
    "%sの adjustment を明示すると値と時刻アンカーを保持する",
    (_direction, adjustment) => {
      const timer = createTimer({ ...base, adjustment });

      expect(timer.adjustment).toBe(adjustment);
      expect(timer.startTime).toBe(START_TIME);
      expect(timer.endTime).toBe(END_TIME);
    },
  );
});
