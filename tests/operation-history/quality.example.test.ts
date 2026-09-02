import { describe, expect, it } from "vitest";
// `?raw` の default は vite/client の `declare module '*?raw'` が与えるため tsc は通る。oxlint の resolver はその宣言を
// 読まず `?raw` を落として実ファイルへ解決するので、実在する .ts を指すときだけ default 無しと誤判定する。
// oxlint-disable-next-line import/default
import qualitySource from "../../src/operation-history/quality.ts?raw";
import { operationQualityAssessmentFromCounts } from "../../src/operation-history/quality";

const scope = { storeId: "store-1", period: "2026-06-01/2026-07-01" } as const;
const thresholds = {
  lifecycleMissingRate: 0.2,
  duplicateRate: 0.25,
  orphanRate: 0.125,
  conflictRate: 0.4,
} as const;

function assess(counts: Parameters<typeof operationQualityAssessmentFromCounts>[0]["counts"]) {
  return operationQualityAssessmentFromCounts({ ...scope, counts, thresholds });
}

describe("operationQualityAssessmentFromCounts", () => {
  it("Requirements 5.9〜5.12 の分子と分母で四品質率を計算し、閾値ちょうどを含める", () => {
    const result = assess({
      expectedLifecycleRecordCount: 10,
      missingLifecycleRecordCount: 2,
      arrivalCount: 12,
      duplicateArrivalCount: 3,
      convergedRecordCount: 8,
      orphanRecordCount: 1,
      primaryCandidateCount: 5,
      conflictingPrimaryCandidateCount: 2,
    });

    expect(result.rates).toEqual({
      lifecycleMissingRate: { status: "calculated", numerator: 2, denominator: 10, value: 0.2 },
      duplicateRate: { status: "calculated", numerator: 3, denominator: 12, value: 0.25 },
      orphanRate: { status: "calculated", numerator: 1, denominator: 8, value: 0.125 },
      conflictRate: { status: "calculated", numerator: 2, denominator: 5, value: 0.4 },
    });
    expect(result.trustedAnalysis).toEqual({ status: "included" });
  });

  it("分母0を数値0にせず算出不能として、対象率と理由を伴い信頼済み分析から除外する", () => {
    const result = assess({
      expectedLifecycleRecordCount: 0,
      missingLifecycleRecordCount: 0,
      arrivalCount: 0,
      duplicateArrivalCount: 0,
      convergedRecordCount: 0,
      orphanRecordCount: 0,
      primaryCandidateCount: 0,
      conflictingPrimaryCandidateCount: 0,
    });

    expect(result.rates.lifecycleMissingRate).toEqual({
      status: "not-calculable",
      numerator: 0,
      denominator: 0,
      reason: "denominator-is-zero",
    });
    expect(result.trustedAnalysis).toEqual({
      status: "excluded",
      exclusions: ["lifecycleMissingRate", "duplicateRate", "orphanRate", "conflictRate"].map(
        (qualityRate) => ({
          qualityRate,
          rate: {
            status: "not-calculable",
            numerator: 0,
            denominator: 0,
            reason: "denominator-is-zero",
          },
          threshold: thresholds[qualityRate as keyof typeof thresholds],
          reason: "rate-not-calculable",
        }),
      ),
    });
  });

  it("閾値超過率だけを理由付きで除外し、best-effort と完全未観測率の測定不能を分離表示する", () => {
    const result = assess({
      expectedLifecycleRecordCount: 10,
      missingLifecycleRecordCount: 3,
      arrivalCount: 10,
      duplicateArrivalCount: 1,
      convergedRecordCount: 10,
      orphanRecordCount: 1,
      primaryCandidateCount: 10,
      conflictingPrimaryCandidateCount: 1,
    });

    expect(result.trustedAnalysis).toEqual({
      status: "excluded",
      exclusions: [
        {
          qualityRate: "lifecycleMissingRate",
          rate: { status: "calculated", numerator: 3, denominator: 10, value: 0.3 },
          threshold: 0.2,
          reason: "threshold-exceeded",
        },
      ],
    });
    expect(result.analysisDisclosure).toEqual({
      storeId: "store-1",
      period: "2026-06-01/2026-07-01",
      basis: "Observed telemetry",
      estimation: "best-effort",
      display: "Best-effort estimate based on Observed telemetry",
    });
    expect(result.consoleLogCompleteMissingRate).toEqual({
      status: "unmeasurable",
      reason: "producer-telemetry-total-unobservable",
      distinctFrom: "lifecycleMissingRate",
      display:
        "Unmeasurable: Producer telemetry total is not observable; distinct from lifecycle missing rate",
    });
  });

  it("Timerモデルとplatform capabilityに依存しない純粋moduleである", () => {
    expect(qualitySource).not.toMatch(/^import /m);
    expect(qualitySource).not.toMatch(/\b(?:console|storage|ctx|env|Date)\s*\./);
    expect(qualitySource).not.toMatch(/\b(?:fetch|setAlarm|put|waitUntil)\s*\(/);
  });
});
