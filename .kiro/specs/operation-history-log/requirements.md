# Requirements Document — 共通の操作履歴基盤

2026-09-16改訂。両ログを **console.log(obj) → Tail Workerで検査・canonical化 → Pipelines → R2／Iceberg** のbest-effort収集とする。2026-09-12の収集経路統一に続き、要件を現行のオブジェクト出力へ追従する。今回の変更対象は要件書であり、runtime・配備の変更を含まない。旧Snowpipe版は [legacy-snowpipe-requirements.md](legacy-snowpipe-requirements.md) に保持する。

## Introduction

操作履歴と麺揚げ遅延ログを、R2 Data Catalogが管理するIcebergへ追記し、R2 SQLとSnowflakeから読む。生ログは期間で削除せず、直近7〜28日は分析窓として選ぶ。厨房操作の成功を観測・送信・分析基盤の状態に依存させない。

本specは既存のOperationRecord、共通Tail、Pipelines／Catalog、保存、reader、品質、observeを所有する。[lift-delay-log](../lift-delay-log/requirements.md) は原時刻・開始文脈・完了相関と専用console recordを所有する。両者の収集保証はbest-effortであり、業務状態の確定はログの保存保証ではない。

自前の配送Queue、Consumer、台帳、outbox、配送用Alarm、耐久受理API、ID別receipt、全件照合を新構成に設けない。記録を失った場合の永続再送も保証しない。Pipelines内の管理された処理を利用する。

### 適用範囲と実装順序

要件1〜3は既存操作履歴の事実とTimer本体への非干渉を保ち、consoleへ渡す形式をオブジェクトとする。アプリ側のProducerは記録の構築と同期console出力を担い、Tailは検査・canonical化・Pipelines送信を担う。保存するcanonical文字列の形式は保つ。遅延ログもconsole出力のためのnetwork・追加起動を持たず、開始文脈の記録方法は遅延specが所有する。操作履歴のON/OFF比較では遅延の設定を固定する。共通observeは店舗DOへ問い合わせず、read-onlyのためのconstructor分離や管理RPCを追加しない。

前段はoperation単独でschema・Tail送信・Iceberg・両reader・observe・保持を検証する。前段のローカル実装完了後に遅延の記録・開始文脈・wire相関を実装し、本番合流はoperation単独の実環境確認後に行う。遅延の実装を前段の完了条件にしない。

既存コード中の旧番号は [参照対応表](legacy-reference-map.md) に従う。新実装は `OH-I/<要件>.<AC>` で本書を参照する。先行レビューの確認事実と今回の採否は [review-evidence.md](review-evidence.md) に分けて残す。

## Glossary

- **Timer_System**: StoreTimerDO、純粋状態遷移、Timer_Persist、既存_Alarm、Snapshot 配信、既存_Effect_列、および応答を含む Timer 本体。
- **既存_Timer_Event**: 観測機能追加前から StoreTimerDO を起動し得る fetch、WebSocket message、既存 Timer Alarm、およびその他の Timer 本体イベント。観測専用イベントを含まない。
- **Producer_Invocation**: 一つの既存_Timer_Eventによって StoreTimerDO が起動または wake し、必要な既存理由の rehydrate を経て当該イベントを処理する invocation。
- **観測なし基準**: 同一の外部から与えた既存_Timer_Event列、各 decide イベントへ与える時刻列、および初期永続状態から、観測機能を実行せずに得られる Timer_System の結果。プラットフォームによる非決定的な instance 廃棄時点の完全一致は含まない。
- **Producer**: 既存_Timer_Event が起動した Producer_Invocation 内で、Timer_Persist 成功後の Operation_Record を Console_Record_Object として構築し、`console.log(obj)` で同期出力試行する StoreTimerDO の最小観測境界。検査・canonical化・Pipelines送信はTail側の責務。
- **Timer_Persist**: Timer_System が ActiveTimersSnapshot を既存の永続先へ保存し、Timer 状態を確定する既存処理。
- **確定前_TimerState**: Timer_Persist 直前の確定済み TimerState。
- **確定後_TimerState**: Timer_Persist 成功によって確定した TimerState。
- **Working_Copy**: Timer_Persist 成功時だけ確定済み TimerState へ更新される StoreTimerDO のメモリ上の複製。
- **TimerState**: アクティブな Timer 集合と既存の次回登録順を表す純粋状態。
- **TimerFact**: server と client が共有する既存の Timer事実の契約。
- **Timer事実**: 既存ドメイン契約が定める Timer の非導出属性。
- **ActiveTimersSnapshot**: TimerState を既存の単一永続先へ保存する表現。
- **既存_Effect_列**: Timer_System が既に持つ Persist、Alarm 設定または取消、および Broadcast の順序付き作用列。
- **既存_Alarm**: Timer の期限到来処理を予定する StoreTimerDO の Alarm。
- **Snapshot**: 接続先へ配信される既存の全量 Timer 表現。
- **Rehydrate**: 既存_Timer_Eventを処理するため、揮発した Working_Copy を StoreTimerDO 自身の既存永続状態から再構築する既存初期化。観測機能はその起動理由にならない。
- **Reconcile**: 既存理由の rehydrate に伴って現在時刻と TimerState を照合し、必要な Timer 状態遷移を決定する内部整合処理。Operation_Kind でも観測目的の起動経路でもない。
- **Operation_Record**: 一つの確定差分を表す best-effort の構造化 telemetry。Timer 状態の正本ではない。
- **Operation_Kind**: boil-started、boiled、completed、cancelled、adjusted のいずれか一つ。
- **Event_Time**: Timer_System が各 decide イベントへ渡すために一回採取する、0 より大きい整数の epoch millisecond。Reconcile では constructor が当該 Reconcile 用に独自に採取する。
- **既知属性**: Requirement 3 が Operation_Record に許可する属性。
- **未知属性**: Requirement 3 が定める全ての既知属性以外の JSON オブジェクト属性。
- **Console_Record_Object**: Producerがconsoleの唯一の引数として渡す記録のオブジェクト。操作履歴ではOperation_Kindに許可された既知属性だけを持ち、元の記録から属性を写し、slotIds配列も複製する。JSON文字列への変換やschema検査はProducerで行わない。
- **Canonical_JSON_Line**: 標準 JSON として妥当で、既知属性だけを固定順序と一意の表記で表す UTF-8 の一行文字列。現行経路ではTailがオブジェクトの検査後に生成する保存用表現であり、Producerのconsole引数ではない。
- **Operation_History_Codec**: Operation_Record と Canonical_JSON_Line の間を変換する printer と parser の対。printerはTailでの保存用文字列生成、parserは保存済み文字列の読取りと旧console文字列の互換経路で用いる。オブジェクトのschema検査はTailが別に行う。
- **解析失敗種別**: 文字列parserの不正 JSON、既知属性重複、必須属性欠落、Operation_Kind 不許可属性、既知属性型違反、既知属性値違反のいずれか。オブジェクトの検査失敗は、これらの優先順位を適用せず `schema-invalid` と検査箇所・理由で表す。
- **Tail_Worker**: Producer 完了後に StoreTimerDO とは別の Worker 実行として起動し、Producer の console logs を受け取るが、Producer または StoreTimerDO を再起動も呼び戻しもしない Worker。
- **Observability_Pipeline**: 操作履歴・遅延記録のconsole出力を、TailからPipelines経由でR2＋Icebergへ収集するbest-effort経路。
- **Data_Platform**: Tailの検証・送信、Pipelines、R2 Data Catalog、Iceberg、共通observe、分析エンジン接続を所有する。店舗DOへの逆呼出しを持たない。
- **Observed_Telemetry**: Tail_Workerが当該到達で観測した妥当な Operation_Record と、その初回観測時刻。
- **Data_Quality_Threshold**: lifecycle 内欠落率、重複率、孤児率、競合率について分析運用者が事前に定める信頼判定値。
- **信頼済み分析**: 全ての算出対象品質率が Data_Quality_Threshold を満たす店舗および期間だけを用いる分析。
- **承認済み分析担当者**: R2 SQL、Snowflake、共通observeの履歴・品質・分析結果へのアクセスを認められた担当者。
- **アクセス承認状態**: 分析担当者ごとのアクセス可否を表す Data_Platform の管理状態。

## Requirements

### Requirement 1: Timer 本体への非干渉

**User Story:** 現場スタッフとして、操作履歴consoleの観測機能の状態や障害にかかわらず Timer 操作が同じ結果になってほしい。そうすれば分析基盤の都合で厨房業務が変化しない。

#### Acceptance Criteria

1. WHEN Producer が StoreTimerDO 内で観測作用を行う, THE Producer SHALL 既存_Timer_Event が既に起動した同じ Producer_Invocation 内で、Console_Record_Object一件を唯一の引数とする同期 `console.log(obj)` だけを出力作用として試行する。Producerは出力前のJSON文字列化・schema検査・Pipelines送信を行わない
2. IF Operation_Record または Console_Record_Object の構築、あるいは console 出力が失敗する, THEN THE Producer SHALL 当該失敗を Timer_System の戻り値または既存例外へ伝播させず、観測目的の await、待機、再試行、および追加作用の発生件数を 0 件にする
3. THE Producer SHALL StoreTimerDO に操作履歴consoleのために追加する観測専用の永続状態、永続履歴、outbox、Record_Seq、採番状態、配送状態、Queue 待ち、binding、Alarm、および Effect の件数を 0 件にする
4. THE Timer_System SHALL Timer_Persist と Producer の観測作用を、相互の成功条件、失敗条件、rollback 条件、Atomic Commit、または完了待ちに含めない
5. WHEN 同一の初期永続状態、外部から与えた既存_Timer_Event列、および各 decide イベントへ与える時刻列について操作履歴consoleの観測機能 ON と OFF を比較する, THE Timer_System SHALL TimerState、Timer_Persist の呼出し内容と成否、Working_Copy、既存_Alarm の設定または取消、Broadcast の内容と宛先と順序、応答、および既存例外を観測なし基準と一致させる
6. WHEN 既存の純粋状態遷移へ同一の TimerState、入力、および現在時刻を与える, THE Timer_System SHALL 操作履歴consoleの観測機能の ON または OFF にかかわらず同一の次 TimerState および既存_Effect_列を返す
7. THE Timer_System SHALL TimerFact、TimerState、および ActiveTimersSnapshot のフィールド集合ならびに既存_Effect_列が取り得る Effect 集合を操作履歴consoleの観測機能追加前と一致させる
8. WHEN 同一の初期永続状態、外部から与えた既存_Timer_Event列、および各 decide イベントへ与える時刻列について操作履歴consoleの観測機能 ON と OFF を比較する, THE Producer および Observability_Pipeline SHALL 操作履歴consoleの観測機能に由来する StoreTimerDO の追加 construct、wake、rehydrate、storage read、および Alarm 予定の生成件数を 0 件にする
9. THE Producer および Observability_Pipeline SHALL 操作履歴consoleの収集・再出力のために観測側から StoreTimerDO を呼び戻す Alarm、scheduled event、Queue callback、RPC、Service Binding、HTTP fetch、Durable Object stub call、WebSocket message、およびその他の作用の発生件数を 0 件にする
10. WHEN Producer_Invocation が終了する, THE Timer_System SHALL 操作履歴consoleの観測に由来する未完了 Promise、timer、interval、開いた connection、および Alarm の保持数を 0 件にし、観測なし基準と同じ条件で hibernate 可能である
11. WHEN 操作履歴consoleの観測機能 ON と OFF の実行を比較する, THE 観測なし基準 SHALL プラットフォームによる非決定的な instance 廃棄だけから生じる construct、wake、または rehydrate の差を比較対象に含めない

### Requirement 2: 確定差分の best-effort 出力

**User Story:** 分析担当者として、Timer 本体を妨げない範囲で確定した操作事実を観測したい。そうすれば観測できた記録から店舗傾向を推定できる。

#### Acceptance Criteria

1. THE Producer SHALL Operation_Record の出力試行対象を、同じ Producer_Invocation 内の既存_Timer_Event処理または既存理由の rehydrate に伴う Reconcile が Timer_Persist の成功によって確定した、確定前_TimerState と確定後_TimerState の差分だけに限定する
2. WHEN Start による Timer 追加の Timer_Persist が成功し、同じ Producer_Invocation の Timer_System が通常完了する, THE Producer SHALL 当該確定差分一件につき確定後_TimerState の対応する Timer事実を用いた boil-started を一件だけ console へ出力試行する
3. WHEN 既存_Timer_Event処理による running から boiled への Timer_Persist が成功し、同じ Producer_Invocation の Timer_System が通常完了する, THE Producer SHALL 当該確定差分一件につき確定後_TimerState の対応する Timer事実を用いた boiled を一件だけ console へ出力試行する
4. WHEN Complete による Timer 除去の Timer_Persist が成功し、同じ Producer_Invocation の Timer_System が通常完了する, THE Producer SHALL 当該確定差分一件につき確定前_TimerState の対応する Timer事実を用いた completed を一件だけ console へ出力試行する
5. WHEN Cancel による Timer 除去の Timer_Persist が成功し、同じ Producer_Invocation の Timer_System が通常完了する, THE Producer SHALL 当該確定差分一件につき確定前_TimerState の対応する Timer事実を用いた cancelled を一件だけ console へ出力試行する
6. WHEN Adjust による firmness と endTime の変更の Timer_Persist が成功し、同じ Producer_Invocation の Timer_System が通常完了する, THE Producer SHALL 当該確定差分一件につき確定後_TimerState の対応する Timer事実を用いた adjusted を一件だけ console へ出力試行する
7. WHEN 既存理由の rehydrate に伴う Reconcile が running から boiled への差分を Timer_Persist し、同じ Producer_Invocation の Timer_System が通常完了する, THE Producer SHALL 当該確定差分一件につき確定後_TimerState の対応する Timer事実を用いた boiled を一件だけ console へ出力試行する
8. IF Reconcile が running から boiled への差分を Timer_Persist しない, THEN THE Producer SHALL 当該 Reconcile に対する Operation_Record の出力試行件数を 0 件にする
9. WHEN Producer が確定差分の出力を試行する, THE Producer SHALL 対応する Timer_Persist の成功後かつ既存_Alarm、Broadcast、応答、およびその他の Timer_System の作用を妨げない通常完了経路内で試行する
10. IF Timer_Persist 成功後に既存_Alarm、Broadcast、応答、またはその他の Timer_System の作用が例外終了する, THEN THE Producer SHALL 当該確定差分の telemetry 欠落を許容し、THE Timer_System SHALL 当該既存例外を捕捉または変換せずに伝播させる
11. IF 状態遷移が拒否、no-op、または Timer_Persist 失敗になる, THEN THE Producer SHALL 当該状態遷移に対する Operation_Record の出力試行件数を 0 件にする
12. WHEN Timer_System が decide イベントを生成する, THE Timer_System SHALL 当該 decide イベントへ渡す now を一回採取し、当該 now とその decide イベントが確定させた差分に対応する全 Operation_Record の Event_Time を同値にする
13. WHEN constructor が既存理由の rehydrate に伴う Reconcile を実行する, THE Timer_System SHALL 当該 Reconcile の decide イベントへ渡す now を独自に一回採取し、当該 now と対応する全 boiled の Event_Time を同値にし、後続する fetch または WebSocket message の Event_Time との同値を要求しない
14. IF Operation_Record または Console_Record_Object の構築、あるいは console 出力が失敗する, THEN THE Producer SHALL 当該失敗を Timer_System へ伝播させず、再試行件数を 0 件にし、成功済み Timer_Persist、Working_Copy、既存_Effect_列、応答、既存例外、および Timer 操作結果を変更しない。複数記録の出力中に一件の出力が失敗しても、後続記録の出力試行を妨げない
15. THE Timer_System SHALL 観測機能だけを理由として開始する Producer_Invocation、rehydrate、Reconcile、および Timer_Persist の件数をそれぞれ 0 件にする
16. THE Producer SHALL Operation_Record の属性を Store_Id、Timer事実、Operation_Kind、および Event_Time に限定し、seq、nextSeq、および Timer事実から計算可能な導出値を含めない
17. THE Operation_Record SHALL 既存の検証済み契約を満たす空文字でない Store_Id を含め、自然人へ直接対応する属性を含めない
18. WHEN Producer が Console_Record_Object を構築する, THE Producer SHALL Operation_Kindに許可された既知属性を新しいオブジェクトへ写し、slotIds配列を複製する。業務状態や元の記録の参照をそのままconsoleへ渡さず、後続の変更で出力対象の値が変わらないようにする

### Requirement 3: 構造化 telemetry 契約

**User Story:** データ基盤担当者として、観測記録を安定した機械可読形式で解釈したい。そうすれば未知属性や不正行を安全に扱いながら分析列を構築できる。

#### Acceptance Criteria

要件3.1〜3.7は記録の属性契約、3.8〜3.19は保存用canonical文字列と文字列codecの契約、3.20〜3.22はTailでのオブジェクト検査の契約とする。文字列parserが未知属性を無視することや重複キーを検出することを、オブジェクト経路へ適用しない。

1. THE Operation_Record SHALL 空文字でない Store_Id、空文字でない Timer_Id、Operation_Kind、Event_Time、既存ドメイン契約を満たす一つ以上の空文字でない slotIds、空文字でない noodleType、および既存ドメイン契約を満たす firmness だけを共通既知属性として含める
2. THE Operation_Record SHALL Record_Seq、seq、および nextSeq を含めない
3. IF Operation_Kind が boil-started である, THEN THE Operation_Record SHALL 共通既知属性、startTime、および endTime だけを含める
4. IF Operation_Kind が boiled である, THEN THE Operation_Record SHALL 共通既知属性、endTime、および boiledAt だけを含める
5. IF Operation_Kind が adjusted である, THEN THE Operation_Record SHALL 共通既知属性および変更後の endTime だけを含める
6. IF Operation_Kind が completed または cancelled である, THEN THE Operation_Record SHALL 共通既知属性だけを含める
7. THE Operation_Record SHALL Event_Time と存在する startTime、endTime、および boiledAt を 0 より大きい整数の epoch millisecond として含める
8. WHEN Operation_History_Codec の printer が Operation_Record を直列化する, THE Operation_History_Codec SHALL Store_Id、Timer_Id、Operation_Kind、Event_Time、slotIds、noodleType、firmness、startTime、endTime、boiledAt のうち存在する既知属性を当該順序で一つの Canonical_JSON_Line へ出力する
9. WHEN Operation_History_Codec の printer が文字列または整数 timestamp を直列化する, THE Operation_History_Codec SHALL 標準 JSON.stringify と同じ文字列 escape および整数の JSON 数値表記を使用する
10. THE Canonical_JSON_Line SHALL 先頭、末尾、属性間、および区切り記号の前後に余分な空白を含めず、BOM および埋め込み改行を含めない
11. WHEN 二件以上の Operation_Record をJSONLとして直列化する, THE Operation_History_Codec SHALL Canonical_JSON_Line を一つの LF で区切り、Operation_Record と各 slotIds の相対順序を保つ。Producerのconsole出力は一件ごとのオブジェクトとし、複数記録を一つの文字列や配列へまとめない
12. WHEN 保存済み文字列または旧console文字列をparserへ渡し、JSON として妥当で既知の必須属性、型制約、および値制約を満たす行を解析する, THE Operation_History_Codec SHALL 未知属性を無視して既知属性だけから Operation_Record を生成する。旧console文字列をTailが送信候補にする条件は要件4.11に従う
13. IF 行が同じ既知属性を二回以上含む, THEN THE Operation_History_Codec SHALL 既知属性重複として解析を失敗させる
14. IF 行が Operation_Kind に許可されない既知属性を含む, THEN THE Operation_History_Codec SHALL Operation_Kind 不許可属性として解析を失敗させる
15. IF 行が複数の解析失敗条件を含む, THEN THE Operation_History_Codec SHALL 不正 JSON、既知属性重複、必須属性欠落、Operation_Kind 不許可属性、既知属性型違反、既知属性値違反の順で最初の該当種別を選択する
16. IF 行の解析が失敗する, THEN THE Operation_History_Codec SHALL 先頭を 1 とする行番号と解析失敗種別を持つ判別可能な結果を生成する
17. WHEN 妥当な行と不正な行が混在する, THE Operation_History_Codec SHALL 不正行の後続行を含む全入力行を処理し、各行の Operation_Record または解析失敗を入力順に保持する
18. WHEN printer が生成した Operation_Record を直列化して解析する, THE Operation_History_Codec SHALL 全既知属性の名前、値、および slotIds の順序が元の Operation_Record と一致する Operation_Record を生成する
19. WHEN Canonical_JSON_Line を解析して再直列化する, THE Operation_History_Codec SHALL 入力と UTF-8 byte 単位で一致する Canonical_JSON_Line を生成する
20. WHEN 操作記録を名乗るオブジェクトを受け取る, THE Tail SHALL 要件3.1〜3.7の属性・型・値をschemaで検査する。必須属性の欠落、未知属性、Operation_Kindに許可されない既知属性、型違反、値違反のいずれかがあれば、その記録全体を拒否する。未知属性を除去して受理しない
21. IF オブジェクトのschema検査が失敗する, THEN THE Tail SHALL 当該記録を送らず、event内の候補位置と `schema-invalid`、検査箇所・理由を件数上限付きで診断し、後続の候補を処理する。文字列parserの解析失敗優先順位や重複キー検出を要求しない
22. WHEN オブジェクトのschema検査が成功する, THE Tail SHALL 検査後のOperation_Recordから要件3.8〜3.10に従うCanonical_JSON_Lineを生成する。受信オブジェクトのキー順序に依存せず、元のconsole引数とのbyte比較を行わない。schema検査の実装をProducerから参照させない

### Requirement 4: TailからPipelinesへ直接送る

1. THE Data_Platform SHALL 両datasetを `console.log(obj) → Tail Worker → Pipelines → R2 Data Catalog / Iceberg` で収集する。Pipelines bindingはTailに置き、本体Workerにはログ配送用bindingを追加しない。
2. THE Tail SHALL 許可したProducer scriptの `console.log` の唯一の引数である記録オブジェクトを取り出し、datasetを識別してschema検査を行い、検査後に固定共通列とcanonical文字列へ写す。既存OperationRecordを新属性で拡張せず、遅延recordは別の識別可能な形式とする。配列・null・複数引数・他のconsole levelは候補にしない。旧文字列の受入れは要件4.11に従う。
3. THE 両dataset SHALL `best-effort` と表示する。Tail以前の欠落・送信失敗・処理落ちを許容し、後から必ず回収できる契約を設けない。
4. THE Tail SHALL 配備Streamと同じ物理schema・null許容・値域・時刻単位・UTF-8サイズを送信前に検証する。不正行は送らず理由を観測し、batch内の妥当行は上限内で処理を継続する。
4a. THE Tail SHALL 操作履歴の候補を「操作記録を名乗る記録」に限定する。オブジェクトの名乗りは `typeof obj.operationKind === "string"` とし、許可されたOperation_Kindかどうかは後続のschema検査で判定する。記録の属性集合へ新しい印を足さない。旧文字列の名乗りは `"operationKind"` という部分文字列の存在で判定する。**名乗らない記録は操作履歴として解析・schema検査せず、その失敗としても数えない。** 同じWorkerが出す他機能の構造化ログを壊れた記録として数えれば、失敗の件数がアプリのログ量そのものになり、品質指標の分母が濁る（2026-09-16に本番のtailで毎分約200件の警告として顕在化した）。
5. THE 送信 SHALL Tail invocation内の件数・byte・batch数・実行時間予算を明示する。sendのPromiseをTailのwaitUntilで追跡し、失敗を観測する。Appによる再試行は初期実装で0回とし、次のinvocationへ未送信を保持しない。超過分の欠落を許容し、検出できた超過は理由付きで数える。
6. THE send成功 SHALL ingestedの確認に限定し、Iceberg保存完了・個別IDの永続受理とは表示しない。結果不明は失敗と成功のどちらにも断定しない。
7. THE Tail SHALL 観測行ごとのarrivalIdを採番し、同じ処理内で保持する。元実行の安定IDを仮定せず、再観測は別arrivalとして保存する。切詰め状態は検出済み／否定確認済み／不明を根拠付きで残す。
8. THE 保存 SHALL 原時刻、payload版、取得来歴、canonical文字列を保持する。rawの複製・競合を分析用の収束前に消さず、Pipelinesのexactly-onceを元イベントの重複排除保証へ読み替えない。
9. THE 物理schema SHALL 世代内で固定する。変更時は新Stream／sink／pipeline／新tableを作り、readerが世代を束ねる。既存表への新sink接続や手動field ID変更を前提にしない。
10. THE 新構成 SHALL 独自の配送Queue・Consumer・台帳・outbox・DLQ・配送Alarm・受理APIを持たない。新Logpush adapterも対象外とし、既存データの移行要否は棚卸しで別に判断する。
11. THE Tail SHALL 旧Producerとの互換性のため、許可したscriptの `console.log` の唯一の引数である改行を含まない文字列も引き続き受け付ける。操作履歴では名乗りの判定後に既存の文字列parserへ渡し、解析成功かつcanonicalへ再出力した文字列と入力がbyte一致する場合だけ送信候補にする。この互換経路を現行Producerの出力形式にはしない。

### Requirement 5: 保存済み記録の相関と品質

1. THE 操作履歴の一次相関 SHALL `(storeId, timerId, operationKind, eventTime)` と既知事実の整合で判定する。hashやtraceは補助情報とする。
2. THE 遅延標本 SHALL 安定eventIdと内容一致で収束させる。同じIDの異内容は競合として分析から分離し、rawを上書きしない。二表の同じ完了を2回の厨房操作として計数しない。
3. THE 品質表示 SHALL 保存済みraw行数、観測arrivalの一意数、分析標本数、重複・孤児・競合・文脈不足を分ける。全操作数や正確な全経路欠落率を保存済み行だけから導かない。両ログのcompleted突合率は保存済み記録同士の相対指標として提供する。
4. THE 操作履歴品質率 SHALL 旧契約の分子・分母を維持する。lifecycle内欠落率は復元可能な期待記録数、重複率は配送複製を含むraw到達数、孤児率は重複除外後の記録数、競合率は一次相関候補数を分母とする。分母0は算出不能とする。
5. THE 信頼判定 SHALL 品質閾値・取得完全性・収集エラー期間・監視coverageを示す。エラーまたは監視不能が重なる期間は統計採用を保留できる。エラー0や合成プローブ成功だけで完全収集・無偏りと判断しない。
6. THE 遅延分析 SHALL 原時刻から早め・0・正の差を再計算し、取消・相関なし・文脈不足を分ける。終端ログがないTimerは未完了かログ欠落か判定不能とし、0秒の完了にしない。
7. THE 品質・要約 SHALL 両readerの取得行に同じTypeScriptのcodec・相関・品質関数を適用する。Snowflake viewは照合用とする。必要なlifecycle前後文脈、取得範囲、方式版、refresh差を表示する。

8. THE completed突合 SHALL 両ログが有効な店舗・操作時刻の期間について、operation completed集合Oとlift-delay completed集合Lをそれぞれ重複排除し、各表内の内容競合および二表間の共有事実の矛盾を除外件数として分け、同じ `(storeId, timerId, eventTime = terminalAt)` と共有事実が整合する一致集合Mを求める。M/Oを遅延行の突合率、M/Lを逆方向の突合率とし、分子・分母・片側件数・競合・比較条件を表示する。分母0は算出不能とする。
9. THE 突合表示 SHALL invocationごと両方が失われる欠落を検出できず、全操作に対する欠落率ではないことを明示する。遅着・refresh差・片側無効化・未導入・部分取得・競合を分け、観測済み片側行だけから欠落の原因を断定しない。突合のための新たな永続配送状態は作らない。

### Requirement 6: 保持とSnowflake読み取り

1. THE 生ログ SHALL R2上のIcebergへ追記し、期間による行・partition削除を行わない。旧90日／25か月／28日のraw削除を採用しない。
2. THE query SHALL イベント期間と取込走査期間を分け、世代・店舗で限定する。Catalog sinkで任意のイベント日partitionを指定できる前提を置かない。実tableの取込列・partitionを確認し、遅着・移行データの取得範囲を明記する。
3. THE 保守 SHALL compaction・snapshot expirationを明示的に有効化し、現在の生ログを保つ。過去の全snapshotの永久保持やorphan fileの自動回収は保証しない。Iceberg管理ファイルへ旧TTLを適用しない。
4. THE Snowflake接続 SHALL 書込み不可のR2 external volumeとIceberg REST catalog integrationで同じtableを読む。新しいSnowflakeネイティブraw複製やそのSnowpipe取込は作らない。
5. THE reader運用 SHALL metadata更新方法・最終読取確認・可視範囲を表示する。AUTO_REFRESH既定無効を前提に、有効化時のSnowpipe名目refresh課金または明示refreshの費用・実行周期を記録する。
6. THE アクセス SHALL 承認済み分析者へ必要な読取り権限を与え、認証情報をログ・CLI引数・manifestへ出さない。TailのStream bindingは専用資源へ限定する。
7. THE 移行 SHALL 既存資源・履歴・削除設定の実環境棚卸しに基づく。不存在確認は理由付きN/A、未確認は未完とし、旧履歴を失う削除設定だけ対象を限定して停止・置換する。

### Requirement 7: 軽量なobserve

1. THE status SHALL Tailの検証不正・検出できた超過・send失敗／結果不明、Pipelines処理エラー、Icebergの店舗別件数・最新eventTime／取込時刻、Snowflakeの可視状態を表示する。指標の取得期間・監視coverage・最終取得時刻を併記する。
2. THE observe SHALL 個別業務ログの全経路未到達一覧、全操作に対する正確な欠落数／率、全件到達の保証、未配送最古時刻を提供しない。取込0件は無操作・欠落・停止のどれか確定できないと示す。指標自体の欠落・取得不能を0へ変換しない。要件5の二表突合による片側件数は、全操作の欠落数とは区別して表示する。
3. THE 経路確認 SHALL 専用の合成Producerからconsole → Tail → 各有効datasetのStream／sink → Iceberg → readerを定期的に通す。プローブID・送出予定時刻・確認時刻と結果を運用証跡に残し、実店舗データと必ず分離する。合成Producer自身のtail_consumers接続と定期実行を明示構成し、本体のattachmentだけで合成consoleが収集されると仮定しない。
4. THE プローブ SHALL 起動失敗、未確認、reader失敗、可視成功を区別する。有界回数の確認で終了し、未確認プローブを永続再送しない。合成経路の成否を業務ログの全件到達SLOへ読み替えない。確認queryの最小課金を含め、周期・有効dataset／世代数・確認回数による月間費用を見積もる。
5. THE 通知 SHALL 送信／処理エラー、プローブの期限超過、監視不能を対象とする。周期・閾値・通知先は明示し、運用監視の設定と短い結果証跡の範囲に留める。statusが読むTail診断・Pipelines指標・プローブ結果の取得API／経路、script／資源、権限、保持期間・集計粒度・samplingと遡及可能な期間をタスク1.4で確定する。保持期間外はunknownとする。業務ログごとの配送台帳を作らない。
6. THE CLI SHALL `status / export / summarize` を提供し、dataset・店舗・イベント期間・取込期間・世代を明示する。店舗DOへの照会や新管理APIを必要としない。
7. THE export SHALL JSONLとmanifestへreader・世代・schema／query版・取得開始終了・cursor・行数・ページ数・完全性を残す。R2 SQLのLIMIT最大10,000とOFFSET非対応に従い、keyset境界の複製・遅着・非snapshot性・資源拒否を扱う。
8. THE CLI SHALL 行数・byte・ページ・時間・再試行・メモリ上限を持ち、不完全取得を成功した全量としない。英語helpと機械可読JSONを提供し、純粋計算とNodeのI/Oを分ける。
9. THE 分析採用 SHALL 収集エラー期間を除外または保留した根拠をmanifestへ記す。繁忙時に欠落が偏る可能性を残し、外れ値処理で収集の偏りまで解消できるとしない。Appへのウェイト採用は後続specとする。

### Requirement 8: 段階的な検証と移行

1. THE 移行 SHALL 旧コード・SQL・テストの参照版を明示し、旧Queue／Snowpipe検証を新方式の成立証拠としない。旧資料の内容を保持する。
2. THE 移行manifest SHALL source、cutover、既存履歴の範囲・欠損・来歴を保存し、失われたconsole記録を生成しない。履歴が存在する場合だけ有界な一回の移行手順を作る。
3. THE 検証 SHALL console出力障害、不正schema、send失敗／結果不明、Tail打切り、上限超過、再観測重複、遅着、世代切替、0件・監視不能を含め、厨房操作の成否へ伝播しないことを確認する。後段ではsnapshotの毎回の残余評価と業務版不変、1 invocationの全console行数／総byte・遅延1行byte・切詰め・二表突合率を検証する。
4. THE cloud検証 SHALL 合成consoleからTail→Pipelines→Icebergと両readerを実際に通す。ローカルfixtureだけで接続・可用性・到達時間を確認済みとしない。Pipelines／Catalog／R2 SQLのbeta制約と費用を記録する。
5. THE 切替 SHALL 新経路が読めた後に対象の旧資源を停止する。ロールバックで履歴を消さず旧TTLを自動復活させない。CP-SAT差分とは分離し、spec・ローカル実装・配備・実測の状態を別報告する。
6. WHEN consoleの出力形式またはpayloadの形を変更する, THE 配備 SHALL 新旧の出力を受けられるTailをProducerより先に配備する。オブジェクト出力への切替では、旧文字列の受入れ、オブジェクトの検査、同じ事実から生成されるcanonical文字列の一致、未知属性・不正値の拒否、他機能ログの除外を検証する。schema検査がProducerの実行経路へ入らないことも確認する。
