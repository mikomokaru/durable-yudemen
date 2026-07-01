# Requirements Document

## Introduction

本 spec は、承認済みの設計書（`design.md`）が確定した **server→client メッセージ契約の構造変更** を、EARS 形式の要件として形式化する。設計は「二重に持っていた表現（意味論メッセージ＋全量 snapshot）を一つへ畳む引き算」であり、設計哲学の「重複の根絶」「真 — 二つの真実の源を作らない」の直接の帰結である。

確定した設計判断（すべて本要件へ演繹する）:

1. 確定した状態変化ごとに、全 client へ送るのは `snapshot` ただ一つ。意味論メッセージ（`started` / `cancelled` / `completed` / `boiled` / `adjusted`）を broadcast / reply 経路から完全に撤去する。
2. `snapshot` を接続時 hydration と確定変化の双方で共用する唯一の権威表現に据える。`config` と `error` は存置する。
3. 要求元への個別 `Reply` を廃し、要求元も他 client と同一の `snapshot` を受ける（bug#1 の構造的消滅）。
4. client は snapshot を「server-confirmed の全置換＋直前集合との差分」で適用し、消えた Timer の `noodleType` を残滓（`lastResults`）として導く。boiled/running/アラート dedup は `endTime` から導出する。
5. 残滓は理由を問わず一様（Complete も Cancel も）。degraded（offline）経路の `LocalCancel` も残滓を記録する（`LocalComplete` と揃える）。
6. 非機能：`snapshot` は素の JSON・非圧縮のまま、離散イベント時のみ broadcast する（hibernation 維持・サイズ有界）。圧縮はスコープ外（YAGNI）。
7. SSOT を崩さない。broadcast は `storage.put` 成功の上にのみ立つ（Persist-first）。no-op 変化は put も broadcast も生まない。
8. 拒否・失敗の要求元通知は `Reply` 作用に依存せず、shell が `error` を直接送る（これが `Reply` 撤去を安全にする前提）。

**スコープ外**：近接同時茹で上がりの maximin 終了調整アルゴリズム挙動（別 spec `synchronized-boil-adjustment`）は本 spec に含めない。本 spec はメッセージ／ブロードキャストモデルの変更のみを扱う。

**naming ゲート（`naming.md`）**：`ServerMessage` の `type` 集合・`Effect` の `Reply` 種別・`settle` / `reconcileServerConfirmed` のシグネチャは公開シンボルの変更である。要件 1・3・8 が固定するこれらの契約形は、実装前にユーザー確認を要する（design.md「公開シンボルの確認ゲート」参照）。

## Glossary

- **Engine**: `src/engine` のプラットフォーム非依存な純粋状態遷移機構（`decide` / `settle` / `assembleEffects` ほか）。計算のみを行い作用を返す。
- **Timer_DO**: `src/shell/store-timer-do.ts` の `StoreTimerDO`（Cloudflare Durable Object・作用の端）。Effect を実行し WS へ送信する。
- **Client**: `src/client` の React フロント（`connection.ts` の `decideServerMessage` / `reconcileServerConfirmed` を含む）。
- **ServerMessage**: server→client の判別共用体メッセージ。すべて `serverTime` を持つ。
- **Snapshot**: `type === "snapshot"` の `ServerMessage`。その時点の server-confirmed な全 Timer を含む唯一の権威表現。
- **TimerFact**: `src/domain/timer.ts` のワイヤ Timer 表現（id / slotIds / noodleType / endTime）。本変更で新フィールドを足さない。
- **Server_Confirmed_Timer**: `origin === "server"` の Client 上 Timer。
- **Provisional_Timer**: `origin === "local"` の Client 上 Timer（degraded/楽観反映）。
- **Effect**: Engine が返す作用の記述（`Persist` / `SetAlarm` / `ClearAlarm` / `Broadcast`）。
- **Broadcast**: 接続中の全 WS へ `ServerMessage` を送る Effect。
- **Reply**: 要求元 WS のみへ返す Effect（本変更で撤去）。
- **Residual**: `ClientView.lastResults`（`slotId → { noodleType, at }`）。直前にそのスロットに在った Timer の麺種。
- **Confirmed_State_Change**: 遷移結果が直前状態と異なり、かつ `storage.put` が成功した確定変化。
- **No_Op_Change**: 遷移結果が直前状態と同一の変化（Effect を生まない）。
- **MAX_TIMERS**: 同時稼働 Timer の上限（100）。

## Requirements

### Requirement 1: 確定変化ごとの単一 snapshot ブロードキャスト

**User Story:** As a 現場の Client（iPad）, I want すべての確定した状態変化で単一の権威 snapshot を受け取りたい, so that 二重表現の順序による不整合が生じない

#### Acceptance Criteria

1. WHEN Engine が Confirmed_State_Change の Effect 列を組み立てる, THE Engine SHALL 種別が `snapshot` の Broadcast 作用をちょうど 1 個含み、かつ他のいかなる Broadcast 作用も含まない Effect 列を返す
2. THE Snapshot SHALL その時点の server-confirmed な全 Timer を、差分ではなく全量の TimerFact 列（件数 0 以上 MAX_TIMERS 以下）として含み、server-confirmed Timer が 0 件のときは空の TimerFact 列を含む
3. THE ServerMessage SHALL 種別として `snapshot` / `config` / `error` の 3 種のみを定義する
4. THE Engine SHALL Effect 列に `Reply` 作用を一切含めない
5. THE Effect SHALL 種別として `Persist` / `SetAlarm` / `ClearAlarm` / `Broadcast` のみを定義する

_Design trace: decision #1, Component 1（messages.ts）/ Component 2（settle.ts）/ Component 4（effect.ts）, Property 1_

### Requirement 2: snapshot を唯一の権威表現とする

**User Story:** As a Client, I want 接続時 hydration も状態変化通知も同一の snapshot 表現で受け取りたい, so that 反映経路を一本へ畳める

#### Acceptance Criteria

1. WHEN Client が Timer_DO と WebSocket 接続を確立する, THE Timer_DO SHALL 同一接続上で `config` を送信し、その送信に続けて、その時点の server-confirmed な全 Timer を TimerFact 列（全量）として含む `snapshot` を、`config` の後に送信する
2. THE Timer_DO SHALL 接続時 hydration と Confirmed_State_Change 通知の双方で、同一種別 `snapshot` かつ同一構造（その時点の server-confirmed な全 Timer を含む全量 TimerFact 列）を用いる
3. THE Timer_DO SHALL `config` メッセージ（店舗設定の一方向配信）を存置する
4. THE Timer_DO SHALL `error` メッセージ（拒否・失敗の通知）を存置する
5. WHEN Client が `snapshot` / `config` / `error` のいずれかを受信する, THE Client SHALL `offset` を、当該メッセージの `serverTime` と受信時のローカル時刻 `receivedAt` から `clockOffset(serverTime, receivedAt)` として更新する
6. WHEN server-confirmed Timer が 0 件の状態で Client が接続する, THE Timer_DO SHALL `timers` を空列とした `snapshot` を接続時 hydration として送信する

_Design trace: decision #2, Component 1 / Component 6, 「変えないもの」, Property 7_

### Requirement 3: 要求元も同一 snapshot を受ける（Reply 廃止・bug#1 消滅）

**User Story:** As a 要求元 Client, I want 他 Client と同一の snapshot を受けたい, so that 自分のタイマーだけ未同期 endTime でズレない

#### Acceptance Criteria

1. WHEN 要求元 Client の要求が Confirmed_State_Change を生む, THE Timer_DO SHALL 要求元 WS を含む接続中の全 WS へ、単一の Broadcast 作用による同一の Snapshot を送信する
2. WHEN Confirmed_State_Change の Snapshot が送信される, THE Timer_DO SHALL 要求元が受信する Snapshot の `timers`（TimerFact 列）および `serverTime` を、他の全 Client が受信する Snapshot のそれと同一の値にする
3. THE Timer_DO SHALL 確定変化の通知経路において、要求元へ per-timer の個別 Reply（要求した Timer 単位の返信メッセージ）を一切送信しない
4. WHEN 要求元 Client と非要求元 Client が同一順序の Snapshot 列を適用し終える, THE Client SHALL 双方の Server_Confirmed_Timer 集合を最新 `snapshot.timers` と一致させ（各 Timer の id / slotIds / noodleType / endTime が一致）、かつ双方の集合を相互に同一にする

_Design trace: decision #3, Overview「bug#1」, シーケンス（変更後）, Property 2_

### Requirement 4: Client の snapshot 適用（全置換＋差分による残滓導出）

**User Story:** As a Client, I want snapshot を全置換＋差分で適用したい, so that 残滓を一様かつ純粋差分で導ける

#### Acceptance Criteria

1. WHEN Client が Snapshot を受信する, THE Client SHALL Server_Confirmed_Timer を `snapshot.timers`（すべて `origin === "server"`）で全置換し、`id` が `snapshot.timers` に現れない Provisional_Timer のみを保持する
2. WHEN Client が Snapshot を適用する, THE Client SHALL 直前の Server_Confirmed_Timer 集合に在り新 `snapshot.timers` に無い各 Timer（消えた Timer）の `noodleType` を、置換後に Server_Confirmed_Timer も保持 Provisional_Timer も占有しない各 `slotId` の Residual として、受信時刻 `at` とともに記録する
3. WHEN ある `slotId` が新 Snapshot の Server_Confirmed_Timer もしくは保持 Provisional_Timer により占有される, THE Client SHALL その `slotId` の Residual を消去する
4. THE Client SHALL boiled / running 状態およびアラート dedup を `endTime` から導出し、これらを状態として保持しない（残り秒・boiled を状態へ昇格させない）
5. WHEN Client が同一 `serverTimers` を二度適用する, THE Client SHALL 二度目適用後の `timers`・`processedIds`・Residual を一度目適用後と同一に保ち、新規 Residual を生成しない
6. THE Client SHALL Residual を `(直前 Server_Confirmed_Timer 集合, 新 serverTimers, at)` のみから導出し、TimerFact への追加フィールドに依存しない
7. WHEN Provisional_Timer の `id` が新 `snapshot.timers` に現れる, THE Client SHALL 当該 Timer を Server_Confirmed_Timer として扱い、Provisional_Timer として二重に保持しない

_Design trace: decision #4, Component 6, `reconcileServerConfirmed` Pseudocode, Property 3/4/5/6_

### Requirement 5: 残滓の一様性（理由を問わない・degraded 経路を含む）

**User Story:** As a 厨房スタッフ, I want 中断でも完了でも直前の麺種が残滓として残ってほしい, so that 直前の調理結果を一様に確認できる

#### Acceptance Criteria

1. WHEN Server_Confirmed_Timer が連続する 2 つの Snapshot 間で消える（直前 Snapshot に在り新 Snapshot に無い）, THE Client SHALL その理由（Complete / Cancel / Fire→Complete）を問わず、新 Snapshot の Server_Confirmed_Timer も保持 Provisional_Timer も占有しない各 `slotId` に、消えた Timer の `noodleType` と受信時刻 `at` を Residual として記録する
2. WHEN degraded（offline）経路で `LocalCancel` により Timer が除去される, THE Client SHALL `LocalComplete` と同一手順で、再占有されない各 `slotId` に除去直前の `noodleType` と除去時刻 `at` を Residual として記録する
3. IF ある `slotId` が新 Snapshot の Server_Confirmed_Timer もしくは保持 Provisional_Timer により占有される, THEN THE Client SHALL その `slotId` に Residual を記録せず、既存の Residual エントリを消去する

_Design trace: decision #5, Data Models「lastResults」, 「整合の申し送り（degraded 経路の残滓一様化）」, Property 3_

### Requirement 6: 非機能 — 素の JSON・非圧縮・離散イベント・有界サイズ

**User Story:** As a 運用者, I want snapshot が非圧縮・離散イベント配信で有界サイズに収まってほしい, so that 資源を浪費せず hibernation を保てる

#### Acceptance Criteria

1. THE Timer_DO SHALL Snapshot を、圧縮もエンコーディング変換も施さない UTF-8 の JSON テキストとして送信する
2. THE Timer_DO SHALL Snapshot の broadcast を Confirmed_State_Change の発生時点にのみ行い、ポーリング・定期送信・時間経過を含むそれ以外のいかなる契機でも行わない
3. THE Snapshot のバイト数 SHALL 含まれる TimerFact 件数に対し単調非減少であり（0 件を最小とする）、各 TimerFact のシリアライズ長が一定の上限を持つことにより、MAX_TIMERS（100 件）時の値を上限として超えない
4. WHILE Confirmed_State_Change が発生していない, THE Timer_DO SHALL Snapshot を送信せず、かつ Snapshot 送信のための in-memory タイマー・ポーリング・待機を一切保持しない

**非機能ノート（圧縮について・調査に基づく事実の記録）：**

- **`permessage-deflate` は本環境で利用不可**：Cloudflare Workers / Durable Objects の WebSocket ではプロトコル層の `permessage-deflate` を使えない（公式の WebSocket / Hibernation API ドキュメントは同拡張に一切言及せず、`WebSocketPair` / `acceptWebSocket` にも有効化・ネゴシエーションの API が無い。クライアントが拡張を提示してもハンドシェイク応答から省かれることがコミュニティ報告で確認済み）。したがって「将来の仮想レバー」として前提にせず、**利用不可**として記録する。
- **生サイズは硬い障壁ではない**：Workers の WebSocket メッセージ上限は **1 MiB から 32 MiB へ引き上げられた（2025-10-31）**。timer snapshot は非圧縮のまま（本要件 6.1 の不変点）で有界サイズに収まり、生サイズが配信を妨げない。
- **もし圧縮が必要になっても本 spec の対象外**：圧縮は別個の将来 spec（order-list snapshot）が要求した場合に限り、**アプリケーション層**で行う（Web 標準 `CompressionStream` / `DecompressionStream` による gzip・バイナリ WebSocket フレーム）。適用はトランスポートのシリアライズ境界（shell encode / client Socket decode）に閉じ、engine / domain / reducer には一切触れない。**本 spec では圧縮はスコープ外**である。

_Design trace: decision #6, 「Non-Functional — 圧縮しない」, Property 8_

### Requirement 7: SSOT の維持（Persist-first・no-op 抑止）

**User Story:** As a システム, I want broadcast が put 成功の上にのみ立ってほしい, so that 永続層が唯一の正本として保たれる

#### Acceptance Criteria

1. WHEN Engine が Confirmed_State_Change の Effect 列を組む, THE Engine SHALL `Persist` を Effect 列の先頭に、かつ列内の全 Broadcast 作用より前に置く
2. WHEN `storage.put` が成功する, THE Timer_DO SHALL その確定後にのみ Snapshot を接続中の全 Client へ broadcast する
3. THE Timer_DO SHALL broadcast する Snapshot を、直前の `storage.put` で永続化した状態と同一内容（差分ではなく全量）とする
4. IF `storage.put` が失敗する, THEN THE Timer_DO SHALL 後続の Broadcast を実行せず、永続層の直前 Snapshot を正本として保持する（メモリ上の変更を確定として外部主張しない）
5. IF 遷移結果が直前状態と同一（No_Op_Change）, THEN THE Engine SHALL 空の Effect 列を返し、`Persist` も `Broadcast` も生成しない

_Design trace: decision #7, Component 2「責務」, Error Handling（put 失敗）, `assembleEffects` Postconditions_

### Requirement 8: error 通知は Reply 作用に依存しない

**User Story:** As a 要求元 Client, I want 拒否・失敗を error で直接受け取りたい, so that Reply 撤去が安全に成立する

#### Acceptance Criteria

1. IF Client の要求が拒否される（`InvalidBoilSeconds` / `InvalidSlotOrNoodle` / `CapacityExceeded`）, THEN THE Timer_DO SHALL 拒否理由を識別できる `error` を要求元 WS のみへ直接 `ws.send` で送信する
2. IF `adjust` の解決が失敗する（`TimerNotFound` / `UnknownNoodle`）, THEN THE Timer_DO SHALL 失敗理由を識別できる `error` を要求元 WS のみへ直接 `ws.send` で送信する
3. THE Timer_DO SHALL `error` 通知に `Reply` 作用を用いない
4. IF 拒否・失敗が発生する, THEN THE Engine SHALL Effect 列を生成しない
5. IF 拒否・失敗が発生する, THEN THE Timer_DO SHALL `storage.put` を実行せず Snapshot を broadcast せず、server-confirmed な Timer 集合を変化させない
6. IF 拒否・失敗が発生する, THEN THE Timer_DO SHALL `error` を要求元以外の Client へ送信しない

_Design trace: decision #8, Component 5, Error Handling 表, 「Reply 撤去を安全にする前提」_
