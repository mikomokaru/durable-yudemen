# 機密業務データの分類と access 制御を構成する手順（operation-history-log）

> 対象 spec: `operation-history-log` / タスク 13.6「機密業務データのアクセス制御を実装する」
> 種別: ［手続き］（Snowflake は外部サービスゆえリポジトリからは適用されない。ユーザーが本手順に従い実行する）
> 正本: `requirements.md` 要件 6.10〜6.12、`design.md` 節「SLO・保持・機密性」「access 制御の確定結果（タスク13.6）」
> 適用する宣言的定義: [`config/operation-history-snowflake/08-access-control.sql`](../../config/operation-history-snowflake/08-access-control.sql)
> 前段: [`retention-procedure.md`](./retention-procedure.md)（保持・タスク 13.5）

---

## 0. この文書の位置づけ

`08` は Snowflake 側の最後の層である。持つものは三つだけで、それぞれ要件と一対一である。

| 項目 | 実体 | 要件 |
| --- | --- | --- |
| 分類 | tag `OPERATION_HISTORY.GOVERNANCE.DATA_CLASSIFICATION`（許可値 `confidential-business-non-personal` 一つ） | 6.10 |
| 許可 | role `OPERATION_HISTORY_ANALYST` への SELECT と USAGE だけ | 6.11 |
| 拒否 | Snowflake の既定拒否（`08` に拒否のための文は無い） | 6.12 |

**アクセス承認状態＝role member は本手順でだけ与える。** 誰が承認済みかはリポジトリに置かない（credential と
同じ規律）。`08` に `GRANT ROLE ... TO USER` は無い。

**拒否は read-only である。** `08` は DML を一つも持たず、task も alert も procedure も作らない。ゆえに拒否を
契機に走る文が存在せず、Operation Record、品質指標、分析結果、アクセス承認状態のいずれも変わらない
（要件 6.12）。拒否の記録を Snowflake の table へ書き足さない（書けば拒否が write になる）。

Timer 本体との関係は一方向のままである。本手順のどの操作も Producer と `StoreTimerDO` を呼ばない
（要件 4.13 / 4.14）。

---

## 1. 前提

- [ ] タスク 13.1〜13.5 の手順を完了し、`01`〜`07` の object が揃っている（`08` は最後に実行する。`ALL` の
      grant が対象を取り違えないため）。
- [ ] account が **Enterprise Edition 以上**である（object tagging の要件。
      [Overview of key features](https://docs.snowflake.com/en/user-guide/intro-supported-features)）。
      Standard の場合は `CREATE TAG` が失敗する。**そこで停止し、ユーザーへ確認すること。** 分類の第二の正本
      （COMMENT や独自 table）を発明しない（要件 6.10 の語を二つにしない）。
- [ ] `CREATE ROLE`（account 権限）、`CREATE SCHEMA`、`CREATE TAG`、対象 object への `GRANT` を実行できる
      role を使える。
- [ ] 分析担当者が使う warehouse を決めた（`08` の `<OPERATION_HISTORY_ANALYST_WAREHOUSE>` に入れる）。
- [ ] 承認済み分析担当者の Snowflake user 名を、承認記録（Data Platform の管理する承認状態）と突き合わせて
      確認した。**リポジトリへ書かないこと。**

---

## 2. 宣言的定義を適用する（要件 6.10 / 6.11）

`<OPERATION_HISTORY_ANALYST_WAREHOUSE>` を実在の warehouse 名へ置換する。**置換後のファイルを commit しない**
（`01` の credential と同じ規律）。

```sh
snow sql --filename config/operation-history-snowflake/08-access-control.sql
```

- [ ] schema `GOVERNANCE`、tag `DATA_CLASSIFICATION`、role `OPERATION_HISTORY_ANALYST` ができたこと。

### 2-1. 分類を確認する（要件 6.10）

database へ直接付いた分類を、その場で確認する。

```sql
SELECT TAG_NAME, TAG_VALUE, LEVEL
  FROM TABLE(OPERATION_HISTORY.INFORMATION_SCHEMA.TAG_REFERENCES('OPERATION_HISTORY', 'DATABASE'));
```

- [ ] 一行だけで、`TAG_NAME = DATA_CLASSIFICATION`、`TAG_VALUE = confidential-business-non-personal` であること
      （分類の語が一つであること）。
- [ ] `SHOW TAGS IN SCHEMA OPERATION_HISTORY.GOVERNANCE;` の `allowed_values` が一値だけであること。

継承した分だけは `SNOWFLAKE.ACCOUNT_USAGE` 側で確認する。この schema は反映に遅延がある（最大数時間）ため、
適用直後に空でも異常ではない。

```sql
SELECT LEVEL, OBJECT_NAME, TAG_VALUE
  FROM TABLE(SNOWFLAKE.ACCOUNT_USAGE.TAG_REFERENCES_WITH_LINEAGE(
    'OPERATION_HISTORY.GOVERNANCE.DATA_CLASSIFICATION'))
 ORDER BY LEVEL, OBJECT_NAME;
```

- [ ] `TAG_VALUE` が全行 `confidential-business-non-personal` であること。
- [ ] `OPERATION_RAW_ARRIVAL`（record）、`OPERATION_QUALITY_RATE`（品質指標）、
      `OPERATION_ANALYSIS_DISCLOSURE`（分析結果）がいずれも継承で現れること。

継承は database に一度付けた tag が下へ降りたものである。object ごとに付け直さない（付け忘れた object だけが
分類の外へ落ちる）。

### 2-2. 与えた権限を確認する（要件 6.11 / 6.12）

```sql
SHOW GRANTS TO ROLE OPERATION_HISTORY_ANALYST;
```

- [ ] `privilege` が `USAGE` と `SELECT` だけであること。
- [ ] `INSERT` / `UPDATE` / `DELETE` / `TRUNCATE` / `OWNERSHIP` / `MODIFY` / `MONITOR` / `OPERATE` /
      `EXECUTE TASK` / `APPLY` が**一件も無い**こと（承認済みでもデータを変えられないこと。要件 6.12）。
- [ ] `granted_on = PROCEDURE` が無いこと（通知の送信は運用者の権限である）。

```sql
SHOW FUTURE GRANTS IN DATABASE OPERATION_HISTORY;
```

- [ ] `TABLE` / `VIEW` / `SCHEMA` / `FUNCTION` の future grant があり、grantee が
      `OPERATION_HISTORY_ANALYST` だけであること。
- [ ] `SHOW FUTURE GRANTS IN SCHEMA OPERATION_HISTORY.RAW;` と `... ANALYSIS;` が**空**であること。
      schema 単位の future grant があると Snowflake はそちらを優先し、database 単位の宣言が静かに無視される
      （覆う範囲が縮む）。

---

## 3. アクセス承認状態を与える（要件 6.11）

承認済みと確認できた user だけに role を与える。`<ANALYST_USER>` を実名へ置換して一人ずつ実行する。
**実行した SQL をリポジトリへ残さないこと。**

```sql
GRANT ROLE OPERATION_HISTORY_ANALYST TO USER <ANALYST_USER>;
```

- [ ] `SHOW GRANTS OF ROLE OPERATION_HISTORY_ANALYST;` の一覧が承認記録と一致すること。
- [ ] 承認記録に無い user が一件も含まれないこと。

承認を外すときは同じ単位で戻す。データも指標も分析結果も触らない（要件 6.12）。

```sql
REVOKE ROLE OPERATION_HISTORY_ANALYST FROM USER <ANALYST_USER>;
```

---

## 4. 許可と拒否を確認する（要件 6.11 / 6.12）

### 4-1. 承認済みが読めること

承認済み user の session で、role と warehouse を切り替えて実行する。

```sql
USE ROLE OPERATION_HISTORY_ANALYST;
USE WAREHOUSE <OPERATION_HISTORY_ANALYST_WAREHOUSE>;

SELECT COUNT(*) FROM OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL;                    -- record（6.11）
SELECT COUNT(*) FROM OPERATION_HISTORY.ANALYSIS.OPERATION_QUALITY_RATE;              -- 品質指標（6.11）
SELECT COUNT(*) FROM OPERATION_HISTORY.ANALYSIS.OPERATION_TRUSTED_ANALYSIS_SCOPE;    -- 分析結果（6.11）
SELECT COUNT(*) FROM OPERATION_HISTORY.ANALYSIS.OPERATION_ANALYSIS_DISCLOSURE;       -- 分析結果（6.11）
SELECT COUNT(*) FROM TABLE(OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_SLO('2026-06')); -- 到達 SLO（6.11）
```

- [ ] いずれも成功すること。
- [ ] `SELECT COUNT(*) FROM OPERATION_HISTORY.ANALYSIS.OPERATION_PENDING_ARRIVAL;` も成功すること。
      この view は stage を読む。owner 権限で解決される想定であり、**失敗した場合はここで ad hoc に
      `GRANT READ ON STAGE` を出さず、`08` を直してから再適用すること**（正本を一つに保つ）。

### 4-2. 承認済みでも書けないこと

```sql
DELETE FROM OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL WHERE FALSE;
INSERT INTO OPERATION_HISTORY.ANALYSIS.OPERATION_QUALITY_THRESHOLD VALUES ('duplicateRate', 1.0);
CALL OPERATION_HISTORY.ANALYSIS.SEND_ARRIVAL_LAG_NOTIFICATION();
EXECUTE TASK OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL_RETENTION_TASK;
```

- [ ] 四つすべてが権限不足で失敗すること。
- [ ] 失敗の後、`OPERATION_RAW_ARRIVAL` の行数、`OPERATION_QUALITY_THRESHOLD` の四行、
      `OPERATION_QUALITY_RATE` の値が変わらないこと（要件 6.12 / 5.7）。

### 4-3. 未承認が拒否されること（要件 6.12）

role を与えていない user、または `OPERATION_HISTORY_ANALYST` 以外の role で実行する。

```sql
USE ROLE <UNAPPROVED_ROLE>;

SELECT COUNT(*) FROM OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL;
SELECT COUNT(*) FROM OPERATION_HISTORY.ANALYSIS.OPERATION_QUALITY_RATE;
SELECT COUNT(*) FROM OPERATION_HISTORY.ANALYSIS.OPERATION_ANALYSIS_DISCLOSURE;
```

- [ ] いずれも失敗すること（database が見えないか、object が見えない）。
- [ ] 拒否の前後で次の四つが**変わらない**こと（要件 6.12）。運用 role で拒否の前後に一度ずつ確認する。
  - [ ] `OPERATION_RAW_ARRIVAL` の行数（Operation Record）
  - [ ] `OPERATION_QUALITY_RATE` の `NUMERATOR` / `DENOMINATOR` / `STATUS`（品質指標）
  - [ ] `OPERATION_TRUSTED_ANALYSIS_SCOPE` の `TRUSTED_ANALYSIS_STATUS`（分析結果）
  - [ ] `SHOW GRANTS OF ROLE OPERATION_HISTORY_ANALYST;` の一覧（アクセス承認状態）
- [ ] `PUBLIC` role で同じ三つの query が失敗すること。

```sql
SHOW GRANTS ON DATABASE OPERATION_HISTORY;
```

- [ ] grantee に `PUBLIC` が現れないこと（未承認主体が既定で拒否されること）。

---

## 5. R2 側の同じ record について（要件 6.10）

同じ Operation Record は R2 の raw object としても存在する。分類は保存先で変わらない。R2 側の読み手は
Consumer の binding と運用者の API token だけであり、公開経路を持たない。

```sh
pnpm exec wrangler r2 bucket dev-url get operation-raw-arrivals
pnpm exec wrangler r2 bucket domain list operation-raw-arrivals
```

- [ ] `r2.dev` の公開 URL が無効であること。
- [ ] custom domain が接続されていないこと。

R2 の access token は credential ゆえリポジトリに置かない（`01` の `<R2_ACCESS_KEY_ID>` と同じ規律）。

---

## 6. 停止と切戻し

承認を全部外す（role は残す）。

```sql
SHOW GRANTS OF ROLE OPERATION_HISTORY_ANALYST;
REVOKE ROLE OPERATION_HISTORY_ANALYST FROM USER <ANALYST_USER>;
```

- [ ] 外した後も Operation Record、品質指標、分析結果が変わらないこと（要件 6.12）。
- [ ] 取込、品質判定、SLO、通知、保持 task が動き続けること（access は読み手の話であり、下流の判定に
      関与しない）。

role 自体を落とす場合、分類 tag は残す。分類（要件 6.10）は誰が読めるかとは独立である。

```sql
DROP ROLE IF EXISTS OPERATION_HISTORY_ANALYST;
```

どの停止も Timer 本体の state migration も rollback も要らない。backfill も Producer 再出力も DO 再起動も
必要としない（要件 1.8 / 4.8）。

---

## 参照

- 要件: 6.10（個人情報ではない機密業務データとしての分類）、6.11（承認済み分析担当者だけに許可）、
  6.12（未承認は拒否し、record・品質指標・分析結果・アクセス承認状態を変更しない）
- 設計: `design.md` 節「SLO・保持・機密性」、節「access 制御の確定結果（タスク13.6）」
- 検査: `tests/operation-history/snowflake-access.static.test.ts`
- 後続タスク: 13.7（承認済み／未承認アクセスと拒否後不変の integration テスト）、15.1（local config smoke）、
  15.2（下流 smoke 手順）
