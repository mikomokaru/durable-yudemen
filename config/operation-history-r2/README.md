# Operation History — R2 bucket 側の保持の宣言的正本

`operation-history-log` の raw arrival を置く R2 bucket `operation-raw-arrivals` の
**object lifecycle 設定の宣言的な正本**。適用手順は
[`docs/operation-history/retention-procedure.md`](../../docs/operation-history/retention-procedure.md)
に従ってユーザーが実行する（bucket 設定は Cloudflare account 側の状態ゆえリポジトリからは適用されない）。

所有者は Data Platform である。Producer 設定の SSOT（root `wrangler.jsonc`）へ R2 への binding も保持設定も
置かない（要件 4.10 / 4.13 / 4.14）。

## ファイル

| ファイル | 内容 | 要件 |
| --- | --- | --- |
| `raw-arrival-lifecycle.json` | bucket `operation-raw-arrivals` の lifecycle 設定一式（`wrangler r2 bucket lifecycle set --file` にそのまま渡す形） | 6.7 / 6.9 |

## なぜ Wrangler 設定ファイルに書かないのか

lifecycle は **bucket 単位の設定**であって Worker の binding ではない。実装時点で導入済みの Wrangler v4
（4.105.0）の `config-schema.json` に lifecycle 用のキーは存在せず、`wrangler.raw-arrival-consumer.jsonc` の
`r2_buckets` には binding 名と bucket 名しか書けない。ゆえに保持は `wrangler r2 bucket lifecycle set` が読む
JSON をリポジトリの正本として持ち、適用は手順書に置く。形は Cloudflare の put object lifecycle
configuration API の request body と同じである（`rules` 配列に `id` / `enabled` / `conditions` /
`deleteObjectsTransition`）。

## 規律

- **削除の起点は R2 保存成功時刻である。** `deleteObjectsTransition.condition` は `type = Age`、
  `maxAge = 7776000` 秒（= 90 日）で、object の upload 時刻から数える。Consumer は put 成功後だけ ack する
  （要件 4.5）ため、保存成功時刻から 90 日という要件 6.7 の起点と一致する。
- **削除を早める条件を一つも足さない。** 期限前に保持期限を理由とする削除を 0 件にするため（要件 6.9）、
  rule は 90 日の expire 一つだけである。storage class transition も、より短い expire も置かない。
- **prefix は object key の文法に従う。** `raw/` は key を作る側（`src/data-platform/raw-arrival-consumer.ts`）
  が必ず付ける接頭辞である。両者の一致は `tests/operation-history/retention.static.test.ts` が検査する。
- **`set` は既存 rule を全部置き換える。** bucket 既定の「incomplete multipart upload を 7 日で中止」も
  消える。Consumer は一回の `put` だけを使い multipart upload を作らないため、この bucket に中止対象は
  存在しない。存在しないものへの rule を置かない。
- 削除完了までの時間は Cloudflare の documented behavior（expire 条件を満たしてから通常 24 時間以内）に
  依る。要件 6.8 の 24 時間はこの性質をそのまま使う。前倒しの削除も追加の削除 job も構成しない。

## Snowflake 側の保持

Snowflake 記録の 25 UTC 暦月保持は
[`config/operation-history-snowflake/07-retention.sql`](../operation-history-snowflake/07-retention.sql)
が正本である。R2（90 日）と Snowflake（25 UTC 暦月）は別の期限であり、どちらも他方を根拠にしない。
