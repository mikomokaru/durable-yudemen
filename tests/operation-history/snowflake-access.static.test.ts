// 機密業務データの分類と承認済み分析担当者への access 制御の静的検査。タスク 13.6。
//
// Snowflake はローカルでは適用できない。ここで固定するのは、適用できなくても壊れていると分かる点である。
//   1. 分類の語が一つであること。tag の許可値が一値で、database へ一度だけ付き、他の層が別の分類語を
//      持たないこと（要件 6.10）。
//   2. 読める主体が承認済み role 一つだけであること。PUBLIC も他の role も grantee に現れないこと
//      （要件 6.11）。
//   3. 読める範囲を object で列挙せず、database 単位の ALL と FUTURE で覆うこと。schema 単位の future grant を
//      併置しないこと（Snowflake は schema 側を優先し、覆う範囲が静かに縮む。要件 6.11）。
//   4. 与える権限が SELECT と USAGE だけであること。承認済みでもデータを変えられないこと（要件 6.12）。
//   5. 拒否が read-only であること。08 が DML を持たず、アクセス要求を契機に走る object（task / alert /
//      procedure / stream）を作らないこと。ゆえに拒否で record、品質指標、分析結果、アクセス承認状態の
//      いずれも変わらない（要件 6.12）。
//   6. アクセス承認状態（role member）と承認済み分析担当者の実名がリポジトリに無いこと（credential と同じ
//      規律）。
//   7. access の正本が 08 一つであること。01〜07 は GRANT / REVOKE / CREATE ROLE を持たず、08 は取込・品質・
//      表示・SLO・保持を作り直さないこと。
//   8. Producer 設定へ role も grant も持ち込まないこと（要件 4.10 / 4.13 / 4.14）。
//
// 判定値はテスト側に書かない。role 名も分類値も SQL から読み、その値で境界を確かめる。

import { describe, expect, it } from "vitest";
import accessSql from "../../config/operation-history-snowflake/08-access-control.sql?raw";
import ingestSql from "../../config/operation-history-snowflake/01-raw-arrival-ingest.sql?raw";
import associationSql from "../../config/operation-history-snowflake/02-first-arrival-association.sql?raw";
import correlationSql from "../../config/operation-history-snowflake/03-correlation-and-convergence.sql?raw";
import qualitySql from "../../config/operation-history-snowflake/04-quality-rates-and-trusted-analysis.sql?raw";
import disclosureSql from "../../config/operation-history-snowflake/05-best-effort-disclosure.sql?raw";
import sloSql from "../../config/operation-history-snowflake/06-arrival-slo-and-notification.sql?raw";
import retentionSql from "../../config/operation-history-snowflake/07-retention.sql?raw";
import snowflakeReadme from "../../config/operation-history-snowflake/README.md?raw";
import procedure from "../../docs/operation-history/snowflake-access-procedure.md?raw";
import producerConfig from "../../wrangler.jsonc?raw";
import tailConfig from "../../wrangler.telemetry-tail.jsonc?raw";
import consumerConfig from "../../wrangler.raw-arrival-consumer.jsonc?raw";
import { jsoncToJson } from "./support/jsonc";

/** `--` 行コメントを除いた SQL 本文。コメント中の語で判定しないため。 */
const activeSql = (sql: string): string =>
  sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

const statements = activeSql(accessSql);

const matched = (pattern: RegExp, text = statements): readonly string[] => {
  const found = text.match(pattern);
  expect(found).not.toBeNull();
  return found!.slice(1);
};

/** 08 が作る access の主体。名前は SQL 側が持つ。 */
const [analystRole] = matched(/CREATE ROLE IF NOT EXISTS (\S+)/);
/** 分類 tag と、その唯一の許可値。 */
const [classificationTag, classificationValue] = matched(
  /CREATE TAG IF NOT EXISTS (\S+)\s+ALLOWED_VALUES '([^']+)'/,
);

/** 08 の GRANT 文を（権限, 対象, 被与者）へ開く。 */
const grants = [...statements.matchAll(/GRANT\s+(\w+)\s+ON\s+(.+?)\s+TO ROLE (\S+);/g)].map(
  ([, privilege, target, grantee]) => ({ privilege: privilege!, target: target!.trim(), grantee: grantee! }),
);

const earlierLayers = {
  "01-raw-arrival-ingest": ingestSql,
  "02-first-arrival-association": associationSql,
  "03-correlation-and-convergence": correlationSql,
  "04-quality-rates-and-trusted-analysis": qualitySql,
  "05-best-effort-disclosure": disclosureSql,
  "06-arrival-slo-and-notification": sloSql,
  "07-retention": retentionSql,
};

// Requirements 6.10
describe("個人情報ではない機密業務データとしての分類", () => {
  it("分類 tag の許可値は一つだけである", () => {
    expect(classificationTag).toBe("OPERATION_HISTORY.GOVERNANCE.DATA_CLASSIFICATION");
    // ALLOWED_VALUES が一値ゆえ、同じ database に第二の分類語を付けられない。
    expect(statements).toContain(`ALLOWED_VALUES '${classificationValue}'`);
    expect(statements).not.toMatch(new RegExp(`ALLOWED_VALUES '${classificationValue}'\\s*,`));
    expect(statements.match(/ALLOWED_VALUES/g)).toHaveLength(1);
  });

  it("許可値が「個人情報ではない」と「機密業務データである」の両方を言う", () => {
    expect(classificationValue).toContain("confidential-business");
    expect(classificationValue).toContain("non-personal");
  });

  it("分類は database へ一度だけ付ける（継承させ、object ごとに付け直さない）", () => {
    expect(statements).toContain(
      `ALTER DATABASE OPERATION_HISTORY\n  SET TAG ${classificationTag} = '${classificationValue}'`,
    );
    expect(statements.match(/SET TAG/g)).toHaveLength(1);
    // 個々の table / view へ付け直すと、付け忘れた object だけが分類の外へ落ちる。
    expect(statements).not.toMatch(/ALTER (?:TABLE|VIEW|SCHEMA)\s+\S+\s+SET TAG/);
  });

  it("分類 tag を置く schema は record も指標も持たない", () => {
    expect(statements).toContain("CREATE SCHEMA IF NOT EXISTS OPERATION_HISTORY.GOVERNANCE");
    expect(statements).not.toMatch(/CREATE (?:OR REPLACE )?(?:VIEW|TABLE|STAGE|PIPE|FILE FORMAT)\b/);
  });

  it("分類の語を他の層が持たない（正本を二つにしない）", () => {
    for (const [name, sql] of Object.entries(earlierLayers)) {
      expect(activeSql(sql), `${name} が分類を宣言する`).not.toMatch(/CREATE TAG|SET TAG|DATA_CLASSIFICATION/i);
    }
  });

  it("R2 複製にも同じ分類が及ぶことを手順書が確認する", () => {
    // 分類は保存先で変わらない。R2 側は公開経路を持たないことを確認する（要件 6.10）。
    expect(procedure).toContain("wrangler r2 bucket dev-url get operation-raw-arrivals");
    expect(procedure).toContain("wrangler r2 bucket domain list operation-raw-arrivals");
  });
});

// Requirements 6.11
describe("承認済み分析担当者だけが読める", () => {
  it("被与者は承認済み role 一つだけである", () => {
    expect(analystRole).toBe("OPERATION_HISTORY_ANALYST");
    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants) {
      expect(grant.grantee).toBe(analystRole);
    }
    // PUBLIC へ与えれば未承認主体が読めてしまう（要件 6.12 の既定拒否が崩れる）。
    expect(statements).not.toMatch(/TO ROLE (?:PUBLIC|ACCOUNTADMIN|SYSADMIN|SECURITYADMIN)\b/);
    expect(statements).not.toMatch(/TO (?:SHARE|APPLICATION ROLE|DATABASE ROLE)\b/);
  });

  it("役を分けない（承認状態を一つに保つ）", () => {
    expect(statements.match(/CREATE ROLE/g)).toHaveLength(1);
  });

  it("読める範囲を object で列挙せず database 単位の ALL と FUTURE で覆う", () => {
    const scopes = grants.map((grant) => grant.target);

    expect(scopes).toContain("DATABASE OPERATION_HISTORY");
    for (const kind of ["SCHEMAS", "TABLES", "VIEWS", "FUNCTIONS"]) {
      expect(scopes).toContain(`ALL ${kind} IN DATABASE OPERATION_HISTORY`);
      expect(scopes).toContain(`FUTURE ${kind} IN DATABASE OPERATION_HISTORY`);
    }
    // 個々の record / 指標 / 分析結果 object を列挙すると、層を足すたびに追記漏れが起きる。
    expect(statements).not.toMatch(/ON (?:TABLE|VIEW|FUNCTION)\s+OPERATION_HISTORY\./);
  });

  it("schema 単位の future grant を併置しない", () => {
    // Snowflake は schema 側の future grant を優先する。併置すると database 側の宣言が無視され、
    // 覆う範囲が静かに縮む。
    expect(statements).not.toMatch(/FUTURE \w+ IN SCHEMA/);
  });

  it("読むための compute を与え、warehouse はプレースホルダである", () => {
    const [warehouse] = matched(/GRANT USAGE ON WAREHOUSE (\S+) TO ROLE/);

    expect(warehouse).toMatch(/^<[A-Z_]+>$/);
    expect(snowflakeReadme).toContain(warehouse);
  });
});

// Requirements 6.12
describe("拒否は read-only である", () => {
  it("与える権限は SELECT と USAGE だけである", () => {
    for (const grant of grants) {
      expect(["SELECT", "USAGE"], `${grant.privilege} ON ${grant.target}`).toContain(grant.privilege);
    }
    expect(statements).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|OWNERSHIP|MODIFY|MONITOR|OPERATE|EXECUTE TASK|EXECUTE MANAGED TASK|APPLY|MANAGE GRANTS|ALL PRIVILEGES)\b/i,
    );
  });

  it("通知を送る procedure と task／alert の操作を与えない", () => {
    const scopes = grants.map((grant) => grant.target);

    for (const scope of scopes) {
      expect(scope).not.toMatch(/PROCEDURE|TASK|ALERT|STAGE|PIPE/i);
    }
  });

  it("08 は DML を持たない（アクセス要求で走る文が無い）", () => {
    expect(statements).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|COPY INTO|DROP)\b/i);
  });

  it("08 は拒否を契機に走る object を作らない", () => {
    expect(statements).not.toMatch(/CREATE (?:OR REPLACE )?(?:TASK|ALERT|PROCEDURE|STREAM|FUNCTION)\b/i);
    // 拒否の記録を table へ書けば、拒否が write になる。
    expect(statements).not.toMatch(/DENIED|DENIAL|ACCESS_LOG|AUDIT/i);
  });

  it("アクセス承認状態を SQL 正本が持たない", () => {
    // 承認状態は role member である。実名は credential と同じ規律で運用者が与える。
    expect(statements).not.toMatch(/GRANT ROLE|REVOKE ROLE|CREATE USER|ALTER USER|CREATE SECURITY INTEGRATION/i);
    for (const [name, sql] of Object.entries(earlierLayers)) {
      expect(activeSql(sql), `${name} が承認状態を持つ`).not.toMatch(/GRANT|REVOKE|CREATE ROLE/i);
    }
  });

  it("承認済み分析担当者の実名がリポジトリに無い", () => {
    const emailLike = /[\w.+-]+@[\w-]+\.[\w.-]+/;

    expect(accessSql).not.toMatch(emailLike);
    expect(procedure).not.toMatch(emailLike);
    // 手順書の GRANT ROLE ... TO USER は必ずプレースホルダである。
    for (const [, user] of procedure.matchAll(/TO USER (\S+);/g)) {
      expect(user).toMatch(/^<[A-Z_]+>$/);
    }
    for (const [, user] of procedure.matchAll(/FROM USER (\S+);/g)) {
      expect(user).toMatch(/^<[A-Z_]+>$/);
    }
  });

  it("手順書が拒否の前後で四つの不変を確認する", () => {
    for (const invariant of [
      "OPERATION_RAW_ARRIVAL",
      "OPERATION_QUALITY_RATE",
      "OPERATION_TRUSTED_ANALYSIS_SCOPE",
      "SHOW GRANTS OF ROLE OPERATION_HISTORY_ANALYST",
    ]) {
      expect(procedure).toContain(invariant);
    }
  });
});

describe("この層の責務境界", () => {
  it("取込・相関・品質率・表示・到達 SLO・保持を作り直さない", () => {
    expect(statements).not.toMatch(
      /OPERATION_RAW_ARRIVAL\b|OPERATION_QUALITY_|OPERATION_ARRIVAL_SLO|OPERATION_ANALYSIS_DISCLOSURE|RETENTION|DATA_RETENTION_TIME_IN_DAYS/,
    );
  });

  it("実行順が最後であることを README と手順書が記録する", () => {
    // ALL の grant は適用時点の object を覆う。01〜07 の後に実行しないと取り違える。
    expect(snowflakeReadme).toContain("`08-access-control.sql`");
    expect(snowflakeReadme).toContain("docs/operation-history/snowflake-access-procedure.md");
    expect(procedure).toContain("`08` は最後に実行する");
  });

  it("Producer と Data Platform の Worker 設定へ role も grant も持ち込まない", () => {
    for (const [name, config] of Object.entries({
      "wrangler.jsonc": producerConfig,
      "wrangler.telemetry-tail.jsonc": tailConfig,
      "wrangler.raw-arrival-consumer.jsonc": consumerConfig,
    })) {
      expect(jsoncToJson(config), `${name} が access 制御を持つ`).not.toMatch(
        /snowflake|analyst|classification|\bgrant\b/i,
      );
    }
  });
});
