# Implementation Plan

前提：`lift-group-planning`（PR #28・`keepsAnchor` まで）がマージ済み、または本ブランチがその先端に載っていること。本 spec は client と domain を変え、engine は `Ordered` の撤去と `toWireTimer` の 1 項目だけ触る（Requirement 5）。

進め方は `lift-group-planning` と同じ——各 task を `[-]` で始め、終えたら `[x]` と実測を残す。チェックポイントは `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm fmt:check`。コミットは task ごと。

- [ ] 0. naming ゲートの確認（design 末尾の表）
  - `OrderItemOrigin` / `TimerFact.orderItem` / `PREP_LEAD_MS` / `LiftGroup` / `GroupItem` / `liftGroups` / `visibleGroups` / `headOf` / `slotSuggestions` / `pairSlots` / `SlotSuggestion`（`role` / `phase`）/ `SuggestionView` / `RadialQueueItem` / `RadialMenu.queue` / `onSelectItem` / `ClientView.unitOrigins` / `slotOffsets` / `affinityToleranceDistance` / `slotDistance`（移設）。撤去：`suggestionTiming` / `SuggestionTiming` / `planAnchor` / `nextForSlot` / `itemOf` / engine の `Ordered`。
  - ユーザー承認を得てから task 1 へ。

- [x] 1. ワイヤと engine — `TimerFact.orderItem`
  - [x] 1.1 `src/domain/timer.ts` に `OrderItemOrigin` を定義し、`TimerFact.orderItem: OrderItemOrigin | null` を足す（doc は engine の `Ordered` から移す）
  - [x] 1.2 `src/engine/timer.ts` の `Ordered` を削除。`Timer` は `TimerFact` から継承。`createTimer` の入力型を `TimerFact["orderItem"]` へ。`migrate.ts` / `start.ts` / `src/domain/order.ts` の注記 / `tests/core/{timer.example,sync.p4.property}.test.ts` の型参照を追随
  - [x] 1.3 `src/engine/project.ts` の `toWireTimer` が `orderItem` を写す。`tests/core/to-wire-timer-adjustment.example.test.ts` を「`orderItem` を運ぶ」形へ（`WIRE_TIMER_KEYS` に加え、`toHaveProperty("orderItem", timer.orderItem)`）
  - [x] 1.4 `src/domain/wire.ts` に `toOrderItemOrigin` を書いて export し、`toTimerFact` が読む（欠如 / null → null、非 null は `externalOrderId` 非空・`itemIndex` 非負整数・`tableId` null か非空文字列、逸脱は失敗）。`tests/domain/wireGenerators.ts` の `genTimerFact` に `orderItem` を足し、`wire.example` に欠如 → null と不正 → 失敗の例を足す
  - [x] 1.5 `src/client/persistence.ts` の `toClientTimer` が `toOrderItemOrigin` で `orderItem` を復元する（永続は不正値も null に畳む・旧ブロブの優雅な移行）。`tests/client/persistenceCodec.property.test.ts` と `generators.ts` の Timer 生成器に `orderItem` を足す
  - [x] 1.6 `src/client/connection.ts` の `decideLocalStart` が作る Provisional_Timer（`ClientTimer`）に `orderItem: null` を足す（永続からの復元とは別の生成経路。アドホック開始ゆえ常に null）。`tests/client/localAuthority.property.test.ts` / `decideView.property.test.ts` の期待値を追随
  - [x] 1.7 チェックポイント（engine の遷移・計画・採点・永続のテストが変更なしに通ること＝Property 13）
  - 実測・2026-09-05: `OrderItemOrigin` を `src/domain/timer.ts` に立て、engine の `Ordered` を削除（doc は `OrderItemOrigin` へ移し、engine 側には「共有事実になった」旨だけ残す）。`toOrderItemOrigin` は三値（欠如 / null → null・逸脱 → undefined）で、ワイヤは undefined を Decode_Failure に、永続は `?? null` に畳む——同じ関門を両方が使い、処置だけを呼び出し側の義務で分けた。`tableId` の判定は `toDeclaredName`（null か非空文字列）を共用。engine の遷移・計画・採点・永続のテストは変更なしに通った（Property 13）。**計画からの逸脱 2 点**：(1) `tests/core/sync.p4.property.test.ts` に `Ordered` の参照は無く（`canonicalOrderedSets` は別語）、`tests/client/decideView.property.test.ts` も生成器経由で期待値を組むため、いずれも追随は不要だった。(2) `TimerFact` に必須項目を足すため、tasks に挙げた以外の Timer リテラル 19 ファイル（`tests/client` の example / property・`tests/core/settle.property`・`audioGenerators`）に `orderItem: null` を足し、`TimerFact` のキー集合を固定する静的検査 2 本（`tests/operation-history/timer-model.static`・`tests/sync-set-batch-complete.static`）を 7 項目へ改めた（それぞれの眼目「Operation History / 一括完了が芯へ足さない」は保ち、他 spec の正当な拡張として追随）。`persistenceCodec.property` に旧ブロブ（`orderItem` 欠如 / 不正）の優雅な移行の Property を足した。typecheck 0（`worker-configuration.d.ts` を除く）・lint エラー 0・fmt:check 通過・226 ファイル 1408 件通過。**レビュー追記**：`wire.example` の「欠如 → null」の例は、ヘルパが「復号が落ちて null」と「復号が通って orderItem が null」を一つの null に潰しており Decode_Failure を反証できなかった。`decodeSnapshotTimer`（メッセージを返す）と `decodedOrderItem`（復号が通ったことを主張してから orderItem を返す）に分け、不正側は前者で snapshot 全体が落ちることを見る。件数は変わらず 226 ファイル 1408 件通過。
  - _Requirements: 5.1, 5.2, 5.3_

- [x] 2. domain — `PREP_LEAD_MS` と `slotDistance` の移設
  - [x] 2.1 `src/domain/messages.ts` に `PREP_LEAD_MS = 60_000`（doc：麺を準備する猶予・設定にしない）
  - [x] 2.2 `slotDistance` / `position` / 2 定数を `src/engine/objective.ts` から `src/domain/store.ts` へ移す（doc ごと）。domain は `slotDistance` と `position` を export。`objective.ts` と `schedule.ts` は domain から import（`schedule.ts:713` の注記を domain へ）。再 export しない。`tests/core/objective.{property,example}.test.ts` の import 先を domain へ
  - [x] 2.3 静的検査：`objective.ts` に `function slotDistance` が無いこと（Property 7 / Requirement 6.7）
  - 実測・2026-09-05: `PREP_LEAD_MS` は `CookRecommendation` の直後に置いた（猶予が推奨の `startAt` に対してだけ意味を持つ時間ゆえ）。`slotDistance` / `position` / 2 定数を doc ごと `store.ts` の `defaultUnitOrigin` の直後（レイアウトの節の末尾）へ移し、`position` は engine の代表 slot 選定が座標を要るため export にした。算術は 1 文字も変えていない（AC 5.7）。`objective.ts` から `SLOTS_PER_UNIT` / `GridPoint` の import が消え、`schedule.ts` の `objective` からの import は型だけになった。注記の行は design の `:713` ではなく `:739`（task 1 で行がずれた）。静的検査は `tests/lift-group-display.static.test.ts`（spec 名で 1 ファイル・TypeScript AST）に (a) domain が `slotDistance` を export する・(b) `objective.ts` に `function slotDistance` / `position` の宣言が無い・(c) `objective.ts` と `schedule.ts` が `../domain/store` から import し `objective.ts` が再 export しない、の 3 件。**計画からの逸脱 1 点**：静的検査は `vitest.config.ts` の static project の `include` に足すだけでなく、workers project の `exclude` にも足す必要があった（workers は `tests/**/*.test.ts` を拾うため、`node:fs` を読む検査が workerd 上でも走って Worker が落ち、「227 passed (228)」＋ unhandled error になった）。既存の静的検査と同じく include / exclude を対で置いて解消。typecheck 0（`worker-configuration.d.ts` を除く）・lint エラー 0・fmt:check 通過・227 ファイル 1411 件通過（3 回連続。うち 1 回だけ別の 1 件が落ちる走行があり、直後の 3 回で再現しなかった——本 task の変更と無関係な時間依存の揺れとみる）。**レビュー追記**：静的検査の (b)(c) は `FunctionDeclaration` と `export { … } from` しか見ておらず、`export { slotDistance }`（moduleSpecifier 無し）・`export const slotDistanceAlias = …`・`const slotDistance = …` の再定義がいずれも緑のまま通った——最も自然な逃げ道が検査の外にあり、Property 7「定義がただ一箇所・入口が一つ」を固定していなかった。宣言は `declaredNamesOf`（関数宣言＋変数宣言の束縛名。分割代入の葉も含む）、export は `exportedNames`（export 修飾子つき宣言・`export { a as b }` の両名・`export default a`・`export *` / `export * as ns` は印 `*`）に合算して名で照合する形に改めた。`objective.ts` へ 8 種の逃げ道（素の再 export・別名の再 export・`export const` 別名・`const` 再定義・分割代入の再定義・`export *`・`export * as`・`export default`）を順に注入し、いずれも該当する検査が落ちることを実行して確かめた。件数は変わらず 227 ファイル 1411 件通過。
  - _Requirements: 5.7, 6.7_

- [x] 3. `ClientView` の 3 項目
  - [x] 3.1 `src/client/connection.ts` の `ClientView` / `EMPTY_VIEW` / config case に `unitOrigins` / `slotOffsets` / `affinityToleranceDistance` を足す。config case の注記を「読み手のできた 3 項目だけ持つ」に改める
  - [x] 3.2 `tests/client/connection.example.test.ts` に config 受信で 3 項目が写る例を足す
  - 実測・2026-09-05: `ClientView` に 3 項目を足し（doc は「釜の組が domain の `slotDistance` で距離を測るために読む・計画と同じ座標と尺度」）、`EMPTY_VIEW` は `defaultUnitOrigins(DEFAULT_UNIT_COUNT)` / `DEFAULT_SLOT_OFFSETS` / `DEFAULT_AFFINITY_TOLERANCE_DISTANCE`、config case は 3 項目を写す。注記は「写すのは読み手のできた 3 項目だけ・重み・許容幅（秒）は引き続き持たない」に改めた。`connection.example` の例は既定と見分けのつく値（原点 2 個・オフセット x=2・距離 24）を config で受け、3 項目が写ることと `Object.keys` が `EMPTY_VIEW` と一致すること（重み・許容幅・対応表を持たない）を見る。**計画からの逸脱 2 点**：(1) `ClientView` に必須項目を足すため、`EMPTY_VIEW` を spread しない完全形のリテラル 5 ファイル（`reconcile.property`・`degraded-slot-superimposition.{gate,resolution,display}.property`・`assignment-ui.example`）に 3 項目を足した（`unitOrigins` は各自の `unitCount` と整合させる）。`tests/client/generators.ts` の `genClientView` は `EMPTY_VIEW` 基点ゆえ壊れないが、`unitOrigins` だけは生成した `unitCount` に整合させた（config の生成器と同じ規律）。(2) `order-queue.example` の「config の追加項目を受け取ってもユニット総数と麺種プリセットだけ」は主張（キー集合が `EMPTY_VIEW` と一致）はそのまま通るが題と注記が嘘になるため、「釜の組に要る 3 項目」を足した文言に改めた。typecheck 0（`worker-configuration.d.ts` を除く）・lint エラー 0（警告は既存のみ・`generators.ts` の map-spread は HEAD でも同じ行に在る）・fmt:check 通過・227 ファイル 1412 件通過（+1 件）。**レビュー追記**：`tests/client/generators.ts` の `genServerMessage` の config 分岐の注記「計画の重み・許容幅・レイアウトは client の畳み込みが読まない（unitCount / noodlePresets だけが確定される）」が本 task で嘘になっていた（同コミットで `genClientView` の doc は改めたが、こちらは据え置いた）。「重み・許容幅（秒）は読まない・レイアウトと許容距離は釜の組が読むため写されるが、生成の分散は要らないので既定に固定する」に改めた。件数は変わらず 227 ファイル 1412 件通過。
  - _Requirements: 4.7_

- [x] 4. `liftGroups.ts` — 群・開始・連鎖・先頭・釜ごとの提案・釜の組（**足すだけ**・旧経路は残す）
  - [x] 4.1 `queueDisplay.ts`：`QueueSuggestion` に `serveAt` を足し、`boilSecondsOf` を export（`suggestionTiming` はまだ消さない——利用側の撤去は task 5 で一括）
  - [x] 4.2 `src/client/components/liftGroups.ts`（新規）：`GroupItem` / `LiftGroup` / `liftGroups(view, corrected)` / `visibleGroups` / `headOf` / `SlotSuggestion` / `slotSuggestions(visible, view, corrected)` / `pairSlots(slot, slotSpan, view)`。design Component 3 の擬似コードどおり。`occupied` は店舗全体の Timer（running / boiled とも）
  - [x] 4.3 `tests/client/generators.ts` に群を作る場面（卓・茹で秒・`startAt`・走行中の仲間：一致 / 不一致 / boiled / `orderItem: null`）を足す
  - [x] 4.4 `tests/client/liftGroups.property.test.ts`（新規）：Requirement 6.1（片方向の等号）・6.2 / 1.10（並べ替えと端末ローカル項目への不変）・6.3（同卓の仲間の `endTime` だけを分割点とする単調性）・6.5（群の境界）・6.8（全釜 idle）・6.9（先頭の一意・全品の `startAt` を過ぎても）・6.10（開始の事実・同卓の後の batch は偽）・6.11（degraded で空）
  - [x] 4.5 `tests/client/liftGroups.example.test.ts`（新規）：茹で 510 / 360 / 330 秒の同卓 3 品で 180 秒後も head は 510 秒の品目だけ。`pairSlots`：起点の釜が埋まっていれば null（`slotSpan` 1 でも）・許容距離の内側に足りなければ null・近い順と index で断つ
  - [x] 4.6 チェックポイント（新規モジュールとその検査だけが増え、既存はすべて通る）
  - 実測・2026-09-05: `QueueSuggestion` に `serveAt` を足し（doc は「等号は `suggestedItemOf` だけが計算する・注文参照は足さない」）、推奨から提案と品目を一度に組む `suggestedItemOf(view, recommendation)` を export した。`liftGroups.ts` は design Component 3 の擬似コードどおり（`GroupItem` / `LiftGroup` / `liftGroups` / `visibleGroups` / `headOf` / `SlotSuggestion` / `slotSuggestions` / `pairSlots`）。群の鍵は卓なしなら品目・卓ありなら (tableId, serveAt)、`started` は同卓・`endTime === serveAt`・`endTime > corrected` の 3 条件、`occupied` は店舗全体の Timer（running / boiled とも）で `slotSuggestions` と `pairSlots` が同じ `occupiedSlots` を読む。`pairSlots` は起点の釜が埋まっていれば `slotSpan` 1 でも null、近い順・同距離は index 順。旧経路（`suggestionTiming` / `nextForSlot` / `planAnchor`）と `slotDisplay` / `SlotBoard` / `SlotCard` は触っていない（task 5）。生成器は `genLiftView` / `genLiftCorrected` / `genLiftScene`（batch ごとに卓と serveAt を決めて茹で秒から startAt を逆算・仲間は match / mismatch / stray / foreign の 4 種・orphan / retired の推奨・境界の corrected）で、`generators.smoke` に場面を踏む番人 2 件を足した。Property は 6.1・6.2 / 1.10（並べ替えと端末ローカル 7 項目への不変）・6.3（分割点の手前まで進めて消えない・跨ぐと接頭辞に縮む）・6.5・6.8（+2.14）・6.9（全品の startAt を過ぎても同じ先頭）・6.10（同卓の後の batch は偽）・6.11 の 9 件、Example は 510 / 360 / 330 秒の再現・連鎖の解禁・卓の一致だけ / endTime の一致だけでは偽・599 → 600 秒の転移・群に入らない推奨・卓なしは 1 品 1 群・複数釜と boiled の占有・`pairSlots` 4 件の 14 件。**計画からの逸脱 3 点**：(1) design は「`boilSecondsOf` を export して共用」としたが、レールと群はどちらも「推奨 → 品目 → 茹で秒 → serveAt」の連鎖を要るため、`boilSecondsOf` ではなく連鎖そのものを `suggestedItemOf(view, recommendation): { order, suggestion } | null` として一つだけ置き、`orderQueueEntries` と `liftGroups` の両方がそれを呼ぶ。`boilSecondsOf`（署名は `(presets, order)`——茹で秒は品目の事実からの導出）と推奨 → 品目の突き合わせ `pendingItemOf`（`itemKey` を使う）は非公開のまま。(2) 到着順の全順序を `compareArrival` として `queueDisplay.ts` から export した（レールの並びと群の中の同値の並びが同じ順序を要る・AC 1.4）。`suggestedItemOf` / `compareArrival` は naming の表に無い公開関数だが、既存の内側の式を名にしただけで新しい概念境界を立てていない——要確認なら task 5 でまとめて。(3) `QueueSuggestion` に必須項目を足すため、リテラルを組む既存テスト 3 本（`slot-card.example` / `order-rail.example` / `order-queue.example`）に `serveAt` を足した（型の追随・主張は不変）。typecheck 0（`worker-configuration.d.ts` を除く）・lint エラー 0（警告は既存のみ・場面の組み立てを `liftViewOf` に出して `map` 内の spread を増やしていない）・fmt:check 通過・229 ファイル 1437 件通過（3 回連続・+2 ファイル +25 件）。**レビュー追記**：serveAt の等号 `startAt + boilSeconds × 1000` が `orderQueueEntries` と `liftGroups` の 2 箇所にインラインで在り、`boilSecondsOf` の doc は「同じ関数で serveAt を再計算する」と述べながら茹で秒しか返していなかった（二つの真実と構造に合わない注記）。連鎖を `suggestedItemOf` に一本化し、両者からインラインの等号を消し、`pendingItemOf` / `boilSecondsOf` を非公開に戻した。Property 1 の照合は `boilSecondsOf` ではなくプリセットから直に茹で秒を引く（導出側の関数を照合に使えば等式が空になる）。件数は変わらず 229 ファイル 1437 件通過。
  - _Requirements: 1.1〜1.10, 2.1〜2.14, 6.1〜6.3, 6.5, 6.8〜6.11_

- [ ] 5. 切り替え——旧経路の削除・表示型の変更・呼び出し側・描画・旧テストの撤去を **一つの作業単位**で行う（途中の状態では検査が通らないため、チェックポイントとコミットはこの task の末尾に一つ）
  - [ ] 5.1 `slotDisplay.ts`：idle の `next: readonly SlotSuggestion[]`。第 4 引数を `bySlot: ReadonlyMap<number, readonly SlotSuggestion[]> = NO_SUGGESTIONS`（省略可）にし、`nextForSlot` を削除
  - [ ] 5.2 `useAudioCues.ts:199` と `[]` を渡すテスト（`complete.example`・`audioCue.property`・`assignment-ui.example`・`localAuthority.property`・`degraded-slot-superimposition.{display,exploration}`）の第 4 引数を落とす。静的検査 `tests/sync-set-batch-complete.static.test.ts` の正規表現が `SlotBoard` の呼び出しで満たされることを確認
  - [ ] 5.3 `SlotBoard`：`planAnchor` と時期の語（`in` / `+`・`formatRemaining` の提案での使用）を撤去。`corrected` を一度読み、`liftGroups` → `visibleGroups` → `slotSuggestions` → `assignedSlotDisplays`。`suggestionOf` は `SuggestionView`（`role` で判別）を返す。`itemOf` を削除し `item.order` から鍵を取る
  - [ ] 5.4 `SlotCard`：`display.next` と `SuggestionView[]` を対で受け、`role` で分岐。`head` だけ丸ボタン（薄は opacity・濃は現行の塗り・語は `now` のみ）、`member` はラベルだけ。aria-label は `now` / `soon` / `queued`
  - [ ] 5.5 `queueDisplay.ts` から `suggestionTiming` / `SuggestionTiming` を削除
  - [ ] 5.6 旧テストの撤去：`tests/client/suggestionTiming.property.test.ts`（削除する関数を import）・`lapsedSuggestion.example.test.tsx`（旧表示の `in` / `+` を要求）・`slotSuggestion.{example,property}.test.ts`（`nextForSlot` / `itemOf`・task 4 の性質へ置き換え済み）
  - [ ] 5.7 `tests/client/slot-card.example.test.tsx` を書き換え：`head`（薄・濃）に丸ボタンと aria-label、`member` にボタン無し・濃くない、複数の提案の折り返しで Start が右下に留まる、時刻の語が無い（Requirement 6.4）。Requirement 6.6（担当外の空白）と「units A と B で共通する釜の `next` が一致」を `assignedSlotDisplays` の Property として足す
  - [ ] 5.8 チェックポイント（ここで初めて全体が通る）
  - _Requirements: 2.2〜2.5, 2.12, 3.1〜3.7, 6.4, 6.6, 7.3_

- [ ] 6. `RadialMenu.tsx` — 待ち行列の帯
  - [ ] 6.1 `RadialQueueItem` / `queue` / `onSelectItem` を足し、帯を花びらの反対側（`base` から導く・余白が足りなければ弧の下）に描く。`slotIds === null` の行は不活性。プリセットの花びらと幾何は変えない
  - [ ] 6.2 `SlotBoard`：`picker` が開いたとき `orderQueueEntries` の各行に `pairSlots(picker.slot, order.slotSpan, view)` を付けて渡す。degraded では `queue: []`。選択 → `connection.startOrderItem(slotIds, { externalOrderId, itemIndex })`
  - [ ] 6.3 `tests/client/radial-queue.example.test.tsx`（新規）：live で帯が出る・到着順・`slotSpan` 2 で足りない行は不活性・degraded で帯が無い・**開いたまま snapshot で起点の釜が走行中になると全行が不活性で `startOrderItem` が呼ばれない**
  - [ ] 6.4 チェックポイント
  - _Requirements: 4.1〜4.9, 6.11_

- [ ] 7. 横断の検証（engine を実走させた snapshot を client の導出に通す）
  - [ ] 7.1 `tests/client/liftGroups.crosslayer.example.test.ts`（新規）：`startOrderItemTimer` → `fireDueTimers` → `toWireSnapshot` で得た snapshot を `liftGroups` / `slotSuggestions` に通す。茹で上がりの 2 場面（同じ snapshot で 599 → 600 秒・その後の発火 snapshot）で「G2 が隠れる」が両方で成り立つこと。boiled の釜が index 最小 / 最大の両方。容量分割（6 釜・4 品・各 2 釜）の (i)(ii)——(ii) は再統合後に 3 品とも head
  - [ ] 7.2 同ファイルに `receivePlan` で合流一片を採用 → 無関係な Timer を `startTimer` → snapshot を `liftGroups` に通し、合流分の群が `started`、届かなくなった一片の群が `started` でない（`keepsAnchor` の帰結）
  - _Requirements: 1.7, 6.3, 6.10_

- [ ] 8. 文書の整合（本体と同じコミット）
  - [ ] 8.1 `slot-suggested-start` の Requirement 1.2・2.3〜2.5・判断 5 に本 spec が改めた旨を追記
  - [ ] 8.2 `online-cook-scheduling` design の「`unitOrigins` / `slotOffsets` は現時点で用途なし」を改める
  - [ ] 8.3 `lapsed-suggestion-timing` の requirements 冒頭に、本 spec が置き換えた旨を追記
  - [ ] 8.4 `docs/adr/0003` の Consequences（「`TimerFact` には出さない」）を改訂。`.kiro/steering/timer-model.md` の「駆動オーダーの保持」を「実装済み（`TimerFact.orderItem`・lift-group-display）」へ
  - _Requirements: 7.1〜7.4_

- [ ] 9. チェックポイント — 全体の green と実機の見え方
  - `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm fmt:check`。
  - 実機（`pnpm dev`・2 端末）で：同卓 3 品で先頭だけに丸ボタン、他は薄いラベル。先頭を押すと残りが錨に揃って次の先頭が濃くなる。別卓の群は先頭の群の 1 本目が始まるまで出ない。ラジアルに待ち行列の帯。degraded で提案も帯も消える。

- [ ] 10. 申し送り（本 spec の範囲外・記録のみ）
  - 麺種プリセットのアドホック開始（`connection.start`）は起点の釜の占有を検査しない既存経路のまま（design Component 3）。
  - 設定変更直後の hydration snapshot は旧 adjustment の錨で推奨を出す（`lift-group-planning` tasks の申し送り）。
