-- Operation History — Snowflake 記録の 25 UTC 暦月保持（operation-history-log タスク 13.5）
-- 要件: 6.8 / 6.9（R2 の 90 日は config/operation-history-r2/raw-arrival-lifecycle.json が正本）
--
-- 所有者は Data Platform である。01-raw-arrival-ingest.sql と 02-first-arrival-association.sql の後に
-- 実行する（手順は docs/operation-history/retention-procedure.md）。Producer 設定の SSOT
-- （root wrangler.jsonc）へ Snowflake への能力を一切足さない（要件 4.10 / 4.13 / 4.14）。
--
-- 期限の定義（要件 6.8）
--   初回 Snowflake 到達月を第 1 月とする 25 UTC 暦月が終了した時点で削除を開始し、24 時間以内に完了する。
--   第 1 月の初日 00:00 UTC から 25 か月後の 00:00 UTC が、その終了時点である。ゆえに月内のどの時刻に
--   到達しても、同じ月に到達した record は同じ期限を持つ（要件は月単位で書かれており、日時単位の期限を
--   発明しない）。
--
-- 期限前は削除しない（要件 6.9 / 5.7）
--   このファイルだけが raw arrival の DELETE を持ち、その述語は IS_EXPIRED だけである。品質判定・表示・
--   到達 SLO の層（03〜06）は view と帯の記憶しか持たず、raw を削除しない。ゆえに「保持期限を理由とする
--   削除」は期限を過ぎた record にしか起こらない。品質根拠 raw も期限までは残る。
--
-- 削除の対象は record 単位である
--   期限は record（canonical bytes）ごとに決まり、その record の全到達行を一度に消す。到達の一件だけを
--   残すと到達総数と重複数（タスク 13.2）が期限後に別の値を主張し始める。
--
-- Time Travel を保持の抜け道にしない
--   DATA_RETENTION_TIME_IN_DAYS が正なら、DELETE 後も AT / BEFORE で消したはずの行を読める。それは
--   「24 時間以内に削除を完了する」と両立しない。ゆえに raw arrival の table は 0 日にする。
--   Fail-safe（永続 table の 7 日・設定不可）は Snowflake 内部の災害復旧領域であり、どの role からも
--   query できない。これを消すには table を TRANSIENT で作り直すしかなく、作り直しは既存 raw を捨てる
--   ため本ファイルでは行わない（この性質は手順書に明記する）。

-- 記録ごとの保持期限（要件 6.8）。
--
-- 初回到達時刻の正本は 02 の OPERATION_TELEMETRY_FIRST_ARRIVAL（canonical bytes 単位の
-- FIRST_SNOWFLAKE_AT）である。ここで収束や初回到達を作り直さない。
--
-- 月の判定は UTC で行う。FIRST_SNOWFLAKE_AT は TIMESTAMP_LTZ ゆえ CONVERT_TIMEZONE で UTC へ寄せてから
-- DATE_TRUNC する（session timezone に依らせない。06 の UTC 暦月と同じ規律）。
CREATE VIEW IF NOT EXISTS OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL_RETENTION
COMMENT = 'record ごとの 25 UTC 暦月の保持期限と期限到達（要件 6.8 / 6.9）'
AS
WITH EXPIRY AS (
  SELECT
    CANONICAL_LINE,
    FIRST_SNOWFLAKE_AT,
    CONVERT_TIMEZONE('UTC', FIRST_SNOWFLAKE_AT) AS FIRST_SNOWFLAKE_AT_UTC,
    -- 第 1 月の初日 + 25 か月 = 25 UTC 暦月の終了時点。
    DATEADD(MONTH, 25, DATE_TRUNC('MONTH', CONVERT_TIMEZONE('UTC', FIRST_SNOWFLAKE_AT)))
      AS RETENTION_EXPIRES_AT
  FROM OPERATION_HISTORY.RAW.OPERATION_TELEMETRY_FIRST_ARRIVAL
)
SELECT
  CANONICAL_LINE,
  FIRST_SNOWFLAKE_AT,
  TO_CHAR(FIRST_SNOWFLAKE_AT_UTC, 'YYYY-MM')        AS FIRST_SNOWFLAKE_UTC_MONTH,
  25                                                AS RETENTION_UTC_MONTHS,
  RETENTION_EXPIRES_AT,
  -- 削除完了の期限。開始（RETENTION_EXPIRES_AT）から 24 時間である（要件 6.8）。
  DATEADD(HOUR, 24, RETENTION_EXPIRES_AT)           AS DELETE_BY,
  CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP()) >= RETENTION_EXPIRES_AT AS IS_EXPIRED
FROM EXPIRY;

-- Time Travel で期限後の記録を読めないようにする（要件 6.8）。
-- 0 日は「消したら読めない」ことを意味する。誤削除からの復旧手段も同時に失うが、保持期限の主張を
-- 偽らないことを優先する。この table を消す唯一の経路は下の task であり、その述語は期限だけである。
ALTER TABLE OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL SET DATA_RETENTION_TIME_IN_DAYS = 0;

-- 期限に達した記録を削除する（要件 6.8 / 6.9）。
--
-- 述語は IS_EXPIRED だけである。ゆえに期限前の削除は 0 件になる（要件 6.9）。
--
-- SCHEDULE は 1 時間である。期限そのものは常に UTC 暦月の初日 00:00 なので、月一回の起動でも「期限に
-- 達したら開始」を満たせる。それでも 1 時間にするのは、一度の失敗（warehouse の停止、権限の失効）が
-- 24 時間の完了期限を破らないためである。1 時間なら窓の中に再試行の機会が 24 回ある。
-- 期限に達した記録が無い周期の DELETE は 0 行で終わる。
--
-- WAREHOUSE は運用資源ゆえプレースホルダである。実行時に置換する（README「credential」と同じ規律）。
-- task は作成時は停止状態である。ALTER TASK ... RESUME はユーザー手順で行う（手順書 §3）。
CREATE TASK IF NOT EXISTS OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL_RETENTION_TASK
  WAREHOUSE = <OPERATION_HISTORY_WAREHOUSE>
  SCHEDULE = 'USING CRON 0 * * * * UTC'
  COMMENT = '25 UTC 暦月の保持期限に達した raw arrival を削除する（要件 6.8 / 6.9）'
AS
DELETE FROM OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL
 WHERE CANONICAL_LINE IN (
   SELECT CANONICAL_LINE
     FROM OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL_RETENTION
    WHERE IS_EXPIRED
 );
