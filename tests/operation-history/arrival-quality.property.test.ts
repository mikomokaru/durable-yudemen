import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FIRMNESS_ORDER } from "../../src/domain/firmness";
import { operationArrivalQualityFromEvidence } from "../../src/operation-history/correlation";
import type { OperationRecord } from "../../src/operation-history/record";
import { nonEmpty } from "../nonEmpty";

const NUM_RUNS = 200;
const timestamp = (value: number): OperationRecord["eventTime"] =>
  value as OperationRecord["eventTime"];
const genText = fc.string({ minLength: 1, maxLength: 12 });
const genTimestamp = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
const genCommon = fc.record({
  storeId: genText,
  timerId: genText,
  eventTime: genTimestamp,
  slotIds: fc.array(genText, { minLength: 1, maxLength: 4 }),
  noodleType: genText,
  firmness: fc.constantFrom(...FIRMNESS_ORDER),
}).map((common) => ({
  ...common,
  eventTime: timestamp(common.eventTime),
  slotIds: nonEmpty(common.slotIds),
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

type Evidence = Parameters<typeof operationArrivalQualityFromEvidence>[0][number];

type Scenario = Readonly<{
  arrivals: readonly Evidence[];
  baseRecord: OperationRecord;
  baseArrivalCount: number;
  missingRecord?: OperationRecord;
  orphanArrival?: Evidence;
  conflictArrivals: readonly Evidence[];
  recoverableStarts: readonly Pick<OperationRecord, "storeId" | "timerId">[];
}>;

function completedFrom(
  record: OperationRecord,
  timerSuffix: string,
  noodleType = record.noodleType,
): OperationRecord {
  return {
    storeId: record.storeId,
    timerId: `${record.timerId}${timerSuffix}`,
    operationKind: "completed",
    eventTime: record.eventTime,
    slotIds: record.slotIds,
    noodleType,
    firmness: record.firmness,
  };
}

const genScenario: fc.Arbitrary<Scenario> = fc.record({
  baseRecord: genRecord,
  baseArrivalCount: fc.integer({ min: 1, max: 8 }),
  includeMissing: fc.boolean(),
  includeOrphan: fc.boolean(),
  includeConflict: fc.boolean(),
  orderSeed: fc.integer(),
}).map(({
  baseRecord,
  baseArrivalCount,
  includeMissing,
  includeOrphan,
  includeConflict,
  orderSeed,
}) => {
  const baseArrivals = Array.from({ length: baseArrivalCount }, (_, index): Evidence => ({
    record: { ...baseRecord } as OperationRecord,
    canonicalHash: `base-${index}`,
    traceMetadata: { arrivalId: `base-${index}` },
  }));
  const orphanArrival = includeOrphan
    ? { record: completedFrom(baseRecord, "\u0000orphan"), canonicalHash: "orphan" }
    : undefined;
  const conflictRecord = completedFrom(baseRecord, "\u0000conflict");
  const conflictArrivals = includeConflict
    ? [
        { record: conflictRecord, canonicalHash: "conflict-a" },
        {
          record: { ...conflictRecord, noodleType: `${conflictRecord.noodleType}\u0000other` },
          canonicalHash: "conflict-b",
        },
      ] satisfies Evidence[]
    : [];
  const unordered = [
    ...baseArrivals,
    ...(orphanArrival === undefined ? [] : [orphanArrival]),
    ...conflictArrivals,
  ];
  const arrivals = unordered
    .map((arrival, index) => ({
      arrival,
      rank: ((index + 1) * (orderSeed | 1)) % (unordered.length + 1),
      index,
    }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ arrival }) => arrival);

  return {
    arrivals,
    baseRecord,
    baseArrivalCount,
    ...(includeMissing ? { missingRecord: completedFrom(baseRecord, "\u0000missing") } : {}),
    ...(orphanArrival === undefined ? {} : { orphanArrival }),
    conflictArrivals,
    recoverableStarts: [
      { storeId: baseRecord.storeId, timerId: baseRecord.timerId },
      ...(includeConflict
        ? [{ storeId: conflictRecord.storeId, timerId: conflictRecord.timerId }]
        : []),
    ],
  };
});

function timerIdentity(record: OperationRecord): string {
  return JSON.stringify([record.storeId, record.timerId]);
}

describe("Property 8: 重複収束と品質状態", () => {
  // **Validates: Requirements 5.5, 5.6, 5.7**
  it("raw arrival を不変に保ち、同一 record を一件へ収束して四品質状態を分離する", () => {
    fc.assert(
      fc.property(genScenario, (scenario) => {
        const before = structuredClone(scenario.arrivals);
        const inputReferences = [...scenario.arrivals];
        const expectedRecords = scenario.missingRecord === undefined
          ? [scenario.baseRecord]
          : [scenario.baseRecord, scenario.missingRecord];

        const result = operationArrivalQualityFromEvidence(
          scenario.arrivals,
          expectedRecords,
          scenario.recoverableStarts,
        );
        const baseArrivals = scenario.arrivals.filter(({ record }) =>
          timerIdentity(record) === timerIdentity(scenario.baseRecord)
        );
        const baseConvergences = result.convergedRecords.filter(({ analysisRecord }) =>
          timerIdentity(analysisRecord) === timerIdentity(scenario.baseRecord)
        );

        expect(baseConvergences).toHaveLength(1);
        expect(baseConvergences[0]).toMatchObject({
          analysisRecord: baseArrivals[0]!.record,
          arrivalCount: scenario.baseArrivalCount,
          duplicateCount: scenario.baseArrivalCount - 1,
        });
        expect(baseConvergences[0]!.rawArrivals).toEqual(baseArrivals);

        expect(result.quality.missing).toEqual(
          scenario.missingRecord === undefined ? [] : [scenario.missingRecord],
        );
        expect(result.quality.orphan).toEqual(
          scenario.orphanArrival === undefined ? [] : [[scenario.orphanArrival]],
        );
        expect(result.quality.conflict).toEqual(
          scenario.conflictArrivals.length === 0
            ? []
            : [scenario.arrivals.filter((arrival) =>
                scenario.conflictArrivals.includes(arrival)
              )],
        );
        expect(result.quality.duplicate).toEqual(
          scenario.baseArrivalCount === 1 ? [] : [baseArrivals],
        );

        expect(result.rawArrivals).toBe(scenario.arrivals);
        expect(scenario.arrivals).toEqual(before);
        expect(result.rawArrivals).toHaveLength(inputReferences.length);
        inputReferences.forEach((arrival, index) => {
          expect(result.rawArrivals[index]).toBe(arrival);
        });
        const convergedRaw = result.convergedRecords.flatMap(({ rawArrivals }) => rawArrivals);
        expect(convergedRaw).toHaveLength(inputReferences.length);
        for (const arrival of inputReferences) {
          expect(convergedRaw.filter((candidate) => candidate === arrival)).toHaveLength(1);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
