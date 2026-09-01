// R2 fixture 起点で到達 SLO、遅延通知、保持期限を貫く clock-controlled 統合テスト。タスク 13.7 の第二の柱。
//
// Snowpipe も Snowflake の task／alert も R2 の lifecycle も外部サービスが実行する。ゆえにここで動かすのは
// 純粋層（src/operation-history/slo.ts）と、宣言的正本（06 / 07 の SQL、R2 lifecycle JSON）が持つ判定値
// だけである。時刻は Date.now を止めて与える。実 fixture の object key・put 時刻・取込時刻から、境界の
// 前後で何件になるかを確かめる。
//
// 判定値をテスト側に書かない。15／30／60／5 分は 06、保持月数と削除完了期限は 07、R2 の 90 日は
// config/operation-history-r2/raw-arrival-lifecycle.json から読む。値を四箇所に持つとどれが正本か分から
// なくなる。
//
// 既存検査との分担（重複を作らない）:
//   - snowflake-slo.static.test.ts … SQL の判定値・語・表示文が純粋層と一致すること。
//   - retention.static.test.ts … 削除の述語が期限だけであること、期限式そのものの形。
//   - slo.example / slo.property.test.ts … 純粋層の単位ごとの境界。
//   - ここ … 実 fixture（重複配送と未取込を含む）に対して、時刻を進めたときの件数と通知回数。
//
// _Requirements: 5.7, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.13_

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sloSql from "../../config/operation-history-snowflake/06-arrival-slo-and-notification.sql?raw";
import retentionSql from "../../config/operation-history-snowflake/07-retention.sql?raw";
import lifecycleJson from "../../config/operation-history-r2/raw-arrival-lifecycle.json?raw";
import { tryWriteOperationLines } from "../../src/operation-history/producer";
import type { OperationObservation } from "../../src/operation-history/derive";
import {
  operationArrivalSloByUtcMonth,
  snowflakeArrivalNotificationTransition,
} from "../../src/operation-history/slo";
import { operationArrivalQualityFromEvidence } from "../../src/operation-history/correlation";
import {
  BOIL_DURATION,
  PRODUCER_SCRIPT,
  producerTimer,
  runTailToR2,
  START_TIME,
  tailEvent,
  timerStateOf,
} from "./support/tail-to-r2";
import {
  arrivalEvidence,
  observedArrivals,
  snowpipeIngest,
  type RawArrival,
} from "./support/snowpipe";

/** `--` 行コメントを除いた SQL 本文。コメント中の数で判定しないため。 */
const activeSql = (sql: string): string =>
  sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

const sloStatements = activeSql(sloSql);
const retentionStatements = activeSql(retentionSql);
const number = (pattern: RegExp, text: string): number => {
  const found = pattern.exec(text);
  expect(found).not.toBeNull();
  return Number(found![1]);
};

// 06 が持つ判定値。
const fifteenMinutes = number(/BETWEEN 0 AND (\d+)/, sloStatements);
const fiveMinutes = number(
  /DATEADD\(MILLISECOND, (\d+), TRANSITION\.TRANSITIONED_AT\)/,
  sloStatements,
);
const [warningOffset, criticalOffset] = (() => {
  const found = /IFF\(KIND\.NOTIFICATION_KIND = 'warning', (\d+), (\d+)\)/.exec(sloStatements);
  expect(found).not.toBeNull();
  return [Number(found![1]), Number(found![2])] as const;
})();
// 07 が持つ判定値。R2 の 90 日と Snowflake の 25 暦月は起点も実行主体も違うが、削除完了までの 24 時間は
// 要件 6.7 / 6.8 が同じ値を要求する（retention-procedure.md も両方をこの窓で確認する）。
const retentionMonths = number(/DATEADD\(MONTH, (\d+), DATE_TRUNC\('MONTH'/, retentionStatements);
const deleteWithinHours = number(
  /DATEADD\(HOUR, (\d+), RETENTION_EXPIRES_AT\)/,
  retentionStatements,
);
// R2 lifecycle が持つ判定値。
const lifecycle = JSON.parse(lifecycleJson) as {
  readonly rules: readonly {
    readonly conditions: { readonly prefix?: string };
    readonly deleteObjectsTransition?: { readonly condition: { readonly maxAge?: number } };
  }[];
};
const objectMaxAge = lifecycle.rules[0]!.deleteObjectsTransition!.condition.maxAge! * 1_000;
const objectPrefix = lifecycle.rules[0]!.conditions.prefix!;

const STORE_ID = "store-1";
const BOILED_AT = START_TIME + BOIL_DURATION;
const COMPLETED_AT = BOILED_AT + 10_000;
/** Tail Worker が観測した時刻。UTC 暦月は 2023-11 である。 */
const OBSERVED_AT = BOILED_AT + 30_000;
const OBSERVED_MONTH = "2023-11";
const EMPTY_MONTH = "2023-10";
const TEN_MINUTES = 10 * 60_000;

const started = producerTimer("started", null, 0);
const boiling = {
  running: producerTimer("boiling", null, 1),
  boiled: producerTimer("boiling", BOILED_AT, 1),
};
const pendingTimer = producerTimer("pending", BOILED_AT, 2);

const observations: readonly OperationObservation[] = [
  {
    storeId: STORE_ID,
    eventTime: START_TIME,
    eventKind: "Start",
    before: timerStateOf([]),
    after: timerStateOf([started]),
  },
  {
    storeId: STORE_ID,
    eventTime: BOILED_AT,
    eventKind: "AlarmFired",
    before: timerStateOf([boiling.running]),
    after: timerStateOf([boiling.boiled]),
  },
  {
    storeId: STORE_ID,
    eventTime: COMPLETED_AT,
    eventKind: "Complete",
    before: timerStateOf([pendingTimer]),
    after: timerStateOf([]),
  },
];

/**
 * object ごとの取込時刻。stored の並びは put の順（= Queue delivery の順）ゆえ、
 * 一件目 = 15 分ちょうど、二件目 = 15 分 + 1ms、三件目（二件目の重複配送）= 10 分、四件目 = 未取込。
 * 二件目と三件目は同じ canonical bytes ゆえ、初回到達は 10 分の側になる（要件 6.1）。
 */
const ingestOffsets: readonly (number | null)[] = [
  fifteenMinutes,
  fifteenMinutes + 1,
  TEN_MINUTES,
  null,
];

type Staged = {
  readonly lines: readonly string[];
  readonly arrivals: readonly RawArrival[];
  readonly lateDuplicateKey: string;
};

/** Producer 出力 → Tail → Queue → Consumer → R2 → 取込。時刻はすべて止めた clock から来る。 */
async function staged(): Promise<Staged> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  for (const observation of observations) tryWriteOperationLines(true, observation);
  const lines = log.mock.calls.map((call) => call[0] as string);

  vi.spyOn(Date, "now").mockReturnValue(OBSERVED_AT);
  const pipeline = await runTailToR2([
    // 二件目（boiled）だけが二度観測された。
    tailEvent(
      PRODUCER_SCRIPT,
      [lines[0]!, lines[1]!, lines[1]!, lines[2]!].map((line) => ({
        level: "log",
        message: [line],
      })),
    ),
  ]);
  const objectKeys = [...pipeline.stored.keys()];

  return {
    lines,
    arrivals: await snowpipeIngest(pipeline.stored, {
      putAt: OBSERVED_AT,
      snowflakeArrivedAt: ({ objectKey }) => {
        const offset = ingestOffsets[objectKeys.indexOf(objectKey)] ?? null;
        return offset === null ? null : OBSERVED_AT + offset;
      },
    }),
    lateDuplicateKey: objectKeys[1]!,
  };
}

/** 07 の期限式。初回 Snowflake 到達月の初日から retentionMonths か月後の 00:00 UTC。 */
function snowflakeExpiresAt(firstSnowflakeAt: number): number {
  const at = new Date(firstSnowflakeAt);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + retentionMonths, 1);
}

/** 07 の削除対象。述語は期限だけで、canonical bytes 単位に record の全到達行を選ぶ。 */
function expiredSnowflakeArrivals(
  arrivals: readonly RawArrival[],
  now: number,
): readonly RawArrival[] {
  const firstArrival = new Map<string, number>();
  for (const arrival of arrivals) {
    if (arrival.snowflakeArrivedAt === null) continue;
    const known = firstArrival.get(arrival.canonicalLine);
    firstArrival.set(
      arrival.canonicalLine,
      known === undefined
        ? arrival.snowflakeArrivedAt
        : Math.min(known, arrival.snowflakeArrivedAt),
    );
  }

  return arrivals.filter((arrival) => {
    const first = firstArrival.get(arrival.canonicalLine);
    return first !== undefined && now >= snowflakeExpiresAt(first);
  });
}

/** R2 lifecycle の削除対象。述語は put 成功からの経過だけである。 */
const expiredObjects = (arrivals: readonly RawArrival[], now: number): readonly RawArrival[] =>
  arrivals.filter((arrival) => now - arrival.r2LastModifiedAt >= objectMaxAge);

let fixture: Staged;

beforeEach(async () => {
  fixture = await staged();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 時刻を止めてから、その時刻を読んで判定させる。判定側へ時刻を書き込まない。 */
function atClock<T>(now: number, read: (now: number) => T): T {
  vi.spyOn(Date, "now").mockReturnValue(now);
  return read(Date.now());
}

// Requirements 6.1, 6.2, 6.3, 6.4, 6.13
describe("UTC 暦月の到達 SLO", () => {
  it("初回観測時刻と初回 Snowflake 到達時刻を record ごとに関連付ける", () => {
    const boiledLine = fixture.lines[1]!;
    const duplicated = fixture.arrivals.filter((arrival) => arrival.canonicalLine === boiledLine);

    // 二到達の初回観測時刻は同じ（同じ Tail 観測）、取込時刻は別である。
    expect(duplicated.map((arrival) => arrival.firstObservedAt)).toEqual([
      OBSERVED_AT,
      OBSERVED_AT,
    ]);
    expect(duplicated.map((arrival) => arrival.snowflakeArrivedAt)).toEqual([
      OBSERVED_AT + fifteenMinutes + 1,
      OBSERVED_AT + TEN_MINUTES,
    ]);
  });

  it("重複除外後の母集団を初回観測 UTC 月へ一度だけ所属させ、15 分ちょうどを含める", () => {
    const [empty, observed] = operationArrivalSloByUtcMonth({
      arrivals: observedArrivals(fixture.arrivals),
      utcMonths: [EMPTY_MONTH, OBSERVED_MONTH],
    });

    // 四到達・三 record。15 分ちょうどの一件と、重複のうち早い到達（10 分）の一件が 15 分以内。
    // 未取込の一件は 15 分以内に数えない。
    expect(fixture.arrivals).toHaveLength(4);
    expect(observed).toMatchObject({
      utcMonth: OBSERVED_MONTH,
      populationCount: 3,
      arrivedWithinFifteenMinutesCount: 2,
      arrivalRate: 2 / 3,
      assessment: "missed",
      timerOperationSuccessGuaranteed: false,
    });
    // 母集団 0 の月は率を作らず判定対象外である（0 で埋めない）。
    expect(empty).toMatchObject({
      utcMonth: EMPTY_MONTH,
      populationCount: 0,
      arrivedWithinFifteenMinutesCount: 0,
      arrivalRate: null,
      assessment: "not-applicable",
    });
    for (const month of [empty, observed]) {
      expect(month!.display).toContain("does not guarantee Timer operation success");
    }
    expect(empty!.display).toContain("not applicable");
  });

  it("15 分を 1ms 超えた到達だけが残ると 15 分以内に数えない", () => {
    // 早い側の重複到達（10 分）を落とすと、同じ record の初回到達は 15 分 + 1ms になる。
    const withoutEarlyDuplicate = fixture.arrivals.filter(
      (arrival) => arrival.snowflakeArrivedAt !== OBSERVED_AT + TEN_MINUTES,
    );
    const [observed] = operationArrivalSloByUtcMonth({
      arrivals: observedArrivals(withoutEarlyDuplicate),
      utcMonths: [OBSERVED_MONTH],
    });

    expect(observed).toMatchObject({
      populationCount: 3,
      arrivedWithinFifteenMinutesCount: 1,
      arrivalRate: 1 / 3,
      assessment: "missed",
    });
  });
});

// Requirements 6.5, 6.6
describe("未到達最古 record の 30／60 分通知", () => {
  const transition = (
    now: number,
    previousBand?: Parameters<typeof snowflakeArrivalNotificationTransition>[0]["previousBand"],
  ) =>
    atClock(now, (clock) =>
      snowflakeArrivalNotificationTransition(
        previousBand === undefined
          ? { arrivals: observedArrivals(fixture.arrivals), now: clock }
          : { arrivals: observedArrivals(fixture.arrivals), now: clock, previousBand },
      ),
    );

  it("30 分帯への遷移で警告を一回、相関属性と 5 分期限つきで出す", () => {
    const before = transition(OBSERVED_AT + warningOffset - 1);
    const warning = transition(OBSERVED_AT + warningOffset);

    expect(before.notification).toBeNull();
    expect(before.nextBand).toBe("under-thirty-minutes");
    expect(warning.nextBand).toBe("thirty-to-sixty-minutes");
    expect(warning.notification).toEqual({
      kind: "warning",
      storeId: STORE_ID,
      timerId: "pending",
      operationKind: "completed",
      eventTime: COMPLETED_AT,
      transitionedAt: OBSERVED_AT + warningOffset,
      notifyBy: OBSERVED_AT + warningOffset + fiveMinutes,
      detectedAt: OBSERVED_AT + warningOffset,
      withinFiveMinuteWindow: true,
    });
    // 未到達なのは取込しなかった一件だけである（重複のいずれかが取込済みの record は未到達でない）。
    expect(warning.oldestPending).toMatchObject({
      timerId: "pending",
      firstObservedAt: OBSERVED_AT,
    });
  });

  it("同じ帯が続く間は通知せず、60 分帯への遷移で重大通知を一回出す", () => {
    const sameBand = transition(OBSERVED_AT + warningOffset + 1, "thirty-to-sixty-minutes");
    const critical = transition(OBSERVED_AT + criticalOffset, "thirty-to-sixty-minutes");
    const afterCritical = transition(OBSERVED_AT + criticalOffset + 1, "sixty-minutes-or-more");

    expect(sameBand.notification).toBeNull();
    expect(critical.notification).toMatchObject({
      kind: "critical",
      storeId: STORE_ID,
      timerId: "pending",
      operationKind: "completed",
      eventTime: COMPLETED_AT,
      transitionedAt: OBSERVED_AT + criticalOffset,
      notifyBy: OBSERVED_AT + criticalOffset + fiveMinutes,
      withinFiveMinuteWindow: true,
    });
    expect(afterCritical.notification).toBeNull();
    expect(afterCritical.nextBand).toBe("sixty-minutes-or-more");
  });
});

// Requirements 6.7, 6.9
describe("R2 の 90 日保持", () => {
  it("lifecycle の prefix が実 fixture の全 object key を覆う", () => {
    for (const arrival of fixture.arrivals) {
      expect(arrival.objectKey.startsWith(objectPrefix)).toBe(true);
    }
  });

  it("保存成功から 90 日に達するまで削除は 0 件で、達した時点で全 object が対象になる", () => {
    const deletionStartsAt = OBSERVED_AT + objectMaxAge;
    const expired = (now: number) =>
      atClock(now, (clock) => expiredObjects(fixture.arrivals, clock));

    expect(expired(deletionStartsAt - 1)).toEqual([]);
    expect(expired(deletionStartsAt)).toHaveLength(4);
    // 未取込の object も R2 側の期限では同じに扱われる（取込の有無は R2 の述語に入らない）。
    expect(
      expired(deletionStartsAt).filter((arrival) => arrival.snowflakeArrivedAt === null),
    ).toHaveLength(1);
    // 削除完了の期限は開始から 24 時間であり、その窓の間ずっと対象のままである（毎時の再試行が届く）。
    expect(deleteWithinHours * 3_600_000).toBe(24 * 3_600_000);
    expect(expired(deletionStartsAt + deleteWithinHours * 3_600_000)).toHaveLength(4);
  });
});

// Requirements 5.7, 6.8, 6.9
describe("Snowflake の 25 UTC 暦月保持", () => {
  it("初回到達月を第 1 月とする 25 暦月の終了まで削除は 0 件で、根拠 raw も残る", () => {
    const expiresAt = snowflakeExpiresAt(OBSERVED_AT + TEN_MINUTES);
    const retained = atClock(expiresAt - 1, (now) => {
      const expired = expiredSnowflakeArrivals(fixture.arrivals, now);
      return fixture.arrivals.filter((arrival) => !expired.includes(arrival));
    });
    const quality = operationArrivalQualityFromEvidence(arrivalEvidence(retained), []);

    expect(new Date(expiresAt).toISOString()).toBe("2025-12-01T00:00:00.000Z");
    // 期限の 1ms 前は一件も削除対象にならず、品質判定の根拠 raw（重複の二到達）も残っている。
    expect(retained).toHaveLength(4);
    expect(quality.rawArrivals).toHaveLength(4);
    expect(
      quality.convergedRecords.reduce((total, { duplicateCount }) => total + duplicateCount, 0),
    ).toBe(1);
  });

  it("期限に達した record は全到達行が対象になり、未取込 record は対象にならない", () => {
    const expiresAt = snowflakeExpiresAt(OBSERVED_AT + TEN_MINUTES);
    const expired = (now: number) =>
      atClock(now, (clock) => expiredSnowflakeArrivals(fixture.arrivals, clock));
    const boiledLine = fixture.lines[1]!;

    // 取込済みの三行（うち二行は同じ record の重複到達）が一度に対象になる。
    expect(expired(expiresAt)).toHaveLength(3);
    expect(
      expired(expiresAt).filter((arrival) => arrival.canonicalLine === boiledLine),
    ).toHaveLength(2);
    // 未取込の一件は Snowflake に行が無いため、Snowflake 側の期限では選ばれない。
    expect(expired(expiresAt).every((arrival) => arrival.snowflakeArrivedAt !== null)).toBe(true);
    // 削除完了までの 24 時間、対象のままである（毎時の task が窓の中で再試行できる）。
    expect(expired(expiresAt + deleteWithinHours * 3_600_000)).toHaveLength(3);
  });

  it("月内のどの時刻に到達しても同じ期限になる", () => {
    const monthStart = Date.UTC(2023, 10, 1);
    const monthEnd = Date.UTC(2023, 11, 1) - 1;

    expect(snowflakeExpiresAt(monthStart)).toBe(snowflakeExpiresAt(OBSERVED_AT + TEN_MINUTES));
    expect(snowflakeExpiresAt(monthEnd)).toBe(snowflakeExpiresAt(OBSERVED_AT + TEN_MINUTES));
  });
});
