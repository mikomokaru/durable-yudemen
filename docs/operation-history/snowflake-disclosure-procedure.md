# best-effort 表示と完全未観測率を Snowflake へ配線する手順（operation-history-log）

> 対象 spec: `operation-history-log` / タスク 13.3「best-effort 分析表示と完全未観測率の表示を実装する」
> 種別: ［手続き］（Snowflake は外部サービスゆえリポジトリから適用できない。ユーザーが本手順に従い実行する）
> 正本: `requirements.md` 要件 5.8 / 5.14 / 5.15、`design.md` 節「相関・重複・品質」
> 適用する宣言的定義: [`config/operation-history-snowflake/`](../../config/operation-history-snowflake/README.md)
> 前段: [`snowflake-quality-procedure.md`](./snowflake-quality-procedure.md)（相関・品質層・タスク 13.2）

---

## 0. この文書の位置づけ

Snowflake 側 object の正本は `config/operation-history-snowflake/05-best-effort-disclosure.sql` にある。
本書はその適用と確認の手順だけを与える。SQL の内容を本書へ写して二重に持たない。

**定義の正本は純粋層である。** `src/operation-history/quality.ts` の `analysisDisclosure` と
`consoleLogCompleteMissingRate` が語と表示文を定める。SQL はそれを写すだけで、言い換えない。両者の一致は
`tests/operation-history/snowflake-disclosure.static.test.ts` が機械検査する。

この段が作るのは表示だけである。**生産能力指標そのもの（何を能力として数えるか）は requirements にも
design にも定義が無いため、ここで発明しない。** 指標を作る側が
`OPERATION_HISTORY.ANALYSIS.OPERATION_ANALYSIS_DISCLOSURE` を `STORE_ID` と `PERIOD` で join し、分析値に
表示を必ず伴わせる（要件 5.8）。

この段で作らないもの: 到達 SLO と 30／60 分通知（タスク 13.4）、R2 90 日と Snowflake 25 UTC 暦月の保持
（13.5）、access role（13.6）。品質率と信頼判定は 13.2 の `04` が正本であり、ここで作り直さない。

Timer 本体との関係は一方向のままである。本手順のどの操作も Producer と `StoreTimerDO` を呼ばない
（要件 4.13 / 4.14）。

---

## 1. 前提

- [ ] タスク 13.2 の手順を完了し、`OPERATION_HISTORY.ANALYSIS.OPERATION_TRUSTED_ANALYSIS_SCOPE` が
      引ける。
- [ ] `CREATE VIEW` を実行できる role を使える。

---

## 2. 宣言的定義を適用する

```sh
snow sql --filename config/operation-history-snowflake/05-best-effort-disclosure.sql
```

- [ ] view `OPERATION_CONSOLE_LOG_COMPLETE_MISSING_RATE` と `OPERATION_ANALYSIS_DISCLOSURE` ができたこと。

---

## 3. 結果を確認する

### 3-1. 分析値へ付ける表示（要件 5.8 / 5.15）

```sql
SELECT STORE_ID, PERIOD, BASIS, ESTIMATION, DISPLAY,
       TRUSTED_ANALYSIS_STATUS, EXCLUSIONS
  FROM OPERATION_HISTORY.ANALYSIS.OPERATION_ANALYSIS_DISCLOSURE
  ORDER BY PERIOD DESC, STORE_ID
  LIMIT 20;
```

- [ ] 対象 Store Id と対象期間が一行ごとに現れること。`PERIOD` は Operation Record 内 `eventTime` の
      UTC 暦日であり、13.2 と同じ定義であること（期間の定義を二つ作らない）。
- [ ] `BASIS = 'Observed telemetry'`、`ESTIMATION = 'best-effort'`、
      `DISPLAY = 'Best-effort estimate based on Observed telemetry'` であること。
- [ ] 除外された店舗・期間では `TRUSTED_ANALYSIS_STATUS = 'excluded'` と `EXCLUSIONS`（対象品質率と
      除外理由）が分析値の表示に同伴すること（要件 5.15）。

### 3-2. 完全未観測率の測定不能表示（要件 5.14）

```sql
SELECT * FROM OPERATION_HISTORY.ANALYSIS.OPERATION_CONSOLE_LOG_COMPLETE_MISSING_RATE;
```

- [ ] 一行だけで、`STATUS = 'unmeasurable'`、
      `REASON = 'producer-telemetry-total-unobservable'`、`DISTINCT_FROM = 'lifecycleMissingRate'`、
      `DISPLAY` が純粋層と同一の一文であること。
- [ ] **数値の列が無いこと。** 件数、分子、分母、率のいずれも持たないこと。Producer telemetry の総数は
      下流から観測できないため、数を置けば観測できなかった分を推定したことになる。
- [ ] `'not-calculable'`（分母 0 の算出不能・要件 5.13）と同じ語になっていないこと。測定不能と算出不能は
      別概念である。

### 3-3. lifecycle 内欠落率との分離（要件 5.14）

```sql
SELECT disclosure.STORE_ID, disclosure.PERIOD,
       rate.QUALITY_RATE, rate.STATUS, rate.VALUE,
       disclosure.CONSOLE_LOG_COMPLETE_MISSING_RATE_STATUS,
       disclosure.CONSOLE_LOG_COMPLETE_MISSING_RATE_DISPLAY
  FROM OPERATION_HISTORY.ANALYSIS.OPERATION_ANALYSIS_DISCLOSURE disclosure
  JOIN OPERATION_HISTORY.ANALYSIS.OPERATION_QUALITY_RATE rate
    ON rate.STORE_ID = disclosure.STORE_ID
   AND rate.PERIOD   = disclosure.PERIOD
  WHERE rate.QUALITY_RATE = 'lifecycleMissingRate'
  ORDER BY disclosure.PERIOD DESC
  LIMIT 20;
```

- [ ] lifecycle 内欠落率が算出できる率として値または算出不能を持ち、完全未観測率が
      `unmeasurable` として別の列に現れること。二つが同じ列にも同じ語にも寄っていないこと。
- [ ] 表示・報告の場でも二つを並べて示し、片方を他方の代用として語らないこと。

---

## 4. 生産能力指標を足すときの規律

指標を定義するのは本タスクの責務ではない。将来足すときは次を守る。

- `OPERATION_ANALYSIS_DISCLOSURE` を `STORE_ID` と `PERIOD` で join し、分析値と表示を分離できない形で
  出す（要件 5.8）。
- 母集団は `TRUSTED_ANALYSIS_STATUS = 'included'` の店舗・期間に限る。除外された期間の値を出すなら
  `EXCLUSIONS` を必ず添える（要件 5.15）。
- 完全未観測率を数値で埋めない。観測できなかった telemetry の総数を推定しない（`design.md` の不変点）。
- 期間の定義を増やさない。暦月が必要なら `PERIOD` を上位で丸める。

---

## 5. 停止と切戻し

view は既存 view を読むだけゆえ、停止は view を落とすだけで足りる（raw arrival と品質 view は残る）。

```sql
DROP VIEW IF EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_ANALYSIS_DISCLOSURE;
DROP VIEW IF EXISTS OPERATION_HISTORY.ANALYSIS.OPERATION_CONSOLE_LOG_COMPLETE_MISSING_RATE;
```

- [ ] `OPERATION_HISTORY.RAW.OPERATION_RAW_ARRIVAL` の行数が変わらないこと（要件 5.7）。
- [ ] Timer 本体の state migration も rollback も要らないこと。

---

## 参照

- 要件: 5.8（Store Id・期間・Observed telemetry に基づく best-effort 推定の表示）、
  5.14（完全未観測率の測定不能表示と lifecycle 内欠落率との分離）、5.15（除外の表示）
- 設計: `design.md` 節「相関・重複・品質」、節「Snowflake best-effort 表示の確定結果（タスク13.3）」
- 定義の正本: `src/operation-history/quality.ts`
- 検査: `tests/operation-history/snowflake-disclosure.static.test.ts`、
  `tests/operation-history/quality.example.test.ts`、
  `tests/operation-history/unobserved-telemetry.integration.test.ts`
- 後続タスク: 13.4（SLO と通知）、13.5（保持）、13.6（access 制御）、13.7（integration テスト）
