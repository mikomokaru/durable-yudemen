# Implementation Plan: ゆで麺タイマー（yude-men-timer）

## Overview

本計画は `design.md` の構造（core 純粋変換 → core の Property テスト → shell の Effect インタプリタ → storage/rehydrate 配線 → Alarm 配線 → WebSocket Hibernation 収容/broadcast → Worker エントリ/ルーティング/静的配信 → React クライアント → 統合検証・静的検査）に沿って、TypeScript / Cloudflare Workers + Durable Objects / Wrangler で実装するためのインクリメンタルなタスク列である。

設計哲学の不変点をタスクの規律として貫く。

- **計算と作用の分離** — core（`cloudflare:workers` にも storage にも触れない純粋関数）を先に完成・テストしてから shell の配線へ進む。core の状態遷移は `(状態, イベント) → 結果（新状態 + Effect[]）` の単一形に還元し、Effect 列は常に `Persist` を先頭に置く。
- **SSOT 規律** — 確定の起点は `storage.put` 成功のみ。shell は Persist 成功後にのみ `Broadcast` / `SetAlarm` を実行する。
- **「待つなら寝かせる、抱えると漏れる」** — 秒読み目的の `setInterval` および終わらない `setTimeout` ループを core / DO に持ち込まない。時間管理は Alarm のみ。
- **KV のみ・SQL 不使用** — 永続化は SQLite バックエンド（`new_sqlite_classes`）＋ 非同期 KV API（`storage.put`/`get`）のみ。`ctx.storage.sql`・テーブル・クエリは作らない。単一キー丸ごと put/get。
- **導出値を状態に昇格させない** — 残り秒は状態として持たず、クライアントの純粋導出として算出する。担当絞り込み・通知冪等性も純粋関数として実装し Property テスト可能にする。

Property-Based Testing は fast-check を採用し、各 Correctness Property（P1〜P16）を**単一の** property テストとして最低 100 回反復で実装する。各 property テストには `// Feature: yude-men-timer, Property {番号}: {本文}` のタグコメントを付す。

## Tasks

- [x] 1. プロジェクトとツール基盤のセットアップ
  - [x] 1.1 ディレクトリ構成・TypeScript・テスト/PBT 基盤を用意する
    - `core/` `shell/` `shared/` `client/` `tests/` のディレクトリ構成を作成（core は `cloudflare:workers`・storage 非依存を構造で表現）
    - TypeScript（strict）・Vitest・fast-check・型定義（`@cloudflare/workers-types`）を導入し、`package.json` のテストスクリプトは `vitest --run`（単発実行）で構成
    - PBT のタグコメント規約（`Feature: yude-men-timer, Property N: ...`）と「property テストは最低 100 回反復（fast-check `numRuns: 100` 以上）」を README または設定に明文化
    - _Requirements: 8.2, 9.5_

  - [x] 1.2 Wrangler 設定（DO バインディング・new_sqlite_classes・Static Assets・locationHint 配線）を用意する
    - `wrangler` 設定に `StoreTimerDO` の Durable Object バインディングを定義
    - migration を `new_sqlite_classes` で宣言（SQLite バックエンド確定。SQL API は使わず KV API のみ）
    - React 静的アセットを同一 Worker から同一オリジン配信する Static Assets 設定を定義
    - APAC 配置（`apac-ne`）を `idFromName(店舗ID)` → `get(id, { locationHint: "apac-ne" })` で配線する前提を設定コメントに明記
    - _Requirements: 8.2, 9.1_

- [x] 2. core の型定義（不正状態を構築不能にする）
  - [x] 2.1 ブランド型・定数・Timer の smart constructor を実装する
    - `core/types.ts`: `SlotId` / `NoodleType` / `TimerId` / `EpochMillis` のブランド型、`BOIL_SECONDS_MIN`(1) / `BOIL_SECONDS_MAX`(1800) / `MAX_TIMERS`(100) / `EPSILON_MS`(500) / `CURRENT_SCHEMA_VERSION`(1) の定数
    - `core/timer.ts`: 全フィールド必須・`readonly` の `Timer`（`id`/`slotId`/`noodleType`/`endTime`/`seq`）と、検証に通った入力からのみ構築できる `createTimer`。`endTime`・`slotId` を欠く Timer を型として構築不能にする
    - _Requirements: 10.1_

  - [x] 2.2 状態・スナップショット・イベント・拒否・Effect・メッセージプロトコルの型を定義する
    - `core/state.ts`: `TimerState`（`timers` / `nextSeq`）と `EMPTY_STATE`
    - `core/snapshot.ts`: `ActiveTimersSnapshot`（`version` / `timers` / `nextSeq`）の型定義
    - `core/event.ts`: `Event`（`Start` / `Cancel` / `AlarmFired` / `Reconcile`、`now` は入力として受け取る）
    - `core/rejection.ts`: `Rejection`（`InvalidBoilSeconds` / `InvalidSlotOrNoodle` / `CapacityExceeded` / `TimerNotFound`）と shell 側 `ShellFailure`
    - `core/effect.ts`: `Effect`（`Persist` / `SetAlarm` / `ClearAlarm` / `Broadcast` / `Reply`）と `Outcome`
    - `shared/messages.ts`: `WireTimer` / `ClientMessage` / `ServerMessage`（サーバは残り時間を含めず `endTime`+`serverTime` を送る）
    - _Requirements: 10.1, 10.2_

- [x] 3. core: スナップショット変換とスキーマ移行
  - [x] 3.1 toSnapshot / fromSnapshot を実装する
    - `core/snapshot.ts`: 状態 → スナップショット（`version = CURRENT_SCHEMA_VERSION`）と スナップショット → 状態の純粋変換。空状態でも往復で情報を落とさない
    - _Requirements: 8.3, 8.7, 11.1_

  - [x]* 3.2 snapshot ラウンドトリップの property テストを書く
    - **Property 9: snapshot ラウンドトリップは状態を保存する**
    - **Validates: Requirements 8.3, 8.7, 11.1**
    - 任意の `TimerState` で `fromSnapshot(toSnapshot(state)) === state`、出力は常に `version = 1`、空状態も往復保存

  - [x] 3.3 migrate（スキーマバージョン検査・移行）を実装する
    - `core/migrate.ts`: version 取得・現行比較。旧版/version 欠如は現行へ移行、現行より大きいなら `UnsupportedSchemaVersion`、移行失敗は `MigrationFailed`。失敗時は入力データを一切変更しない
    - _Requirements: 11.2, 11.3, 11.4, 11.5, 11.6, 11.7_

  - [x]* 3.4 migrate の version 不整合の property テストを書く
    - **Property 13: migrate は version 不整合時に元データ不変でエラーを返す**
    - **Validates: Requirements 11.5, 11.6**
    - version > 1 で `UnsupportedSchemaVersion`、壊れたデータで `MigrationFailed`、いずれも入力不変

- [x] 4. core: Alarm 導出（最早算出を一関数へ集約）
  - [x] 4.1 earliestEndTime / nextAlarmEffect を実装する
    - `core/alarm.ts`: 最早 `endTime`（同一は `seq` 最小）の算出と、残存があれば `SetAlarm(最早)`、残存ゼロなら `ClearAlarm` を返す単一関数。開始・キャンセル・発火・rehydrate のすべてがこの一関数を通す（重複の根絶）
    - _Requirements: 2.1, 2.2, 2.4, 2.9, 3.2, 3.3, 3.4, 3.5, 6.3, 6.4, 7.2, 7.7_

  - [x]* 4.2 単一 Alarm の正しさの property テストを書く
    - **Property 3: Alarm は常に残存最早に一致するか、残存ゼロなら ClearAlarm**
    - **Validates: Requirements 2.1, 2.2, 2.4, 2.9, 3.2, 3.3, 3.4, 3.5, 6.3, 6.4, 7.2, 7.7**

- [x] 5. core: タイマー開始
  - [x] 5.1 validateStart / startTimer を実装する
    - `core/start.ts`: 茹で時間 1〜1800 秒・`slotId`/`noodleType` 定義の検証とブランド型昇格、容量検査（100 件上限）、`endTime = now + boilSeconds*1000` 算出、Timer 追加。成功時 Effect は `[Persist, SetAlarm, Broadcast(started), Reply(started)]`（Persist 先頭）、拒否時は状態不変で `Rejection`
    - `newTimerId` は入力として受け取り core を決定的に保つ（`crypto.randomUUID()` を core に持ち込まない）
    - _Requirements: 1.1, 1.2, 1.5, 3.1, 3.8_

  - [x]* 5.2 開始時の endTime 算出の property テストを書く
    - **Property 14: 開始した Timer の endTime は now + boilSeconds*1000 に一致する**
    - **Validates: Requirements 1.1, 1.2**

  - [x]* 5.3 開始拒否（範囲外・未定義）の property テストを書く
    - **Property 7: 茹で時間範囲外・未定義 slot/noodle の開始は拒否され状態不変**
    - **Validates: Requirements 1.5**

  - [x]* 5.4 容量上限の property テストを書く
    - **Property 6: 容量上限を超えて Timer は増えない**
    - **Validates: Requirements 3.1, 3.8**

- [x] 6. core: キャンセル
  - [x] 6.1 cancelTimer を実装する
    - `core/cancel.ts`: 対象 Timer を除去（存在しなければ `TimerNotFound` で状態不変）。成功時 Effect は `[Persist, (SetAlarm|ClearAlarm), Broadcast(cancelled), Reply(cancelled)]`。キャンセル済み Timer はその後の発火対象に現れない
    - _Requirements: 6.1, 6.3, 6.4, 6.5, 6.6_

  - [x]* 6.2 非存在キャンセルの property テストを書く
    - **Property 8: 存在しない timerId のキャンセルは拒否され状態不変**
    - **Validates: Requirements 6.6**

  - [x]* 6.3 結果集合が部分集合であることの property テストを書く
    - **Property 10: 発火・キャンセル後の Timer 集合は元集合の部分集合**
    - **Validates: Requirements 6.5**

- [x] 7. core: 一括ドレイン発火と rehydrate 整合
  - [x] 7.1 fireDueTimers / reconcile を実装する
    - `core/fire.ts`: `endTime ≤ now + ε` の全 Timer を `(endTime, seq)` 昇順で一括処理して除去、`nextAlarmEffect(残存)` で Alarm 張り直し/解除、`done` を昇順で Broadcast。Effect は `Persist` 先頭。`reconcile` は同形で rehydrate 直後の整合に用いる。残存最早は構造的に必ず `now + ε` より未来（無限スルー防止）
    - _Requirements: 2.3, 2.5, 2.8, 2.9, 2.10, 3.3, 3.4, 3.6, 7.6, 7.7_

  - [x]* 7.2 一括ドレインの property テストを書く
    - **Property 4: 一括ドレイン後、due は消滅し残存最早は必ず now+ε より未来**
    - **Validates: Requirements 2.3, 2.8, 2.10, 3.3, 7.6**

  - [x]* 7.3 発火の冪等性の property テストを書く
    - **Property 5: fireDueTimers は冪等的に安定（at-least-once 多重発火への安定性）**
    - **Validates: Requirements 2.6**

  - [x]* 7.4 処理順序の property テストを書く
    - **Property 11: 茹で上がりの処理順は endTime 昇順（同一は seq 順）**
    - **Validates: Requirements 3.6**

- [x] 8. core: decide 統合（唯一の入口）
  - [x] 8.1 decide ディスパッチを実装する
    - `core/decide.ts`: イベント種別で `startTimer` / `cancelTimer` / `fireDueTimers` / `reconcile` へディスパッチする唯一の状態遷移関数。Effect 列は常に `Persist` 先頭の不変条件を保つ
    - _Requirements: 8.1, 8.4, 8.7_

  - [x]* 8.2 Effect 列の SSOT 規律の property テストを書く
    - **Property 2: Effect 列は常に Persist を先頭に持つ（SSOT 規律）**
    - **Validates: Requirements 8.1, 8.7**

  - [x]* 8.3 状態が残り秒を持たないことの property テストを書く
    - **Property 1: 状態は残り秒を持たない（導出値が状態に昇格していない）**
    - **Validates: Requirements 10.1**

  - [x]* 8.4 decide の決定性の property テストを書く
    - **Property 12: decide は決定的（純粋性）**
    - **Validates: Requirements 8.4**

- [x] 9. チェックポイント — core の全テストが通ることを確認
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. shell: Effect インタプリタ（runEffects）
  - [x] 10.1 DO クラス骨格と runEffects を実装する
    - `shell/store-timer-do.ts`: `import { DurableObject } from "cloudflare:workers"`、`constructor(ctx, env)`。core が返す Effect 列を先頭から順に実行する `runEffects`。`Persist` は `await ctx.storage.put(SNAPSHOT_KEY, snapshot)` で確定を保証し、成功後にのみ後続 `SetAlarm`/`ClearAlarm`/`Broadcast`/`Reply` を実行。put 失敗時は後続を実行せず Working_Copy を put 前へ戻す
    - 単一キー（`"activeTimers"`）丸ごと put のみ。`ctx.storage.sql` を使わない
    - _Requirements: 8.1, 8.4, 8.5, 3.7_

  - [ ]* 10.2 runEffects の SSOT 規律の統合テストを書く
    - `storage.put` の成功/失敗をモックし、(a) put 成功時のみ Broadcast/SetAlarm が実行される、(b) put 失敗時は後続 Effect 不実行・Working_Copy が put 前へ戻ることを検証
    - _Requirements: 8.4, 8.5, 3.7_

- [x] 11. shell: rehydrate 配線（ensureLoaded / blockConcurrencyWhile）
  - [x] 11.1 ensureLoaded と constructor の rehydrate を実装する
    - `shell/store-timer-do.ts`: `ctx.blockConcurrencyWhile` で初期化を囲い、`ensureLoaded` が `storage.get("activeTimers")` → `migrate` → `fromSnapshot` で Working_Copy を再構築。各エントリポイントの前段でロードを保証。snapshot 不在は空状態（Alarm 設定なし）、読み出し失敗は確定せず throw（再初期化に委ねる）。ロード後 `reconcile` を 1 回適用し Effect を実行
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 8.6_

  - [ ]* 11.2 rehydrate 配線の統合テストを書く
    - 未ロード時に `get → migrate → fromSnapshot` を通すこと、読み出し失敗時に状態を確定せずエラーにすること、snapshot 不在で空初期化することを検証
    - _Requirements: 7.1, 7.4, 7.5, 8.6_

- [x] 12. shell: Alarm 配線
  - [x] 12.1 alarm() ハンドラを実装する
    - `shell/store-timer-do.ts`: `alarm(alarmInfo)` で `ensureLoaded` 後に `decide(state, {type:"AlarmFired", now})` を呼び Effect を実行。`storage.setAlarm`/`getAlarm`/`deleteAlarm` を Effect から写す。put 失敗時は throw して at-least-once リトライに委ね、`retryCount` 上限近傍では throw せず `setAlarm(Date.now()+30s)` で張り直す。`ctx.id.name` で店舗 ID を参照
    - _Requirements: 2.3, 2.4, 2.7, 2.8, 2.9, 2.10, 3.3, 3.4_

  - [ ]* 12.2 Alarm 配線の統合テストを書く
    - Alarm 発火で due 一括処理 → done broadcast → 残存最早へ張り直し（残存 0 で解除）を検証。多重発火（同一 now で 2 回）で状態が壊れないことを確認
    - _Requirements: 2.5, 2.6, 3.4_

- [-] 13. shell: WebSocket Hibernation 収容・hydration・broadcast
  - [x] 13.1 fetch での acceptWebSocket 収容と hydration 全量送信を実装する
    - `shell/store-timer-do.ts`: `fetch` で `new WebSocketPair()` を作り `this.ctx.acceptWebSocket(server)` で受理（`server.accept()` は使わない）。受理直後に現在アクティブな全 Timer を `snapshot` メッセージで当該 WS へ全量送信（`serverTime = Date.now()` 付与）
    - _Requirements: 4.1, 9.2_

  - [x] 13.2 webSocketMessage / webSocketClose / broadcast を実装する
    - `shell/store-timer-do.ts`: `webSocketMessage` で `ClientMessage` をパースし core を呼び Effect 実行。不正形式メッセージは破棄して Working_Copy 不変。`webSocketClose` で接続管理から除去（接続集合は `ctx.getWebSockets()` を正とし隠れ状態を持たない）。`Broadcast` は `ctx.getWebSockets()` を走査して全 WS へ送信、送信失敗は握り潰さず再接続 hydration に委ねる。担当分割には関与せず全 WS を等価に扱う（`serializeAttachment` 不使用）。秒読み目的の setInterval/終わらない setTimeout を持たない
    - _Requirements: 1.3, 2.5, 2.6, 6.2, 9.3, 9.4, 9.7, 12.6_

  - [ ]* 13.3 WebSocket Hibernation の統合テストを書く
    - 接続確立で全量 snapshot を受信、メッセージ処理、close での除去、複数 WS への broadcast 到達、不正形式メッセージ破棄を検証
    - _Requirements: 4.1, 9.2, 9.3, 9.4, 9.7_

- [x] 14. Worker エントリ（ルーティング・APAC 配線・静的配信）
  - [x] 14.1 Worker エントリと DO 委譲・静的アセット配信を実装する
    - `src/worker.ts`: Hono の極薄エントリ。WebSocket アップグレード要求を検証し、不正な Upgrade は 426 で拒否して DO へ引き渡さない。正当な要求は `namespace.idFromName(店舗ID)` → `namespace.get(id, { locationHint: "apac-ne" })` で stub を引いて `fetch` を委譲。React 静的アセットを同一オリジンで配信。業務ロジックは持たない
    - _Requirements: 9.1, 9.6_

  - [ ]* 14.2 アップグレード拒否の example テストを書く
    - 不正な Upgrade ヘッダの要求が 426 で拒否され DO へ引き渡されないことを確認
    - _Requirements: 9.6_

- [x] 15. チェックポイント — shell / Worker の配線テストが通ることを確認
  - Ensure all tests pass, ask the user if questions arise.

- [x] 16. client: 残り時間の純粋導出と書式
  - [x] 16.1 クロックオフセット導出と残り算出を実装する
    - `client/clock.ts`: `offset = serverTime - localReceipt`、`remaining = max(0, endTime - (Date.now() + offset))`（負を出さない）。残り秒は状態として持たず描画のたびに導出。切断中は最新 offset を使い続けてローカル再算出（サーバへ問い合わせない）
    - _Requirements: 4.3, 4.4, 5.1, 5.2, 5.3, 10.3, 10.4_

  - [x]* 16.2 残り算出のクランプの property テストを書く
    - 任意の `endTime`/`serverTime`/`localReceipt`/現在時刻について残りが常に 0 以上、補正後現在時刻 ≥ endTime で必ず 0 になることを検証
    - _Requirements: 4.3, 4.4, 5.1, 5.6, 10.3, 10.4_

  - [x] 16.3 formatRemaining（MM:SS 整形）を実装する
    - `client/format.ts`: 非負ミリ秒を MM:SS・最小単位 1 秒で整形、負を出さない
    - _Requirements: 5.4, 5.6_

  - [x]* 16.4 MM:SS 整形の property テストを書く
    - 任意の非負ミリ秒で MM:SS 形式・最小単位 1 秒・負なしを検証
    - _Requirements: 5.4_

- [x] 17. client: 担当スロット絞り込み（表示スコープの純粋導出）
  - [x] 17.1 slotsOfUnits / isAssigned / assignedTimers を実装する
    - `client/assignment.ts`: `slotOf(slotId) = Number(slotId)`（恒等対応）、unit u は slot `6u..6u+5`。受信した全量 Timer を保持し、表示は `assignedTimers` の純粋導出として絞り込む（保持は全量・表示は導出）
    - _Requirements: 12.2, 12.5_

  - [x]* 17.2 担当絞り込みの property テストを書く
    - **Property 15: 担当絞り込みは健全かつ完全（クライアント表示スコープ）**
    - **Validates: Requirements 12.2, 12.5**
    - 部分集合性・担当性・完全性、`slotsOfUnits([u]) == {6u..6u+5}`、`isAssigned(slot, units) == (slot ∈ slotsOfUnits(units))` を同テストで確認

- [x] 18. client: 通知の冪等性（重複 done / cancelled の無視）
  - [x] 18.1 shouldHandleDone / markProcessed を実装する
    - `client/notification.ts`: 処理済み `timerId` 集合に基づき処理可否を判定する純粋関数。判定は `timerId` 基準（Slot 単位ではない）。サーバ状態（SSOT）を一切変更しない表示制御用ローカル情報
    - _Requirements: 2.11, 2.12, 2.13, 6.8_

  - [x]* 18.2 通知冪等性の property テストを書く
    - **Property 16: 通知の冪等性 — 各 timerId につき高々 1 回だけ処理**
    - **Validates: Requirements 2.11, 2.12, 6.8**
    - 重複・done/cancelled 混在列を畳み込み、各 timerId で `shouldHandleDone` が高々 1 回 true、登録後は以後 false、異なる timerId は相互不干渉を検証

- [x] 19. client: WebSocket 接続と状態同期
  - [x] 19.1 WS クライアントと snapshot 全置換・offset 再確立・刈り取り・同期失敗を実装する
    - `client/connection.ts`: WS 接続管理。`snapshot` 受信で保持 Timer 集合を全置換し offset を再確立、非アクティブ済み `timerId` を処理済み記録から刈り取り。`started`/`cancelled`/`done`/`error` を上記純粋関数（clock/assignment/notification）に通して処理。接続確立から 2 秒以内に snapshot 未受信なら同期失敗表示し既存表示を保持して再接続。1000ms 以下間隔で残り再算出
    - _Requirements: 1.4, 4.1, 4.2, 4.5, 4.6, 6.7, 10.5, 10.6_

  - [x]* 19.2 状態同期と切断継続の example テストを書く
    - snapshot 全置換・含まれない Timer 除去、同期失敗（2 秒未受信）、切断中に offset 固定でローカルのみ進めて再算出が継続しサーバ通信が発生しないことを確認
    - _Requirements: 4.2, 4.5, 4.6, 5.2, 5.3, 5.5_

- [x] 20. client: UI（カウントダウン表示・担当 UI・操作）
  - [x] 20.1 カウントダウン表示・担当 UI 制限・開始/キャンセル操作を実装する
    - `client/components/`: 担当スロットの Timer のみ表示（担当外は `assignedTimers` で除外）。開始・キャンセル操作 UI を担当スロットにのみ提示。残り 0 以下は 00:00 固定の茹で上がり相当表示、endTime 未受信は「残り時間未受信」表示。担当ユニット（1 or 2 ユニット）はユーザー明示再指定でのみ更新（接続台数で不変）。UI コンテンツは英語
    - _Requirements: 5.5, 5.6, 12.1, 12.3, 12.4_

  - [x]* 20.2 担当 UI と担当不変の example テストを書く
    - 担当スロットにのみ操作 UI が描画され担当外に操作手段が出ないこと、WS 接続台数増減で担当ユニット集合が不変であることを確認
    - _Requirements: 12.3, 12.4_

- [x] 21. チェックポイント — クライアントのテストが通ることを確認
  - Ensure all tests pass, ask the user if questions arise.

- [x] 22. 統合検証と静的検査
  - [x] 22.1 静的検査（setInterval/setTimeout 不在・acceptWebSocket・sql 不使用）を実装する
    - `tests/` に静的検査（lint ルールまたはソース grep スクリプト）を実装。core / StoreTimerDO に秒読み目的の `setInterval`・終端のない `setTimeout` ループが存在しないこと、`ctx.acceptWebSocket` を使い `server.accept()` を使わないこと、`ctx.storage.sql` を使わず put/get のみであることを検証
    - _Requirements: 8.2, 9.2, 9.5_

  - [ ]* 22.2 2〜3 台同時反映の統合テストを書く
    - 複数 WS クライアントを接続し、1 台の `start`/`cancel` が他の全クライアントへ 1000ms 以内に届くことを確認
    - _Requirements: 1.3, 6.2_

  - [ ]* 22.3 hibernate 後発火・多重発火冪等の統合テストを書く
    - hibernate 後に Alarm 発火で `done` がブロードキャストされること、発火遅延の実測、多重発火時に `fireDueTimers` 冪等性で状態が壊れないことを確認
    - _Requirements: 2.5, 2.6, 2.7_

  - [ ]* 22.4 切断・再接続復元（Hydration）の統合テストを書く
    - WS 切断・再接続後、接続直後に全量 snapshot を 2 秒以内に受信し表示が追いつくことを確認
    - _Requirements: 4.1, 4.2, 4.3_

  - [ ]* 22.5 複数タイマー並走の単一 Alarm 張り直しの統合テストを書く
    - 時刻差のある複数 Timer を並走させ、発火・キャンセルのたびに Alarm が残存最早へ張り直され、残存 0 で解除されることを確認
    - _Requirements: 3.2, 3.3, 3.4, 6.3, 6.4_

  - [ ]* 22.6 broadcast / put 確定（fsync）レイテンシ実測の統合テストを書く
    - Output Gate と明示 `await` の二重がけ下で broadcast が put 確定後に出ることを前提に、put 確定レイテンシ込みで要件 1.3／6.2 の 1000ms 以内を満たすか実測
    - _Requirements: 1.3, 6.2_

- [x] 23. 最終チェックポイント — 全テストと静的検査が通ることを確認
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- `*` を付したサブタスクは省略可能（MVP を急ぐ場合スキップ可）。トップレベルタスクには `*` を付さない。
- 各タスクは特定の要件（granular な受け入れ基準）を参照し、トレーサビリティを保つ。
- 各 Correctness Property（P1〜P16）は単一の property テストとして実装し、最低 100 回反復、`Feature: yude-men-timer, Property N: ...` のタグコメントを付す。
- core を先に完成・テストしてから shell の配線へ進む（純粋部分の早期検証）。core は `cloudflare:workers`・storage に依存しない。
- SSOT 規律（Persist 先頭・put 成功が確定の起点）、「待つなら寝かせる（setInterval を持ち込まない）」、KV のみ・SQL 不使用、を全タスクで破らない。
- Property テストは PBT ライブラリ（fast-check）を用い、自前実装しない。
- タイミング保証・プラットフォーム挙動・UI の見た目は Integration / Example / 静的検査で検証する。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2"] },
    { "id": 3, "tasks": ["3.1", "3.3", "4.1", "16.1", "16.3", "17.1", "18.1"] },
    { "id": 4, "tasks": ["3.2", "3.4", "4.2", "5.1", "6.1", "7.1", "16.2", "16.4", "17.2", "18.2"] },
    { "id": 5, "tasks": ["5.2", "5.3", "5.4", "6.2", "6.3", "7.2", "7.3", "7.4", "8.1", "19.1"] },
    { "id": 6, "tasks": ["8.2", "8.3", "8.4", "10.1", "19.2"] },
    { "id": 7, "tasks": ["10.2", "11.1", "20.1"] },
    { "id": 8, "tasks": ["11.2", "12.1", "20.2"] },
    { "id": 9, "tasks": ["12.2", "13.1"] },
    { "id": 10, "tasks": ["13.2"] },
    { "id": 11, "tasks": ["13.3", "14.1"] },
    { "id": 12, "tasks": ["14.2", "22.1"] },
    { "id": 13, "tasks": ["22.2", "22.3", "22.4", "22.5", "22.6"] }
  ]
}
```
