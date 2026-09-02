type QualityRateName = "lifecycleMissingRate" | "duplicateRate" | "orphanRate" | "conflictRate";

type QualityRate =
  | Readonly<{
      status: "calculated";
      numerator: number;
      denominator: number;
      value: number;
    }>
  | Readonly<{
      status: "not-calculable";
      numerator: number;
      denominator: 0;
      reason: "denominator-is-zero";
    }>;

type QualityExclusion = Readonly<{
  qualityRate: QualityRateName;
  rate: QualityRate;
  threshold: number;
  reason: "rate-not-calculable" | "threshold-exceeded";
}>;

const qualityRateNames = [
  "lifecycleMissingRate",
  "duplicateRate",
  "orphanRate",
  "conflictRate",
] as const satisfies readonly QualityRateName[];

function qualityRate(numerator: number, denominator: number): QualityRate {
  return denominator === 0
    ? { status: "not-calculable", numerator, denominator, reason: "denominator-is-zero" }
    : { status: "calculated", numerator, denominator, value: numerator / denominator };
}

/** Requirements 5.9〜5.15 の集計定義から、信頼判定と表示根拠を純粋に導く。 */
export function operationQualityAssessmentFromCounts(
  input: Readonly<{
    storeId: string;
    period: string;
    counts: Readonly<{
      expectedLifecycleRecordCount: number;
      missingLifecycleRecordCount: number;
      arrivalCount: number;
      duplicateArrivalCount: number;
      convergedRecordCount: number;
      orphanRecordCount: number;
      primaryCandidateCount: number;
      conflictingPrimaryCandidateCount: number;
    }>;
    thresholds: Readonly<Record<QualityRateName, number>>;
  }>,
) {
  const rates = {
    lifecycleMissingRate: qualityRate(
      input.counts.missingLifecycleRecordCount,
      input.counts.expectedLifecycleRecordCount,
    ),
    duplicateRate: qualityRate(input.counts.duplicateArrivalCount, input.counts.arrivalCount),
    orphanRate: qualityRate(input.counts.orphanRecordCount, input.counts.convergedRecordCount),
    conflictRate: qualityRate(
      input.counts.conflictingPrimaryCandidateCount,
      input.counts.primaryCandidateCount,
    ),
  } satisfies Readonly<Record<QualityRateName, QualityRate>>;

  const exclusions: QualityExclusion[] = [];
  for (const qualityRateName of qualityRateNames) {
    const rate = rates[qualityRateName];
    const threshold = input.thresholds[qualityRateName];
    if (rate.status === "not-calculable") {
      exclusions.push({
        qualityRate: qualityRateName,
        rate,
        threshold,
        reason: "rate-not-calculable",
      });
    } else if (rate.value > threshold) {
      exclusions.push({
        qualityRate: qualityRateName,
        rate,
        threshold,
        reason: "threshold-exceeded",
      });
    }
  }

  return {
    analysisDisclosure: {
      storeId: input.storeId,
      period: input.period,
      basis: "Observed telemetry",
      estimation: "best-effort",
      display: "Best-effort estimate based on Observed telemetry",
    },
    rates,
    trustedAnalysis:
      exclusions.length === 0
        ? { status: "included" as const }
        : { status: "excluded" as const, exclusions: exclusions as readonly QualityExclusion[] },
    consoleLogCompleteMissingRate: {
      status: "unmeasurable" as const,
      reason: "producer-telemetry-total-unobservable" as const,
      distinctFrom: "lifecycleMissingRate" as const,
      display:
        "Unmeasurable: Producer telemetry total is not observable; distinct from lifecycle missing rate",
    },
  };
}
