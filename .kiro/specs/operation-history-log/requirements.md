# Requirements Document

## Introduction

本機能は、現場スタッフの Timer 操作を構造化 telemetry として best-effort に観測し、R2 を経由して Snowflake で店舗の生産能力と傾向を推定する。StoreTimerDO 内の観測作用は、既存_Timer_Event が既に起動した同じ Producer_Invocation 内で Producer が Canonical_JSON_Line の同期 console 出力を試行することだけとし、その成否は Timer_System の状態、作用、応答、既存例外、hibernation、construct、wake、および rehydrate を変えない。

Producer は、既存_Timer_Event の処理または既存理由の rehydrate に伴う Reconcile が同じ Producer_Invocation 内で Timer_Persist に成功させた確定差分だけを、後続する Timer_System の作用が通常完了した経路で出力試行する。Reconcile は観測目的では起動せず、running から boiled への差分を Timer_Persist した場合だけ boiled を出力対象とする。既存作用が例外終了した場合は telemetry の欠落を許容する。

第一経路は Producer → structured console log → Tail_Worker → Queue → Consumer → R2 → Snowpipe → Snowflake とし、Tail_Worker を利用できない環境は Logpush を用いる。Tail_Worker は Producer 完了後に StoreTimerDO とは別の Worker 実行として起動する。Observability_Pipeline は structured console log から下流への一方向に限定し、収集、配送、再試行、保存、および品質判定を StoreTimerDO の実行外で行う。分析結果は観測できた telemetry に基づく best-effort 推定であり、完全な権威履歴ではない。

## Glossary

- **Timer_System**: StoreTimerDO、純粋状態遷移、Timer_Persist、既存_Alarm、Snapshot 配信、既存_Effect_列、および応答を含む Timer 本体。
- **既存_Timer_Event**: 観測機能追加前から StoreTimerDO を起動し得る fetch、WebSocket message、既存 Timer Alarm、およびその他の Timer 本体イベント。観測専用イベントを含まない。
- **Producer_Invocation**: 一つの既存_Timer_Eventによって StoreTimerDO が起動または wake し、必要な既存理由の rehydrate を経て当該イベントを処理する invocation。
- **観測なし基準**: 同一の外部から与えた既存_Timer_Event列、各 decide イベントへ与える時刻列、および初期永続状態から、観測機能を実行せずに得られる Timer_System の結果。プラットフォームによる非決定的な instance 廃棄時点の完全一致は含まない。
- **Producer**: 既存_Timer_Event が起動した Producer_Invocation 内で、Timer_Persist 成功後に Operation_Record の Canonical_JSON_Line を structured console log として同期出力試行する StoreTimerDO の最小観測境界。
- **Timer_Persist**: Timer_System が ActiveTimersSnapshot を既存の永続先へ保存し、Timer 状態を確定する既存処理。
- **確定前_TimerState**: Timer_Persist 直前の確定済み TimerState。
- **確定後_TimerState**: Timer_Persist 成功によって確定した TimerState。
- **Working_Copy**: Timer_Persist 成功時だけ確定済み TimerState へ更新される StoreTimerDO のメモリ上の複製。
- **TimerState**: アクティブな Timer 集合と既存の次回登録順を表す純粋状態。
- **TimerFact**: server と client が共有する既存の Timer事実の契約。
- **Timer事実**: 既存ドメイン契約が定める Timer の非導出属性。
- **ActiveTimersSnapshot**: TimerState を既存の単一永続先へ保存する表現。
- **Atomic Commit**: 複数の変更を一体として成功または rollback させる確定境界。本機能の観測処理には採用しない。
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
- **Canonical_JSON_Line**: 標準 JSON として妥当で、既知属性だけを固定順序と一意の表記で表す UTF-8 の一行文字列。
- **Operation_History_Codec**: Operation_Record と Canonical_JSON_Line の間を変換する printer と parser の対。
- **解析失敗種別**: 不正 JSON、既知属性重複、必須属性欠落、Operation_Kind 不許可属性、既知属性型違反、既知属性値違反のいずれか。
- **Tail_Worker**: Producer 完了後に StoreTimerDO とは別の Worker 実行として起動し、Producer の console logs を受け取るが、Producer または StoreTimerDO を再起動も呼び戻しもしない Worker。
- **Observability_Pipeline**: Producer の structured console log から Snowflake までを一方向に結ぶ Timer_System 外の観測経路。
- **Data_Platform**: Tail_Worker、Queue、Consumer、Logpush、R2、Snowpipe、Snowflake、および下流の再試行とデータ品質管理を所有する責任主体。Producer または StoreTimerDO への呼出し、再出力要求、ack 返却を行わないが、Consumer から Queue への下流内部 ack は含み得る。
- **Queue**: 第一経路で Tail_Worker から Operation_Record を受け取り Consumer へ配送する本体外の入口。
- **Consumer**: Queue から受け取った Operation_Record を R2 へ保存する処理主体。
- **Logpush**: Tail_Worker を利用できない環境で、観測できた structured console log を R2 へ搬送する縮退経路。
- **Observed_Telemetry**: Tail_Worker または Logpush が初めて観測した妥当な Operation_Record と、その初回観測時刻。
- **Data_Quality_Threshold**: lifecycle 内欠落率、重複率、孤児率、競合率について分析運用者が事前に定める信頼判定値。
- **信頼済み分析**: 全ての算出対象品質率が Data_Quality_Threshold を満たす店舗および期間だけを用いる分析。
- **承認済み分析担当者**: Snowflake の Operation_Record、品質指標、分析結果へのアクセスを明示的に承認された担当者。
- **アクセス承認状態**: 分析担当者ごとのアクセス可否を表す Data_Platform の管理状態。

## Requirements

### Requirement 1: Timer 本体への非干渉

**User Story:** 現場スタッフとして、観測機能の状態や障害にかかわらず Timer 操作が同じ結果になってほしい。そうすれば分析基盤の都合で厨房業務が変化しない。

#### Acceptance Criteria

1. WHEN Producer が StoreTimerDO 内で観測作用を行う, THE Producer SHALL 既存_Timer_Event が既に起動した同じ Producer_Invocation 内で Canonical_JSON_Line の同期 console 出力だけを試行する
2. IF Operation_Record の構築、JSON 直列化、または console 出力が失敗する, THEN THE Producer SHALL 当該失敗を Timer_System の戻り値または既存例外へ伝播させず、観測目的の await、待機、再試行、および追加作用の発生件数を 0 件にする
3. THE Producer SHALL StoreTimerDO に追加する観測専用の永続状態、永続履歴、outbox、Record_Seq、採番状態、配送状態、Queue 待ち、binding、Alarm、および Effect の件数を 0 件にする
4. THE Timer_System SHALL Timer_Persist と Producer の観測作用を、相互の成功条件、失敗条件、rollback 条件、Atomic Commit、または完了待ちに含めない
5. WHEN 同一の初期永続状態、外部から与えた既存_Timer_Event列、および各 decide イベントへ与える時刻列について観測機能 ON と OFF を比較する, THE Timer_System SHALL TimerState、Timer_Persist の呼出し内容と成否、Working_Copy、既存_Alarm の設定または取消、Broadcast の内容と宛先と順序、応答、および既存例外を観測なし基準と一致させる
6. WHEN 既存の純粋状態遷移へ同一の TimerState、入力、および現在時刻を与える, THE Timer_System SHALL 観測機能の ON または OFF にかかわらず同一の次 TimerState および既存_Effect_列を返す
7. THE Timer_System SHALL TimerFact、TimerState、および ActiveTimersSnapshot のフィールド集合ならびに既存_Effect_列が取り得る Effect 集合を観測機能追加前と一致させる
8. WHEN 同一の初期永続状態、外部から与えた既存_Timer_Event列、および各 decide イベントへ与える時刻列について観測機能 ON と OFF を比較する, THE Producer および Observability_Pipeline SHALL 観測機能に由来する StoreTimerDO の追加 construct、wake、rehydrate、storage read、および Alarm 予定の生成件数を 0 件にする
9. THE Producer および Observability_Pipeline SHALL 観測側から StoreTimerDO を呼び戻す Alarm、scheduled event、Queue callback、RPC、Service Binding、HTTP fetch、Durable Object stub call、WebSocket message、およびその他の作用の発生件数を 0 件にする
10. WHEN Producer_Invocation が終了する, THE Timer_System SHALL 観測に由来する未完了 Promise、timer、interval、開いた connection、および Alarm の保持数を 0 件にし、観測なし基準と同じ条件で hibernate 可能である
11. WHEN 観測機能 ON と OFF の実行を比較する, THE 観測なし基準 SHALL プラットフォームによる非決定的な instance 廃棄だけから生じる construct、wake、または rehydrate の差を比較対象に含めない

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
14. IF Operation_Record の構築、JSON 直列化、または console 出力が失敗する, THEN THE Producer SHALL 当該失敗を Timer_System へ伝播させず、再試行件数を 0 件にし、成功済み Timer_Persist、Working_Copy、既存_Effect_列、応答、既存例外、および Timer 操作結果を変更しない
15. THE Timer_System SHALL 観測機能だけを理由として開始する Producer_Invocation、rehydrate、Reconcile、および Timer_Persist の件数をそれぞれ 0 件にする
16. THE Producer SHALL Operation_Record の属性を Store_Id、Timer事実、Operation_Kind、および Event_Time に限定し、seq、nextSeq、および Timer事実から計算可能な導出値を含めない
17. THE Operation_Record SHALL 既存の検証済み契約を満たす空文字でない Store_Id を含め、自然人へ直接対応する属性を含めない

### Requirement 3: 構造化 telemetry 契約

**User Story:** データ基盤担当者として、観測記録を安定した機械可読形式で解釈したい。そうすれば未知属性や不正行を安全に扱いながら分析列を構築できる。

#### Acceptance Criteria

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
11. WHEN 二件以上の Operation_Record を直列化する, THE Operation_History_Codec SHALL Canonical_JSON_Line を一つの LF で区切り、Operation_Record と各 slotIds の相対順序を保つ
12. WHEN JSON として妥当で既知の必須属性、型制約、および値制約を満たす行を解析する, THE Operation_History_Codec SHALL 未知属性を無視して既知属性だけから Operation_Record を生成する
13. IF 行が同じ既知属性を二回以上含む, THEN THE Operation_History_Codec SHALL 既知属性重複として解析を失敗させる
14. IF 行が Operation_Kind に許可されない既知属性を含む, THEN THE Operation_History_Codec SHALL Operation_Kind 不許可属性として解析を失敗させる
15. IF 行が複数の解析失敗条件を含む, THEN THE Operation_History_Codec SHALL 不正 JSON、既知属性重複、必須属性欠落、Operation_Kind 不許可属性、既知属性型違反、既知属性値違反の順で最初の該当種別を選択する
16. IF 行の解析が失敗する, THEN THE Operation_History_Codec SHALL 先頭を 1 とする行番号と解析失敗種別を持つ判別可能な結果を生成する
17. WHEN 妥当な行と不正な行が混在する, THE Operation_History_Codec SHALL 不正行の後続行を含む全入力行を処理し、各行の Operation_Record または解析失敗を入力順に保持する
18. WHEN printer が生成した Operation_Record を直列化して解析する, THE Operation_History_Codec SHALL 全既知属性の名前、値、および slotIds の順序が元の Operation_Record と一致する Operation_Record を生成する
19. WHEN Canonical_JSON_Line を解析して再直列化する, THE Operation_History_Codec SHALL 入力と UTF-8 byte 単位で一致する Canonical_JSON_Line を生成する

### Requirement 4: 本体外へ隔離した搬送

**User Story:** 運用者として、telemetry の搬送と再試行を Timer 本体から隔離したい。そうすれば下流障害が厨房の Timer 操作へ波及しない。

#### Acceptance Criteria

1. WHERE Tail_Worker を利用できる環境である, WHEN Observability_Pipeline をデプロイする, THE Data_Platform SHALL Producer、structured console log、Tail_Worker、Queue、Consumer、R2、Snowpipe、Snowflake の順を第一経路として構成する
2. WHEN Producer の実行が完了する, THE Tail_Worker SHALL Producer 完了後に StoreTimerDO とは別の Worker 実行として起動し、完了した Producer 実行の console logs を受け取る
3. WHEN Tail_Worker が妥当な Canonical_JSON_Line を受け取る, THE Tail_Worker SHALL 当該行から得た Operation_Record だけを Queue へ送信する
4. IF Tail_Worker が不正行を受け取る, THEN THE Tail_Worker SHALL 当該行を Queue へ送信せず、行番号と解析失敗種別を観測側に保持する
5. WHEN Queue が Operation_Record を Consumer へ配送する, THE Consumer SHALL 当該 Operation_Record の R2 への保存成功後だけ Queue へ ack し、保存成功前の ack 件数を 0 件にする
6. WHEN R2 に Operation_Record が保存される, THE Snowpipe SHALL 当該 Operation_Record を Snowflake へ取り込む
7. WHERE Tail_Worker を利用できない環境である, WHEN Logpush が structured console log を観測する, THE Observability_Pipeline SHALL 観測できた Operation_Record だけを Logpush、R2、Snowpipe、Snowflake の順に best-effort で搬送する
8. WHERE Tail_Worker を利用できない環境である, WHEN structured console log を観測できない, THE Data_Platform SHALL backfill および Producer への再出力要求の発生件数を 0 件にする
9. WHEN Producer が一件の Operation_Record を出力試行する, THE Producer SHALL StoreTimerDO 外への境界を一件の Canonical_JSON_Line から成る一件の structured console log だけにする
10. THE Producer SHALL StoreTimerDO から Queue、Consumer、R2、Snowpipe、および Snowflake への呼出し件数を 0 件にする
11. IF Tail_Worker、Queue、Consumer、R2、Snowpipe、または Snowflake で処理失敗が発生する, THEN THE Data_Platform SHALL 待機、再試行判断、失敗状態保持、および再配送を下流の再試行ポリシーに従って StoreTimerDO の実行外だけで行う
12. THE Data_Platform SHALL 全環境の Object Storage に R2 を使用し、最終分析基盤に Snowflake を使用する
13. THE Observability_Pipeline SHALL structured console log から Snowflake への一方向だけに処理し、Producer または StoreTimerDO への逆方向経路を構成しない
14. THE Tail_Worker および Data_Platform SHALL Producer または StoreTimerDO への呼出し、ack 返却、および再出力要求の発生件数ならびに StoreTimerDO の construct、wake、および rehydrate の原因となる件数を 0 件にする
15. WHEN Consumer が Requirement 4.5 の ack を返す, THE Observability_Pipeline SHALL 当該 ack を Consumer から Queue への下流内部通信に限定し、Producer または StoreTimerDO へ返さない

### Requirement 5: 相関、重複許容、データ品質

**User Story:** 分析担当者として、best-effort telemetry の限界を数値で把握した上で分析したい。そうすれば不完全な期間を完全な履歴として誤認しない。

#### Acceptance Criteria

1. WHEN Data_Platform が Operation_Record の一次相関候補を作る, THE Data_Platform SHALL Store_Id、Timer_Id、Operation_Kind、および Event_Time を使用する
2. WHEN Data_Platform が一次相関候補を検証する, THE Data_Platform SHALL Operation_Record に含まれる既存 Timer事実との整合を検証条件にする
3. WHERE 一次相関候補の判定に追加情報が必要である, WHEN Data_Platform が Operation_Record を処理する, THE Data_Platform SHALL Canonical_JSON_Line の hash または Cloudflare trace metadata を観測側の補助情報として使用する
4. THE Data_Platform SHALL hash および Cloudflare trace metadata を Operation_Record 本体の identity、Record_Seq、または Timer_System の永続 identity として扱わない
5. WHEN 同一と判定可能な Operation_Record が二件以上到達する, THE Data_Platform SHALL 到達総数と到達総数から一を引いた重複数を保持し、分析用の一件へ収束させる
6. IF 復元可能な lifecycle 内の期待記録不在、開始記録と相関できない記録、または同一事実について両立しない既知属性値が検出される, THEN THE Data_Platform SHALL 当該状態をそれぞれ欠落、孤児、競合として区別して保持する
7. WHEN Data_Platform が欠落、孤児、競合、または重複を検出する, THE Data_Platform SHALL 検出根拠となった収集済み Operation_Record を削除しない
8. WHEN Snowflake が生産能力指標を算出する, THE Snowflake SHALL 対象 Store_Id、対象期間、および Observed_Telemetry に基づく best-effort 推定である表示を分析値に付ける
9. WHEN Data_Platform が lifecycle 内欠落率を算出する, THE Data_Platform SHALL 観測済み Operation_Record の Operation_Kind と内包 Timer事実から存在を復元できる期待 lifecycle 記録数を分母とし、そのうち対応する Operation_Record が存在しない記録数を分子にする
10. WHEN Data_Platform が重複率を算出する, THE Data_Platform SHALL Operation_Record の到達総数を分母とし、分析用一件へ収束した後の重複到達数を分子にする
11. WHEN Data_Platform が孤児率を算出する, THE Data_Platform SHALL 重複除外後の Operation_Record 数を分母とし、観測済み boil-started または復元可能な開始事実へ相関できない Operation_Record 数を分子にする
12. WHEN Data_Platform が競合率を算出する, THE Data_Platform SHALL 一次相関候補の総数を分母とし、両立しない既知属性値を持つ一次相関候補数を分子にする
13. IF 品質率の分母が 0 件である, THEN THE Data_Platform SHALL 当該品質率を算出不能として保持する
14. WHEN Data_Platform が console log 自体の完全な未観測率を表示する, THE Data_Platform SHALL Producer telemetry 総数を観測できないため測定不能であることを lifecycle 内欠落率と分けて表示する
15. IF 店舗または期間の品質率が Data_Quality_Threshold を超過するか算出不能である, THEN THE Data_Platform SHALL 当該店舗または期間を信頼済み分析から除外し、対象品質率と除外理由を表示する

### Requirement 6: 到達 SLO、保持、機密性

**User Story:** 運用者として、観測できた telemetry の到達品質、保持期間、アクセス範囲を管理したい。そうすれば Timer 本体の保証と混同せずに分析基盤を運用できる。

#### Acceptance Criteria

1. WHEN Operation_Record が初めて Observed_Telemetry になる, THE Data_Platform SHALL 初回観測時刻を当該 Operation_Record の初回 Snowflake 到達時刻と関連付ける
2. WHEN Data_Platform が UTC 暦月の到達 SLO を算出する, THE Data_Platform SHALL 当該月に初回観測された重複除外後の Observed_Telemetry 数を母集団とし、初回観測時刻から 15 分以内に初回 Snowflake 到達した件数の比率を算出する
3. WHERE UTC 暦月の到達 SLO の母集団が一件以上である, WHEN 到達 SLO を判定する, THE Data_Platform SHALL 15 分以内到達率を 99% 以上にする
4. IF UTC 暦月の到達 SLO の母集団が 0 件である, THEN THE Data_Platform SHALL 到達率を算出せず、当該月を SLO 判定対象外として表示する
5. WHEN Snowflake 未到達の Observed_Telemetry の最古経過時間が 30 分未満から 30 分以上 60 分未満へ遷移する, THE Data_Platform SHALL 遷移から 5 分以内に Store_Id、Timer_Id、Operation_Kind、および Event_Time を含む警告を当該連続状態につき一回発する
6. WHEN Snowflake 未到達の Observed_Telemetry の最古経過時間が 60 分未満から 60 分以上へ遷移する, THE Data_Platform SHALL 遷移から 5 分以内に Store_Id、Timer_Id、Operation_Kind、および Event_Time を含む重大通知を当該連続状態につき一回発する
7. WHEN Operation_Record の R2 保存成功時刻から 90 日が経過する, THE Data_Platform SHALL 対応する R2 オブジェクトの保持期限削除を開始し、24 時間以内に削除を完了する
8. WHEN Operation_Record の初回 Snowflake 到達月を第1月とする 25 UTC 暦月が終了する, THE Data_Platform SHALL 対応する Snowflake 記録の保持期限削除を開始し、24 時間以内に削除を完了する
9. WHILE R2 の 90 日保持期限または Snowflake の 25 UTC 暦月保持期限に達していない, THE Data_Platform SHALL 保持期限を理由とする対応記録の削除件数を 0 件にする
10. THE Operation_Record SHALL 個人情報ではない機密業務データとして分類される
11. WHEN Snowflake の Operation_Record、品質指標、または分析結果へのアクセスが要求される, THE Data_Platform SHALL 承認済み分析担当者だけにアクセスを許可する
12. IF 承認済み分析担当者ではない主体がアクセスを要求する, THEN THE Data_Platform SHALL アクセスを拒否し、Operation_Record、品質指標、分析結果、およびアクセス承認状態を変更しない
13. WHEN Data_Platform が UTC 暦月の到達 SLO を表示する, THE Data_Platform SHALL 母集団数、15 分以内到達数、到達率または算出対象外、および到達 SLO が Timer 操作の成功を保証しない旨を併記する