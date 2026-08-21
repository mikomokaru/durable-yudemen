-- Operation History — best-effort 表示と完全未観測率の測定不能表示（operation-history-log タスク 13.3）
-- 要件: 5.8 / 5.14 / 5.15
--
-- 所有者は Data Platform である。04-quality-rates-and-trusted-analysis.sql の後に実行する（手順は
-- docs/operation-history/snowflake-disclosure-procedure.md）。
--
-- 定義の正本は src/operation-history/quality.ts の analysisDisclosure と
-- consoleLogCompleteMissingRate である。この層はその定義を SQL へ写すだけで、読み替えて別定義を作らない。
-- 表示文字列（display）も純粋層と同一の文であり、SQL 側で言い換えない。
--
-- この層は表示の付与だけを行う。生産能力指標そのもの（何を能力として数えるか）は requirements にも
-- design にも定義が無いため、ここで発明しない。指標を作る側が下の OPERATION_ANALYSIS_DISCLOSURE を
-- STORE_ID と PERIOD で join し、分析値に表示を必ず伴わせる（要件 5.8）。
--
-- raw arrival は読まない・削除しない。この層が持つのは view だけである（要件 5.7）。

-- console log 自体の完全未観測率（要件 5.14）。
--
-- Producer が出力できた telemetry の総数は下流から観測できない。ゆえにこの率は算出不能ではなく
-- **測定不能**である。分母が 0 件だから算出できない（要件 5.13 の denominator-is-zero）のではなく、
-- 分母そのものを観測できない。両者を同じ語にしないため、状態は 'unmeasurable'、理由は
-- 'producer-telemetry-total-unobservable' とする（quality.ts と同じ語）。
--
-- ゆえにこの view は数を持たない。件数、分子、分母、率の列を持たず、到達 record を数える view も参照
-- しない。数を置いた時点で「観測できなかった分を推定した」ことになり、best-effort の限界を偽る。
--
-- lifecycle 内欠落率とは別概念である。あちらは観測できた記録から存在を復元できる期待記録のうち未到達の
-- 割合であり、算出できる（要件 5.9）。混同を防ぐため DISTINCT_FROM に相手の名前を明示して持つ。
CREATE VIEW IF NOT EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_CONSOLE_LOG_COMPLETE_MISSING_RATE
COMMENT = 'console log 自体の完全未観測率は測定不能である。lifecycle 内欠落率と分けて表示する（要件 5.14）'
AS
SELECT
  'unmeasurable'                          AS STATUS,
  'producer-telemetry-total-unobservable' AS REASON,
  'lifecycleMissingRate'                  AS DISTINCT_FROM,
  'Unmeasurable: Producer telemetry total is not observable; distinct from lifecycle missing rate'
                                          AS DISPLAY;

-- 分析値へ付ける表示（要件 5.8 / 5.14 / 5.15）。
--
-- 一店舗・一期間に一行。列は quality.ts の analysisDisclosure と同名同義であり、
--   BASIS      = 'Observed telemetry'   … 根拠は観測できた telemetry だけである
--   ESTIMATION = 'best-effort'          … 権威履歴ではなく best-effort 推定である
--   DISPLAY                             … 分析値に添える一文（純粋層と同一）
-- を持つ。PERIOD の定義は 03 / 04 と同じ（Operation Record 内 eventTime の UTC 暦日）であり、ここで
-- 二つ目の期間定義を作らない。
--
-- 信頼済み分析の判定（TRUSTED_ANALYSIS_STATUS / EXCLUSIONS）は 04 の
-- OPERATION_TRUSTED_ANALYSIS_SCOPE をそのまま連れてくる。除外された店舗・期間の分析値に、対象品質率と
-- 除外理由が必ず添うようにするためである（要件 5.15）。判定そのものをここで作り直さない。
--
-- 完全未観測率は上の一行 view から CROSS JOIN で連れてくる。一つの join で表示が揃い、かつ率の定義は
-- 一箇所に留まる。列名は CONSOLE_LOG_COMPLETE_MISSING_RATE_ 接頭辞で lifecycle 内欠落率
-- （OPERATION_QUALITY_RATE の 'lifecycleMissingRate' 行）と混ざらないようにする（要件 5.14）。
CREATE VIEW IF NOT EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_ANALYSIS_DISCLOSURE
COMMENT = '分析値へ付ける Store Id・期間・Observed telemetry に基づく best-effort 推定の表示（要件 5.8 / 5.14 / 5.15）'
AS
SELECT
  SCOPE.STORE_ID,
  SCOPE.PERIOD,
  'Observed telemetry'                               AS BASIS,
  'best-effort'                                      AS ESTIMATION,
  'Best-effort estimate based on Observed telemetry' AS DISPLAY,
  SCOPE.TRUSTED_ANALYSIS_STATUS,
  SCOPE.EXCLUSIONS,
  UNMEASURABLE.STATUS        AS CONSOLE_LOG_COMPLETE_MISSING_RATE_STATUS,
  UNMEASURABLE.REASON        AS CONSOLE_LOG_COMPLETE_MISSING_RATE_REASON,
  UNMEASURABLE.DISTINCT_FROM AS CONSOLE_LOG_COMPLETE_MISSING_RATE_DISTINCT_FROM,
  UNMEASURABLE.DISPLAY       AS CONSOLE_LOG_COMPLETE_MISSING_RATE_DISPLAY
FROM OPERATION_HISTORY.ANALYSIS.OPERATION_TRUSTED_ANALYSIS_SCOPE SCOPE
CROSS JOIN OPERATION_HISTORY.ANALYSIS.OPERATION_CONSOLE_LOG_COMPLETE_MISSING_RATE UNMEASURABLE;
