# R2 raw arrival を Snowpipe で Snowflake へ取り込む手順（operation-history-log）

> 対象 spec: `operation-history-log` / タスク 13.1「R2 raw arrival を Snowpipe で Snowflake へ取り込む」
> 種別: ［手続き］（Snowflake は外部サービスゆえリポジトリから適用できない。ユーザーが本手順に従い実行する）
> 正本: `requirements.md` 要件 4.6 / 5.3 / 5.4 / 5.5 / 5.6 / 5.7 / 6.1、`design.md` 節「6. Snowpipe と Snowflake」・節「Deployment and Configuration Ownership」
> 適用する宣言的定義: [`config/operation-history-snowflake/`](../../config/operation-history-snowflake/README.md)

---

## 0. この文書の位置づけ

Snowflake 側 object の正本は `config/operation-history-snowflake/*.sql` にある。本書はその適用と疎通確認の
手順だけを与える。SQL の内容を本書へ写して二重に持たない。

この段で作るのは **raw arrival 層と要件 6.1 の関連付けだけ**である。相関、重複収束、欠落／孤児／競合、
品質率、SLO 通知、保持期限、access 制御はタスク 13.2〜13.6 が別の責務として足す。純粋層
（`src/operation-history/correlation.ts`・`quality.ts`・`slo.ts`）の定義を SQL 側で読み替えない。

Timer 本体との関係は一方向のままである。本手順のどの操作も Producer と `StoreTimerDO` を呼ばず、
construct・wake・rehydrate の原因にならない（要件 4.13 / 4.14）。取込を止めても Timer 操作は変わらず、
止めた期間の backfill も行わない（要件 4.8）。

---

## 1. 前提

- [ ] Snowflake account があり、`CREATE DATABASE` / `CREATE STAGE` / `CREATE PIPE` を実行できる role を使える。
- [ ] R2 bucket `operation-raw-arrivals` が存在し、Consumer（`wrangler.raw-arrival-consumer.jsonc`）が
      `raw/...` へ put できている（タスク 10.2 / 10.3 で検証済み）。
- [ ] R2 の S3 互換 API 用 access key（read 権限）と account id を用意した。
- [ ] credential をリポジトリへ書かない。`01-raw-arrival-ingest.sql` のプレースホルダは実行時にだけ置換し、
      置換後のファイルを commit しない。

R2 の endpoint（`<account_id>.r2.cloudflarestorage.com`）は Snowflake の S3 互換 stage として既定で有効で
あり、Snowflake Support への申請は要らない。

---

## 2. 宣言的定義を適用する

`config/operation-history-snowflake/` の SQL を番号順に実行する。いずれも `IF NOT EXISTS` ゆえ再実行できる。

```sh
# Snowflake CLI（snow sql）を使う例。Snowsight の worksheet に貼っても同じ。
# <...> のプレースホルダは実行前に実値へ置換する（置換後のファイルを commit しない）。
snow sql --filename config/operation-history-snowflake/01-raw-arrival-ingest.sql
snow sql --filename config/operation-history-snowflake/02-first-arrival-association.sql
```

- [ ] `01` が database `OPERATION_HISTORY`、schema `RAW`、file format `CANONICAL_OPERATION_LINE`、
      stage `OPERATION_RAW_ARRIVALS`、table `OPERATION_RAW_ARRIVAL`、pipe `OPERATION_RAW_ARRIVAL_PIPE`
      を作ったこと。
- [ ] `02` が view `OPERATION_TELEMETRY_FIRST_ARRIVAL` を作ったこと。

stage が R2 を読めることを確認する。

```sql
LIST @OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVALS;
```

- [ ] Consumer が put した `raw/{YYYY}/{MM}/{DD}/{firstObservedAt}-{queueMessageId}-{deliveryAttempt}.json`
      が一覧に出ること。出ない場合は endpoint、bucket 名、access key の権限を順に疑う。

pipe が動作可能な状態にあることを確認する。

```sql
SELECT SYSTEM$PIPE_STATUS('OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL_PIPE');
```

- [ ] `executionState` が `RUNNING` であること。

---

## 3. 取込を駆動する

S3 互換 stage は S3 event 通知による Snowpipe auto-ingest に対応しない。ゆえに pipe は
`AUTO_INGEST = FALSE` であり、**Snowpipe REST の `insertFiles`** で「どの object を取り込むか」を渡す。

```text
POST https://{account}.snowflakecomputing.com/v1/data/pipes/OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL_PIPE/insertFiles?requestId={uuid}
```

- 認証は key-pair（JWT）である。ingestion service は client session を持たない。
- body に stage 相対の object path を並べる。応答の成功は「取込予定として記録した」ことを意味し、取込完了は
  意味しない。取込結果は `insertReport` または `loadHistoryScan` で確認する。
- 詳細は [Snowpipe REST endpoints](https://docs.snowflake.com/en/user-guide/data-load-snowpipe-rest-apis) と
  [Option 1: Load data with the Snowpipe REST API](https://docs.snowflake.com/en/user-guide/data-load-snowpipe-rest-load)。

`insertFiles` を定期的に呼ぶ駆動主体（Data Platform 所有）はまだ実装していない。**未確定事項**として
タスク 13.7 / 15.2 へ引き渡す。駆動主体を足すときも、Producer 設定（root `wrangler.jsonc`）へ Snowflake
credential や binding を置かず、Producer を呼び戻す経路を作らない（要件 4.13 / 4.14）。

手動の疎通確認と、取り込み漏れの復旧には `ALTER PIPE ... REFRESH` を使う。**7 日以内に staged された object
だけが対象**で、短期の復旧用途に限る（常用しない）。

```sql
-- 疎通確認・復旧用。日付 prefix で対象を絞れる。
ALTER PIPE OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL_PIPE REFRESH PREFIX = '2026/06/26/';
```

---

## 4. 取込結果を確認する

### 4-1. canonical と観測側 metadata が分離して入る（要件 5.3 / 5.4）

```sql
SELECT CANONICAL_LINE, OBJECT_KEY, FIRST_OBSERVED_AT, QUEUE_MESSAGE_ID, DELIVERY_ATTEMPT,
       R2_LAST_MODIFIED_AT, SNOWFLAKE_ARRIVED_AT
  FROM OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL
  ORDER BY SNOWFLAKE_ARRIVED_AT DESC
  LIMIT 10;
```

- [ ] `CANONICAL_LINE` が Producer が出した canonical 一行と byte 単位で一致すること（前後に空白や引用符が
      付かず、`\uXXXX` や `\\` が壊れていないこと）。
- [ ] `FIRST_OBSERVED_AT` / `QUEUE_MESSAGE_ID` / `DELIVERY_ATTEMPT` が object key の値と一致すること。
- [ ] 観測側 metadata が `CANONICAL_LINE` の中へ混ざっていないこと（Operation Record の属性を汚さない）。

`producerScript` と正確な `arrivedAt` は R2 `customMetadata` にあり、Snowflake からは読めない。key に載る値と
`R2_LAST_MODIFIED_AT`（R2 put 時刻）で代える。理由は
[`config/operation-history-snowflake/README.md`](../../config/operation-history-snowflake/README.md)
の「取込の前提」を参照。

### 4-2. firstObservedAt と firstSnowflakeAt が関連付く（要件 6.1）

```sql
SELECT CANONICAL_HASH, FIRST_OBSERVED_AT, FIRST_SNOWFLAKE_AT
  FROM OPERATION_HISTORY.RAW.OPERATION_TELEMETRY_FIRST_ARRIVAL
  ORDER BY FIRST_SNOWFLAKE_AT DESC
  LIMIT 10;
```

- [ ] 各 record について両時刻が並ぶこと。15 分以内到達率の判定はタスク 13.4 が本 view の上に配線する。

### 4-3. 重複配送の raw arrival が全件残る（要件 5.5 / 5.7）

同一 record が複数回配送された場合、object key が delivery ごとに異なるため別 object・別行になる。

```sql
SELECT CANONICAL_LINE, COUNT(*) AS ARRIVALS
  FROM OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL
  GROUP BY CANONICAL_LINE
  HAVING COUNT(*) > 1;
```

- [ ] 重複到達が `n` 行として残っていること（削除も上書きもされない）。到達総数 `n` と重複数 `n - 1` の
      算出、および欠落・孤児・競合の保持はタスク 13.2（[`snowflake-quality-procedure.md`](./snowflake-quality-procedure.md)）が担う。

---

## 5. 停止と切戻し

取込の停止は pipe の一時停止だけで足りる。Timer 本体の state migration も rollback も要らない。

```sql
ALTER PIPE OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL_PIPE SET PIPE_EXECUTION_PAUSED = TRUE;
-- 再開
ALTER PIPE OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL_PIPE SET PIPE_EXECUTION_PAUSED = FALSE;
```

- [ ] 停止中も Consumer は R2 へ put を続け、raw arrival は残ること。
- [ ] 停止期間について backfill job、Producer への再出力要求、DO 再起動を行わないこと。観測できなかった分は
      欠落のまま残す（要件 4.8）。Snowpipe の load history は file 単位ゆえ、再開後の取込で行は重複しない。

---

## 6. スコープ境界（本手順で触らないもの）

- 相関、重複収束、欠落／孤児／競合、品質率（タスク 13.2。手順は
  [`snowflake-quality-procedure.md`](./snowflake-quality-procedure.md)）と best-effort 表示（13.3）を作らない。
- 到達 SLO の判定と 30／60 分通知（13.4）を作らない。
- R2 90 日・Snowflake 25 UTC 暦月の保持（13.5）と access role（13.6）を作らない。この段では raw を消さない。
- `src/operation-history/` の純粋層と `src/data-platform/` の Worker を変更しない。object key の文法の正本は
  `src/data-platform/raw-arrival-consumer.ts` であり、SQL 側は読むだけである。
- Producer 設定の SSOT（root `wrangler.jsonc`）へ Snowflake の binding、credential、route を足さない。

---

## 参照

- 要件: 4.6（R2 保存 → Snowpipe 取込）、5.3 / 5.4（補助 metadata の扱い）、5.5（重複到達の保持と収束）、
  5.6（欠落・孤児・競合の区別）、5.7（根拠 record を削除しない）、6.1（初回観測時刻と初回到達時刻の関連付け）
- 設計: `design.md` 節「6. Snowpipe と Snowflake」、節「相関・重複・品質」、節「SLO・保持・機密性」、
  節「Deployment and Configuration Ownership」
- 定義: `config/operation-history-snowflake/`（SQL 正本）、`src/operation-history/codec.ts`（canonical 表現）、
  `src/data-platform/raw-arrival-consumer.ts`（object key と R2 put）
- 検査: `tests/operation-history/snowflake-ingest.static.test.ts`（object key 文法の一致・取込 SQL の責務境界）
- 後続タスク: 13.2（相関・品質率。手順は [`snowflake-quality-procedure.md`](./snowflake-quality-procedure.md)）、
  13.3（best-effort 表示）、13.4（SLO と通知）、13.5（保持）、13.6（access 制御）、
  13.7（integration テスト）、15.2（ユーザー実行の下流 smoke 手順）
