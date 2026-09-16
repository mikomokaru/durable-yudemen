// 物理契約の性質。写像した行は必ず送信前の検査を通り、列を一つでも崩せばその列名で落ちる。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ARRIVAL_FIELDS,
  operationArrival,
  validateArrival,
  type TailObservation,
} from "../../src/data-platform/arrival";
import { printCanonicalOperationLine } from "../../src/operation-history/codec";
import type { OperationRecord } from "../../src/operation-history/record";

const NUM_RUNS = 100;

const timestamp = (value: number): OperationRecord["eventTime"] =>
  value as OperationRecord["eventTime"];

const genEpochMs = fc.integer({ min: 1, max: 4_102_444_800_000 }).map(timestamp);
const genStoreId = fc
  .stringMatching(/^[a-z0-9-]{1,64}$/)
  .filter((value) => value.length > 0 && value.length <= 64);
const genNonEmpty = fc.string({ minLength: 1, maxLength: 32 }).filter((value) => value.length > 0);

const genRecord: fc.Arbitrary<OperationRecord> = fc
  .record({
    storeId: genStoreId,
    timerId: genNonEmpty,
    eventTime: genEpochMs,
    slotIds: fc.array(genNonEmpty, { minLength: 1, maxLength: 4 }),
    noodleType: genNonEmpty,
    firmness: fc.constantFrom("extraHard", "hard", "normal", "soft" as const),
    endTime: genEpochMs,
    boiledAt: genEpochMs,
    startTime: genEpochMs,
    kind: fc.constantFrom("boil-started", "boiled", "adjusted", "completed", "cancelled" as const),
  })
  .map((raw) => {
    const common = {
      storeId: raw.storeId,
      timerId: raw.timerId,
      eventTime: raw.eventTime,
      slotIds: [raw.slotIds[0]!, ...raw.slotIds.slice(1)] as const,
      noodleType: raw.noodleType,
      firmness: raw.firmness,
    };
    switch (raw.kind) {
      case "boil-started":
        return {
          ...common,
          operationKind: "boil-started",
          startTime: raw.startTime,
          endTime: raw.endTime,
        };
      case "boiled":
        return { ...common, operationKind: "boiled", endTime: raw.endTime, boiledAt: raw.boiledAt };
      case "adjusted":
        return { ...common, operationKind: "adjusted", endTime: raw.endTime };
      case "completed":
        return { ...common, operationKind: "completed" };
      case "cancelled":
        return { ...common, operationKind: "cancelled" };
    }
  });

const genObservation: fc.Arbitrary<TailObservation> = fc.record({
  arrivalId: fc.uuid(),
  observedAt: fc.integer({ min: 1, max: 4_102_444_800_000 }),
  producerScript: fc.constantFrom("yude-men-timer", "yude-men-history-probe"),
  truncation: fc.constantFrom("detected", "not-detected", "unknown" as const),
  probeId: fc.oneof(fc.constant(null), genNonEmpty),
});

const requiredColumns = ARRIVAL_FIELDS.filter((field) => field.required).map((field) => field.name);

describe("物理契約の性質", () => {
  it("妥当な記録から写した行は必ず検査を通り、原文と原時刻を保つ", () => {
    fc.assert(
      fc.property(genRecord, genObservation, (record, observation) => {
        const canonical = printCanonicalOperationLine(record);
        const checked = validateArrival(operationArrival(record, canonical, observation));

        expect(checked.ok).toBe(true);
        if (!checked.ok) return;
        expect(checked.arrival.canonicalPayload).toBe(canonical);
        expect(checked.arrival.eventTime).toBe(record.eventTime);
        expect(checked.arrival.observedAt).toBe(observation.observedAt);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("必須列を落とすと、その列名で欠落として落ちる", () => {
    fc.assert(
      fc.property(
        genRecord,
        genObservation,
        fc.constantFrom(...requiredColumns),
        (record, observation, column) => {
          const row: Record<string, unknown> = {
            ...operationArrival(record, printCanonicalOperationLine(record), observation),
          };
          delete row[column];

          expect(validateArrival(row)).toEqual({
            ok: false,
            rejection: { reason: "missing-column", column },
          });
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("未知の列を足すとその名前で落ちる", () => {
    fc.assert(
      fc.property(
        genRecord,
        genObservation,
        genNonEmpty.filter(
          (name) => !ARRIVAL_FIELDS.some((field) => (field.name as string) === name),
        ),
        (record, observation, column) => {
          const row = {
            ...operationArrival(record, printCanonicalOperationLine(record), observation),
            [column]: "x",
          };

          expect(validateArrival(row)).toEqual({
            ok: false,
            rejection: { reason: "unknown-column", column },
          });
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
