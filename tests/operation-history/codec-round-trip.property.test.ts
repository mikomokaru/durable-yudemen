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
const timestamp = (value: number): OperationRecord["eventTime"] =>
  value as OperationRecord["eventTime"];
const genTimestamp = fc.oneof(
  fc.constant(1),
  fc.constant(Number.MAX_SAFE_INTEGER),
  fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
);
const genText = fc.oneof(
  fc.constantFrom('"', "\\", "\n", "\r", "\t", "\u0000", "日本語", "😀", " "),
  fc.string({ unit: "grapheme", minLength: 1, maxLength: 12 }),
);
const genCommon = fc.record({
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
}).map((record) => ({
  ...record,
  eventTime: timestamp(record.eventTime),
  slotIds: nonEmpty(record.slotIds),
}));
const genRecord: fc.Arbitrary<OperationRecord> = genCommon.chain((common) =>
  fc.oneof(
    fc.record({ startTime: genTimestamp, endTime: genTimestamp }).map(
      ({ startTime, endTime }) => ({
        ...common,
        operationKind: "boil-started",
        startTime: timestamp(startTime),
        endTime: timestamp(endTime),
      }) as const,
    ),
    fc.record({ endTime: genTimestamp, boiledAt: genTimestamp }).map(
      ({ endTime, boiledAt }) => ({
        ...common,
        operationKind: "boiled",
        endTime: timestamp(endTime),
        boiledAt: timestamp(boiledAt),
      }) as const,
    ),
    genTimestamp.map((endTime) => ({
      ...common,
      operationKind: "adjusted",
      endTime: timestamp(endTime),
    }) as const),
    fc.constant({ ...common, operationKind: "completed" } as const),
    fc.constant({ ...common, operationKind: "cancelled" } as const),
  ),
);

describe("Property 6: Codec round-trip", () => {
  // **Validates: Requirements 3.18, 3.19**
  it("有効 record と canonical line を既知属性値・slotIds 順・UTF-8 bytes を保って往復する", () => {
    fc.assert(fc.property(genRecord, (record) => {
      const canonicalLine = printCanonicalOperationLine(record);
      const [parsed] = parseOperationLines(canonicalLine);

      expect(parsed).toEqual({ ok: true, record });
      if (parsed?.ok !== true) return;

      expect(printCanonicalOperationLine(parsed.record)).toBe(canonicalLine);
      expect(new TextEncoder().encode(printCanonicalOperationLine(parsed.record)))
        .toEqual(new TextEncoder().encode(canonicalLine));
    }), { numRuns: NUM_RUNS });
  });
});
