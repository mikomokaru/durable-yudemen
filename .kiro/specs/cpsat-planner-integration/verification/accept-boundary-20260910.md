# 受理境界の切り分け — どこで親が待っているか

証拠: `accept-boundary-local-20260910.json`（ローカル workerd・実 WASM・実固定問題）,
`cloud-separation-invocations-20260910.json`（cloud・アプリ側 invocation）,
`cloud-concurrency2-join-20260910.json`（cloud・solver 側）

## 0. 前提の訂正

先に「アプリの invocation が長い」ことを分離不成立の根拠として述べたのは誤り
だった。Cloudflare の invocation wall time は応答到着時刻とは別の指標である。
以下はすべて、その指標ではなく**呼出側自身の時計での経過**で測り直している。

## 1. 配備版の照合

`yude-men-timer` の稼働版は `f1d82402-6a94-405a-8fe5-a261a3678a89`（2026-09-10
T13:56:08Z）。`request.ts`・`app.ts`・`solver.ts` は 09:33Z 以前、`manifest.json`
は 13:55:52Z の更新で、いずれも配備より前。**計測した挙動は現在のソースのもの。**

`request.ts:101-105` は既に「子の fetch を待つ → `body.cancel()` → 新しい
`Response.json` を返す」であり、子の Response をそのまま転送してはいない。

## 2. cloud で測れていた点（測定点 1＋2）

`dispatchCpsatTransportRequest` は `solver.fetch()` の直前に
`cpsat.request-dispatched` を、`await response.body?.cancel()` の直後に
`cpsat.dispatch-result` を出す。この 2 行の `at` の差が測定点 1＋2 である。

| ラウンド | 1＋2（アプリ自身の時計） | solver CPU |
|---|---|---|
| 0 | 1,498ms | 1,426ms |
| 1 | 1,292ms | 1,255ms |
| 2 | 3,270ms | 2,779ms |
| 3 | 1,465ms | 1,400ms |

両者の間に I/O があるので時計は進んでおり、これは実経過時間である。
ただし 1 と 2 は分離できていない。

## 3. ローカル最小再現（測定点 1 と 2 の分離）

実 WASM・実固定問題（hard・予算 0.14）で、呼出側の body の扱いだけを 3 通りに
変えた。

| body の扱い | 1: fetch 解決 | 2: body 処理 |
|---|---|---|
| `cancel()` | 473ms | **0ms** |
| `text()` | 271ms | **0ms** |
| 触らない | 259ms | **0ms** |

**body の扱いは原因ではない。** 測定点 2 は 3 通りとも無償である。

## 4. 対照 — どの機構が待たせているか

同じ呼出側から、202 を返したあと `waitUntil` に置く仕事だけを変えた子を呼ぶ。

| 子の `waitUntil` | 1: fetch 解決 |
|---|---|
| 何も置かない | 0ms |
| **非同期**の 1,500ms 待ち | **1ms** |
| **同期**の 1,500ms 消費 | **1,500ms** |

- `waitUntil` に仕事を残すこと自体は親を待たせない（非同期 1,500ms → 1ms）。
- 親が待つのは、**子の応答後の仕事が同期である場合だけ**である。

したがって原因は `waitUntil` でも body でもなく、**単一スレッドの同期 WASM が
service binding の共有スレッドを占有すること**である。これは design 第 9 節が
公式資料から引いて先に挙げていた懸念そのものである。

> Service binding は公開 URL を通さず Worker を呼べるが、既定では同じサーバの
> 同じスレッドで実行される。配置を CPU 分離の保証と読み替えない。

cloud の測定点 1＋2（1,292〜3,270ms）が solver CPU（1,255〜2,779ms）と一致する
のも、この機構で説明がつく。

## 5. この切り分けで言えないこと

- **ローカル workerd は cloud ではない。** 上は機構の同定であって、production
  の証明ではない。cloud 再確認は依然として必要である。
- **測定点 3 と 4 は cloud では未分離のまま。** ドライバが 202 を受け取った
  時刻は remote binding proxy 越しの値しかない。求解中の別操作の応答（39〜52ms）
  は取れている（`cloud-separation-20260910.md`）。
- **店舗 DO 自身が呼出側になる経路は未検証。** cloud で通したのは直接 probe
  だけで、shim 系列（DO の Effect → SOLVER → shim → solver）は配備版の manifest
  が無効なため一度も通っていない。**呼出側が DO のとき DO が占有されるかは
  分かっていない。** cloud で ops 操作が 39〜52ms で返ったのは、要求を出したのが
  DO ではなく probe 入口だったからである。

## 6. 次

第 9 節へ戻すかどうかは、5 の最後の点を測ってから決める。呼出側が DO のときに
DO が同じだけ占有されるなら、実行契機の作り直しが要る。占有されないなら、
呼出側を DO から切り離す修正で足りる可能性がある。いずれも cloud 再確認と
2.5 判定の前段である。
