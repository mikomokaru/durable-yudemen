-- Operation History — 四品質率と信頼済み分析の範囲（operation-history-log タスク 13.2）
-- 要件: 5.9 / 5.10 / 5.11 / 5.12 / 5.13 / 5.15
--
-- 所有者は Data Platform である。03-correlation-and-convergence.sql の後に実行する（手順は
-- docs/operation-history/snowflake-quality-procedure.md）。
--
-- 定義の正本は src/operation-history/quality.ts である。この層はその定義を SQL へ写すだけで、読み替えて
-- 別定義を作らない。集計の列名は quality.ts の counts の属性名と一対一であり、品質率の名前
-- （lifecycleMissingRate / duplicateRate / orphanRate / conflictRate）と状態の語
-- （calculated / not-calculable / denominator-is-zero / rate-not-calculable / threshold-exceeded /
-- included / excluded）も同じ語を使う。語を二つにしないためである。
--
-- 分母 0 は数値 0 ではない。算出不能として保持する（要件 5.13）。ゆえに VALUE は NULL のままにし、
-- 0 で埋めない。
--
-- raw arrival は読むだけで削除しない（要件 5.7）。この層が持つ table は運用者が定める閾値だけである。

-- 分析運用者が事前に定める Data_Quality_Threshold（要件 5.15）。
-- 値は運用判断ゆえリポジトリに置かない。手順書に従って四行を投入する。四行が揃わない品質率は
-- 「閾値未設定」として信頼済み分析から除外する（下の OPERATION_QUALITY_RATE を参照）。
CREATE TABLE IF NOT EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_QUALITY_THRESHOLD (
  QUALITY_RATE VARCHAR NOT NULL COMMENT 'quality.ts の QualityRateName（camelCase のまま）',
  THRESHOLD    FLOAT   NOT NULL COMMENT '信頼判定値。率がこの値を超えたら除外する（ちょうどは含める）'
)
COMMENT = '分析運用者が事前に定める四閾値（要件 5.15）。値は運用設定ゆえ SQL 正本に持たない';

-- 店舗・期間ごとの集計。列名は quality.ts の counts の属性名と一対一である（要件 5.9〜5.12）。
--
-- 四つの品質状態の判定自体は 03 の view が観測全体に対して行い、この view は判定結果を期間へ割り当てて
-- 数えるだけである。期間は Operation Record 内の eventTime（期待記録は復元された Event_Time）の UTC 暦日
-- であり、観測側時刻を期間の根拠にしない（要件 5.4）。
--
-- 期待 lifecycle 記録は到達記録と別の日に落ち得る（boil-started が前日、期限が翌日）。ゆえに期間の集合は
-- 到達側と期待側の合併とし、片側だけが存在する期間も 0 件として現れるようにする。ここでの 0 は「その期間に
-- その種の記録が無い」という件数であり、品質率の算出不能とは別の概念である。
CREATE VIEW IF NOT EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_QUALITY_COUNT
COMMENT = '店舗・期間ごとの八集計。quality.ts の counts と同名同義（要件 5.9〜5.12）'
AS
WITH SCOPE AS (
  SELECT DISTINCT STORE_ID, PERIOD FROM OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL
  UNION
  SELECT DISTINCT STORE_ID, PERIOD FROM OPERATION_HISTORY.ANALYSIS.OPERATION_EXPECTED_LIFECYCLE_RECORD
),
EXPECTED AS (
  SELECT
    STORE_ID,
    PERIOD,
    COUNT(*)                AS EXPECTED_LIFECYCLE_RECORD_COUNT,
    COUNT_IF(IS_MISSING)    AS MISSING_LIFECYCLE_RECORD_COUNT
  FROM OPERATION_HISTORY.ANALYSIS.OPERATION_EXPECTED_LIFECYCLE_RECORD
  GROUP BY STORE_ID, PERIOD
),
ARRIVAL AS (
  SELECT STORE_ID, PERIOD, COUNT(*) AS ARRIVAL_COUNT
  FROM OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL
  GROUP BY STORE_ID, PERIOD
),
CONVERGED AS (
  SELECT
    STORE_ID,
    PERIOD,
    SUM(DUPLICATE_COUNT)  AS DUPLICATE_ARRIVAL_COUNT,
    COUNT(*)              AS CONVERGED_RECORD_COUNT,
    COUNT_IF(IS_ORPHAN)   AS ORPHAN_RECORD_COUNT
  FROM OPERATION_HISTORY.ANALYSIS.OPERATION_CONVERGED_RECORD
  GROUP BY STORE_ID, PERIOD
),
CANDIDATE AS (
  SELECT
    STORE_ID,
    PERIOD,
    COUNT(*)                              AS PRIMARY_CANDIDATE_COUNT,
    COUNT_IF(NOT TIMER_FACTS_CONSISTENT)  AS CONFLICTING_PRIMARY_CANDIDATE_COUNT
  FROM OPERATION_HISTORY.ANALYSIS.OPERATION_CORRELATION_CANDIDATE
  GROUP BY STORE_ID, PERIOD
)
SELECT
  SCOPE.STORE_ID,
  SCOPE.PERIOD,
  COALESCE(EXPECTED.EXPECTED_LIFECYCLE_RECORD_COUNT, 0)      AS EXPECTED_LIFECYCLE_RECORD_COUNT,
  COALESCE(EXPECTED.MISSING_LIFECYCLE_RECORD_COUNT, 0)       AS MISSING_LIFECYCLE_RECORD_COUNT,
  COALESCE(ARRIVAL.ARRIVAL_COUNT, 0)                         AS ARRIVAL_COUNT,
  COALESCE(CONVERGED.DUPLICATE_ARRIVAL_COUNT, 0)             AS DUPLICATE_ARRIVAL_COUNT,
  COALESCE(CONVERGED.CONVERGED_RECORD_COUNT, 0)              AS CONVERGED_RECORD_COUNT,
  COALESCE(CONVERGED.ORPHAN_RECORD_COUNT, 0)                 AS ORPHAN_RECORD_COUNT,
  COALESCE(CANDIDATE.PRIMARY_CANDIDATE_COUNT, 0)             AS PRIMARY_CANDIDATE_COUNT,
  COALESCE(CANDIDATE.CONFLICTING_PRIMARY_CANDIDATE_COUNT, 0) AS CONFLICTING_PRIMARY_CANDIDATE_COUNT
FROM SCOPE
LEFT JOIN EXPECTED  ON EXPECTED.STORE_ID  = SCOPE.STORE_ID AND EXPECTED.PERIOD  = SCOPE.PERIOD
LEFT JOIN ARRIVAL   ON ARRIVAL.STORE_ID   = SCOPE.STORE_ID AND ARRIVAL.PERIOD   = SCOPE.PERIOD
LEFT JOIN CONVERGED ON CONVERGED.STORE_ID = SCOPE.STORE_ID AND CONVERGED.PERIOD = SCOPE.PERIOD
LEFT JOIN CANDIDATE ON CANDIDATE.STORE_ID = SCOPE.STORE_ID AND CANDIDATE.PERIOD = SCOPE.PERIOD;

-- 四品質率を一率一行で持つ（要件 5.9〜5.13）。分子と分母は requirements の定義そのままである。
--   lifecycleMissingRate … 分母 = 復元できる期待 lifecycle 記録数、分子 = そのうち未到達（要件 5.9）
--   duplicateRate        … 分母 = 到達総数、分子 = 収束後の重複到達数（要件 5.10）
--   orphanRate           … 分母 = 重複除外後の record 数、分子 = 開始へ相関できない record 数（要件 5.11）
--   conflictRate         … 分母 = 一次相関候補総数、分子 = 両立しない既知属性値を持つ候補数（要件 5.12）
--
-- RATE_ORDER は quality.ts の qualityRateNames の順序である。除外理由の並びを実装と同じにするために持つ。
--
-- 分母 0 は算出不能である（要件 5.13）。NULLIF で VALUE を NULL に保ち、0 で埋めない。
--
-- EXCLUSION_REASON は quality.ts の QualityExclusion.reason と同じ語である。閾値ちょうどは除外しない
-- （超過だけを除外する）。閾値が未設定の品質率は信頼を主張できないため除外側へ倒す。これは五つ目の
-- 品質状態ではなく、四閾値が揃っていることを要求する quality.ts の型を SQL 側で満たせないことへの
-- 構成上の guard である。
CREATE VIEW IF NOT EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_QUALITY_RATE
COMMENT = '四品質率と算出不能・除外理由（要件 5.9〜5.13 / 5.15）'
AS
WITH RATE AS (
  SELECT STORE_ID, PERIOD, 1 AS RATE_ORDER, 'lifecycleMissingRate' AS QUALITY_RATE,
         MISSING_LIFECYCLE_RECORD_COUNT       AS NUMERATOR,
         EXPECTED_LIFECYCLE_RECORD_COUNT      AS DENOMINATOR
  FROM OPERATION_HISTORY.ANALYSIS.OPERATION_QUALITY_COUNT
  UNION ALL
  SELECT STORE_ID, PERIOD, 2 AS RATE_ORDER, 'duplicateRate' AS QUALITY_RATE,
         DUPLICATE_ARRIVAL_COUNT              AS NUMERATOR,
         ARRIVAL_COUNT                        AS DENOMINATOR
  FROM OPERATION_HISTORY.ANALYSIS.OPERATION_QUALITY_COUNT
  UNION ALL
  SELECT STORE_ID, PERIOD, 3 AS RATE_ORDER, 'orphanRate' AS QUALITY_RATE,
         ORPHAN_RECORD_COUNT                  AS NUMERATOR,
         CONVERGED_RECORD_COUNT               AS DENOMINATOR
  FROM OPERATION_HISTORY.ANALYSIS.OPERATION_QUALITY_COUNT
  UNION ALL
  SELECT STORE_ID, PERIOD, 4 AS RATE_ORDER, 'conflictRate' AS QUALITY_RATE,
         CONFLICTING_PRIMARY_CANDIDATE_COUNT  AS NUMERATOR,
         PRIMARY_CANDIDATE_COUNT              AS DENOMINATOR
  FROM OPERATION_HISTORY.ANALYSIS.OPERATION_QUALITY_COUNT
)
SELECT
  RATE.STORE_ID,
  RATE.PERIOD,
  RATE.RATE_ORDER,
  RATE.QUALITY_RATE,
  RATE.NUMERATOR,
  RATE.DENOMINATOR,
  IFF(RATE.DENOMINATOR = 0, 'not-calculable', 'calculated')          AS STATUS,
  RATE.NUMERATOR / NULLIF(RATE.DENOMINATOR, 0)                      AS VALUE,
  IFF(RATE.DENOMINATOR = 0, 'denominator-is-zero', NULL)             AS NOT_CALCULABLE_REASON,
  THRESHOLD.THRESHOLD,
  CASE
    WHEN RATE.DENOMINATOR = 0 THEN 'rate-not-calculable'
    WHEN THRESHOLD.THRESHOLD IS NULL THEN 'threshold-not-configured'
    WHEN RATE.NUMERATOR / RATE.DENOMINATOR > THRESHOLD.THRESHOLD THEN 'threshold-exceeded'
  END                                                                AS EXCLUSION_REASON
FROM RATE
LEFT JOIN OPERATION_HISTORY.ANALYSIS.OPERATION_QUALITY_THRESHOLD THRESHOLD
  ON THRESHOLD.QUALITY_RATE = RATE.QUALITY_RATE;

-- 信頼済み分析の範囲（要件 5.15）。全ての品質率が算出可能かつ閾値以下の店舗・期間だけを included とし、
-- それ以外は excluded として対象品質率と除外理由を並べる。
--
-- EXCLUSIONS の要素は quality.ts の QualityExclusion と同じ形である（qualityRate / rate / threshold /
-- reason）。OBJECT_CONSTRUCT は NULL 値の key を落とすため、算出不能の率には value が現れず、算出できた率には
-- reason（denominator-is-zero）が現れない。分母 0 が数値 0 として現れないことをここでも保つ。
CREATE VIEW IF NOT EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_TRUSTED_ANALYSIS_SCOPE
COMMENT = '店舗・期間の信頼済み分析 included / excluded と除外理由（要件 5.15）'
AS
WITH EXCLUSION AS (
  SELECT
    STORE_ID,
    PERIOD,
    ARRAY_AGG(OBJECT_CONSTRUCT(
      'qualityRate', QUALITY_RATE,
      'rate', OBJECT_CONSTRUCT(
        'status', STATUS,
        'numerator', NUMERATOR,
        'denominator', DENOMINATOR,
        'value', VALUE,
        'reason', NOT_CALCULABLE_REASON
      ),
      'threshold', THRESHOLD,
      'reason', EXCLUSION_REASON
    )) WITHIN GROUP (ORDER BY RATE_ORDER) AS EXCLUSIONS
  FROM OPERATION_HISTORY.ANALYSIS.OPERATION_QUALITY_RATE
  WHERE EXCLUSION_REASON IS NOT NULL
  GROUP BY STORE_ID, PERIOD
),
SCOPE AS (
  SELECT DISTINCT STORE_ID, PERIOD FROM OPERATION_HISTORY.ANALYSIS.OPERATION_QUALITY_RATE
)
SELECT
  SCOPE.STORE_ID,
  SCOPE.PERIOD,
  IFF(EXCLUSION.EXCLUSIONS IS NULL, 'included', 'excluded') AS TRUSTED_ANALYSIS_STATUS,
  EXCLUSION.EXCLUSIONS
FROM SCOPE
LEFT JOIN EXCLUSION
  ON EXCLUSION.STORE_ID = SCOPE.STORE_ID
 AND EXCLUSION.PERIOD   = SCOPE.PERIOD;
