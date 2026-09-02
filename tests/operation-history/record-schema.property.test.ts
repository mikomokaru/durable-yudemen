import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FIRMNESS_ORDER, isFirmness } from "../../src/domain/firmness";
import {
  recordsFromCommittedDiff,
  type OperationObservation,
} from "../../src/operation-history/derive";
import type { OperationRecord } from "../../src/operation-history/record";
import { isValidStoreId } from "../../src/registry/slug";
import { EMPTY_STATE } from "../../src/engine/state";
import { createTimer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { nonEmpty } from "../nonEmpty";

const NUM_RUNS = 200;
const COMMON_KEYS = [
  "storeId",
  "timerId",
  "operationKind",
  "eventTime",
  "slotIds",
  "noodleType",
  "firmness",
] as const;
const KEYS_BY_KIND = {
  "boil-started": [...COMMON_KEYS, "startTime", "endTime"],
  boiled: [...COMMON_KEYS, "endTime", "boiledAt"],
  adjusted: [...COMMON_KEYS, "endTime"],
  completed: COMMON_KEYS,
  cancelled: COMMON_KEYS,
} satisfies Record<OperationRecord["operationKind"], readonly string[]>;
const genText = fc.string({ minLength: 1, maxLength: 16 });
const genStoreId = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-"), {
    minLength: 1,
    maxLength: 64,
  })
  .map((chars) => chars.join(""));
const genObservation = fc
  .record({
    storeId: genStoreId,
    eventTime: fc.integer({ min: 1, max: 2_000_000_000_000 }),
    eventKind: fc.constantFrom<OperationObservation["eventKind"]>(
      "Start",
      "Adjust",
      "Complete",
      "Cancel",
      "AlarmFired",
      "Reconcile",
    ),
    timerId: genText,
    slotIds: fc.array(genText, { minLength: 1, maxLength: 4 }),
    noodleType: genText,
    firmness: fc.constantFrom(...FIRMNESS_ORDER),
    startTime: fc.integer({ min: 1, max: 1_000_000_000_000 }),
    duration: fc.integer({ min: 1, max: 1_000_000 }),
  })
  .map((seed): OperationObservation => {
    const timer = createTimer({
      id: seed.timerId as TimerId,
      slotIds: nonEmpty(seed.slotIds.map((id) => id as SlotId)),
      noodleType: seed.noodleType as NoodleType,
      firmness: seed.firmness,
      startTime: seed.startTime as EpochMillis,
      endTime: (seed.startTime + seed.duration) as EpochMillis,
      seq: 7,
    });
    const empty = { ...EMPTY_STATE, timers: [], nextSeq: 8 } as const;
    const populated = { ...EMPTY_STATE, timers: [timer], nextSeq: 8 } as const;
    if (seed.eventKind === "Start")
      return {
        storeId: seed.storeId,
        eventTime: seed.eventTime,
        eventKind: seed.eventKind,
        before: empty,
        after: populated,
      };
    if (seed.eventKind === "Complete" || seed.eventKind === "Cancel")
      return {
        storeId: seed.storeId,
        eventTime: seed.eventTime,
        eventKind: seed.eventKind,
        before: populated,
        after: empty,
      };
    const changed = createTimer({
      ...timer,
      firmness: seed.firmness === "normal" ? "hard" : "normal",
      boiledAt: seed.eventTime as EpochMillis,
    });
    return {
      storeId: seed.storeId,
      eventTime: seed.eventTime,
      eventKind: seed.eventKind,
      before: populated,
      after: { ...EMPTY_STATE, timers: [changed], nextSeq: 8 },
    };
  });

function expectPositiveEpoch(value: number): void {
  expect(Number.isSafeInteger(value)).toBe(true);
  expect(value).toBeGreaterThan(0);
}

describe("Property 2: Operation Record schema の閉包", () => {
  // **Validates: Requirements 2.16, 2.17, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**
  it("kind 別の既知属性と値制約だけを持ち、自然人属性・連番・追加導出値を持たない", () => {
    fc.assert(
      fc.property(genObservation, (observation) => {
        const records = recordsFromCommittedDiff(observation);
        expect(records).toHaveLength(1);
        const record = records[0];
        expect(record).toBeDefined();
        if (record === undefined) return;

        expect(Object.keys(record).toSorted()).toEqual(
          [...KEYS_BY_KIND[record.operationKind]].toSorted(),
        );
        expect(isValidStoreId(record.storeId)).toBe(true);
        expect(record.timerId.length).toBeGreaterThan(0);
        expect(record.slotIds.length).toBeGreaterThan(0);
        expect(record.slotIds.every((slotId) => slotId.length > 0)).toBe(true);
        expect(record.noodleType.length).toBeGreaterThan(0);
        expect(isFirmness(record.firmness)).toBe(true);
        expectPositiveEpoch(record.eventTime);
        if ("startTime" in record) expectPositiveEpoch(record.startTime);
        if ("endTime" in record) expectPositiveEpoch(record.endTime);
        if ("boiledAt" in record) expectPositiveEpoch(record.boiledAt);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
