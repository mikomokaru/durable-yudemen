// Snowflake 取込 SQL（config/operation-history-snowflake/）の静的検査。タスク 13.1。
//
// Snowflake は外部サービスゆえローカルでは実行できない。ここで検査するのは、実行できなくても壊れていると
// 分かる二点である。
//   1. object key の文法が Consumer（src/data-platform/raw-arrival-consumer.ts）と一致すること。key を作る
//      側と読む側で文法が二箇所にあるのは、Snowflake が R2 customMetadata を読めないための已むを得ない
//      重複であり、その一致を機械検査で固定する。
//   2. 取込 SQL が raw 保持の責務に留まり、canonical bytes を壊さず、到達数や品質率へ踏み込まないこと
//      （純粋層の定義を SQL 側で読み替えない）。

import { describe, expect, it } from "vitest";
import ingestSql from "../../config/operation-history-snowflake/01-raw-arrival-ingest.sql?raw";
import associationSql from "../../config/operation-history-snowflake/02-first-arrival-association.sql?raw";
import { printCanonicalOperationLine } from "../../src/operation-history/codec";
import type { OperationRecord } from "../../src/operation-history/record";
import type { OperationRecordMessage } from "../../src/data-platform/tail-worker";
import { rawArrivalObject } from "../../src/data-platform/raw-arrival-consumer";

/** `--` 行コメントを除いた SQL 本文。日本語コメント中の語で判定しないため。 */
function statements(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

/** 取込 SQL に書かれた object key の正規表現を、そのまま JS の RegExp として取り出す。 */
function objectKeyPatterns(): readonly string[] {
  return [
    ...statements(ingestSql).matchAll(/REGEXP_SUBSTR\(METADATA\$FILENAME, '([^']+)'/g),
  ].map(([, pattern]) => pattern!);
}

const canonicalLine = printCanonicalOperationLine({
  storeId: "store-1",
  timerId: "timer-1",
  operationKind: "completed",
  eventTime: 1 as OperationRecord["eventTime"],
  slotIds: ["slot-1"],
  noodleType: "Thin",
  firmness: "normal",
});

const message: OperationRecordMessage = {
  canonicalLine,
  firstObservedAt: Date.UTC(2026, 5, 26, 7, 8, 9),
  producerScript: "yude-men-timer",
};

// Requirements 5.3, 5.4, 5.5
describe("取込 SQL の object key 文法", () => {
  it("三つの列が同一の pattern から group 1 / 2 / 3 を取る", () => {
    const patterns = objectKeyPatterns();

    expect(patterns).toHaveLength(3);
    expect(new Set(patterns).size).toBe(1);
    expect(
      [...statements(ingestSql).matchAll(/REGEXP_SUBSTR\(METADATA\$FILENAME, '[^']+', 1, 1, 'e', (\d)\)/g)]
        .map(([, group]) => group),
    ).toEqual(["1", "2", "3"]);
  });

  it("Consumer が作る key から firstObservedAt / queueMessageId / deliveryAttempt を復元できる", () => {
    // SQL 文字列リテラル中の \\ は正規表現の \ 一個を表す。
    const pattern = new RegExp(objectKeyPatterns()[0]!.replace(/\\\\/g, "\\"));

    for (const [queueMessageId, deliveryAttempt] of [
      ["msg-1", 1],
      ["b0a1c2d3e4f5", 3],
      ["9f8e-7d6c-5b4a", 12],
    ] as const) {
      const { key } = rawArrivalObject(message, {
        queueMessageId,
        deliveryAttempt,
        arrivedAt: 1_800_000_000_000,
        canonicalHash: "abc",
      });

      // stage prefix が key に含まれる場合も含まれない場合も末尾一致で読める。
      for (const filename of [key, key.slice("raw/".length)]) {
        expect(filename.match(pattern)?.slice(1)).toEqual([
          `${message.firstObservedAt}`,
          queueMessageId,
          `${deliveryAttempt}`,
        ]);
      }
    }
  });
});

// Requirements 4.6, 5.7
describe("取込 SQL の責務境界", () => {
  it("canonical 一行を VARIANT へ parse せず、bytes を壊す file format 設定を持たない", () => {
    const sql = statements(ingestSql);

    expect(sql).not.toMatch(/PARSE_JSON/i);
    expect(sql).toMatch(/ESCAPE_UNENCLOSED_FIELD = NONE/);
    expect(sql).toMatch(/FIELD_OPTIONALLY_ENCLOSED_BY = NONE/);
    expect(sql).toMatch(/TRIM_SPACE = FALSE/);
  });

  it("S3 互換 stage の制約どおり AUTO_INGEST = FALSE で、credential を実値で持たない", () => {
    const sql = statements(ingestSql);

    expect(sql).toMatch(/AUTO_INGEST = FALSE/);
    expect(sql).toMatch(/AWS_KEY_ID = '<R2_ACCESS_KEY_ID>'/);
    expect(sql).toMatch(/AWS_SECRET_KEY = '<R2_SECRET_ACCESS_KEY>'/);
    expect(sql).toMatch(/ENDPOINT = '<R2_ACCOUNT_ID>\.r2\.cloudflarestorage\.com'/);
  });

  it("raw arrival を削除せず、到達数・重複数・品質率をこの段で算出しない", () => {
    for (const sql of [statements(ingestSql), statements(associationSql)]) {
      expect(sql).not.toMatch(/\b(?:DELETE|TRUNCATE|DROP)\b/i);
      expect(sql).not.toMatch(/COUNT\s*\(/i);
      expect(sql).not.toMatch(/DUPLICATE|ORPHAN|CONFLICT|MISSING|_RATE|THRESHOLD/i);
    }
  });
});
