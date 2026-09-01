import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { operationQualityAssessmentFromCounts } from "../../src/operation-history/quality";

const NUM_RUNS = 200;
const qualityRateNames = [
  "lifecycleMissingRate",
  "duplicateRate",
  "orphanRate",
  "conflictRate",
] as const;

const genRateCounts = fc.oneof(
  fc.constant({ numerator: 0, denominator: 0 }),
  fc.integer({ min: 1, max: 1_000_000 }).chain((denominator) =>
    fc.integer({ min: 0, max: denominator }).map((numerator) => ({
      numerator,
      denominator,
    })),
  ),
);
const genThresholds = fc.record({
  lifecycleMissingRate: fc.double({ min: 0, max: 1, noNaN: true }),
  duplicateRate: fc.double({ min: 0, max: 1, noNaN: true }),
  orphanRate: fc.double({ min: 0, max: 1, noNaN: true }),
  conflictRate: fc.double({ min: 0, max: 1, noNaN: true }),
});
const genScenario = fc.record({
  lifecycleMissingRate: genRateCounts,
  duplicateRate: genRateCounts,
  orphanRate: genRateCounts,
  conflictRate: genRateCounts,
  thresholds: genThresholds,
});

describe("Property 9: 品質率と信頼判定", () => {
  // **Validates: Requirements 5.9, 5.10, 5.11, 5.12, 5.13, 5.15**
  it("四品質率を定義どおり算出し、全率が算出可能かつ閾値以下の場合だけ信頼済みに含める", () => {
    fc.assert(
      fc.property(genScenario, (scenario) => {
        const counts = {
          expectedLifecycleRecordCount: scenario.lifecycleMissingRate.denominator,
          missingLifecycleRecordCount: scenario.lifecycleMissingRate.numerator,
          arrivalCount: scenario.duplicateRate.denominator,
          duplicateArrivalCount: scenario.duplicateRate.numerator,
          convergedRecordCount: scenario.orphanRate.denominator,
          orphanRecordCount: scenario.orphanRate.numerator,
          primaryCandidateCount: scenario.conflictRate.denominator,
          conflictingPrimaryCandidateCount: scenario.conflictRate.numerator,
        };
        const result = operationQualityAssessmentFromCounts({
          storeId: "store-property",
          period: "generated-period",
          counts,
          thresholds: scenario.thresholds,
        });

        const generatedCounts = {
          lifecycleMissingRate: scenario.lifecycleMissingRate,
          duplicateRate: scenario.duplicateRate,
          orphanRate: scenario.orphanRate,
          conflictRate: scenario.conflictRate,
        };
        const expectedExclusions: Array<{
          qualityRate: (typeof qualityRateNames)[number];
          rate: (typeof result.rates)[(typeof qualityRateNames)[number]];
          threshold: number;
          reason: "rate-not-calculable" | "threshold-exceeded";
        }> = [];
        for (const qualityRate of qualityRateNames) {
          const { numerator, denominator } = generatedCounts[qualityRate];
          const threshold = scenario.thresholds[qualityRate];
          const rate = result.rates[qualityRate];

          if (denominator === 0) {
            expect(rate).toEqual({
              status: "not-calculable",
              numerator,
              denominator: 0,
              reason: "denominator-is-zero",
            });
            expectedExclusions.push({
              qualityRate,
              rate,
              threshold,
              reason: "rate-not-calculable",
            });
            continue;
          }

          const value = numerator / denominator;
          expect(rate).toEqual({ status: "calculated", numerator, denominator, value });
          if (value > threshold) {
            expectedExclusions.push({
              qualityRate,
              rate,
              threshold,
              reason: "threshold-exceeded",
            });
          }
        }

        expect(result.trustedAnalysis).toEqual(
          expectedExclusions.length === 0
            ? { status: "included" }
            : { status: "excluded", exclusions: expectedExclusions },
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
