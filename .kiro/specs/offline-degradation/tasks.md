# Implementation Plan: オフライン劣化（offline-degradation）

## Overview

本計画は `design.md` の四層構成（UI / Client_Decide / Connectivity_Watch / Persistence_Port）と純粋・非純粋の境界に沿って、iPad_Client のオフライン劣化をインクリメンタルに実装する TypeScript / React / Cloudflare Workers + Durable Objects タスク列である。設計の中心は「劣化運用の正しさそのものを純粋関数の property で保証する」ことにあるため、**純粋層（クライアントの単一遷移 `decideView` と導出ヘルパ・永続コーデック）を先に完成・検証してから**、作用の端（Persistence_Port / Connectivity_Watch / Sync_Mediator）・shell の一点追加・PWA・dev 限定フォルトインジェクション・静的検査へ進む。

実装の順序は次のとおり。

1. **純粋層を先に（PURE LAYER FIRST）** — 既存の純粋畳み込み `reduceView`（`src/client/connection.ts`）を、タグ付きイベント列（Server / LocalStart / LocalCancel / Connectivity / LocalDone / Tick / Reconcile）を畳み込む単一の純粋遷移 `decideView(view, event)` へ一般化し、あわせて `mode(view)` と `dueLocalTimers(view, correctedNow)` を実装する。残り導出（`clock.ts` の `remainingMs` / `correctedNow`）と通知冪等性（`notification.ts` の `shouldHandleDone` / `markProcessed`）は既存純粋関数を**そのまま再利用し二重定義しない**。永続コーデック（`serializeView` / `parsePersistedView`）も純粋関数として `src/client/persistence.ts` に置く。Correctness Property P1〜P9 を fast-check の単一 property テスト（最低 100 回反復）として、いずれも `*` 省略可サブタスクで実装する。**純粋層テストは `Date.now` のスタブも `vi.useFakeTimers()` も用いない**（時刻は引数で渡す）。
2. **端の配線（THEN EFFECT EDGES）** — Persistence_Port の localStorage 裏側実装と boot 再水和 → Connectivity_Watch（WS ライフサイクル・ping/pong 生存検出・二段階 down 検出）→ Sync_Mediator（既存 `openTimerConnection` / `TimerConnection` の拡張・Mode 経路選択・down→up での Reconcile 契機づけ・ティック + ローカル発火ループ・ビュー変化での永続化）→ `slotDisplay.ts` への未確定フラグ追加とダブルブッキングゲートの確認。
3. **shell への唯一の追加** — `src/shell/store-timer-do.ts` の `fetch()` で `acceptWebSocket` 直後に `setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_REQUEST, PONG_RESPONSE))` を一点だけ加える。**core（`src/engine/`）は一文字も変更しない。**
4. **PWA 基盤** — vite-plugin-pwa / Workbox を追加（`pnpm add -D`）し、manifest（`display: standalone`）・App Shell precache・`overscroll-behavior` を構成する。iOS 制約（Background Sync 不可・`beforeunload` 不可信）を前提に追加抑止層を設けない。
5. **dev 限定フォルトインジェクション（要件14）** — `withPingBlackhole` デコレータを `SocketOpener` / `ConnectivityWatchFactory` の継ぎ目に被せ、**送信 ping のみ破棄**する。デバッグフラグ（`OBSERVE_DEBUG` と同じ規律）でゲートし `import.meta.env.DEV` で本番バンドルから tree-shaking 除外、ランタイム可逆。
6. **静的検査と最終チェックポイント** — core 無変更・shell 一点・ワイヤ形式不変・UI は Sync_Mediator のみ経由・IndexedDB / Background Sync 不使用・英語 UI / 日本語コメント、`tsc` / `oxlint` / `vitest` ゲートを通す。

設計哲学と規律をタスクの不変点として貫く。

- **計算と作用の分離をクライアントへ徹底** — `decideView` / `mode` / `dueLocalTimers` / 永続コーデックは純粋（WS / DOM / 時計 / 乱数 / localStorage 非依存・時刻と生成 id と受信時刻は引数）に置き、WS・localStorage IO・実時間ティック・アラート音・PWA / SW は端へ寄せる（要件4.1〜4.3）。
- **導出値を状態に昇格させない** — Mode は `mode(view)` で Connectivity から関数導出し、残り秒は `remainingMs` で描画のたびに導出する。どちらも `ClientView` のフィールドにしない（要件3.3 / 5.1）。
- **SSOT 規律を崩さない** — サーバ全量スナップショットが正本。Provisional_Timer は起源タグ付きの未確定意図であり、degraded 中も WS へ送らず、Reconcile でも消さない（決定 B・要件11.5 / 12.4）。書き戻し（reconciliation）はスコープ外（要件12.5）。
- **core 不変・ワイヤ形式不変・shell 最小追加** — 変更は `src/client/` 配下と `src/shell/store-timer-do.ts` への `setWebSocketAutoResponse` 一点のみ。`src/domain/messages.ts` の既存 `ClientMessage` / `ServerMessage` のワイヤ形式のみを使う（要件12.1 / 12.2）。
- **「待つなら寝かせる、抱えると漏れる」を heartbeats でも守る** — ping/pong は auto-response 経路に限定し、`webSocketMessage` 起動や hibernate からの wake を伴わせない。クライアントのティック常駐ループは DO を wake させる通常メッセージを送らない（要件1.5 / 1.6 / 12.3）。
- **既存資産の延長・二重定義の根絶** — `clock.ts`（残り導出・補正後現在時刻）・`notification.ts`（processedIds 冪等性）・`assignment.ts`（担当射影）・`slotDisplay.ts`（表示導出）・`connection.ts` の `reduceView` をそのまま延長し、同じ概念を二度定義しない。

ツールは確定スタックに従う（pnpm / TypeScript strict / Vite + @cloudflare/vite-plugin / Wrangler v4 / Vitest + @cloudflare/vitest-pool-workers / fast-check / oxlint）。ユーザー向け画面コンテンツは英語、コードコメントは日本語、Kiro 出力は日本語。Property-Based Testing は fast-check を採用し、各 Correctness Property（P1〜P9）を**単一の** property テストとして最低 100 回反復で実装し、各テストに `// Feature: offline-degradation, Property {番号}: {本文}` のタグコメントを付す。

> **公開シンボル名の確認（命名規律）:** 本機能の公開シンボル（クライアント純粋遷移 `decideView` / `Client_Decide`、モード名 `live` / `degraded`、Connectivity の `up` / `down`、イベント種別 `Server` / `LocalStart` / `LocalCancel` / `Connectivity` / `LocalDone` / `Tick` / `Reconcile`、UI の唯一の窓口を `Sync_Mediator` とするか既存 `TimerConnection` 据え置きか、`Persistence_Port`、`Connectivity_Watch` / `watchConnectivity`、`ClientTimer` / `TimerOrigin`（`server` / `local`）、`PING_REQUEST` / `PONG_RESPONSE` 文字列、`STORAGE_KEY`、`withPingBlackhole` と debug フラグ名）は概念境界の表明であり、**実装着手前にユーザー確認を要する**（design.md「公開シンボル命名の確認」節）。タスク 1.1 でこれを確定してから後続のコードタスクへ進む。本計画中の名前はすべて暫定候補である。

## Tasks

- [x] 1. プロジェクト基盤と公開シンボル名の確定
  - [x] 1.1 公開シンボル名をユーザーと確認・確定する
    - design.md「公開シンボル命名の確認」節の候補表と「特に確認を要する論点」を提示し、候補名・概念境界・既存ドメイン語彙（サーバ側 `decide` / `reconcile` / `Snapshot` / `Effect` / `Persist`）との対応とともにユーザーの判断を仰ぐ
    - 確定対象: 純粋遷移名（暫定 `decideView` / `Client_Decide`・既存 `reduceView` 据え置きの是非）、モード名（`live` / `degraded`）、Connectivity の値（`up` / `down`）、イベント種別名（`Server` / `LocalStart` / `LocalCancel` / `Connectivity` / `LocalDone` / `Tick` / `Reconcile`・`Reconcile` を独立イベントにするか `snapshot` に畳むか）、**UI の唯一の窓口（`Sync_Mediator` か既存 `TimerConnection` 据え置きか。「Mediator」はパターン名であり命名規律で忌避対象）**、`Persistence_Port`（`Persist` 語彙との一致可否・「Port」を残すか）、`Connectivity_Watch` / `watchConnectivity`、`ClientTimer` / `TimerOrigin`（`server` / `local` か `confirmed` / `provisional` か）、`PING_REQUEST` / `PONG_RESPONSE` の具体文字列とその置き場所（`src/transport/` の定数追加か各層定義か。ワイヤ**型**は変えない）、`STORAGE_KEY`、`withPingBlackhole` とデバッグフラグ / トークン名
    - 確定した名前を後続の全タスクで一貫して用いる（本計画の暫定名はすべて差し替え対象）
    - _Requirements: 12.2_

  - [x] 1.2 クライアント純粋層のテスト基盤と生成器の土台を用意する
    - `tests/client/` に本機能用の生成器（`genClientTimer` / `genClientView` / `genCorrectedNow` / `genEvent` / `genEventStream` / 永続ブロブ生成器）の土台を用意する。server / local 混在 Timer、`endTime == correctedNow` 境界、範囲外 boilSeconds（0・負・1801 以上・非整数）、処理済み id の重複、cancel 済み server の snapshot 復活、不正 / 不在ブロブを構造的にサンプリングできるようにする（design.md「生成器の前提」）
    - PBT のタグコメント規約（`Feature: offline-degradation, Property N: ...`）と「最低 100 回反復（fast-check `numRuns: 100` 以上）」、および**純粋層テストで `Date.now` スタブ・`vi.useFakeTimers()` を用いない方針**を `tests/client/` の README または設定に明文化する（要件13.4・「暗黙時計に漏れたら境界を疑う」）
    - 既存の `tests/client/clock.property.test.ts` / `notification.property.test.ts` の規約に倣う。fast-check は既存依存をそのまま用いる
    - _Requirements: 13.3, 13.4_

- [x] 2. 純粋層: クライアントビュー型・Mode 導出・単一純粋遷移 decideView
  - [x] 2.1 ClientView / ClientTimer / ClientEvent 型と mode() を定義する
    - `src/client/connection.ts`: 既存 `TimerView` を `ClientView` へ拡張（`connectivity: Connectivity` を追加、`timers` を `ClientTimer[]` 化）。`Connectivity`（`up` / `down`）・`Mode`（`live` / `degraded`）・`TimerOrigin`（`server` / `local`）・`ClientTimer`（`WireTimer` に `origin` を足す）・`ClientEvent`（`Server` / `LocalStart` / `LocalCancel` / `Connectivity` / `LocalDone` / `Tick` / `Reconcile` の判別共用体）を定義する。`EMPTY_VIEW` の `connectivity` は `"down"` 起点
    - `mode(view)` を `view.connectivity === "up" ? "live" : "degraded"` として実装する。`ClientView` は Mode を独立フィールドに持たない（要件3.3）
    - _Requirements: 4.1, 4.2, 3.1, 3.2, 3.3, 12.2_

  - [ ]* 2.2 Mode 導出の property テストを書く
    - **Property 1: Mode は Connectivity から全域的・決定的に導出される**
    - **Validates: Requirements 3.1, 3.2, 3.3**

  - [x] 2.3 decideView の Server 系分岐と reconcileServerConfirmed を実装する
    - `src/client/connection.ts`: `reduceView` を `decideView(view, event)` へ一般化し、`event.kind === "Server"`（snapshot / started / cancelled / done / error）を既存ロジックの延長として畳み込む。`snapshot` と後続 `Reconcile` が共有する純粋規律 `reconcileServerConfirmed`（**server-confirmed のみ全置換・provisional は保持・processedIds を「snapshot の id ∪ 保持 provisional の id」へ刈り取り**）を実装する。offset は `serverTime` を伴う受信でのみ再確立する（既存 `clockOffset` を再利用）
    - 通知冪等性は既存 `shouldHandleDone` / `markProcessed` をそのまま使い、二重定義しない
    - _Requirements: 4.1, 4.2, 11.5, 11.6, 11.7_

  - [x] 2.4 decideView のローカル / 接続性 / Tick / Reconcile 各分岐と dueLocalTimers を実装する
    - `src/client/connection.ts`: `LocalStart`（boilSeconds が 1〜1800 内のとき `endTime = correctedNow + boilSeconds*1000` の `origin:"local"` Provisional_Timer をちょうど 1 件注入。範囲外は不変）、`LocalCancel`（`origin:"local"` は除去のみ・`origin:"server"` は除去＋`markProcessed`・非存在 id は不変）、`Connectivity`（`connectivity` をセットし offset は変えない）、`Tick`（参照同一を返しビュー不変）、`LocalDone`（`shouldHandleDone` が true のときのみ `markProcessed`）、`Reconcile`（`reconcileServerConfirmed` を適用）を実装する
    - `dueLocalTimers(view, correctedNow)` を実装する（`endTime ≤ correctedNow` かつ id が `processedIds` 未登録の `ClientTimer` を server / local 双方から返す純粋関数）。アラート音は持たない（端が鳴らす）
    - _Requirements: 6.1, 6.2, 6.5, 7.1, 7.2, 8.1, 8.3, 2.1, 2.2, 5.2, 11.5, 11.6, 11.7_

  - [ ]* 2.5 decideView の純粋性・決定性の property テストを書く
    - **Property 2: Client_Decide は決定的かつ純粋（時刻を引数に取り暗黙時計に漏れない）**
    - **Validates: Requirements 4.1, 4.2, 4.3**

  - [ ]* 2.6 degraded ローカル start の property テストを書く
    - **Property 3: degraded のローカル start は範囲内でちょうど 1 件の Provisional_Timer を注入し、範囲外では不変**
    - **Validates: Requirements 6.1, 6.2, 6.5, 9.1**

  - [ ]* 2.7 degraded ローカル cancel の property テストを書く
    - **Property 4: degraded のローカル cancel は起源別に正しく作用する**
    - **Validates: Requirements 7.1, 7.2**

  - [ ]* 2.8 ローカル茹で上がりの冪等性の property テストを書く
    - **Property 5: ローカル茹で上がりは各 timerId につき高々 1 回だけ処理される（後続サーバ done と冪等）**
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4**

  - [ ]* 2.9 クロックオフセット凍結の property テストを書く
    - **Property 7: degraded 系イベントはクロックオフセットを凍結する（変えない）**
    - **Validates: Requirements 5.2**

  - [ ]* 2.10 Reconcile 保存性の property テストを書く
    - **Property 8: Reconcile は server-confirmed のみを置換し、provisional と抑止記録を保存する**
    - **Validates: Requirements 11.5, 11.6, 11.7, 12.4**

  - [ ]* 2.11 残り時間導出クランプの property テストを書く
    - 既存 `clock.ts` の `remainingMs` を再利用対象として検証する（新規実装はしない）
    - **Property 6: 残り時間の導出は常に 0 以上にクランプされる**
    - **Validates: Requirements 5.1, 5.3**

- [x] 3. 純粋層: 永続コーデック（serializeView / parsePersistedView）
  - [x] 3.1 PersistedView 型と純粋コーデックを実装する
    - `src/client/persistence.ts`（新規）: `PersistedView`（`version: 1` / `timers`（起源タグ込み）/ `offset` / `processedIds`（配列））、`serializeView`（ビュー → 単一 JSON 文字列。Connectivity / sync / error など導出・一過性フィールドは含めない）、`parsePersistedView`（文字列 → ビュー。不正 / 不在は `EMPTY_VIEW` を返し、再水和後の `connectivity` は `"down"` 起点）を純粋関数として実装する
    - _Requirements: 11.1, 11.2, 11.3_

  - [ ]* 3.2 永続ブロブ round-trip の property テストを書く
    - **Property 9: 永続ブロブは直列化→解析で全フィールドを保存する（round-trip）**
    - **Validates: Requirements 11.1, 11.2, 11.3**

- [x] 4. チェックポイント — 純粋層（decideView / mode / dueLocalTimers / 永続コーデック）の全テストが通ることを確認
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. 端: Persistence_Port の localStorage 裏側実装
  - [x] 5.1 localStoragePersistence（save / load IO）を実装する
    - `src/client/persistence.ts`（続き）: `PersistencePort`（`save(view)` / `load()`）と既定実装 `localStoragePersistence()` を実装する。`save` は `serializeView` の結果を単一キー `STORAGE_KEY` へ同期書き込み、`load` はページ内同期読み出し → `parsePersistedView`。**IndexedDB および Background Sync に依存しない**（要件11.4）。書き込み失敗は握り潰さず劣化（表示・発火は継続し次のビュー変化で再試行）
    - _Requirements: 4.7, 11.1, 11.2, 11.4_

  - [ ]* 5.2 Persistence_Port の IO example テストを書く
    - 保存 → 読み出しの往復、不在 / 不正ブロブで `EMPTY_VIEW` 復帰（`connectivity` が `"down"` 起点）、書き込み失敗時に例外を投げず劣化することを 1〜2 例で固める
    - _Requirements: 11.2, 11.4_

- [-] 6. 端: Connectivity_Watch（WS 生存検出・二段階 down 検出）
  - [x] 6.1 ping/pong 定数・閾値と watchConnectivity の WS ライフサイクルを実装する
    - `src/client/connectivity.ts`（新規）: `PING_REQUEST` / `PONG_RESPONSE`（shell の auto-response と同一確定値）・`PING_INTERVAL_MS`(15000)・`PONG_TIMEOUT_MS`(10000)・`SILENT_LOSS_MISSES`(2) を定義。`ConnectivityWatch` / `ConnectivityWatchFactory` と `watchConnectivity` を実装し、WS の開閉・`PING_INTERVAL_MS` 以下での ping 送信・ServerMessage 受信購読・`send` を担う。WS open ＋ 全量 snapshot 受信で `up`、pong 受信で `up` を確定する（既存 `Socket` / `SocketOpener` 注入の継ぎ目を再利用）
    - 到達性検出の常駐ループは DO を wake させる通常メッセージを送らない（heartbeats は auto-response 経路に限る・要件1.6）
    - _Requirements: 1.2, 1.3, 1.6, 2.2_

  - [x] 6.2 二段階の down 検出（明示的切断と静かな喪失）を実装する
    - `src/client/connectivity.ts`（続き）: ping 送信後 `PONG_TIMEOUT_MS` 以内に pong 無しが `SILENT_LOSS_MISSES` 回連続したら `down`（静かな喪失）、WS close / error で `down`（明示的切断）を確定する。**二系統を独立に扱い、いずれか一方の成立で `down`**（要件2.3）。ビューの決定はせず Connectivity の確定のみを担う（要件4.6）
    - _Requirements: 1.4, 2.1, 2.3, 4.6_

  - [ ]* 6.3 二段階 Connectivity 検出の統合テストを書く（mock WS + faketime）
    - 既存 `SocketOpener` 注入のモック WS と faketime で、(a) pong タイムアウト 2 連続で `down`、(b) close / error で `down`、(c) open + snapshot で `up`、(d) pong 受信で `up` を 1〜3 例ずつ確認する
    - _Requirements: 1.3, 1.4, 2.1, 2.2, 2.3_

- [x] 7. 端: Sync_Mediator（openTimerConnection / TimerConnection の拡張）
  - [x] 7.1 Mode 経路選択・Reconcile 契機づけ・永続化・boot 再水和を配線する
    - `src/client/connection.ts`: 既存 `openTimerConnection` / `TimerConnection` を拡張し、UI の `start` / `cancel` を `mode(view)` で経路選択する（**live: `ClientMessage` を WS 送信。degraded: 補正後現在時刻と生成 id を端で採取して `LocalStart` / `LocalCancel` を `decideView` へ畳み込み、WS へは送らない**）。Connectivity_Watch から `up` を受け、直前が `down`（down→up 遷移）なら次の全量 snapshot を `Reconcile` として畳み込む。ビューが変化するたび `Persistence_Port.save(view)` を呼び、boot 時は `Persistence_Port.load()` で同期再水和してから接続する。UI はこの窓口のみと対話し、トランスポートはポート背後に隠す
    - 再水和ビューに endTime が補正後現在以下かつ未登録の Timer があれば、boot 直後に `dueLocalTimers` で導出してローカル発火する（要件11.3）
    - _Requirements: 4.4, 4.5, 6.3, 7.3, 2.4, 11.1, 11.2, 11.3_

  - [x] 7.2 秒読みティック＋ローカル茹で上がり発火ループを実装する
    - `src/client/connection.ts`: `tickMs`（≤1000ms・既定 1000）ごとに `dueLocalTimers(view, Date.now()+offset)` を導出し、各対象のアラートを 1 回鳴らして `LocalDone` を dispatch する。ティック自体は `Tick` でビューを変えず再描画を促す。**この常駐ループは DO を wake させる通常メッセージを送らない**（要件1.6）。degraded 中も最新 offset を凍結して使い続ける
    - _Requirements: 5.1, 8.1_

  - [ ]* 7.3 Mode 経路選択の統合テストを書く（mock WS + faketime）
    - degraded で `start` / `cancel` が WS 送信されず Provisional_Timer を注入 / 除去すること、live で `ClientMessage` が送信されることを 1〜3 例で確認する
    - _Requirements: 4.5, 6.3, 7.3_

  - [ ]* 7.4 Reconcile 契機づけと boot 再水和発火の example テストを書く
    - down→up 遷移で次の snapshot が `Reconcile` として畳まれ provisional が保持されること、再水和ビューの期限到来分が boot 直後にローカル発火することを example で固める
    - _Requirements: 2.4, 11.2, 11.3_

- [x] 8. 端: slotDisplay の未確定フラグとダブルブッキングゲート
  - [x] 8.1 SlotDisplay の running に unconfirmed を追加し ClientView から導出する
    - `src/client/components/slotDisplay.ts`: `running` バリアントに `unconfirmed: boolean`（`origin === "local"` から導出）を加え、`assignedSlotDisplays` を `ClientView`（`ClientTimer`）に追随させる。Provisional_Timer 注入で当該 Slot が `running` になることを保つ（既存の表示導出を最小拡張）
    - _Requirements: 6.4_

  - [ ]* 8.2 走行中ゲートと未確定表示の example テストを書く
    - 走行中（`running`）の Slot に Start の口が現れない（既存 `SlotCard` が `idle` / `boiled` のみ Start を描画する構造ゲートが効く）こと、Provisional_Timer が未確定表示（`unconfirmed`）で server-confirmed と区別されることを example で確認する
    - _Requirements: 6.4, 9.1, 9.2_

- [x] 9. チェックポイント — 端（Persistence_Port / Connectivity_Watch / Sync_Mediator / slotDisplay）のテストが通ることを確認
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. shell への唯一の追加（setWebSocketAutoResponse）
  - [x] 10.1 store-timer-do.ts に auto-response を一点追加する
    - `src/shell/store-timer-do.ts`: `fetch()` 内の `this.ctx.acceptWebSocket(server)` の直後に `this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_REQUEST, PONG_RESPONSE))` を加える。**これが shell への唯一の変更**であり、`webSocketMessage` / `webSocketClose` / `alarm` / core・既存 Effect 順序・hibernation 互換を一切変えない。ping 要求文字列は client（Connectivity_Watch）と同一の確定値を共有する
    - _Requirements: 1.1, 12.1, 12.3_

  - [ ]* 10.2 auto-response が wake させない統合テストを書く（@cloudflare/vitest-pool-workers）
    - Workers pool で DO へ ping を送り、auto-response で pong が返ること、`webSocketMessage`（broadcast 等）の継ぎ目が発火せず hibernate が維持されること（既存 `hibernation-observability` ハーネスの計装と併用可）を確認する
    - _Requirements: 1.1, 1.5, 12.3_

- [x] 11. PWA 基盤（App Shell precache・standalone・overscroll）
  - [x] 11.1 vite-plugin-pwa を追加し manifest と App Shell precache を構成する
    - `pnpm add -D vite-plugin-pwa`。Vite 設定に PWA プラグインを加え、manifest に `display: standalone`、App_Shell（HTML / JS / CSS）の Workbox precache を構成する。既存 SPA フォールバック（`not_found_handling: "single-page-application"`）と整合させ、Service Worker 更新戦略を定める。新たなパッケージマネージャを導入しない（pnpm のみ）
    - _Requirements: 10.1, 10.3, 13.5_

  - [x] 11.2 standalone 表示と overscroll-behavior によるリロード抑止を実装する
    - manifest の standalone 表示でリロードボタンを提示せず、CSS の `overscroll-behavior` でプルトゥリフレッシュを抑止する。**リロード抑止の手段を standalone + overscroll に限定し、追加の抑止層を設けない**（決定 A・要件10.5）
    - _Requirements: 10.3, 10.4, 10.5_

  - [ ]* 11.3 PWA 設定の smoke テストを書く
    - manifest が `display: standalone` であること、App Shell precache が設定されていること、`overscroll-behavior` が適用されていること、**IndexedDB / Background Sync を使用していない**ことを静的に確認する
    - _Requirements: 10.1, 10.3, 10.4, 11.4_

- [x] 12. dev 限定フォルトインジェクション（ping blackhole・要件14）
  - [x] 12.1 withPingBlackhole デコレータとデバッグフラグを実装する
    - `src/client/connectivity.ts`（dev/test 限定・本番バンドルから除外）: `withPingBlackhole(inner, isEnabled)` を実装する。返す `Socket` の `send` は `message === PING_REQUEST` かつ `isEnabled()` のとき**送信 ping のみを破棄**し、それ以外（通常メッセージ）は inner へ素通し、受信・close / error の観測経路は inner のまま変えない。デバッグフラグ（`OBSERVE_DEBUG` と同じ規律）でゲートし、`import.meta.env.DEV` 分岐で本番バンドルから tree-shaking 除外する。**Mode を直接書き換えない**
    - _Requirements: 14.1, 14.4, 14.5_

  - [ ]* 12.2 blackhole ライフサイクルの統合テストを書く（mock WS + faketime）
    - blackhole 有効化で送信 ping のみ捨て通常メッセージ・受信を素通しすること、silent-loss 検知（要件1.4）を通じて degraded に入り Mode を直接書き換えないこと、無効化でランタイム可逆に ping 再開 →`up` 復帰 → down→up 遷移で Reconcile を契機づけることを 1〜2 例で確認する
    - _Requirements: 14.1, 14.2, 14.3_

  - [ ]* 12.3 本番バンドル除外・UI 非露出の静的検査を書く
    - blackhole 切替手段が `import.meta.env.DEV` / デバッグフラグでゲートされ本番ユーザー向け UI に露出しないこと、本番バンドルへ含まれないことを静的に検証する
    - _Requirements: 14.4_

- [x] 13. 静的検査と規律の不変点
  - [x] 13.1 構造制約の静的検査を実装する
    - `tests/client/`（または `tests/`）に静的検査を実装。(a) `src/engine/` 配下に差分が無く変更が `src/client/` と `src/shell/store-timer-do.ts` の `setWebSocketAutoResponse` 一点のみ（要件12.1）、(b) `src/domain/messages.ts` の既存ワイヤ形式のみ使用・新種別 / フィールド不導入（要件12.2）、(c) UI が `Socket` を直接持たず Sync_Mediator（窓口）のみ経由（要件4.4）、(d) 永続が Persistence_Port 経由で IndexedDB / Background Sync 不使用（要件4.7 / 11.4）、(e) `decideView` が WS / DOM / 時計 / 乱数 / localStorage を import / 参照しない（要件4.3）、(f) ユーザー向け画面コンテンツが英語・コードコメントが日本語（要件13.6）を検証する
    - _Requirements: 4.3, 4.4, 4.7, 11.4, 12.1, 12.2, 13.6_

- [x] 14. 最終チェックポイント — 全テストとゲートが通ることを確認
  - `tsc --noEmit`（エラー 0・要件13.1）・`oxlint`（エラー 0・警告 0・要件13.2）・`vitest --run`（失敗 0・property テストに faketime / Date スタブ不在・要件13.3 / 13.4）を通し、疑問が生じたらユーザーに確認する。
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- `*` を付したサブタスクは省略可能（PBT・example・統合・smoke。MVP を急ぐ場合スキップ可）。トップレベルタスクには `*` を付さない。
- 各タスクは特定の要件（granular な受け入れ基準）を `_Requirements: x.y_` 形式で参照し、各 Property テストタスクは `Validates: Requirements x.y` を明記する。
- 各 Correctness Property（P1〜P9）は単一の property テストとして実装し、最低 100 回反復、`Feature: offline-degradation, Property N: ...` のタグコメントを付す（PBT は fast-check を用い自前実装しない）。
- **純粋層（`decideView` / `mode` / `dueLocalTimers` / 永続コーデック）を先に完成・検証してから端・shell・PWA・フォルトインジェクションへ進む。** 純粋層テストは `Date.now()` のスタブや `vi.useFakeTimers()` を用いない（時刻・生成 id・受信時刻は引数で渡す。暗黙時計への漏れは境界の引き直しサイン・要件4.3 / 13.4）。
- **既存純粋関数を再利用し二重定義しない** — 残り導出 / 補正後現在時刻は `clock.ts`、通知冪等性は `notification.ts`、担当射影は `assignment.ts`、表示導出は `slotDisplay.ts`、サーバ受信畳み込みは `connection.ts` の `reduceView` をそのまま延長する。
- **core（`src/engine/`）は追加・変更・削除しない。** 変更は `src/client/` 配下と `src/shell/store-timer-do.ts` への `setWebSocketAutoResponse` 一点のみ。既存ワイヤ形式（`ClientMessage` / `ServerMessage`）のみを使う。SSOT 規律（サーバ snapshot が正本・Provisional_Timer は起源タグ付き未確定意図・競合源にしない）と hibernation 規律（heartbeats は auto-response 経路限定・常駐ループは wake させない）を崩さない。書き戻し（reconciliation）はスコープ外。
- 公開シンボル名は 1.1 で確定してからコードに用いる。本計画中の名前はすべて暫定候補。特に `Sync_Mediator` のパターン名忌避（既存 `TimerConnection` 据え置きが規律に適う）・`Reconcile` の独立性・ping/pong 文字列 / `STORAGE_KEY` の置き場所は実装前に確定する。
- WS 生存検出の実時間タイミング（ping 間隔・pong タイムアウト・二段階検出）・Mode による経路選択・localStorage の同期 IO・PWA / Service Worker のプラットフォーム挙動・shell の auto-response（wake 抑止）・dev 限定フォルトインジェクションは、入力で振る舞いが変わらない／外部依存／実時間依存の**端**であり、Integration / Example / Smoke（静的検査・実機 E2E）で検証する。degraded → ローカル権限 → 再接続 → provisional 保持の手動 E2E ライフサイクルと「茹で上がりが各 timerId につきちょうど一度鳴る」安全要は iPad 実機で確認する（要件8）。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "10.1", "11.1", "11.2"] },
    { "id": 2, "tasks": ["2.2", "2.3", "3.1", "6.1", "8.1", "10.2", "11.3"] },
    { "id": 3, "tasks": ["2.4", "3.2", "5.1", "6.2", "8.2"] },
    { "id": 4, "tasks": ["2.5", "2.6", "2.7", "2.8", "2.9", "2.10", "2.11", "5.2", "6.3", "7.1", "12.1"] },
    { "id": 5, "tasks": ["7.2", "12.3"] },
    { "id": 6, "tasks": ["7.3", "7.4", "12.2"] },
    { "id": 7, "tasks": ["13.1"] }
  ]
}
```
