// local config smoke（タスク 15.1）。設定と宣言的正本を跨いだ参照が解決していることだけを見る。
//
// 15.1 が挙げる項目のうち、既存検査が既に主張しているものはここへ書き写さない（同じ概念を二箇所で
// 定義しない）。担当は次のとおりである。
//   - root `tail_consumers` → 実在 Tail Worker 名、Tail の Queue producer、Consumer の Queue consumer／R2、
//     binding 名 ↔ Env 宣言、Queue 名の両側一致、`main` の実在 … `config-graph.static.test.ts`
//   - Producer root に Queue／R2 が無いこと、Tail／Consumer に `STORE_TIMER_DO`・Producer URL・
//     Service binding・DO stub が無いこと、Producer 逆呼出し edge 0 件 … `config-graph.static.test.ts`／
//     `no-wake.static.test.ts`（O1〜O6）／`reverse-path.integration.test.ts`（call trace）
//   - R2 lifecycle の 90 日と prefix ↔ 実 object key … `retention.static.test.ts`
//   - object key 文法 ↔ Consumer、stage の AUTO_INGEST／credential プレースホルダ … `snowflake-ingest.static.test.ts`
//   - 通知の判定値・属性・周期・fail closed … `snowflake-slo.static.test.ts`
//   - access role の grant の形と 01〜07 の object 目録との突き合わせ … `snowflake-access.static.test.ts`／
//     `snowflake-access.integration.test.ts`
//
// 残っているのは、そのどれも見ていない**正本を跨ぐ参照**である。ここが担うのは二点だけである。
//   1. R2 の保存先が三つの正本で同じ場所を指すこと。Consumer の R2 binding（書く側）、lifecycle の
//      prefix（消す側）、Snowpipe stage の URL（読む側）が同じ bucket と同じ prefix でなければ、書いた
//      object を取り込めず（要件 4.5 / 4.12）、90 日の保持が覆わない場所が生まれる（要件 6.7）。
//   2. Snowflake の完全修飾参照が実在の宣言へ解決し、かつ実行順（01→08）で先に宣言されること。
//      既存検査は参照名を文字列として含むことだけを見るため、**宣言側を改名しても緑のまま**になる。
//      Snowpipe stage（pipe → stage → file format）、通知（alert → procedure → 通知先 table）、
//      保持（task → view）、access（grant → database）の参照がここで閉じる（要件 6.8 / 6.11）。
//
// 参照は解決するが未デプロイでも壊れない形にしてある点は既存検査と同じ規律である。root の
// `tail_consumers` は段階的有効化のためコメントアウトされており、その突き合わせは
// `config-graph.static.test.ts` が「コメントを外した本文からも読む」形で持つ。ここでは触らない。
//
// _Requirements: 4.5, 4.12, 6.7, 6.8, 6.11_

import { describe, expect, it } from "vitest";
import ingestSql from "../../config/operation-history-snowflake/01-raw-arrival-ingest.sql?raw";
import associationSql from "../../config/operation-history-snowflake/02-first-arrival-association.sql?raw";
import correlationSql from "../../config/operation-history-snowflake/03-correlation-and-convergence.sql?raw";
import qualitySql from "../../config/operation-history-snowflake/04-quality-rates-and-trusted-analysis.sql?raw";
import disclosureSql from "../../config/operation-history-snowflake/05-best-effort-disclosure.sql?raw";
import sloSql from "../../config/operation-history-snowflake/06-arrival-slo-and-notification.sql?raw";
import retentionSql from "../../config/operation-history-snowflake/07-retention.sql?raw";
import accessSql from "../../config/operation-history-snowflake/08-access-control.sql?raw";
import lifecycleJson from "../../config/operation-history-r2/raw-arrival-lifecycle.json?raw";
import consumerConfig from "../../wrangler.raw-arrival-consumer.jsonc?raw";
import { jsoncToJson } from "./support/jsonc";

/** `--` 行コメントを除いた SQL 本文。コメント中の名前を参照や宣言と読まないため。 */
const activeSql = (sql: string): string =>
  sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

/** 適用の実行順（README「ファイル」表と Rollout order）。添字がそのまま順序である。 */
const layers = [
  ["01-raw-arrival-ingest", ingestSql],
  ["02-first-arrival-association", associationSql],
  ["03-correlation-and-convergence", correlationSql],
  ["04-quality-rates-and-trusted-analysis", qualitySql],
  ["05-best-effort-disclosure", disclosureSql],
  ["06-arrival-slo-and-notification", sloSql],
  ["07-retention", retentionSql],
  ["08-access-control", accessSql],
].map(([layer, sql]) => ({ layer: layer!, sql: activeSql(sql!) }));

const sloLayer = layers.find(({ layer }) => layer.startsWith("06"))!.sql;

/** 完全修飾名。末尾の `\b` が `OPERATION_HISTORY_ANALYST` や `<OPERATION_HISTORY_WAREHOUSE>` を除ける。 */
const qualifiedName = /\bOPERATION_HISTORY(?:\.[A-Z0-9_]+)*\b/g;

const declarationKinds = [
  "DATABASE",
  "SCHEMA",
  "FILE FORMAT",
  "STAGE",
  "TABLE",
  "VIEW",
  "PIPE",
  "FUNCTION",
  "TASK",
  "ALERT",
  "PROCEDURE",
  "TAG",
] as const;
type DeclarationKind = (typeof declarationKinds)[number];

const declaration = new RegExp(
  `CREATE (?:OR REPLACE )?(${declarationKinds.join("|")})(?: IF NOT EXISTS)? (OPERATION_HISTORY(?:\\.[A-Z0-9_]+)*)\\b`,
  "g",
);

/** 宣言された object。名前 → 種別と、それを宣言する層の順序。 */
const declarations = new Map<string, { readonly kind: DeclarationKind; readonly order: number }>();
for (const [order, { sql }] of layers.entries()) {
  for (const [, kind, name] of sql.matchAll(declaration)) {
    if (!declarations.has(name!)) declarations.set(name!, { kind: kind as DeclarationKind, order });
  }
}

/**
 * 参照。宣言の `CREATE ... <名前>` を落とした残りに現れる完全修飾名がすべて参照である
 * （`ALTER`・`FROM`・`@stage`・`CALL`・`GRANT ... ON` を種別ごとに列挙せずに済む）。
 */
const references = layers.flatMap(({ layer, sql }, order) =>
  [...sql.replace(declaration, "").matchAll(qualifiedName)].map((match) => ({
    layer,
    order,
    name: match[0],
  })),
);

// Requirements 4.5, 4.12, 6.7
describe("R2 の保存先 — 書く側・消す側・読む側が同じ場所を指す", () => {
  const stages = layers.flatMap(({ layer, sql }) =>
    [...sql.matchAll(/CREATE STAGE(?: IF NOT EXISTS)? (\S+)\s+URL = '([^']+)'/g)].map(
      ([, name, url]) => ({ layer, name: name!, url: url! }),
    ),
  );
  const consumerBucket = (
    JSON.parse(jsoncToJson(consumerConfig)) as {
      readonly r2_buckets: readonly { readonly bucket_name: string }[];
    }
  ).r2_buckets[0]!.bucket_name;
  const lifecyclePrefix = (
    JSON.parse(lifecycleJson) as {
      readonly rules: readonly { readonly conditions: { readonly prefix?: string } }[];
    }
  ).rules[0]!.conditions.prefix!;

  it("R2 の位置を宣言する stage は一つだけである", () => {
    // 二つ目の stage は、lifecycle が覆わない場所や Consumer が書かない場所を静かに増やす。
    expect(stages.map(({ layer, name }) => `${layer}: ${name}`)).toHaveLength(1);
    // s3compat の URL も一箇所だけである（別 bucket を指す URL が他層に無い）。
    expect(
      layers.flatMap(({ sql }) =>
        [...sql.matchAll(/s3compat:\/\/([^/'\s]+)/g)].map(([, bucket]) => bucket),
      ),
    ).toEqual([consumerBucket]);
  });

  it("stage の bucket が Consumer の R2 binding の bucket と一致する", () => {
    const [, bucket] = /^s3compat:\/\/([^/]+)\/(.*)$/.exec(stages[0]!.url)!;

    expect(bucket).toBe(consumerBucket);
  });

  it("stage の prefix が lifecycle の prefix と一致する", () => {
    // lifecycle の prefix と実 object key の一致は retention.static.test.ts が持つ。ゆえに三者
    // （書く側・消す側・読む側）がここで閉じる。
    const [, , prefix] = /^s3compat:\/\/([^/]+)\/(.*)$/.exec(stages[0]!.url)!;

    expect(prefix).toBe(lifecyclePrefix);
  });
});

// Requirements 6.8, 6.11
describe("Snowflake 宣言の参照整合", () => {
  it("参照がすべて実在の宣言へ解決する", () => {
    expect(references.length).toBeGreaterThan(0);
    expect(
      references
        .filter(({ name }) => !declarations.has(name))
        .map(({ layer, name }) => `${layer}: ${name} が宣言されていない`),
    ).toEqual([]);
  });

  it("参照は自層または先行層で宣言される", () => {
    // 実行順は README の表と Rollout order で固定されている。後の層で宣言される object を先の層が
    // 参照すると、順に適用した時点で壊れる。未解決の参照は上の主張が扱う（ここでは順序だけを見る）。
    const resolved = references.flatMap(({ layer, order, name }) => {
      const declared = declarations.get(name);
      return declared === undefined ? [] : [{ layer, order, name, declaredAt: declared.order }];
    });
    const crossLayer = resolved.filter(({ order, declaredAt }) => declaredAt < order);

    expect(
      resolved
        .filter(({ order, declaredAt }) => declaredAt > order)
        .map(({ layer, name }) => `${layer}: ${name} は後の層で宣言される`),
    ).toEqual([]);
    // 層を跨ぐ参照が現にあってこそ、この主張は空虚でない。
    expect(crossLayer.length).toBeGreaterThan(0);
  });

  it("通知の三段（alert → procedure → 通知先）が実在の宣言で閉じる", () => {
    const alertBody = sloLayer.slice(sloLayer.indexOf("CREATE ALERT"));
    const [, called] = /THEN\s+CALL\s+(OPERATION_HISTORY(?:\.[A-Z0-9_]+)*)\s*\(/.exec(alertBody)!;
    const declared = `PROCEDURE ${called}`;
    const procedureStart = sloLayer.indexOf(declared) + declared.length;
    const procedureBody = sloLayer.slice(procedureStart, sloLayer.indexOf("$$;", procedureStart));

    expect(declarations.get(called!)?.kind).toBe("PROCEDURE");
    // procedure が読み書きする先はすべて実在の table・view である（帯の記憶と通知先を含む）。
    const touched = [
      ...new Set([...procedureBody.matchAll(qualifiedName)].map((match) => match[0])),
    ];
    expect(touched.length).toBeGreaterThan(0);
    for (const name of touched) {
      expect(["TABLE", "VIEW"], `${name} は procedure が触れる対象ではない`).toContain(
        declarations.get(name)?.kind,
      );
    }
  });
});
