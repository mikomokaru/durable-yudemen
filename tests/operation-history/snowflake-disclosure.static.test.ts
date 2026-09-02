// best-effort 表示と完全未観測率の Snowflake 配線（config/operation-history-snowflake/05）の静的検査。
// タスク 13.3。
//
// Snowflake は外部サービスゆえローカルでは実行できない。ここで固定するのは、実行できなくても壊れていると
// 分かる四点である。
//   1. 純粋層（src/operation-history/quality.ts の analysisDisclosure / consoleLogCompleteMissingRate）の
//      語と表示文を SQL 側で言い換えていないこと（要件 5.8 / 5.14）。
//   2. 完全未観測率が数を持たないこと。測定不能を数値で埋めた時点で best-effort の限界を偽る（要件 5.14）。
//   3. lifecycle 内欠落率と混ざらないこと（要件 5.14）。
//   4. 生産能力指標そのものを発明せず、表示の付与に留まること。信頼済み分析の判定と期間の定義を
//      作り直さないこと（要件 5.8 / 5.15）。

import { describe, expect, it } from "vitest";
import disclosureSql from "../../config/operation-history-snowflake/05-best-effort-disclosure.sql?raw";
// `?raw` の default は vite/client の `declare module '*?raw'` が与えるため tsc は通る。oxlint の resolver はその宣言を
// 読まず `?raw` を落として実ファイルへ解決するので、実在する .ts を指すときだけ default 無しと誤判定する
// （上の .sql?raw は resolver が解決できず黙る）。
// oxlint-disable-next-line import/default
import qualitySource from "../../src/operation-history/quality.ts?raw";

/** `--` 行コメントを除いた SQL 本文。コメント中の語で判定しないため。 */
function statements(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

/** 指定 view を作る一文だけを、空白を畳んだ形で取り出す。 */
function creationOf(object: string): string {
  const create = new RegExp(
    `^CREATE VIEW(?: IF NOT EXISTS)? OPERATION_HISTORY\\.ANALYSIS\\.${object}\\b`,
  );
  // 文の区切りは行末の `;` だけで取る。表示文に含まれる `;`（"observable; distinct …"）で切らないため。
  const found = statements(disclosureSql)
    .split(/;\r?\n/)
    .map((statement) => statement.trim().replace(/\s+/g, " "))
    .filter((statement) => create.test(statement));

  expect(found).toHaveLength(1);
  return found[0]!;
}

const camelToUpperSnake = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();

/** quality.ts の object literal から、文字列値を持つ属性だけを宣言順に取り出す。 */
function literalFields(symbol: string): readonly (readonly [string, string])[] {
  const body = qualitySource.match(new RegExp(`${symbol}: \\{([\\s\\S]*?)\\n    \\},`))![1]!;
  // コロンと値の間は \s* で受ける。長い文字列値は整形で次行へ送られるが、属性と値の対応は変わらない。
  return [...body.matchAll(/(\w+):\s*"([^"]*)"/g)].map(
    ([, name, value]) => [name!, value!] as const,
  );
}

const disclosureFields = literalFields("analysisDisclosure");
const unmeasurableFields = literalFields("consoleLogCompleteMissingRate");

// Requirements 5.8
describe("分析値へ付ける best-effort 表示", () => {
  it("Store Id と期間で一行になり、期間の定義を作り直さない", () => {
    const disclosure = creationOf("OPERATION_ANALYSIS_DISCLOSURE");

    // analysisDisclosure の storeId / period は SQL の STORE_ID / PERIOD である。
    expect(disclosureSource(["storeId", "period"])).toEqual(["input.storeId", "input.period"]);
    expect(disclosure).toContain("SCOPE.STORE_ID, SCOPE.PERIOD");
    // PERIOD は 03 / 04 の定義を連れてくるだけで、ここで暦日を作り直さない。
    expect(disclosure).not.toMatch(/TO_TIMESTAMP_NTZ|TO_CHAR|DATE_TRUNC/);
  });

  it("根拠と推定の語、表示文を quality.ts と同一に持つ", () => {
    const disclosure = creationOf("OPERATION_ANALYSIS_DISCLOSURE");

    expect(disclosureFields.map(([name]) => name)).toEqual(["basis", "estimation", "display"]);
    for (const [name, value] of disclosureFields) {
      expect(disclosure).toContain(`'${value}' AS ${camelToUpperSnake(name)}`);
    }
    expect(disclosureFields.map(([, value]) => value)).toEqual([
      "Observed telemetry",
      "best-effort",
      "Best-effort estimate based on Observed telemetry",
    ]);
  });

  it("生産能力指標そのものを発明せず、表示の付与に留まる", () => {
    const sql = statements(disclosureSql);

    // 数える・丸める・集計する形が一切ないこと。指標の中身はこの層の責務ではない。
    expect(sql).not.toMatch(/\b(?:COUNT|COUNT_IF|SUM|AVG|MIN|MAX|ANY_VALUE|ARRAY_AGG)\s*\(/i);
    expect(sql).not.toMatch(/\bGROUP BY\b/i);
  });
});

// Requirements 5.15
describe("信頼済み分析の判定は 04 の結果を連れてくるだけである", () => {
  it("除外状態と除外理由を分析値の表示に同伴させる", () => {
    const disclosure = creationOf("OPERATION_ANALYSIS_DISCLOSURE");

    expect(disclosure).toContain("SCOPE.TRUSTED_ANALYSIS_STATUS");
    expect(disclosure).toContain("SCOPE.EXCLUSIONS");
    expect(disclosure).toContain(
      "FROM OPERATION_HISTORY.ANALYSIS.OPERATION_TRUSTED_ANALYSIS_SCOPE SCOPE",
    );
  });

  it("included / excluded と除外理由の語を 05 で作り直さない", () => {
    const sql = statements(disclosureSql);

    for (const word of [
      "included",
      "excluded",
      "threshold-exceeded",
      "rate-not-calculable",
      "denominator-is-zero",
      "not-calculable",
    ]) {
      expect(sql).not.toContain(`'${word}'`);
    }
  });
});

// Requirements 5.14
describe("console log 自体の完全未観測率", () => {
  it("測定不能の語と表示文を quality.ts と同一に持つ", () => {
    const unmeasurable = creationOf("OPERATION_CONSOLE_LOG_COMPLETE_MISSING_RATE");

    expect(unmeasurableFields.map(([name]) => name)).toEqual([
      "status",
      "reason",
      "distinctFrom",
      "display",
    ]);
    expect(unmeasurableFields.map(([, value]) => value)).toEqual([
      "unmeasurable",
      "producer-telemetry-total-unobservable",
      "lifecycleMissingRate",
      "Unmeasurable: Producer telemetry total is not observable; distinct from lifecycle missing rate",
    ]);
    for (const [name, value] of unmeasurableFields) {
      expect(unmeasurable).toContain(`'${value}' AS ${camelToUpperSnake(name)}`);
    }
  });

  it("数を持たず、到達 record を数える view も参照しない", () => {
    const unmeasurable = creationOf("OPERATION_CONSOLE_LOG_COMPLETE_MISSING_RATE");

    // 参照する object は自分自身（CREATE の対象）だけ。到達 record も集計 view も読まない。
    expect(unmeasurable.match(/OPERATION_HISTORY\.\w+\.\w+/g)).toEqual([
      "OPERATION_HISTORY.ANALYSIS.OPERATION_CONSOLE_LOG_COMPLETE_MISSING_RATE",
    ]);
    expect(unmeasurable).not.toMatch(/NUMERATOR|DENOMINATOR|\bVALUE\b|_COUNT\b/i);
    // 算出不能（分母 0）ではなく測定不能である。二つを同じ語にしない。
    expect(unmeasurable).not.toContain("'not-calculable'");
  });

  it("lifecycle 内欠落率と分けて表示し、混ざらない列名で同伴させる", () => {
    const disclosure = creationOf("OPERATION_ANALYSIS_DISCLOSURE");
    const sql = statements(disclosureSql);

    for (const [name] of unmeasurableFields) {
      expect(disclosure).toContain(
        `AS CONSOLE_LOG_COMPLETE_MISSING_RATE_${camelToUpperSnake(name)}`,
      );
    }
    // lifecycle 内欠落率の分子・分母をこの層で再計算しない（正本は 04 の OPERATION_QUALITY_RATE）。
    expect(sql).not.toMatch(/MISSING_LIFECYCLE_RECORD_COUNT|EXPECTED_LIFECYCLE_RECORD_COUNT/);
    expect(sql).not.toMatch(/AS LIFECYCLE_MISSING_RATE\b/);
  });
});

describe("この層の責務境界", () => {
  // Requirements 5.7
  it("raw arrival を読まず、削除も上書きもしない", () => {
    const sql = statements(disclosureSql);

    expect(sql).not.toMatch(/\b(?:DELETE|TRUNCATE|DROP|UPDATE|MERGE|INSERT)\b/i);
    expect(sql).not.toMatch(/OPERATION_HISTORY\.RAW\./);
  });

  it("到達 SLO・通知・保持・access 制御へ踏み込まない（タスク 13.4〜13.6 の責務）", () => {
    const sql = statements(disclosureSql);

    expect(sql).not.toMatch(/FIRST_SNOWFLAKE_AT|OPERATION_TELEMETRY_FIRST_ARRIVAL/);
    expect(sql).not.toMatch(/\bSLO\b|DATA_RETENTION_TIME_IN_DAYS|CREATE ROLE|GRANT\b/i);
  });
});

/** quality.ts の analysisDisclosure が storeId / period に何を入れているか。 */
function disclosureSource(names: readonly string[]): readonly string[] {
  const body = qualitySource.match(/analysisDisclosure: \{([\s\S]*?)\n    \},/)![1]!;
  return names.map((name) => body.match(new RegExp(`${name}:\\s*([\\w.]+),`))![1]!);
}
