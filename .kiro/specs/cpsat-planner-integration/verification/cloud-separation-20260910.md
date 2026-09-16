# 受理と求解の分離 — 反証（2.3・2.5 の停止条件に該当）

証拠: `cloud-separation-invocations-20260910.json`（アプリ側 invocation 集計）,
`cloud-concurrency2-join-20260910.json`（同じ 4 ラウンドの solver 側）,
`cloud-separation-20260910.json`（shim 系列の試行）

## 何を測ったか

solver 自身の時計は同期 WASM 実行中に進まないので、solver の行では求解区間を
特定できない（`cloud-concurrency-20260910.md` §1）。そこで**呼出側の Worker の
invocation 集計**を使った。アプリの `CpsatTransportProbe`（`POST /plan`）は
`CPSAT_SOLVER` の応答ヘッダを受けて戻る作りなので、アプリ側の invocation が
短ければ、202 が求解の完了前に戻った証拠になる。

## 結果

同じ 4 ラウンドの、アプリ側と solver 側の invocation：

| ラウンド | アプリ `POST /plan` wall | アプリ CPU | solver wall | solver CPU |
|---|---|---|---|---|
| 0 | 1,499ms | **1ms** | 1,505ms | 1,426ms |
| 1 | 1,292ms | **1ms** | 1,301ms | 1,255ms |
| 2 | 3,271ms | **5ms** | 3,110ms | 2,779ms |
| 3 | 1,467ms | **2ms** | 1,473ms | 1,400ms |

**アプリの invocation は solver の invocation とほぼ同じ長さ、開いたままだった。**
CPU は 1〜5ms なので、アプリは計算していない——solver への subrequest で待って
いる。solver 側は確かに `ctx.waitUntil(deliver(...))` の後に 202 を返している
（`solver.ts:384-385`）が、**その 202 は呼出側へ即座には戻っていない。**
プラットフォームが子の `waitUntil` が終わるまで親の invocation を開いたままに
するためである。

ローカル driver の待ち時間が invocation 全体とほぼ一致していた（21〜429ms 差）
のも、remote binding proxy の性質ではなく、この連鎖そのものだった。

## 判定

2.1 の「受理が求解完了より先に戻る」は **成立していない**。
「別 Worker・`async`・`waitUntil` を使った事実だけで分離成立と判定しない」と
いう 2.3 の但し書きが、まさにこの状況を指している。コード上の分離はあるが、
呼出側から見た分離は無い。

2.5 は「不成立…は合格にしない。**3.2以降へ着手せず、第9節の実行方式の設計へ
戻る**」と定めている。**この結果は 2.5 の停止条件に当たる。**

同時に、求解中に同じ店舗の独立操作が 39〜52ms で完了・通知されている
（`POST /ops/orders` の invocation・同資料）。**店舗 DO は塞がっていない。**
塞がるのは要求を出した側の invocation だけである。

## shim 系列は未検証のまま

店舗 03・04（shim 経由）を注文で駆動したところ、shim は 3/3 とも 503 を返した。
配備済み shim の版は `2026-09-10T11:45:15Z`（手順4）で、manifest を有効化する
前のものである。したがって shim に埋め込まれた manifest は無効のままであり、
**shim 系列はクラウドで一度も通っていない。** 通常の POS 流入は同じ shim を
素通しで 202（wall 1〜25ms）で流れており、そちらへの影響はない。

## 残る未検証

- **DO 復帰（hibernate からの復帰）**。試行したが証拠が取れない。
  12 分アイドルにした store 02 へ注文を 1 件入れたところ、`POST /ops/orders` の
  invocation は wall 833ms・CPU 2ms（温まっている時は 39〜52ms）で、退避からの
  復帰らしい待ちは観測できた。しかし **construct / rehydrate の継ぎ目行は 0 件**
  で、配備済みアプリでは `instrumentationEnabled` が立っていない。
  `StoreTimerDO.jsrpc` の invocation 集計は実 POS の同時流入と混ざり、店舗を
  識別する欄が無いため自分の DO のものを特定できない。
  **`restoredCount` による復帰の確認には、計装を有効にしたアプリの再配備が要る。**
- 11 件目の callback 欠測（`cloud-repeat-20260910.md`）。
- cloud のドライバ 3 本が `ledger.mjs` を通っていない。
- `GET /ops/watch` の invocation が 28,476ms・`outcome: exception` で終わった。
  WS 中継の終端の扱いに問題がある可能性がある（2.2 の設計上は両側確認まで
  `waitUntil` で保持する）。未調査。
