// R2 fixture 起点で取込・相関・品質・表示を貫く統合テスト。タスク 13.7 の第一の柱。
//
// Snowflake は外部サービスゆえ SQL は実行できない。ゆえにここは「実行できない層を跨いだ後に、純粋層の
// 定義でどう見えるか」を確かめる。完了済み Producer が実際に console へ書いた行だけを材料にし、
// Tail Worker → Queue → Consumer → R2（実物）→ 取込（tests/.../support/snowpipe.ts）→ 相関・品質・表示
// （src/operation-history の純粋層）を一本に繋ぐ。
//
// 既存検査との分担（重複を作らない）:
//   - tail-queue-r2.integration.test.ts … 搬送機構そのもの（envelope filter、ack、失敗、重複 put）。
//   - snowflake-ingest / -quality / -disclosure.static.test.ts … SQL が純粋層と同じ定義を写していること。
//   - correlation / quality.example.test.ts … 純粋層の単位ごとの境界。
//   - unobserved-telemetry.integration.test.ts … 観測できなかった分を補完しないこと。
//   - ここ … 一つの R2 fixture が四つの品質状態を同時に生む場合に、層を跨いで数と表示が揃うこと。
//
// _Requirements: 4.6, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 5.12, 5.13, 5.14, 5.15, 6.1_

import { afterEach, describe, expect, it, vi } from "vitest";
import { tryWriteOperationLines } from "../../src/operation-history/producer";
import type { OperationObservation } from "../../src/operation-history/derive";
import type { OperationRecord } from "../../src/operation-history/record";
import {
  correlationCandidatesFromOperationEvidence,
  operationArrivalQualityFromEvidence,
} from "../../src/operation-history/correlation";
import { operationQualityAssessmentFromCounts } from "../../src/operation-history/quality";
import {
  BOIL_DURATION,
  PRODUCER_SCRIPT,
  producerTimer,
  runTailToR2,
  START_TIME,
  tailEvent,
  timerStateOf,
} from "./support/tail-to-r2";
import { arrivalEvidence, snowpipeIngest, type RawArrival } from "./support/snowpipe";

const STORE_ID = "store-1";
/** producerTimer の endTime。boiled の Event Time と、復元できる期待記録の Event Time でもある。 */
const BOILED_AT = START_TIME + BOIL_DURATION;
const ADJUSTED_AT = START_TIME + 20_000;
const COMPLETED_AT = BOILED_AT + 10_000;
/** Tail Worker が観測した時刻。object key と FIRST_OBSERVED_AT の出所である。 */
const OBSERVED_AT = BOILED_AT + 30_000;
const INGESTED_AT = OBSERVED_AT + 60_000;
const PERIOD = "2023-11-14";

// timer ごとの事実。lifecycle が届いた／届かない／開始が届かない／両立しない、の四通りを一つの
// fixture に同居させる。
const arrived = { running: producerTimer("arrived", null, 0), boiled: producerTimer("arrived", BOILED_AT, 0) };
const missing = { running: producerTimer("missing", null, 1) };
const orphan = { boiled: producerTimer("orphan", BOILED_AT, 2) };
const conflicting = {
  running: producerTimer("conflicting", null, 3),
  earlier: producerTimer("conflicting", null, 3, -1_000),
  later: producerTimer("conflicting", null, 3, 2_000),
};

/** Producer が出す確定差分の列。R2 fixture の唯一の材料である。 */
const observations: readonly OperationObservation[] = [
  {
    storeId: STORE_ID,
    eventTime: START_TIME,
    eventKind: "Start",
    before: timerStateOf([]),
    after: timerStateOf([arrived.running]),
  },
  {
    storeId: STORE_ID,
    eventTime: BOILED_AT,
    eventKind: "AlarmFired",
    before: timerStateOf([arrived.running]),
    after: timerStateOf([arrived.boiled]),
  },
  {
    storeId: STORE_ID,
    eventTime: START_TIME + 1_000,
    eventKind: "Start",
    before: timerStateOf([arrived.running]),
    after: timerStateOf([arrived.running, missing.running]),
  },
  {
    // 開始が観測されていない timer の完了。孤児の材料である。
    storeId: STORE_ID,
    eventTime: COMPLETED_AT,
    eventKind: "Complete",
    before: timerStateOf([orphan.boiled]),
    after: timerStateOf([]),
  },
  {
    storeId: STORE_ID,
    eventTime: START_TIME + 2_000,
    eventKind: "Start",
    before: timerStateOf([]),
    after: timerStateOf([conflicting.running]),
  },
  {
    // 同じ一次相関 key（store / timer / kind / Event Time）に、両立しない実効 endTime が二つ届く。
    storeId: STORE_ID,
    eventTime: ADJUSTED_AT,
    eventKind: "Adjust",
    before: timerStateOf([conflicting.running]),
    after: timerStateOf([conflicting.earlier]),
  },
  {
    storeId: STORE_ID,
    eventTime: ADJUSTED_AT,
    eventKind: "Adjust",
    before: timerStateOf([conflicting.running]),
    after: timerStateOf([conflicting.later]),
  },
];

/**
 * 観測できた boil-started から存在を復元できる期待 lifecycle 記録。規則の正本は
 * unobserved-telemetry.integration.test.ts の recoverableLifecycleRecords（03 の SQL と docs もそれを
 * 指す）ゆえ、ここでは規則を書かず、この fixture について復元される三件を値として置く。
 */
const expectedRecords: readonly OperationRecord[] = ["arrived", "missing", "conflicting"].map(
  (timerId): OperationRecord => ({
    storeId: STORE_ID,
    timerId,
    operationKind: "boiled",
    eventTime: BOILED_AT as OperationRecord["eventTime"],
    slotIds: [`slot-${timerId}`],
    noodleType: "Thin",
    firmness: "normal",
    endTime: BOILED_AT as OperationRecord["eventTime"],
    boiledAt: BOILED_AT as OperationRecord["eventTime"],
  }),
);

const thresholds = {
  // 欠落率だけが超過し、重複率はちょうど閾値（超過ではない）に一致する。
  lifecycleMissingRate: 0.2,
  duplicateRate: 1 / 8,
  orphanRate: 0.2,
  conflictRate: 0.2,
} as const;

/** Producer 出力 → Tail → Queue → Consumer → R2 → 取込。重複配送は同じ一行を二度観測させて作る。 */
async function stagedArrivals(): Promise<{
  readonly producedLines: readonly string[];
  readonly observedLines: readonly string[];
  readonly arrivals: readonly RawArrival[];
}> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  for (const observation of observations) tryWriteOperationLines(true, observation);
  const producedLines = log.mock.calls.map((call) => call[0] as string);
  // 一件目（arrived の boil-started）だけ二度観測された。
  const observedLines = [producedLines[0]!, ...producedLines];

  vi.spyOn(Date, "now").mockReturnValue(OBSERVED_AT);
  const pipeline = await runTailToR2([
    tailEvent(PRODUCER_SCRIPT, observedLines.map((line) => ({ level: "log", message: [line] }))),
  ]);

  return {
    producedLines,
    observedLines,
    arrivals: await snowpipeIngest(pipeline.stored, {
      putAt: OBSERVED_AT,
      snowflakeArrivedAt: () => INGESTED_AT,
    }),
  };
}

/** 到達列から、quality.ts の counts（= 04 の八集計）と四つの品質状態を得る。 */
function analysis(arrivals: readonly RawArrival[], expected: readonly OperationRecord[] = expectedRecords) {
  const evidence = arrivalEvidence(arrivals);
  const quality = operationArrivalQualityFromEvidence(evidence, expected);
  const candidates = correlationCandidatesFromOperationEvidence(evidence);
  const duplicateArrivalCount = quality.convergedRecords.reduce(
    (total, converged) => total + converged.duplicateCount,
    0,
  );

  return {
    quality,
    candidates,
    assessment: operationQualityAssessmentFromCounts({
      storeId: STORE_ID,
      period: PERIOD,
      counts: {
        expectedLifecycleRecordCount: expected.length,
        missingLifecycleRecordCount: quality.quality.missing.length,
        arrivalCount: quality.rawArrivals.length,
        duplicateArrivalCount,
        convergedRecordCount: quality.convergedRecords.length,
        orphanRecordCount: quality.quality.orphan.length,
        primaryCandidateCount: candidates.length,
        conflictingPrimaryCandidateCount: quality.quality.conflict.length,
      },
      thresholds,
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// Requirements 4.6, 5.4, 6.1
describe("R2 fixture の取込", () => {
  it("R2 の全 object が canonical bytes のまま一到達一行になる", async () => {
    const { observedLines, arrivals } = await stagedArrivals();

    expect(arrivals).toHaveLength(observedLines.length);
    expect([...arrivals].map((arrival) => arrival.canonicalLine).sort()).toEqual(
      [...observedLines].sort(),
    );
    // 一到達一 object。重複配送は上書きせず別 object として残る。
    expect(new Set(arrivals.map((arrival) => arrival.objectKey)).size).toBe(arrivals.length);
  });

  it("観測側 metadata を object key から読み、Operation Record の属性にしない", async () => {
    const { arrivals } = await stagedArrivals();

    for (const arrival of arrivals) {
      expect(arrival.firstObservedAt).toBe(OBSERVED_AT);
      expect(arrival.queueMessageId).toMatch(/^msg-\d+$/);
      expect(arrival.deliveryAttempt).toBe(1);
      expect(arrival.r2LastModifiedAt).toBe(OBSERVED_AT);
      expect(arrival.snowflakeArrivedAt).toBe(INGESTED_AT);
      // canonical hash は bytes から再計算した補助情報であり、record の属性ではない。
      expect(arrival.canonicalHash).toMatch(/^[0-9a-f]{64}$/);
      for (const observed of [
        "firstObservedAt",
        "objectKey",
        "queueMessageId",
        "deliveryAttempt",
        "canonicalHash",
        "snowflakeArrivedAt",
        "seq",
      ]) {
        expect(Object.keys(arrival.record)).not.toContain(observed);
      }
    }
  });
});

// Requirements 5.5, 5.7
describe("重複 raw の保持", () => {
  it("同一 record の二到達は分析用一件へ収束し、raw は判定の前後で残る", async () => {
    const { producedLines, arrivals } = await stagedArrivals();
    const duplicated = arrivals.filter((arrival) => arrival.canonicalLine === producedLines[0]);
    const { quality } = analysis(arrivals);
    const converged = quality.convergedRecords.find(
      ({ analysisRecord }) => analysisRecord.timerId === "arrived"
        && analysisRecord.operationKind === "boil-started",
    );

    expect(duplicated).toHaveLength(2);
    expect(new Set(duplicated.map((arrival) => arrival.objectKey)).size).toBe(2);
    expect(converged).toMatchObject({ arrivalCount: 2, duplicateCount: 1 });
    // 判定後も raw は八件のまま。根拠を削らない。
    expect(quality.rawArrivals).toHaveLength(8);
    expect(arrivals).toHaveLength(8);
  });
});

// Requirements 5.6, 5.7
describe("四つの品質状態", () => {
  it("欠落、孤児、競合、重複を別の状態として同時に保持する", async () => {
    const { arrivals } = await stagedArrivals();
    const { quality, candidates } = analysis(arrivals);

    // 欠落: 復元できる boiled のうち届かなかった二件。
    expect(quality.quality.missing.map((record) => record.timerId)).toEqual(["missing", "conflicting"]);
    for (const record of quality.quality.missing) expect(record.operationKind).toBe("boiled");
    // 孤児: 観測できた boil-started へ相関できない一件。
    expect(quality.quality.orphan.map((group) => group.map(({ record }) => record.operationKind)))
      .toEqual([["completed"]]);
    expect(quality.quality.orphan[0]![0]!.record.timerId).toBe("orphan");
    // 競合: 同じ一次相関 key に両立しない実効 endTime が二つ。
    expect(quality.quality.conflict).toHaveLength(1);
    const conflicted = candidates.find((candidate) => !candidate.timerFactsConsistent)!;
    expect(conflicted.primary).toEqual({
      storeId: STORE_ID,
      timerId: "conflicting",
      operationKind: "adjusted",
      eventTime: ADJUSTED_AT,
    });
    expect(conflicted.records.map((record) => (record as { endTime: number }).endTime)).toEqual([
      BOILED_AT - 1_000,
      BOILED_AT + 2_000,
    ]);
    // 曖昧性の根拠は hash（補助情報）として残る。identity ではない。
    expect(conflicted.ambiguityEvidence?.canonicalHashes).toHaveLength(2);
    // 重複: 一組だけ。
    expect(quality.quality.duplicate.map((group) => group.length)).toEqual([2]);
    // 四つは互いに独立である（同じ到達が二つの状態に数えられても他を消さない）。
    expect(quality.convergedRecords).toHaveLength(7);
    expect(candidates).toHaveLength(6);
  });
});

// Requirements 5.9, 5.10, 5.11, 5.12, 5.13, 5.15
describe("四品質率と信頼済み分析の範囲", () => {
  it("四率を分子・分母どおり算出し、閾値超過の理由だけを除外に挙げる", async () => {
    const { arrivals } = await stagedArrivals();
    const { assessment } = analysis(arrivals);

    expect(assessment.rates).toEqual({
      lifecycleMissingRate: { status: "calculated", numerator: 2, denominator: 3, value: 2 / 3 },
      duplicateRate: { status: "calculated", numerator: 1, denominator: 8, value: 1 / 8 },
      orphanRate: { status: "calculated", numerator: 1, denominator: 7, value: 1 / 7 },
      conflictRate: { status: "calculated", numerator: 1, denominator: 6, value: 1 / 6 },
    });
    // 閾値ちょうど（重複率）は除外しない。超過した欠落率だけが理由と共に現れる。
    expect(assessment.trustedAnalysis).toEqual({
      status: "excluded",
      exclusions: [{
        qualityRate: "lifecycleMissingRate",
        rate: { status: "calculated", numerator: 2, denominator: 3, value: 2 / 3 },
        threshold: thresholds.lifecycleMissingRate,
        reason: "threshold-exceeded",
      }],
    });
  });

  it("一件も到達しない R2 fixture では四率が算出不能になり、0 で埋まらない", async () => {
    const pipeline = await runTailToR2([tailEvent(PRODUCER_SCRIPT, [])]);
    const arrivals = await snowpipeIngest(pipeline.stored, {
      putAt: OBSERVED_AT,
      snowflakeArrivedAt: () => INGESTED_AT,
    });
    const { assessment } = analysis(arrivals, []);

    expect(arrivals).toEqual([]);
    for (const rate of Object.values(assessment.rates)) {
      expect(rate).toMatchObject({ status: "not-calculable", denominator: 0, reason: "denominator-is-zero" });
      expect(rate).not.toHaveProperty("value");
    }
    expect(assessment.trustedAnalysis.status).toBe("excluded");
    expect(
      assessment.trustedAnalysis.status === "excluded"
        ? assessment.trustedAnalysis.exclusions.map((exclusion) => exclusion.reason)
        : [],
    ).toEqual(["rate-not-calculable", "rate-not-calculable", "rate-not-calculable", "rate-not-calculable"]);
  });
});

// Requirements 5.8, 5.14, 5.15
describe("best-effort 表示と完全未観測率", () => {
  it("分析値に店舗・期間・best-effort 推定を付け、完全未観測率は測定不能として分ける", async () => {
    const { arrivals } = await stagedArrivals();
    const { assessment } = analysis(arrivals);

    expect(assessment.analysisDisclosure).toEqual({
      storeId: STORE_ID,
      period: PERIOD,
      basis: "Observed telemetry",
      estimation: "best-effort",
      display: "Best-effort estimate based on Observed telemetry",
    });
    // 完全未観測率は「分母 0 の算出不能」ではなく測定不能であり、lifecycle 内欠落率と別に並ぶ。
    expect(assessment.consoleLogCompleteMissingRate).toMatchObject({
      status: "unmeasurable",
      reason: "producer-telemetry-total-unobservable",
      distinctFrom: "lifecycleMissingRate",
    });
    expect(assessment.consoleLogCompleteMissingRate).not.toHaveProperty("numerator");
    expect(assessment.rates.lifecycleMissingRate.status).toBe("calculated");
  });
});
