# Implementation Plan

前提：main（#33 まで）。永続の版は上げない（v12 のまま）。`plan-stability` と同じ進め方（task ごとに `[-]` → `[x]` と実測・チェックポイント・コミット）。

- [x] 0. naming ゲート（design の表）をユーザーが承認する（2026-09-06 承認：`liveOrders` / `ORDER_LIFETIME_MS` / `livePending`）
  - `liveOrders` / `ORDER_LIFETIME_MS`（`src/domain/order.ts`）、`livePending`（client 局所）

- [ ] 1. 述語と定数（domain）
  - [ ] 1.1 `src/domain/order.ts` に `ORDER_LIFETIME_MS`（2 時間）と `liveOrders(pending, now)` を置く（並びを保つ・半開区間・全件期限内なら同じ参照）
  - [ ] 1.2 `tests/domain/order.example` / `order.property`：冪等・単調・並び保持・境界・同じ参照（性質 5.1〜5.3）
  - _Requirements: 1.1〜1.5_

- [ ] 2. engine の入口
  - [ ] 2.1 `planTargets(pending, now)`（絞ってから切る）。`baselineSchedule` / `buildSchedule` に `now` を足し、`committedSchedule` / `admit` / `digestInput(pending, running, params, now)` / `settle` の要求抑制へ通す
  - [ ] 2.2 `snapshotMessage`：`pendingOrders` を `liveOrders(state.pendingOrders, now)` にする（Broadcast と hydration の両方）
  - [ ] 2.3 `ChangeContext.pending` を 4 入口で絞る：`settle.deriveRecommendations` / `plan.receivePlan` / `admit`（冒頭で `liveOrders(pending, now)`・文脈と採点と `planTargets` の全部に使う）/ `src/solver`（`request.pending` を自分の `now` で）。混在の例示（期限切れの旧先頭 A・生きている B・B を 1 秒遅らせる計画の変更費用が 2L = 90 秒、A を残すと 0）を 4 入口で固定
  - [ ] 2.4 `start.ts` の照合を `liveOrders(state.pendingOrders, args.now)` に替える（消費は正本に対して）
  - [ ] 2.5 テスト：`schedule.example` / `schedule.property`（性質 5.4 枠）、`settle-*.example`（性質 5.5 一致・hydration）、`plan.example` / `admit.example`（期限切れを指す一片は `isStale`・要求に乗らない）、`start-order-item.example`（`OrderItemNotFound`・`now` だけ違う 2 本）、`stability.example`（対応から外れて費用 0）、性質 5.6（無害）・5.7（不変）
  - [ ] 2.6 チェックポイント（typecheck / lint 0 errors / test / fmt:check）とコミット
  - _Requirements: 2.1〜2.8_

- [ ] 3. client の入口
  - [ ] 3.1 `queueDisplay.ts` に `livePending(view, corrected)`（補正済みを受ける・内部で補正しない）を置き、`orderQueueEntries(view, units, now)` は境界として `corrected` を 1 回計算して `livePending` と `suggestedItemOf(view, recommendation, corrected)` を呼ぶ。`liftGroups(view, corrected)` は持っている `corrected` をそのまま渡す（時刻の引数名は `now`＝ローカル・`corrected`＝補正済みで固定）
  - [ ] 3.2 テスト：`order-queue.*` / `liftGroups.*` / `radial-queue.*`——snapshot 直後は残り、`correctedNow` が寿命を跨ぐと左レールとラジアルから消える（性質 5.8）。**非ゼロの `offset`** で左レールと釜の提案が同じ品目集合を生きているとみなす一致テスト（境界の 1 ms 前後で同時に切り替わる）
  - [ ] 3.3 チェックポイントとコミット
  - _Requirements: 3.1〜3.3_

- [ ] 4. 走行中の独立（テストだけ・構造は変えない）
  - [ ] 4.1 `tests/core` に性質 5.9：Timer・設定・`now`・操作を固定し、待ち行列の `arrivalTime` だけを寿命以上過去へ動かした二状態に、両状態で同じに成立する操作（発火・完了・調整・キャンセル・Boil_Sync・アドホック開始・Record 受理・外部計画の受領・hydration）を与え、`timers`・実効 endTime・Alarm 効果・`tableMembers` が等しい。`StartOrderItem` は含めない（期限切れ品目の開始拒否は 2.5 の例示で別に見る）
  - _Requirements: 4.1〜4.4, 5.9_

- [ ] 5. 文書と最終ゲート
  - [ ] 5.1 `online-cook-scheduling`（計画対象の定義に `now`・snapshot の待ち行列は Live_Orders）と `pos-order-ingress`（`arrivalTime` が期限の起点になった）に日付付きの注記。`lift-group-display` design に client の入口の注記
  - [ ] 5.2 ADR-0011：正本を変えず純粋関数で絞った値を正とする（Alarm を張らない・永続を触らない・走行中は独立）。Considered Options：状態からの除去（Alarm）・受理時に弾く・設定化
  - [ ] 5.3 全数チェックポイント（typecheck / lint 0 errors / test / fmt:check）
