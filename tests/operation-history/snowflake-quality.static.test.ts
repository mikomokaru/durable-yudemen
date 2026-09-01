// 相関・重複収束・品質率の Snowflake 配線（config/operation-history-snowflake/03・04）の静的検査。タスク 13.2。
//
// Snowflake は外部サービスゆえローカルでは実行できない。ここで固定するのは、実行できなくても壊れていると
// 分かる三点である。
//   1. 純粋層（src/operation-history/correlation.ts・quality.ts）の定義を SQL 側で読み替えていないこと。
//      率の名前、集計の名前、状態の語、分子・分母の対応、一次相関 key の四属性、収束 key の Timer 事実が
//      片方だけ動いたら落ちる。
//   2. 分母 0 を数値 0 にせず算出不能として保持していること（要件 5.13）。
//   3. 判定の根拠 raw arrival を削除しないこと（要件 5.7）。閾値の実値をリポジトリに置かないこと。

import { describe, expect, it } from "vitest";
import correlationAndConvergenceSql from "../../config/operation-history-snowflake/03-correlation-and-convergence.sql?raw";
import qualityRatesSql from "../../config/operation-history-snowflake/04-quality-rates-and-trusted-analysis.sql?raw";
// 以下 3 つの `?raw` の default は vite/client の `declare module '*?raw'` が与えるため tsc は通る。oxlint の resolver は
// その宣言を読まず `?raw` を落として実ファイルへ解決するので、実在する .ts を指すときだけ default 無しと誤判定する
// （上の .sql?raw は resolver が解決できず黙る）。ゆえに抑制は .ts?raw の import に限る。
// oxlint-disable-next-line import/default
import qualitySource from "../../src/operation-history/quality.ts?raw";
// oxlint-disable-next-line import/default
import correlationSource from "../../src/operation-history/correlation.ts?raw";
// oxlint-disable-next-line import/default
import unobservedTelemetrySource from "./unobserved-telemetry.integration.test.ts?raw";

/** `--` 行コメントを除いた SQL 本文。コメント中の語で判定しないため。 */
function statements(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

/** 指定 object を作る一文だけを、空白を畳んだ形で取り出す。 */
function creationOf(object: string): string {
  const create = new RegExp(
    `^CREATE (?:VIEW|TABLE|SCHEMA)(?: IF NOT EXISTS)? OPERATION_HISTORY\\.ANALYSIS\\.${object}\\b`,
  );
  const found = [statements(correlationAndConvergenceSql), statements(qualityRatesSql)]
    .flatMap((sql) => sql.split(";"))
    .map((statement) => statement.trim().replace(/\s+/g, " "))
    .filter((statement) => create.test(statement));

  expect(found).toHaveLength(1);
  return found[0]!;
}

/** 一文の GROUP BY 句に並ぶ列名。 */
function groupByColumns(statement: string): readonly (readonly string[])[] {
  return [...statement.matchAll(/GROUP BY (.+?)(?=\)|LEFT JOIN|$)/g)].map(([, columns]) =>
    columns!.split(",").map((column) => column.trim()),
  );
}

const camelToUpperSnake = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();

/** quality.ts が宣言する品質率の名前（宣言順）。 */
const qualityRateNames = [
  ...qualitySource
    .match(/const qualityRateNames = \[([\s\S]*?)\] as const/)![1]!
    .matchAll(/"([^"]+)"/g),
].map(([, name]) => name!);

/** quality.ts が受け取る counts の属性名（宣言順）。 */
const countNames = [
  ...qualitySource.match(/counts: Readonly<\{([\s\S]*?)\}>/)![1]!.matchAll(/(\w+): number;/g),
].map(([, name]) => name!);

// Requirements 5.9, 5.10, 5.11, 5.12
describe("純粋層の定義との一対一対応", () => {
  it("四品質率の名前と順序が quality.ts の宣言と一致する", () => {
    expect(qualityRateNames).toEqual([
      "lifecycleMissingRate",
      "duplicateRate",
      "orphanRate",
      "conflictRate",
    ]);

    const rates = [
      ...statements(qualityRatesSql).matchAll(/(\d) AS RATE_ORDER, '([^']+)' AS QUALITY_RATE/g),
    ].map(([, order, name]) => [Number(order), name!] as const);

    expect(rates).toEqual(qualityRateNames.map((name, index) => [index + 1, name]));
  });

  it("八集計の列名が quality.ts の counts と同名同義である", () => {
    expect(countNames).toHaveLength(8);

    const count = creationOf("OPERATION_QUALITY_COUNT");
    for (const name of countNames) {
      expect(count).toContain(`AS ${camelToUpperSnake(name)}`);
    }
  });

  it("各品質率の分子と分母が requirements の集計そのままである", () => {
    const rate = creationOf("OPERATION_QUALITY_RATE");

    for (const [name, numerator, denominator] of [
      ["lifecycleMissingRate", "missingLifecycleRecordCount", "expectedLifecycleRecordCount"],
      ["duplicateRate", "duplicateArrivalCount", "arrivalCount"],
      ["orphanRate", "orphanRecordCount", "convergedRecordCount"],
      ["conflictRate", "conflictingPrimaryCandidateCount", "primaryCandidateCount"],
    ] as const) {
      // quality.ts が使う集計名だけを分子・分母に据えていることを、名前の対で確かめる。
      expect(countNames).toContain(numerator);
      expect(countNames).toContain(denominator);
      expect(rate).toMatch(
        new RegExp(
          `'${name}' AS QUALITY_RATE, ${camelToUpperSnake(numerator)} AS NUMERATOR, ` +
            `${camelToUpperSnake(denominator)} AS DENOMINATOR`,
        ),
      );
    }
  });

  it("状態と除外理由の語を quality.ts と共有し、別の語を作らない", () => {
    const sql = statements(qualityRatesSql);

    for (const word of [
      "calculated",
      "not-calculable",
      "denominator-is-zero",
      "rate-not-calculable",
      "threshold-exceeded",
      "included",
      "excluded",
    ]) {
      expect(qualitySource).toContain(`"${word}"`);
      expect(sql).toContain(`'${word}'`);
    }
  });
});

// Requirements 5.1, 5.2, 5.3, 5.4, 5.5
describe("相関 key と収束 key", () => {
  it("一次相関候補の key が correlation.ts と同じ四属性だけである", () => {
    const primary = [
      ...correlationSource
        .match(
          /function primaryCandidate\(record: OperationRecord\): PrimaryCandidate \{([\s\S]*?)\n\}/,
        )![1]!
        .matchAll(/(\w+): record\.\w+,/g),
    ].map(([, name]) => camelToUpperSnake(name!));

    expect(primary).toEqual(["STORE_ID", "TIMER_ID", "OPERATION_KIND", "EVENT_TIME"]);

    const candidate = creationOf("OPERATION_CORRELATION_CANDIDATE");
    // PERIOD は EVENT_TIME の関数（UTC 暦日）ゆえ key を増やさない。
    expect(groupByColumns(candidate)).toEqual([[...primary, "PERIOD"]]);
  });

  it("収束 key が一次相関 key と record 本体の Timer 事実だけで、補助 metadata を含まない", () => {
    const [converged] = groupByColumns(creationOf("OPERATION_CONVERGED_RECORD"));

    expect(converged).toEqual([
      "STORE_ID",
      "TIMER_ID",
      "OPERATION_KIND",
      "EVENT_TIME",
      "SLOT_IDS",
      "NOODLE_TYPE",
      "FIRMNESS",
      "START_TIME",
      "END_TIME",
      "BOILED_AT",
      "PERIOD",
    ]);
    for (const auxiliary of [
      "CANONICAL_HASH",
      "OBJECT_KEY",
      "QUEUE_MESSAGE_ID",
      "DELIVERY_ATTEMPT",
      "FIRST_OBSERVED_AT",
      "SNOWFLAKE_ARRIVED_AT",
    ]) {
      expect(converged).not.toContain(auxiliary);
    }
  });

  it("到達総数 n と重複数 n - 1 を保持する", () => {
    expect(creationOf("OPERATION_CONVERGED_RECORD")).toMatch(
      /COUNT\(\*\) AS ARRIVAL_COUNT, COUNT\(\*\) - 1 AS DUPLICATE_COUNT/,
    );
  });

  it("期間は Operation Record 内の eventTime から取り、観測側時刻から取らない", () => {
    const arrival = creationOf("OPERATION_ARRIVAL");

    expect(arrival).toContain(
      "TO_CHAR(TO_TIMESTAMP_NTZ(KNOWN:eventTime::NUMBER, 3), 'YYYY-MM-DD') AS PERIOD",
    );
    expect(arrival).not.toMatch(
      /(?:FIRST_OBSERVED_AT|SNOWFLAKE_ARRIVED_AT|R2_LAST_MODIFIED_AT)[^,]*AS PERIOD/,
    );
  });
});

// Requirements 5.6, 5.9, 5.11
describe("四品質状態と復元規則", () => {
  it("欠落・孤児・競合・重複を独立の列として持つ", () => {
    expect(creationOf("OPERATION_EXPECTED_LIFECYCLE_RECORD")).toContain("AS IS_MISSING");
    expect(creationOf("OPERATION_CONVERGED_RECORD")).toContain("AS IS_ORPHAN");
    expect(creationOf("OPERATION_CORRELATION_CANDIDATE")).toContain("AS TIMER_FACTS_CONSISTENT");
    expect(creationOf("OPERATION_CONVERGED_RECORD")).toContain("AS DUPLICATE_COUNT");
  });

  it("期待 lifecycle 記録の復元規則が既存の表明と同じ boil-started → boiled である", () => {
    const expected = creationOf("OPERATION_EXPECTED_LIFECYCLE_RECORD");

    expect(expected).toContain("'boiled' AS OPERATION_KIND, END_TIME AS EVENT_TIME");
    expect(expected).toContain("WHERE OPERATION_KIND = 'boil-started'");
    // SQL 側で別の復元規則を発明していないこと（他 kind から復元しない）。
    for (const kind of ["completed", "cancelled", "adjusted"]) {
      expect(expected).not.toContain(`'${kind}'`);
    }
    // 既存の表明（統合テストの recoverableLifecycleRecords）と同じ規則であること。
    expect(unobservedTelemetrySource).toContain(
      'if (record.operationKind !== "boil-started") return [];',
    );
    expect(unobservedTelemetrySource).toContain('operationKind: "boiled",');
    expect(unobservedTelemetrySource).toContain("eventTime: record.endTime,");
  });

  it("孤児判定は観測できた boil-started への相関だけを根拠にする", () => {
    expect(creationOf("OPERATION_CONVERGED_RECORD")).toMatch(
      /OBSERVED_START AS \( SELECT DISTINCT STORE_ID, TIMER_ID FROM \S+\.OPERATION_ARRIVAL WHERE OPERATION_KIND = 'boil-started' \)/,
    );
    expect(correlationSource).toContain(
      'if (arrival.record.operationKind === "boil-started") starts.add(timerKey(arrival.record));',
    );
  });
});

// Requirements 5.13, 5.15
describe("分母 0 の算出不能と信頼済み分析からの除外", () => {
  it("分母 0 を数値 0 にせず算出不能として保持する", () => {
    const rate = creationOf("OPERATION_QUALITY_RATE");

    expect(rate).toContain("IFF(RATE.DENOMINATOR = 0, 'not-calculable', 'calculated') AS STATUS");
    expect(rate).toContain("RATE.NUMERATOR / NULLIF(RATE.DENOMINATOR, 0) AS VALUE");
    expect(rate).toContain(
      "IFF(RATE.DENOMINATOR = 0, 'denominator-is-zero', NULL) AS NOT_CALCULABLE_REASON",
    );
    // 0 で埋める形が混ざっていないこと。
    expect(rate).not.toMatch(/ZEROIFNULL|(?:COALESCE|IFNULL)\(\s*(?:RATE\.NUMERATOR \/|VALUE)/i);
  });

  it("算出不能と閾値超過を理由付きで除外し、閾値ちょうどは除外しない", () => {
    const rate = creationOf("OPERATION_QUALITY_RATE");

    expect(rate).toContain("WHEN RATE.DENOMINATOR = 0 THEN 'rate-not-calculable'");
    expect(rate).toMatch(/> THRESHOLD\.THRESHOLD THEN 'threshold-exceeded'/);
    expect(rate).not.toMatch(/>= THRESHOLD\.THRESHOLD/);
    expect(qualitySource).toContain("rate.value > threshold");
  });

  it("除外理由のある店舗・期間だけを excluded にし、対象品質率を並べる", () => {
    const scope = creationOf("OPERATION_TRUSTED_ANALYSIS_SCOPE");

    expect(scope).toContain("WHERE EXCLUSION_REASON IS NOT NULL");
    expect(scope).toContain("IFF(EXCLUSION.EXCLUSIONS IS NULL, 'included', 'excluded')");
    expect(scope).toContain("WITHIN GROUP (ORDER BY RATE_ORDER)");
    for (const key of ["'qualityRate'", "'rate'", "'threshold'", "'reason'"]) {
      expect(scope).toContain(key);
    }
  });
});

// Requirements 5.7
describe("この層の責務境界", () => {
  it("raw arrival を削除も上書きもせず、読むだけである", () => {
    for (const sql of [statements(correlationAndConvergenceSql), statements(qualityRatesSql)]) {
      expect(sql).not.toMatch(/\b(?:DELETE|TRUNCATE|DROP|UPDATE|MERGE|INSERT)\b/i);
    }
    // raw table を読むのは OPERATION_ARRIVAL の一箇所だけ。
    expect(
      statements(correlationAndConvergenceSql).match(/RAW\.OPERATION_RAW_ARRIVAL\b/g),
    ).toHaveLength(1);
  });

  it("canonical bytes を再直列化せず、そのまま持ち回る", () => {
    const sql = statements(correlationAndConvergenceSql);

    expect(sql).toContain("ANY_VALUE(CANONICAL_LINE)");
    // record 全体を VARIANT から再直列化しない（属性順が正規化されて bytes が失われる）。
    expect(sql).not.toMatch(/TO_JSON\(\s*KNOWN\s*\)/);
    expect(
      [...sql.matchAll(/TO_JSON\(([^)]*)\)/g)].map(([, argument]) => argument!.trim()),
    ).toEqual(["KNOWN:slotIds"]);
  });

  it("閾値の実値をリポジトリに持たず、運用設定として分離する", () => {
    const threshold = creationOf("OPERATION_QUALITY_THRESHOLD");

    expect(threshold).toMatch(/^CREATE TABLE IF NOT EXISTS/);
    // 既定値も投入行も持たない（実値は運用者が手順書に従って入れる）。
    expect(threshold).not.toMatch(/\bDEFAULT\b/i);
    expect(statements(qualityRatesSql)).not.toMatch(/OPERATION_QUALITY_THRESHOLD\s+VALUES/i);
  });

  it("SLO 判定・保持・access 制御へ踏み込まない（タスク 13.4〜13.6 の責務）", () => {
    for (const sql of [statements(correlationAndConvergenceSql), statements(qualityRatesSql)]) {
      expect(sql).not.toMatch(/FIRST_SNOWFLAKE_AT|OPERATION_TELEMETRY_FIRST_ARRIVAL/);
      expect(sql).not.toMatch(/\bSLO\b|DATA_RETENTION_TIME_IN_DAYS|CREATE ROLE|GRANT\b/i);
    }
  });
});
