import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { operationArrivalSloByUtcMonth } from "../../src/operation-history/slo";
import type { OperationRecord } from "../../src/operation-history/record";

const NUM_RUNS = 200;
const FIFTEEN_MINUTES = 15 * 60_000;

type Arrival = Parameters<typeof operationArrivalSloByUtcMonth>[0]["arrivals"][number];
type LogicalArrival = Readonly<Arrival & { duplicateCount: number }>;

const timestamp = (value: number): OperationRecord["eventTime"] =>
  value as OperationRecord["eventTime"];

function completed(timerId: string, eventTime: number): OperationRecord {
  return {
    storeId: "store-property",
    timerId,
    operationKind: "completed",
    eventTime: timestamp(eventTime),
    slotIds: ["slot-property"],
    noodleType: "Thin",
    firmness: "normal",
  };
}

function utcMonth(epochMillis: number): string {
  return new Date(epochMillis).toISOString().slice(0, 7);
}

const genYearAndMonth = fc.record({
  year: fc.integer({ min: 2000, max: 2090 }),
  month: fc.integer({ min: 0, max: 11 }),
});

const genScenario = genYearAndMonth.chain(({ year, month }) => {
  const nextMonthStart = Date.UTC(year, month + 1, 1);
  const emptyMonthStart = Date.UTC(year, month + 2, 1);
  return fc.record({
    year: fc.constant(year),
    month: fc.constant(month),
    generated: fc.uniqueArray(
      fc.record({
        identity: fc.integer({ min: 1, max: 1_000_000 }),
        observedOffset: fc.integer({ min: 0, max: emptyMonthStart - nextMonthStart - 1 }),
        lag: fc.constantFrom<number | null>(
          null,
          0,
          FIFTEEN_MINUTES - 1,
          FIFTEEN_MINUTES,
          FIFTEEN_MINUTES + 1,
        ),
        duplicateCount: fc.integer({ min: 1, max: 4 }),
      }),
      { minLength: 0, maxLength: 12, selector: ({ identity }) => identity },
    ),
    orderSeed: fc.integer(),
  });
});

function rawArrivals(logical: readonly LogicalArrival[], orderSeed: number): Arrival[] {
  return logical
    .flatMap((arrival) =>
      Array.from({ length: arrival.duplicateCount }, (_, duplicateIndex): Arrival => ({
        record: { ...arrival.record } as OperationRecord,
        firstObservedAt: arrival.firstObservedAt + duplicateIndex,
        firstSnowflakeAt:
          arrival.firstSnowflakeAt === null || arrival.firstSnowflakeAt === undefined
            ? null
            : arrival.firstSnowflakeAt + duplicateIndex,
      })),
    )
    .map((arrival, index) => ({
      arrival,
      rank: ((index + 1) * (orderSeed | 1)) % (logical.length * 5 + 1),
      index,
    }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ arrival }) => arrival);
}

function logicalArrival(
  timerId: string,
  observedAt: number,
  lag: number | null,
  duplicateCount = 1,
): LogicalArrival {
  return {
    record: completed(timerId, observedAt),
    firstObservedAt: observedAt,
    firstSnowflakeAt: lag === null ? null : observedAt + lag,
    duplicateCount,
  };
}

describe("Property 10: UTC月次到達 SLO", () => {
  // **Validates: Requirements 6.1, 6.2, 6.3, 6.4**
  it("重複除外後の初回観測を UTC 月へ一度だけ所属させ、15分率と空月の対象外を算出する", () => {
    fc.assert(
      fc.property(genScenario, ({ year, month, generated, orderSeed }) => {
        const monthStart = Date.UTC(year, month, 1);
        const nextMonthStart = Date.UTC(year, month + 1, 1);
        const emptyMonthStart = Date.UTC(year, month + 2, 1);
        const monthAfterEmptyStart = Date.UTC(year, month + 3, 1);
        const thresholdTimely = Array.from({ length: 97 }, (_, index) =>
          logicalArrival(`threshold-timely-${index}`, monthStart + index + 1, FIFTEEN_MINUTES),
        );
        const logical: LogicalArrival[] = [
          logicalArrival("previous-month-duplicate", monthStart - 1, FIFTEEN_MINUTES, 2),
          logicalArrival("at-month-start", monthStart, FIFTEEN_MINUTES),
          logicalArrival("before-next-month", nextMonthStart - 1, FIFTEEN_MINUTES - 1),
          ...thresholdTimely,
          logicalArrival("threshold-late", monthStart + 10_000, FIFTEEN_MINUTES + 1),
          logicalArrival("at-next-month", nextMonthStart, FIFTEEN_MINUTES + 1),
          logicalArrival("next-month-unreached", nextMonthStart + 1, null),
          ...generated.map(({ identity, observedOffset, lag, duplicateCount }) =>
            logicalArrival(
              `generated-${identity}`,
              nextMonthStart + observedOffset,
              lag,
              duplicateCount,
            ),
          ),
        ];
        const utcMonths = [
          utcMonth(monthStart - 1),
          utcMonth(monthStart),
          utcMonth(nextMonthStart),
          utcMonth(emptyMonthStart),
        ];
        const arrivals = rawArrivals(logical, orderSeed);
        const result = operationArrivalSloByUtcMonth({ arrivals, utcMonths });

        expect(result).toHaveLength(utcMonths.length);
        expect(new Set(result.map(({ utcMonth: resultMonth }) => resultMonth))).toEqual(
          new Set(utcMonths),
        );
        expect(arrivals.length).toBeGreaterThan(logical.length);

        for (const resultMonth of result) {
          const expectedPopulation = logical.filter(
            ({ firstObservedAt }) => utcMonth(firstObservedAt) === resultMonth.utcMonth,
          );
          const expectedWithinFifteenMinutes = expectedPopulation.filter((arrival) => {
            if (arrival.firstSnowflakeAt === null || arrival.firstSnowflakeAt === undefined)
              return false;
            const elapsed = arrival.firstSnowflakeAt - arrival.firstObservedAt;
            return elapsed >= 0 && elapsed <= FIFTEEN_MINUTES;
          }).length;
          const expectedRate =
            expectedPopulation.length === 0
              ? null
              : expectedWithinFifteenMinutes / expectedPopulation.length;

          expect(resultMonth.populationCount).toBe(expectedPopulation.length);
          expect(resultMonth.arrivedWithinFifteenMinutesCount).toBe(expectedWithinFifteenMinutes);
          expect(resultMonth.arrivalRate).toBe(expectedRate);
          expect(resultMonth.assessment).toBe(
            expectedRate === null ? "not-applicable" : expectedRate >= 0.99 ? "met" : "missed",
          );
          expect(resultMonth.targetRate).toBe(0.99);
        }

        const thresholdMonth = result.find(
          ({ utcMonth: resultMonth }) => resultMonth === utcMonth(monthStart),
        );
        expect(thresholdMonth).toMatchObject({
          populationCount: 100,
          arrivedWithinFifteenMinutesCount: 99,
          arrivalRate: 0.99,
          assessment: "met",
        });
        const emptyMonth = result.find(
          ({ utcMonth: resultMonth }) => resultMonth === utcMonth(emptyMonthStart),
        );
        expect(emptyMonth).toMatchObject({
          populationCount: 0,
          arrivedWithinFifteenMinutesCount: 0,
          arrivalRate: null,
          assessment: "not-applicable",
        });
        expect(utcMonth(monthAfterEmptyStart - 1)).toBe(utcMonth(emptyMonthStart));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
