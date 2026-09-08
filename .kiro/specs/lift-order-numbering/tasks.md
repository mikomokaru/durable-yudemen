# Implementation Plan

前提：main（#38 まで・`order-lifecycle` 済み）。永続・ワイヤの変更なし。client の導出だけ。

- [x] 0. naming ゲート（design の表）をユーザーが承認する（2026-09-08 承認：店舗全体・同じ実効 endTime かつ同じ注文・未確定も数える。名は `liftOrderOf` / `SlotDisplay.running.liftOrder` / `BadgeMarker "order"`）

- [x] 1. domain：`liftOrderOf`
  - [x] 1.1 `src/domain/lift-order.ts`：走行中（`endTime > now`）の Timer を「同じ実効 endTime かつ同じ注文」の単位に束ね、`endTime` → 単位内の最早 `startTime` → `externalOrderId` の順で密な番号を振る。アドホック（`orderItem` null）は 1 本 1 単位。返り値は Timer id → 番号
    - 実測（2026-09-08）：`src/domain/lift-order.ts` に `LiftTimer`（`id` / `startTime` / `endTime` / `orderItem: { externalOrderId } | null`——engine の `Timer` も wire の `TimerFact` / `ClientTimer` も満たす構造型・`slotIds` は読まない）と `liftOrderOf(timers, now): ReadonlyMap<string, number>`。単位の鍵は `endTime` と注文の識別子（アドホックは `\u0000` ＋ id）、並びは `endTime` → 単位内の最早 `startTime` → `compareText`（`order.ts` の符号単位順を export して共有）、番号は並びの index + 1。domain の import は `./order` だけ（`domain-imports` 静的検査は変更なし）。`offline-degradation.static` の確定集合は `src/engine` だけなので domain の新規ファイルは列挙不要
  - [x] 1.2 `tests/domain/lift-order.example` / `lift-order.property`：性質 3.1〜3.5・アドホック・boiled は番号なし・決定性
    - 実測（2026-09-08）：example 11 件（endTime 昇順と入力順非依存・空・同じ endTime で注文違いは別番号・同じ注文の同じ endTime は同番で密・同じ注文でも endTime 違いは別単位・アドホック 1 本 1 単位・最早 startTime の順・同値は externalOrderId で決定的・boiled は Map に無く走行中だけ詰める・時間が進むと繰り上がる・engine の `createTimer` で作った 2 釜の Timer を 1 本と数える）、property 7 件（3.1 順序・3.2 同単位 ⇔ 同番・3.2′ 最早 startTime の順・3.3 密 1..k・3.4 入力順非依存かつ単位を丸ごと落とした部分集合では番号が減るだけで相対順序不変——単位を割って落とすと最早 startTime が変わり同じ endTime の中の順が入れ替わりうるので単位単位で落とす・3.5 鍵集合＝走行中の id かつ slotIds 非依存・決定性と時間経過で相対順序不変・各 300 runs）。`pnpm typecheck` 0 error・`pnpm lint` 0 error（警告は既存のみ）・`pnpm test` 255 files / 1889 tests 全通過・`pnpm fmt:check` 通過・`lift-order.property` の 3 回再実行はいずれも 7 / 7
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
