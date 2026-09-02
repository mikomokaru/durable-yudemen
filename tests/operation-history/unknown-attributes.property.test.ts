import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FIRMNESS_ORDER } from "../../src/domain/firmness";
import {
  parseOperationLines,
  printCanonicalOperationLine,
} from "../../src/operation-history/codec";
import type { OperationRecord } from "../../src/operation-history/record";
import { nonEmpty } from "../nonEmpty";

const NUM_RUNS = 200;
const KNOWN_ATTRIBUTES = new Set([
  "storeId",
  "timerId",
  "operationKind",
  "eventTime",
  "slotIds",
  "noodleType",
  "firmness",
  "startTime",
  "endTime",
  "boiledAt",
]);
const timestamp = (value: number): OperationRecord["eventTime"] =>
  value as OperationRecord["eventTime"];
const genTimestamp = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
const genText = fc.string({ minLength: 1, maxLength: 16 });
const genCommon = fc
  .record({
    storeId: fc
      .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-"), {
        minLength: 1,
        maxLength: 64,
      })
      .map((characters) => characters.join("")),
    timerId: genText,
    eventTime: genTimestamp,
    slotIds: fc.array(genText, { minLength: 1, maxLength: 4 }),
    noodleType: genText,
    firmness: fc.constantFrom(...FIRMNESS_ORDER),
  })
  .map((record) => ({
    ...record,
    eventTime: timestamp(record.eventTime),
    slotIds: nonEmpty(record.slotIds),
  }));
const genRecord: fc.Arbitrary<OperationRecord> = genCommon.chain((common) =>
  fc.oneof(
    fc.record({ startTime: genTimestamp, endTime: genTimestamp }).map(
      ({ startTime, endTime }) =>
        ({
          ...common,
          operationKind: "boil-started",
          startTime: timestamp(startTime),
          endTime: timestamp(endTime),
        }) as const,
    ),
    fc.record({ endTime: genTimestamp, boiledAt: genTimestamp }).map(
      ({ endTime, boiledAt }) =>
        ({
          ...common,
          operationKind: "boiled",
          endTime: timestamp(endTime),
          boiledAt: timestamp(boiledAt),
        }) as const,
    ),
    genTimestamp.map(
      (endTime) => ({ ...common, operationKind: "adjusted", endTime: timestamp(endTime) }) as const,
    ),
    fc.constant({ ...common, operationKind: "completed" } as const),
    fc.constant({ ...common, operationKind: "cancelled" } as const),
  ),
);
const genUnknownName = fc.string({ maxLength: 32 }).filter((name) => !KNOWN_ATTRIBUTES.has(name));

describe("Property 4: 未知属性に対する既知意味の不変性", () => {
  // **Validates: Requirements 3.12**
  it("任意の未知属性を追加しても既知属性値と slotIds 順を保つ", () => {
    fc.assert(
      fc.property(
        genRecord,
        genUnknownName,
        fc.jsonValue(),
        (record, unknownName, unknownValue) => {
          const canonicalLine = printCanonicalOperationLine(record);
          const lineWithUnknown = `{${JSON.stringify(unknownName)}:${JSON.stringify(unknownValue)},${canonicalLine.slice(1)}`;
          const before = parseOperationLines(canonicalLine);
          const after = parseOperationLines(lineWithUnknown);

          expect(before).toEqual([{ ok: true, record }]);
          expect(after).toEqual(before);
          expect(after[0]?.ok && after[0].record.slotIds).toEqual(record.slotIds);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
