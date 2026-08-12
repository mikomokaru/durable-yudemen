import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FIRMNESS_ORDER } from "../../src/domain/firmness";
import { correlationCandidatesFromOperationEvidence } from "../../src/operation-history/correlation";
import type { OperationRecord } from "../../src/operation-history/record";
import { nonEmpty } from "../nonEmpty";

const NUM_RUNS = 200;
const timestamp = (value: number): OperationRecord["eventTime"] =>
  value as OperationRecord["eventTime"];
const genTimestamp = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
const genText = fc.string({ minLength: 1, maxLength: 12 });
const genCommon = fc.record({
  storeId: fc.constantFrom("store-a", "store-b"),
  timerId: fc.constantFrom("timer-1", "timer-2", "timer-3"),
  eventTime: fc.integer({ min: 1, max: 4 }),
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

type Evidence = Parameters<typeof correlationCandidatesFromOperationEvidence>[0][number];
const genTraceMetadata = fc.record({
  traceId: genText,
  scriptName: genText,
  sampled: fc.boolean(),
});
const genEvidence = genRecord.chain((record) =>
  fc.record({
    canonicalHash: fc.option(genText, { nil: undefined }),
    traceMetadata: fc.option(genTraceMetadata, { nil: undefined }),
  }).map(({ canonicalHash, traceMetadata }): Evidence => ({
    record,
    ...(canonicalHash === undefined ? {} : { canonicalHash }),
    ...(traceMetadata === undefined ? {} : { traceMetadata }),
  })),
);
const genEvidenceSet = fc.record({
  base: genEvidence,
  conflictHash: fc.option(genText, { nil: undefined }),
  conflictTrace: fc.option(genTraceMetadata, { nil: undefined }),
  others: fc.array(genEvidence, { maxLength: 20 }),
}).map(({ base, conflictHash, conflictTrace, others }): readonly Evidence[] => [
  base,
  {
    record: { ...base.record, noodleType: `${base.record.noodleType}-conflict` },
    ...(conflictHash === undefined ? {} : { canonicalHash: conflictHash }),
    ...(conflictTrace === undefined ? {} : { traceMetadata: conflictTrace }),
  },
  ...others,
]);

function primaryOf(record: OperationRecord) {
  return {
    storeId: record.storeId,
    timerId: record.timerId,
    operationKind: record.operationKind,
    eventTime: record.eventTime,
  };
}

function primaryKey(record: OperationRecord): string {
  return JSON.stringify([
    record.storeId,
    record.timerId,
    record.operationKind,
    record.eventTime,
  ]);
}

function timerFactKey(record: OperationRecord): string {
  const common = [record.slotIds, record.noodleType, record.firmness];
  switch (record.operationKind) {
    case "boil-started":
      return JSON.stringify([...common, record.startTime, record.endTime]);
    case "boiled":
      return JSON.stringify([...common, record.endTime, record.boiledAt]);
    case "adjusted":
      return JSON.stringify([...common, record.endTime]);
    case "completed":
    case "cancelled":
      return JSON.stringify(common);
  }
}

function identityProjection(evidence: readonly Evidence[]) {
  return correlationCandidatesFromOperationEvidence(evidence).map((candidate) => ({
    primary: candidate.primary,
    records: candidate.records,
    timerFactsConsistent: candidate.timerFactsConsistent,
  }));
}
describe("Property 7: 相関候補の閉じた構成", () => {
  // **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
  it("一次4属性だけで候補を閉じ、Timer 事実の競合と補助 metadata を identity から分離する", () => {
    fc.assert(
      fc.property(genEvidenceSet, (evidence) => {
        const expected = new Map<string, Evidence[]>();
        for (const item of evidence) {
          const key = primaryKey(item.record);
          const group = expected.get(key);
          if (group === undefined) expected.set(key, [item]);
          else group.push(item);
        }

        const candidates = correlationCandidatesFromOperationEvidence(evidence);
        expect(candidates).toHaveLength(expected.size);

        for (const candidate of candidates) {
          expect(Object.keys(candidate.primary)).toEqual([
            "storeId",
            "timerId",
            "operationKind",
            "eventTime",
          ]);
          const group = expected.get(primaryKey(candidate.records[0]!));
          expect(group).toBeDefined();
          if (group === undefined) continue;

          expect(candidate.primary).toEqual(primaryOf(group[0]!.record));
          expect(candidate.records).toEqual(group.map(({ record }) => record));
          expect(candidate.records.every((record) =>
            primaryKey(record) === primaryKey(group[0]!.record)
          )).toBe(true);

          const factKeys = new Set(group.map(({ record }) => timerFactKey(record)));
          const timerFactsConsistent = factKeys.size === 1;
          expect(candidate.timerFactsConsistent).toBe(timerFactsConsistent);
          if (timerFactsConsistent) {
            expect(candidate).not.toHaveProperty("ambiguityEvidence");
          } else {
            expect(candidate).toMatchObject({
              ambiguityEvidence: {
                canonicalHashes: group.flatMap(({ canonicalHash }) =>
                  canonicalHash === undefined ? [] : [canonicalHash]
                ),
                traceMetadata: group.flatMap(({ traceMetadata }) =>
                  traceMetadata === undefined ? [] : [traceMetadata]
                ),
              },
            });
          }
        }

        const withoutMetadata = evidence.map(({ record }) => ({ record }));
        expect(identityProjection(evidence)).toEqual(identityProjection(withoutMetadata));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});