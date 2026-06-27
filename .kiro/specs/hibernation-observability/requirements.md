# Requirements Document

## Introduction

本 spec は、既存パイロット `yude-men-timer`（Cloudflare Durable Objects）の `StoreTimerDO` が持つ **WebSocket Hibernation** が、実環境で設計どおりに振る舞うことを「観測して確かめる」ための**観測ハーネス**を新規に定義する。

ローカル（miniflare）では hibernate の発生が非決定的であるため、本ハーネスは本番（実 Cloudflare）へデプロイした `StoreTimerDO` に対して、外部の CLI 観測クライアントから WebSocket で接続し、宣言的なシナリオに沿って操作を行い、**クライアント側の操作ログ**と**サーバ側の計装ログ**を時系列に突き合わせることで、次の二点を観測する。

1. クライアント無操作の区間でも、Alarm 発火 → broadcast によって `done` がクライアントへ届くこと（hibernate 中でもタイマーが発火する）。
2. アイドル後の最初のイベントで、新しい instanceId（= constructor 再実行）に続く rehydrate の復元件数が、その直前の残存タイマー数と一致すること（メモリ揮発から storage 復元が正しく行われる）。

本ハーネスは「挙動検証のための道具」であって製品機能ではない。`StoreTimerDO` の core（純粋関数）には一切手を入れず、計装は **shell 層と CLI 側のみ**に閉じる。SSOT 規律（Persist 先頭・`put` 成功が確定の起点）と hibernation 規律（「待つなら寝かせる」＝計装でも `setInterval` / 終わらない `setTimeout` を持ち込まない）を崩さない。

### 観測の決定性に関する前提（正直な限界）

Cloudflare の hibernation 移行タイミングはランタイムの判断であり、外部から強制できない（公式上、hibernate 可能条件を満たした状態で約10秒の無イベントを目安に移行しうるが保証はない。実務上は 15〜30 秒のアイドルで安定して発生する経験則がある）。したがって本ハーネスは hibernation の**発生を保証できず**、観測は「発生した hibernation を捉える」ことに限定される。hibernation が観測されなかった実行は**失敗ではなく「未観測（inconclusive）」**として扱う。この限界を要件全体の前提とする。

### スコープ外

- 認証・認可の作り込み（WebSocket エンドポイントは無認証パイロット前提）
- マルチテナント
- 本番運用の恒久的なログ基盤・ログ収集パイプライン

## Glossary

> 注: 以下の **System_Name** は概念境界を表す暫定名である。公開シンボル（CLI コマンド名・ログイベント型名・型名）の確定は命名規律に従い設計／実装前のユーザー確認に委ねる（本書末尾「制約と前提」参照）。本要件では概念の輪郭のみを定義する。

- **Observability_Harness**: 本 spec が定義する観測ハーネス全体。Probe_Client / Scenario_Runner / Shell_Instrumentation / Correlator / Deploy_Procedure の総称。
- **Probe_Client**: Node 上で動作し、`wss://` で `StoreTimerDO` の `/ws` に接続して `start` / `cancel` を送信し、受信メッセージを構造化ログに記録する CLI 観測クライアント（暫定名）。
- **Scenario_Runner**: 宣言的なシナリオ（相対時刻と操作の列）を解釈し、Probe_Client を駆動して順に実行する実行器（暫定名）。
- **Shell_Instrumentation**: `StoreTimerDO` の shell 層（`src/shell/`）の継ぎ目（constructor / ensureLoaded によるrehydrate / alarm / broadcast）に追加する構造化ログ計装（暫定名）。
- **Correlator**: Probe_Client の操作ログとサーバの計装ログを共通時刻軸で突き合わせ、検証条件を判定する突き合わせ器（暫定名）。
- **Deploy_Procedure**: 本番 Cloudflare へデプロイし、ライブログ（`wrangler tail` 等）を観測するための手順（暫定名）。
- **Operation_Log**: Probe_Client が出力する、送受信イベントを 1 行 1 オブジェクトで表す JSON Lines 形式の構造化ログ。
- **Instrumentation_Log**: Shell_Instrumentation が `console.log` 経由で出力し、`wrangler tail` / Workers Logs で観測されるサーバ側の構造化ログ。
- **instanceId**: constructor が実行されるたびに採番される、DO インスタンス（in-memory 生存期間）を一意に識別する値。cold start・再デプロイ・hibernation wake による再 construct を区別するための観測キー。
- **rehydrate**: hibernate 復帰または cold start 後、`ensureLoaded` が storage から `TimerState` を再構築する処理。設計の `ensureLoaded` / `fromSnapshot` に対応する。
- **hibernation wake**: WebSocket 接続が維持されたまま hibernate から復帰し、イベント配送前に constructor が再実行される事象。
- **idle interval**: シナリオ中の、Probe_Client がコマンドを一切送信しない待機区間。hibernation の発生を誘発するために設ける。
- **debug flag**: Shell_Instrumentation の出力可否を制御するフラグ。既定の本番挙動にログを漏らさないための切り替え。
- **round-trip**: あるlog entryを直列化し、再度解析して得たオブジェクトが元と等価になる性質。

## Requirements

### Requirement 1: CLI 観測クライアントの接続とコマンド送信

**User Story:** As a パイロット検証者, I want CLI から実本番の StoreTimerDO へ WebSocket 接続して start/cancel を送れること, so that 実環境の hibernation 挙動を外部から駆動して観測できる。

#### Acceptance Criteria

1. IF 起動引数で与えられたエンドポイントが `wss://` スキームでないか、または店舗識別子が空である, THEN THE Probe_Client SHALL WebSocket 接続を試行せず、当該引数不正を Operation_Log に記録し、非ゼロの終了コードで終了する。
2. WHEN Probe_Client が `wss://` スキームの有効なエンドポイントと空でない店舗識別子を与えられて起動されると, THE Probe_Client SHALL 当該エンドポイントの `/ws` パスへ WebSocket 接続を確立する。
3. IF WebSocket 接続が確立試行の開始から 10,000 ミリ秒以内に確立されないか、または確立が失敗したら, THEN THE Probe_Client SHALL 失敗の理由を Operation_Log に記録し、非ゼロの終了コードで終了する。
4. WHILE WebSocket 接続が確立されている間, WHEN シナリオが `start` 操作を指示すると, THE Probe_Client SHALL `slotId`・`noodleType`・`boilSeconds` を含む `start` メッセージを既存の ClientMessage 形式で送信する。
5. WHILE WebSocket 接続が確立されている間, WHEN シナリオが `cancel` 操作を指示すると, THE Probe_Client SHALL `timerId` を含む `cancel` メッセージを既存の ClientMessage 形式で送信する。
6. IF メッセージの送信が失敗したら, THEN THE Probe_Client SHALL 失敗の理由と対象メッセージ種別を Operation_Log に記録し、非ゼロの終了コードで終了する。
7. WHILE WebSocket 接続が確立されている間, THE Probe_Client SHALL サーバから受信した全メッセージを、受信順序を保持し本文を改変せずに Operation_Log へ記録する。

### Requirement 2: 操作ログの構造化記録

**User Story:** As a パイロット検証者, I want 送受信を timestamp 付きの構造化ログに残せること, so that 後でサーバログと時系列照合できる。

#### Acceptance Criteria

1. WHEN Probe_Client がメッセージを送信すると, THE Probe_Client SHALL 送信時刻（エポックミリ秒は 0 以上の整数として、ISO 8601 文字列は UTC・末尾 `Z`・ミリ秒精度として）・方向（送信）・メッセージ種別・ペイロードを 1 行の JSON オブジェクトとして Operation_Log に記録する。
2. WHEN Probe_Client がサーバメッセージ（`snapshot` / `started` / `cancelled` / `done` / `error` のいずれか）を受信すると, THE Probe_Client SHALL 受信時刻（エポックミリ秒は 0 以上の整数として、ISO 8601 文字列は UTC・末尾 `Z`・ミリ秒精度として）・方向（受信）・メッセージ種別・ペイロードを 1 行の JSON オブジェクトとして Operation_Log に記録する。
3. WHEN Probe_Client が Operation_Log に行を記録すると, THE Probe_Client SHALL その行に、起動時の初期値 0 から記録ごとに 1 ずつ単調増加し、欠番および重複を含まないシーケンス番号を付与する。
4. THE Probe_Client SHALL Operation_Log を、各行を改行（`\n`）で区切り、1 行に 1 個の JSON オブジェクトを格納し、各記録行自体には改行を含まない JSON Lines 形式で出力する。
5. WHEN Correlator が JSON Lines 形式の Operation_Log を入力として受け取ると, THE Correlator SHALL 各行を log entry オブジェクトへ解析し、入力の行順序を保持した log entry の列を生成する。
6. IF 解析対象の行が JSON として不正であるか、または必須属性（時刻・方向・メッセージ種別・ペイロード・シーケンス番号）のいずれかを欠く場合, THEN THE Correlator SHALL 当該行を結果の列から除外し、当該行を解析失敗として判別可能にし、かつ既に解析済みの log entry を保持する。
7. FOR ALL 有効な log entry, THE Observability_Harness SHALL 直列化してから解析した結果の全属性の値が元の log entry の全属性の値と一致すること（round-trip 性質）を満たす。

### Requirement 3: シナリオ駆動実行

**User Story:** As a パイロット検証者, I want 宣言的な手順で操作とアイドルを記述して再現実行できること, so that hibernation 誘発を含む観測を反復可能にできる。

#### Acceptance Criteria

1. THE Scenario_Runner SHALL 相対時刻（起動からの経過、0〜3,600,000ms の整数ミリ秒）と操作（`start` / `cancel` / `wait` / `await-done`）の列からなり、ステップ数が 1〜100 の範囲にある宣言的シナリオを受け取り、相対時刻の昇順に実行する。相対時刻が等しい複数ステップは、シナリオ内の記述順に実行する。
2. WHEN あるシナリオステップの相対時刻に達すると, THE Scenario_Runner SHALL 当該ステップの操作を、その相対時刻から 250ms 以内に開始する。
3. WHERE シナリオが idle interval（`wait`、待機時間 0〜600,000ms の整数ミリ秒）を含む, THE Scenario_Runner SHALL その区間中コマンドを送信せず、受信メッセージの Operation_Log への記録のみを継続する。
4. WHEN `await-done` ステップが指定された `timerId` と上限待機時間（1,000〜600,000ms の整数ミリ秒）とともに与えられると, THE Scenario_Runner SHALL 当該 `timerId` の `done` 受信、または上限待機時間の到達のいずれかまで待機し、待機中に受信した全メッセージ（指定 `timerId` と一致しない `done` を含む）を Operation_Log に記録する。
5. IF `await-done` の待機中に指定 `timerId` と一致しない `done` を受信したなら, THEN THE Scenario_Runner SHALL 当該メッセージを Operation_Log に記録した上で待機を継続し、待機を終了しない。
6. IF `await-done` が上限待機時間に達しても指定 `timerId` の `done` を受信しないなら, THEN THE Scenario_Runner SHALL タイムアウトを示す記録を Operation_Log に追記し、これまでに記録した Operation_Log を保持したまま、当該シナリオの実行を非ゼロ終了コードで終了する。
7. IF いずれかのステップの操作実行時点で WebSocket 接続が確立されていないなら, THEN THE Scenario_Runner SHALL 接続未確立を示す記録を Operation_Log に追記し、これまでに記録した Operation_Log を保持したまま、当該シナリオの実行を非ゼロ終了コードで終了する。
8. WHEN シナリオの全ステップが完了すると, THE Scenario_Runner SHALL WebSocket 接続を閉じ、Operation_Log を確定し、ゼロ終了コードで終了する。

### Requirement 4: DO shell 層の計装

**User Story:** As a パイロット検証者, I want shell の継ぎ目に instanceId 付きの構造化ログを仕込めること, so that メモリ揮発と storage 復元をサーバ側から観測できる。

#### Acceptance Criteria

1. WHERE debug flag が有効である, WHEN `StoreTimerDO` の constructor が実行されると, THE Shell_Instrumentation SHALL 継ぎ目種別 `construct` と現在の instanceId を含む Instrumentation_Log を 1 件出力する。
2. WHERE debug flag が有効である, WHEN `ensureLoaded` が storage から `TimerState` を復元すると, THE Shell_Instrumentation SHALL 継ぎ目種別 `rehydrate`・復元した Timer 件数（0 以上の整数）・現在の instanceId を含む Instrumentation_Log を 1 件出力する。
3. WHERE debug flag が有効である, WHEN `alarm` ハンドラが実行されると, THE Shell_Instrumentation SHALL 継ぎ目種別 `alarm` と現在の instanceId を含む Instrumentation_Log を 1 件出力する。
4. WHERE debug flag が有効である, WHEN broadcast（接続中の全 WS への送信）が実行されると, THE Shell_Instrumentation SHALL 継ぎ目種別 `broadcast`・送信した ServerMessage の種別・現在の instanceId を含む Instrumentation_Log を、broadcast 操作ごとに 1 件出力する。
5. THE Shell_Instrumentation SHALL 計装を `src/shell/` の層に限定し、`src/core/` の純粋関数を変更しない。
6. THE Shell_Instrumentation SHALL 各 Instrumentation_Log のフィールドを、継ぎ目で既に得られている値からのみ導出し、Working_Copy と永続スナップショットおよび Effect 実行順序（Persist 先頭）を不変に保つ。
7. THE Shell_Instrumentation SHALL タイマー管理に `setInterval` および終了しない `setTimeout` を導入せず、`ctx.acceptWebSocket` を用いた hibernate 可能な構成を維持する。
8. THE Shell_Instrumentation SHALL instanceId を、対象 DO インスタンスの存続期間中は不変とし、constructor 実行ごとに以前出力した instanceId と区別可能な値として採番する。
9. WHERE debug flag が有効である, THE Shell_Instrumentation SHALL Instrumentation_Log の出力を上記 4 つの継ぎ目（`construct` / `rehydrate` / `alarm` / `broadcast`）に限定し、それ以外の箇所から Instrumentation_Log を出力しない。
10. WHERE debug flag が無効である, THE Shell_Instrumentation SHALL 上記 4 つの継ぎ目のいずれからも Instrumentation_Log を出力しない。

### Requirement 5: instanceId による再 construct の区別

**User Story:** As a パイロット検証者, I want hibernation wake と cold start / 再デプロイを区別できること, so that 観測した再 construct が本当に hibernate 由来かを判定できる。

#### Acceptance Criteria

1. WHEN `StoreTimerDO` の constructor が実行されると, THE Shell_Instrumentation SHALL 対象 DO インスタンスの全 construct を通じて重複しない一意な instanceId を採番し、その採番時刻を記録する。
2. WHEN 新しい instanceId の出現区間（当該 instanceId の採番時刻から次の instanceId の採番時刻まで、次が無ければ観測終了時刻まで）において、Operation_Log に Probe_Client の再接続イベントが 0 件である, THE Correlator SHALL 当該再 construct を hibernation wake として分類する。
3. WHEN 新しい instanceId の出現区間において、Operation_Log に Probe_Client の再接続イベントが 1 件以上記録される, THE Correlator SHALL 当該再 construct を cold start または再デプロイとして分類する。
4. THE Correlator SHALL 各 instanceId の出現区間を、Instrumentation_Log の採番時刻に基づき時系列に並べて出力し、採番時刻が同一の場合は採番順の昇順で安定整列する。
5. IF ある出現区間において対応する Operation_Log が欠落し分類に必要な情報が得られないなら, THEN THE Correlator SHALL 当該区間を「分類不能」として標識し、他の区間の分類処理を継続する。
6. IF ある construct に先行する instanceId が存在しない（観測上の初回 construct である）なら, THEN THE Correlator SHALL 当該 construct を初回構築の独立カテゴリとして扱い、hibernation wake にも cold start／再デプロイにも分類しない。

### Requirement 6: 操作ログとサーバログの突き合わせと検証条件

**User Story:** As a パイロット検証者, I want 二つのログを時系列照合して合否を判定できること, so that hibernation 挙動の検証結果を再現可能な形で得られる。

#### Acceptance Criteria

1. THE Correlator SHALL Operation_Log と Instrumentation_Log を、エポックミリ秒の共通時刻軸で時系列に整列した単一の系列へ統合し、同一エポックミリ秒の行は元の出現順を保持する安定整列とし、同一入力に対して常に同一の系列を生成する。
2. WHEN Probe_Client の idle interval（`start`・`cancel` いずれも発行しない連続区間）の中で、`alarm` の Instrumentation_Log のエポックミリ秒が当該タイマーの `done`（Operation_Log）のエポックミリ秒以下となる順序で記録される, THE Correlator SHALL これを「クライアント無操作区間で Alarm がタイマーを発火させた」観測として、対象タイマーを特定可能な形で合格に記録する（検証条件 a）。
3. IF idle interval の中で当該タイマーの `done` が Operation_Log に記録されるが、対応する `alarm` の Instrumentation_Log が存在しないか、または `alarm` のエポックミリ秒が `done` のエポックミリ秒より後である（順序逆転）なら, THEN THE Correlator SHALL 当該観測を、両ケースを識別可能な形で検証失敗として記録する。
4. WHEN idle interval 後の最初のイベントにおいて、新しい instanceId の `construct` に続く（同一 instanceId・エポックミリ秒昇順の）`rehydrate` の復元件数が、当該イベント直前に active（`start` 済みかつ `done`／`cancel` 未到達）であったタイマー数と一致する, THE Correlator SHALL これを「メモリ揮発から storage 復元が正しく行われた」観測として合格に記録する（検証条件 b）。
5. IF `rehydrate` の復元件数が当該イベント直前に active であったタイマー数と一致しないなら, THEN THE Correlator SHALL 当該観測を、期待件数（直前 active 数）と観測件数（復元件数）を識別可能な形で検証失敗として記録する。
6. THE Correlator SHALL 整列した系列の長さが、入力した Operation_Log と Instrumentation_Log の行数の合計と等しいことを保ち、いずれの入力行も欠落・重複させず、片方または両方が 0 行の入力に対しても当該保存性を満たす。

### Requirement 7: 観測の決定性の限界の取り扱い

**User Story:** As a パイロット検証者, I want hibernation を強制できない事実を結果に正直に反映できること, so that 未発生の実行を誤って失敗と判定しない。

#### Acceptance Criteria

1. THE Observability_Harness SHALL hibernation の発生を制御する手段を提供せず、かつ hibernation が発生しなかったことを理由に検証実行を中断したり fail として判定したりしない。
2. THE Scenario_Runner SHALL idle interval の長さを 1 秒以上 3600 秒以下の整数秒値の設定可能パラメータとして受け取る。
3. IF idle interval パラメータが 1 秒未満、3600 秒超、または整数秒でない値である, THEN THE Scenario_Runner SHALL 当該パラメータを拒否し、許容範囲（1〜3600 秒の整数秒）を示すエラーを返し、シナリオ実行を開始せず、既存の設定値を変更しない。
4. WHEN シナリオ実行後、idle interval の経過時点からさらに最大 60 秒を加えた観測ウィンドウの満了時点において、新しい instanceId と `rehydrate` の組（hibernation wake の signal）が Instrumentation_Log に観測されない, THE Correlator SHALL 当該実行の結果を「hibernation 未観測（inconclusive）」として記録する。
5. WHEN 観測ウィンドウの満了時点までに、新しい instanceId と `rehydrate` の組（hibernation wake の signal）が Instrumentation_Log に観測される, THE Correlator SHALL 当該実行の結果を「hibernation 観測（confirmed）」として記録する。
6. THE Correlator SHALL 「inconclusive」「confirmed」「fail」を相互に独立した区分として出力し、「inconclusive」を「fail」の集計に含めない。

### Requirement 8: 本番デプロイと観測の手順

**User Story:** As a パイロット検証者, I want 本番へ出してライブログを見る手順が整っていること, so that 実 hibernation を発生させて観測できる。

#### Acceptance Criteria

1. THE Deploy_Procedure SHALL `wrangler deploy` により本番 Cloudflare へ Worker と `StoreTimerDO` をデプロイし、Worker のデプロイ成功と `StoreTimerDO` バインディングの公開を確認する手順を提供する。
2. THE Deploy_Procedure SHALL `wrangler tail`（またはこれに相当する Workers Logs 参照）で Instrumentation_Log をライブ観測し、`construct` / `rehydrate` / `alarm` / `broadcast` の各イベントログがライブ観測出力に現れることを確認する手順を含む。
3. WHEN 観測を開始すると, THE Deploy_Procedure SHALL debug flag を本番で有効化する手順を提供する。
4. WHEN 観測を完了すると, THE Deploy_Procedure SHALL debug flag を無効化（既定状態）へ戻し、戻した後に Instrumentation_Log が出力されないことを確認する手順を提供する。
5. WHERE WebSocket エンドポイントが無認証で公開される, THE Deploy_Procedure SHALL 第三者が `wss://` に接続して `start`／`cancel` を送信し得ること、およびこれがパイロット前提で許容されアクセス制御の追加はスコープ外であることをリスクとして明記する。

### Requirement 9: ツールと規律の準拠

**User Story:** As a 保守者, I want ハーネスがプロジェクトの確定スタックと規律に従うこと, so that 既存コードベースと一貫し、core の純粋性を損なわない。

#### Acceptance Criteria

1. THE Probe_Client SHALL pnpm で依存管理され、TypeScript の strict モードで実装され、`tsc --noEmit` による型検査をエラー 0 件で通過する。
2. THE Probe_Client SHALL oxlint による静的解析を、エラー 0 件かつ警告 0 件で通過する。
3. THE Probe_Client SHALL fast-check を用いた property-based test を含む Vitest 検証スイートを、失敗テスト 0 件で通過する。
4. THE Probe_Client SHALL 全てのユーザー向け出力（CLI のコマンドメッセージ・ヘルプ表示・エラー表示）を英語のみで提示し、日本語を含めない。
5. THE Observability_Harness SHALL `src/core/` 配下の既存ファイルを追加・変更・削除せず、計装の追加を `src/shell/` 配下と CLI 側のファイルに限定する。
6. THE Observability_Harness SHALL `src/shared/messages.ts` に定義された既存の ClientMessage / ServerMessage のワイヤ形式のみに従ってメッセージを送受信し、新たなメッセージ種別やフィールドを導入しない。

## 制約と前提（Constraints and Assumptions）

- **設計哲学の不変点**: core/shell 分離を壊さない。計装は shell と CLI 側のみ。SSOT 規律（Persist 先頭・`put` 成功が確定の起点）を崩さない。「待つなら寝かせる」＝計装でも `setInterval` / 終わらない `setTimeout` を持ち込まない。
- **命名規律**: 公開シンボル（CLI コマンド名・Instrumentation_Log のイベント型名 `construct` / `rehydrate` / `alarm` / `broadcast` 等・型名）は概念境界の表明であり、実装前にユーザー確認を要する。本要件中の System_Name・イベント名は暫定であり、設計フェーズで候補・概念境界・ドメイン語彙との対応を提示して確認を得る。
- **ツール**: pnpm / TypeScript(strict) / Wrangler v4 / Vitest + fast-check / oxlint。npm / yarn / npx は使わない。
- **言語**: フロント／CLI のユーザー向けコンテンツは英語、コードコメントは日本語、Kiro 出力は日本語。
- **観測の前提**: hibernation 移行は Cloudflare ランタイムの判断であり強制不可。idle interval は実務上 15〜30 秒で安定発生する経験則に基づくが保証ではない。
- **スコープ外**: 認証認可の作り込み、マルチテナント、本番運用の恒久ログ基盤。本ハーネスはパイロットの挙動検証用に限る。
