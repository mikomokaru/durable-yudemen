-- Operation History — firstObservedAt と firstSnowflakeAt の関連付け（operation-history-log タスク 13.1）
-- 要件: 5.3 / 5.4 / 5.6 / 6.1
--
-- 所有者は Data Platform である。01-raw-arrival-ingest.sql の後に実行する。
--
-- この view が作るのは要件 6.1 の関連付けだけである。すなわち「初めて Observed_Telemetry になった時刻」と
-- 「初回 Snowflake 到達時刻」を record ごとに並べる。到達総数、重複数、欠落／孤児／競合、品質率、SLO 判定は
-- ここで作らない（タスク 13.2 / 13.3 / 13.4。定義の正本は src/operation-history/correlation.ts、
-- quality.ts、slo.ts であり、SQL 側で読み替えて別定義を作らない）。
--
-- 同一 record の判定はここでは canonical bytes の一致だけを使う。同じ bytes は同じ Operation Record である
-- ことが codec の canonical 性から従うため、相関判定を持ち込まずに済む。一次相関 key
-- (storeId, timerId, operationKind, eventTime) 単位の収束と、両立しない既知属性値の競合判定は
-- correlation.ts の定義どおりタスク 13.2 が配線する。
--
-- raw arrival は集約しても削除しない。この view は OPERATION_RAW_ARRIVAL を読むだけである（要件 5.7）。

CREATE VIEW IF NOT EXISTS OPERATION_HISTORY.RAW.OPERATION_TELEMETRY_FIRST_ARRIVAL
COMMENT = 'record ごとの firstObservedAt と firstSnowflakeAt の関連付け（要件 6.1）'
AS
SELECT
  CANONICAL_LINE,
  -- 曖昧性解消の補助情報。Operation Record の identity、連番、Timer 永続 identity ではない（要件 5.3 / 5.4）。
  -- Consumer が R2 customMetadata へ入れた canonicalHash は Snowflake から読めないため、同じ canonical
  -- 一行から同じ SHA-256 を再計算する（src/data-platform/raw-arrival-consumer.ts の canonicalLineHash と同値）。
  SHA2(CANONICAL_LINE, 256) AS CANONICAL_HASH,
  -- Tail Worker が初めて観測した時刻。epoch millisecond を TIMESTAMP_LTZ へ写す（scale 3 = millisecond）。
  TO_TIMESTAMP_LTZ(MIN(FIRST_OBSERVED_AT), 3) AS FIRST_OBSERVED_AT,
  -- 初回 Snowflake 到達時刻。重複到達のうち最も早い取込時刻である。
  MIN(SNOWFLAKE_ARRIVED_AT) AS FIRST_SNOWFLAKE_AT
FROM OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL
GROUP BY CANONICAL_LINE;
