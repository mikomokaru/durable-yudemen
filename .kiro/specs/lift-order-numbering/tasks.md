# Implementation Plan

前提：main（#38 まで・`order-lifecycle` 済み）。永続・ワイヤの変更なし。client の導出だけ。

- [x] 0. naming ゲート（design の表）をユーザーが承認する（2026-09-08 承認：店舗全体・同じ実効 endTime かつ同じ注文・未確定も数える。名は `liftOrderOf` / `SlotDisplay.running.liftOrder` / `BadgeMarker "order"`）

- [x] 1. domain：`liftOrderOf`
  - [x] 1.1 `src/domain/lift-order.ts`：走行中（`endTime > now`）の Timer を「同じ実効 endTime かつ同じ注文」の単位に束ね、`endTime` → 単位内の最早 `startTime` → `externalOrderId` の順で密な番号を振る。アドホック（`orderItem` null）は 1 本 1 単位。返り値は Timer id → 番号
    - 実測（2026-09-08）：`src/domain/lift-order.ts` に `LiftTimer`（`id` / `startTime` / `endTime` / `orderItem: { externalOrderId } | null`——engine の `Timer` も wire の `TimerFact` / `ClientTimer` も満たす構造型・`slotIds` は読まない）と `liftOrderOf(timers, now): ReadonlyMap<string, number>`。単位の鍵は `endTime` と注文の識別子（アドホックは `\u0000` ＋ id）、並びは `endTime` → 単位内の最早 `startTime` → `compareText`（`order.ts` の符号単位順を export して共有）、番号は並びの index + 1。domain の import は `./order` だけ（`domain-imports` 静的検査は変更なし）。`offline-degradation.static` の確定集合は `src/engine` だけなので domain の新規ファイルは列挙不要
  - [x] 1.2 `tests/domain/lift-order.example` / `lift-order.property`：性質 3.1〜3.5・アドホック・boiled は番号なし・決定性
    - 実測（2026-09-08）：example 11 件（endTime 昇順と入力順非依存・空・同じ endTime で注文違いは別番号・同じ注文の同じ endTime は同番で密・同じ注文でも endTime 違いは別単位・アドホック 1 本 1 単位・最早 startTime の順・同値は externalOrderId で決定的・boiled は Map に無く走行中だけ詰める・時間が進むと繰り上がる・engine の `createTimer` で作った 2 釜の Timer を 1 本と数える）、property 7 件（3.1 順序・3.2 同単位 ⇔ 同番・3.2′ 最早 startTime の順・3.3 密 1..k・3.4 入力順非依存かつ単位を丸ごと落とした部分集合では番号が減るだけで相対順序不変——単位を割って落とすと最早 startTime が変わり同じ endTime の中の順が入れ替わりうるので単位単位で落とす・3.5 鍵集合＝走行中の id かつ slotIds 非依存・決定性と時間経過で相対順序不変・各 300 runs）。`pnpm typecheck` 0 error・`pnpm lint` 0 error（警告は既存のみ）・`pnpm test` 255 files / 1889 tests 全通過・`pnpm fmt:check` 通過・`lift-order.property` の 3 回再実行はいずれも 7 / 7
  - _Requirements: 1.1〜1.4, 3.1〜3.5_

- [x] 2. client
  - [x] 2.1 `slotDisplay.ts`：running に `liftOrder`（`view.timers` 全件と `correctedNow` から一度導く）。`tests/client/slotDisplay.example`（担当外の Timer が番号を押し上げる・boiled に無い）
    - 実測（2026-09-08）：`assignedSlotDisplays` の冒頭で `corrected = correctedNow(view.offset, now)` を 1 回計算し `liftOrderOf(view.timers, corrected)`（担当外・provisional を含む全件）を一度導き、running に `liftOrder: liftOrder.get(earliest.id) ?? liftOrder.size + 1`（`remaining > 0 ⇔ endTime > corrected` は導出と同じ線なので必ず在る・右辺は型の関門）を載せた。boiled の `overdueMs` も同じ `corrected` を読む。`slotDisplay.example` に 5 件（担当外ユニットの先に上がる Timer で 2 番・担当を広げても不変・2 釜の Timer は同番・boiled は `liftOrder` を持たず同じ注文を指す参照先なし Timer は同番・offset を足せば上がっている Timer は番号から外れる・provisional も数える）
  - [x] 2.2 `SlotCard.tsx`：`NoodleBadge` の marker `"order"`（番号・点滅しない・aria-label `Boiling {n}: …`）。バッジの語は `displayName(orderItem)` ＋ ` · Table {id}`（参照先が無ければ麺種だけ）。boiled / 残滓は ✓ のまま。`tests/client/slot-card.example`
    - 実測（2026-09-08）：`BadgeMarker = "none" | "ready" | "last" | { kind: "order"; n }`（`"boiling"` と点滅ドットは撤去）。番号は `aria-hidden` の `tabular-nums` な文字で濃色（親の文字色を継ぐ・`animate-pulse` 無し）、接頭辞は `ariaPrefixOf`（`Boiling {n}: ` / `Ready: ` / `Last: `）。`NoodleBadge` の prop は `noodleType` → `label` に改め、語は呼び出し側が組む——running / boiled は `display.orderItem` が在れば `displayName(orderItem)`（`queueDisplay` を import）に卓が在れば ` · Table {id}`（SlotBoard の提案の語と同じ）、無ければ `noodleType`。残滓は従来どおり麺種。`slot-card.example` に 6 件（番号と aria-label `Boiling 2: プレ塩 中盛 · Table 12`・点滅しない／濃色・卓なしは品名だけ・参照先なしは `Boiling 3: Thin`・boiled は `Ready: …` と ✓・参照先なしの boiled は `✓Thin`）。既存の running リテラル（`slot-card.example` / `complete.example` / `audioGenerators` の生成器）に `liftOrder` を足した
  - [x] 2.3 `OrderRail.tsx`：`interruptedAt` を持つ行に記号「↩」と淡色（並びと語は不変）。`tests/client/order-queue.example` / rail の描画テスト
    - 実測（2026-09-08）：`OrderRow` は `returned = order.interruptedAt !== null` なら名称の span の先頭に `<span role="img" aria-label="Returned" className="mr-1 text-muted">↩</span>` を置き、名称の span に `opacity-60` を足す。**2 点、design の字面から変えた**：(a) aria の語は「（戻された）」でなく英語 `Returned`——`offline-degradation.static` (f) と `pending-order-list-left-rail.static` S15 が client / レールの文字列・JSX テキストの日本語を禁じる（茹で加減ラベルのみ例外）；(b) 淡さは `text-muted` でなく `opacity-60`——S6 / S12 がレール唯一のインライン style を `style={{ color: noodleColor(` に固定しており、class の `text-muted` はインライン色に負ける。麺種色を保ったまま淡くする（識別は色）のは SlotCard の残滓と同じ扱い。`order-rail.example` に 2 件（interruptedAt を持つ行だけが ↩ / Returned と opacity-60・並びと語は不変）。`radial-queue.example` の 1 件（レールの名を `span.textContent` で読んで帯と比べる）は、中断済み品目の行が ↩ を持つようになったので名の読み方をテキストノードだけに改めた（主張「レールも同じ 3 品」は不変）
  - [x] 2.4 既存の client テスト（群・先頭・提案・音・残り時間）がそのまま通ることを確認（性質 3.6）。静的検査（`lift-group-display.static` / `pending-order-list-left-rail.static` / `sync-set-batch-complete.static`）
    - 実測（2026-09-08）：`liftGroups.*` / `slot-board-suggestions` / `boiledGroup.*` / `audioCue.property` / `format.property` / `slotDisplay.property` / `order-queue.example` は変更なしで通過（上の `radial-queue.example` の読み方の 1 箇所と、型の追随 3 箇所だけ）。静的検査 8 files / 94 tests 通過（`lift-group-display.static` / `pending-order-list-left-rail.static` / `sync-set-batch-complete.static` / `offline-degradation.static` / `tests/static/*`）
  - [x] 2.5 チェックポイント（typecheck / lint 0 errors / test / fmt:check）とコミット
    - 実測（2026-09-08）：`pnpm typecheck` 0 error（tests 含む）・`pnpm lint` 0 error（警告は既存のみ）・`pnpm test` 255 files / 1902 tests 全通過・`pnpm fmt:check` 通過。`audioCue.property` + `slotDisplay.property` + `lift-order.property` の 3 回再実行はいずれも 14 / 14
  - _Requirements: 1.5, 2.1〜2.4, 3.6_

- [ ] 3. 文書
  - [ ] 3.1 `lift-group-display` design に注記（マーカー "order"・バッジの語に品名と卓）、`pending-order-list-left-rail` に注記（中断の色分け）
  - [ ] 3.2 全数チェックポイント
