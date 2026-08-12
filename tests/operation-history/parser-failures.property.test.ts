import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FIRMNESS_ORDER } from "../../src/domain/firmness";
import {
  parseOperationLines,
  type OperationLineFailure,
} from "../../src/operation-history/codec";
import type { OperationRecord } from "../../src/operation-history/record";
import { nonEmpty } from "../nonEmpty";

const NUM_RUNS = 200;
const COMMON_ATTRIBUTES = [
  "storeId", "timerId", "operationKind", "eventTime", "slotIds", "noodleType", "firmness",
] as const;
const KNOWN_ATTRIBUTES = [
  ...COMMON_ATTRIBUTES, "startTime", "endTime", "boiledAt",
] as const;
const timestamp = (value: number): OperationRecord["eventTime"] => value as OperationRecord["eventTime"];
const genText = fc.string({ minLength: 1, maxLength: 16 });
const genTimestamp = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
const genCommon = fc.record({
  storeId: fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-"), { minLength: 1, maxLength: 64 })
    .map((characters) => characters.join("")),
  timerId: genText,
  eventTime: genTimestamp,
  slotIds: fc.array(genText, { minLength: 1, maxLength: 4 }),
  noodleType: genText,
  firmness: fc.constantFrom(...FIRMNESS_ORDER),
});

type CommonSeed = typeof genCommon extends fc.Arbitrary<infer Value> ? Value : never;
type ExpectedLine =
  | { readonly ok: true; readonly record: OperationRecord }
  | { readonly ok: false; readonly failure: OperationLineFailure };
type GeneratedLine = { readonly line: string; readonly expected: ExpectedLine };
type JsonMember = readonly [name: string, value: unknown];

function jsonObject(members: readonly JsonMember[]): string {
  return `{${members.map(([name, value]) => `${JSON.stringify(name)}:${JSON.stringify(value)}`).join(",")}}`;
}

function commonMembers(seed: CommonSeed, overrides: Readonly<Record<string, unknown>> = {}): JsonMember[] {
  return COMMON_ATTRIBUTES.map((name) => [
    name,
    overrides[name] ?? (name === "operationKind" ? "completed" : seed[name]),
  ] as const);
}
function validLine(seed: CommonSeed): GeneratedLine {
  const record = {
    ...seed,
    operationKind: "completed",
    eventTime: timestamp(seed.eventTime),
    slotIds: nonEmpty(seed.slotIds),
  } satisfies OperationRecord;
  return { line: jsonObject(commonMembers(seed, { operationKind: "completed" })), expected: { ok: true, record } };
}

const genValidLine = genCommon.map(validLine);
const genInvalidJsonLine = genCommon.map((seed): GeneratedLine => ({
  line: jsonObject([
    ["storeId", seed.storeId],
    ["storeId", seed.storeId],
    ["operationKind", "completed"],
  ]).slice(0, -1),
  expected: { ok: false, failure: "invalid-json" },
}));

const genDuplicateLine = genCommon.chain((seed) => fc.constantFrom(...KNOWN_ATTRIBUTES).map((duplicate): GeneratedLine => {
  const values: Record<(typeof KNOWN_ATTRIBUTES)[number], unknown> = {
    storeId: "INVALID",
    timerId: seed.timerId,
    operationKind: "completed",
    eventTime: "wrong-type",
    slotIds: seed.slotIds,
    noodleType: seed.noodleType,
    firmness: seed.firmness,
    startTime: seed.eventTime,
    endTime: seed.eventTime,
    boiledAt: seed.eventTime,
  };
  const missing = COMMON_ATTRIBUTES.find((name) => name !== duplicate)!;
  const members: JsonMember[] = COMMON_ATTRIBUTES
    .filter((name) => name !== missing)
    .map((name) => [name, values[name]] as const);
  if (!COMMON_ATTRIBUTES.includes(duplicate as (typeof COMMON_ATTRIBUTES)[number])) {
    members.push([duplicate, values[duplicate]]);
  }
  members.push([duplicate, values[duplicate]]);
  if (duplicate !== "endTime") members.push(["endTime", values.endTime]);
  return {
    line: jsonObject(members),
    expected: { ok: false, failure: "duplicate-known-attribute" },
  };
}));

const genMissingLine = genCommon.map((seed): GeneratedLine => ({
  line: jsonObject([
    ["operationKind", "completed"],
    ["eventTime", "wrong-type"],
    ["endTime", seed.eventTime],
  ]),
  expected: { ok: false, failure: "missing-required-attribute" },
}));
const genDisallowedLine = genCommon.map((seed): GeneratedLine => ({
  line: jsonObject([
    ...commonMembers(seed, {
      storeId: "INVALID",
      operationKind: "completed",
      eventTime: "wrong-type",
    }),
    ["endTime", 0],
  ]),
  expected: { ok: false, failure: "disallowed-operation-kind-attribute" },
}));

const genTypeLine = genCommon.map((seed): GeneratedLine => ({
  line: jsonObject(commonMembers(seed, {
    storeId: "INVALID",
    operationKind: "completed",
    eventTime: "wrong-type",
  })),
  expected: { ok: false, failure: "known-attribute-type" },
}));

const genValueLine = genCommon.map((seed): GeneratedLine => ({
  line: jsonObject(commonMembers(seed, {
    storeId: "INVALID",
    timerId: "",
    operationKind: "completed",
    eventTime: 0,
    slotIds: [],
    noodleType: "",
    firmness: "unknown",
  })),
  expected: { ok: false, failure: "known-attribute-value" },
}));

const genLineMatrix = fc.tuple(
  genValidLine,
  genInvalidJsonLine,
  genDuplicateLine,
  genMissingLine,
  genDisallowedLine,
  genTypeLine,
  genValueLine,
  genValidLine,
).chain(([valid, invalidJson, duplicate, missing, disallowed, type, value, trailingValid]) =>
  fc.shuffledSubarray(
    [valid, invalidJson, duplicate, missing, disallowed, type, value],
    { minLength: 7, maxLength: 7 },
  ).map((shuffled) => [...shuffled, trailingValid]),
);

describe("Property 5: 行 parser の失敗分類と継続性", () => {
  // **Validates: Requirements 3.13, 3.14, 3.15, 3.16, 3.17**
  it("六種の失敗を優先分類し、各行の結果と1始まり行番号を入力順に保つ", () => {
    fc.assert(fc.property(genLineMatrix, (rows) => {
      const expected = rows.map(({ expected: lineExpected }, index) => lineExpected.ok
        ? lineExpected
        : { ...lineExpected, lineNumber: index + 1 });
      const actual = parseOperationLines(rows.map(({ line }) => line).join("\n"));

      expect(actual).toHaveLength(rows.length);
      expect(actual).toEqual(expected);
      expect(actual.at(-1)).toEqual(rows.at(-1)?.expected);
    }), { numRuns: NUM_RUNS });
  });
});
