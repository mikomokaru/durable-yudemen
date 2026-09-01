import { describe, expect, it } from "vitest";
// `?raw` の default は vite/client の `declare module '*?raw'` が与えるため tsc は通る。oxlint の resolver はその宣言を
// 読まず `?raw` を落として実ファイルへ解決するので、実在する .ts を指すときだけ default 無しと誤判定する。
// oxlint-disable-next-line import/default
import sloSource from "../../src/operation-history/slo.ts?raw";
import {
  operationArrivalSloByUtcMonth,
  snowflakeArrivalNotificationTransition,
} from "../../src/operation-history/slo";
import type { OperationRecord } from "../../src/operation-history/record";

const timestamp = (value: number): OperationRecord["eventTime"] =>
  value as OperationRecord["eventTime"];

function completed(timerId: string, eventTime = 1_700_000_000_000): OperationRecord {
  return {
    storeId: "store-1",
    timerId,
    operationKind: "completed",
    eventTime: timestamp(eventTime),
    slotIds: ["slot-1"],
    noodleType: "Thin",
    firmness: "normal",
  };
}

describe("operationArrivalSloByUtcMonth", () => {
  it("重複を除外し、firstObservedAt の UTC 月と15分境界の前後へ一度だけ集計する", () => {
    const januaryObservedAt = Date.UTC(2026, 0, 31, 23, 59, 59, 999);
    const februaryObservedAt = Date.UTC(2026, 1, 1);
    const januaryRecord = completed("timer-january");
    const beforeBoundaryRecord = completed("timer-before-boundary", 1_700_000_000_001);
    const februaryRecord = completed("timer-february", 1_700_000_000_002);
    const result = operationArrivalSloByUtcMonth({
      arrivals: [
        {
          record: januaryRecord,
          firstObservedAt: januaryObservedAt,
          firstSnowflakeAt: januaryObservedAt + 15 * 60_000,
        },
        {
          record: { ...januaryRecord },
          firstObservedAt: februaryObservedAt,
          firstSnowflakeAt: februaryObservedAt + 1_000,
        },
        {
          record: beforeBoundaryRecord,
          firstObservedAt: februaryObservedAt,
          firstSnowflakeAt: februaryObservedAt + 15 * 60_000 - 1,
        },
        {
          record: februaryRecord,
          firstObservedAt: februaryObservedAt,
          firstSnowflakeAt: februaryObservedAt + 15 * 60_000 + 1,
        },
      ],
      utcMonths: ["2026-01", "2026-02"],
    });

    expect(
      result.map(
        ({
          utcMonth,
          populationCount,
          arrivedWithinFifteenMinutesCount,
          arrivalRate,
          assessment,
        }) => ({
          utcMonth,
          populationCount,
          arrivedWithinFifteenMinutesCount,
          arrivalRate,
          assessment,
        }),
      ),
    ).toEqual([
      {
        utcMonth: "2026-01",
        populationCount: 1,
        arrivedWithinFifteenMinutesCount: 1,
        arrivalRate: 1,
        assessment: "met",
      },
      {
        utcMonth: "2026-02",
        populationCount: 2,
        arrivedWithinFifteenMinutesCount: 1,
        arrivalRate: 0.5,
        assessment: "missed",
      },
    ]);
  });

  it("母集団0月は率を作らず対象外とし、必要な表示と非保証を返す", () => {
    const [result] = operationArrivalSloByUtcMonth({ arrivals: [], utcMonths: ["2026-03"] });

    expect(result).toMatchObject({
      utcMonth: "2026-03",
      populationCount: 0,
      arrivedWithinFifteenMinutesCount: 0,
      arrivalRate: null,
      assessment: "not-applicable",
      targetRate: 0.99,
      timerOperationSuccessGuaranteed: false,
    });
    expect(result?.display).toContain("Population: 0");
    expect(result?.display).toContain("within 15 minutes: 0");
    expect(result?.display).toContain("rate: not applicable");
    expect(result?.display).toContain("does not guarantee Timer operation success");
  });
});

describe("snowflakeArrivalNotificationTransition", () => {
  const observedAt = 1_700_000_000_000;
  const oldestRecord = completed("timer-oldest");
  const newerRecord = completed("timer-newer", 1_700_000_000_001);
  const arrivals = [
    { record: newerRecord, firstObservedAt: observedAt + 10_000, firstSnowflakeAt: null },
    { record: oldestRecord, firstObservedAt: observedAt, firstSnowflakeAt: null },
  ] as const;

  it("最古未到達 record の30分帯遷移だけを警告へ写し、相関属性と5分期限を返す", () => {
    const before = snowflakeArrivalNotificationTransition({
      arrivals,
      now: observedAt + 30 * 60_000 - 1,
      previousBand: "under-thirty-minutes",
    });
    const atBoundary = snowflakeArrivalNotificationTransition({
      arrivals,
      now: observedAt + 30 * 60_000,
      previousBand: before.nextBand,
    });

    expect(before.notification).toBeNull();
    expect(atBoundary).toMatchObject({
      nextBand: "thirty-to-sixty-minutes",
      oldestPending: {
        storeId: "store-1",
        timerId: "timer-oldest",
        operationKind: "completed",
        eventTime: oldestRecord.eventTime,
      },
      notification: {
        kind: "warning",
        storeId: "store-1",
        timerId: "timer-oldest",
        operationKind: "completed",
        eventTime: oldestRecord.eventTime,
        transitionedAt: observedAt + 30 * 60_000,
        notifyBy: observedAt + 35 * 60_000,
        withinFiveMinuteWindow: true,
      },
    });
  });

  it("30分帯と60分以上の各連続状態で一回だけ通知し、解消後に状態をリセットする", () => {
    const warningRepeat = snowflakeArrivalNotificationTransition({
      arrivals,
      now: observedAt + 31 * 60_000,
      previousBand: "thirty-to-sixty-minutes",
    });
    const beforeCritical = snowflakeArrivalNotificationTransition({
      arrivals,
      now: observedAt + 60 * 60_000 - 1,
      previousBand: warningRepeat.nextBand,
    });
    const critical = snowflakeArrivalNotificationTransition({
      arrivals,
      now: observedAt + 60 * 60_000,
      previousBand: beforeCritical.nextBand,
    });
    const criticalRepeat = snowflakeArrivalNotificationTransition({
      arrivals,
      now: observedAt + 61 * 60_000,
      previousBand: critical.nextBand,
    });
    const cleared = snowflakeArrivalNotificationTransition({
      arrivals: arrivals.map((arrival) => ({
        ...arrival,
        firstSnowflakeAt: observedAt + 61 * 60_000,
      })),
      now: observedAt + 61 * 60_000,
      previousBand: criticalRepeat.nextBand,
    });

    expect(warningRepeat.notification).toBeNull();
    expect(beforeCritical).toMatchObject({
      nextBand: "thirty-to-sixty-minutes",
      notification: null,
    });
    expect(critical.notification).toMatchObject({
      kind: "critical",
      timerId: "timer-oldest",
      transitionedAt: observedAt + 60 * 60_000,
      notifyBy: observedAt + 65 * 60_000,
      withinFiveMinuteWindow: true,
    });
    expect(criticalRepeat.notification).toBeNull();
    expect(cleared).toEqual({
      nextBand: "under-thirty-minutes",
      oldestPending: null,
      notification: null,
    });
  });

  it("重複のいずれかが到達済みなら未到達にせず、遅延検出時は5分窓超過を明示する", () => {
    const reachedDuplicate = snowflakeArrivalNotificationTransition({
      arrivals: [
        { record: oldestRecord, firstObservedAt: observedAt, firstSnowflakeAt: null },
        {
          record: { ...oldestRecord },
          firstObservedAt: observedAt + 1,
          firstSnowflakeAt: observedAt + 1_000,
        },
      ],
      now: observedAt + 60 * 60_000,
    });
    const late = snowflakeArrivalNotificationTransition({
      arrivals,
      now: observedAt + 66 * 60_000,
      previousBand: "thirty-to-sixty-minutes",
    });

    expect(reachedDuplicate.notification).toBeNull();
    expect(reachedDuplicate.oldestPending).toBeNull();
    expect(late.notification).toMatchObject({ kind: "critical", withinFiveMinuteWindow: false });
  });

  it("現在時刻を入力だけから受け、時計やplatform作用を内部で読まない純粋moduleである", () => {
    expect(sloSource).not.toMatch(/\b(?:Date\.now|performance\.now)\s*\(/);
    expect(sloSource).not.toMatch(/\b(?:console|storage|ctx|env)\s*\./);
    expect(sloSource).not.toMatch(/\b(?:fetch|setAlarm|put|waitUntil|setTimeout|setInterval)\s*\(/);
  });
});
