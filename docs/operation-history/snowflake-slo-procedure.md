# 月次到達 SLO と 30／60 分通知を Snowflake へ配線する手順（operation-history-log）

> 対象 spec: `operation-history-log` / タスク 13.4「月次 99%／15 分 SLO と 30／60 分通知を運用経路へ配線する」
> 種別: ［手続き］（Snowflake は外部サービスゆえリポジトリから適用できない。ユーザーが本手順に従い実行する）
> 正本: `requirements.md` 要件 6.1〜6.6 / 6.13、`design.md` 節「SLO・保持・機密性」
> 適用する宣言的定義: [`config/operation-history-snowflake/`](../../config/operation-history-snowflake/README.md)
> 前段: [`snowflake-disclosure-procedure.md`](./snowflake-disclosure-procedure.md)（表示層・タスク 13.3）

---

## 0. この文書の位置づけ

Snowflake 側 object の正本は `config/operation-history-snowflake/06-arrival-slo-and-notification.sql` に
ある。本書はその適用と確認の手順だけを与える。SQL の内容を本書へ写して二重に持たない。

**定義の正本は純粋層である。** `src/operation-history/slo.ts` の `operationArrivalSloByUtcMonth` と
`snowflakeArrivalNotificationTransition` が判定値・語・表示文を定める。SQL はそれを写すだけで、言い換え
ない。両者の一致は `tests/operation-history/snowflake-slo.static.test.ts` が機械検査する。

この段で作るもの: UTC 暦月の到達 SLO（要件 6.2〜6.4 / 6.13）と、未到達最古 record の 30／60 分帯への
遷移通知（要件 6.5 / 6.6）。

この段で作らないもの: R2 90 日と Snowflake 25 UTC 暦月の保持（タスク 13.5）、access role（13.6）。
品質率と信頼判定は 13.2 の `04`、best-effort 表示は 13.3 の `05` が正本であり、ここで作り直さない。

Timer 本体との関係は一方向のままである。本手順のどの操作も Producer と `StoreTimerDO` を呼ばない
（要件 4.13 / 4.14）。通知は Data Platform 内の宛先へ出すだけで、Producer への再出力要求にしない。

---

## 1. 前提

- [ ] タスク 13.1 の手順を完了し、`OPERATION_HISTORY.RAW.OPERATION_TELEMETRY_FIRST_ARRIVAL` が引ける。
- [ ] `CREATE FUNCTION` / `CREATE VIEW` / `CREATE TABLE` / `CREATE PROCEDURE` / `CREATE ALERT` を実行できる
      role を使える。alert の実行には `EXECUTE ALERT` 権限が要る。
- [ ] alert を走らせる warehouse を決めた（`06` の `<OPERATION_HISTORY_WAREHOUSE>` に入れる）。
- [ ] 通知宛先を決めた。email notification integration の `ALLOWED_RECIPIENTS` に入れる宛先である。

---

## 2. 宣言的定義を適用する

`<OPERATION_HISTORY_WAREHOUSE>` を実在の warehouse 名へ置換する。**置換後のファイルを commit しない**
（`01` の credential と同じ規律）。

```sh
snow sql --filename config/operation-history-snowflake/06-arrival-slo-and-notification.sql
```

- [ ] table function `OPERATION_ARRIVAL_SLO`、view `OPERATION_PENDING_ARRIVAL` と
      `OPERATION_ARRIVAL_LAG_TRANSITION`、table `OPERATION_ARRIVAL_NOTIFICATION_STATE` と
      `OPERATION_ARRIVAL_NOTIFICATION_TARGET`、procedure `SEND_ARRIVAL_LAG_NOTIFICATION`、
      alert `OPERATION_ARRIVAL_LAG_ALERT` ができたこと。
- [ ] `OPERATION_ARRIVAL_NOTIFICATION_STATE` が一行だけ持ち、`BAND = 'under-thirty-minutes'` であること
      （再実行しても増えない）。

---

## 3. 月次到達 SLO を確認する（要件 6.2〜6.4 / 6.13）

**月の集合は入力である。** 純粋層の `utcMonths` と同じく、どの月を見るかは呼ぶ側が決める。SQL 側に月軸を
持たせない（持たせると保持期間や観測範囲に依存した二つ目の定義が生まれる）。

### 3-1. 単月

```sql
SELECT * FROM TABLE(OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_SLO('2026-06'));
```

- [ ] 一行返ること。`POPULATION_COUNT`（母集団数）、`ARRIVED_WITHIN_FIFTEEN_MINUTES_COUNT`
      （15 分以内到達数）、`ARRIVAL_RATE`（率）、`ASSESSMENT`、`TARGET_RATE = 0.99`、`DISPLAY`、
      `TIMER_OPERATION_SUCCESS_GUARANTEED = FALSE` が揃うこと。
- [ ] 母集団が一件以上なら `ASSESSMENT` が `met`（率 99% 以上）または `missed` であること（要件 6.3）。
- [ ] `DISPLAY` に母集団数、15 分以内到達数、率または `not applicable`、および
      `this SLO does not guarantee Timer operation success.` が併記されること（要件 6.13）。

### 3-2. 母集団 0 件の月（要件 6.4）

```sql
SELECT * FROM TABLE(OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_SLO('1970-01'));
```

- [ ] 一行返り、`POPULATION_COUNT = 0`、`ARRIVAL_RATE IS NULL`、`ASSESSMENT = 'not-applicable'` である
      こと。**率を 0 で埋めていないこと。**
- [ ] `DISPLAY` の率が `not applicable` であること。

### 3-3. 複数月を並べる

月の集合は呼ぶ側が与える。例えば見たい月を列挙して横に展開する。

```sql
SELECT slo.*
  FROM (SELECT COLUMN1 AS UTC_MONTH FROM VALUES ('2026-04'), ('2026-05'), ('2026-06')) months,
       TABLE(OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_SLO(months.UTC_MONTH)) slo
  ORDER BY slo.UTC_MONTH;
```

- [ ] 与えた月がすべて一行ずつ現れること（観測が 0 件の月も判定対象外として現れること）。

---

## 4. 30／60 分通知を有効化する（要件 6.5 / 6.6）

### 4-1. 未到達と帯を確認する

```sql
SELECT STORE_ID, TIMER_ID, OPERATION_KIND, EVENT_TIME, FIRST_OBSERVED_AT
  FROM OPERATION_HISTORY.ANALYSIS.OPERATION_PENDING_ARRIVAL
  ORDER BY FIRST_OBSERVED_AT
  LIMIT 20;

SELECT PREVIOUS_BAND, NEXT_BAND, ELAPSED_MS, NOTIFICATION_KIND, NOTIFICATION
  FROM OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_LAG_TRANSITION;
```

- [ ] `OPERATION_ARRIVAL_LAG_TRANSITION` が常に一行返ること（未到達 0 件でも
      `NEXT_BAND = 'under-thirty-minutes'` の一行が返ること）。
- [ ] `NOTIFICATION` が出るときは `storeId` / `timerId` / `operationKind` / `eventTime` を含むこと
      （要件 6.5 / 6.6）。

`OPERATION_PENDING_ARRIVAL` が覆うのは **R2 まで到達したが Snowflake へ未取込の分だけ**である。Tail
Worker から Queue／Consumer の間に滞留している分は属性の出所が Snowflake から読めないため、この view には
現れない。その滞留は Consumer の再配送方針と dead-letter（Data Platform 側の設定正本）で扱う。観測でき
ない分を推定しない。

### 4-2. 通知先を設定する

integration を作る（宛先は運用判断ゆえリポジトリに持たない）。

```sql
CREATE NOTIFICATION INTEGRATION IF NOT EXISTS OPERATION_HISTORY_EMAIL
  TYPE = EMAIL
  ENABLED = TRUE
  ALLOWED_RECIPIENTS = ('<運用者の宛先>');

INSERT INTO OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_NOTIFICATION_TARGET
  (NOTIFICATION_INTEGRATION, RECIPIENTS)
VALUES ('OPERATION_HISTORY_EMAIL', '<運用者の宛先>');
```

- [ ] `OPERATION_ARRIVAL_NOTIFICATION_TARGET` が**一行だけ**であること（複数行は運用の誤り）。
- [ ] 宛先が Snowflake の verified email であること（未 verify の宛先へは送れない）。

### 4-3. procedure を一度手で実行する

alert を起動する前に、procedure が通ることを確かめる。

```sql
CALL OPERATION_HISTORY.ANALYSIS.SEND_ARRIVAL_LAG_NOTIFICATION();
```

- [ ] 戻り値が `warning` / `critical` / `band-recorded-without-notification` のいずれかであること。
- [ ] `notification-target-not-configured` が返る場合は 4-2 が未完了である。この場合 **帯は更新されない**
      （fail closed）。通知先を入れてから再実行すると同じ遷移が改めて通知される。
- [ ] 実行後 `OPERATION_ARRIVAL_NOTIFICATION_STATE.BAND` が現在の帯と一致すること。

### 4-4. alert を起動する

```sql
ALTER ALERT OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_LAG_ALERT RESUME;
```

- [ ] `SHOW ALERTS IN SCHEMA OPERATION_HISTORY.ANALYSIS;` で `state = started`、
      `schedule = 1 MINUTE` であること。**5 分より長い間隔にしないこと**（要件 6.5 / 6.6 の「遷移から
      5 分以内」が満たせなくなる）。

### 4-5. 一連続状態一回を確認する

```sql
SELECT NAME, SCHEDULED_TIME, STATE, ACTION_RETURN_VALUE
  FROM TABLE(INFORMATION_SCHEMA.ALERT_HISTORY(
    SCHEDULED_TIME_RANGE_START => DATEADD('HOUR', -3, CURRENT_TIMESTAMP())))
  WHERE NAME = 'OPERATION_ARRIVAL_LAG_ALERT'
  ORDER BY SCHEDULED_TIME DESC;
```

- [ ] 同じ帯が続く間、`warning` も `critical` も **一回だけ**現れること（要件 6.5 / 6.6）。帯が変わらない
      周期では alert の条件が満たされず、実行自体が起きないこと。
- [ ] 30 分帯へ入った遷移で `warning`、60 分以上へ入った遷移で `critical` が現れること。
- [ ] 帯が下がる遷移（60 分以上 → 30 分帯、未到達 0 件への復帰）では通知が出ず、
      `band-recorded-without-notification` として帯だけが記録されること。
- [ ] `OPERATION_ARRIVAL_LAG_TRANSITION.WITHIN_FIVE_MINUTE_WINDOW` が通知時に `TRUE` であること
      （遷移から 5 分以内）。

---

## 5. 費用の性質

`OPERATION_PENDING_ARRIVAL` は stage の全 object を読む。実行費用は stage 上の object 数に比例し、alert の
周期（1 分）ごとに発生する。path で刈って軽くすると最古の未到達 record を見失い、帯が誤って戻って同じ遷移
を二度通知するため、刈らない。

費用が問題になるときは object 数を減らす方向で扱う（R2 の保持は 90 日・タスク 13.5）。帯の判定条件や
未到達の定義を変えて軽くしない。定義の正本は `src/operation-history/slo.ts` である。

---

## 6. 停止と切戻し

```sql
ALTER ALERT OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_LAG_ALERT SUSPEND;
```

- [ ] 停止しても raw arrival、品質 view、表示 view が変わらないこと（要件 5.7）。
- [ ] Timer 本体の state migration も rollback も要らないこと。

完全に落とす場合は次の順で落とす（`STATE` を落とすと連続状態の記憶が消えるため、再開時に現在の帯が改めて
通知される）。

```sql
DROP ALERT IF EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_LAG_ALERT;
DROP PROCEDURE IF EXISTS OPERATION_HISTORY.ANALYSIS.SEND_ARRIVAL_LAG_NOTIFICATION();
DROP VIEW IF EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_LAG_TRANSITION;
DROP VIEW IF EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_PENDING_ARRIVAL;
DROP FUNCTION IF EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL_SLO(VARCHAR);
```

---

## 参照

- 要件: 6.1（初回観測時刻と初回 Snowflake 到達時刻の関連付け）、6.2〜6.4（UTC 暦月の到達 SLO と判定対象外）、
  6.5 / 6.6（30 分警告・60 分重大通知を各連続状態一回、遷移から 5 分以内）、6.13（SLO 表示の併記）
- 設計: `design.md` 節「SLO・保持・機密性」、節「Snowflake 到達 SLO と通知の確定結果（タスク13.4）」
- 定義の正本: `src/operation-history/slo.ts`
- 検査: `tests/operation-history/snowflake-slo.static.test.ts`、
  `tests/operation-history/slo.example.test.ts`、`tests/operation-history/slo.property.test.ts`
- 後続タスク: 13.5（保持）、13.6（access 制御）、13.7（integration テスト）、15.2（下流 smoke 手順）
