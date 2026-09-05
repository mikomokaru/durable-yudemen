# Implementation Plan

前提：`lift-group-planning`（PR #28・`keepsAnchor` まで）がマージ済み、または本ブランチがその先端に載っていること。本 spec は client と domain を変え、engine は `Ordered` の撤去と `toWireTimer` の 1 項目だけ触る（Requirement 5）。

進め方は `lift-group-planning` と同じ——各 task を `[-]` で始め、終えたら `[x]` と実測を残す。チェックポイントは `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm fmt:check`。コミットは task ごと。

- [ ] 0. naming ゲートの確認（design 末尾の表）
  - `OrderItemOrigin` / `TimerFact.orderItem` / `PREP_LEAD_MS` / `LiftGroup` / `GroupItem` / `liftGroups` / `visibleGroups` / `headOf` / `slotSuggestions` / `pairSlots` / `SlotSuggestion`（`role` / `phase`）/ `SuggestionView` / `RadialQueueItem` / `RadialMenu.queue` / `onSelectItem` / `ClientView.unitOrigins` / `slotOffsets` / `affinityToleranceDistance` / `slotDistance`（移設）。撤去：`suggestionTiming` / `SuggestionTiming` / `planAnchor` / `nextForSlot` / `itemOf` / engine の `Ordered`。
  - ユーザー承認を得てから task 1 へ。

- [ ] 1. ワイヤと engine — `TimerFact.orderItem`
  - [ ] 1.1 `src/domain/timer.ts` に `OrderItemOrigin` を定義し、`TimerFact.orderItem: OrderItemOrigin | null` を足す（doc は engine の `Ordered` から移す）
  - [ ] 1.2 `src/engine/timer.ts` の `Ordered` を削除。`Timer` は `TimerFact` から継承。`createTimer` の入力型を `TimerFact["orderItem"]` へ。`migrate.ts` / `start.ts` / `src/domain/order.ts` の注記 / `tests/core/{timer.example,sync.p4.property}.test.ts` の型参照を追随
  - [ ] 1.3 `src/engine/project.ts` の `toWireTimer` が `orderItem` を写す。`tests/core/to-wire-timer-adjustment.example.test.ts` を「`orderItem` を運ぶ」形へ（`WIRE_TIMER_KEYS` に加え、`toHaveProperty("orderItem", timer.orderItem)`）
  - [ ] 1.4 `src/domain/wire.ts` に `toOrderItemOrigin` を書いて export し、`toTimerFact` が読む（欠如 / null → null、非 null は `externalOrderId` 非空・`itemIndex` 非負整数・`tableId` null か非空文字列、逸脱は失敗）。`tests/domain/wireGenerators.ts` の `genTimerFact` に `orderItem` を足し、`wire.example` に欠如 → null と不正 → 失敗の例を足す
  - [ ] 1.5 `src/client/persistence.ts` の `toClientTimer` が `toOrderItemOrigin` で `orderItem` を復元する（永続は不正値も null に畳む・旧ブロブの優雅な移行）。`tests/client/persistenceCodec.property.test.ts` と `generators.ts` の Timer 生成器に `orderItem` を足す
  - [ ] 1.6 チェックポイント（engine の遷移・計画・採点・永続のテストが変更なしに通ること＝Property 13）
  - _Requirements: 5.1, 5.2, 5.3_

- [ ] 2. domain — `PREP_LEAD_MS` と `slotDistance` の移設
  - [ ] 2.1 `src/domain/messages.ts` に `PREP_LEAD_MS = 60_000`（doc：麺を準備する猶予・設定にしない）
  - [ ] 2.2 `slotDistance` / `position` / 2 定数を `src/engine/objective.ts` から `src/domain/store.ts` へ移す（doc ごと）。domain は `slotDistance` と `position` を export。`objective.ts` と `schedule.ts` は domain から import（`schedule.ts:713` の注記を domain へ）。再 export しない。`tests/core/objective.{property,example}.test.ts` の import 先を domain へ
  - [ ] 2.3 静的検査：`objective.ts` に `function slotDistance` が無いこと（Property 7 / Requirement 6.7）
  - _Requirements: 5.7, 6.7_

- [ ] 3. `ClientView` の 3 項目
  - [ ] 3.1 `src/client/connection.ts` の `ClientView` / `EMPTY_VIEW` / config case に `unitOrigins` / `slotOffsets` / `affinityToleranceDistance` を足す。config case の注記を「読み手のできた 3 項目だけ持つ」に改める
  - [ ] 3.2 `tests/client/connection.example.test.ts` に config 受信で 3 項目が写る例を足す
  - _Requirements: 4.7_

- [ ] 4. `liftGroups.ts` — 群・開始・連鎖・先頭・釜ごとの提案・釜の組
  - [ ] 4.1 `queueDisplay.ts`：`QueueSuggestion` に `serveAt` を足し、`boilSecondsOf` を export。`suggestionTiming` / `SuggestionTiming` を削除
  - [ ] 4.2 `src/client/components/liftGroups.ts`（新規）：`GroupItem` / `LiftGroup` / `liftGroups(view, corrected)` / `visibleGroups` / `headOf` / `SlotSuggestion` / `slotSuggestions(visible, view, corrected)` / `pairSlots(slot, slotSpan, view)`。design Component 3 の擬似コードどおり。`occupied` は店舗全体の Timer（running / boiled とも）
  - [ ] 4.3 `tests/client/generators.ts` に群を作る場面（卓・茹で秒・`startAt`・走行中の仲間：一致 / 不一致 / boiled / `orderItem: null`）を足す
  - [ ] 4.4 `tests/client/liftGroups.property.test.ts`（新規）：Requirement 6.1（片方向の等号）・6.2 / 1.10（並べ替えと端末ローカル項目への不変）・6.3（同卓の仲間の `endTime` だけを分割点とする単調性）・6.5（群の境界）・6.8（全釜 idle）・6.9（先頭の一意・全品の `startAt` を過ぎても）・6.10（開始の事実・同卓の後の batch は偽）・6.11（degraded で空）
  - [ ] 4.5 `tests/client/liftGroups.example.test.ts`（新規）：茹で 510 / 360 / 330 秒の同卓 3 品で 180 秒後も head は 510 秒の品目だけ。`pairSlots`：起点の釜が埋まっていれば null（`slotSpan` 1 でも）・許容距離の内側に足りなければ null・近い順と index で断つ
  - [ ] 4.6 チェックポイント
  - _Requirements: 1.1〜1.10, 2.1〜2.14, 6.1〜6.3, 6.5, 6.8〜6.11_

- [ ] 5. `slotDisplay.ts` と `assignedSlotDisplays` の呼び出し側
  - [ ] 5.1 idle の `next: readonly SlotSuggestion[]`。第 4 引数を `bySlot: ReadonlyMap<number, readonly SlotSuggestion[]> = NO_SUGGESTIONS`（省略可）にし、`nextForSlot` を削除
  - [ ] 5.2 `useAudioCues.ts:199` と `[]` を渡すテスト（`complete.example`・`audioCue.property`・`assignment-ui.example`・`localAuthority.property`・`degraded-slot-superimposition.{display,exploration}`）の第 4 引数を落とす。静的検査 `tests/sync-set-batch-complete.static.test.ts` の正規表現が `SlotBoard` の呼び出しで満たされることを確認
  - [ ] 5.3 `tests/client/slotSuggestion.{example,property}.test.ts` を削除（`liftGroups` の性質へ置き換え済み）。Requirement 6.6（担当外の空白）と「units A と B で共通する釜の `next` が一致」を `assignedSlotDisplays` の Property として足す
  - _Requirements: 2.12, 6.6_

- [ ] 6. `SlotBoard.tsx` / `SlotCard.tsx`
  - [ ] 6.1 `SlotBoard`：`planAnchor` と時期の語（`in` / `+`・`formatRemaining` の提案での使用）を撤去。`corrected` を一度読み、`liftGroups` → `visibleGroups` → `slotSuggestions` → `assignedSlotDisplays`。`suggestionOf` は `SuggestionView`（`role` で判別）を返す。`itemOf` を削除し `item.order` から鍵を取る
  - [ ] 6.2 `SlotCard`：`display.next` と `SuggestionView[]` を対で受け、`role` で分岐。`head` だけ丸ボタン（薄は opacity・濃は現行の塗り・語は `now` のみ）、`member` はラベルだけ。aria-label は `now` / `soon` / `queued`
  - [ ] 6.3 `tests/client/slot-card.example.test.tsx` を書き換え：`head`（薄・濃）に丸ボタンと aria-label、`member` にボタン無し・濃くない、複数の提案の折り返しで Start が右下に留まる、時刻の語が無い（Requirement 6.4）
  - [ ] 6.4 チェックポイント
  - _Requirements: 2.2〜2.5, 3.1〜3.7, 6.4_

- [ ] 7. `RadialMenu.tsx` — 待ち行列の帯
  - [ ] 7.1 `RadialQueueItem` / `queue` / `onSelectItem` を足し、帯を花びらの反対側（`base` から導く・余白が足りなければ弧の下）に描く。`slotIds === null` の行は不活性。プリセットの花びらと幾何は変えない
  - [ ] 7.2 `SlotBoard`：`picker` が開いたとき `orderQueueEntries` の各行に `pairSlots(picker.slot, order.slotSpan, view)` を付けて渡す。degraded では `queue: []`。選択 → `connection.startOrderItem(slotIds, { externalOrderId, itemIndex })`
  - [ ] 7.3 `tests/client/radial-queue.example.test.tsx`（新規）：live で帯が出る・到着順・`slotSpan` 2 で足りない行は不活性・degraded で帯が無い・**開いたまま snapshot で起点の釜が走行中になると全行が不活性で `startOrderItem` が呼ばれない**
  - _Requirements: 4.1〜4.9, 6.11_

- [ ] 8. 横断の検証（engine を実走させた snapshot を client の導出に通す）
  - [ ] 8.1 `tests/client/liftGroups.crosslayer.example.test.ts`（新規）：`startOrderItemTimer` → `fireDueTimers` → `toWireSnapshot` で得た snapshot を `liftGroups` / `slotSuggestions` に通す。茹で上がりの 2 場面（同じ snapshot で 599 → 600 秒・その後の発火 snapshot）で「G2 が隠れる」が両方で成り立つこと。boiled の釜が index 最小 / 最大の両方。容量分割（6 釜・4 品・各 2 釜）の (i)(ii)——(ii) は再統合後に 3 品とも head
  - [ ] 8.2 同ファイルに `receivePlan` で合流一片を採用 → 無関係な Timer を `startTimer` → snapshot を `liftGroups` に通し、合流分の群が `started`、届かなくなった一片の群が `started` でない（`keepsAnchor` の帰結）
  - _Requirements: 1.7, 6.3, 6.10_

- [ ] 9. 文書の整合（本体と同じコミット）
  - [ ] 9.1 `slot-suggested-start` の Requirement 1.2・2.3〜2.5・判断 5 に本 spec が改めた旨を追記
  - [ ] 9.2 `online-cook-scheduling` design の「`unitOrigins` / `slotOffsets` は現時点で用途なし」を改める
  - [ ] 9.3 `lapsed-suggestion-timing` の requirements 冒頭に、本 spec が置き換えた旨を追記
  - [ ] 9.4 `docs/adr/0003` の Consequences（「`TimerFact` には出さない」）を改訂。`.kiro/steering/timer-model.md` の「駆動オーダーの保持」を「実装済み（`TimerFact.orderItem`・lift-group-display）」へ
  - _Requirements: 7.1〜7.4_

- [ ] 10. チェックポイント — 全体の green と実機の見え方
  - `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm fmt:check`。
  - 実機（`pnpm dev`・2 端末）で：同卓 3 品で先頭だけに丸ボタン、他は薄いラベル。先頭を押すと残りが錨に揃って次の先頭が濃くなる。別卓の群は先頭の群の 1 本目が始まるまで出ない。ラジアルに待ち行列の帯。degraded で提案も帯も消える。

- [ ] 11. 申し送り（本 spec の範囲外・記録のみ）
  - 麺種プリセットのアドホック開始（`connection.start`）は起点の釜の占有を検査しない既存経路のまま（design Component 3）。
  - 設定変更直後の hydration snapshot は旧 adjustment の錨で推奨を出す（`lift-group-planning` tasks の申し送り）。
