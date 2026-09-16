# Queue 方式のローカル検証 — 2.3・2.4 の項目別照合

証拠 `queue-local-20260912.json`（測定）、`queue-app-local-20260912.json`（実チェーン）。
harness は `check-queue-local.mjs`・`check-app-local.mjs`。

**この資料は cloud の証拠ではない。** `cloudEvidence: false` を両 JSON に付けてある。

## 実チェーン（要求元が店舗 DO）

`check-app-local.mjs` を Queue 経路で再実行し、**15 check すべて緑・78 観測・53 要求**。
実 `StoreTimerDO` の Persist Effect が shim を経て Queue に載り、consumer の実 WASM が
解き、実 `deliverPlan` まで戻る。要求元が店舗 DO である経路の証拠はこちらにある
（`queue-local` の要求元は合成 DO である）。

consumer 設定はローカルと配備設定を揃えた（`max_batch_size: 1`・`max_batch_timeout: 0`・
`max_concurrency: 1`・DLQ）。揃える前はローカルだけ既定で、通った条件が違っていた。

## 2.3 の項目

| 項目 | ローカルで示せたこと | cloud 待ち |
|---|---|---|
| 要求元が求解完了待ちにならない | **示せた。** 同一 harness・同一問題で交互に 10 回。service binding 経由 252〜442ms（p50 254）に対し、**Queue 経由 0〜2ms（p50 0）**。構造の主張であり、スレッド配置に依存しない | 絶対値は代表値ではない。実配送の `send()` 往復を含まない |
| 求解中も注文・Timer 操作が処理できる | **示せない。** Miniflare は全 Worker を 1 プロセスで動かすため、Queue にしてもスレッドを共有する | **cloud で測る。** 判定の根拠は連鎖の外の DO が自店舗の求解中も 39〜52ms で応答した実測（F6） |
| 要求元は店舗 DO | 実チェーンで通した（上記） | 同上 |
| callback を DO の処理を含む戻りまで追跡 | **示せた。** 20 件すべて `callback-returned` に到達。`allQueuedDelivered: true` | — |
| 別の起動契機を使った事実だけで分離成立としない | 守っている。判定に使っているのは handler の戻り時刻であって、Queue を使った事実ではない | — |
| 合格条件「遅い回が混じらない」 | 10 回で最大 2ms。外れ値なし | 回数を増やすのは cloud 側 |

## 2.4 の項目

| 項目 | 結果 |
|---|---|
| 求解開始→callback 完了 | 233〜240ms（10 件） |
| `consumed-deterministic` | 10 件すべて `0.140242550894` で同一 |
| `wasm-bytes` | 全件同一 |
| `wait-until-wall-ms` | **`not-applicable`**（`unavailable` ではない）。Queue 経路では応答後の延長が存在しないので、欠測ではなく非該当である。輸送によって理由が変わるよう `deliver` へ引数を足した |
| `cpu-ms`・`invocation-wall-ms`・`isolate-bytes` | `unavailable`（ローカルでは取得できない） |
| consumer の CPU／wall の分母 | cloud 待ち。ローカルには consumer の上限が無い |

### 時計について — 誤読しかけた点

Queue 経路の `solve-started` → `solve-finished` の `at` の差は 233〜240ms で、幅がある。
cloud の fetch 経路では同値（差 0）で区間を特定できなかったので、**invocation の境界で
解けたように見える**。

しかし同じ harness の fetch 経路も 232〜416ms の幅を示した。**幅はローカル workerd の
時計の性質であって、Queue 経路の成果ではない。** cloud で確かめるまで、この点は
解決したと書けない。

## ack・retry・DLQ

- 受領行は `attempts` と結末を並べて出す。busy を経た要求は `attempts` が進んだ状態で
  deliver に入るため、その deliver 失敗は 1 回しか試されない。**記録を読むとき、これを
  「deliver が 1 回しか試されなかった」と読み違えない**ための並記である。
- **DLQ へ到達する経路は busy の連続だけ**である。deliver 失敗は `attempts >= 2` で
  ack するので DLQ へ行かない。今回は fetch 経路で isolate を占有して意図的に作り、
  `attempts` 1→2→3→4 の busy 受領行のあと DLQ に 1 件到達した。

### そこから出た条件 — **構造的に解消した**

測定した時点では「直接 probe 系列（fetch）と shim 系列（Queue）を同時に走らせない」を
cloud 試験の手順に置く必要があった。同じ isolate を fetch 経路が占有すると、Queue 側の
要求が busy を踏み続け、一度も解かれずに DLQ へ落ちるためである。

**2026-09-12、アプリから求解 Worker への直接 binding を外したことでこの経路は消えた。**
直接 probe も Queue に載るので、fetch 経路で isolate を占有する主体が cloud に存在しない。
手順で守る約束ではなく、binding が無いという構造で守られる。

**ただし `max_concurrency: 1` が前提である。** これを外すと同じ isolate へ複数 invocation が
同時に入り、負けた側が busy を踏んで同じ経路が復活する。配備設定の値は条件であって
最適化ではない。

## ローカルで測れないこと

1. 求解中の要求元の応答性（上記・Miniflare の同一プロセス）
2. 素の配送遅延（R5.10）。ローカルの Queue は実配送ではない
3. isolate をまたぐ再利用と memory growth
4. consumer の CPU／wall の上限に対する余裕
5. 時計が同期求解中に進まない問題が Queue の境界で解けるか（上記）
