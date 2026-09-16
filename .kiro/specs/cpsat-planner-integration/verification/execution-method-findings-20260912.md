# 実行方式について確定したこと — 索引と訂正

2026-09-12 時点。第 9 節の書き換えはこの 1 枚を根拠にする。

`verification/` は 22 本あり時系列に散っている。後から読む人が現在地を
再構成できるよう、**確定した事実・その証拠・訂正された記述・未検証**を
ここに集める。個々の測定値は各ファイルにあり、ここには重複させない。

## 1. 確定した事実

| # | 事実 | 環境 | 証拠 |
|---|---|---|---|
| F1 | service binding は、**呼ばれた側の同期作業が終わるまで呼出元を解放しない** | cloud | [accept-boundary](./accept-boundary-20260910.md) §2、`cloud-separation-invocations-20260910.json` |
| F2 | 原因は `waitUntil` でも応答 body の扱いでもない。**同期であることだけ**が効く | ローカル対照 | [accept-boundary](./accept-boundary-20260910.md) §3・§4 |
| F3 | `waitUntil` に同期作業を預けても呼出元は解放されない | cloud | [cloud-noawait](./cloud-noawait-20260912.md) |
| F4 | await しない位置を 1 ホップ手前へ動かしても効かない | cloud | 同上 |
| F5 | **呼出連鎖の中にいる店舗 DO は、求解の間ずっと塞がる** | cloud | [cloud-do-occupancy](./cloud-do-occupancy-20260912.md) |
| F6 | **呼出連鎖の外にいる店舗 DO は、自店舗の求解中でも 39〜52ms で応答する** | cloud | `cloud-separation-invocations-20260910.json` |
| F7 | 別 Worker・別 env・別 binding 構成・別 isolate では分かれない | cloud | F5 と、DO binding を持たない shim が握られた事実（F3） |
| F8 | 配置の制御は Placement Hints だけで、データセンター単位。CPU 分離の制御ではなく、Cloudflare が自動調整する | 公式 | [Smart Placement](https://developers.cloudflare.com/workers/platform/smart-placement/) |
| F9 | `PlanRequest` は Queue の 1 通（128 KB）に収まる。実データ寄り 44,081 B・構造上の最悪 77,696 B | ローカル実測 | [plan-request-size](./plan-request-size-20260912.md) |

**F6 が方向を決めた。** 止まる条件は「スレッドが塞がる」ではなく
「**自分が呼出の連鎖の中にいる**」である。連鎖から出れば DO は動き続ける。

## 2. 訂正された記述

後から読む人が古い枠組みを拾わないよう、明示的に残す。

| 訂正 | 内容 |
|---|---|
| **invocation 寿命 ≠ 応答到着** | 当初「アプリの invocation が長い」ことを分離不成立の根拠とした。Cloudflare の wall time は応答到着時刻とは別の指標であり、根拠にならない。測り直した結果が F1 である。[accept-boundary](./accept-boundary-20260910.md) §0 |
| [cloud-separation-20260910.md](./cloud-separation-20260910.md) | 上の訂正前の枠組みで書かれている。結論（分離していない）は後の測定でも維持されたが、**論証は差し替わっている**。数値は有効 |
| 「店舗 DO は塞がっていない」 | 直接 probe 系列での観測。正しいが、**要求を出したのが DO ではなかった**からである。F6 として範囲を限定した |
| 最初の no-await cloud 走行 | 無効 manifest のまま配備し、shim が 503 を返していた。速さは無活動の速さで、成功に数えない。[cloud-noawait](./cloud-noawait-20260912.md) §5 |

## 3. 未検証

| # | 内容 | なぜ残っているか |
|---|---|---|
| U1 | **店舗 DO 自身が await をやめた場合**の cloud 挙動 | `src/shell/store-timer-do.ts` の変更が要る。ローカルでは handler 0ms・別通信は残りの求解時間だけ待つ |
| U2 | **Queue consumer が呼出連鎖の外か** | F6 からそう見えるが、consumer の起動と配置を資料で確認していない |
| U3 | Queue の素の配送遅延（バッチ設定を除く） | 未計測 |
| U4 | 順序。古い解が新しい解を上書きしない条件 | design の表に行はあるが Queue 前提で書かれていない |
| U5 | solver の invocation が `outcome: canceled` で終わる | await 形・no-await 形の両方で観測。callback は届いている。未調査 |
| U6 | DO の hibernate 復帰（2.3 の項目） | 配備済みアプリで `OBSERVE_DEBUG=0` のため継ぎ目行が出ない |

## 4. 検証条件の申し送り

Queue を試すとき、**1 回動いたら合格にしない**。同居が起きるとしたら偶発なので、
繰り返し測って**遅い回が混じらないこと**を条件にする。今日の測定は平常時
114〜195ms・占有時 456〜533ms と分離がはっきりしているので、混入は見分けられる。

## 5. 後片づけの申し送り

非公開のアプリ版が 2 件、Access 値がプレースホルダのまま残っている
（`b20cd5b1-6f1c-4878-a8d5-119780bdedfd`、`8a8efeaa-1dac-456e-ba7f-f94b10a52a13`）。
トラフィックは向いていないが、**昇格させると Access が無効になる**。
`--keep-vars` の効果を確かめる過程で作ったもの。

あわせて、配備で踏んだ落とし穴を [cloud-do-occupancy](./cloud-do-occupancy-20260912.md)
に記録した——配備設定は root の `wrangler.jsonc` ではなく vite が生成する
`dist/yude_men_timer/wrangler.json` であること、`--keep-vars` は設定に載っている
var を保護しないこと、`wrangler versions view --json` は切り詰めのない値を返すこと。
