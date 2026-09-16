# CP-SAT 由来の採用は起きていない（2026-09-13）— **数えられないので、証明した**

## 0. 先に結論

1. **`cpsat.plan-decided` は本番で一度も出ない。** 型としては `src/cpsat/observation.ts` に在り、
   集計器（`src/observe/cpsat.ts`）も読める。だが**構築する場所が src にも experiments にも無い**。
   `StoreTimerDO.deliverPlan` は観測を一切持たない。**adopted / rejected は数えられない。**
2. 数えられないので、**採用が起こり得ないことを機械で押さえた**（`tests/cpsat-target-coverage.example.test.ts`・
   4 件通過）。条件は「卓が 1 つ・計画対象が 7 件以上」で、これが本番で成立していることを実測した。
3. 実測（直近 1 時間・189 店舗・3,671 求解）で、**pending > 6 の求解が 3,653 件＝99.5%**。
   185 店舗は全求解が該当。実 POS データ 2 系統 2,219 行の `table_no` は**すべて `1`**。
4. ゆえに **73（現在 189）店舗は CP-SAT の費用を払って、画面には engine の合成解を見ている**
   可能性が極めて高い。安全側ではある（提案は engine の自前解）が、有効化記録・費用の承認・
   7-C の設計の前提が変わる。

**まだ「採用 0 件」を数えた記録ではない。** 数えるには `deliverPlan` に観測を足して配備する
必要があり、それは別の承認である（§5）。

## 1. なぜ数えられないか

```
$ grep -rn '"cpsat.plan-decided"' src/
src/observe/cpsat.ts:170,206,269,275     ← 読む側（集計）
src/cpsat/observation.ts:93,381          ← 型と検証
$ grep -rn 'cpsat.plan-decided' experiments/cpsat-workers/transport/*.ts
（出力なし）
```

構築する側が存在しない。`StoreTimerDO.deliverPlan`（`src/shell/store-timer-do.ts`）は
`toCookSchedule` → `decide` → `runEffects` だけで、`console.log` も観測も持たない。

**有効化記録の「端から端」の根拠は「画面に推奨が出ている」だった。これは CP-SAT 由来を示さない
——合成でも推奨は出る。** 7.5 が求めていた「要求→求解→採用→表示の対応で CP-SAT 由来を確認」は
行われていない。

## 2. 本番で何は分かるか（実測）

本番の計画 Worker が出す行は `cpsat-queue-received` / `cpsat-plan-computed` / `cpsat-plan-failed` の
3 つである。Workers Logs から読んだ（読み取りのみ。配備も設定変更もしていない）。

```
set -a; . experiments/cpsat-workers/fixtures/local/observability.env; set +a
node experiments/cpsat-workers/quality/collect-plan-decisions.mjs OUT.json 60
```

| | |
|---|---|
| 窓 | 2026-09-13T01:44:00Z 〜 02:44:00Z（60 分） |
| Worker | `yude-men-cpsat-planner-dev`（版 `a910005c-1e3a-4b44-9853-633ad1eae763`） |
| 読み切り | 3 分刻み 20 区間すべて非飽和（`saturatedSlices: 0`）。取りこぼしの区間なし |
| 求解 | **3,671 件 / 189 店舗**（`cpsat-queue-received` 3,673 との差 2 は窓の端） |
| 結末 | `FEASIBLE` 3,213 ／ `OPTIMAL` 458 ／ **`cpsat-plan-failed` 0** |
| `placements` | 全 189 店舗で 6 が現れる（上限に張り付いている） |
| `running` | 最大 6。**running > 0 の店舗は 9 / 189** |
| 記録 | `cpsat-adoption-20260913.json` |

### 計画対象の件数（採用可否を決める値）

| | 全体 |
|---|---|
| `pending` min / p50 / max | 1 / **64** / 64 |
| `pending > 6` の求解 | **3,653 / 3,671（99.5%）** |
| 全求解が `pending > 6` の店舗 | **185 / 189** |
| 混在の店舗 | 4 |
| 全求解が `pending ≤ 6` の店舗 | **0** |

上位 12 店舗（求解数順）。

| 店舗 | 求解 | pending min/p50/max | pending>6 | running max |
|---|---:|---:|---:|---:|
| yamaokaya-1335 | 36 | 44/53/64 | 36 | 0 |
| yamaokaya-1151 | 36 | 34/49/64 | 36 | 0 |
| yamaokaya-1327 | 36 | 31/46/60 | 36 | 0 |
| yamaokaya-1263 | 35 | 39/49/60 | 35 | 0 |
| yamaokaya-1152 | 35 | 36/45/64 | 35 | 0 |
| yamaokaya-1144 | 34 | 20/43/61 | 34 | 1 |
| yamaokaya-1334 | 33 | 40/51/63 | 33 | 0 |
| yamaokaya-1205 | 32 | 49/56/61 | 32 | 0 |
| yamaokaya-1153 | 31 | 16/43/64 | 31 | 0 |
| yamaokaya-1330 | 31 | 53/56/64 | 31 | 0 |
| yamaokaya-1328 | 31 | 64/64/64 | 31 | 0 |
| yamaokaya-1222 | 30 | 64/64/64 | 30 | 0 |

**189 店舗である（73 ではない）。** 有効化記録の店舗数は古い。

## 3. 卓の分布——**卓は分かれていない**

`cpsat-plan-computed` は卓の構造を持たないので、本番のログからは出せない。実 POS データで見る。

| 出所 | 行数 | `table_no` の分布 |
|---|---:|---|
| `noodle_plan_histories`（10 店舗・2026-09-05〜08） | 1,919 | **すべて `1`** |
| `kenbaiki_orders`（旧 native pilot の補助資料） | 300 | **すべて `1`** |

独立した 2 回の抽出、2,219 行、例外なし。`toTableId` は `"1"` を卓 id として通す（`0`・欠落だけを
`null` にする）ので、**1 店舗の待ち行列は 1 つの Table_Group に畳まれる**。

**これは「卓が 1 つ」の証明ではなく「POS が卓を申告していない」の観測である。** ただし計画に効くのは
POS が申告する値だけなので、結論は同じである（R2.6 の「不明」）。

## 4. 採用が起こり得ないことの機械的な確認

`tests/cpsat-target-coverage.example.test.ts`（4 件通過）。

| 主張 | 結果 |
|---|---|
| 卓 1 つ・対象 7 件で、**engine 自身の最良の 6 件計画**を外部計画として持ち込むと `isStale` が真 | 通過 |
| 同じ計画が、対象ちょうど 6 件の局面では `isStale` が偽 | 通過 |
| 7 件の局面で `admit` が接頭辞を 1 つも採らない | 通過 |
| 本番の規模（64 件）でも同じ | 通過 |

作り物の悪い計画ではなく **engine 自身の解**を持ち込んでいるので、落ちる理由は被覆だけに絞られる。
根拠は `isStale`（`src/engine/schedule.ts:1095`）の 1 行である。

```ts
const group = targets.filter((order) => tableKeyOf(order) === slice.tableKey);
if (group.length !== slice.placements.length) return true;   // 陳腐化
```

**完全被覆は engine の欠陥ではない。** 同一卓の配置は互いの開始時刻を前提に提供時刻を揃えるので、
一部だけ採ればその一片が主張していた同時提供が成り立たない。plan-stability の不変条件であり、
CP-SAT のために崩せば TS 側の保証も動く。噛み合っていないのは `cpsatTargets` の切り方である。

## 5. 採用を実際に数えるには（未実施・承認が要る）

`StoreTimerDO.deliverPlan` に `cpsat.plan-decided` を出させる。これは**本番の配備**であり、
1〜6 のクラウド変更の承認とは別に諮る。

- 出す値：`outcome`（adopted / rejected）・`storeId`・`inputKey`・採用した一片数・
  拒否なら段（段 1 の被覆 / 段 1 の feasibility / 段 2 の非改善）。
- **段を分けることが要点である。** 被覆で落ちたのか改善しなかったのかで、次の手がまるで違う。
- 併せて `cpsat-plan-computed` に `slices`（卓の数）を足すと、卓の分布が本番のログだけで分かる。

## 6. この記録が言わないこと

- **「採用 0 件」を数えた記録ではない。** §4 は「起こり得ない」を示し、§2・§3 はその条件が
  成立していることを示す。両者を合わせた推論であって、計数ではない。
- 4 店舗は `pending ≤ 6` の求解を含む。そこでは採用が起こり得る（起きたとは言っていない）。
- `running > 0` の局面は 9 / 189 店舗にしかない。**釜が走っている局面は本番でもほぼ無い**
  ——誰も操作していない dev 環境だからである。7-C の設計はこれを前提にできない。
