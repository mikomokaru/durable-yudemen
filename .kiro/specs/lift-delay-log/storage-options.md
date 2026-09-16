# 保存先と収集方式 — 共通のR2＋Iceberg

2026-09-12改訂。R2＋Icebergの採用を維持し、ユーザー指示により両ログをconsole→Tail→Pipelinesのbest-effort収集へ統一する。実装・配備は未変更。

## 採用する構成

- 生ログはPipelinesからR2 Data Catalog／Icebergへ追記し、期間で削除しない。直近7〜28日は分析窓。
- 操作履歴も遅延記録も同期consoleへ出し、共通Tailが検証してStreamへ直接送る。自前Queue・Consumer・配送台帳・outbox・配送Alarm・耐久受理APIは作らない。
- 稼働Timerの開始文脈だけを既存業務snapshotの任意属性に保持する。毎回の業務snapshot実内容からkey・保存形式overhead・安全余裕を含む残余を評価し、安全に収まると確認できなければ任意キー全体を省略する。固定の文脈byte枠だけで保存を許可しない。業務snapshot版（導入基準13）は上げず、旧readerでの切戻しを保つ。
- 両ログの収集保証はbest-effort。業務状態が確定していてもログ保存は欠落し得る。失われたログの永続再送・全件到達の保証は持たない。
- R2 SQLとSnowflakeで同じIcebergを読む。固定共通列＋canonical文字列を保存し、物理変更は新table世代を作る。品質・分位点は同じTypeScriptで計算する。

## observe

Tailの検証・送信エラー、Pipelinesの処理エラー、店舗別の保存件数・最新時刻・遅延分布と、専用の合成consoleによる経路確認を使う。監視coverage・取得不能を表示し、障害期間の統計採用を保留できる。両ログが有効な店舗・期間ではcompletedの突合率と片側件数を表示する。これは両行が失われたinvocationを検出できない相対指標である。statusの参照元・保持期間、専用プローブのTail接続・定期実行・確認query費用を共通タスク1.4で固定する。個別業務ログの未到達一覧・正確な欠落率・現在の未完了数を提供するための追加状態は持たない。

## 正本と順序

共通の保存・保持・Tail・reader・品質・observeは [共通要件](../operation-history-log/requirements.md)、[設計](../operation-history-log/design.md)、[タスク](../operation-history-log/tasks.md)。遅延固有の原事実・開始文脈・相関は [要件](requirements.md)、[設計](design.md)、[タスク](tasks.md)。

operation単独のローカル検証後に遅延を実装し、本番合流はoperationの実環境確認後。旧Snowpipe履歴・削除設定の移行は [棚卸し](../operation-history-log/review-evidence.md) で存在を確認した範囲だけ行う。

## 公式資料と制約

WorkerからStreamへ直接送信できる。send成功はingested確認であり、schema不一致は処理で落ち得るため事前検証を行う。[送信契約](https://developers.cloudflare.com/pipelines/streams/writing-to-streams/)

Catalog sinkがIcebergへの書込みを担う。[Catalog sink](https://developers.cloudflare.com/pipelines/sinks/available-sinks/r2-data-catalog/)。Snowflakeは同じtableへread-only接続する。[接続例](https://developers.cloudflare.com/r2-data-catalog/config-examples/snowflake/)

compactionとsnapshot expirationは明示的に有効化し、現在の生ログを保つ。全snapshotの永久保持とは区別する。[保守](https://developers.cloudflare.com/r2-data-catalog/table-maintenance/)
