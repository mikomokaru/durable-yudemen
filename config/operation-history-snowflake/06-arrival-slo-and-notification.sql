-- Operation History — 月次到達 SLO と 30／60 分通知（operation-history-log タスク 13.4）
-- 要件: 6.1 / 6.2 / 6.3 / 6.4 / 6.5 / 6.6 / 6.13
--
-- 所有者は Data Platform である。02-first-arrival-association.sql と
-- 05-best-effort-disclosure.sql の後に実行する（手順は
-- docs/operation-history/snowflake-slo-procedure.md）。Producer 設定の SSOT（root wrangler.jsonc）へ
-- Snowflake への能力を一切足さない（要件 4.10 / 4.13 / 4.14）。
--
-- 定義の正本は src/operation-history/slo.ts である。この層はその定義を SQL へ写すだけで、読み替えて
-- 別定義を作らない。対応は次のとおり。
--   operationArrivalSloByUtcMonth            … OPERATION_ARRIVAL_SLO（月を引数に取る table function）
--   snowflakeArrivalNotificationTransition   … OPERATION_ARRIVAL_LAG_TRANSITION（view）
--   previousBand（連続状態の記憶）            … OPERATION_ARRIVAL_NOTIFICATION_STATE（一行 table）
--   notification の送出                       … SEND_ARRIVAL_LAG_NOTIFICATION ＋ OPERATION_ARRIVAL_LAG_ALERT
-- 判定値（15 分 = 900000ms、30 分 = 1800000ms、60 分 = 3600000ms、5 分 = 300000ms、目標率 0.99）と
-- 語（met / missed / not-applicable、under-thirty-minutes / thirty-to-sixty-minutes /
-- sixty-minutes-or-more、warning / critical）は slo.ts と同じ値・同じ語である。表示文（DISPLAY）も
-- 純粋層と同一の文であり、SQL 側で言い換えない。一致は
-- tests/operation-history/snowflake-slo.static.test.ts が機械検査する。
--
-- 月の集合は「入力」である。slo.ts の utcMonths と同じく、どの月を見るかは呼ぶ側が決める。ここで月軸を
-- 発明しない（発明すると保持期間や観測範囲に依存した二つ目の定義が生まれる）。ゆえに月次 SLO は view では
-- なく引数を取る table function として持ち、母集団 0 件の月も一行として現れる（要件 6.4）。
--
-- raw arrival は読むだけで、削除も上書きもしない（要件 5.7）。この層が書くのは連続状態を覚える一行
-- （OPERATION_ARRIVAL_NOTIFICATION_STATE）だけである。保持（タスク 13.5）と access 制御（13.6）へ
-- 踏み込まない。

-- UTC 暦月の到達 SLO（要件 6.2 / 6.3 / 6.4 / 6.13）。
--
-- 母集団は「当該月に初回観測された重複除外後の Observed_Telemetry」である。重複除外は
-- OPERATION_TELEMETRY_FIRST_ARRIVAL（タスク 13.1）が canonical bytes 単位で済ませており、同 view が
-- firstObservedAt と firstSnowflakeAt を関連付けている（要件 6.1）。ここで収束を作り直さない。
--
-- 月の判定は UTC で行う。FIRST_OBSERVED_AT は TIMESTAMP_LTZ ゆえ、CONVERT_TIMEZONE で UTC へ寄せてから
-- 暦月を取る（session timezone に依らせない）。
--
-- object key を読めなかった到達は初回観測時刻を持たない（01 の TRY_TO_NUMBER が NULL を残す）。初回観測
-- 時刻の無い record はどの UTC 暦月にも属せないため母集団に入らない。観測できなかった値を推定しない。
--
-- 母集団 0 件の月は率を作らず判定対象外である。ARRIVAL_RATE は NULLIF で NULL に保ち、0 で埋めない
-- （品質率の分母 0 と同じ規律。要件 6.4）。
CREATE FUNCTION IF NOT EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_SLO(TARGET_UTC_MONTH VARCHAR)
RETURNS TABLE (
  UTC_MONTH                            VARCHAR,
  POPULATION_COUNT                     NUMBER,
  ARRIVED_WITHIN_FIFTEEN_MINUTES_COUNT NUMBER,
  ARRIVAL_RATE                         FLOAT,
  ASSESSMENT                           VARCHAR,
  TARGET_RATE                          FLOAT,
  DISPLAY                              VARCHAR,
  TIMER_OPERATION_SUCCESS_GUARANTEED   BOOLEAN
)
COMMENT = 'UTC 暦月の到達 SLO。母集団数・15 分以内到達数・率または対象外・Timer 操作成功を保証しない旨（要件 6.2〜6.4 / 6.13）'
AS
$$
WITH POPULATION AS (
  -- GROUP BY を持たない集計ゆえ、該当 record が 0 件でも一行（0 件）を返す。母集団 0 件の月を
  -- 「行が無い」ではなく「判定対象外」として表示するためである（要件 6.4 / 6.13）。
  SELECT
    COUNT(*) AS POPULATION_COUNT,
    COUNT_IF(
      TIMESTAMPDIFF(MILLISECOND, FIRST_OBSERVED_AT, FIRST_SNOWFLAKE_AT) BETWEEN 0 AND 900000
    ) AS ARRIVED_WITHIN_FIFTEEN_MINUTES_COUNT
  FROM OPERATION_HISTORY.RAW.OPERATION_TELEMETRY_FIRST_ARRIVAL
  WHERE TO_CHAR(CONVERT_TIMEZONE('UTC', FIRST_OBSERVED_AT), 'YYYY-MM') = TARGET_UTC_MONTH
)
SELECT
  TARGET_UTC_MONTH,
  POPULATION_COUNT,
  ARRIVED_WITHIN_FIFTEEN_MINUTES_COUNT,
  ARRIVED_WITHIN_FIFTEEN_MINUTES_COUNT / NULLIF(POPULATION_COUNT, 0),
  CASE
    WHEN POPULATION_COUNT = 0 THEN 'not-applicable'
    WHEN ARRIVED_WITHIN_FIFTEEN_MINUTES_COUNT / POPULATION_COUNT >= 0.99 THEN 'met'
    ELSE 'missed'
  END,
  0.99,
  'Population: ' || POPULATION_COUNT
    || '; within 15 minutes: ' || ARRIVED_WITHIN_FIFTEEN_MINUTES_COUNT
    || '; rate: ' || IFF(
         POPULATION_COUNT = 0,
         'not applicable',
         TO_CHAR(
           ROUND(100 * ARRIVED_WITHIN_FIFTEEN_MINUTES_COUNT / NULLIF(POPULATION_COUNT, 0), 2),
           'FM999990.00'
         ) || '%'
       )
    || '; this SLO does not guarantee Timer operation success.',
  FALSE
FROM POPULATION
$$;

-- 観測できたが Snowflake へ未到達の Observed_Telemetry（要件 6.5 / 6.6 の母集団）。
--
-- 取込済みの行（OPERATION_RAW_ARRIVAL）は SNOWFLAKE_ARRIVED_AT を必ず持つ。ゆえに「未到達」は取込済みの
-- 表からは原理的に見えない。未到達を知る唯一の場所は Consumer が put した R2 object であり、stage を
-- 直接読む。record の identity は canonical bytes、初回観測時刻は object key の firstObservedAt である
-- （key 文法の正本は src/data-platform/raw-arrival-consumer.ts、01 と同じ末尾一致の正規表現で読む）。
--
-- 未到達判定は canonical bytes 単位の anti-join である（object key 単位ではない）。同じ record が n 件
-- 重複配送され、そのうち一件でも取込済みなら slo.ts の収束では firstSnowflakeAt が付くため未到達では
-- ない。key 単位で引くと取込済み record を未到達に数えてしまう。
--
-- 通知には Store Id、Timer Id、Operation Kind、Event Time が必要である（要件 6.5 / 6.6）。これらは
-- 未取込 object の中身にしか無いため、stage の内容を読む。canonical bytes は保存せず、既知属性の読取り
-- にだけ VARIANT を使う（bytes の正本は R2 object と取込後の CANONICAL_LINE 列である）。
--
-- 費用の性質を明示しておく。この view は stage の全 object を読むため、実行費用は stage 上の object 数に
-- 比例する。path で刈って軽くすると最古の未到達 record を見失い、band が誤って戻って同じ遷移を二度
-- 通知する（要件 6.5 / 6.6 の「当該連続状態につき一回」を壊す）。ゆえに刈らない。
--
-- object key を読めなかった object は初回観測時刻を持たない（NULL）。経過時間を主張できないため帯は
-- 'under-thirty-minutes' に留まり、ORDER BY ASC の NULLS LAST で最古にもならない。観測できなかった値を
-- 推定しない。
--
-- 覆う範囲の限界も明示しておく。ここで見えるのは R2 まで到達した未取込分だけである。Tail Worker から
-- Queue／Consumer の間に滞留している分は、この経路のどこにも属性の出所が無い（属性は message 本文に
-- あり、Snowflake から読めない）。その滞留は Consumer の再配送方針と dead-letter（Data Platform 側の
-- 設定正本）が扱う。観測できない分を推定しない。
CREATE VIEW IF NOT EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_PENDING_ARRIVAL
COMMENT = 'R2 まで到達したが Snowflake へ未取込の Observed_Telemetry（要件 6.5 / 6.6）'
AS
WITH OBSERVED AS (
  SELECT
    line.$1           AS CANONICAL_LINE,
    METADATA$FILENAME AS OBJECT_KEY
  FROM @OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVALS
    (FILE_FORMAT => 'OPERATION_HISTORY.RAW.CANONICAL_OPERATION_LINE') line
),
PENDING AS (
  SELECT
    OBSERVED.CANONICAL_LINE,
    -- 初回観測時刻は同じ record の全観測のうち最も早いもの（slo.ts の収束と同じ）。
    MIN(TO_TIMESTAMP_LTZ(
      TRY_TO_NUMBER(REGEXP_SUBSTR(OBSERVED.OBJECT_KEY, '([0-9]+)-(.+)-([0-9]+)\\.json$', 1, 1, 'e', 1)),
      3
    )) AS FIRST_OBSERVED_AT,
    ARRAY_AGG(OBSERVED.OBJECT_KEY) WITHIN GROUP (ORDER BY OBSERVED.OBJECT_KEY) AS PENDING_OBJECT_KEYS
  FROM OBSERVED
  WHERE NOT EXISTS (
    SELECT 1
    FROM OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL arrival
    WHERE arrival.CANONICAL_LINE = OBSERVED.CANONICAL_LINE
  )
  GROUP BY OBSERVED.CANONICAL_LINE
)
SELECT
  PENDING.CANONICAL_LINE,
  PENDING.FIRST_OBSERVED_AT,
  PENDING.PENDING_OBJECT_KEYS,
  -- 既知属性の名前と意味の正本は src/operation-history/record.ts（03 と同じ読み方）。
  TRY_PARSE_JSON(PENDING.CANONICAL_LINE):storeId::VARCHAR       AS STORE_ID,
  TRY_PARSE_JSON(PENDING.CANONICAL_LINE):timerId::VARCHAR       AS TIMER_ID,
  TRY_PARSE_JSON(PENDING.CANONICAL_LINE):operationKind::VARCHAR AS OPERATION_KIND,
  TRY_PARSE_JSON(PENDING.CANONICAL_LINE):eventTime::NUMBER      AS EVENT_TIME
FROM PENDING;

-- 通知した連続状態の記憶（slo.ts の previousBand）。一行だけを持つ。
--
-- 「当該連続状態につき一回」を守るには、直前に判定した帯を覚える以外に方法が無い（要件 6.5 / 6.6）。
-- これは判定の入力であって Operation Record ではない。raw arrival も品質判定も触らない。
CREATE TABLE IF NOT EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_NOTIFICATION_STATE (
  BAND       VARCHAR       NOT NULL COMMENT 'slo.ts の ArrivalLagBand。直前に判定した帯',
  UPDATED_AT TIMESTAMP_LTZ NOT NULL COMMENT 'この帯を記録した時刻'
)
COMMENT = '直前に判定した到達遅延の帯（slo.ts の previousBand）。一行だけ持つ';

-- 初期値は slo.ts の既定（previousBand ?? "under-thirty-minutes"）と同じ。再実行しても増えない。
INSERT INTO OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_NOTIFICATION_STATE (BAND, UPDATED_AT)
SELECT 'under-thirty-minutes', CURRENT_TIMESTAMP()
FROM (SELECT 1)
WHERE NOT EXISTS (SELECT 1 FROM OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_NOTIFICATION_STATE);

-- 通知先。運用設定ゆえ実値をリポジトリへ置かない（01 の credential と同じ規律）。一行だけ入れる。
-- 行が無い間、遷移は消費されない（下の procedure を参照。fail closed）。
CREATE TABLE IF NOT EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_NOTIFICATION_TARGET (
  NOTIFICATION_INTEGRATION VARCHAR NOT NULL COMMENT 'email notification integration の名前',
  RECIPIENTS               VARCHAR NOT NULL COMMENT 'その integration が許可している宛先'
)
COMMENT = '通知先。運用設定ゆえ SQL 正本に実値を持たない（要件 6.5 / 6.6）';

-- 未到達最古 record の帯の遷移（要件 6.5 / 6.6）。slo.ts の
-- snowflakeArrivalNotificationTransition をそのまま写す。
--
-- 常に一行返す。未到達が 0 件でも PREVIOUS 側の一行が残り、NEXT_BAND は
-- 'under-thirty-minutes' へ戻る（slo.ts の oldestPending === null と同じ）。帯が戻ったことを記録
-- できないと、次に 30 分帯へ入ったときの遷移を検出できない。
--
-- 通知の判定も slo.ts と同一である。
--   warning  … 30 分帯へ入り、直前が 30 分未満だったとき
--   critical … 60 分以上へ入り、直前が 60 分以上でなかったとき
-- 帯が下がる遷移（60 分以上 → 30 分帯など）は通知しない。帯の記録だけを更新する。
--
-- TRANSITIONED_AT は「帯へ入った時刻」＝初回観測時刻 ＋ 帯の下限（warning は 30 分、critical は 60 分）
-- である。検出時刻ではない。NOTIFY_BY はそこから 5 分後であり、WITHIN_FIVE_MINUTE_WINDOW が要件 6.5 /
-- 6.6 の「遷移から 5 分以内」を満たしたかを可視化する。
CREATE VIEW IF NOT EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_LAG_TRANSITION
COMMENT = '未到達最古 record の帯の遷移と通知（要件 6.5 / 6.6）。正本は src/operation-history/slo.ts'
AS
WITH NOW AS (
  -- 一文中で一度だけ採る。経過時間と 5 分窓の判定で同じ時刻を使うため。
  SELECT CURRENT_TIMESTAMP() AS DETECTED_AT
),
PREVIOUS AS (
  SELECT BAND AS PREVIOUS_BAND FROM OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_NOTIFICATION_STATE
),
OLDEST AS (
  SELECT CANONICAL_LINE, FIRST_OBSERVED_AT, STORE_ID, TIMER_ID, OPERATION_KIND, EVENT_TIME
  FROM OPERATION_HISTORY.ANALYSIS.OPERATION_PENDING_ARRIVAL
  ORDER BY FIRST_OBSERVED_AT
  LIMIT 1
),
BAND AS (
  SELECT
    NOW.DETECTED_AT,
    PREVIOUS.PREVIOUS_BAND,
    OLDEST.CANONICAL_LINE,
    OLDEST.FIRST_OBSERVED_AT,
    OLDEST.STORE_ID,
    OLDEST.TIMER_ID,
    OLDEST.OPERATION_KIND,
    OLDEST.EVENT_TIME,
    GREATEST(0, TIMESTAMPDIFF(MILLISECOND, OLDEST.FIRST_OBSERVED_AT, NOW.DETECTED_AT)) AS ELAPSED_MS
  FROM NOW
  CROSS JOIN PREVIOUS
  LEFT OUTER JOIN OLDEST ON TRUE
),
NEXT AS (
  SELECT
    BAND.*,
    CASE
      WHEN BAND.CANONICAL_LINE IS NULL      THEN 'under-thirty-minutes'
      WHEN BAND.ELAPSED_MS >= 3600000       THEN 'sixty-minutes-or-more'
      WHEN BAND.ELAPSED_MS >= 1800000       THEN 'thirty-to-sixty-minutes'
      ELSE 'under-thirty-minutes'
    END AS NEXT_BAND
  FROM BAND
),
KIND AS (
  SELECT
    NEXT.*,
    CASE
      WHEN NEXT.NEXT_BAND = 'thirty-to-sixty-minutes' AND NEXT.PREVIOUS_BAND = 'under-thirty-minutes'
        THEN 'warning'
      WHEN NEXT.NEXT_BAND = 'sixty-minutes-or-more' AND NEXT.PREVIOUS_BAND <> 'sixty-minutes-or-more'
        THEN 'critical'
    END AS NOTIFICATION_KIND
  FROM NEXT
),
TRANSITION AS (
  SELECT
    KIND.*,
    DATEADD(
      MILLISECOND,
      IFF(KIND.NOTIFICATION_KIND = 'warning', 1800000, 3600000),
      KIND.FIRST_OBSERVED_AT
    ) AS TRANSITIONED_AT
  FROM KIND
)
SELECT
  TRANSITION.DETECTED_AT,
  TRANSITION.PREVIOUS_BAND,
  TRANSITION.NEXT_BAND,
  TRANSITION.CANONICAL_LINE,
  TRANSITION.FIRST_OBSERVED_AT,
  TRANSITION.ELAPSED_MS,
  TRANSITION.STORE_ID,
  TRANSITION.TIMER_ID,
  TRANSITION.OPERATION_KIND,
  TRANSITION.EVENT_TIME,
  TRANSITION.NOTIFICATION_KIND,
  IFF(TRANSITION.NOTIFICATION_KIND IS NULL, NULL, TRANSITION.TRANSITIONED_AT) AS TRANSITIONED_AT,
  IFF(
    TRANSITION.NOTIFICATION_KIND IS NULL,
    NULL,
    DATEADD(MILLISECOND, 300000, TRANSITION.TRANSITIONED_AT)
  ) AS NOTIFY_BY,
  IFF(
    TRANSITION.NOTIFICATION_KIND IS NULL,
    NULL,
    TRANSITION.DETECTED_AT <= DATEADD(MILLISECOND, 300000, TRANSITION.TRANSITIONED_AT)
  ) AS WITHIN_FIVE_MINUTE_WINDOW,
  -- 通知そのもの。属性名と並びは slo.ts の notification と同じである。Store Id、Timer Id、
  -- Operation Kind、Event Time を必ず含める（要件 6.5 / 6.6）。時刻は slo.ts と同じ epoch millisecond。
  IFF(TRANSITION.NOTIFICATION_KIND IS NULL, NULL, OBJECT_CONSTRUCT(
    'kind',          TRANSITION.NOTIFICATION_KIND,
    'storeId',       TRANSITION.STORE_ID,
    'timerId',       TRANSITION.TIMER_ID,
    'operationKind', TRANSITION.OPERATION_KIND,
    'eventTime',     TRANSITION.EVENT_TIME,
    'transitionedAt', DATE_PART(EPOCH_MILLISECOND, TRANSITION.TRANSITIONED_AT),
    'notifyBy',      DATE_PART(EPOCH_MILLISECOND, DATEADD(MILLISECOND, 300000, TRANSITION.TRANSITIONED_AT)),
    'detectedAt',    DATE_PART(EPOCH_MILLISECOND, TRANSITION.DETECTED_AT),
    'withinFiveMinuteWindow',
      TRANSITION.DETECTED_AT <= DATEADD(MILLISECOND, 300000, TRANSITION.TRANSITIONED_AT)
  )) AS NOTIFICATION
FROM TRANSITION;

-- 遷移を一回だけ通知し、帯を記録する（要件 6.5 / 6.6）。
--
-- 通知できたときだけ帯を進める（fail closed）。通知先が未設定なら帯を更新せず、同じ遷移が次回も
-- 遷移として現れる。通知しないまま「通知済み」にしてしまうと、その連続状態の通知が永久に失われる。
-- 通知を伴わない帯の変化（帯が下がる遷移、未到達 0 件への復帰）は、帯だけを記録する。
CREATE OR REPLACE PROCEDURE OPERATION_HISTORY.ANALYSIS.SEND_ARRIVAL_LAG_NOTIFICATION()
RETURNS VARCHAR
LANGUAGE SQL
COMMENT = '帯の遷移を一回だけ通知し帯を記録する（要件 6.5 / 6.6）。判定の正本は src/operation-history/slo.ts'
AS
$$
DECLARE
  next_band         VARCHAR;
  notification_kind VARCHAR;
  notification      VARCHAR;
  integration       VARCHAR;
  recipients        VARCHAR;
BEGIN
  -- OPERATION_ARRIVAL_LAG_TRANSITION は常に一行返す。
  SELECT NEXT_BAND, NOTIFICATION_KIND, TO_JSON(NOTIFICATION)
    INTO :next_band, :notification_kind, :notification
    FROM OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_LAG_TRANSITION;

  IF (notification_kind IS NULL) THEN
    UPDATE OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_NOTIFICATION_STATE
       SET BAND = :next_band, UPDATED_AT = CURRENT_TIMESTAMP();
    RETURN 'band-recorded-without-notification';
  END IF;

  -- 集計ゆえ行が無くても一行返る（NULL になる）。
  SELECT ANY_VALUE(NOTIFICATION_INTEGRATION), ANY_VALUE(RECIPIENTS)
    INTO :integration, :recipients
    FROM OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_NOTIFICATION_TARGET;

  IF (integration IS NULL) THEN
    RETURN 'notification-target-not-configured';
  END IF;

  CALL SYSTEM$SEND_EMAIL(
    :integration,
    :recipients,
    'Operation History arrival lag ' || :notification_kind,
    :notification
  );

  UPDATE OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_NOTIFICATION_STATE
     SET BAND = :next_band, UPDATED_AT = CURRENT_TIMESTAMP();
  RETURN :notification_kind;
END;
$$;

-- 遷移の検出（要件 6.5 / 6.6）。
--
-- 条件は「帯が変わったこと」である。通知が要る遷移は必ず帯の変化を含み、帯が下がる変化は帯の記録だけを
-- 更新する。どちらも同じ procedure が扱う。
--
-- SCHEDULE は 1 分である。要件は「遷移から 5 分以内」ゆえ、5 分間隔では検出時刻が窓の端に張り付き、
-- procedure の実行時間の分だけ超える。1 分間隔で余裕を持たせる。実際に窓を満たしたかは
-- OPERATION_ARRIVAL_LAG_TRANSITION.WITHIN_FIVE_MINUTE_WINDOW で確認できる。
--
-- WAREHOUSE は運用資源ゆえプレースホルダである。実行時に置換する（README「credential」と同じ規律）。
-- alert は作成時は停止状態である。ALTER ALERT ... RESUME はユーザー手順で行う（手順書 §4）。
CREATE ALERT IF NOT EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_LAG_ALERT
  WAREHOUSE = <OPERATION_HISTORY_WAREHOUSE>
  SCHEDULE = '1 MINUTE'
  COMMENT = '未到達最古 record の帯の遷移を検出して一回だけ通知する（要件 6.5 / 6.6）'
IF (EXISTS (
  SELECT 1
  FROM OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_LAG_TRANSITION
  WHERE NEXT_BAND <> PREVIOUS_BAND
))
THEN
  CALL OPERATION_HISTORY.ANALYSIS.SEND_ARRIVAL_LAG_NOTIFICATION();
