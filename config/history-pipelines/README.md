# 共通の履歴基盤 — Pipelines 資源（物理世代 v1）

現行 spec: [operation-history-log](../../.kiro/specs/operation-history-log/design.md)。console → Tail Worker → Pipelines → R2 Data Catalog / Iceberg の best-effort 収集で使う資源の構成を置く。

**2026-09-12 に実アカウントで作成し、合成 Producer で経路を確認した。** 資源 ID と実測結果は [実環境確認の記録](../../docs/operation-history/cloud-verification-2026-09-12.md)。本番 Producer の `tail_consumers` は未 attach。

旧 Snowpipe 方式の設定は [config/operation-history-snowflake](../operation-history-snowflake/README.md) と [config/operation-history-r2](../operation-history-r2/README.md) に残っている。そちらは旧構成の記録であり、この方式へそのまま適用しない。

## 物理 schema

[arrivals-v1.schema.json](arrivals-v1.schema.json) が物理世代 v1 の列定義である。正本は `src/data-platform/arrival.ts` の `ARRIVAL_FIELDS` で、この JSON はそこから写した配備用の成果物。ずれは `tests/data-platform/stream-schema.example.test.ts` が止める。

両 dataset は同じ列を使う。`dataset` 列は stream ごとに定数になるが、export した JSONL や世代をまたいだ読み取りで行が自分を説明できるように残す。

列名は canonical payload の属性名と同じ camelCase にした。`store_id` は POS ベンダーの payload キーであり、型メンバとして宣言しない規律があるため、綴りを分ける。sink が自動で付ける取込時刻列だけは Cloudflare 側の表記になる。R2 SQL では**引用符なしのまま参照できることを実 table で確認した**。Snowflake は引用符なしの識別子を大文字へ畳むため、あちらは接続時に確かめる。

**作成後に変更できない。** stream の schema、sink の設定、pipeline の SQL はいずれも再作成が必要で、既存の Iceberg table へ新しい sink を繋ぐこともできない。列を変えるときは物理世代を上げ、別名の stream・sink・pipeline・table を作り、reader が世代を束ねる（要件 4.9）。

## 認証情報の置き場

catalog sink の作成には R2 Data Catalog 権限を持つ Cloudflare API トークンが要る。**値はこの repo に置かない。** macOS のキーチェーンに置き、コマンドの中で読み出す。

| 用途 | service 名 | account |
| --- | --- | --- |
| R2 Data Catalog（sink 作成・Iceberg 読み取り） | `cloudflare-r2-catalog` | `$USER` |

記録する（値は端末のプロンプトで入力する。履歴にも引数にも残らない）。

```sh
security add-generic-password -s cloudflare-r2-catalog -a "$USER" -U -w
```

使う（値を表示せずに渡す）。

```sh
CT=$(security find-generic-password -s cloudflare-r2-catalog -a "$USER" -w)
pnpm wrangler pipelines sinks create operation_arrivals_v1_sink \
  --type r2-data-catalog --bucket yude-men-history \
  --namespace history --table operation_arrivals_v1 \
  --catalog-token "$CT" --roll-interval 60
```

既存の `cloudflare-dns` は DNS 用の別トークンで、Catalog の権限を持たない（`code: 1012` で拒否される）。混同しない。

## 資源名（物理世代 v1）

| dataset | stream | sink | Iceberg table |
| --- | --- | --- | --- |
| operation | `operation_arrivals_v1` | `operation_arrivals_v1_sink` | `history.operation_arrivals_v1` |
| lift-delay | `lift_delay_arrivals_v1` | `lift_delay_arrivals_v1_sink` | `history.lift_delay_arrivals_v1` |
| order-arrival | `order_arrival_arrivals_v1` | `order_arrival_arrivals_v1_sink` | `history.order_arrival_arrivals_v1` |

どちらも 2026-09-16 時点で作成済み。Tail は dataset ごとに別の binding（`HISTORY_ARRIVALS` / `LIFT_DELAY_ARRIVALS`）で送り分ける。同じ batch に別 dataset を混ぜない。

dataset ごとに stream・sink・pipeline を分けるのは、後段で遅延記録を足すときに operation 側の資源へ触れずに済ませるため。共有した stream に pipeline SQL で振り分ける形だと、SQL を変更できない以上、dataset を足すたびに operation 側の pipeline を作り直すことになる。

## 作成手順（未実施）

```sh
pnpm wrangler pipelines streams create operation_arrivals_v1 \
  --schema-file config/history-pipelines/arrivals-v1.schema.json \
  --http-enabled false

pnpm wrangler pipelines sinks create operation_arrivals_v1_sink \
  --type r2-data-catalog --bucket <bucket> --namespace history \
  --table operation_arrivals_v1 --catalog-token <token> --roll-interval 60
```

HTTP 取込は閉じる。この stream への正当な到達経路は Tail Worker の binding だけであり、公開の取込口を開けない（要件 6.6）。

roll interval は既定 300 秒・最小 60 秒。可視までの時間はここでは決まらず、実測で確かめる。プローブの確認期限はその実測から決める（タスク 1.4）。

sink が自動で付ける取込時刻列で日ごとに partition される。イベント日を partition に選ぶことはできないので、query はイベント期間と取込走査期間を別に指定する（要件 6.2）。実 table の metadata で確認した形は、列 `__ingest_ts`（timestamp・ID 1・先頭に足される）と partition `__ingest_ts_day = day(__ingest_ts)` である。宣言した 14 列は ID 2 以降に宣言順で並ぶ。
