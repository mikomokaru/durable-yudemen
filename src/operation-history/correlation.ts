import type { OperationRecord } from "./record";

type TraceMetadata = Readonly<Record<string, unknown>>;
type OperationEvidence = Readonly<{
  record: OperationRecord;
  canonicalHash?: string;
  traceMetadata?: TraceMetadata;
}>;
type PrimaryCandidate = Pick<
  OperationRecord,
  "storeId" | "timerId" | "operationKind" | "eventTime"
>;
type CandidateAccumulator = {
  readonly primary: PrimaryCandidate;
  readonly records: OperationRecord[];
  readonly canonicalHashes: string[];
  readonly traceMetadata: TraceMetadata[];
};
type ArrivalConvergence = {
  readonly analysisRecord: OperationRecord;
  readonly rawArrivals: OperationEvidence[];
};

function primaryCandidate(record: OperationRecord): PrimaryCandidate {
  return {
    storeId: record.storeId,
    timerId: record.timerId,
    operationKind: record.operationKind,
    eventTime: record.eventTime,
  };
}

function primaryKey(primary: PrimaryCandidate): string {
  return JSON.stringify([
    primary.storeId,
    primary.timerId,
    primary.operationKind,
    primary.eventTime,
  ]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameTimerFacts(left: OperationRecord, right: OperationRecord): boolean {
  if (
    left.operationKind !== right.operationKind ||
    !sameStrings(left.slotIds, right.slotIds) ||
    left.noodleType !== right.noodleType ||
    left.firmness !== right.firmness
  ) {
    return false;
  }

  switch (left.operationKind) {
    case "boil-started":
      return (
        right.operationKind === "boil-started" &&
        left.startTime === right.startTime &&
        left.endTime === right.endTime
      );
    case "boiled":
      return (
        right.operationKind === "boiled" &&
        left.endTime === right.endTime &&
        left.boiledAt === right.boiledAt
      );
    case "adjusted":
      return right.operationKind === "adjusted" && left.endTime === right.endTime;
    case "completed":
      return right.operationKind === "completed";
    case "cancelled":
      return right.operationKind === "cancelled";
  }
}

/** 一次4属性で候補を作り、record 本体の Timer 事実だけで整合を判定する。 */
export function correlationCandidatesFromOperationEvidence(evidence: readonly OperationEvidence[]) {
  const candidates = new Map<string, CandidateAccumulator>();

  for (const item of evidence) {
    const primary = primaryCandidate(item.record);
    const key = primaryKey(primary);
    const existing = candidates.get(key);
    const candidate = existing ?? {
      primary,
      records: [],
      canonicalHashes: [],
      traceMetadata: [],
    };

    candidate.records.push(item.record);
    if (item.canonicalHash !== undefined) candidate.canonicalHashes.push(item.canonicalHash);
    if (item.traceMetadata !== undefined) candidate.traceMetadata.push(item.traceMetadata);
    if (existing === undefined) candidates.set(key, candidate);
  }

  return [...candidates.values()].map((candidate) => {
    const first = candidate.records[0]!;
    const timerFactsConsistent = candidate.records.every((record) => sameTimerFacts(first, record));

    return {
      primary: candidate.primary,
      records: [...candidate.records] as readonly OperationRecord[],
      timerFactsConsistent,
      ...(timerFactsConsistent
        ? {}
        : {
            ambiguityEvidence: {
              canonicalHashes: [...candidate.canonicalHashes] as readonly string[],
              traceMetadata: [...candidate.traceMetadata] as readonly TraceMetadata[],
            },
          }),
    };
  });
}

function timerKey(record: Pick<OperationRecord, "storeId" | "timerId">): string {
  return JSON.stringify([record.storeId, record.timerId]);
}

/** raw arrival を保持したまま同一事実を収束し、四つの品質状態を独立に残す。 */
export function operationArrivalQualityFromEvidence(
  evidence: readonly OperationEvidence[],
  expectedRecords: readonly OperationRecord[],
  recoverableStarts: readonly Pick<OperationRecord, "storeId" | "timerId">[] = [],
) {
  const candidates = correlationCandidatesFromOperationEvidence(evidence);
  const arrivalsByPrimary = new Map<string, OperationEvidence[]>();

  for (const arrival of evidence) {
    const key = primaryKey(primaryCandidate(arrival.record));
    const arrivals = arrivalsByPrimary.get(key);
    if (arrivals === undefined) arrivalsByPrimary.set(key, [arrival]);
    else arrivals.push(arrival);
  }

  const starts = new Set(recoverableStarts.map(timerKey));
  for (const arrival of evidence) {
    if (arrival.record.operationKind === "boil-started") starts.add(timerKey(arrival.record));
  }

  const observedPrimaryKeys = new Set(candidates.map(({ primary }) => primaryKey(primary)));
  const convergedRecords: {
    readonly analysisRecord: OperationRecord;
    readonly arrivalCount: number;
    readonly duplicateCount: number;
    readonly rawArrivals: readonly OperationEvidence[];
  }[] = [];
  const orphan: (readonly OperationEvidence[])[] = [];
  const conflict: (readonly OperationEvidence[])[] = [];
  const duplicate: (readonly OperationEvidence[])[] = [];

  for (const candidate of candidates) {
    const candidateArrivals = arrivalsByPrimary.get(primaryKey(candidate.primary)) ?? [];
    const convergences: ArrivalConvergence[] = [];

    for (const arrival of candidateArrivals) {
      const convergence = convergences.find(({ analysisRecord }) =>
        sameTimerFacts(analysisRecord, arrival.record),
      );
      if (convergence === undefined) {
        convergences.push({ analysisRecord: arrival.record, rawArrivals: [arrival] });
      } else {
        convergence.rawArrivals.push(arrival);
      }
    }

    if (!candidate.timerFactsConsistent) conflict.push(candidateArrivals);

    for (const convergence of convergences) {
      const result = {
        analysisRecord: convergence.analysisRecord,
        arrivalCount: convergence.rawArrivals.length,
        duplicateCount: convergence.rawArrivals.length - 1,
        rawArrivals: convergence.rawArrivals as readonly OperationEvidence[],
      };
      convergedRecords.push(result);

      if (result.duplicateCount > 0) duplicate.push(result.rawArrivals);
      if (
        result.analysisRecord.operationKind !== "boil-started" &&
        !starts.has(timerKey(result.analysisRecord))
      ) {
        orphan.push(result.rawArrivals);
      }
    }
  }

  return {
    rawArrivals: evidence,
    convergedRecords: convergedRecords as readonly (typeof convergedRecords)[number][],
    quality: {
      missing: expectedRecords.filter(
        (record) => !observedPrimaryKeys.has(primaryKey(primaryCandidate(record))),
      ),
      orphan: orphan as readonly (readonly OperationEvidence[])[],
      conflict: conflict as readonly (readonly OperationEvidence[])[],
      duplicate: duplicate as readonly (readonly OperationEvidence[])[],
    },
  };
}
