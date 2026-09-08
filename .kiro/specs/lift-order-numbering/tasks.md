# Implementation Plan

前提：main（#38 まで・`order-lifecycle` 済み）。永続・ワイヤの変更なし。client の導出だけ。

- [x] 0. naming ゲート（design の表）をユーザーが承認する（2026-09-08 承認：店舗全体・同じ実効 endTime かつ同じ注文・未確定も数える。名は `liftOrderOf` / `SlotDisplay.running.liftOrder` / `BadgeMarker "order"`）

- [ ] 1. domain：`liftOrderOf`
  - [ ] 1.1 `src/domain/lift-order.ts`：走行中（`endTime > now`）の Timer を「同じ実効 endTime かつ同じ注文」の単位に束ね、`endTime` → 単位内の最早 `startTime` → `externalOrderId` の順で密な番号を振る。アドホック（`orderItem` null）は 1 本 1 単位。返り値は Timer id → 番号
  - [ ] 1.2 `tests/domain/lift-order.example` / `lift-order.property`：性質 3.1〜3.5・アドホック・boiled は番号なし・決定性
  - _Requirements: 1.1〜1.4, 3.1〜3.5_

- [ ] 2. client
  - [ ] 2.1 `slotDisplay.ts`：running に `liftOrder`（`view.timers` 全件と `correctedNow` から一度導く）。`tests/client/slotDisplay.example`（担当外の Timer が番号を押し上げる・boiled に無い）
  - [ ] 2.2 `SlotCard.tsx`：`NoodleBadge` の marker `"order"`（番号・点滅しない・aria-label `Boiling {n}: …`）。バッジの語は `displayName(orderItem)` ＋ ` · Table {id}`（参照先が無ければ麺種だけ）。boiled / 残滓は ✓ のまま。`tests/client/slot-card.example`
  - [ ] 2.3 `OrderRail.tsx`：`interruptedAt` を持つ行に記号「↩」と淡色（並びと語は不変）。`tests/client/order-queue.example` / rail の描画テスト
  - [ ] 2.4 既存の client テスト（群・先頭・提案・音・残り時間）がそのまま通ることを確認（性質 3.6）。静的検査（`lift-group-display.static` / `pending-order-list-left-rail.static` / `sync-set-batch-complete.static`）
  - [ ] 2.5 チェックポイント（typecheck / lint 0 errors / test / fmt:check）とコミット
  - _Requirements: 1.5, 2.1〜2.4, 3.6_

- [ ] 3. 文書
  - [ ] 3.1 `lift-group-display` design に注記（マーカー "order"・バッジの語に品名と卓）、`pending-order-list-left-rail` に注記（中断の色分け）
  - [ ] 3.2 全数チェックポイント
