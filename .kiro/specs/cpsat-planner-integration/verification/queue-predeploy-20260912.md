# 配備直前の再照合（2026-09-12・Queue 方式）

配備差分 §3.1 手順 1。**1 つでも 2.1 の記録と異なれば停止する。**
ローカル HEAD の一致は代用にならない。

## 結果：一致。停止条件に触れない。

| 照合項目 | 2.1／直近の記録 | 取得値 | 判定 |
|---|---|---|---|
| アカウント | `305d89a643ac689b4204454c5493cbde` | 同一 | ✅ |
| DO namespace 件数 | 11（9-10 に 12→11 の差異を許容して基準化） | **11** | ✅ |
| 対象 DO namespace | `yude-men-timer_StoreTimerDO`・`_StoreRegistryDO` | 両方在り、`script` も `yude-men-timer` | ✅ |
| アプリ現稼働版 | `ea3665b7-c09d-457d-b6d6-2b6be02c1c95` | 同一（100%） | ✅ |
| solver 現稼働版 | `f3cf6457-8dcb-43ad-9632-d6d2d73300ab` | 同一（100%） | ✅ |
| shim 現稼働版 | `5d06def7-a1ec-4a7c-a67f-e7551652cb1c` | 同一（100%） | ✅ |
| アプリの Access | `ACCESS_REQUIRED=1`・`TEAM_DOMAIN` 34 文字・`POLICY_AUD` 64 文字 | 同一 | ✅ |
| アプリの secret | `ADMIN_TOKEN`・`ORDER_INGRESS_TOKEN` | 両方在り | ✅ |
| アプリの binding | `SOLVER → shim`・`CPSAT_SOLVER → planner`・`ASSETS`・DO 2 件 | 同一 | ✅ |
| solver の CPU 上限 | `cpu_ms: 10000`（2.4 の分母） | **10000**（`resources.script_runtime.limits`） | ✅ |
| shim の binding | `SOLVER → yude-men-solver`・`CPSAT_SOLVER → planner` | 同一 | ✅ |
| 合成店舗 4 件 | `...-01`〜`-04` | 今日の DO 占有試験と no-await 試験が 02・04 へ実際に注文を通した | ✅ |
| **Queue 名の空き** | 新規 2 本 | `cpsat-plan-requests`・`cpsat-plan-requests-dlq` は**存在しない** | ✅ |

## 配備で触らないもの（確認済み）

アカウントには既存の Queue が 1 本ある。

| name | id | producers | consumers | 作成 |
|---|---|---|---|---|
| `kanda-load-notify` | `0fe8297811544615a2b0cfe383950a56` | 1 | 1 | 2026-07-29 |

**これは別機能のものであり、触らない。** 今回作る 2 本と名前が衝突しないことを確認した。
`wrangler queues` の操作は必ず名前を明示し、`list` の結果をそのまま消す形は採らない。

DO namespace の残り 9 件（`do-slack-gateway*` 7 件、`do-slack-gateway-*-poc*` 2 件相当、
`share-pages_PageHub`）も対象外である。

## 取得方法

- 版・binding・var・secret・CPU 上限：`wrangler versions view <id> --name <worker> --json`
  （**表形式は値を切り詰める**ので JSON を使う。`POLICY_AUD` は 64 文字で、表では途中で切れる）
- DO namespace：`GET /accounts/{account}/workers/durable_objects/namespaces`
  （`wrangler durable-objects namespace list` は当該 wrangler に無い）
- Queue：`wrangler queues list`

## 未取得のまま進めるもの

- **観測設定（`head_sampling_rate` ほか）。** 手元の API token は Workers Observability Write
  のみで、script settings の読み取りは 403 になる（9-10 に確認）。配備設定
  （`wrangler.queue-consumer.jsonc`）には `head_sampling_rate: 1` を明示しており、
  配備後の実値は読めない。**「設定上の間引きがない」ことの確認は配備設定の記述までで、
  欠落ゼロの保証ではない。**
- **累積送出の確定値。** cloud ドライバは `ledger.mjs` を通っていないので、承認要求の
  「消費 45 件・残枠 83」は各報告書から数えた概算である。配分 66 件を守る責任は人手にある。

## 次

手順 2〜6 を順に実施する。手順 4 と 6 は「`CPSAT_SOLVER` の削除と producer の追加」で
あり、追加ではなく置換である。窓は 1 回だけ開く。
