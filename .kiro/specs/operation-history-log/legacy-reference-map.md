# 旧要件番号の参照先と移行対応

2026-09-12。下記の既存コード・テスト・設定中のoperation-history要件番号は、[legacy-snowpipe-requirements.md](legacy-snowpipe-requirements.md)を参照する。現行要件の同じ番号へ機械的に読み替えない。新仕様の参照は `OH-I/<要件>.<AC>`、旧仕様は `OH-S/<要件>.<AC>` とし、ファイルの先頭注記または各コメントで版を明示する。

本変更はspecのみで、既存コメント・assertionの書換えはまだ行っていない。以下の一覧で旧参照の解釈を固定し、共通タスク1.5と各実装タスクで明示参照へ移行する。旧テストの成功は新仕様適合の証明にはならない。

| 旧要件 | 現行への扱い |
| --- | --- |
| 1〜3 | console Producerの契約は維持。no-wakeとconfig-graphはconsole経路に限定し、遅延の設定を固定して比較する |
| 4（旧搬送・逆呼出し禁止） | OH-I/4・7へ。旧Queue／Consumerのack契約は新方式へ移植しない。Tailから直接sendし、best-effort・再試行0回とする |
| 5（旧相関・品質・raw） | OH-I/4.8・5。TypeScript相関・分子分母は再利用、旧Snowpipe SQLは照合用へ整理する |
| 6.1〜6.6・6.13（旧Snowflake到達SLO） | OH-I/7へ。業務全件到達SLOを外し、合成プローブ・エラー監視・保存済み行の可視状態へ変更する |
| 6.7〜6.9（旧90日・25か月保持） | OH-I/6.1〜6.3・6.7へ。旧設定のstatic検査に隔離し、新構成へ適用しない |
| 6.10〜6.12（旧アクセス） | OH-I/6.4〜6.6へ。外部Icebergとreader権限の実検査に差し替える |

## 旧4〜6の参照を確認したファイル

一覧は範囲を限定した文字列検索の結果であり、他specの番号は置換しない。rootのwrangler.jsoncはCP-SAT変更中なので、一括書換え・一括stageの対象にしない。

- `config/operation-history-snowflake/01-raw-arrival-ingest.sql`
- `config/operation-history-snowflake/02-first-arrival-association.sql`
- `config/operation-history-snowflake/03-correlation-and-convergence.sql`
- `config/operation-history-snowflake/04-quality-rates-and-trusted-analysis.sql`
- `config/operation-history-snowflake/05-best-effort-disclosure.sql`
- `config/operation-history-snowflake/06-arrival-slo-and-notification.sql`
- `config/operation-history-snowflake/07-retention.sql`
- `config/operation-history-snowflake/08-access-control.sql`
- `src/data-platform/raw-arrival-consumer.ts`
- `src/data-platform/tail-worker.ts`
- `src/operation-history/quality.ts`
- `tests/operation-history/arrival-quality.property.test.ts`
- `tests/operation-history/config-graph.static.test.ts`
- `tests/operation-history/config-smoke.static.test.ts`
- `tests/operation-history/correlation.property.test.ts`
- `tests/operation-history/no-backfill.static.test.ts`
- `tests/operation-history/quality.example.test.ts`
- `tests/operation-history/quality.property.test.ts`
- `tests/operation-history/raw-arrival-consumer.example.test.ts`
- `tests/operation-history/retention.static.test.ts`
- `tests/operation-history/slo.property.test.ts`
- `tests/operation-history/snowflake-access.integration.test.ts`
- `tests/operation-history/snowflake-access.static.test.ts`
- `tests/operation-history/snowflake-disclosure.static.test.ts`
- `tests/operation-history/snowflake-ingest.static.test.ts`
- `tests/operation-history/snowflake-operations.integration.test.ts`
- `tests/operation-history/snowflake-pipeline.integration.test.ts`
- `tests/operation-history/snowflake-quality.static.test.ts`
- `tests/operation-history/snowflake-slo.static.test.ts`
- `tests/operation-history/support/snowpipe.ts`
- `tests/operation-history/support/tail-to-r2.ts`
- `tests/operation-history/tail-queue-r2.integration.test.ts`
- `tests/operation-history/tail-worker.example.test.ts`
- `tests/operation-history/tail.example.test.ts`
- `tests/operation-history/tail.property.test.ts`
- `tests/operation-history/unobserved-telemetry.integration.test.ts`
- `tests/operation-history/wrangler-config-keys.static.test.ts`
- `wrangler.jsonc`
- `wrangler.raw-arrival-consumer.jsonc`
- `wrangler.telemetry-tail.jsonc`

## テストの移行順

1. 既存のcodec・純粋品質・console非干渉は維持し、参照版を固定する。
2. config-graph／no-wakeはTailの直接Stream bindingと店舗DOへの逆経路なしを検査する。両ログとも配送Alarm・管理readを追加せず、console起因の追加起動0件を保つ。遅延の任意開始文脈保存だけは別specの範囲として検証する。
3. 旧retention・snowflake-ingest・snowflake-slo等はlegacy構成を明示した検査として保持する。新構成の無削除・Tail直接送信・合成プローブ・reader権限テストを実装し、完了判定を切り替える。
4. 旧資源を廃止する際は棚卸し証拠とセットでlegacy検査の実行範囲を整理する。新仕様に合わないという理由だけで検査を削除しない。
