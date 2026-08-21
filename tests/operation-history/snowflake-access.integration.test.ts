// 承認済み／未承認アクセスと、拒否後の不変を貫く統合テスト。タスク 13.7 の第三の柱。
//
// Snowflake の access 制御は外部サービスが評価する。ゆえにここで動かすのは、宣言的正本
// （config/operation-history-snowflake/08-access-control.sql の grant）と、01〜07 が実際に作る object の
// 対応だけである。既定拒否（grant の無い主体は読めない）は Snowflake の規則そのものであり、この test は
// その規則の下で「08 の grant が 01〜07 の全 object を覆うか」「覆わない主体が一つも読めないか」を見る。
// 実 role member への適用と実際の拒否は docs/operation-history/snowflake-access-procedure.md の
// ユーザー実行手順が確かめる。
//
// 既存検査との分担（重複を作らない）:
//   - snowflake-access.static.test.ts … 08 単体の形（分類の一値、被与者一つ、権限二つ、DML 不在）。
//   - ここ … 01〜07 が作る object の集合と 08 の grant の突き合わせ、および拒否の前後で読める内容が
//     変わらないこと。層を足したのに grant が追いつかない、という層を跨いだ齟齬はここでだけ出る。
//
// _Requirements: 6.10, 6.11, 6.12_

import { afterEach, describe, expect, it, vi } from "vitest";
import accessSql from "../../config/operation-history-snowflake/08-access-control.sql?raw";
import ingestSql from "../../config/operation-history-snowflake/01-raw-arrival-ingest.sql?raw";
import associationSql from "../../config/operation-history-snowflake/02-first-arrival-association.sql?raw";
import correlationSql from "../../config/operation-history-snowflake/03-correlation-and-convergence.sql?raw";
import qualitySql from "../../config/operation-history-snowflake/04-quality-rates-and-trusted-analysis.sql?raw";
import disclosureSql from "../../config/operation-history-snowflake/05-best-effort-disclosure.sql?raw";
import sloSql from "../../config/operation-history-snowflake/06-arrival-slo-and-notification.sql?raw";
import retentionSql from "../../config/operation-history-snowflake/07-retention.sql?raw";
import { tryWriteOperationLines } from "../../src/operation-history/producer";
import { operationArrivalQualityFromEvidence } from "../../src/operation-history/correlation";
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
import { arrivalEvidence, snowpipeIngest } from "./support/snowpipe";

const DATABASE = "OPERATION_HISTORY";

/** `--` 行コメントを除いた SQL 本文。コメント中の語を object や grant と読まないため。 */
const activeSql = (sql: string): string =>
  sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

/** 08 が宣言する grant。（権限, 対象, 被与者）だけを読む。 */
const grants = [...activeSql(accessSql).matchAll(/GRANT\s+(\w+)\s+ON\s+(.+?)\s+TO ROLE (\S+);/g)]
  .map(([, privilege, target, grantee]) => ({
    privilege: privilege!,
    target: target!.trim(),
    grantee: grantee!,
  }));
const [analystRole] = /CREATE ROLE IF NOT EXISTS (\S+)/.exec(activeSql(accessSql))!.slice(1) as [string];

type ObjectKind =
  | "DATABASE" | "SCHEMA" | "FILE FORMAT" | "STAGE" | "TABLE" | "VIEW"
  | "PIPE" | "FUNCTION" | "TASK" | "ALERT" | "PROCEDURE" | "TAG";

/** 01〜07 が実際に作る object の目録。層を足すたびにここが増える。 */
const inventory = Object.entries({
  "01-raw-arrival-ingest": ingestSql,
  "02-first-arrival-association": associationSql,
  "03-correlation-and-convergence": correlationSql,
  "04-quality-rates-and-trusted-analysis": qualitySql,
  "05-best-effort-disclosure": disclosureSql,
  "06-arrival-slo-and-notification": sloSql,
  "07-retention": retentionSql,
}).flatMap(([layer, sql]) =>
  [
    ...activeSql(sql).matchAll(
      /CREATE (?:OR REPLACE )?(DATABASE|SCHEMA|FILE FORMAT|STAGE|TABLE|VIEW|PIPE|FUNCTION|TASK|ALERT|PROCEDURE|TAG)(?: IF NOT EXISTS)? ([A-Z0-9_.]+)/g,
    ),
  ].map(([, kind, name]) => ({ layer, kind: kind as ObjectKind, name: name! })),
);

/** 読むために要る権限。table / view は SELECT、関数の呼出しと階層の通過は USAGE である。 */
const readPrivilege: Partial<Record<ObjectKind, "SELECT" | "USAGE">> = {
  DATABASE: "USAGE",
  SCHEMA: "USAGE",
  TABLE: "SELECT",
  VIEW: "SELECT",
  FUNCTION: "USAGE",
};
const plural: Partial<Record<ObjectKind, string>> = {
  SCHEMA: "SCHEMAS",
  TABLE: "TABLES",
  VIEW: "VIEWS",
  FUNCTION: "FUNCTIONS",
};

const granted = (role: string, privilege: string, target: string): boolean =>
  grants.some((grant) =>
    grant.grantee === role && grant.privilege === privilege && grant.target === target
  );

/**
 * ある主体がある object を読めるか。Snowflake の既定拒否に従い、grant で覆われていなければ拒否である。
 * 08 は拒否のための文を持たないため、拒否は「許可の不在」以外の何物でもない（要件 6.12）。
 */
function readAccess(role: string, object: { readonly kind: ObjectKind; readonly name: string }) {
  const privilege = readPrivilege[object.kind];
  if (privilege === undefined) {
    // stage / pipe / task / alert / procedure は運用者の領域である。読む役には与えない。
    return { decision: "denied", reason: "not-a-read-target" } as const;
  }
  const throughDatabase = granted(role, "USAGE", `DATABASE ${DATABASE}`);
  const throughSchema = object.kind === "DATABASE"
    || granted(role, "USAGE", `ALL SCHEMAS IN DATABASE ${DATABASE}`);
  const onObject = object.kind === "DATABASE" || object.kind === "SCHEMA"
    || granted(role, privilege, `ALL ${plural[object.kind]} IN DATABASE ${DATABASE}`);

  return throughDatabase && throughSchema && onObject
    ? ({ decision: "allowed", privilege } as const)
    : ({ decision: "denied", reason: "no-grant" } as const);
}

const STORE_ID = "store-1";
const OBSERVED_AT = START_TIME + BOIL_DURATION + 30_000;

/** 承認済み分析担当者が読む対象の実体。R2 fixture 一件から作る。 */
async function readableContent() {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  // 同一テスト内で二度呼ぶ場合も、この呼出しが出した行だけを材料にする。
  log.mockClear();
  tryWriteOperationLines(true, {
    storeId: STORE_ID,
    eventTime: START_TIME,
    eventKind: "Start",
    before: timerStateOf([]),
    after: timerStateOf([producerTimer("readable", null, 0)]),
  });
  const lines = log.mock.calls.map((call) => call[0] as string);

  vi.spyOn(Date, "now").mockReturnValue(OBSERVED_AT);
  const pipeline = await runTailToR2([
    tailEvent(PRODUCER_SCRIPT, lines.map((line) => ({ level: "log", message: [line] }))),
  ]);
  const arrivals = await snowpipeIngest(pipeline.stored, {
    putAt: OBSERVED_AT,
    snowflakeArrivedAt: () => OBSERVED_AT + 60_000,
  });
  const quality = operationArrivalQualityFromEvidence(arrivalEvidence(arrivals), []);

  return {
    // Operation Record（raw arrival）。
    records: arrivals.map(({ canonicalLine, objectKey }) => ({ canonicalLine, objectKey })),
    // 品質指標と分析結果。
    assessment: operationQualityAssessmentFromCounts({
      storeId: STORE_ID,
      period: "2023-11-14",
      counts: {
        expectedLifecycleRecordCount: 0,
        missingLifecycleRecordCount: 0,
        arrivalCount: quality.rawArrivals.length,
        duplicateArrivalCount: 0,
        convergedRecordCount: quality.convergedRecords.length,
        orphanRecordCount: quality.quality.orphan.length,
        primaryCandidateCount: quality.convergedRecords.length,
        conflictingPrimaryCandidateCount: quality.quality.conflict.length,
      },
      thresholds: {
        lifecycleMissingRate: 0.2,
        duplicateRate: 0.2,
        orphanRate: 0.2,
        conflictRate: 0.2,
      },
    }),
    // アクセス承認状態（role member ではなく、role が持つ許可の集合）。
    approval: grants.filter((grant) => grant.grantee === analystRole),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// Requirements 6.10, 6.11
describe("承認済み分析担当者のアクセス", () => {
  it("01〜07 が作る record・品質指標・分析結果の object をすべて読める", () => {
    const readTargets = inventory.filter(({ kind }) => readPrivilege[kind] !== undefined);
    const denied = readTargets.filter(
      (object) => readAccess(analystRole, object).decision !== "allowed",
    );

    expect(readTargets.length).toBeGreaterThan(0);
    // 一つでも覆われない object があれば、承認済み分析担当者から見えない層がある（要件 6.11 の未達）。
    expect(denied.map((object) => `${object.layer}: ${object.kind} ${object.name}`)).toEqual([]);
  });

  it("要件が挙げる三つの対象が実在の object として読める", () => {
    for (const name of [
      // Operation Record
      `${DATABASE}.RAW.OPERATION_RAW_ARRIVAL`,
      // 品質指標
      `${DATABASE}.ANALYSIS.OPERATION_QUALITY_RATE`,
      // 分析結果（best-effort 表示と月次到達 SLO）
      `${DATABASE}.ANALYSIS.OPERATION_ANALYSIS_DISCLOSURE`,
      `${DATABASE}.ANALYSIS.OPERATION_ARRIVAL_SLO`,
    ]) {
      const object = inventory.find((candidate) => candidate.name === name);
      expect(object, `${name} が 01〜07 に無い`).toBeDefined();
      expect(readAccess(analystRole, object!).decision).toBe("allowed");
    }
  });

  it("これから足す層も覆う（ALL と FUTURE が対になっている）", () => {
    const readKinds = new Set(
      inventory.filter(({ kind }) => plural[kind] !== undefined).map(({ kind }) => kind),
    );

    for (const kind of readKinds) {
      const privilege = readPrivilege[kind]!;
      expect(granted(analystRole, privilege, `ALL ${plural[kind]} IN DATABASE ${DATABASE}`)).toBe(true);
      expect(granted(analystRole, privilege, `FUTURE ${plural[kind]} IN DATABASE ${DATABASE}`)).toBe(true);
    }
  });

  it("承認済みでも運用者の object は読む対象にならない", () => {
    const operational = inventory.filter(({ kind }) =>
      ["STAGE", "PIPE", "TASK", "ALERT", "PROCEDURE", "FILE FORMAT", "TAG"].includes(kind)
    );

    expect(operational.length).toBeGreaterThan(0);
    for (const object of operational) {
      expect(readAccess(analystRole, object)).toEqual({
        decision: "denied",
        reason: "not-a-read-target",
      });
    }
    // 与えられている権限は SELECT と USAGE の二つだけである（record も指標も変えられない）。
    expect([...new Set(grants.map((grant) => grant.privilege))].sort()).toEqual(["SELECT", "USAGE"]);
  });
});

// Requirements 6.12
describe("未承認主体のアクセスと拒否後の不変", () => {
  it("承認済み role 以外は一つも読めない", () => {
    // PUBLIC は全 user が持つ既定の role である。ここへ一つも grant が無いことが既定拒否の要点である。
    for (const subject of ["PUBLIC", "OPERATION_HISTORY_OPERATOR", ""]) {
      const allowed = inventory.filter((object) => readAccess(subject, object).decision === "allowed");
      expect(allowed, `${subject} が読める object がある`).toEqual([]);
    }
  });

  it("拒否は record・品質指標・分析結果・承認状態を変えない", async () => {
    const before = structuredClone(await readableContent());
    const analystView = inventory.map((object) => readAccess(analystRole, object));

    // 未承認主体が全 object へアクセスを要求する。拒否の評価は読むだけで、何も書かない。
    const decisions = inventory.map((object) => readAccess("PUBLIC", object).decision);
    const after = await readableContent();

    expect(new Set(decisions)).toEqual(new Set(["denied"]));
    expect(after.records).toEqual(before.records);
    expect(after.assessment).toEqual(before.assessment);
    expect(after.approval).toEqual(before.approval);
    // 承認済み分析担当者から見える範囲も拒否の前後で同じである。
    expect(inventory.map((object) => readAccess(analystRole, object))).toEqual(analystView);
  });
});
