// R2 90 日と Snowflake 25 UTC 暦月の保持の静的検査。タスク 13.5。
//
// R2 bucket 設定も Snowflake もローカルでは適用できない。ここで固定するのは、適用できなくても壊れていると
// 分かる点である。
//   1. R2 の削除条件が「保存成功から 90 日」一つだけであること。より短い期限も storage class transition も
//      無いこと（期限前の保持期限削除を 0 件にする。要件 6.7 / 6.9）。
//   2. lifecycle の prefix が object key を作る側（src/data-platform/raw-arrival-consumer.ts）の接頭辞と
//      一致すること。刈り残しも過剰削除も起きないこと。
//   3. Snowflake の期限が「初回到達月を第 1 月とする 25 UTC 暦月の終了時点」であり、月内のどの時刻に到達
//      しても同じ期限になること。削除完了の期限がその 24 時間後であること（要件 6.8）。
//   4. 削除の述語が期限だけであり、raw arrival を削除する場所が 07 の task 一つだけであること。品質判定・
//      表示・SLO の層（01〜06）は raw を削除しないこと（要件 6.9 / 5.7）。
//   5. Time Travel が保持の抜け道にならないこと（削除後に読めないこと。要件 6.8）。
//   6. access 制御（タスク 13.6）へ踏み込まないこと。
//
// 判定値はテスト側に書かない。設定と SQL から読み、その値で境界を確かめる。値を三箇所（要件・設定・
// テスト）に持つと、どれが正本か分からなくなる。

import { describe, expect, it } from "vitest";
import lifecycleJson from "../../config/operation-history-r2/raw-arrival-lifecycle.json?raw";
import retentionSql from "../../config/operation-history-snowflake/07-retention.sql?raw";
import ingestSql from "../../config/operation-history-snowflake/01-raw-arrival-ingest.sql?raw";
import associationSql from "../../config/operation-history-snowflake/02-first-arrival-association.sql?raw";
import correlationSql from "../../config/operation-history-snowflake/03-correlation-and-convergence.sql?raw";
import qualitySql from "../../config/operation-history-snowflake/04-quality-rates-and-trusted-analysis.sql?raw";
import disclosureSql from "../../config/operation-history-snowflake/05-best-effort-disclosure.sql?raw";
import sloSql from "../../config/operation-history-snowflake/06-arrival-slo-and-notification.sql?raw";
import consumerConfig from "../../wrangler.raw-arrival-consumer.jsonc?raw";
import procedure from "../../docs/operation-history/retention-procedure.md?raw";
import { rawArrivalObject } from "../../src/data-platform/raw-arrival-consumer";
import { jsoncToJson } from "./support/jsonc";

/** `--` 行コメントを除いた SQL 本文。コメント中の語で判定しないため。 */
const activeSql = (sql: string): string =>
  sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

const statements = activeSql(retentionSql);

const matched = (pattern: RegExp, text = statements): readonly string[] => {
  const found = text.match(pattern);
  expect(found).not.toBeNull();
  return found!.slice(1);
};

// R2 側の宣言的正本。wrangler r2 bucket lifecycle set が読む形そのままである。
type LifecycleCondition = { readonly type: string; readonly maxAge?: number; readonly date?: string };
type LifecycleRule = {
  readonly id: string;
  readonly enabled: boolean;
  readonly conditions: { readonly prefix?: string };
  readonly deleteObjectsTransition?: { readonly condition: LifecycleCondition };
  readonly storageClassTransitions?: readonly unknown[];
  readonly abortMultipartUploadsTransition?: unknown;
};
const lifecycle = JSON.parse(lifecycleJson) as { readonly rules: readonly LifecycleRule[] };

const day = 86_400;
const hour = 3_600_000;

/** Consumer が実際に作る object key。prefix の正本はこちら側である（要件 5.5 / 5.7）。 */
const consumerKey = rawArrivalObject(
  {
    canonicalLine: '{"storeId":"store-1"}',
    firstObservedAt: Date.UTC(2026, 5, 1, 12, 34, 56, 789),
    producerScript: "yude-men-timer",
  },
  { queueMessageId: "message-1", deliveryAttempt: 1, arrivedAt: Date.UTC(2026, 5, 1), canonicalHash: "hash" },
).key;

const bucketName = (JSON.parse(jsoncToJson(consumerConfig)) as {
  readonly r2_buckets: readonly { readonly bucket_name: string }[];
}).r2_buckets[0]!.bucket_name;

// Requirements 6.7, 6.9
describe("R2 の 90 日保持", () => {
  it("wrangler r2 bucket lifecycle set が読む形（rules 配列）である", () => {
    expect(Array.isArray(lifecycle.rules)).toBe(true);
    // JSONC ではなく JSON である（wrangler は JSON.parse で読む）。
    expect(lifecycleJson).not.toContain("//");
  });

  it("削除条件は保存成功から 90 日ひとつだけである", () => {
    expect(lifecycle.rules).toHaveLength(1);
    const [rule] = lifecycle.rules as readonly [LifecycleRule];

    expect(rule.enabled).toBe(true);
    // type = Age は object の upload 時刻（= Consumer の put 成功時刻）から数える。要件 6.7 の起点である。
    expect(rule.deleteObjectsTransition?.condition.type).toBe("Age");
    expect(rule.deleteObjectsTransition?.condition.maxAge).toBe(90 * day);
    expect(rule.deleteObjectsTransition?.condition.date).toBeUndefined();
  });

  it("期限を前倒しする条件を一つも持たない", () => {
    for (const rule of lifecycle.rules) {
      // storage class transition は削除ではないが、expire と競合すると 24 時間内の扱いが分かれる。置かない。
      expect(rule.storageClassTransitions).toBeUndefined();
      expect(rule.abortMultipartUploadsTransition).toBeUndefined();
      const maxAge = rule.deleteObjectsTransition?.condition.maxAge ?? 90 * day;
      expect(maxAge).toBeGreaterThanOrEqual(90 * day);
    }
  });

  it("prefix が object key を作る側の接頭辞と一致する", () => {
    const [rule] = lifecycle.rules as readonly [LifecycleRule];
    const prefix = rule.conditions.prefix!;

    expect(consumerKey.startsWith(prefix)).toBe(true);
    // 一段だけ深い prefix にすると、日付の刻みが変わった key を刈り残す。key の第一段までに留める。
    expect(prefix).toBe(`${consumerKey.split("/")[0]}/`);
  });

  it("手順書が正本の JSON と Consumer の bucket を指す", () => {
    expect(procedure).toContain(`lifecycle set ${bucketName}`);
    expect(procedure).toContain("--file config/operation-history-r2/raw-arrival-lifecycle.json");
  });
});

// Requirements 6.8
describe("Snowflake の 25 UTC 暦月保持", () => {
  // SQL 側が持つ判定値。
  const retentionMonths = Number(matched(/DATEADD\(MONTH, (\d+), DATE_TRUNC\('MONTH'/)[0]);
  const deleteWithinHours = Number(matched(/DATEADD\(HOUR, (\d+), RETENTION_EXPIRES_AT\)/)[0]);

  /** SQL の期限式（第 1 月の初日 + retentionMonths か月）を UTC で解いた値。 */
  const expiresAt = (firstSnowflakeAt: number): number => {
    const at = new Date(firstSnowflakeAt);
    return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + retentionMonths, 1);
  };
  const monthIndex = (epochMs: number): number => {
    const at = new Date(epochMs);
    return at.getUTCFullYear() * 12 + at.getUTCMonth();
  };

  it("初回到達月を第 1 月として 25 暦月保持する", () => {
    const firstArrival = Date.UTC(2026, 5, 15, 3, 4, 5);

    // 第 1 月から数えて 25 暦月ぶん保持し、第 26 月の初日に期限が来る。
    expect(monthIndex(expiresAt(firstArrival)) - monthIndex(firstArrival)).toBe(25);
    expect(new Date(expiresAt(firstArrival)).toISOString()).toBe("2028-07-01T00:00:00.000Z");
    // 列で示す暦月数も同じ値である（SQL 内で二つの月数を持たない）。
    expect(Number(matched(/(\d+)\s+AS RETENTION_UTC_MONTHS/)[0])).toBe(retentionMonths);
  });

  it("月内のどの時刻に到達しても同じ期限になる", () => {
    const monthStart = Date.UTC(2026, 5, 1);
    const monthEnd = Date.UTC(2026, 6, 1) - 1;

    expect(expiresAt(monthStart)).toBe(expiresAt(monthEnd));
    // 期限は月初 00:00 UTC であり、session timezone に依らない。
    expect(statements).toContain("CONVERT_TIMEZONE('UTC', FIRST_SNOWFLAKE_AT)");
    expect(statements).toContain("CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP()) >= RETENTION_EXPIRES_AT");
  });

  it("第 25 月の最終瞬間は期限前である", () => {
    const firstArrival = Date.UTC(2026, 5, 15);
    const lastRetainedInstant = expiresAt(firstArrival) - 1;

    expect(lastRetainedInstant).toBeLessThan(expiresAt(firstArrival));
    expect(monthIndex(lastRetainedInstant) - monthIndex(firstArrival)).toBe(retentionMonths - 1);
  });

  it("削除完了の期限は開始から 24 時間である", () => {
    expect(deleteWithinHours * hour).toBe(24 * hour);
    expect(statements).toContain("AS DELETE_BY");
  });

  it("初回到達時刻はタスク 13.1 の view から取り、収束を作り直さない", () => {
    expect(statements).toContain("OPERATION_HISTORY.RAW.OPERATION_TELEMETRY_FIRST_ARRIVAL");
    expect(statements).not.toContain("GROUP BY CANONICAL_LINE");
  });

  it("期限に達したら 24 時間以内に完了できる周期で走らせる", () => {
    const [minute, hourField] = matched(/SCHEDULE = 'USING CRON (\S+) (\S+) \S+ \S+ \S+ UTC'/);

    // 分は固定、時は毎時。ゆえに起動間隔は 1 時間であり、24 時間の窓に再試行の機会が残る。
    expect(Number(minute)).toBeGreaterThanOrEqual(0);
    expect(hourField).toBe("*");
    expect(hour).toBeLessThanOrEqual(deleteWithinHours * hour);
  });

  it("R2 の 90 日を SQL 側に写さない（期限の定義を二つ作らない）", () => {
    expect(statements).not.toMatch(/\b90\b/);
  });
});

// Requirements 6.9, 5.7
describe("期限前の保持期限削除が 0 件である", () => {
  it("削除の述語は期限だけである", () => {
    const deleteStatement = statements.slice(statements.indexOf("DELETE FROM"));

    expect(deleteStatement).toContain("OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL");
    expect(deleteStatement).toContain("OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL_RETENTION");
    expect(deleteStatement).toContain("WHERE IS_EXPIRED");
    // 期限以外の述語（品質、店舗、期間、行数上限）で消さない。
    expect(deleteStatement).not.toMatch(/IS_MISSING|IS_ORPHAN|DUPLICATE_COUNT|STORE_ID|PERIOD|LIMIT/);
  });

  it("record の全到達行を一度に消す（一到達だけ残さない）", () => {
    expect(statements).toMatch(/DELETE FROM OPERATION_HISTORY\.RAW\.OPERATION_RAW_ARRIVAL\s+WHERE CANONICAL_LINE IN/);
    expect(statements).not.toMatch(/OBJECT_KEY\s*(?:=|IN)/);
  });

  it("07 以外の層は raw arrival を削除しない", () => {
    const layers = {
      "01-raw-arrival-ingest": ingestSql,
      "02-first-arrival-association": associationSql,
      "03-correlation-and-convergence": correlationSql,
      "04-quality-rates-and-trusted-analysis": qualitySql,
      "05-best-effort-disclosure": disclosureSql,
      "06-arrival-slo-and-notification": sloSql,
    };

    for (const [name, sql] of Object.entries(layers)) {
      expect(activeSql(sql), `${name} が raw arrival を削除する`).not.toMatch(
        /\b(?:DELETE|TRUNCATE|DROP|MERGE)\b/i,
      );
    }
    // 07 の削除も一箇所だけである。
    expect(statements.match(/\bDELETE\b/g)).toHaveLength(1);
    expect(statements).not.toMatch(/\b(?:TRUNCATE|DROP|MERGE)\b/i);
  });

  it("Time Travel を保持の抜け道にしない", () => {
    // 正の retention なら DELETE 後も AT / BEFORE で読める。それは「24 時間以内に削除を完了する」と
    // 両立しない（要件 6.8）。
    expect(statements).toContain(
      "ALTER TABLE OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL SET DATA_RETENTION_TIME_IN_DAYS = 0",
    );
  });
});

describe("この層の責務境界", () => {
  it("access 制御へ踏み込まない（タスク 13.6 の責務）", () => {
    expect(statements).not.toMatch(/CREATE ROLE|\bGRANT\b|\bREVOKE\b/i);
  });

  it("品質率・表示・到達 SLO を作り直さない（タスク 13.2〜13.4 の責務）", () => {
    expect(statements).not.toMatch(
      /OPERATION_QUALITY_|OPERATION_TRUSTED_ANALYSIS_SCOPE|OPERATION_ANALYSIS_DISCLOSURE|OPERATION_ARRIVAL_SLO/,
    );
  });

  it("Producer 設定へ保持を持ち込まない", () => {
    // 保持は bucket 単位の設定であり Worker の binding ではない。Consumer 設定にも lifecycle キーは無い。
    expect(jsoncToJson(consumerConfig)).not.toMatch(/lifecycle|retention/i);
  });
});
