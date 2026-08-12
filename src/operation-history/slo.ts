import { printCanonicalOperationLine } from "./codec";
import type { OperationRecord } from "./record";

const FIFTEEN_MINUTES = 15 * 60 * 1_000;
const THIRTY_MINUTES = 30 * 60 * 1_000;
const SIXTY_MINUTES = 60 * 60 * 1_000;
const FIVE_MINUTES = 5 * 60 * 1_000;
const ARRIVAL_SLO_TARGET = 0.99;

type ObservedArrival = Readonly<{
  record: OperationRecord;
  firstObservedAt: number;
  firstSnowflakeAt?: number | null;
}>;

type ArrivalLagBand =
  | "under-thirty-minutes"
  | "thirty-to-sixty-minutes"
  | "sixty-minutes-or-more";

type ConvergedObservedTelemetry = Readonly<{
  record: OperationRecord;
  firstObservedAt: number;
  firstSnowflakeAt: number | null;
}>;

function utcMonthFromEpochMillis(epochMillis: number): string {
  const daysSinceEpoch = Math.floor(epochMillis / 86_400_000);
  const shiftedDays = daysSinceEpoch + 719_468;
  const era = Math.floor(shiftedDays / 146_097);
  const dayOfEra = shiftedDays - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1_460) + Math.floor(dayOfEra / 36_524)
      - Math.floor(dayOfEra / 146_096)) / 365,
  );
  const yearDay = dayOfEra - (
    365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100)
  );
  const shiftedMonth = Math.floor((5 * yearDay + 2) / 153);
  const month = shiftedMonth + (shiftedMonth < 10 ? 3 : -9);
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}`;
}
function convergedObservedTelemetry(
  arrivals: readonly ObservedArrival[],
): readonly ConvergedObservedTelemetry[] {
  const converged = new Map<string, ConvergedObservedTelemetry>();
  for (const arrival of arrivals) {
    const key = printCanonicalOperationLine(arrival.record);
    const existing = converged.get(key);
    const snowflakeAt = arrival.firstSnowflakeAt ?? null;
    if (existing === undefined) {
      converged.set(key, {
        record: arrival.record,
        firstObservedAt: arrival.firstObservedAt,
        firstSnowflakeAt: snowflakeAt,
      });
      continue;
    }
    converged.set(key, {
      record: existing.record,
      firstObservedAt: Math.min(existing.firstObservedAt, arrival.firstObservedAt),
      firstSnowflakeAt: existing.firstSnowflakeAt === null
        ? snowflakeAt
        : snowflakeAt === null
          ? existing.firstSnowflakeAt
          : Math.min(existing.firstSnowflakeAt, snowflakeAt),
    });
  }
  return [...converged.values()];
}

/** 重複除外後の Observed telemetry を初回観測 UTC 月へ一度だけ所属させる。 */
export function operationArrivalSloByUtcMonth(input: Readonly<{
  arrivals: readonly ObservedArrival[];
  utcMonths: readonly string[];
}>) {
  const converged = convergedObservedTelemetry(input.arrivals);
  return input.utcMonths.map((utcMonth) => {
    const population = converged.filter(({ firstObservedAt }) =>
      utcMonthFromEpochMillis(firstObservedAt) === utcMonth
    );
    const arrivedWithinFifteenMinutesCount = population.filter((arrival) => {
      if (arrival.firstSnowflakeAt === null) return false;
      const elapsed = arrival.firstSnowflakeAt - arrival.firstObservedAt;
      return elapsed >= 0 && elapsed <= FIFTEEN_MINUTES;
    }).length;
    const populationCount = population.length;
    const arrivalRate = populationCount === 0 ? null : arrivedWithinFifteenMinutesCount / populationCount;
    const assessment = arrivalRate === null
      ? "not-applicable" as const
      : arrivalRate >= ARRIVAL_SLO_TARGET ? "met" as const : "missed" as const;
    const rateDisplay = arrivalRate === null ? "not applicable" : `${(arrivalRate * 100).toFixed(2)}%`;

    return {
      utcMonth,
      populationCount,
      arrivedWithinFifteenMinutesCount,
      arrivalRate,
      assessment,
      targetRate: ARRIVAL_SLO_TARGET,
      display: `Population: ${populationCount}; within 15 minutes: ${arrivedWithinFifteenMinutesCount}; rate: ${rateDisplay}; this SLO does not guarantee Timer operation success.`,
      timerOperationSuccessGuaranteed: false as const,
    };
  });
}
function lagBand(elapsed: number): ArrivalLagBand {
  if (elapsed >= SIXTY_MINUTES) return "sixty-minutes-or-more";
  if (elapsed >= THIRTY_MINUTES) return "thirty-to-sixty-minutes";
  return "under-thirty-minutes";
}

/** 未到達最古 record の 30/60 分帯への遷移を、連続状態ごとに一度だけ通知判断へ写す。 */
export function snowflakeArrivalNotificationTransition(input: Readonly<{
  arrivals: readonly ObservedArrival[];
  now: number;
  previousBand?: ArrivalLagBand;
}>) {
  const oldestPending = convergedObservedTelemetry(input.arrivals)
    .filter(({ firstSnowflakeAt }) => firstSnowflakeAt === null)
    .reduce<ConvergedObservedTelemetry | null>(
      (oldest, arrival) => oldest === null || arrival.firstObservedAt < oldest.firstObservedAt
        ? arrival
        : oldest,
      null,
    );
  const previousBand = input.previousBand ?? "under-thirty-minutes";
  if (oldestPending === null) {
    return { nextBand: "under-thirty-minutes" as const, oldestPending: null, notification: null };
  }

  const elapsed = Math.max(0, input.now - oldestPending.firstObservedAt);
  const nextBand = lagBand(elapsed);
  const notificationKind = nextBand === "thirty-to-sixty-minutes" && previousBand === "under-thirty-minutes"
    ? "warning" as const
    : nextBand === "sixty-minutes-or-more" && previousBand !== "sixty-minutes-or-more"
      ? "critical" as const
      : null;
  const transitionOffset = notificationKind === "warning" ? THIRTY_MINUTES : SIXTY_MINUTES;
  const transitionedAt = oldestPending.firstObservedAt + transitionOffset;
  const oldestCorrelation = {
    storeId: oldestPending.record.storeId,
    timerId: oldestPending.record.timerId,
    operationKind: oldestPending.record.operationKind,
    eventTime: oldestPending.record.eventTime,
  };

  return {
    nextBand,
    oldestPending: { ...oldestCorrelation, firstObservedAt: oldestPending.firstObservedAt, elapsed },
    notification: notificationKind === null ? null : {
      kind: notificationKind,
      ...oldestCorrelation,
      transitionedAt,
      notifyBy: transitionedAt + FIVE_MINUTES,
      detectedAt: input.now,
      withinFiveMinuteWindow: input.now <= transitionedAt + FIVE_MINUTES,
    },
  };
}
