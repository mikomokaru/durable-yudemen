import { describe, expect, it } from "vitest";
import { toWireTimer } from "../../src/engine/project";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import type { TimerFact } from "../../src/domain/timer";
import { nonEmpty } from "../nonEmpty";

const ORIGINAL_END_TIME = 1_700_000_180_000 as EpochMillis;
const WIRE_TIMER_KEYS = [
  "endTime",
  "firmness",
  "id",
  "noodleType",
  "orderItem",
  "slotIds",
  "startTime",
] as const satisfies readonly (keyof TimerFact)[];

function fixedTimer(id: string, adjustment: number, seq: number): Timer {
  return createTimer({
    id: id as TimerId,
    slotIds: nonEmpty(["0" as SlotId]),
    noodleType: "ramen" as NoodleType,
    firmness: "normal",
    startTime: 1_700_000_000_000 as EpochMillis,
    endTime: ORIGINAL_END_TIME,
    seq,
    boiledAt: null,
    adjustment,
    orderItem: { externalOrderId: "order-1", itemIndex: 0, tableId: null },
  });
}

function expectWireProjection(timer: Timer): void {
  const originalEndTime = timer.endTime;
  const wire = toWireTimer(timer);

  expect(wire.endTime).toBe((originalEndTime as number) + timer.adjustment);
  expect(wire.startTime).toBe(timer.startTime);
  expect(Object.keys(wire).sort()).toEqual(WIRE_TIMER_KEYS);
  expect(wire).not.toHaveProperty("adjustment");
  expect(wire).not.toHaveProperty("seq");
  expect(wire).not.toHaveProperty("boiledAt");
  // orderItem は共有事実として運ぶ（lift-group-display 判断 16）。engine 専用の 3 項目とは扱いが違う。
  expect(wire).toHaveProperty("orderItem", timer.orderItem);
  expect(timer.endTime).toBe(originalEndTime);
}

// Feature: synchronized-boil-adjustment, Example: toWireTimer hides Adjustment
// Validates: Requirements 4.1, 4.2, 5.1
describe("toWireTimer — Adjustment を wire に露出しない射影", () => {
  it("正Adjustmentを実効endTimeへ畳み、オリジナルendTimeを保持する", () => {
    expectWireProjection(fixedTimer("positive-adjustment", 12_000, 1));
  });

  it("負Adjustmentを実効endTimeへ畳み、オリジナルendTimeを保持する", () => {
    expectWireProjection(fixedTimer("negative-adjustment", -8_000, 2));
  });
});
