# R2 90 日と Snowflake 25 UTC 暦月の保持を構成する手順（operation-history-log）

> 対象 spec: `operation-history-log` / タスク 13.5「R2 90 日と Snowflake 25 UTC 暦月の保持を構成する」
> 種別: ［手続き］（R2 bucket 設定と Snowflake はいずれも account／外部サービス側の状態ゆえ、リポジトリから
> 適用されない。ユーザーが本手順に従い実行する）
> 正本: `requirements.md` 要件 6.7〜6.9、`design.md` 節「SLO・保持・機密性」
> 適用する宣言的定義: [`config/operation-history-r2/`](../../config/operation-history-r2/README.md)（R2）、
> [`config/operation-history-snowflake/07-retention.sql`](../../config/operation-history-snowflake/07-retention.sql)（Snowflake）
> 前段: [`snowflake-slo-procedure.md`](./snowflake-slo-procedure.md)（到達 SLO・通知層・タスク 13.4）

---

## 0. この文書の位置づけ

保持は**二つの独立した期限**である。どちらも他方を根拠にしない。

| 対象 | 期限 | 起点 | 削除の実行主体 | 正本 |
| --- | --- | --- | --- | --- |
| R2 object | 90 日（要件 6.7） | R2 保存成功時刻（object の upload 時刻） | R2 の object lifecycle | `config/operation-history-r2/raw-arrival-lifecycle.json` |
| Snowflake 記録 | 25 UTC 暦月（要件 6.8） | 初回 Snowflake 到達月を第 1 月とする 25 か月の終了時点 | task `OPERATION_RAW_ARRIVAL_RETENTION_TASK` | `config/operation-history-snowflake/07-retention.sql` |

どちらも削除開始後 24 時間以内に完了する（要件 6.8）。期限に達していない間、保持期限を理由とする削除は
0 件である（要件 6.9）。品質判定の根拠 raw arrival も期限までは残る（要件 5.7）。

この段で作らないもの: 分類と承認済み分析担当者への access 制御（タスク 13.6・
[`snowflake-access-procedure.md`](./snowflake-access-procedure.md)）。本手順は role も grant も tag も触らない。

Timer 本体との関係は一方向のままである。本手順のどの操作も Producer と `StoreTimerDO` を呼ばない
（要件 4.13 / 4.14）。削除は下流の記録にだけ効き、Producer へ再出力を要求しない。

---

## 1. 前提

- [ ] タスク 13.1 の手順を完了し、`OPERATION_HISTORY.RAW.OPERATION_TELEMETRY_FIRST_ARRIVAL` が引ける。
- [ ] R2 bucket `operation-raw-arrivals` が存在する（`wrangler.raw-arrival-consumer.jsonc` の
      `r2_buckets` が指す bucket）。
- [ ] R2 の lifecycle を書ける API token を使える（**Workers R2 Storage Write** 権限グループ。lifecycle の
      管理は bucket 単位の操作である）。
- [ ] Snowflake で `CREATE VIEW` / `CREATE TASK` / `ALTER TABLE` を実行できる role を使える。task の起動には
      `EXECUTE TASK` 権限が要る。
- [ ] task を走らせる warehouse を決めた（`07` の `<OPERATION_HISTORY_WAREHOUSE>` に入れる）。

---

## 2. R2 の 90 日保持を構成する（要件 6.7 / 6.9）

### 2-1. 現在の lifecycle を記録する

`set` は既存 rule を全部置き換える。適用前の状態を残しておく。

```sh
pnpm exec wrangler r2 bucket lifecycle list operation-raw-arrivals
```

- [ ] 出力を控えたこと。新規 bucket なら bucket 既定の「incomplete multipart upload を 7 日で中止」だけが
      見えるはずである。

### 2-2. 宣言的正本を適用する

```sh
pnpm exec wrangler r2 bucket lifecycle set operation-raw-arrivals \
  --file config/operation-history-r2/raw-arrival-lifecycle.json
```

上書きの確認を求められる。JSON はリポジトリの正本ゆえ、内容を編集して渡さない。

- [ ] 適用後の rule が **1 件だけ**であること。

```sh
pnpm exec wrangler r2 bucket lifecycle list operation-raw-arrivals
```

- [ ] `operation-raw-arrival-90-days` が `enabled = Yes`、prefix `raw/`、action
      `Expire objects after 90 days` であること。
- [ ] **90 日より短い expire も storage class transition も無いこと**（あれば期限前の削除が起こり得る。
      要件 6.9）。

bucket 既定の multipart 中止 rule は上書きで消える。Consumer は一回の `put` だけを使い multipart upload を
作らないため、この bucket に中止対象は存在しない（`src/data-platform/raw-arrival-consumer.ts`）。

### 2-3. 期限の起点と完了を確認する（要件 6.7）

```sh
pnpm exec wrangler r2 object get operation-raw-arrivals/raw/<YYYY>/<MM>/<DD>/<key>.json --pipe > /dev/null
```

- [ ] 応答の `x-amz-expiration` が put 時刻 + 90 日を指すこと（起点が保存成功時刻であること）。
- [ ] 期限前の object が消えていないこと（要件 6.9）。`raw/` 配下の最古 object の日付が 90 日以内である
      ことで確認する。

```sh
pnpm exec wrangler r2 object list operation-raw-arrivals --prefix raw/ | head
```

削除完了までの時間は Cloudflare の documented behavior に依る。expire 条件を満たした object は通常 24 時間
以内に消える（要件 6.8 の 24 時間）。前倒しの削除 job を足さない。

---

## 3. Snowflake の 25 UTC 暦月保持を構成する（要件 6.8 / 6.9）

### 3-1. 宣言的定義を適用する

`<OPERATION_HISTORY_WAREHOUSE>` を実在の warehouse 名へ置換する。**置換後のファイルを commit しない**
（`01` の credential と同じ規律）。

```sh
snow sql --filename config/operation-history-snowflake/07-retention.sql
```

- [ ] view `OPERATION_RAW_ARRIVAL_RETENTION` と task `OPERATION_RAW_ARRIVAL_RETENTION_TASK` ができたこと。
- [ ] `SHOW TABLES LIKE 'OPERATION_RAW_ARRIVAL' IN SCHEMA OPERATION_HISTORY.RAW;` の
      `retention_time` が `0` であること。

`DATA_RETENTION_TIME_IN_DAYS = 0` は Time Travel を切る。正の値なら DELETE 後も `AT` / `BEFORE` で
消したはずの行が読めてしまい、「24 時間以内に削除を完了する」と両立しない。誤削除からの復旧手段も同時に
失うが、削除は下の task だけが行い、その述語は期限だけである。

Fail-safe（永続 table の 7 日・設定不可）は Snowflake 内部の災害復旧領域であり、どの role からも query
できない。これを無くすには table を `TRANSIENT` で作り直すしかなく、作り直しは既存 raw を捨てる。ゆえに
本手順では行わない。

### 3-2. 期限を確認する（要件 6.8）

```sql
SELECT FIRST_SNOWFLAKE_UTC_MONTH,
       RETENTION_UTC_MONTHS,
       MIN(RETENTION_EXPIRES_AT) AS EXPIRES_AT,
       MIN(DELETE_BY)            AS DELETE_BY,
       COUNT(*)                  AS RECORDS,
       COUNT_IF(IS_EXPIRED)      AS EXPIRED_RECORDS
  FROM OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL_RETENTION
 GROUP BY FIRST_SNOWFLAKE_UTC_MONTH, RETENTION_UTC_MONTHS
 ORDER BY FIRST_SNOWFLAKE_UTC_MONTH;
```

- [ ] `RETENTION_UTC_MONTHS` が全行 `25` であること。
- [ ] `EXPIRES_AT` が「初回到達月の初日 + 25 か月」の 00:00 であること（第 1 月を含めて 25 暦月）。
      例: 初回到達が `2026-06` の任意の時刻なら `2028-07-01 00:00`。
- [ ] `DELETE_BY` が `EXPIRES_AT` + 24 時間であること。
- [ ] 運用開始から 25 暦月未満なら `EXPIRED_RECORDS` が全月 `0` であること（要件 6.9）。

### 3-3. task を起動する

期限前は 0 行の DELETE で終わることを、手で一度確かめてから起動する。

```sql
EXECUTE TASK OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL_RETENTION_TASK;

SELECT NAME, SCHEDULED_TIME, STATE, ERROR_MESSAGE
  FROM TABLE(INFORMATION_SCHEMA.TASK_HISTORY(
    SCHEDULED_TIME_RANGE_START => DATEADD('HOUR', -1, CURRENT_TIMESTAMP())))
 WHERE NAME = 'OPERATION_RAW_ARRIVAL_RETENTION_TASK'
 ORDER BY SCHEDULED_TIME DESC;
```

- [ ] `STATE = SUCCEEDED` であること。
- [ ] 期限に達した record が無い間、`OPERATION_RAW_ARRIVAL` の行数が**変わらない**こと（要件 6.9 / 5.7）。

```sql
ALTER TASK OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL_RETENTION_TASK RESUME;
```

- [ ] `SHOW TASKS IN SCHEMA OPERATION_HISTORY.RAW;` で `state = started`、
      `schedule = USING CRON 0 * * * * UTC` であること。**24 時間より長い間隔にしないこと**（要件 6.8 の
      「24 時間以内に完了」が満たせなくなる）。

### 3-4. 期限後を確認する（要件 6.8）

期限を跨いだ最初の周期で確認する。

```sql
SELECT COUNT(*) AS EXPIRED_RECORDS_REMAINING
  FROM OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL_RETENTION
 WHERE IS_EXPIRED;
```

- [ ] 期限の 24 時間後には `0` であること（削除が完了したこと）。
- [ ] 期限に達していない月の record が残っていること（削除が期限だけを根拠にしていること。要件 6.9）。
- [ ] 期限に達した record は**全到達行**が消えていること（一到達だけ残らないこと）。

```sql
SELECT COUNT(*) AS ARRIVAL_ROWS
  FROM OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL arrival
 WHERE NOT EXISTS (
   SELECT 1 FROM OPERATION_HISTORY.RAW.OPERATION_TELEMETRY_FIRST_ARRIVAL first_arrival
    WHERE first_arrival.CANONICAL_LINE = arrival.CANONICAL_LINE
 );
```

---

## 4. 二つの期限が独立であること

R2 の 90 日が過ぎても Snowflake 記録は 25 UTC 暦月まで残る。逆に Snowflake 記録が消えても R2 object の期限は
変わらない。どちらの削除も他方を起点にしない。

R2 object が消えると、`OPERATION_PENDING_ARRIVAL`（タスク 13.4・stage を読む view）から 90 日より古い未取込
分が見えなくなる。これは覆う範囲の縮小であって、未到達の推定でも補完でもない。観測できない分を推定しない
（要件 4.8）。

---

## 5. 停止と切戻し

Snowflake 側:

```sql
ALTER TASK OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL_RETENTION_TASK SUSPEND;
```

- [ ] 停止しても raw arrival、品質 view、表示 view、SLO が変わらないこと（要件 5.7）。
- [ ] 停止中は保持期限を過ぎた記録が残る。これは要件 6.8 の未達であり、再開までの期間を記録すること。

R2 側は 2-1 で控えた rule へ戻す。lifecycle を空にすると 90 日の削除が止まる（要件 6.8 の未達）。

```sh
pnpm exec wrangler r2 bucket lifecycle remove operation-raw-arrivals \
  --name operation-raw-arrival-90-days
```

どちらの停止も Timer 本体の state migration も rollback も要らない。backfill も Producer 再出力も DO 再起動も
必要としない（要件 1.8 / 4.8）。

---

## 参照

- 要件: 6.7（R2 90 日で削除開始・24 時間以内に完了）、6.8（Snowflake 25 UTC 暦月）、6.9（期限前の保持期限
  削除 0 件）、5.7（品質根拠 raw を削除しない）
- 設計: `design.md` 節「SLO・保持・機密性」、節「保持の確定結果（タスク13.5）」
- 検査: `tests/operation-history/retention.static.test.ts`
- 後続タスク: 13.6（分類・access 制御・[`snowflake-access-procedure.md`](./snowflake-access-procedure.md)）、
  13.7（clock-controlled な境界 integration テスト）、15.1（local config smoke）、15.2（下流 smoke 手順）
