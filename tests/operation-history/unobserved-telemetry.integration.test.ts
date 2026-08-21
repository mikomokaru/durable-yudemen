// タスク 12.3 の検査。
//
// 前提（タスク 12.1 の確定・design.md「環境別搬送の確定結果」）: Logpush 縮退の構成対象環境は0件で、
// 全環境が第一経路（Tail Worker）を使う。要件4.7 の前件「Tail_Worker を利用できない環境である」は
// 成立しないため、Logpush 固有の fixture は作らない。ここでは両経路に共通する不変点だけを、実在する
// 第一経路の上で見る。
//   1. 観測できた canonical line だけが R2 へ到達する（要件4.7 の best-effort 搬送）。
//   2. 観測できなかった分は補完しない。届かない行は届かないまま残る（要件4.8）。
//   3. 観測できた lifecycle 内の欠落は測れるが、console log 自体の完全未観測率は測れない。前者は
//      lifecycleMissingRate、後者は測定不能として分けて表示する（要件5.14）。分析値には Observed
//      telemetry に基づく best-effort 推定である旨を付ける（要件5.8）。
//
// 既存検査との分担（重複を作らない）:
//   - tail-queue-r2.integration.test.ts … 搬送機構そのもの（envelope filter、ack、重複保持、失敗）。
//   - quality.example.test.ts … 四品質率と表示の計算。
//   - no-backfill.static.test.ts … 補完機構が設定・実装・手順に存在しないこと。
//   - ここ … 上の三つを跨いだ運用結果、すなわち「Producer が出した総数が観測側の数値へ一切現れない」。
//
// _Requirements: 4.7, 4.8, 5.8, 5.14_

import { afterEach, describe, expect, it, vi } from "vitest";
import { tryWriteOperationLines } from "../../src/operation-history/producer";
import type { OperationObservation } from "../../src/operation-history/derive";
import { parseOperationLines } from "../../src/operation-history/codec";
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

const STORE_ID = "store-1";
const BOILED_AT = START_TIME + BOIL_DURATION;
const COMPLETED_AT = BOILED_AT + 10_000;

const a = { running: producerTimer("a", null, 0), boiled: producerTimer("a", BOILED_AT, 0) } as const;
const b = { running: producerTimer("b", null, 1), boiled: producerTimer("b", BOILED_AT, 1) } as const;

/** timer a の lifecycle。boil-started → boiled → completed の三行を出す。 */
const timerALifecycle: readonly OperationObservation[] = [
  {
    storeId: STORE_ID,
    eventTime: START_TIME,
    eventKind: "Start",
    before: timerStateOf([]),
    after: timerStateOf([a.running]),
  },
  {
    storeId: STORE_ID,
    eventTime: BOILED_AT,
    eventKind: "AlarmFired",
    before: timerStateOf([a.running]),
    after: timerStateOf([a.boiled]),
  },
  {
    storeId: STORE_ID,
    eventTime: COMPLETED_AT,
    eventKind: "Complete",
    before: timerStateOf([a.boiled]),
    after: timerStateOf([]),
  },
];

/** timer b の lifecycle。一行も観測されない場合、その存在は観測側から復元できない。 */
const timerBLifecycle: readonly OperationObservation[] = [
  {
    storeId: STORE_ID,
    eventTime: START_TIME + 1_000,
    eventKind: "Start",
    before: timerStateOf([a.running]),
    after: timerStateOf([a.running, b.running]),
  },
  {
    storeId: STORE_ID,
    eventTime: BOILED_AT + 1,
    eventKind: "AlarmFired",
    before: timerStateOf([a.running, b.running]),
    after: timerStateOf([a.running, b.boiled]),
  },
];

const thresholds = {
  lifecycleMissingRate: 0.2,
  duplicateRate: 0.2,
  orphanRate: 0.2,
  conflictRate: 0.2,
} as const;

/** 観測できた boil-started から、存在を復元できる lifecycle 記録（boiled）を導く。 */
function recoverableLifecycleRecords(record: OperationRecord): readonly OperationRecord[] {
  if (record.operationKind !== "boil-started") return [];
  return [{
    storeId: record.storeId,
    timerId: record.timerId,
    operationKind: "boiled",
    eventTime: record.endTime,
    slotIds: record.slotIds,
    noodleType: record.noodleType,
    firmness: record.firmness,
    endTime: record.endTime,
    boiledAt: record.endTime,
  }];
}

/**
 * Producer が出した行のうち、`observed` に挙げた行だけが Tail に見えた場合の運用結果を作る。
 * 観測できなかった行は fixture の外に置く（Tail が見なかった console log を後から拾う経路がない）。
 */
async function observedOnlyRun(
  produced: readonly OperationObservation[],
  observed: (lines: readonly string[]) => readonly string[],
) {
  // 同一テスト内で二度呼ぶ場合も、この run が出した行だけを見る。
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  log.mockClear();
  for (const observation of produced) tryWriteOperationLines(true, observation);
  const producedLines = log.mock.calls.map((call) => call[0] as string);
  const producerTrace = log.mock.calls.map((call) => call.slice());

  const observedLines = observed(producedLines);
  const pipeline = await runTailToR2([
    tailEvent(PRODUCER_SCRIPT, observedLines.map((line) => ({ level: "log", message: [line] }))),
  ]);

  const arrivedLines = [...pipeline.stored.values()].map((writes) => writes[0]!.split("|")[0]!);
  const parsed = parseOperationLines(arrivedLines.join("\n"));
  const evidence = parsed.flatMap((result) => (result.ok ? [{ record: result.record }] : []));
  const expectedRecords = evidence.flatMap(({ record }) => recoverableLifecycleRecords(record));
  const quality = operationArrivalQualityFromEvidence(evidence, expectedRecords);
  const candidates = correlationCandidatesFromOperationEvidence(evidence);

  return {
    producedLines,
    observedLines,
    arrivedLines,
    producerTrace,
    producerTraceAfterPipeline: log.mock.calls.map((call) => call.slice()),
    assessment: operationQualityAssessmentFromCounts({
      storeId: STORE_ID,
      period: "2023-11-14/2023-11-15",
      counts: {
        expectedLifecycleRecordCount: expectedRecords.length,
        missingLifecycleRecordCount: quality.quality.missing.length,
        arrivalCount: quality.rawArrivals.length,
        duplicateArrivalCount: quality.convergedRecords.reduce(
          (total, converged) => total + converged.duplicateCount,
          0,
        ),
        convergedRecordCount: quality.convergedRecords.length,
        orphanRecordCount: quality.quality.orphan.length,
        primaryCandidateCount: candidates.length,
        conflictingPrimaryCandidateCount: quality.quality.conflict.length,
      },
      thresholds,
    }),
  };
}

/** timer a の boil-started と completed だけが Tail に見えた、という観測。 */
const observeTimerAEnds = (lines: readonly string[]): readonly string[] => [
  lines.find((line) => line.includes('"boil-started"') && line.includes('"a"'))!,
  lines.find((line) => line.includes('"completed"') && line.includes('"a"'))!,
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("観測できた分だけの搬送と、完全未観測率の測定不能", () => {
  it("観測できた canonical line だけが R2 へ到達し、未観測分は補完されない", async () => {
    const run = await observedOnlyRun([...timerALifecycle, ...timerBLifecycle], observeTimerAEnds);

    expect(run.producedLines).toHaveLength(5);
    expect(run.arrivedLines).toEqual(run.observedLines);
    // 未観測の三行（a の boiled、b の boil-started と boiled）は R2 に一件も現れない。
    const unobserved = run.producedLines.filter((produced) => !run.observedLines.includes(produced));
    expect(unobserved).toHaveLength(3);
    for (const line of unobserved) expect(run.arrivedLines).not.toContain(line);
    // Producer の console trace は搬送後も増えない（再出力要求も backfill も存在しない）。
    expect(run.producerTraceAfterPipeline).toEqual(run.producerTrace);
  });

  it("観測できた lifecycle 内の欠落は測り、完全未観測率は測定不能として分けて表示する", async () => {
    const run = await observedOnlyRun([...timerALifecycle, ...timerBLifecycle], observeTimerAEnds);

    // 観測できた boil-started から boiled の存在は復元できる。ゆえに lifecycle 内欠落として測れる。
    expect(run.assessment.rates.lifecycleMissingRate).toEqual({
      status: "calculated",
      numerator: 1,
      denominator: 1,
      value: 1,
    });
    expect(run.assessment.trustedAnalysis).toEqual({
      status: "excluded",
      exclusions: [{
        qualityRate: "lifecycleMissingRate",
        rate: { status: "calculated", numerator: 1, denominator: 1, value: 1 },
        threshold: 0.2,
        reason: "threshold-exceeded",
      }],
    });
    // console log 自体の完全未観測率は、Producer telemetry 総数を観測できないため測れない。
    expect(run.assessment.consoleLogCompleteMissingRate).toEqual({
      status: "unmeasurable",
      reason: "producer-telemetry-total-unobservable",
      distinctFrom: "lifecycleMissingRate",
      display: "Unmeasurable: Producer telemetry total is not observable; distinct from lifecycle missing rate",
    });
    expect(run.assessment.analysisDisclosure).toEqual({
      storeId: STORE_ID,
      period: "2023-11-14/2023-11-15",
      basis: "Observed telemetry",
      estimation: "best-effort",
      display: "Best-effort estimate based on Observed telemetry",
    });
  });

  it("一行も観測されなかった timer は、出力されていてもいなくても運用結果を変えない", async () => {
    // timer b は Producer が二行出したが Tail が一行も見なかった。その二行の存在は観測側から復元
    // できないため、どの品質率にも現れない。これが「完全未観測率は測定不能」の運用上の意味である。
    const withTimerB = await observedOnlyRun([...timerALifecycle, ...timerBLifecycle], observeTimerAEnds);
    const withoutTimerB = await observedOnlyRun(timerALifecycle, observeTimerAEnds);

    expect(withTimerB.producedLines).toHaveLength(5);
    expect(withoutTimerB.producedLines).toHaveLength(3);
    expect(withTimerB.arrivedLines).toEqual(withoutTimerB.arrivedLines);
    expect(withTimerB.assessment).toEqual(withoutTimerB.assessment);
  });
});
