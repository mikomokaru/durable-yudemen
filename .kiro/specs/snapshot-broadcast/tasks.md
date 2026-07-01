# Implementation Plan: snapshot 単一表現によるブロードキャスト（snapshot-broadcast）

## Overview

これは server→client メッセージ契約の **引き算（subtractive）リファクタ**である。per-timer の意味論 `ServerMessage`（`started` / `cancelled` / `completed` / `boiled` / `adjusted`）と `Effect` の `Reply` を撤去し、確定変化ごとに全 client へ単一の権威 `snapshot` を broadcast する。client の reducer は `snapshot` / `config` / `error` の 3 分岐へ畳み、タイマー反映は「server-confirmed の全置換＋差分による一様残滓」に集約する。これにより確定済みの **bug#1**（Reply が snapshot より後着して要求元の未同期 endTime で上書きする）を構造的に消滅させる。

実装は依存順（domain 契約 → engine → shell → client → テスト）で進める。本リファクタは複数ファイルにまたがる協調的な型変更であり、個々の下位タスクの途中では型エラーが残りうる。**typecheck / lint / test の green はクラスタ末尾のチェックポイントで担保する**（各チェックポイントで `pnpm typecheck` / `pnpm lint` / `pnpm test`（= `vitest --run`）を実行し、watch は使わない）。engine/domain のテストは既定 pool、shell/DO のテストは Workers pool（`@cloudflare/vitest-pool-workers` の `cloudflareTest()`）で走る。

**スコープ外**：近接同時茹で上がりの maximin 終了調整アルゴリズム挙動（別 spec `synchronized-boil-adjustment`）は本計画に含めない。

## Tasks

- [x] 1. 公開シンボルの確認ゲート（naming.md・実装前にユーザー確認）
  - コードを書く前に、次の公開シンボル変更をユーザーへ提示して確定する（`naming.md`「公開シンボルの命名は実装前にユーザー確認を要する」）。承認が得られるまで後続タスクへ進まない。
  - **`ServerMessage.type` の撤去集合**：`started` / `cancelled` / `completed` / `boiled` / `adjusted`。**存置集合**：`snapshot` / `config` / `error`。
  - **`Effect` の `Reply` 種別の撤去**（本変更後どこからも生成されない）。
  - **`settle` / `assembleEffects` のシグネチャ変更**：`trigger`（意味論列）引数と `replyTo`（Reply 宛先）引数の撤去。
  - **`reconcileServerConfirmed` のシグネチャ変更**：残滓記録時刻 `at` の追加（関数名・概念境界は不変）。
  - **`snapshot` / `TimerFact` への新フィールド追加なし**を推奨（純粋 client 差分で残滓を復元可能）。この推奨の承認可否を確認する。
  - _Requirements: 1.3, 1.5, 3.3, 4.6, 8.3_

- [x] 2. 契約の縮退と engine の単一 snapshot 化（domain + engine）
  - [x] 2.1 `domain/messages.ts` の `ServerMessage` を snapshot/config/error へ縮退
    - `started` / `cancelled` / `completed` / `boiled` / `adjusted` の 5 種を判別共用体から撤去し、`snapshot` / `config` / `error` の 3 種のみを残す。
    - `ClientMessage` は不変。`snapshot` は `timers: readonly TimerFact[]`（全量）を保持する形を維持する。
    - _Requirements: 1.3, 2.3, 2.4_

  - [x] 2.2 `engine/effect.ts` から `Reply` 種別を撤去
    - `Effect` 判別共用体を `Persist` / `SetAlarm` / `ClearAlarm` / `Broadcast` の 4 種のみへ縮退する。
    - _Requirements: 1.5_

  - [x] 2.3 `engine/settle.ts` の `assembleEffects` を単一 snapshot 化し `settle` から `trigger`/`replyTo` を撤去
    - `settle(prev, moved, params, now)` へシグネチャ変更（`trigger` / `replyTo` 引数を削除）。
    - `assembleEffects(nextState, now)` を `[Persist, SetAlarm|ClearAlarm, Broadcast(snapshot)]` へ縮退し、意味論 Broadcast と Reply の生成を撤去する（Broadcast はちょうど 1 個・`type === "snapshot"`）。
    - no-op 検出（`isSameConfirmedResult`）・Persist 先頭・実効 endTime の `toWireTimer` 射影は不変で維持する。
    - _Requirements: 1.1, 1.2, 1.4, 7.1, 7.5_

  - [x] 2.4 `engine/{start,cancel,complete,fire,adjust}.ts` から意味論 `ServerMessage` 構築を撤去
    - 各遷移で `started` / `cancelled` / `completed` / `boiled`（`boiledBroadcasts`）/ `adjusted` の構築を削除し、`settle(state, moved, params, now)` を呼ぶだけにする。
    - 未使用化する `toWireTimer` import（`start.ts` / `adjust.ts`）と意味論並べ替え（`fire.ts` の `byAdjustedEndTimeThenSeq` / `boiledBroadcasts`）を撤去する。基底の集合変更・拒否経路・固定点反復は不変。
    - _Requirements: 1.1, 1.4, 3.1, 3.2, 3.3_

  - [x]* 2.5 engine の Effect 列に対する property test（Property 1）
    - **Property 1: 単一表現（SSOT）** — 確定変化を生む任意の遷移で、`effects` の `Broadcast` はちょうど 1 個かつ `message.type === "snapshot"`、`Reply` は一切含まれない。`Persist` が先頭。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: snapshot-broadcast, Property 1: 単一表現（SSOT）`。
    - 配置 `tests/core/settle.property.test.ts`（既定 pool）。
    - _Validates: Requirements 1.1, 1.4, 7.1_

  - [x]* 2.6 snapshot サイズ有界の property test（Property 8）
    - **Property 8: サイズ有界** — `|JSON(snapshot)|` は TimerFact 件数（0〜MAX_TIMERS）に対し単調非減少で、`MAX_TIMERS` 時を上限として超えない。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: snapshot-broadcast, Property 8: サイズ有界`。
    - 配置 `tests/core/settle.property.test.ts`（既定 pool）。
    - _Validates: Requirements 6.3_

- [x] 3. チェックポイント — engine/domain の green を確認
  - `pnpm typecheck` / `pnpm lint` / `pnpm test`（`vitest --run`）を実行し、engine/domain の型・静的解析・テストが通ることを確認する。問題があればユーザーに相談する。

- [x] 4. shell の broadcast 経路の縮退（`shell/store-timer-do.ts`）
  - [x] 4.1 `runEffects` / `applySideEffect` から `replyTo` 引き回しと `Reply` 分岐を撤去
    - `runEffects(effects)` へ変更し、`webSocketMessage` / `alarm` の呼び出しから `ws`（replyTo）受け渡しを削除する。`applySideEffect` の `Reply` case を削除する。
    - 拒否（`InvalidBoilSeconds` / `InvalidSlotOrNoodle` / `CapacityExceeded`）と `adjust` 解決失敗（`TimerNotFound` / `UnknownNoodle`）の `error` は従来どおり要求元 WS へ直接 `ws.send`（`Reply` Effect を使わない）で送る。接続時の `config` → `snapshot` 初期送信、`emitSeam` の broadcast 継ぎ目、Persist-first の put 成功規律は不変。
    - _Requirements: 7.2, 7.3, 7.4, 8.1, 8.2, 8.3, 8.5, 8.6_

  - [x] 4.2 観測層の stale 参照を新契約へ移行（`observe/scenario.ts`）
    - `shouldStopAwaiting` ほかが撤去済み種別（`boiled` / `timerId` など）を参照している箇所を、新契約（`snapshot` / `config` / `error`）ベースの待機条件へ再定義する。`boiled` 撤去後は「snapshot から特定 Timer が消える／現れる」で待機を表現する。**観測 DSL の再定義は概念境界を含むため、着手前に再定義方針をユーザーへ確認する。**
    - _Requirements: 1.3, 2.3_

  - [x] 4.3 撤去済み契約を参照する stale テストを新契約へ移行
    - `tests/client/generators.ts`（`genServerMessage` が旧種別を生成）、`tests/core/fire.property.test.ts`（`boiled` 参照）、`tests/offline-degradation.static.test.ts`（`WIRE_MESSAGE_TYPES` が旧10種集合を期待）、`tests/client/complete.example.test.ts` / `tests/client/connection.example.test.ts`（`completed` / `boiled` を送信）を、新契約（`snapshot` / `config` / `error`）へ更新する。旧種別を送信・生成・期待する記述を snapshot ベースへ置換する。
    - _Requirements: 1.3, 2.3, 2.4_

- [x] 5. client reducer の一本化と差分による一様残滓（`client/connection.ts`）
  - [x] 5.1 `decideServerMessage` を 3 分岐へ縮退し `reconcileServerConfirmed` に差分残滓を統合
    - `decideServerMessage` を `snapshot` / `config` / `error` のみへ縮退し、`started` / `cancelled` / `completed` / `boiled` / `adjusted` の分岐を撤去する。3 種すべてで `offset = clockOffset(serverTime, receivedAt)` を更新する。
    - `reconcileServerConfirmed(view, serverTimers, at)` へシグネチャ変更し、design 擬似コードのとおり (a) server-confirmed 全置換・provisional 保持、(b) 消えた Timer から再占有されない slotId へ `noodleType` と `at` を残滓記録、(c) 占有スロットの残滓消去、(d) `processedIds` 刈り取り、を実装する。boiled/running・アラート dedup は `endTime` からの導出を維持し状態へ昇格させない。
    - `snapshot` 受信および `Reconcile` イベントの呼び出しへ `receivedAt`（= `at`）を配線する。冪等（同一 `serverTimers` の二度適用で新規残滓を生まない）を満たす。
    - _Requirements: 2.1, 2.2, 2.5, 2.6, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 5.1, 5.3_

  - [x] 5.2 degraded 経路の `LocalCancel` を一様残滓化
    - `decideLocalCancel` を `LocalComplete` と同一手順にし、除去直前の `noodleType` を再占有されない slotId へ受信時刻 `at` とともに残滓記録する。端（`openTimerConnection`）の `cancel` 経路で `LocalCancel` に時刻を運ぶ配線を整える。
    - _Requirements: 5.2, 5.3_

  - [x]* 5.3 一様残滓の property test（Property 3）
    - **Property 3: 残滓の一様性** — 連続 2 snapshot 間で消えた任意の Timer `t`（Cancel / Complete / Fire→Complete いずれの理由でも）について、再占有されない各 slotId に `lastResults[slotId].noodleType === t.noodleType`。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: snapshot-broadcast, Property 3: 残滓の一様性`。
    - 配置 `tests/client/reconcile.property.test.ts`（既定 pool）。
    - _Validates: Requirements 4.2, 5.1_

  - [x]* 5.4 残滓クリアの property test（Property 4）
    - **Property 4: 残滓のクリア** — 新 snapshot（＋保持 provisional）が占有する任意の slotId に `lastResults` エントリは存在しない。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: snapshot-broadcast, Property 4: 残滓のクリア`。
    - 配置 `tests/client/reconcile.property.test.ts`（既定 pool）。
    - _Validates: Requirements 4.3, 5.3_

  - [x]* 5.5 純粋差分の property test（Property 5）
    - **Property 5: 純粋差分（新フィールド不要）** — `reconcileServerConfirmed` の出力は `(直前 server-confirmed, 新 serverTimers, at)` のみの関数であり、`TimerFact` の追加フィールドに依存しない。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: snapshot-broadcast, Property 5: 純粋差分（新フィールド不要）`。
    - 配置 `tests/client/reconcile.property.test.ts`（既定 pool）。
    - _Validates: Requirements 4.6_

  - [x]* 5.6 冪等性の property test（Property 6）
    - **Property 6: 冪等性** — 同一 `serverTimers` を二度適用すると `timers`・`processedIds` は不変、`lastResults` はキー集合不変（`at` 更新のみ）で新規残滓を生じない。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: snapshot-broadcast, Property 6: 冪等性`。
    - 配置 `tests/client/reconcile.property.test.ts`（既定 pool）。
    - _Validates: Requirements 4.5_

  - [x]* 5.7 offset 再確立の property test（Property 7）
    - **Property 7: offset 再確立** — `snapshot` / `config` / `error` の受信ごとに `offset = clockOffset(serverTime, receivedAt)` が更新される。
    - fast-check・`numRuns: 100` 以上。タグ `Feature: snapshot-broadcast, Property 7: offset 再確立`。
    - 配置 `tests/client/reconcile.property.test.ts`（既定 pool）。
    - _Validates: Requirements 2.5_

- [x] 6. チェックポイント — shell/client の green を確認
  - `pnpm typecheck` / `pnpm lint` / `pnpm test`（`vitest --run`）を実行し、全レイヤの型・静的解析・テストが通ることを確認する。問題があればユーザーに相談する。

- [x] 7. 収束一致と bug#1 回帰の検証（engine + client シミュレーション）
  - [x]* 7.1 収束一致の property test（Property 2）
    - **Property 2: bug#1 の消滅（収束一致）** — 任意の start 直後、要求元 client と非要求元 client が同一順序の broadcast（snapshot）列を適用すると、両者の server-confirmed 集合は `snapshot.timers` に完全一致し、相互にも同一になる（要求元だけがズレる経路が存在しない）。
    - engine（`startTimer` → `settle`）と client（`decideView` の snapshot 適用）を結線したシミュレーションで検証する。fast-check・`numRuns: 100` 以上。タグ `Feature: snapshot-broadcast, Property 2: bug#1 の消滅（収束一致）`。
    - 配置 `tests/client/convergence.property.test.ts`（既定 pool）。
    - _Validates: Requirements 3.1, 3.2, 3.4_

  - [x]* 7.2 bug#1 回帰 example テスト
    - 「2 本同期茹での 2 本目 start」を engine + client シミュレーションで再現し、要求元 client が受ける Timer の `endTime` が snapshot（同期済み・実効 endTime）と一致することを確認する（変更前の Reply 経路なら未同期 endTime で不一致になった）。要求元と非要求元の集合が一致することも併せて確認する。
    - 配置 `tests/client/convergence.property.test.ts`（既定 pool・example ケース）。
    - _Validates: Requirements 3.1, 3.2, 3.4_

- [x] 8. 最終チェックポイント — 全テスト green を確認
  - `pnpm typecheck` / `pnpm lint` / `pnpm test`（`vitest --run`）を実行し、全タスク完了後に型・静的解析・全テスト（既定 pool の engine/domain/client、Workers pool の shell/DO）が通ることを確認する。問題があればユーザーに相談する。

## Notes

- `*` 付き下位タスクは property/example テストで、MVP 短縮時にスキップ可能（コア実装タスクは非 optional）。
- 本機能は引き算リファクタのため、個々の下位タスク途中では型エラーが残りうる。green の担保はチェックポイント（タスク 3 / 6 / 8）で行う。
- 各タスクは特定要件を参照し追跡可能。property test は design の 8 Correctness Properties を、example テストは bug#1 回帰を検証する。
- ツール規律（`tooling.md`）：`pnpm` / `Vitest v4`（`cloudflareTest()`）/ `oxlint` / `tsc --noEmit`。engine/domain は既定 pool、shell/DO は Workers pool。テストは `vitest --run`（watch を使わない）。
- 命名規律（`naming.md`）：公開シンボルの変更はタスク 1 のゲートで確定してから着手する。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["2.1", "2.2"] },
    { "id": 1, "tasks": ["2.3", "5.1"] },
    { "id": 2, "tasks": ["2.4", "5.2"] },
    { "id": 3, "tasks": ["4.1"] },
    { "id": 4, "tasks": ["4.2", "4.3"] },
    { "id": 5, "tasks": ["2.5", "2.6", "5.3", "5.4", "5.5", "5.6", "5.7", "7.1", "7.2"] }
  ]
}
```
