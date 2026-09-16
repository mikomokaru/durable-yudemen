# 求解中の独立操作 — クラウド実測（2.3・2.1の閾値照合）

対象店舗: manifest の direct/hard（合成店舗、実 POS の流入なし）
経路: 求解 = driver → `CpsatTransportProbe` → solver → WASM → 実 DO callback、
操作 = driver → `CpsatTransportOperations` `/ops/orders?store=…` → **同じ店舗の実 DO**
実行: `run-cloud-concurrency.mjs`（各 4 ラウンド、間隔 3s、2 回）
証拠: `cloud-concurrency-20260910.json`（完了のみ）,
`cloud-concurrency-timeline-20260910.json`（時計の検査）,
`cloud-concurrency2-20260910.json`・`cloud-concurrency2-join-20260910.json`（通知込み）

## 手順

各ラウンドで `/plan` を **await せずに** 送る。remote binding 越しの呼出は
invocation 全体（`waitUntil` を含む）が終わるまで戻らないので、戻り待ちにすると
求解中に別の要求を出せない。送出の 200ms 後に同じ店舗へ注文を 1 件入れ、
注文が戻った時刻と求解の fetch が解決した時刻を比べる。

## 結果（1 回目・完了のみ）

| ラウンド | 注文送出 | 注文完了 | 求解 fetch 解決 | 注文 | solver CPU |
|---|---|---|---|---|---|
| 0 | +203ms | +1,466ms | +1,637ms | 200 | 864ms |
| 1 | +202ms | +408ms | +870ms | 200 | 721ms |
| 2 | +202ms | +395ms | +929ms | 200 | 867ms |
| 3 | +201ms | +405ms | +2,507ms | 200 | 2,198ms |

- 注文 4/4 が `200 {"accepted":true}`。**同じ店舗の DO は、その店舗の求解が
  進行中に独立した注文を受理して返した。**
- 求解 4/4 が `solve-finished:UNKNOWN` → `callback-returned:delivered`。
  `consumed-deterministic` は 4 件とも `0.140242550894` で連続実行時と同一。
- solver CPU は 4 件とも 250ms を大きく超える（721〜2,198ms）。2.1 の
  「CPU 250ms 以上の求解を少なくとも 4 件含む」を満たす。

## 結果（2 回目・通知込み）

購読専用 WS `/ops/watch` を 1 本張り、接続時の `config`・`snapshot` を捨ててから
同じ 4 ラウンドを回した。

| ラウンド | 注文完了 | broadcast | 求解 fetch 解決 | solver CPU |
|---|---|---|---|---|
| 0 | +391ms | `snapshot` | +1,563ms | 1,426ms |
| 1 | +421ms | `snapshot` | +1,352ms | 1,255ms |
| 2 | +423ms | `snapshot` | +3,316ms | 2,779ms |
| 3 | +369ms | `snapshot` | +1,573ms | 1,400ms |

- 注文 4/4 が `200`、**broadcast も 4/4** が届き、いずれも求解の invocation が
  解決する前である。`afterOrderMs` が −9〜+26ms の幅にあるのは、DO が遷移の
  内側で broadcast してから HTTP を返すためで、通知が注文の完了と同時に近い。
- 求解 4/4 が `callback-returned:delivered`、CPU 1,255〜2,779ms（いずれも
  2.1 の 250ms 条件を満たす）、`consumed-deterministic` は全件 `0.140242550894`。
- WS は購読専用で、driver からの送信は `4003 subscription only` で切られる契約
  （2.2 でローカル検証済み）。今回は送信していない。

これで 2.1 の「同じ店舗の独立した既存操作が求解中に**完了・通知**される」の
うち、**完了と通知の両方**が観測できた。

## 満たせていない点

**1. 求解の時刻を solver 自身の時計で特定できない。**
`solve-started` と `solve-finished` の `at` が 4 件とも同一（差 0ms）である。
Workers の時計は同期実行中に進まず、WASM 求解は 1 回の同期呼出なので、
求解区間が時計上は幅を持たない。2.1 は「時計の分解能・跨る invocation の
対応が不十分なら欠測扱い」と定めており、この条件に当たる。
実時間が経過したことはプラットフォームの invocation 集計（wall 751〜2,438ms /
CPU 721〜2,198ms）が示すが、これは区間の位置ではなく総量である。

したがって言えるのは「**求解の invocation が開いている間に注文が完了した**」
までで、「**WASM が回っている最中に完了した**」ではない。求解開始前や
求解終了後・callback 前に処理された可能性は、この計測では排除できていない。

**2. cloud のドライバは永続台帳を通っていない。**
`run-cloud-trial.mjs`・`run-cloud-repeat.mjs`・本ドライバのいずれも
2.2 で作った `ledger.mjs` を呼んでいない。送出 128／操作 512 の上限は
ジャーナルで数えられておらず、実際に効いているのは solver 側の
isolate ごとの `maxDispatches` と `busy` だけである。台帳は 2.2 の
ローカル検証では動いているが、cloud 実行分は記録されていない。

## 2.1 閾値との対照（現時点）

| 閾値 | 判定 |
|---|---|
| waitUntil 消費の上界 ≤ 20,000ms / 余裕 ≥ 10,000ms | ✅（上界 4,384ms・余裕下界 25,616ms） |
| CPU が正常例で 8,000ms 未満 | ✅（max 3,145ms） |
| WASM 線形メモリ ≤ 96MiB | ✅（32MiB 固定） |
| isolate 全体メモリ | 数値は取得不能。終端は全件 `outcome: ok`、資源エラーなし |
| 同店舗の独立操作が求解の invocation 中に完了・通知（CPU 250ms 以上 ×4 件） | ✅ 8 ラウンド全件 |
| 受理が求解完了より先に戻る（求解区間の位置の特定） | ❌ 上記 1 により欠測 |
