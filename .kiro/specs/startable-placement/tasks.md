# Implementation Plan

前提：main（#34 まで）。永続の版は上げない（v12 のまま）。`pending-order-expiry` と同じ進め方（task ごとに `[-]` → `[x]` と実測・チェックポイント・コミット）。

- [x] 0. naming ゲート（design の表）をユーザーが承認する（2026-09-06 承認：`occupiedSlotsOf` / `pinNow` / `Pinned` / `cannotStart` / `operationScenes`）
  - `occupiedSlotsOf`（domain）、`pinNow` / `Pinned`・`cannotStart`（engine 内部）、`operationScenes`（tests）

- [x] 1. 事実の述語と harness
  - 実測・2026-09-06: `src/domain/store.ts` の `slotOf` の隣に `occupiedSlotsOf(timers: readonly { readonly slotIds: readonly string[] }[]): ReadonlySet<number>`（Timer の載る釜・補集合が Startable_Slot・engine の `Timer` も wire の `TimerFact` も満たす入力）を置き、client の `occupiedSlots(view)` は `occupiedSlotsOf(view.timers)` を返す薄い包みにした（`headsOf` / `displayableItemsOf` / `pairSlots` の呼び手は不変）。`tests/client/liftGroups.example`（+3：集合そのもの・6 品 6 釜の提案が落ちる釜 = `occupiedSlotsOf`・`pairSlots` が null の釜 = `occupiedSlotsOf` ちょうど）。`tests/core/operationScenes.ts`（新設・純粋）：`kitchenOf`（engine の params と client の config を同じ値で）・`step`（decide → Broadcast snapshot・拒否と no-op は throw・`alarmAt` を添える）・`viewOf` / `groupsOf` / `suggestionsOf` / `suggestionSummaryOf` / `displayedHeadsOf`（表示の順）・操作 `startHeads`（表示された先頭を提案の釜で）・`fire`（茹で上がり）・`completeOn(state, slot, now)`（釜 N の Timer を Complete）・`nextBoilEndOf`・駆動 `operate(kitchen, from, policy)`（刻みごとに「発火（茹で上がりの時刻で）→ 猶予を過ぎた boiled を昇順／降順に 1 釜 Complete → 表示された先頭を n 本開始」を踏み trace を返す）・性質 4.2 の述語 `startableGapOf(kitchen, step)`（表示の順で最初の `startAt ≤ now` の品目について、Timer が無く採用済み接頭辞の配置（推奨に一致する採用済み一片の配置で茹で時間帯が重なるもの）が予約していない釜が slotSpan に足り、上がりを含む窓の負荷が arms + HELPER_ARMS 以下なのに head の提案が一つも無ければ空白。「今」の品目が無ければ主張しない。合流は「計画が既に今に置いた事実」で足りるので別に検査しない。遷移の直後にだけ当てる）・`gapsOf(trace)`。`tests/core/startable-placement.example`（新設 5 件・4 通過 + 1 `it.fails`）：観測事実 8 を engine の実走で再現——開始 0 / 3 / 6 / 9 / 42 / 45 秒（Boil_Sync が 0・3 秒開始を 57 秒、6・9 秒開始を 67.5 秒へ揃え、上げ窓 [57, 102) が 4 本で埋まる）、発火 57 / 67.5 / 103.5 / 136.5 秒、72 秒（57 + 15）に釜 1 を Complete した直後は釜 0 が boiled（57 秒）・釜 1 が空き・釜 2・3 が boiled（67.5 秒）・4・5 が走行中で、残り A（o6#0）は釜 0 に「今」（72 秒・先頭群）、B（o7#0）は釜 1 に「今」（後続群）、提案は空、空白は `{at: 72, head: "o6#0", placedOn: [0], startable: [1], occupied: [0,2,3,4,5], groups: [["o6#0"],["o7#0"]]}` の 1 箇所だけ（45〜67.5 秒の全釜占有は空き釜不足の例外）。75 秒の釜 0 の Complete で再開（A が釜 0 に now → 75 秒に開始、B は 78 秒）し、8 品は最後まで処理され待ち行列も Timer も残らない。望む状態「72 秒の直後に A が釜 1 に「今」で先頭・空白なし」は `it.fails`（task 3 が `.fails` を外す）、修正前の観測は「【修正前の観測・task 3 が 0 箇所へ置き換える】」の 1 件に明示。typecheck 0（worker-configuration.d.ts を除く）・lint 0 errors（警告は既存）・fmt:check clean（428 files）・全数 245 ファイル 1680 テスト通過 + 1 expected fail。
  - [x] 1.1 `src/domain/store.ts` に `occupiedSlotsOf(timers)` を置き、client の `occupiedSlots(view)` をそれに置き換える（結果不変を `liftGroups.example` で見る）
  - [x] 1.2 `tests/core/operationScenes.ts`：decide → snapshot → decideView → liftGroups / slotSuggestions の連続処理 harness と、「今割当可能な Startable_Slot が先頭品目に足りるのに提案が空」の述語（例外：空き不足・予約の排他・上げ窓・合流）
  - [x] 1.3 観測事実 8 の 8 品の再現を `startable-placement.example` に赤で固定（72 秒の釜 1 の Complete の後に提案が出ない）
  - _Requirements: 1.1（事実の共有）, 4.3_

- [ ] 2. 合成の失効
  - [ ] 2.1 `commit.ts`：`livePrefix` に `occupied` を通し、`hasLapsedStart` を `cannotStart`（過去開始 ∨ `startAt ≤ now` かつ釜に Timer）に広げる。`committedSchedule` が `occupiedSlotsOf(running)` を一度作る
  - [ ] 2.2 `commit.example`：boiled の釜に `startAt === now` の採用済み一片は落ちる／Timer の無い釜なら残る／時刻の到来で「今」になった将来配置も次の遷移で落ちる
  - _Requirements: 3.4, 3.5_

- [ ] 3. 2 段の計画
  - [ ] 3.1 `baselineSchedule(…, now, occupied, changeContext)`：1 段目 → `pinNow` → 2 段目（配分が同じなら 1 段目を返す）。呼び手（`commit.ts` / `src/solver` / テスト・`scheduleScenes` / `schedulingScenes`）に `occupied` を通す
  - [ ] 3.2 `pinNow`：表示順（`startAt` → `compareArrival`）、`pool`（`release ≤ now`）の上の**排他的な割当**（`claimed`）。今割当可能な釜が足りる品目は空き釜だけから（前回の釜 → 1 段目の釜 → `chooseSlots`）、足りない品目は待つ釜（boiled）だけから（1 段目の釜 → 前回の釜 → index）、それも足りなければ混ぜて index 順（退避先）。固定配置どうしの釜の重複が無いことを性質に
  - [ ] 3.3 `buildSchedule(…, pinned)`：固定した配置を先に解放表・上げ表へ載せる（**卓の成員表＝走行中の錨には足さない**。局所費用の `members` にだけ足す）。`placeGroup` は固定した品目をそのまま出力し、残りに下限を当てる——batch は `earliest`、合流は置いた後の配置時刻（`joinable` / `joinTarget` は変えない）。忠実／候補比較の両方に通す。レビュー反例（固定配置を成員に足すと 60 秒麺に `anchor: 600` が付く／窓延期の合流 45 → 105 秒が残る）を例示に
  - [ ] 3.4 テスト：`startable-placement.example`（8 品の再現が緑・レビュー反例 3 件：卓 X/Y の表示順配分・予約の排他で A は待つ・C は「今」にならない）、`startable-placement.property`（4.1・4.6・4.7）、24 品の連続処理（昇順／降順・Shown_Plan 有無・採用済み接頭辞有無・同卓／別卓／卓なし・slotSpan 1／2）で例外に当たらない空白 0
  - [ ] 3.5 既存の性質（`schedule.property` / `commit.property` / `admit.property` / `lift-split` / `continuous-input` / `plan.example` / `settle-*`）がそのまま通る。期待値が動く場合は理由を実測に書く
  - [ ] 3.6 チェックポイント（typecheck / lint 0 errors / test / fmt:check）とコミット
  - _Requirements: 1.1〜1.8, 2.1〜2.3, 3.1〜3.3, 4.1, 4.2, 4.4〜4.7_

- [ ] 4. 文書と最終ゲート
  - [ ] 4.1 `lift-group-planning`（`baselineSchedule` の署名・2 段・`initialRelease` の注記「Complete は釜の占有ではない」に「開始の可否は別」を添える）、`lift-group-display`（`occupiedSlots` は domain の共有述語）、`plan-stability`（前回の釜の第一候補は 2 段目の配分に吸収）、`online-cook-scheduling`（合成の失効に開始を妨げる配置）に日付付きの注記
  - [ ] 4.2 ADR-0012：予測（解放表）と事実（Timer の無い釜）を分け、「今」置く配置の釜の選択にだけ事実を読ませる。Considered Options：boiled を占有として解放表に載せる／連鎖を緩めて後続群を出す／同点処理だけ／client だけで直す
  - [ ] 4.3 全数チェックポイント（typecheck / lint 0 errors / test / fmt:check）
