import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FIRMNESS_ORDER } from "../../src/domain/firmness";
import { printCanonicalOperationLines } from "../../src/operation-history/codec";
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
  fc
    .string({ unit: "grapheme", minLength: 1, maxLength: 12 })
    .filter((value) => !value.includes("\uFEFF")),
);
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

function canonicalAttributes(record: OperationRecord): Record<string, unknown> {
  const common = {
    storeId: record.storeId,
    timerId: record.timerId,
    operationKind: record.operationKind,
    eventTime: record.eventTime,
    slotIds: [...record.slotIds],
    noodleType: record.noodleType,
    firmness: record.firmness,
  };
  if (record.operationKind === "boil-started")
    return { ...common, startTime: record.startTime, endTime: record.endTime };
  if (record.operationKind === "boiled")
    return { ...common, endTime: record.endTime, boiledAt: record.boiledAt };
  if (record.operationKind === "adjusted") return { ...common, endTime: record.endTime };
  return common;
}

describe("Property 3: Canonical printer の一意性", () => {
  // **Validates: Requirements 3.8, 3.9, 3.10, 3.11**
  it("既知属性だけを標準 JSON 表記の一行へ固定順で写し、record と slotIds の順序を保つ", () => {
    fc.assert(
      fc.property(fc.array(genRecord, { maxLength: 8 }), (records) => {
        const expectedLines = records.map((record) => JSON.stringify(canonicalAttributes(record)));
        const text = printCanonicalOperationLines(records);
        const lines = records.length === 0 ? [] : text.split("\n");
        expect(text).toBe(expectedLines.join("\n"));
        expect((text.match(/\n/g) ?? []).length).toBe(Math.max(0, records.length - 1));
        expect(lines.every((line) => !line.includes("\r") && !line.includes("\uFEFF"))).toBe(true);
        expect(lines.map((line) => Object.keys(JSON.parse(line)))).toEqual(
          records.map((record) => Object.keys(canonicalAttributes(record))),
        );
        expect(lines.map((line) => JSON.parse(line))).toEqual(records);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
