// 月次到達 SLO と 30／60 分通知の Snowflake 配線（config/operation-history-snowflake/06）の静的検査。
// タスク 13.4。
//
// Snowflake は外部サービスゆえローカルでは実行できない。ここで固定するのは、実行できなくても壊れていると
// 分かる点である。
//   1. SQL が持つ判定値（15 / 30 / 60 / 5 分、目標率）と語（met / missed / not-applicable、三つの帯、
//      warning / critical）が純粋層 src/operation-history/slo.ts の振る舞いと一致すること。
//   2. 表示文が純粋層と同一の文であること。母集団 0 の月は率を 0 で埋めず対象外とすること（要件 6.4 / 6.13）。
//   3. 通知が Store Id / Timer Id / Operation Kind / Event Time を含み、属性名と並びが純粋層の
//      notification と一致すること（要件 6.5 / 6.6）。
//   4. 月軸を SQL 側で発明しないこと。月の集合は純粋層の utcMonths と同じく入力である。
//   5. 未到達判定が canonical bytes 単位であること（重複のいずれかが到達済みなら未到達にしない）。
//   6. 保持（13.5）と access 制御（13.6）へ踏み込まず、raw arrival を削除・上書きしないこと。
//
// 判定値はテスト側に書かない。SQL から読み、その値で純粋層を動かして境界の一致を確かめる。値を三箇所
// （純粋層・SQL・テスト）に持つと、どれが正本か分からなくなる。

import { describe, expect, it } from "vitest";
import sloSql from "../../config/operation-history-snowflake/06-arrival-slo-and-notification.sql?raw";
import {
  operationArrivalSloByUtcMonth,
  snowflakeArrivalNotificationTransition,
} from "../../src/operation-history/slo";
import type { OperationRecord } from "../../src/operation-history/record";

/** `--` 行コメントを除いた SQL 本文。コメント中の語で判定しないため。 */
const statements = sloSql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

const matched = (pattern: RegExp): readonly string[] => {
  const found = statements.match(pattern);
  expect(found).not.toBeNull();
  return found!.slice(1);
};

// SQL 側が持つ判定値。
const fifteenMinutes = Number(matched(/BETWEEN 0 AND (\d+)/)[0]);
const targetRate = Number(matched(/>= (0\.\d+)/)[0]);
const fiveMinutes = Number(
  matched(/DATEADD\(MILLISECOND, (\d+), TRANSITION\.TRANSITIONED_AT\)/)[0],
);
const [warningOffset, criticalOffset] = matched(
  /IFF\(KIND\.NOTIFICATION_KIND = 'warning', (\d+), (\d+)\)/,
).map(Number) as [number, number];
const bandThresholds = [...statements.matchAll(/>= (\d+)\s+THEN '([a-z-]+)'/g)].map(
  ([, elapsed, band]) => [Number(elapsed), band!] as const,
);
/** DISPLAY 式に現れる文字列 literal（format model を除く）。 */
const displayLiterals = [...statements.matchAll(/'([^']*)'/g)]
  .map(([, literal]) => literal!)
  .filter(
    (literal) =>
      literal.startsWith("Population: ") ||
      literal.startsWith("; ") ||
      literal === "not applicable" ||
      literal === "%",
  );

const observedAt = Date.UTC(2026, 5, 1);
const utcMonth = "2026-06";

function completed(timerId: string, eventTime = 1_700_000_000_000): OperationRecord {
  return {
    storeId: "store-1",
    timerId,
    operationKind: "completed",
    eventTime: eventTime as OperationRecord["eventTime"],
    slotIds: ["slot-1"],
    noodleType: "Thin",
    firmness: "normal",
  };
}

const pending = [
  {
    record: completed("timer-oldest"),
    firstObservedAt: observedAt,
    firstSnowflakeAt: null,
  },
] as const;

type ArrivalLagBand = "under-thirty-minutes" | "thirty-to-sixty-minutes" | "sixty-minutes-or-more";

const transitionAt = (now: number, previousBand?: ArrivalLagBand) =>
  snowflakeArrivalNotificationTransition(
    previousBand === undefined
      ? { arrivals: pending, now }
      : { arrivals: pending, now, previousBand },
  );

// Requirements 6.1, 6.2, 6.3, 6.4, 6.13
describe("UTC 暦月の到達 SLO", () => {
  it("重複除外と初回到達の関連付けはタスク 13.1 の view を使い、収束を作り直さない", () => {
    expect(statements).toContain("OPERATION_HISTORY.RAW.OPERATION_TELEMETRY_FIRST_ARRIVAL");
    expect(statements).not.toContain("GROUP BY CANONICAL_LINE");
  });

  it("SQL の 15 分境界が純粋層の境界と一致する", () => {
    const [result] = operationArrivalSloByUtcMonth({
      arrivals: [
        {
          record: completed("timer-within"),
          firstObservedAt: observedAt,
          firstSnowflakeAt: observedAt + fifteenMinutes,
        },
        {
          record: completed("timer-late", 1_700_000_000_001),
          firstObservedAt: observedAt,
          firstSnowflakeAt: observedAt + fifteenMinutes + 1,
        },
      ],
      utcMonths: [utcMonth],
    });

    expect(result).toMatchObject({ populationCount: 2, arrivedWithinFifteenMinutesCount: 1 });
  });

  it("SQL の目標率と判定の語が純粋層と一致する", () => {
    const arrivals = Array.from({ length: 100 }, (_, index) => ({
      record: completed(`timer-${index}`, 1_700_000_000_000 + index),
      firstObservedAt: observedAt,
      firstSnowflakeAt: observedAt + (index === 0 ? fifteenMinutes + 1 : fifteenMinutes),
    }));
    const [met] = operationArrivalSloByUtcMonth({ arrivals, utcMonths: [utcMonth] });
    const [missed] = operationArrivalSloByUtcMonth({
      arrivals: arrivals.slice(0, 2),
      utcMonths: [utcMonth],
    });
    const [notApplicable] = operationArrivalSloByUtcMonth({ arrivals: [], utcMonths: [utcMonth] });

    expect(met).toMatchObject({ arrivalRate: targetRate, targetRate, assessment: "met" });
    expect(missed?.assessment).toBe("missed");
    expect(notApplicable).toMatchObject({ arrivalRate: null, assessment: "not-applicable" });
    for (const assessment of [met, missed, notApplicable]) {
      expect(statements).toContain(`'${assessment!.assessment}'`);
    }
    // TARGET_RATE 列と判定の比較の二箇所だけで使う。
    expect(statements.match(new RegExp(String(targetRate), "g"))).toHaveLength(2);
  });

  it("母集団 0 の月は率を作らず、0 で埋めない", () => {
    expect(statements).toContain("NULLIF(POPULATION_COUNT, 0)");
    expect(statements).toContain("WHEN POPULATION_COUNT = 0 THEN 'not-applicable'");
    expect(statements).not.toMatch(/COALESCE\([^)]*POPULATION_COUNT[^)]*\)/);
  });

  it("SQL の DISPLAY 式が純粋層の表示文をそのまま組み立てる", () => {
    const [prefix, withinPrefix, ratePrefix, notApplicable, percent, guarantee] =
      displayLiterals as [string, string, string, string, string, string];
    const [notApplicableMonth] = operationArrivalSloByUtcMonth({
      arrivals: [],
      utcMonths: [utcMonth],
    });
    const [halfMonth] = operationArrivalSloByUtcMonth({
      arrivals: [
        {
          record: completed("timer-within"),
          firstObservedAt: observedAt,
          firstSnowflakeAt: observedAt + fifteenMinutes,
        },
        {
          record: completed("timer-late", 1_700_000_000_001),
          firstObservedAt: observedAt,
          firstSnowflakeAt: observedAt + fifteenMinutes + 1,
        },
      ],
      utcMonths: [utcMonth],
    });

    expect(notApplicableMonth?.display).toBe(
      `${prefix}0${withinPrefix}0${ratePrefix}${notApplicable}${guarantee}`,
    );
    expect(halfMonth?.display).toBe(
      `${prefix}2${withinPrefix}1${ratePrefix}50.00${percent}${guarantee}`,
    );
    // 率は小数二桁で描く（SQL の format model と純粋層の toFixed(2) が同じ形であること）。
    expect(statements).toContain("'FM999990.00'");
    expect(guarantee).toContain("does not guarantee Timer operation success");
    expect(statements).toContain("TIMER_OPERATION_SUCCESS_GUARANTEED   BOOLEAN");
    expect(halfMonth?.timerOperationSuccessGuaranteed).toBe(false);
  });

  it("月の集合を入力として受け、SQL 側で月軸を発明しない", () => {
    expect(statements).toMatch(
      /CREATE FUNCTION IF NOT EXISTS OPERATION_HISTORY\.ANALYSIS\.OPERATION_ARRIVAL_SLO\(TARGET_UTC_MONTH VARCHAR\)/,
    );
    expect(statements).not.toMatch(/GENERATOR\s*\(|SEQ[1248]\s*\(|DATEADD\(\s*'?MONTH/i);
  });

  it("UTC 暦月を session timezone に依らせない", () => {
    expect(statements).toContain("TO_CHAR(CONVERT_TIMEZONE('UTC', FIRST_OBSERVED_AT), 'YYYY-MM')");
  });
});

// Requirements 6.5, 6.6
describe("未到達最古 record の帯の遷移", () => {
  it("SQL の 30／60 分境界と帯の語が純粋層と一致する", () => {
    expect(bandThresholds.map(([, band]) => band)).toEqual([
      "sixty-minutes-or-more",
      "thirty-to-sixty-minutes",
    ]);
    for (const [elapsed, band] of bandThresholds) {
      expect(transitionAt(observedAt + elapsed).nextBand).toBe(band);
      expect(transitionAt(observedAt + elapsed - 1).nextBand).not.toBe(band);
    }
    // 未到達 0 件は帯が戻る。SQL も同じ語で戻す（帯の記録を更新できないと次の遷移を検出できない）。
    const cleared = snowflakeArrivalNotificationTransition({ arrivals: [], now: observedAt });
    expect(cleared.nextBand).toBe("under-thirty-minutes");
    expect(statements).toContain("THEN 'under-thirty-minutes'");
  });

  it("SQL の遷移時刻と 5 分期限が純粋層と一致する", () => {
    const warning = transitionAt(observedAt + warningOffset, "under-thirty-minutes").notification;
    const critical = transitionAt(
      observedAt + criticalOffset,
      "thirty-to-sixty-minutes",
    ).notification;

    expect(warning).toMatchObject({
      kind: "warning",
      transitionedAt: observedAt + warningOffset,
      notifyBy: observedAt + warningOffset + fiveMinutes,
      withinFiveMinuteWindow: true,
    });
    expect(critical).toMatchObject({
      kind: "critical",
      transitionedAt: observedAt + criticalOffset,
      notifyBy: observedAt + criticalOffset + fiveMinutes,
    });
    for (const kind of ["warning", "critical"]) {
      expect(statements).toContain(`'${kind}'`);
    }
  });

  it("警告と重大通知の条件を純粋層と同じにし、連続状態につき一回にする", () => {
    expect(statements).toContain(
      "NEXT_BAND = 'thirty-to-sixty-minutes' AND NEXT.PREVIOUS_BAND = 'under-thirty-minutes'",
    );
    expect(statements).toContain(
      "NEXT_BAND = 'sixty-minutes-or-more' AND NEXT.PREVIOUS_BAND <> 'sixty-minutes-or-more'",
    );
    // 同じ帯が続く間は通知しない。SQL は直前の帯だけを覚え、帯の変化で検出する。
    expect(
      transitionAt(observedAt + warningOffset + 1, "thirty-to-sixty-minutes").notification,
    ).toBeNull();
    expect(
      transitionAt(observedAt + criticalOffset + 1, "sixty-minutes-or-more").notification,
    ).toBeNull();
    expect(statements).toContain(
      "CREATE TABLE IF NOT EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_NOTIFICATION_STATE",
    );
    expect(statements).toContain("SELECT 'under-thirty-minutes', CURRENT_TIMESTAMP()");
    expect(statements).toContain("WHERE NEXT_BAND <> PREVIOUS_BAND");
  });

  it("通知の属性名と並びを純粋層の notification と一致させる", () => {
    const { notification } = transitionAt(observedAt + warningOffset, "under-thirty-minutes");
    const construct = statements.slice(
      statements.indexOf("OBJECT_CONSTRUCT("),
      statements.indexOf(") AS NOTIFICATION"),
    );

    expect([...construct.matchAll(/'(\w+)',/g)].map(([, key]) => key)).toEqual(
      Object.keys(notification!),
    );
    // 要件 6.5 / 6.6 が要求する相関属性。
    for (const attribute of ["storeId", "timerId", "operationKind", "eventTime"]) {
      expect(Object.keys(notification!)).toContain(attribute);
    }
  });

  it("未到達は canonical bytes 単位で引き、重複のいずれかが到達済みなら未到達にしない", () => {
    const reachedDuplicate = snowflakeArrivalNotificationTransition({
      arrivals: [
        pending[0],
        {
          record: { ...pending[0].record },
          firstObservedAt: observedAt + 1,
          firstSnowflakeAt: observedAt + 2,
        },
      ],
      now: observedAt + criticalOffset,
    });

    expect(reachedDuplicate.oldestPending).toBeNull();
    expect(statements).toContain("WHERE arrival.CANONICAL_LINE = OBSERVED.CANONICAL_LINE");
    // object key 単位の anti-join にしない（取込済み record を未到達に数えてしまう）。
    expect(statements).not.toMatch(/arrival\.OBJECT_KEY\s*=/);
  });

  it("5 分以内に検出できる周期で走らせる", () => {
    const schedule = matched(/SCHEDULE = '(\d+) MINUTE'/)[0]!;

    expect(Number(schedule) * 60_000).toBeLessThanOrEqual(fiveMinutes);
  });

  it("通知できないときは帯を進めない（fail closed）", () => {
    const guard = statements.slice(
      statements.indexOf("IF (integration IS NULL) THEN"),
      statements.indexOf("CALL SYSTEM$SEND_EMAIL"),
    );

    expect(guard).toContain("RETURN 'notification-target-not-configured'");
    expect(guard).not.toContain("UPDATE");
  });

  it("通知先の実値をリポジトリへ置かない", () => {
    expect(statements).not.toMatch(/ALLOWED_RECIPIENTS|CREATE NOTIFICATION INTEGRATION/i);
    expect(statements).not.toMatch(/[\w.]+@[\w.]+/);
  });
});

describe("この層の責務境界", () => {
  // Requirements 5.7
  it("raw arrival を削除も上書きもせず、書くのは帯の記憶だけである", () => {
    expect(statements).not.toMatch(/\b(?:DELETE|TRUNCATE|DROP|MERGE)\b/i);
    for (const [, target] of statements.matchAll(/\b(?:INSERT INTO|UPDATE)\s+(\S+)/g)) {
      expect(target).toBe("OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_NOTIFICATION_STATE");
    }
  });

  it("保持と access 制御へ踏み込まない（タスク 13.5 / 13.6 の責務）", () => {
    expect(statements).not.toMatch(/DATA_RETENTION_TIME_IN_DAYS|CREATE ROLE|\bGRANT\b/i);
  });

  it("品質率と信頼判定を作り直さない（タスク 13.2 の責務）", () => {
    expect(statements).not.toMatch(/OPERATION_QUALITY_|OPERATION_TRUSTED_ANALYSIS_SCOPE/);
    for (const word of ["included", "excluded", "not-calculable", "denominator-is-zero"]) {
      expect(statements).not.toContain(`'${word}'`);
    }
  });
});
