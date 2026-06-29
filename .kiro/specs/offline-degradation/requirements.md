# Requirements Document

## Introduction

本 spec は、既存パイロット `yude-men-timer`（Cloudflare Durable Objects）の **iPad_Client（React フロント）** に、サーバへの回線が落ちたときの **クライアント側の優雅な劣化（offline degradation）** を新規に定義する。狙いは「厨房スタッフへの善」——瞬断や回線喪失で表示が死なず、現場の速度を奪わないこと、とりわけ茹で上がりの取りこぼしを防ぐことにある。

本パイロットの正本（SSOT）は Store_Timer_DO（サーバ）であり、この前提は変えない。本 spec が加えるのは、サーバへ到達できない区間に限り iPad_Client が自身の担当スロットに対する**一時的なローカル権限（temporary local authority）**として振る舞い、回線復帰後はサーバの全量スナップショットへ追随し直す、という劣化運用である。

土台として PWA（Progressive Web App）を導入する。Service Worker が App Shell をキャッシュしてアプリがオフラインでも起動でき、状態の永続化と起動時の再水和（rehydrate）により、オフライン中のリロード／再起動後も走行中タイマーが復元される。対象デバイスは iPad Safari / standalone PWA であり、iOS の制約（Background Sync 不可・`beforeunload` 不可信）を前提に設計する。

### スコープ

本 spec のスコープは「劣化運用（degraded operation）」と「最善努力での再参加（best-effort rejoin）」に限る。

### スコープ外

- **再整合（reconciliation）／DO への耐久的な書き戻し（durable write-back）**：オフライン中に発生したローカル操作（start / cancel）を回線復帰時に Store_Timer_DO へ反映して正本へ確定させる処理は、本 spec のスコープ外とし、**将来フェーズ**に委ねる。本 spec のローカル操作は耐久化されず、最善努力にとどまる。
- **クロスデバイスのダブルブッキング防止**：オフライン中は共有された真実が存在しないため、別デバイスとの二重起動はオフラインでは防止不能であり、受容される限界とする（本 spec で新たなサーバ側ルールを追加しない）。
- **サーバ core（`src/engine/`）の変更**：本 spec は core を一切変更しない。
- 認証認可の作り込み、マルチテナント。

## Glossary

> 注: 以下の **System_Name**・イベント名・状態名・公開シンボル相当の語は、命名規律（`naming.md`）に従う **概念境界の暫定表明**である。クライアント純粋遷移関数名・モード名（live / degraded）・Connectivity / Reconcile 等のイベント名・Sync_Mediator / Persistence_Port のシンボル名・auto-response の ping/pong 文字列・localStorage キーといった公開シンボルは、実装前にユーザー確認を要する。本書末尾「制約と前提」に暫定一覧を掲げる。ドメイン語彙はサーバ側（decide / reconcile / Snapshot / Effect）を踏襲することを優先する。

- **Store_Timer_DO**: サーバ側の正本（SSOT）。タイマー状態を保持し、WebSocket（`/ws`）で iPad_Client と接続する。本 spec では shell 層（`src/shell/`）への最小追加（auto-response 設定）のみを受ける。
- **iPad_Client**: 厨房 iPad 上の React フロント（`src/client/`）。本 spec の主たる変更対象。standalone PWA として動作する。
- **Connectivity**: iPad_Client から Store_Timer_DO への到達可能性の事実。`up`（到達可）/ `down`（到達不可）の二値で表す。回線状態の検出結果であり、表示の導出元。
- **Mode**: iPad_Client の運用モード。`live`（サーバ追随）と `degraded`（ローカル権限）の二値。**Connectivity から導出される値**であり、独立した状態として保持しない。
- **Client_Decide**（暫定名）: iPad_Client の純粋状態遷移関数。タグ付きイベント列（ServerMessage / LocalCommand / Connectivity / LocalDone / Tick / Reconcile）を現在ビューへ畳み込む単一の決定的関数。サーバの `decide` を母語として踏襲する。
- **LocalCommand**: ユーザー由来のローカル操作イベント。`start` / `cancel` を含む。
- **LocalDone**: degraded 中に endTime を過ぎた Timer の、ローカルでの茹で上がり発火イベント。
- **Tick**: 残り秒の再導出を促す描画契機。ビューを変えない（既存実装の思想を踏襲）。
- **Reconcile**: 回線復帰後にサーバ全量スナップショットへ追随し直す再水和イベント。
- **Connectivity_Watch**（暫定名）: Connectivity を検出する作用の端（effect edge）。同一 WebSocket 上の auto-response ping/pong と、ソースの close / error を観測して Connectivity を導く。タイマー秒読みのための常駐ループを持たない。
- **Sync_Mediator**（暫定名）: UI が唯一対話する窓口。UI のインテント（start / cancel / 購読）を現在の Mode に応じて経路選択し、トランスポート（WS / DO）をポートの背後に隠す。
- **Persistence_Port**（暫定名）: 状態の永続化と読み出しの抽象境界。既定の裏側実装は localStorage。
- **Provisional_Timer**: degraded 中のローカル start で生成される、クライアント生成 id と クライアント算出 endTime を持つ**未確定（unconfirmed）**な Timer。起源タグ（origin tag）で server-confirmed Timer と区別され、正本の競合源にはならない。
- **server-confirmed Timer**: Store_Timer_DO の snapshot / started に由来する、正本に裏打ちされた Timer。
- **クロックオフセット**: 接続中に確立した serverTime とローカル時刻の差分。degraded 中も保持した最新値を使い続ける（既存仕様 5.2 / 10.3 を踏襲）。
- **補正後の現在時刻**: ローカル時刻 + クロックオフセット。degraded 中の endTime 比較に用いる。
- **processedIds**: 茹で上がり / キャンセルを処理済みとして記録する timerId 集合（表示制御用・SSOT のコピーではない）。LocalDone と後続のサーバ done の冪等性を担う既存機構（`src/client/notification.ts`）。
- **App_Shell**: アプリの起動に必要な静的アセット一式（HTML / JS / CSS）。Service Worker がキャッシュする。
- **Service_Worker**: App_Shell をキャッシュし、オフライン起動を成立させる PWA の基盤。
- **standalone 表示モード**: PWA をブラウザ UI なしの全画面で表示する display mode。リロードボタンの非表示・プルリフレッシュの抑止に用いる。

## Requirements

### 要件 1: 同一 WebSocket 上の到達性検出（auto-response ping/pong）

**ユーザーストーリー:** 厨房スタッフとして、回線が静かに半死（half-open）になっても、サーバに届かなくなった事実を iPad が速やかに察知してほしい。これにより劣化運用へ切り替えられる。

#### 受け入れ基準

1. WHEN Store_Timer_DO が WebSocket 接続を収容するとき、THE Store_Timer_DO SHALL `state.setWebSocketAutoResponse` により、所定の ping 要求文字列に対して所定の pong 応答文字列を自動返信する設定を行う。
2. WHILE WebSocket 接続が確立されているとき、THE iPad_Client SHALL 所定の ping 要求文字列を 15000 ミリ秒以下の間隔で当該 WebSocket へ送信する。
3. WHEN iPad_Client が所定の pong 応答文字列を受信したとき、THE iPad_Client SHALL Connectivity を `up` として確定する。
4. IF iPad_Client が ping 要求の送信後 2000 ミリ秒以内に対応する pong 応答を受信しないことが 2 回連続したとき、THEN THE iPad_Client SHALL Connectivity を `down`（half-open による静かな喪失）として確定する。down 確定までの目安は `送信間隔 × 2 + 待ち時間 ≈ 10 秒`（単発のパケット欠落で誤検知しないよう 2 回連続を要求する）。
5. THE Store_Timer_DO SHALL auto-response による ping/pong の応答を、`webSocketMessage` ハンドラの起動および hibernate からの復帰（wake）を伴わずに行う。
6. THE iPad_Client SHALL 到達性検出のために `setInterval` 等で常駐するループを設ける場合も、当該ループが Store_Timer_DO を wake させる通常メッセージを送出しないことを保ち、heartbeats を auto-response 経路のみに限定する。

### 要件 2: 二段階の接続性遷移（明示的切断と静かな喪失）

**ユーザーストーリー:** 厨房スタッフとして、ソケットが明示的に閉じた場合も、無応答で静かに死んだ場合も、どちらでも劣化運用に入ってほしい。

#### 受け入れ基準

1. WHEN iPad_Client の WebSocket が close または error を通知したとき、THE iPad_Client SHALL Connectivity を `down`（明示的切断）として確定する。
2. WHEN iPad_Client が WebSocket 接続を確立し、かつ全量スナップショットを受信したとき、THE iPad_Client SHALL Connectivity を `up` として確定する。
3. THE iPad_Client SHALL Connectivity の確定要因として、明示的切断（要件2.1）と静かな喪失（要件1.4）の二系統を独立に扱い、いずれか一方の成立で `down` を確定する。
4. WHEN Connectivity が `down` から `up` へ遷移したとき、THE iPad_Client SHALL Reconcile（要件11）を契機づける。

### 要件 3: モードの導出（live / degraded）

**ユーザーストーリー:** 開発者として、運用モードを独立した状態として持たず、接続性から一意に導出してほしい。これにより二つの真実の源を作らない。

#### 受け入れ基準

1. WHILE Connectivity が `up` であるとき、THE iPad_Client SHALL Mode を `live` として導出する。
2. WHILE Connectivity が `down` であるとき、THE iPad_Client SHALL Mode を `degraded` として導出する。
3. THE iPad_Client SHALL Mode を独立した永続状態または可変状態として保持せず、参照のたびに Connectivity から関数的に導出する。
4. WHEN Mode が変化したとき、THE iPad_Client SHALL 現在の Mode を画面上に視認可能な形で提示する。

### 要件 4: クライアント層構成と単一の純粋遷移

**ユーザーストーリー:** 保守者として、クライアントが「計算と作用の分離」に沿った層構成を持ち、UI が単一の窓口とのみ対話してほしい。これにより劣化ロジックが検証可能で差し替え可能になる。

#### 受け入れ基準

1. THE iPad_Client SHALL 状態遷移を Client_Decide という単一の純粋関数に集約し、当該関数を `(現在ビュー, タグ付きイベント) → 新しいビュー` の形に保つ。
2. THE Client_Decide SHALL タグ付きイベントとして ServerMessage・LocalCommand・Connectivity・LocalDone・Tick・Reconcile の各種別を受理し、各種別を網羅的に分岐する。
3. THE Client_Decide SHALL WebSocket・DOM・時計・乱数・localStorage のいずれにも触れず、時刻・生成 id・受信時刻を引数として受け取る純粋関数として実装される。
4. THE iPad_Client SHALL UI からのインテント（start / cancel / ビュー購読）を Sync_Mediator のみを介して受け、トランスポート（WebSocket / Store_Timer_DO）を Sync_Mediator の背後のポートに隠蔽する。
5. THE Sync_Mediator SHALL UI インテントを現在の Mode に応じて経路選択し、`live` ではサーバ送信経路へ、`degraded` ではローカル権限経路（要件6〜8）へ振り分ける。
6. THE Connectivity_Watch SHALL Connectivity の検出という作用のみを担い、ビューの決定を Client_Decide に委ねる。
7. THE iPad_Client SHALL 状態の永続化・読み出しを Persistence_Port を介してのみ行い、既定の裏側実装を localStorage とする。

### 要件 5: degraded 中のカウントダウン表示継続

**ユーザーストーリー:** 厨房スタッフとして、回線が落ちている間も全タイマーのカウントダウンが止まらないでほしい。

#### 受け入れ基準

1. WHILE Mode が `degraded` であるとき、THE iPad_Client SHALL 各 Timer の残り時間を「endTime -（ローカル時刻 + クロックオフセット）」として 1000 ミリ秒以下ごとに再算出し続ける。
2. THE iPad_Client SHALL degraded 中、接続中に確立した最新のクロックオフセットを使い続け、新規 serverTime を要求しない。
3. WHEN degraded 中にある Timer の残り時間が 0 以下になったとき、THE iPad_Client SHALL 当該 Slot のカウントダウン表示を 00:00 に固定し、負の残り時間を表示しない。

### 要件 6: degraded 中のローカル start（楽観的な Provisional_Timer）

**ユーザーストーリー:** 厨房スタッフとして、回線が落ちている間でも自分の担当釜でタイマーを開始できてほしい。回線が戻るまで待たされたくない。

#### 受け入れ基準

1. WHILE Mode が `degraded` であるとき、WHEN ユーザーが担当スロットに対し start 操作（slotId・麺種・茹で時間）を行ったとき、THE iPad_Client SHALL クライアント生成の id と、endTime =「（ローカル時刻 + クロックオフセット）+ 茹で時間（1〜1800 秒の範囲内）」を持つ Provisional_Timer を生成する。
2. WHEN Provisional_Timer を生成したとき、THE iPad_Client SHALL 当該 Provisional_Timer を起源タグ（unconfirmed）付きでビューへ注入し、当該 Slot の表示を走行中へ切り替える。
3. WHILE Mode が `degraded` であるとき、THE iPad_Client SHALL Provisional_Timer を Store_Timer_DO へ送信せず、当該 Provisional_Timer を正本の競合源として扱わない。
4. THE iPad_Client SHALL Provisional_Timer を server-confirmed Timer と視覚的に区別可能な未確定表示で提示する。
5. IF degraded 中の start 操作の茹で時間が 1〜1800 秒の範囲外であるとき、THEN THE iPad_Client SHALL Provisional_Timer を生成せず、当該 Slot の表示を変更しない。

### 要件 7: degraded 中のローカル cancel

**ユーザーストーリー:** 厨房スタッフとして、回線が落ちている間でも自分の担当釜のタイマーを取り消せてほしい。

#### 受け入れ基準

1. WHILE Mode が `degraded` であるとき、WHEN ユーザーが担当スロットの Provisional_Timer に対し cancel 操作を行ったとき、THE iPad_Client SHALL 当該 Provisional_Timer をビューから除去する。
2. WHILE Mode が `degraded` であるとき、WHEN ユーザーが担当スロットの server-confirmed Timer に対し cancel 操作を行ったとき、THE iPad_Client SHALL 当該 Timer をビューから除去し、当該 timerId を processedIds に登録して当該 Timer のローカル茹で上がり発火を抑止する。
3. THE iPad_Client SHALL degraded 中の cancel 操作を Store_Timer_DO へ送信せず、当該操作を耐久的な正本変更として扱わない。

### 要件 8: degraded 中のローカル茹で上がり発火（安全要）

**ユーザーストーリー:** 厨房スタッフとして、回線が落ちている間でも、茹で上がり時刻が来たら必ずアラートが鳴ってほしい。これは麺を茹で過ぎないための最重要機能である。

#### 受け入れ基準

1. WHILE Mode が `degraded` であるとき、WHEN ある Timer（Provisional_Timer または server-confirmed Timer）の endTime が補正後の現在時刻以下になり、かつ当該 timerId が processedIds に未登録であるとき、THE iPad_Client SHALL 当該 Timer の茹で上がりアラートをローカルで 1 回発火し、当該 timerId を processedIds に登録する。
2. IF ローカル発火後に Store_Timer_DO から同一 timerId の done を受信したとき、THEN THE iPad_Client SHALL 当該 done を processedIds 機構により冪等に無視し、アラートを再発火しない。
3. THE iPad_Client SHALL ローカル茹で上がり発火を Store_Timer_DO へ依存せず、回線状態に関わらず補正後の現在時刻のみに基づいて判定する。
4. THE iPad_Client SHALL ローカル茹で上がり発火による processedIds の登録を表示制御用ローカル情報として扱い、当該登録によって Store_Timer_DO の正本を変更しない。

### 要件 9: ダブルブッキングの最善努力扱い

**ユーザーストーリー:** 厨房スタッフとして、同じ釜に二重でタイマーを掛けてしまう事故を、可能な範囲で防いでほしい。

#### 受け入れ基準

1. WHEN degraded 中のローカル start により Provisional_Timer が当該 Slot へ注入されたとき、THE iPad_Client SHALL 当該 Slot を走行中とみなし、当該 Slot に対する start 操作手段を画面上に提示しない。
2. THE iPad_Client SHALL 同一デバイス上のダブルブッキングを、走行中スロットへの start 操作手段を提示しないという既存の構造的 UI ゲートにより防止する。
3. THE システム（iPad_Client 群および Store_Timer_DO） SHALL クロスデバイスのダブルブッキングを degraded 中に防止せず、当該事象を共有された真実の不在に由来する受容される限界として扱い、本 spec で新たなサーバ側拒否ルールを追加しない。

### 要件 10: App Shell のオフライン起動と standalone 表示

**ユーザーストーリー:** 厨房スタッフとして、回線が落ちている最中に iPad のアプリを開き直しても、アプリが起動して茹で状況を見続けられてほしい。

#### 受け入れ基準

1. WHEN iPad_Client が初回オンラインで読み込まれたとき、THE Service_Worker SHALL App_Shell（アプリ起動に必要な静的アセット一式）をキャッシュへ格納する。
2. WHILE Connectivity が `down` であるとき、WHEN ユーザーがアプリをリロードまたは再起動したとき、THE iPad_Client SHALL キャッシュ済みの App_Shell から起動する。
3. THE iPad_Client SHALL standalone 表示モードで動作し、ブラウザのリロードボタンを提示せず、プルトゥリフレッシュによる再読み込みを抑止する。
4. THE iPad_Client SHALL プルトゥリフレッシュの抑止を CSS の `overscroll-behavior` により実現する。
5. THE iPad_Client SHALL リロード抑止の手段を standalone 表示モードと `overscroll-behavior` に限定し、これを超える追加の抑止層を設けず、リロードを生き延びる担保を App_Shell キャッシュ（要件10.1）と状態の永続化・再水和（要件11）に委ねる（決定 A）。

### 要件 11: 状態の永続化と起動時の再水和

**ユーザーストーリー:** 厨房スタッフとして、回線が落ちている間にアプリを開き直しても、走行中のタイマーが消えずに復元され、茹で上がりが鳴り続けてほしい。

#### 受け入れ基準

1. WHEN ビューが変化したとき（タイマーの追加・除去・offset 更新・processedIds 更新）、THE iPad_Client SHALL Persistence_Port を介して、timers・クロックオフセット・processedIds・Provisional_Timer を含む単一の JSON ブロブを保存する。
2. WHEN iPad_Client が起動したとき、THE iPad_Client SHALL Persistence_Port から保存済みの JSON ブロブをページ内で同期的に読み出し、ビューを当該ブロブの内容へ再水和する。
3. WHEN 再水和したビューに endTime が補正後の現在時刻以下の Timer が含まれ、かつ当該 timerId が processedIds に未登録であるとき、THE iPad_Client SHALL 要件8.1 に従い当該 Timer の茹で上がりアラートをローカルで発火する。
4. THE Persistence_Port SHALL 既定の裏側実装を localStorage とし、IndexedDB および Background Sync に依存しない。
5. WHEN Connectivity が `up` へ遷移し全量スナップショットを受信したとき（Reconcile）、THE iPad_Client SHALL server-confirmed Timer の集合のみを当該スナップショットで置き換え、起源タグ（unconfirmed）付きの Provisional_Timer をビューに保持する（決定 B）。
6. THE iPad_Client SHALL Reconcile 後も保持した Provisional_Timer を未確定表示で提示し続け、走行中の Provisional_Timer が回線復帰を契機に表示から消えないことを保つ（決定 B）。
7. WHEN Reconcile によるスナップショットに、degraded 中にローカル cancel した server-confirmed Timer（要件7.2 で processedIds に登録済み）が含まれるとき、THE iPad_Client SHALL 当該 timerId が processedIds に登録済みである限り、当該 Timer のローカル茹で上がりアラートを発火しない（復活キャンセルの最善努力扱い・決定 B）。

### 要件 12: 規律の不変点（core 不変・ワイヤ形式不変・hibernation 保持・SSOT 保持）

**ユーザーストーリー:** 保守者として、本 spec の変更が既存の設計規律を一切壊さないでほしい。

#### 受け入れ基準

1. THE 本機能 SHALL `src/engine/` 配下の既存ファイルを追加・変更・削除せず、変更を `src/client/` 配下と `src/shell/` への最小追加（auto-response 設定）に限定する。
2. THE 本機能 SHALL `src/domain/messages.ts` に定義された既存の ClientMessage / ServerMessage のワイヤ形式のみに従い、新たなメッセージ種別やフィールドを導入しない。
3. THE Store_Timer_DO SHALL auto-response の追加後も WebSocket Hibernation 互換を保ち、heartbeats による wake を発生させない。
4. THE iPad_Client SHALL Store_Timer_DO の全量スナップショットを正本として扱い、Provisional_Timer を起源タグ付きの未確定なローカル意図として保持し、正本の競合源にしない。
5. THE 本機能 SHALL オフライン中のローカル操作（start / cancel）の Store_Timer_DO への耐久的な書き戻し（write-back / reconciliation）を行わず、当該処理を将来フェーズのスコープ外として扱う。

### 要件 13: ツールと規律の準拠

**ユーザーストーリー:** 保守者として、本機能がプロジェクトの確定スタックと規律に従い、既存コードベースと一貫してほしい。

#### 受け入れ基準

1. THE iPad_Client SHALL pnpm で依存管理され、TypeScript の strict モードで実装され、`tsc --noEmit` による型検査をエラー 0 件で通過する。
2. THE iPad_Client SHALL oxlint による静的解析を、エラー 0 件かつ警告 0 件で通過する。
3. THE Client_Decide および純粋層 SHALL fast-check を用いた property-based test を含む Vitest 検証スイートを、失敗テスト 0 件で通過する。
4. THE 純粋層のテスト SHALL `Date.now` 等のスタブを用いず、時刻を引数として渡す方式で検証する。
5. WHERE PWA のビルドにツールを要する場合、THE 本機能 SHALL pnpm / Vite スタックと整合する vite-plugin-pwa / Workbox を用い、新たなパッケージマネージャを導入しない。
6. THE iPad_Client SHALL 全てのユーザー向け画面コンテンツを英語で提示し、コードコメントを日本語で記述する。

### 要件 14: デバッグ用フォルトインジェクション（擬似切断・dev 限定）

**ユーザーストーリー:** 開発者 / QA として、回線を物理的に切らずとも擬似的な半死（half-open）状態をオンデマンドで再現したい。これにより本物の静かな喪失（silent-loss）検知と、degraded → 再接続までのライフサイクル全体を実機で検証できる。

#### 受け入れ基準

1. WHERE デバッグフラグが有効であるとき、THE iPad_Client SHALL 既存のトランスポート注入継ぎ目（Connectivity_Watch / SocketOpener）の上に、送信される ping のみを破棄（blackhole）するフォルトインジェクションを提供し、送信 ping 以外のトラフィック（通常メッセージ・受信）を変更しない（ping-only）。
2. WHEN ping blackhole が有効化されたとき、THE iPad_Client SHALL 以後の ping を相手へ届けず、pong が返らないことによる要件1.4 の silent-loss（連続未応答）検知を通じて Connectivity を `down` へ確定し、Mode を直接書き換えず本物の検知経路を経て degraded に入る。
3. THE iPad_Client SHALL ping blackhole をランタイムで可逆に切替可能とし、無効化（blackhole 解除）後は ping 送信を再開し、pong 受信により Connectivity を `up` へ復帰させ Reconcile（要件2.4）を契機づける。
4. WHERE デバッグフラグが無効であるとき（本番の既定）、THE iPad_Client SHALL ping blackhole の切替手段をユーザー向け UI に提示せず、当該フォルトインジェクションのコードを本番バンドルから除外する（dev/test 限定・OBSERVE_DEBUG と同様の規律）。
5. THE ping blackhole SHALL Mode を独立状態として保持・上書きせず、Connectivity 検知（要件2・3）を唯一のモード決定経路として保つ。

## 確定事項（旧・未決事項）

> 当初の未決 2 点はユーザー確認により確定し、該当要件へ織り込んだ。

### 決定 A: リロード抑止の範囲 → **案 A-1**

リロード抑止は standalone PWA ＋ `overscroll-behavior` のみとし、稀な OS による eviction / 強制終了の裾は受容する。これを超える追加の抑止層は設けない。走行中ポットがリロードを生き延びる担保は、App_Shell キャッシュ（要件10.1）と状態の永続化・再水和（要件11）に委ねる。→ 要件 10.5 に反映。

### 決定 B: 再接続時の Provisional_Timer 方針 → **案 B-1**

回線復帰時（Reconcile）、サーバの全量スナップショットで置き換えるのは server-confirmed Timer のみとし、この iPad だけで始めた Provisional_Timer は消さずに未確定表示で保持し続ける（茹でているポットが回線復帰の瞬間に消えない）。あわせて、オフライン中に server-confirmed Timer をローカル cancel した場合、その取り消しはサーバへ届かない（書き戻しはスコープ外）ため再接続時に復活しうるが、これは**最善努力として受容**する。復活した当該 Timer のローカルアラートは processedIds により抑止する。→ 要件 11.5 / 11.6 / 11.7 に反映。

## 制約と前提（Constraints and Assumptions）

- **設計哲学の不変点**: core/shell/client 分離を壊さない。core（`src/engine/`）は不変。変更は client（`src/client/`）と shell（`src/shell/`）への最小追加（`setWebSocketAutoResponse`）に限る。SSOT 規律（サーバ snapshot が正本・Provisional_Timer は起源タグ付きの未確定意図）を崩さない。hibernation 規律（heartbeats は auto-response 経路に限り DO を wake させない）を保持する。導出値（残り秒・Mode）は状態に昇格させない。
- **命名規律（暫定・要確認の公開シンボル）**: 次は概念境界の表明であり実装前にユーザー確認を要する。本書での使用名はすべて暫定であり、ドメイン語彙（decide / reconcile / Snapshot / Effect）の踏襲を優先する。
  - クライアント純粋遷移関数名（暫定 `Client_Decide`）
  - モード名（暫定 `live` / `degraded`）
  - イベント種別名（暫定 `LocalCommand` / `Connectivity` / `LocalDone` / `Tick` / `Reconcile`）
  - UI の唯一の窓口（暫定 `Sync_Mediator`。「Mediator」はパターン名であり、ドメイン語への置換も含め確認対象）
  - 永続ポート（暫定 `Persistence_Port`）
  - 接続性検出の端（暫定 `Connectivity_Watch`）
  - auto-response の ping 要求文字列 / pong 応答文字列
  - localStorage の保存キー
- **iOS / iPad 制約**: 対象は iPad Safari / standalone PWA。Background Sync 不可のため Service Worker によるバックグラウンド再送は行わない。`beforeunload` は不可信のため依存しない。リロード抑止は standalone PWA ＋ `overscroll-behavior` を主とするが、真の担保は PWA がリロードを生き延びること（App_Shell キャッシュ＋永続化＋再水和）にある。
- **ツール**: pnpm / TypeScript(strict) / Vite ＋ @cloudflare/vite-plugin / Wrangler v4 / Vitest ＋ fast-check / oxlint。PWA は vite-plugin-pwa / Workbox を許容。npm / yarn / npx は使わない。
- **言語**: フロントのユーザー向け画面コンテンツは英語、コードコメントは日本語、Kiro 出力は日本語。
- **既存資産の踏襲**: 残り秒のローカル導出（`clock.ts`）・通知の冪等性（`notification.ts` の processedIds）・純粋な畳み込み（`connection.ts` の reduceView）の思想をそのまま延長し、二重定義を作らない。
- **デバッグ用フォルトインジェクション（要件14）**: ping blackhole は dev/test 限定の検証足場であり、本番 UI・本番バンドルに露出しない。切替トークン / フラグ名は公開シンボルとして命名確認対象（暫定）。
