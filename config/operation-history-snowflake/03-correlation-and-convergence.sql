-- Operation History — 相関、重複収束、欠落／孤児／競合／重複（operation-history-log タスク 13.2）
-- 要件: 5.1 / 5.2 / 5.3 / 5.4 / 5.5 / 5.6 / 5.7
--
-- 所有者は Data Platform である。01-raw-arrival-ingest.sql の後に実行する（手順は
-- docs/operation-history/snowflake-quality-procedure.md）。Producer 設定の SSOT（root wrangler.jsonc）へ
-- Snowflake への能力を一切足さない（要件 4.10 / 4.13 / 4.14）。
--
-- 定義の正本は src/operation-history/correlation.ts である。この層はその定義を SQL へ写すだけで、
-- 読み替えて別定義を作らない。対応は次のとおり。
--   correlationCandidatesFromOperationEvidence … OPERATION_CORRELATION_CANDIDATE
--   同一事実への収束（arrivalCount / duplicateCount） … OPERATION_CONVERGED_RECORD
--   quality.duplicate  … OPERATION_CONVERGED_RECORD.DUPLICATE_COUNT > 0
--   quality.orphan     … OPERATION_CONVERGED_RECORD.IS_ORPHAN
--   quality.conflict   … OPERATION_CORRELATION_CANDIDATE.TIMER_FACTS_CONSISTENT = FALSE
--   quality.missing    … OPERATION_EXPECTED_LIFECYCLE_RECORD.IS_MISSING
-- 四つの品質状態は互いに独立の列として残す（要件 5.6）。品質率と信頼判定は
-- 04-quality-rates-and-trusted-analysis.sql が quality.ts の定義から作る。
--
-- raw arrival は読むだけで、判定の前後で削除も上書きもしない（要件 5.7）。この層は view だけである。

CREATE SCHEMA IF NOT EXISTS OPERATION_HISTORY.ANALYSIS;

-- 一到達一行の raw を、canonical 既知属性と観測側の補助 metadata に開く。
--
-- canonical 一行は Tail Worker が既に codec で妥当性を確認した行だけが到達する（要件 4.3 / 4.4）。ゆえに
-- ここで parser の失敗分類を再実装しない。CANONICAL_LINE は到達した bytes のまま持ち回り、VARIANT から
-- 再直列化しない（属性順が正規化されて canonical bytes が失われる。要件 3.19 / 5.7）。
--
-- PERIOD は Operation Record 内の eventTime の UTC 暦日である。観測側時刻（FIRST_OBSERVED_AT /
-- SNOWFLAKE_ARRIVED_AT）は補助情報ゆえ期間の根拠にしない（要件 5.4）。
CREATE VIEW IF NOT EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL
COMMENT = 'raw 一到達を canonical 既知属性と観測側補助 metadata に開く（要件 5.1〜5.4）'
AS
SELECT
  -- canonical Operation Record の既知属性。名前と意味の正本は src/operation-history/record.ts。
  KNOWN:storeId::VARCHAR        AS STORE_ID,
  KNOWN:timerId::VARCHAR        AS TIMER_ID,
  KNOWN:operationKind::VARCHAR  AS OPERATION_KIND,
  KNOWN:eventTime::NUMBER       AS EVENT_TIME,
  -- slotIds は順序を保つ（要件 3.11）。VARIANT の配列を compact JSON 文字列として持つことで、順序を
  -- 保ったまま同値比較できる。
  TO_JSON(KNOWN:slotIds)        AS SLOT_IDS,
  KNOWN:noodleType::VARCHAR     AS NOODLE_TYPE,
  KNOWN:firmness::VARCHAR       AS FIRMNESS,
  KNOWN:startTime::NUMBER       AS START_TIME,
  KNOWN:endTime::NUMBER         AS END_TIME,
  KNOWN:boiledAt::NUMBER        AS BOILED_AT,
  -- 集計の期間割り当て。eventTime の UTC 暦日（NTZ ゆえ session timezone に依らない）。
  TO_CHAR(TO_TIMESTAMP_NTZ(KNOWN:eventTime::NUMBER, 3), 'YYYY-MM-DD') AS PERIOD,
  -- 到達した bytes そのまま。
  CANONICAL_LINE,
  -- 以下は曖昧性解消の補助情報。Operation Record の identity、連番、Timer 永続 identity ではない
  -- （要件 5.3 / 5.4）。一次相関候補の key にも収束の key にも使わない。
  SHA2(CANONICAL_LINE, 256)     AS CANONICAL_HASH,
  OBJECT_KEY,
  FIRST_OBSERVED_AT,
  QUEUE_MESSAGE_ID,
  DELIVERY_ATTEMPT,
  R2_LAST_MODIFIED_AT,
  SNOWFLAKE_ARRIVED_AT
FROM (
  SELECT arrival.*, PARSE_JSON(arrival.CANONICAL_LINE) AS KNOWN
  FROM OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL arrival
);

-- 同一事実へ収束した分析用の一件。到達総数 n と重複数 n - 1 を保持する（要件 5.5）。
--
-- 収束の key は correlation.ts と同じく「一次相関 key（storeId / timerId / operationKind / eventTime）
-- ＋ record 本体の Timer 事実（slotIds / noodleType / firmness と kind 別時刻）」である。canonical 表現が
-- 既知属性だけを固定順で表すため、この key の一致は canonical bytes の一致と同値になる。補助 metadata
-- （hash、object key、queue message id、delivery attempt）は key に入れない（要件 5.4）。
--
-- IS_ORPHAN は「観測済み boil-started へ相関できない」ことである。correlation.ts の recoverableStarts は
-- 既定で空であり、この経路に boil-started 以外の開始事実の出所はない。ゆえに開始の集合は観測できた
-- boil-started に一致する（要件 5.11）。判定は店舗×timer 単位で観測全体に対して行い、PERIOD は集計の
-- 割り当てにしか使わない。日境界を跨ぐ lifecycle を人工的に孤児にしないためである。
CREATE VIEW IF NOT EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_CONVERGED_RECORD
COMMENT = '重複収束後の分析用 record。到達総数と重複数と孤児判定を持つ（要件 5.5 / 5.6 / 5.11）'
AS
WITH CONVERGED AS (
  SELECT
    STORE_ID,
    TIMER_ID,
    OPERATION_KIND,
    EVENT_TIME,
    SLOT_IDS,
    NOODLE_TYPE,
    FIRMNESS,
    START_TIME,
    END_TIME,
    BOILED_AT,
    PERIOD,
    COUNT(*)                                       AS ARRIVAL_COUNT,
    COUNT(*) - 1                                   AS DUPLICATE_COUNT,
    -- 収束 key が同じ行は canonical bytes も同じゆえ、代表値を取っても bytes は失われない。
    ANY_VALUE(CANONICAL_LINE)                      AS CANONICAL_LINE,
    ANY_VALUE(CANONICAL_HASH)                      AS CANONICAL_HASH,
    -- 根拠 raw arrival への参照。削除しない raw を辿るための補助情報である（要件 5.7）。
    ARRAY_AGG(OBJECT_KEY) WITHIN GROUP (ORDER BY OBJECT_KEY) AS ARRIVAL_OBJECT_KEYS
  FROM OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL
  GROUP BY
    STORE_ID, TIMER_ID, OPERATION_KIND, EVENT_TIME,
    SLOT_IDS, NOODLE_TYPE, FIRMNESS, START_TIME, END_TIME, BOILED_AT,
    PERIOD
),
OBSERVED_START AS (
  SELECT DISTINCT STORE_ID, TIMER_ID
  FROM OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL
  WHERE OPERATION_KIND = 'boil-started'
)
SELECT
  CONVERGED.*,
  (CONVERGED.OPERATION_KIND <> 'boil-started' AND OBSERVED_START.TIMER_ID IS NULL) AS IS_ORPHAN
FROM CONVERGED
LEFT JOIN OBSERVED_START
  ON OBSERVED_START.STORE_ID = CONVERGED.STORE_ID
 AND OBSERVED_START.TIMER_ID = CONVERGED.TIMER_ID;

-- 一次相関候補。key は Store_Id、Timer_Id、Operation_Kind、Event_Time の四つだけである（要件 5.1）。
--
-- 候補の検証条件は record に含まれる Timer 事実の整合だけである（要件 5.2）。候補が収束後 record を
-- ちょうど一件だけ含むことが「全到達の Timer 事実が一致する」ことと同値ゆえ、両立しない既知属性値を
-- 持つ候補は二件以上を含む（要件 5.6 の競合）。
--
-- 補助情報（canonical hash、根拠 object key）は整合しない候補に限って残す。整合する候補では identity を
-- 名乗らせない（要件 5.3 / 5.4）。Cloudflare trace metadata は Snowflake から読めないため
-- （config/operation-history-snowflake/README.md「取込の前提」）、補助情報は hash と delivery identity である。
CREATE VIEW IF NOT EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_CORRELATION_CANDIDATE
COMMENT = '一次相関候補（四属性 key）と Timer 事実整合（要件 5.1 / 5.2 / 5.6）'
AS
SELECT
  STORE_ID,
  TIMER_ID,
  OPERATION_KIND,
  EVENT_TIME,
  PERIOD,
  SUM(ARRIVAL_COUNT)  AS ARRIVAL_COUNT,
  COUNT(*)            AS CONVERGED_RECORD_COUNT,
  COUNT(*) = 1        AS TIMER_FACTS_CONSISTENT,
  IFF(COUNT(*) = 1, NULL, ARRAY_AGG(CANONICAL_HASH) WITHIN GROUP (ORDER BY CANONICAL_HASH))
    AS AMBIGUITY_CANONICAL_HASHES,
  IFF(COUNT(*) = 1, NULL, ARRAY_FLATTEN(ARRAY_AGG(ARRIVAL_OBJECT_KEYS)))
    AS AMBIGUITY_ARRIVAL_OBJECT_KEYS
FROM OPERATION_HISTORY.ANALYSIS.OPERATION_CONVERGED_RECORD
GROUP BY STORE_ID, TIMER_ID, OPERATION_KIND, EVENT_TIME, PERIOD;

-- 観測できた記録から存在を復元できる期待 lifecycle 記録と、そのうち到達しなかったもの（要件 5.6 / 5.9）。
--
-- 復元規則は観測できた boil-started 一件から boiled 一件の存在を導くことだけである。boiled の Event_Time は
-- boil-started の endTime である。この規則の既存の表明は
-- tests/operation-history/unobserved-telemetry.integration.test.ts の recoverableLifecycleRecords であり、
-- ここで別の規則を発明しない。completed / cancelled は running からも到達し得るため、その存在から他の
-- 記録を復元しない。
--
-- 復元元は収束後 record である。同じ boil-started が n 件重複到達しても期待記録は一件であり、重複を
-- 期待記録へ二重計上しない（要件 5.5 の「分析用の一件へ収束」）。
--
-- PERIOD は期待記録自身の Event_Time（= endTime）の UTC 暦日である。boil-started と別の日に落ちる場合も
-- 期待記録はその日の分母に属する。
CREATE VIEW IF NOT EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_EXPECTED_LIFECYCLE_RECORD
COMMENT = '観測から存在を復元できる期待 lifecycle 記録と欠落判定（要件 5.6 / 5.9）'
AS
WITH EXPECTED AS (
  SELECT
    STORE_ID,
    TIMER_ID,
    'boiled'    AS OPERATION_KIND,
    END_TIME    AS EVENT_TIME,
    SLOT_IDS,
    NOODLE_TYPE,
    FIRMNESS,
    END_TIME,
    -- 復元できるのは boiled の存在である。boiledAt は endTime に到来する期限として写す（同上の
    -- recoverableLifecycleRecords と同値）。
    END_TIME    AS BOILED_AT,
    TO_CHAR(TO_TIMESTAMP_NTZ(END_TIME, 3), 'YYYY-MM-DD') AS PERIOD,
    -- 復元の根拠となった観測記録。
    CANONICAL_HASH AS RECOVERED_FROM_CANONICAL_HASH
  FROM OPERATION_HISTORY.ANALYSIS.OPERATION_CONVERGED_RECORD
  WHERE OPERATION_KIND = 'boil-started'
)
SELECT
  EXPECTED.*,
  -- 対応する Operation_Record の存在は一次相関 key の一致で判定する（correlation.ts の
  -- observedPrimaryKeys と同じ）。
  (CANDIDATE.EVENT_TIME IS NULL) AS IS_MISSING
FROM EXPECTED
LEFT JOIN OPERATION_HISTORY.ANALYSIS.OPERATION_CORRELATION_CANDIDATE CANDIDATE
  ON CANDIDATE.STORE_ID       = EXPECTED.STORE_ID
 AND CANDIDATE.TIMER_ID       = EXPECTED.TIMER_ID
 AND CANDIDATE.OPERATION_KIND = EXPECTED.OPERATION_KIND
 AND CANDIDATE.EVENT_TIME     = EXPECTED.EVENT_TIME;
