// R2 の raw arrival を Snowflake 側の「一到達一行」へ写す、テスト側の取込。
//
// Snowpipe と Snowflake は外部サービスゆえローカルでは実行できない。SQL 正本は
// config/operation-history-snowflake/01〜08 であり、適用は docs/operation-history/*.md の
// ユーザー実行手順が担う。ここが担うのは、実行できない層を跨いで R2 fixture から純粋層
// （correlation.ts / quality.ts / slo.ts）まで貫くための配線だけである。次の規律を守る。
//
//   1. **文法をテスト側に書かない。** object key から観測側 metadata を取る正規表現は
//      01-raw-arrival-ingest.sql の文字列 literal をそのまま読む。key を作る側の正本は
//      src/data-platform/raw-arrival-consumer.ts であり、両者の一致は
//      snowflake-ingest.static.test.ts が検査する。ここで三つ目の文法を作らない。
//   2. **判定を持ち込まない。** 取込は canonical 一行（到達した bytes のまま）と観測側 metadata を
//      別の値として並べるだけである（要件 5.4）。相関、重複収束、品質、SLO の判定は純粋層が行う。
//   3. **取込時刻は入力である。** 各到達の Snowflake 到達時刻は呼ぶ側の clock が決める（要件 6.1）。
//   4. **canonical hash は bytes から再計算する。** 02-first-arrival-association.sql の
//      SHA2(CANONICAL_LINE, 256) と同じく、identity ではなく曖昧性解消の補助情報として持つ
//      （要件 5.3 / 5.4）。

import ingestSql from "../../../config/operation-history-snowflake/01-raw-arrival-ingest.sql?raw";
import { parseOperationLines } from "../../../src/operation-history/codec";
import { canonicalLineHash } from "../../../src/data-platform/raw-arrival-consumer";
import type { OperationRecord } from "../../../src/operation-history/record";

/** `--` 行コメントを除いた SQL 本文。コメント中の語から文法を読まないため。 */
const activeIngestSql = ingestSql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

/**
 * 01 が object key から観測側 metadata を取る正規表現。SQL の literal では backslash が二重ゆえ、
 * 一重へ戻して JS の RegExp にする。group 1 / 2 / 3 が firstObservedAt / queueMessageId /
 * deliveryAttempt である（末尾一致ゆえ stage 相対 key でも完全 key でも同じ値を取る）。
 */
const objectKeyMetadata = new RegExp(
  /METADATA\$FILENAME, '([^']+)'/.exec(activeIngestSql)![1]!.replace(/\\\\/g, "\\"),
);

/** Snowflake の OPERATION_RAW_ARRIVAL 一行。canonical と観測側 metadata を別の値として持つ。 */
export type RawArrival = {
  readonly canonicalLine: string;
  readonly record: OperationRecord;
  readonly canonicalHash: string;
  readonly objectKey: string;
  readonly firstObservedAt: number | null;
  readonly queueMessageId: string | null;
  readonly deliveryAttempt: number | null;
  readonly r2LastModifiedAt: number;
  /** null は「R2 まで到達したが未取込」である（06 の OPERATION_PENDING_ARRIVAL が見る状態）。 */
  readonly snowflakeArrivedAt: number | null;
};

/** テスト側 R2 の書込値（`canonical|producerScript`）から canonical bytes を戻す。 */
export function storedCanonicalLine(write: string): string {
  return write.slice(0, write.lastIndexOf("|"));
}

/**
 * R2 に保存された raw object を、Snowflake の一到達一行へ取り込む。重複配送は key が異なるため
 * 別 object であり、n 件の到達は n 行として残る（要件 5.5 / 5.7）。
 */
export async function snowpipeIngest(
  stored: ReadonlyMap<string, readonly string[]>,
  clock: Readonly<{
    putAt: number;
    snowflakeArrivedAt: (
      arrival: Readonly<{ objectKey: string; canonicalLine: string }>,
    ) => number | null;
  }>,
): Promise<readonly RawArrival[]> {
  const arrivals: RawArrival[] = [];

  for (const [objectKey, writes] of stored) {
    for (const write of writes) {
      const canonicalLine = storedCanonicalLine(write);
      const [parsed] = parseOperationLines(canonicalLine);
      if (parsed === undefined || !parsed.ok) {
        throw new Error(`fixture の canonical 一行が canonical ではない: ${canonicalLine}`);
      }
      const metadata = objectKeyMetadata.exec(objectKey);

      arrivals.push({
        canonicalLine,
        record: parsed.record,
        canonicalHash: await canonicalLineHash(canonicalLine),
        objectKey,
        firstObservedAt: metadata === null ? null : Number(metadata[1]),
        queueMessageId: metadata?.[2] ?? null,
        deliveryAttempt: metadata === null ? null : Number(metadata[3]),
        r2LastModifiedAt: clock.putAt,
        snowflakeArrivedAt: clock.snowflakeArrivedAt({ objectKey, canonicalLine }),
      });
    }
  }

  return arrivals;
}

/** 相関・品質の入力。canonical hash は補助情報として添えるだけである（要件 5.3 / 5.4）。 */
export function arrivalEvidence(arrivals: readonly RawArrival[]) {
  return arrivals.map(({ record, canonicalHash }) => ({ record, canonicalHash }));
}

/**
 * 到達 SLO の入力。firstObservedAt は object key 由来の観測値、firstSnowflakeAt は取込時刻である。
 * 同一 record の複数到達の収束（初回の採用）は slo.ts が行うため、ここでは畳まない。
 */
export function observedArrivals(arrivals: readonly RawArrival[]) {
  return arrivals.map(({ record, firstObservedAt, snowflakeArrivedAt }) => {
    if (firstObservedAt === null) {
      throw new Error(`object key から初回観測時刻を読めない: ${record.timerId}`);
    }
    return { record, firstObservedAt, firstSnowflakeAt: snowflakeArrivedAt };
  });
}
