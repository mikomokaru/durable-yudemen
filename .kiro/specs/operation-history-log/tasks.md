# Implementation Plan — 共通の操作履歴基盤

2026-09-12改訂。console→Tail→Pipelines→Icebergのbest-effort収集を実装する。実装・配備は未着手。[旧タスク](legacy-snowpipe-tasks.md)の完了印を引き継がない。要件参照 `OH-I/n.m` は [現行要件](requirements.md) の要件n・AC m。

## 前段: operation単独

- [ ] 1. 実環境と契約を固定する
  - [ ] 1.1 [先行棚卸し](review-evidence.md)を起点に、Tail attachment・旧Queue／Consumer・R2／TTL・Snowflake／削除task・別環境の読み取り確認を完了する。未確認とN/Aを分ける。
  - [ ] 1.2 旧履歴がある場合だけ移行と停止範囲を決める。Logpush adapter・配送台帳は新設しない。
  - [ ] 1.3 固定物理schema、dataset識別、Stream／sink／table名、Tailのbatch件数・byte・時間予算を固定する。再試行は0回。
  - [ ] 1.4 statusが読むTail診断・Pipelines指標・scheduler結果のAPI／取得経路、対象script／資源・権限・sampling・粒度・保持日数・最古取得可能時刻を具体化する。**取得経路と認可は2026-09-15に確定し[設計の表](design.md)へ記した**（Workers Observability の telemetry query／GraphQL の pipelines 3 node／token は 3 種に分かれる）。残りは token の発行と保持期間の実測。専用Producerの別tail attachmentと定期実行、プローブ周期・確認回数・期限・通知先を決め、query最小課金・有効dataset／世代数・実走査を含む月間費用を見積もる。業務IDごとの追跡は作らない。
  - [ ] 1.5 [旧番号対応表](legacy-reference-map.md)に従いコード・テストの参照版とlegacy検査の対象を明示する。CP-SAT差分をコミット対象から分ける。
  - 完了条件: inventory、条件付き移行範囲、公開名・上限・status参照元と遡及期間・プローブ接続／定期実行／費用の設定案が揃う。二表突合の定義は後段の契約として固定し、遅延実装を前段完了の条件にしない。
  - _Requirements: OH-I/4, 6.7, 7.3–7.5, 8.1–8.2_

- [ ] 2. 共通schemaとTailの直接送信
  - [ ] 2.1 既存OperationRecord codecを保持し、dataset別の抽出・意味検証・固定共通列への写像を実装する。
  - [ ] 2.2 Stream schemaと同じ定義からruntime validatorを作る。必須・null・時刻単位・安全整数・UTF-8サイズを検証する。
  - [ ] 2.3 TailにStream bindingを置き、上限内のbatchをwaitUntilで送信する。Queue／Consumerを経由しない。失敗・結果不明・検出できた超過を診断する。
  - [ ] 2.4 行ごとのarrivalId、切詰めunknown、再観測重複、不正行後の妥当行、打切り、再試行0回を検証する。Tail診断が再帰収集されない設定にする。
  - 完了条件: 下流失敗でも本体へ逆呼出しがなく、未知と成功を混同しない（P1–P3）。
  - _Requirements: OH-I/1–4, 8.3_

- [ ] 3. Icebergと世代管理
  - [ ] 3.1 operation用Stream／sink／pipelineを作る設定を用意する。固定列＋canonical文字列を保存し、payload検証をSQLへ任せない。
  - [ ] 3.2 新物理世代への切替と複数世代readerをfixtureで検証する。資源ID・schema digest・切替期間を構成ファイルへ記す。
  - [ ] 3.3 取込列名・partition変換とroll設定を実環境で確認する。sinkを既存tableへ再接続する手順を作らない。
  - 完了条件: 元時刻・原文を保持し、世代をまたいでも旧rawが読める（P2・P4）。
  - _Requirements: OH-I/4.8–4.9, 6.1–6.2, 8.4_

- [ ] 4. 軽量observeと合成経路確認
  - [ ] 4.1 Tail診断・Pipelines処理エラー、店舗別保存件数・最新時刻、指標の取得失敗をstatusへまとめる。
  - [ ] 4.2 専用Producer自身のtail_consumers attachmentと定期起動を設定し、consoleからoperationの実Stream／sinkへ合成行を流す。予定実行と起動失敗も運用schedulerから観測する。
  - [ ] 4.3 対象probeIdを有限回queryして終了する。未確認・reader失敗・成功を分け、期限超過・監視不能を通知する。未確認分を永続再送しない。
  - [ ] 4.4 合成行の除外、プローブ自体の失敗、無操作の0件、監視coverage不足、エラー期間の統計採用保留を検証する。
  - 完了条件: 業務ログの未到達数を捏造せず、経路と監視の故障を区別できる（P3・P6）。
  - _Requirements: OH-I/5.5, 7.1–7.6, 7.9_

- [ ] 5. export・共通TypeScript品質
  - [ ] 5.1 status/export/summarize、英語help・JSON出力、JSONL＋manifestを作る。read-only queryを用い、店舗DOへ照会しない。
  - [ ] 5.2 世代・イベント窓・取込窓で限定したkeyset取得を実装する。10,001行以上、同一キーの多重複製、遅着、世代境界、非snapshot取得を検証する。
  - [ ] 5.3 既存correlation／qualityを再利用する。lifecycleの必要な前後文脈とraw多重度を保ち、不足時はincompleteにする。
  - [ ] 5.4 認可拒否・secret非出力・HTML応答・不正行・資源拒否・行数／byte／時間／メモリ上限・有限終了を検証する。
  - 完了条件: 同じ固定ファイルから同じ結果が得られ、部分取得を完全と表示しない（P5）。
  - _Requirements: OH-I/5, 6.2, 6.6, 7.6–7.9_

- [ ] 6. Snowflakeと保守・条件付き移行
  - [ ] 6.1 read-only external volume、REST catalog integration、世代別tableのSQL／権限を用意する。refreshの方式・周期・費用を明示する。
  - [ ] 6.2 同じoperation合成行を両readerで読み、原文・時刻・件数を照合する。viewは照合用とする。
  - [ ] 6.3 compaction／snapshot expirationを明示構成し、保守前後の現在行を照合する。orphan fileの調査手順を残す。
  - [ ] 6.4 旧履歴が存在するときだけ、一回の移行manifest・取得／送信・件数照合を用意する。旧TTL／削除task停止は対象を限定し、不在は証跡付きN/Aにする。
  - 完了条件: 両readerの実queryと保守の証跡、移行結果または理由付きN/Aが揃う（P4–P5）。
  - _Requirements: OH-I/6, 8.2, 8.4–8.5_

- [ ] 7. operation単独の完了判定
  - [ ] 7.1 ローカル: 全Operation_Kind、Producer非干渉、直接送信とreader障害の関連テスト・typecheck・lintを通す。
  - [ ] 7.2 cloud: 合成console→Tail→Pipelines→Iceberg→両reader→CLIを実測する。send失敗・処理エラー・Snowflake停止・R2 SQL確認不能を検証する。
  - [ ] 7.3 CPU・サイズ・件数・到達時間・走査費用を記録し、監視周期を確定する。新経路確認後の旧資源停止と履歴を消さない復帰手順を揃える。
  - [ ] 7.4 ローカル完了・配備・実測を別に記録する。CP-SAT試験設定の混入がないことを確認する。
  - 完了条件: P1〜P6の証拠が揃う。7.1完了後に後段実装へ進めるが、本番合流には実環境確認も必要。
  - _Requirements: OH-I/1, 4–8_

## 後段: 遅延記録の合流

- [ ] 8. lift-delayを同じconsole経路へ追加する
  - [ ] 8.1 [lift-delay-log/tasks.md](../lift-delay-log/tasks.md)と専用record識別・canonical codec・安定eventIdを揃える。耐久受理APIは作らない。
  - [ ] 8.2 Tailのdataset validator・遅延用Stream／sink／tableを追加し、両方best-effortと表示する。
  - [ ] 8.3 共通プローブへ遅延datasetを追加し、その実Stream／sinkの到達を確認する。共通CLIへ同じTypeScriptの遅延要約を接続する。
  - [ ] 8.4 同じ完了のM/O・M/L・片側件数を共通TypeScriptで実装し、片側／両側欠落、競合、重複、分母0、遅着、片側無効化、部分取得を検証する。遅延側の毎回のsnapshot残余評価と業務版不変・旧reader切戻し、invocationの全console行数／総byte・遅延1行byte分布・切詰めを測定する。operation単独の実環境確認後に本番合流する。
  - 完了条件: lift-delay側の性質と共通P1〜P6が通り、両datasetの合成経路が確認できる。
  - _Requirements: OH-I/4–5, 7–8; lift-delay-log/1–7_
