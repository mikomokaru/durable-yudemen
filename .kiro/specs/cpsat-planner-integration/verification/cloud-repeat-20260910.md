# 連続求解（難問 20 件・逐次）— クラウド実測

対象: `yude-men-cpsat-planner-dev`（版 `99aa3f53-8b28-4d4a-a03c-7b87c325948a`）
経路: driver → remote binding → `CpsatTransportProbe` → solver → 実 `StoreTimerDO`
問題: hard（500 変数 / 22,495 制約 / model 604,697 B / 予算 0.14 決定時間）
証拠: `cloud-repeat-20260910.json`（間隔なし）, `cloud-repeat2-20260910.json`（間隔 3s）,
`cloud-repeat2-join-20260910.json`, `cloud-repeat2-metrics-20260910.json`

## 1. 間隔なしの連続送信は 2 件目で 429

| 送信 | 結果 |
|---|---|
| 1 | 202 |
| 2 | 429（drive 側で停止） |

これは想定どおりの拒否である。solver は 1 isolate につき 1 求解までを
`busy` で守っており、前の求解が `waitUntil` の中にいる間の新規は受け付けない。
**受理と求解は分離している**（`solver.ts:384-385` — `ctx.waitUntil(deliver(...))`
の後に 202 を返す）。当初「受理が求解を待っている」と述べたのは誤りだった。

## 2. 間隔 3 秒での 20 件は全件受理・全件求解

- 受理: 20/20 が 202。429 なし。invocation の `outcome` は全件 `ok`。
- 求解: 20/20 に `solve-started` と `solve-finished:UNKNOWN` の行がある。
  `UNKNOWN` は決定時間の打ち切りで、この予算では想定どおり。
- callback: **19/20** に `callback-returned:delivered`。残る 1 件は下記 4 のとおり未観測。

## 3. 決定性

20 件すべての `consumed-deterministic` が **完全に同一**:

```
0.140242550894   (budget 0.14)
```

model-bytes・variables・constraints・wasm-bytes も 20 件で単一値。
同じ入力に同じ計算量が返ることが、別々の isolate をまたいで確認できた。

## 4. isolate の再利用と成長の有無

20 件を 9 個の isolate が処理した。連続列は最長 3 件。
`282bd663` は 4,5 件目 → 他の isolate を挟んで 10,12 件目にも現れており、
**再初期化ではなく再利用**が起きている。

CPU（送信順）: 3101, 1437, 902, 888, 1328, 883, 1750, 1590, 1499, 871, —,
3145, 673, 895, 694, 818, 1382, 638, 709, 2981 ms

同一 isolate の連続列で単調増加する箇所はない。**memory growth は測れていない**:
`isolate-bytes` は 20 件すべて `unavailable` で、Workers の実行環境がこの値を
返さない。間接的な証拠は `wasm-bytes` が 33,554,432 B 固定であることだけで、
これは線形メモリの確保量であって使用量の推移ではない。

## 5. 余裕

| 項目 | min | p50 | max | 上限 |
|---|---|---|---|---|
| invocation CPU (ms) | 638 | 902 | 3,145 | 10,000 |
| invocation wall (ms) | 701 | 977 | 4,384 | — |
| solve→callback (ms) | 42 | 164 | 3,522 | — |

最悪でも CPU 上限に対して 68% の余裕がある。max の 3,145ms / 4,384ms /
3,522ms はいずれも冷起動（1 件目と 12 件目・20 件目＝新規 isolate）で、
WASM の用意を含む。

## 6. この計測でわかっていないこと

1. **受理単体の所要時間は測れていない。** driver の待ち時間は invocation 全体
   （`waitUntil` を含む）より 21〜429ms 大きいだけで、202 が返った時点では
   解決しない。remote binding 経由の呼び出しが invocation の完了まで戻らない
   ためで、`wait-until-wall-ms`・`invocation-wall-ms` も `unavailable` のため
   内側からも分離できない。受理単体を測るには公開 URL からの HTTP が要る。
2. **11 件目（index 10）の callback は未観測。** solve-finished までの 10 行は
   あるが、それ以降の 6 つの計測行・`callback-returned`・invocation 集計行が
   まとめて欠けている。末尾がそろって欠ける形なのでログ側の欠落と考えられるが、
   届いたことの証拠にはならない。`yude-men-timer` 側の照合は実 POS の流入で
   1,000 件の上限に当たり走査しきれず、不在の証拠にもならない。
3. `cpu-ms`・`isolate-bytes` は `unavailable`。表の CPU は Workers の invocation
   集計から取っており、solver 自身の計測ではない。

## 7. 窓

manifest の窓は 2026-09-10T14:40:52Z に閉じる。以降は無効化 manifest での
再配備、または記録済みの停止版に戻す。
