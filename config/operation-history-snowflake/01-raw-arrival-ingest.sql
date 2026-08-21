-- Operation History — R2 raw arrival の Snowflake 取込（operation-history-log タスク 13.1）
-- 要件: 4.6 / 5.3 / 5.4 / 5.5 / 5.7
--
-- 所有者は Data Platform である。このファイルは Snowflake 側 object の宣言的な正本であり、実行は
-- ユーザーが行う（手順は docs/operation-history/snowflake-ingest-procedure.md）。Producer 設定の
-- SSOT（root wrangler.jsonc）へ Snowflake への能力を一切足さない（要件 4.10 / 4.13 / 4.14）。
--
-- 責務の分離。この段で作るのは raw arrival 層だけである。
--   1. raw arrival      … このファイル。canonical 一行を文字列のまま一到達一行で保存し、削除しない（要件 5.7）。
--   2. 重複収束後 record … タスク 13.2。
--   3. 相関結果          … タスク 13.2。src/operation-history/correlation.ts が定義の正本。
--   4. 品質判定          … タスク 13.2 / 13.3。src/operation-history/quality.ts と slo.ts が定義の正本。
-- 純粋層の定義を SQL 側で読み替えて別定義を作らない。この層は raw を足すだけで、何も判定しない。
--
-- 観測側 metadata の取得可能性（実装時に Snowflake 公式資料で確認した制約）
--   Snowflake は stage object の user metadata（R2 customMetadata / S3 の x-amz-meta-*）を読まない。
--   COPY で読めるのは METADATA$FILENAME / FILE_ROW_NUMBER / FILE_CONTENT_KEY / FILE_LAST_MODIFIED /
--   START_SCAN_TIME だけである（https://docs.snowflake.com/en/user-guide/querying-metadata）。
--   ゆえに観測側 metadata のうち firstObservedAt / queueMessageId / deliveryAttempt は object key から
--   取り、arrivedAt は R2 put 時刻（METADATA$FILE_LAST_MODIFIED）で代える。canonicalHash は canonical
--   一行から Snowflake 側で再計算する（02-first-arrival-association.sql）。いずれも曖昧性解消の補助情報
--   であって Operation Record の identity ではない（要件 5.3 / 5.4）。
--
-- object key の文法の正本は src/data-platform/raw-arrival-consumer.ts である。
--   raw/{YYYY}/{MM}/{DD}/{firstObservedAt}-{queueMessageId}-{deliveryAttempt}.json
--   key は delivery identity だけから決まるため、重複配送は別 object として残り、取込後も別行として
--   残る（要件 5.5 / 5.7）。この SQL は同じ文法を末尾一致の正規表現で読むだけで、key を作らない。
--   （tests/operation-history/snowflake-ingest.static.test.ts が両者の一致を検査する。）

CREATE DATABASE IF NOT EXISTS OPERATION_HISTORY;
CREATE SCHEMA IF NOT EXISTS OPERATION_HISTORY.RAW;

-- canonical 一行を「文字列のまま」一行一 record で読む file format。
-- JSON 型で読んで VARIANT へ parse すると属性順が正規化され canonical bytes が失われる。canonical 表現の
-- 正本は src/operation-history/codec.ts であり、下流はその bytes を根拠として保持する（要件 3.19 / 5.7）。
-- CSV 型 + FIELD_DELIMITER = NONE で一行を丸ごと一列として受ける。
--   ESCAPE / ESCAPE_UNENCLOSED_FIELD = NONE … 既定の backslash escape は JSON の \\ \" \uXXXX を壊すため切る。
--   FIELD_OPTIONALLY_ENCLOSED_BY = NONE     … 行頭末の " を引用符と解釈させない。
--   RECORD_DELIMITER = '\n'                 … canonical 一行は埋め込み改行を持たない（要件 3.10）。
--   TRIM_SPACE = FALSE                      … 前後の空白を勝手に落とさず、到達した bytes を保つ。
CREATE FILE FORMAT IF NOT EXISTS OPERATION_HISTORY.RAW.CANONICAL_OPERATION_LINE
  TYPE = CSV
  FIELD_DELIMITER = NONE
  RECORD_DELIMITER = '\n'
  FIELD_OPTIONALLY_ENCLOSED_BY = NONE
  ESCAPE = NONE
  ESCAPE_UNENCLOSED_FIELD = NONE
  TRIM_SPACE = FALSE
  EMPTY_FIELD_AS_NULL = FALSE
  SKIP_BLANK_LINES = TRUE
  REPLACE_INVALID_CHARACTERS = FALSE
  COMPRESSION = NONE
  COMMENT = 'Operation History の canonical 一行を文字列のまま読む。正本は src/operation-history/codec.ts';

-- R2 bucket operation-raw-arrivals の raw/ 配下を指す外部 stage（S3 互換）。
-- ENDPOINT が r2.cloudflarestorage.com の場合、S3 互換 stage は既定で有効である（Snowflake 公式資料）。
-- CREDENTIALS は secret ゆえリポジトリへ実値を置かない。実行時に置換し、置換後のファイルを commit しない。
CREATE STAGE IF NOT EXISTS OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVALS
  URL = 's3compat://operation-raw-arrivals/raw/'
  ENDPOINT = '<R2_ACCOUNT_ID>.r2.cloudflarestorage.com'
  CREDENTIALS = (AWS_KEY_ID = '<R2_ACCESS_KEY_ID>' AWS_SECRET_KEY = '<R2_SECRET_ACCESS_KEY>')
  FILE_FORMAT = OPERATION_HISTORY.RAW.CANONICAL_OPERATION_LINE
  COMMENT = 'Consumer が put した raw arrival（wrangler.raw-arrival-consumer.jsonc の R2 bucket）';

-- 一到達一行の raw arrival。canonical Operation Record（CANONICAL_LINE）と観測側 metadata を同じ行の
-- 別の列として分離して持つ。Operation Record の属性を観測側の値で汚さない（要件 5.4）。
--
-- key 由来の列は NULL 許容にする。想定外の key でも canonical 一行は必ず残すためであり、根拠 record を
-- 取込段で落とさない（要件 5.7）。
CREATE TABLE IF NOT EXISTS OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL (
  -- canonical Operation Record（到達した bytes そのまま。解釈は codec の定義に従う）
  CANONICAL_LINE       VARCHAR       NOT NULL,
  -- 観測側 metadata
  OBJECT_KEY           VARCHAR       NOT NULL COMMENT 'R2 object key（delivery identity）',
  FIRST_OBSERVED_AT    NUMBER(38, 0)          COMMENT 'Tail Worker が初めて観測した epoch millisecond（key 由来）',
  QUEUE_MESSAGE_ID     VARCHAR                COMMENT 'Queue delivery の trace 値（key 由来）',
  DELIVERY_ATTEMPT     NUMBER(38, 0)          COMMENT 'Queue 配送試行回数（key 由来）',
  R2_LAST_MODIFIED_AT  TIMESTAMP_NTZ          COMMENT 'R2 put 時刻。arrivedAt の代替',
  SNOWFLAKE_ARRIVED_AT TIMESTAMP_LTZ NOT NULL COMMENT 'この到達の Snowflake 取込時刻'
)
COMMENT = 'raw arrival。品質判定の根拠ゆえ判定後も削除しない（要件 5.7）';

-- Snowpipe。S3 互換 stage は S3 event 通知による auto-ingest に対応しないため AUTO_INGEST = FALSE とし、
-- Snowpipe REST の insertFiles で駆動する（手順書 §4）。ALTER PIPE ... REFRESH は 7 日以内の復旧用途に限る。
--
-- Snowpipe の load history は file 単位で重複取込を防ぐ。重複配送は key が異なるため別 file であり、
-- n 件の到達は n 行として残る（要件 5.5 / 5.7）。到達数と重複数の算出はタスク 13.2 が担う。
--
-- ON_ERROR = CONTINUE は、ある object の失敗が他の object の取込を止めないためである。不正行は Tail Worker
-- が既に落としており（要件 4.4）、ここへ来る行は canonical である。
CREATE PIPE IF NOT EXISTS OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL_PIPE
  AUTO_INGEST = FALSE
  COMMENT = 'R2 raw arrival を OPERATION_RAW_ARRIVAL へ取り込む（要件 4.6）'
AS
COPY INTO OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL (
  CANONICAL_LINE,
  OBJECT_KEY,
  FIRST_OBSERVED_AT,
  QUEUE_MESSAGE_ID,
  DELIVERY_ATTEMPT,
  R2_LAST_MODIFIED_AT,
  SNOWFLAKE_ARRIVED_AT
)
FROM (
  SELECT
    line.$1,
    METADATA$FILENAME,
    -- 以下三つは object key の同一文法（末尾一致）から group 1 / 2 / 3 を取る。TRY_ 系にすることで、
    -- 想定外の key でも行を落とさず NULL として残す。
    TRY_TO_NUMBER(REGEXP_SUBSTR(METADATA$FILENAME, '([0-9]+)-(.+)-([0-9]+)\\.json$', 1, 1, 'e', 1)),
    REGEXP_SUBSTR(METADATA$FILENAME, '([0-9]+)-(.+)-([0-9]+)\\.json$', 1, 1, 'e', 2),
    TRY_TO_NUMBER(REGEXP_SUBSTR(METADATA$FILENAME, '([0-9]+)-(.+)-([0-9]+)\\.json$', 1, 1, 'e', 3)),
    METADATA$FILE_LAST_MODIFIED,
    METADATA$START_SCAN_TIME
  FROM @OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVALS line
)
FILE_FORMAT = (FORMAT_NAME = OPERATION_HISTORY.RAW.CANONICAL_OPERATION_LINE)
ON_ERROR = CONTINUE;
