# 統合レビューの確認記録

2026-09-12。公式資料とCloudflare APIの読み取りだけを実施。クラウド変更・配備・runtime／test／Wrangler変更は行っていない。specの完成、実装完了、実環境稼働は別状態である。

## 現在の採用判断

この棚卸しは前回の読み取り結果を保持したもので、今回再取得した結果ではない。最新のユーザー指示により、両ログをconsole→Tail→Pipelines→Icebergのbest-effort収集へ変更した。独自Queue・配送台帳・outbox・耐久受理APIは不採用。公式仕様から台帳が必須になるわけではなく、「全記録を耐久受理して再送する」という前案の要求が台帳を必要としていた。現在は欠落を許容し、送信・処理エラー、保存済み行、合成プローブを観測する。

## 公式資料との照合

| 論点 | 確認結果と採用した修正 |
| --- | --- |
| Stream変更 | schema変更不可。HTTP取込の有効化・認証・CORSは一部変更可能なので「Stream全体が不変」とは書かない。[公式](https://developers.cloudflare.com/pipelines/streams/manage-streams/) |
| sink／pipeline変更 | sink設定とpipeline SQLは再作成が必要。既存Iceberg tableへ新sinkを作れない。固定共通列＋canonical文字列、新物理世代で変更する。[sink管理](https://developers.cloudflare.com/pipelines/sinks/manage-sinks/)、[pipeline管理](https://developers.cloudflare.com/pipelines/pipelines/manage-pipelines/)、[Catalog sink](https://developers.cloudflare.com/pipelines/sinks/available-sinks/r2-data-catalog/) |
| send成功 | ingested確認。schema不一致は処理時に落ち得る。validatorと送信・処理エラー監視を置く。前案の全payload台帳・業務ID別到達照合は不採用とし、欠落を許容する。処理落ちはuser error metricsでも追えるため、検出手段が一切ないという意味の「黙って破棄」とは区別する。[送信](https://developers.cloudflare.com/pipelines/streams/writing-to-streams/)、[schema](https://developers.cloudflare.com/pipelines/streams/manage-streams/)、[metrics](https://developers.cloudflare.com/pipelines/observability/metrics/) |
| partition | CLIのpartitioningは通常R2 sink専用であり、Catalog sinkでイベント日を選べる前提を撤回。自動取込列の正確な名前・partition transformは今回の公式本文では未確認。作成table metadataと実クエリで固定するタスクを設け、推測名でSQLを書かない。[CLI](https://developers.cloudflare.com/pipelines/reference/wrangler-commands/) |
| R2 SQL | LIMITは1〜10,000、OFFSETなし。keysetと取込期間分割、境界複製・途中取得の検査が必要。betaでは資源予算による拒否もある。品質計算は既存TypeScriptへ集約する。[paging](https://developers.cloudflare.com/r2-sql/troubleshooting/)、[制約](https://developers.cloudflare.com/r2-sql/reference/limitations-best-practices/) |
| Snowflake refresh | AUTO_REFRESH既定FALSE。自動refreshはSnowpipeを用い、その名目で課金される。旧raw複製のSnowpipe取込を廃することと、refresh料金がないことは別。[table](https://docs.snowflake.com/en/sql-reference/sql/create-iceberg-table-rest)、[refresh](https://docs.snowflake.com/en/user-guide/tables-iceberg-auto-refresh) |
| テーブル保守 | compactionとsnapshot expirationの有効化が必要。どのsnapshotからも参照されなかったorphan fileは自動清掃対象外。[公式](https://developers.cloudflare.com/r2-data-catalog/table-maintenance/) |
| Tail | 公開TailItems契約には元実行の安定IDと切詰めフラグを確認できなかった。観測行IDをTailで採番し、切詰め状態は不明も保持する。env bindingsは説明されているが今回採用するTail→Pipelinesの対象環境動作は未実測。cloud smokeを必須にする。[Tail handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/)、[Tail Workers](https://developers.cloudflare.com/workers/observability/logs/tail-workers/) |
| beta | Pipelines、R2 Data Catalog、R2 SQLは確認時点でbeta表記。Snowflake停止時のR2 SQL継続はCloudflare側が利用可能という条件付き。[Pipelines](https://developers.cloudflare.com/pipelines/)、[Catalog](https://developers.cloudflare.com/r2-data-catalog/)、[R2 SQL](https://developers.cloudflare.com/r2-sql/) |

## 旧経路の先行棚卸し

対象: 接続済みCloudflareアカウントYamaokaya、既存wranglerで指定されたdefault資源名。GETのみ。APIの秘密値や業務ログ本文は取得・保存していない。

| GETの対象 | 結果 | 解釈 |
| --- | --- | --- |
| workers/scripts/yude-men-timer/settings | success、HTTP 200、tail_consumers=[] | 確認時点の本体にTail attachmentなし |
| workers/scripts/yude-men-telemetry-tail/settings | API error 10007、Worker does not exist | このアカウント・既知名の旧Tailは存在しない |
| workers/scripts/yude-men-raw-arrival-consumer/settings | API error 10007、Worker does not exist | このアカウント・既知名の旧Consumerは存在しない |
| r2/buckets、name_contains=operation、per_page=1000 | success、HTTP 200、buckets=[] | default jurisdictionの検索範囲でoperation-raw-arrivalsなし。他名・他jurisdictionは未確認 |
| queues | success、HTTP 200、total_count=1、total_pages=1 | 全1件は履歴用名ではなく、operation-recordsとoperation-records-dlqは存在しない |
| logpush/jobs（account単位） | success、HTTP 200、result=[] | このアカウントのaccount Logpush jobなし。zone単位や別アカウントは未確認 |

ローカルwrangler.jsoncでもtail_consumersはコメントアウトされている。ただしローカル設定だけを実環境の証拠にしない。mainブランチの過去全履歴は今回調査しておらず、導入時から一度も使われていないとは断定しない。

指定のCloudflare旧経路が現在接続されていないことは確認できた。指定bucketへの削除停止や現存データ移行はこの範囲では対象なし。Snowflakeのraw表／pipe／削除task、別名・別環境・過去に退避した履歴は未確認であり、現行タスク1.1は未完。Cloudflare側の不存在からSnowflakeも空と推定しない。

## 修正範囲と残る確認

- 共通・遅延のrequirements/design/tasks、参照対応表を修正した。実装順序はoperation前段→遅延後段を維持。
- 旧要件番号のコード内コメントは変更していない。[対応表](legacy-reference-map.md)で旧版を指すことを固定し、タスク1.5で明示表記へ移行する。
- root wranglerのCP-SAT入口・SOLVER等の既存試験差分は変更していない。specのコミットと実装・試験のコミットを分ける。
- 未配送保持を廃止したため、容量満杯時の厨房操作に関するD1は解消した。記録・送信の失敗で厨房操作を拒否しない。開始文脈は既存snapshotの任意属性として上限を持ち、取得不能は不明として扱う。

新たに確認する対象はTail→Pipelinesの実動作、取込列・partitionの実metadata、status参照元と保持期間、専用プローブの接続・定期実行・費用、開始文脈の保存byte評価法と旧reader切戻し・負荷である。これらは実装タスクの検証項目であり、spec変更で確認済みにしない。

## 容量・切戻し・実トラフィック突合の追加レビュー

コードの [pending.ts](../../../src/engine/pending.ts) は4096品目で1.09 MB／1.56 MBという代表値を記しているが、文字列長を制限しておらずbyte上界ではない。[types.ts](../../../src/engine/types.ts) のTimer上限は100、業務版は13。[migrate.ts](../../../src/engine/migrate.ts) は未来版を拒否し、既知キーだけを復元する。これらは今回コードを読んで確認した事実であり、境界負荷や切戻しを実行して検証した結果ではない。

SQLite-backed DOのkey＋value上限2 MBは [公式limits](https://developers.cloudflare.com/durable-objects/platform/limits/) でも確認した。文脈を付ける条件は固定枠から、毎回の業務snapshot実内容に基づく保存サイズの安全な上界・残余の確認へ変更した。評価不能なら任意キー全体を省略する。JSON byte数と保存byte数の同一性は未検証であり、安全な評価法とruntime境界テストは実装タスクに残す。

業務版を13から引き上げず、文脈を同じ階層の任意キーとして追加する制約と、新writer→変更前reader／writer→新readerの切戻しテストをspecに明記した。未来版拒否を弱める変更は行わない。

実トラフィックのcompleted突合率M/O・逆方向M/Lと片側件数を追加した。両ログの有効化範囲、重複・競合・遅着・取得不完全を分け、両行が消えたinvocationは検出できない。プローブの合成経路監視と合わせて評価し、全経路の欠落率としない。

[R2 SQL料金](https://developers.cloudflare.com/r2-sql/platform/pricing/) の最小10 MB/query・$0.0025/GBを確認し、共通設計に周期と確認回数ごとの走査費用例を追加した。statusの読取API／権限・実際の遡及期間、プローブの専用Tail接続・定期実行・合算費用が未確定なら、共通タスク1.4は未完とする。今回のspec修正だけでタスク1全体の完了や実環境検証済みとはしない。
