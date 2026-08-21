# 相関・重複収束・品質率を Snowflake へ配線する手順（operation-history-log）

> 対象 spec: `operation-history-log` / タスク 13.2「相関、重複収束、欠落／孤児／競合／重複、品質率を Snowflake へ配線する」
> 種別: ［手続き］（Snowflake は外部サービスゆえリポジトリから適用できない。ユーザーが本手順に従い実行する）
> 正本: `requirements.md` 要件 5.1〜5.7 / 5.9〜5.13 / 5.15、`design.md` 節「相関・重複・品質」
> 適用する宣言的定義: [`config/operation-history-snowflake/`](../../config/operation-history-snowflake/README.md)
> 前段: [`snowflake-ingest-procedure.md`](./snowflake-ingest-procedure.md)（raw arrival 層・タスク 13.1）

---

## 0. この文書の位置づけ

Snowflake 側 object の正本は `config/operation-history-snowflake/03-correlation-and-convergence.sql` と
`04-quality-rates-and-trusted-analysis.sql` にある。本書はその適用と確認の手順だけを与える。SQL の内容を
本書へ写して二重に持たない。

**定義の正本は純粋層である。** 相関と収束は `src/operation-history/correlation.ts`、品質率と信頼判定は
`src/operation-history/quality.ts` が定める。SQL はその定義を写すだけで、読み替えて別定義を作らない。
両者の一致は `tests/operation-history/snowflake-quality.static.test.ts` が機械検査する（率の名前、集計の
名前、状態の語、分子・分母の対応、一次相関 key の四属性、収束 key の Timer 事実、分母 0 の扱い）。

この段で作らないもの: best-effort 表示と完全未観測率（タスク 13.3）、到達 SLO と 30／60 分通知（13.4）、
R2 90 日と Snowflake 25 UTC 暦月の保持（13.5）、access role（13.6）。判定の根拠となる raw arrival は
判定の前後で削除しない（要件 5.7）。

Timer 本体との関係は一方向のままである。本手順のどの操作も Producer と `StoreTimerDO` を呼ばない
（要件 4.13 / 4.14）。

---

## 1. 前提

- [ ] タスク 13.1 の手順を完了し、`OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL` に raw arrival が入っている。
- [ ] `CREATE SCHEMA` / `CREATE VIEW` / `CREATE TABLE` を実行できる role を使える。
- [ ] 四つの Data_Quality_Threshold（`lifecycleMissingRate` / `duplicateRate` / `orphanRate` /
      `conflictRate`）の値を分析運用者が事前に決めている。値は運用判断ゆえリポジトリに置かない。

---

## 2. 宣言的定義を適用する

```sh
snow sql --filename config/operation-history-snowflake/03-correlation-and-convergence.sql
snow sql --filename config/operation-history-snowflake/04-quality-rates-and-trusted-analysis.sql
```

- [ ] `03` が schema `ANALYSIS` と view `OPERATION_ARRIVAL` / `OPERATION_CONVERGED_RECORD` /
      `OPERATION_CORRELATION_CANDIDATE` / `OPERATION_EXPECTED_LIFECYCLE_RECORD` を作ったこと。
- [ ] `04` が table `OPERATION_QUALITY_THRESHOLD` と view `OPERATION_QUALITY_COUNT` /
      `OPERATION_QUALITY_RATE` / `OPERATION_TRUSTED_ANALYSIS_SCOPE` を作ったこと。

---

## 3. 閾値を設定する

四行が揃うまで、その品質率は `threshold-not-configured` として信頼済み分析から除外される。閾値の無い率で
信頼を主張しないための構成上の guard であり、五つ目の品質状態ではない。

```sql
-- 値は分析運用者の判断。ここに挙げた数値は例であって既定値ではない。
MERGE INTO OPERATION_HISTORY.ANALYSIS.OPERATION_QUALITY_THRESHOLD AS target
USING (
  SELECT 'lifecycleMissingRate' AS QUALITY_RATE, 0.05 AS THRESHOLD
  UNION ALL SELECT 'duplicateRate', 0.05
  UNION ALL SELECT 'orphanRate', 0.05
  UNION ALL SELECT 'conflictRate', 0.01
) AS source
ON target.QUALITY_RATE = source.QUALITY_RATE
WHEN MATCHED THEN UPDATE SET target.THRESHOLD = source.THRESHOLD
WHEN NOT MATCHED THEN INSERT (QUALITY_RATE, THRESHOLD) VALUES (source.QUALITY_RATE, source.THRESHOLD);
```

- [ ] 四行が入り、`QUALITY_RATE` が `quality.ts` の名前（camelCase）と一致すること。
- [ ] 率が閾値を**超えた**ときだけ除外されること（閾値ちょうどは除外しない）を運用者と確認したこと。

---

## 4. 結果を確認する

### 4-1. 一次相関候補と Timer 事実整合（要件 5.1 / 5.2 / 5.6）

```sql
SELECT STORE_ID, TIMER_ID, OPERATION_KIND, EVENT_TIME, ARRIVAL_COUNT,
       TIMER_FACTS_CONSISTENT, AMBIGUITY_CANONICAL_HASHES
  FROM OPERATION_HISTORY.ANALYSIS.OPERATION_CORRELATION_CANDIDATE
  ORDER BY EVENT_TIME DESC
  LIMIT 20;
```

- [ ] 候補の key が Store_Id、Timer_Id、Operation_Kind、Event_Time の四つだけであること。
- [ ] 両立しない既知属性値を持つ候補が `TIMER_FACTS_CONSISTENT = FALSE` として残り、整合済みへ吸収されて
      いないこと。
- [ ] 補助情報（`AMBIGUITY_CANONICAL_HASHES` / `AMBIGUITY_ARRIVAL_OBJECT_KEYS`）が整合しない候補にだけ現れ、
      identity や連番として使われていないこと（要件 5.3 / 5.4）。

### 4-2. 重複収束と四つの品質状態（要件 5.5 / 5.6 / 5.7）

```sql
SELECT STORE_ID, TIMER_ID, OPERATION_KIND, EVENT_TIME,
       ARRIVAL_COUNT, DUPLICATE_COUNT, IS_ORPHAN, ARRIVAL_OBJECT_KEYS
  FROM OPERATION_HISTORY.ANALYSIS.OPERATION_CONVERGED_RECORD
  WHERE DUPLICATE_COUNT > 0 OR IS_ORPHAN
  LIMIT 20;

SELECT STORE_ID, TIMER_ID, EVENT_TIME, IS_MISSING
  FROM OPERATION_HISTORY.ANALYSIS.OPERATION_EXPECTED_LIFECYCLE_RECORD
  WHERE IS_MISSING
  LIMIT 20;
```

- [ ] 同一と判定できる到達が `n` 件のとき、分析用 record が 1 件、`ARRIVAL_COUNT = n`、
      `DUPLICATE_COUNT = n - 1` であること。
- [ ] 欠落（`IS_MISSING`）、孤児（`IS_ORPHAN`）、競合（`TIMER_FACTS_CONSISTENT = FALSE`）、重複
      （`DUPLICATE_COUNT > 0`）が互いに独立の状態として残ること。
- [ ] 確認の前後で `OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL` の行数が変わらないこと（根拠 record を
      削除しない）。

期待 lifecycle 記録の復元は「観測できた boil-started 一件から boiled 一件（`EVENT_TIME` = `END_TIME`）の
存在を導く」だけである。completed / cancelled は running からも到達し得るため、その存在から他の記録を
復元しない。同じ規則の既存の表明は
`tests/operation-history/unobserved-telemetry.integration.test.ts` の `recoverableLifecycleRecords`。

### 4-3. 四品質率と算出不能（要件 5.9〜5.13）

```sql
SELECT STORE_ID, PERIOD, QUALITY_RATE, NUMERATOR, DENOMINATOR, STATUS, VALUE,
       NOT_CALCULABLE_REASON, THRESHOLD, EXCLUSION_REASON
  FROM OPERATION_HISTORY.ANALYSIS.OPERATION_QUALITY_RATE
  ORDER BY PERIOD DESC, STORE_ID, RATE_ORDER
  LIMIT 40;
```

- [ ] 店舗・期間ごとに四行（`RATE_ORDER` 1〜4）が並ぶこと。
- [ ] 分母 0 の率が `STATUS = 'not-calculable'`、`VALUE IS NULL`、
      `NOT_CALCULABLE_REASON = 'denominator-is-zero'` であること。**`VALUE` が 0 になっていないこと。**
- [ ] `PERIOD` が Operation Record 内の `eventTime`（期待記録は復元された Event_Time）の UTC 暦日である
      こと。観測側時刻を期間の根拠にしないこと（要件 5.4）。

### 4-4. 信頼済み分析からの除外（要件 5.15）

```sql
SELECT STORE_ID, PERIOD, TRUSTED_ANALYSIS_STATUS, EXCLUSIONS
  FROM OPERATION_HISTORY.ANALYSIS.OPERATION_TRUSTED_ANALYSIS_SCOPE
  WHERE TRUSTED_ANALYSIS_STATUS = 'excluded'
  ORDER BY PERIOD DESC
  LIMIT 20;
```

- [ ] 閾値超過（`threshold-exceeded`）または算出不能（`rate-not-calculable`）の店舗・期間が `excluded`
      であること。
- [ ] `EXCLUSIONS` に対象品質率と除外理由、閾値、分子、分母が並ぶこと。
- [ ] 全ての率が算出可能かつ閾値以下の店舗・期間だけが `included` であること。
- [ ] 分析 query が `included` の店舗・期間だけを使う運用になっていること（best-effort 表示の付与は
      タスク 13.3）。

---

## 5. 期間（period）の粒度について

`PERIOD` は Operation Record 内の `eventTime` の UTC 暦日（`YYYY-MM-DD`）である。

- 期間の根拠を Operation Record の中に置く。観測側時刻（`FIRST_OBSERVED_AT` / `SNOWFLAKE_ARRIVED_AT`）は
  補助情報ゆえ使わない（要件 5.4）。
- 欠落と孤児の**判定自体**は店舗×timer 単位で観測全体に対して行い、期間は集計の割り当てにしか使わない。
  日境界を跨ぐ lifecycle（前日の boil-started と翌日の boiled）を人工的に孤児にしないためである。
- 期待 lifecycle 記録は自身の Event_Time（= `endTime`）の日に属する。ゆえに到達側と期待側で期間集合が
  食い違う日があり、`OPERATION_QUALITY_COUNT` は両者の合併を範囲にする。
- 暦月の集計が必要な場合は本 view を上位で丸める。**期間の定義を二つ作らない。**

---

## 6. 停止と切戻し

view は raw を読むだけゆえ、停止は view を落とすだけで足りる（raw arrival は残る）。

```sql
DROP VIEW IF EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_TRUSTED_ANALYSIS_SCOPE;
DROP VIEW IF EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_QUALITY_RATE;
DROP VIEW IF EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_QUALITY_COUNT;
DROP VIEW IF EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_EXPECTED_LIFECYCLE_RECORD;
DROP VIEW IF EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_CORRELATION_CANDIDATE;
DROP VIEW IF EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_CONVERGED_RECORD;
DROP VIEW IF EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_ARRIVAL;
```

- [ ] `OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL` の行数が変わらないこと（要件 5.7）。
- [ ] Timer 本体の state migration も rollback も要らないこと。

---

## 参照

- 要件: 5.1 / 5.2（一次相関候補と Timer 事実整合）、5.3 / 5.4（補助 metadata）、5.5（重複収束）、
  5.6（欠落・孤児・競合の区別）、5.7（根拠 record を削除しない）、5.9〜5.12（四品質率の分子・分母）、
  5.13（分母 0 の算出不能）、5.15（閾値超過・算出不能の除外表示）
- 設計: `design.md` 節「相関・重複・品質」、節「6. Snowpipe と Snowflake」、節「Snowflake 品質配線の確定結果（タスク13.2）」
- 定義の正本: `src/operation-history/correlation.ts`、`src/operation-history/quality.ts`
- 検査: `tests/operation-history/snowflake-quality.static.test.ts`
- 後続タスク: 13.3（best-effort 表示・完全未観測率 →
  [`snowflake-disclosure-procedure.md`](./snowflake-disclosure-procedure.md)）、13.4（SLO と通知）、
  13.5（保持）、13.6（access 制御）、13.7（integration テスト）
