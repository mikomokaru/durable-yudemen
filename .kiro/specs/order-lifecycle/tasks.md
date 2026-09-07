# Implementation Plan

前提：main（#37 まで）。永続は v12 → v13。`startable-placement` と同じ進め方（task ごとに `[-]` → `[x]` と実測・チェックポイント・コミット）。`lift-order-numbering`（番号・卓・品名・中断の色分け）は本 spec の後に載せる。

- [ ] 0. naming ゲート（requirements の表 12 件 ＋ design の内部名）をユーザーが承認する

- [ ] 1. domain：`OrderItem` と導出
  - [ ] 1.1 `PendingOrder` → `OrderItem`（`completedAt` / `interruptedAt` を足す）、`refersTo` / `isLive`、`itemStatusOf` / `pendingOrders` / `orderItemsToBroadcast` / `orderItemOf`（`liveOrders` は `pendingOrders` の内側へ）。型の改名は src / tests 全体（機械的）
  - [ ] 1.2 `tests/domain/order.example` / `order.property`：性質 7.1（排他・boiled は cooking）・7.3′（中断は状態に効かない）・`pendingOrders` と `orderItemsToBroadcast` の境界（1 時間 59 分開始・2 時間 1 分）・`orderItemOf` の null
  - _Requirements: 1.2, 1.7, 3.1, 3.2, 7.1, 7.3′_

- [ ] 2. engine：状態・遷移・後着・永続
  - [ ] 2.1 `TimerState.orderItems`（旧 `pendingOrders`）、`snapshot.ts`、`migrate.ts` v13（`pendingOrders` → `orderItems`・欠如は null・壊れた要素だけ落とす）、`types.ts` 版、`docs/persisted-schema-rollback.md` v13 行（切戻しの注意：v13 で残した cooking / done が v12 では未着手として現れる）
  - [ ] 2.2 `start.ts`：`consumeOrder` 撤去・照合は `pendingOrders`・`OrderItemCooking`。`complete.ts`：参照先に `completedAt`。`cancel.ts`：参照先に `interruptedAt`（上書き）。参照先なしは書かない
  - [ ] 2.3 `pending.ts`：`upsertOrder` を「注文属性だけ更新・厨房の事実と生きた Timer を保持・arrivalTime 引継ぎ・後着に無い品目は unstarted だけ除く」に。`removeOrder`（`OrderCancelled`）も同じ規則。`isSamePending` → `isSameOrderItems`
  - [ ] 2.4 `settle.ts` / `plan.ts` / `admit.ts` / `digest.ts` / `receive.ts` / `order.ts`：`pendingOrders(...)` を読む。snapshot は `orderItemsToBroadcast`。`RequestPlan.pending` は `pendingOrders` の結果。`project.ts` `toWireTimer` に `orderItem`
  - [ ] 2.5 テスト：`start-order-item.*`（消費しない・`OrderItemCooking`・done / 期限切れ / 不在は `OrderItemNotFound`）、`complete` / `cancel` の記録（参照先なし・`arrivalTime` 不変）、一括完了の各品目、`pending.example` / `received-order.example`（Requirement 2 の回帰 6 件：A 調理中に {A, B} 再送で A が残る・done は戻らない・Cancel → 再送で `interruptedAt` 保持・再開始→完了で done・次の Cancel でだけ上書き・後着に無い品目は unstarted だけ除く）、`settle-*` / `digest` / `plan` / `admit` の読む集合、`migrate.*`（v12 → v13・往復・参照先なし Timer が動き完了しても書かない・再送で補われた後は書く）
  - [ ] 2.6 チェックポイントとコミット
  - _Requirements: 1.1, 1.3〜1.6, 2.1〜2.6, 3.3〜3.4, 4.1〜4.3, 6.1〜6.3, 7.2〜7.6, 7.8〜7.9′_

- [ ] 3. wire と shell
  - [ ] 3.1 `messages.ts` / `wire.ts` / `timer.ts`：snapshot の `orderItems`・`TimerFact.orderItem` の decode（形の検証・不正は snapshot ごと落とす）。`store-timer-do.ts` / `solver/request.ts` の名前の付け替え。Operation History の `TimerFact` 読み手が追加フィールドを無視できることを確認
  - [ ] 3.2 `tests/wire/*`：往復と関門。`timer-model.static`（鍵集合・inline snapshot v13）・`offline-degradation.static`
  - [ ] 3.3 チェックポイントとコミット
  - _Requirements: 4.2, 4.4, 7.7_

- [ ] 4. client
  - [ ] 4.1 `connection.ts`：`ClientView.orderItems`。`queueDisplay.ts`：`livePending` → `pendingOrders(view.orderItems, view.timers, corrected)`。`slotDisplay.ts` / `SlotCard`：`orderItemOf` で品目を引ける口（表示は `lift-order-numbering`）
  - [ ] 4.2 `cancelGuard.ts` / `SlotCard`：残り < 60 秒の 1 タップは `complete`、それ以外は従来の `arm` → `cancel`
  - [ ] 4.3 テスト：`order-queue.*` / `liftGroups.*` / `radial-queue.*`（左レールとラジアルは `pendingOrders`）、`cancelGuard.*` / `slot-card.*`（`complete` / `cancel` の分岐・性質 7.4）、`operationScenes` の系列（開始 → Cancel → 再開始 → 完了で `cooking → unstarted → cooking → done`・7.6）
  - [ ] 4.4 チェックポイントとコミット
  - _Requirements: 4.5〜4.6, 5.1〜5.2, 7.4, 7.6_

- [ ] 5. 文書と最終ゲート
  - [ ] 5.1 `pos-order-ingress`（後着は注文属性の更新・調理中の除外規則の撤去）、`online-cook-scheduling`（計画対象は `pendingOrders`）、`pending-order-expiry`（`liveOrders` は内側・二つの読む集合）、`plan-stability`（対応は未調理の間）、`lift-group-display`（`TimerFact.orderItem`）、`sync-set-batch-complete`（一括完了は各品目に `completedAt`）、`synchronized-boil-adjustment`（`Timer.orderItem.tableId` は開始時点の卓）に日付付きの注記。ADR-0003 の Consequences を改訂（wire に参照を出す）
  - [ ] 5.2 ADR-0013：品目は生涯を通じて残り状態は導出する・参照は Timer 側だけ・厨房の事実は `completedAt` / `interruptedAt`・後着は注文属性だけ・二つの読む集合・v12 の移行例外
  - [ ] 5.3 全数チェックポイント（typecheck / lint 0 errors / test / fmt:check）と既存 property の再実行（5.6 実占有・startable-placement・expiry・independence）
