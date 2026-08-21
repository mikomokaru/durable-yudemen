# Operation History — Snowflake 側 object の宣言的正本

`operation-history-log` の下流（Data Platform）が Snowflake に置く object の**宣言的な正本**。
Snowflake は外部サービスゆえリポジトリからは適用できない。適用手順は次の二つに従ってユーザーが実行する。

- raw arrival 層（`01` / `02`）: [`docs/operation-history/snowflake-ingest-procedure.md`](../../docs/operation-history/snowflake-ingest-procedure.md)
- 相関・品質層（`03` / `04`）: [`docs/operation-history/snowflake-quality-procedure.md`](../../docs/operation-history/snowflake-quality-procedure.md)
- 表示層（`05`）: [`docs/operation-history/snowflake-disclosure-procedure.md`](../../docs/operation-history/snowflake-disclosure-procedure.md)
- 到達 SLO・通知層（`06`）: [`docs/operation-history/snowflake-slo-procedure.md`](../../docs/operation-history/snowflake-slo-procedure.md)
- 保持（`07`）: [`docs/operation-history/retention-procedure.md`](../../docs/operation-history/retention-procedure.md)
- 分類・access 制御（`08`）: [`docs/operation-history/snowflake-access-procedure.md`](../../docs/operation-history/snowflake-access-procedure.md)

所有者は Data Platform である。Producer 設定の SSOT（root `wrangler.jsonc`）へ Snowflake への binding、
credential、route を一切足さない（要件 4.10 / 4.13 / 4.14）。

## ファイル

| 実行順 | ファイル | 作る object | 要件 |
| ---: | --- | --- | --- |
| 1 | `01-raw-arrival-ingest.sql` | database `OPERATION_HISTORY`、schema `RAW`、file format `CANONICAL_OPERATION_LINE`、stage `OPERATION_RAW_ARRIVALS`、table `OPERATION_RAW_ARRIVAL`、pipe `OPERATION_RAW_ARRIVAL_PIPE` | 4.6 / 5.3 / 5.4 / 5.5 / 5.7 |
| 2 | `02-first-arrival-association.sql` | view `OPERATION_TELEMETRY_FIRST_ARRIVAL` | 5.3 / 5.4 / 5.6 / 6.1 |
| 3 | `03-correlation-and-convergence.sql` | schema `ANALYSIS`、view `OPERATION_ARRIVAL`、`OPERATION_CONVERGED_RECORD`、`OPERATION_CORRELATION_CANDIDATE`、`OPERATION_EXPECTED_LIFECYCLE_RECORD` | 5.1〜5.7 |
| 4 | `04-quality-rates-and-trusted-analysis.sql` | table `OPERATION_QUALITY_THRESHOLD`、view `OPERATION_QUALITY_COUNT`、`OPERATION_QUALITY_RATE`、`OPERATION_TRUSTED_ANALYSIS_SCOPE` | 5.9〜5.13 / 5.15 |
| 5 | `05-best-effort-disclosure.sql` | view `OPERATION_CONSOLE_LOG_COMPLETE_MISSING_RATE`、`OPERATION_ANALYSIS_DISCLOSURE` | 5.8 / 5.14 / 5.15 |
| 6 | `06-arrival-slo-and-notification.sql` | table function `OPERATION_ARRIVAL_SLO`、view `OPERATION_PENDING_ARRIVAL`、`OPERATION_ARRIVAL_LAG_TRANSITION`、table `OPERATION_ARRIVAL_NOTIFICATION_STATE`、`OPERATION_ARRIVAL_NOTIFICATION_TARGET`、procedure `SEND_ARRIVAL_LAG_NOTIFICATION`、alert `OPERATION_ARRIVAL_LAG_ALERT` | 6.1〜6.6 / 6.13 |
| 7 | `07-retention.sql` | view `OPERATION_RAW_ARRIVAL_RETENTION`、task `OPERATION_RAW_ARRIVAL_RETENTION_TASK`、`OPERATION_RAW_ARRIVAL` の Time Travel 0 日 | 6.8 / 6.9 |
| 8 | `08-access-control.sql` | schema `GOVERNANCE`、tag `DATA_CLASSIFICATION`、role `OPERATION_HISTORY_ANALYST`、database 単位の SELECT／USAGE grant | 6.10 / 6.11 / 6.12 |

## 責務の分離（層ごとの担当と定義の正本）

`RAW` schema は取込と raw 保持で止め、判定を持ち込まない。判定は `ANALYSIS` schema が raw を読むだけで行う。

| 層 | 担当 | 定義の正本 |
| --- | --- | --- |
| raw arrival | `01` / `02`（タスク 13.1） | canonical 表現は `src/operation-history/codec.ts` |
| 重複収束後 record、相関結果 | `03`（タスク 13.2） | `src/operation-history/correlation.ts` |
| 品質率・信頼済み分析の範囲 | `04`（タスク 13.2） | `src/operation-history/quality.ts` |
| best-effort 表示・完全未観測率 | `05`（タスク 13.3） | `src/operation-history/quality.ts` |
| 到達 SLO・通知 | `06`（タスク 13.4） | `src/operation-history/slo.ts` |
| Snowflake 25 UTC 暦月の保持 | `07`（タスク 13.5） | 要件 6.8 / 6.9 |
| R2 90 日の保持 | `config/operation-history-r2/raw-arrival-lifecycle.json`（タスク 13.5） | 要件 6.7 / 6.9 |
| 分類と承認済み分析担当者への access 制御 | `08`（タスク 13.6） | 要件 6.10〜6.12 |

純粋層の定義を SQL 側で読み替えて別定義を作らない。品質判定の根拠となる raw arrival は判定の前後で削除しない
（要件 5.7）。

## 判定層（`03` / `04`）の前提

- **期間（`PERIOD`）は Operation Record 内の `eventTime` の UTC 暦日**（期待記録は復元された Event Time）。
  観測側時刻を期間の根拠にしない（要件 5.4）。欠落と孤児の判定自体は店舗×timer 単位で観測全体に対して行い、
  期間は集計の割り当てにしか使わない。暦月が必要なら上位で丸める（期間の定義を二つ作らない）。
- **分母 0 は数値 0 ではない。** `VALUE` を NULL に保ち、`STATUS = 'not-calculable'` と
  `NOT_CALCULABLE_REASON = 'denominator-is-zero'` で算出不能として持つ（要件 5.13）。
- **閾値の実値はリポジトリに置かない。** `OPERATION_QUALITY_THRESHOLD` の四行は運用者が手順書に従って入れる。
  四行が揃わない品質率は `threshold-not-configured` として信頼済み分析から除外する（fail closed）。

## 表示層（`05`）の前提

- **生産能力指標そのものを発明しない。** 何を能力として数えるかは requirements にも design にも定義が無い。
  `05` は表示（disclosure）の付与に留め、指標を作る側が `OPERATION_ANALYSIS_DISCLOSURE` を `STORE_ID` と
  `PERIOD` で join する（要件 5.8）。
- **完全未観測率は測定不能であって算出不能ではない。** Producer telemetry の総数を下流から観測できないため、
  `OPERATION_CONSOLE_LOG_COMPLETE_MISSING_RATE` は数の列を持たない。分母 0 の算出不能
  （`denominator-is-zero`）と同じ語にしない。lifecycle 内欠落率（`OPERATION_QUALITY_RATE` の
  `lifecycleMissingRate` 行）とは列名を分けて並べる（要件 5.14）。

## 到達 SLO・通知層（`06`）の前提

- **月の集合は入力である。** 月次 SLO は view ではなく月を引数に取る table function
  （`OPERATION_ARRIVAL_SLO`）である。どの月を見るかは呼ぶ側が決める（純粋層 `slo.ts` の `utcMonths` と
  同じ）。SQL 側に月軸を持たせると、保持期間や観測範囲に依存した二つ目の定義が生まれる。母集団 0 件の月も
  一行として返り、率は NULL のまま `not-applicable` になる（要件 6.4）。
- **未到達は stage を読むしかない。** 取込済みの `OPERATION_RAW_ARRIVAL` は `SNOWFLAKE_ARRIVED_AT` を必ず
  持つため、「Snowflake 未到達」は取込済みの表からは原理的に見えない。`OPERATION_PENDING_ARRIVAL` は
  stage（R2 object）を読み、canonical bytes 単位の anti-join で未取込分を出す。object key 単位で引くと、
  重複配送のうち一件が取込済みの record を未到達に数えてしまう。
- **費用は object 数に比例する。** stage の全 object を読むため、alert の周期ごとに object 数相当の費用が
  かかる。path で刈ると最古の未到達 record を見失い、帯が誤って戻って同じ遷移を二度通知する（要件 6.5 /
  6.6 の「当該連続状態につき一回」を壊す）。ゆえに刈らない。
- **覆う範囲の限界を偽らない。** 見えるのは R2 まで到達した未取込分だけである。Tail Worker から
  Queue／Consumer の間に滞留している分は属性の出所が Snowflake から読めないため現れない。その滞留は
  Consumer の再配送方針と dead-letter が扱う。観測できない分を推定しない。
- **連続状態の記憶が一つだけある。** `OPERATION_ARRIVAL_NOTIFICATION_STATE` の一行が `slo.ts` の
  `previousBand` である。通知できなかったとき（通知先未設定）は帯を進めない（fail closed）。

## 保持層（`07`）の前提

- **期限は月単位である。** 初回 Snowflake 到達月を第 1 月とする 25 UTC 暦月が終了した時点、すなわち第 1 月の
  初日から 25 か月後の 00:00 UTC が削除の開始点である（要件 6.8）。月内のどの時刻に到達しても同じ期限に
  なる。日時単位の期限を発明しない。
- **削除の述語は期限だけである。** `07` だけが raw arrival の `DELETE` を持つ。`03`〜`06` は view と帯の記憶
  しか持たないため、期限前に保持期限を理由とする削除は起こらない（要件 6.9）。品質判定の根拠 raw も期限まで
  残る（要件 5.7）。
- **Time Travel を抜け道にしない。** `OPERATION_RAW_ARRIVAL` の `DATA_RETENTION_TIME_IN_DAYS` を 0 にする。
  正の値なら `DELETE` 後も `AT` / `BEFORE` で読めてしまい、「24 時間以内に削除を完了する」と両立しない。
  Fail-safe（永続 table の 7 日・設定不可）は Snowflake 内部の領域でどの role からも query できない。消すには
  table を `TRANSIENT` で作り直すしかなく、既存 raw を捨てるため行わない。
- **R2 の 90 日は別の期限である。** 起点も実行主体も違う（R2 の object lifecycle）。正本は
  `config/operation-history-r2/raw-arrival-lifecycle.json` であり、SQL 側へ 90 日を写さない。

## 分類・access 層（`08`）の前提

- **分類の語は一つである。** tag `DATA_CLASSIFICATION` の `ALLOWED_VALUES` を
  `confidential-business-non-personal` 一値にする。自由文字列にすると `confidential` / `internal` / `PII` の
  ような第二の語が後から付き、どれが正本か分からなくなる（要件 6.10）。database へ一度付ければ継承で全
  object へ降りる。object ごとに付け直すと、付け忘れた object だけが分類の外へ落ちる。object tagging は
  Enterprise Edition 以上を要する。使えない account では第二の正本を発明せず、手順書に従って停止する。
- **読める範囲を object で列挙しない。** grant は database 単位の `ALL` と `FUTURE` だけである。列挙すると層を
  足すたびに追記漏れが起き、承認済み分析担当者から見えない object が生まれる（要件 6.11 の未達）。`FUTURE` は
  database 単位だけに置く。schema 単位の future grant を併置すると Snowflake はそちらを優先し、覆う範囲が
  静かに縮む。
- **与える権限は `SELECT` と `USAGE` だけである。** ゆえに承認済みであっても record、品質指標、分析結果を
  変えられない。閾値と通知先の投入、task と alert の起動、通知の送信は運用者の権限として分けたままにする
  （要件 6.12）。
- **拒否のための文を書かない。** 未承認主体の拒否は Snowflake の既定拒否そのものである。`08` は DML を持たず
  task も alert も procedure も作らないため、拒否を契機に走る文が存在しない。拒否の記録を table へ書き足すと
  拒否が write になる（要件 6.12）。
- **アクセス承認状態はリポジトリに置かない。** 承認状態は role member（`GRANT ROLE ... TO USER`）であり、
  credential と同じ規律で運用者が与える。`08` に実名も member も無い。

## canonical と観測側 metadata の分離

`OPERATION_RAW_ARRIVAL` は一到達一行で、canonical Operation Record（`CANONICAL_LINE`）と観測側 metadata
（`OBJECT_KEY` / `FIRST_OBSERVED_AT` / `QUEUE_MESSAGE_ID` / `DELIVERY_ATTEMPT` / `R2_LAST_MODIFIED_AT` /
`SNOWFLAKE_ARRIVED_AT`）を別の列として持つ。観測側の値を Operation Record の属性、identity、連番、Timer
永続 identity として扱わない（要件 5.4）。

`CANONICAL_LINE` は VARIANT へ parse せず文字列のまま持つ。VARIANT は属性順を正規化するため canonical bytes
が失われ、hash と byte 一致の根拠が消える。

## 取込の前提（Snowflake / R2 の制約）

- **object の user metadata は読めない。** Snowflake が stage object について公開するのは
  `METADATA$FILENAME` / `FILE_ROW_NUMBER` / `FILE_CONTENT_KEY` / `FILE_LAST_MODIFIED` /
  `START_SCAN_TIME` だけで、R2 の `customMetadata`（S3 の `x-amz-meta-*` も同様）は含まれない
  （[Query metadata for staged files](https://docs.snowflake.com/en/user-guide/querying-metadata)）。
  ゆえに `firstObservedAt` / `queueMessageId` / `deliveryAttempt` は object key から読み、`arrivedAt` は
  R2 put 時刻（`METADATA$FILE_LAST_MODIFIED`）で代え、`canonicalHash` は canonical 一行から再計算する。
- **object key の文法の正本は `src/data-platform/raw-arrival-consumer.ts`。**
  `raw/{YYYY}/{MM}/{DD}/{firstObservedAt}-{queueMessageId}-{deliveryAttempt}.json`。
  SQL 側はこれを末尾一致の正規表現で読むだけで key を作らない。両者の一致は
  `tests/operation-history/snowflake-ingest.static.test.ts` が検査する。
- **S3 互換 stage は Snowpipe auto-ingest に対応しない。** pipe は `AUTO_INGEST = FALSE` とし、Snowpipe REST
  の `insertFiles` で駆動する（手順書 §4）。`ALTER PIPE ... REFRESH` は 7 日以内の復旧用途に限る。

## credential

`01-raw-arrival-ingest.sql` の `<R2_ACCOUNT_ID>` / `<R2_ACCESS_KEY_ID>` / `<R2_SECRET_ACCESS_KEY>` は
プレースホルダである。実値は実行時に置換し、置換後のファイルを commit しない。

`06-arrival-slo-and-notification.sql` の `<OPERATION_HISTORY_WAREHOUSE>`（alert を走らせる warehouse）、
`07-retention.sql` の同名プレースホルダ（保持 task を走らせる warehouse）、`08-access-control.sql` の
`<OPERATION_HISTORY_ANALYST_WAREHOUSE>`（分析担当者が読むための warehouse）も同じ規律で扱う。通知先
（integration 名と宛先）は運用設定ゆえ SQL 正本に持たず、運用者が
`OPERATION_ARRIVAL_NOTIFICATION_TARGET` の一行として入れる（品質閾値と同じ扱い）。

承認済み分析担当者の実名も同じ規律である。`08` は role を作るだけで、誰にその role を与えたかを持たない
（`GRANT ROLE ... TO USER` は手順書だけにあり、実名はプレースホルダである）。
