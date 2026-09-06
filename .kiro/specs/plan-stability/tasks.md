# Implementation Plan

前提：main（#32 まで）。永続は v11 → v12。`lift-group-planning` と同じ進め方（task ごとに `[-]` → `[x]` と実測・チェックポイント・コミット）。

- [x] 0. naming ゲートの確認（design 末尾の表）——ユーザー承認済み（2026-09-06「namingOK」）

- [x] 1. Head の共有導出（`src/domain/lift-group.ts`）
  - 実測・2026-09-06: `src/domain/lift-group.ts` に `LiftItem` / `LiftGroupOf<T>` / `liftGroupsOf` / `visibleGroupsOf` / `displayableItemsOf` / `headsOf` を新設。品目の鍵（`ItemKey` / `itemKeyOf`）と到着順（`compareArrival`）は `src/domain/order.ts` へ移し、client の `queueDisplay.ts` はそれを呼ぶ。client の `liftGroups.ts` は `suggestedItemOf`（`LiftItem` に提案を重ねた `SuggestedItem` を返す）・`occupiedSlots`・`mode` の取り出しと釜ごとの並べ直しだけを残し、`LiftGroup` は `LiftGroupOf<SuggestedItem>` の別名。`GroupItem` / `SlotSuggestion` / `pairSlots` は不変。client の既存テスト（`liftGroups.example` / `liftGroups.property` / `liftGroups.crosslayer` / `slot-board-suggestions` / `slotDisplay.property` / `generators.smoke` / `slot-card` / `radial-queue` / `order-queue`）は 1 行も変えずに通過。`tests/domain/lift-group.example.test.ts`（8 件：束ね・started・連鎖・Prep_Lead・arms の上限・占有釜・時刻順・表示できない群）を追加。typecheck 0・lint 0 errors・fmt:check clean・234 ファイル 1544 テスト全通過。
  - [x] 1.1 `liftGroupsOf` / `visibleGroupsOf` / `headsOf` / `LiftItem` を domain に新設し、client の `liftGroups.ts` をそれを呼ぶ形に寄せる（`ClientView` からの取り出しだけを残す）
  - [x] 1.2 client の既存テスト（`liftGroups.*`・`slot-board-suggestions.*`・crosslayer・`slotDisplay.property`）が変更なしに通ることを確認（表示の挙動は変えない・AC 4.3）
  - [x] 1.3 チェックポイント
  - _Requirements: 4.3, Glossary Head_

- [x] 2. Shown_Plan（状態・永続 v12・確定）
  - 実測・2026-09-06: `src/engine/stability.ts` に `ShownItem` / `ShownPlan` / `EMPTY_SHOWN_PLAN` / `shownPlanOf(schedule, recommendations)` を新設（配置から `slotIds` / `startAt` / `serveAt` / `anchor`、`recommend` の `group` から `mates`——自分を含まず対称・計画順）。`TimerState.shownPlan` / `EMPTY_STATE` / `StoreSnapshot` / `toSnapshot` / `fromSnapshot`、`CURRENT_SCHEMA_VERSION = 12`（doc 行）、`migrate.ts` の `reviveShownPlan` / `reviveShownItem`（欠如・非配列は空、壊れた要素はその要素だけ落とす）、`docs/persisted-schema-rollback.md` の v12 行（v11 の `migrate` は `shownPlan` を読まないので `version` を 11 にするだけ）。`settle.ts` は `deriveRecommendations`（`committedSchedule` → `recommend` を一度だけ）と `snapshotMessage` に分け、no-op 検出の後に `confirmed = { ...nextState, shownPlan: shownPlanOf(committed, recommendations) }` を Persist と返り値の状態に載せる。`isSameConfirmedResult` は `shownPlan` を比べない。追随：`timer-model.static`（鍵集合・inline snapshot v12）、`offline-degradation.static`（core のファイル集合に `stability.ts`）、`store-timer-observation-fault.integration`（Working_Copy の期待値）。テスト：`tests/core/stability.example.test.ts`（7 件）、`tests/core/settle-shown-plan.example.test.ts`（6 件：確定変化で Persist の `shownPlan` が Broadcast の推奨と一致・比較の相手は prev・no-op / 棄却 / hydration で不変）、`migrate.example`（v11 → v12 の 4 件）、`migrate.property`（v11 の欠如 → 空・v12 の往復・壊れた要素だけ落とす）。typecheck 0（worker-configuration.d.ts を除く）・lint 0 errors・fmt:check clean・236 ファイル 1564 テスト全通過。
  - [x] 2.1 `src/engine/stability.ts`：`ShownItem` / `ShownPlan` / `EMPTY_SHOWN_PLAN` / `shownPlanOf(schedule, recommendations)`（`serveAt` / `slotIds` / `startAt` / `anchor` は `Placement` から・`mates` は同じ `group` の相手の鍵）
  - [x] 2.2 `TimerState.shownPlan`・`EMPTY_STATE`・`snapshot.ts`・`types.ts`（v12 の doc 行）・`migrate.ts`（欠如 → 空・壊れた要素は落とす）・`docs/persisted-schema-rollback.md` の v12 行
  - [x] 2.3 `settle.ts`：確定結果の `Persist` に `shownPlanOf(snapshot.recommendations)` を載せる。`isSameConfirmedResult` は `shownPlan` を比べない。no-op / 棄却 / hydration で更新しないことを `settle.example` に
  - [x] 2.4 `migrate.{example,property}`：v11 → v12 の二方向・壊れた要素の切り捨て
  - [x] 2.5 チェックポイント
  - _Requirements: 1.1〜1.3, 1.5〜1.7, 5.8_

- [x] 3. Change_Cost と採点
  - 実測・2026-09-06: `src/engine/stability.ts` に `ChangeContext` / `changeCost(next, changeContext, params)` を新設（design Component 2 の手順どおり。旧 Shown_Plan は `mates` の連結成分に比較の内側で閉じる仮の群を振って `LiftItem` に組み、新しい計画は `recommend` の `group` / `anchor` で組む。両側とも同じ now・同じ Timer 集合（`running` / `boiled` の釜を占有）で `headsOf` に掛ける。(a) 2L・(b) L（釜番号の集合で比較）・(c-1) 同じ群だった組の分割 L・(c-2) 全対応の組の逆転 L・(d) h_i 超過分の窓の数 × L / (k + 1) の床。窓と減衰はミリ秒の L × 1000、費用は秒の L）。`objective.ts` に `ScoreContext { members, lifts, change }` を導入し `scoreSchedule(slices, pending, scoreContext, params)` の `total` にだけ足す（内側で `recommend` を呼ぶ・`bySlice` 不変）。`admit(arrived, committed, pending, running, shown, now, presets, params)` は一つの `ScoreContext` を 3 回の採点に渡し、`receivePlan` は `state.shownPlan`（遷移前）を渡す。`committedSchedule` は採点しないので不変（task 4 で配置に通す）。**引数名の逸脱**：Operation History の静的検査（`no-wake.static`）が Producer の import graph に `context` という識別子と `bucket*.get` を禁じ、graph が `objective → stability → lift-group` に届くため、引数は `scoreContext` / `changeContext`、`lift-group.ts` の `buckets` は `byGroup` に改名（型名 `ScoreContext` / `ChangeContext` は design どおり）。テスト：`stability.example`（+11 件：先頭 2L・釜 L・分割 L・逆転 L・1 窓 L と 45 ≠ 45000・減衰 45/22/15/4・h_i 内側 0・同じ計画は now / Timer に依らず 0・10 秒開始の保護・対応の規律・加法と整数）、`stability.property`（5.1・5.3・5.4・5.5・5.9、Shown_Plan は `baselinePlan` → `shownPlanOf` で現実の自前解から）、`admit.example`（+2 件：2 秒の改善は変更費用 180 で棄却・Shown_Plan 空なら採用／600 秒の改善は費用 123 を上回り採用）、`scheduleScenes.baselinePlan` を追加。既存の `scoreSchedule` / `admit` 呼び出し（objective.* / admit.* / schedule.example）を追随。typecheck 0（worker-configuration.d.ts を除く）・lint 0 errors・fmt:check clean・237 ファイル 1582 テスト全通過。
  - [x] 3.1 `changeCost(next, context, params)`（design Component 2 の手順どおり・秒相当の整数・`context` に `pending` / `presets`・窓の数と減衰はミリ秒の L × 1000、費用は秒の L・順の逆転は群を跨いだ全対応の組・分割は同じ群だった組）
  - [x] 3.2 `ScoreContext` を導入し、`scoreSchedule(slices, pending, context, params)` の `total` に Change_Cost を足す（`bySlice` は不変）。呼び出し側（`admit` 3 回・`commit`・テスト）を追随
  - [x] 3.3 `admit`：`prev.shownPlan`・再同期後の Timer・受領時刻の now を `ChangeContext` に。`receivePlan` から渡す
  - [x] 3.4 `stability.property`（5.1・5.3・5.4・5.5・5.9）と `stability.example`（4 種の費用の例）
  - [x] 3.5 `admit.example`：前回と大きく違う外部計画が微小な改善で通らない／改善が費用を上回れば通る
  - [x] 3.6 チェックポイント
  - _Requirements: 2.1〜2.6, 4.1, 5.1, 5.3〜5.5, 5.9_

- [ ] 4. 自前解が前回を残す
  - [ ] 4.1 `chooseSlots(..., preferred)` と `assignSlots` の第一候補（前回の釜が候補の時刻までに空けば採る）
  - [ ] 4.2 batch の並びの同値の断ち方に前回の `startAt` 順
  - [ ] 4.3 `placeWithLifts`：局所費用に Change_Cost の差分（**先頭の変更 (a) を含む 4 種**・列の候補配置を仮に置いた計画に `headsOf`）、第 3 候補「前回のまとまりを保つ分割」、同点は前回を保つ側。回帰：arms 1・L 45・茹で 600 秒・走行中 2 本が 600 秒・旧提案 A 今／B 45 秒後 → 両方 45 秒後の pack を採らない
  - [ ] 4.4 `baselineSchedule` / `committedSchedule` / `src/solver` に `ChangeContext | null` を通す。`RequestPlan.shownPlan` を足す（指紋には畳まない）
  - [ ] 4.5 `schedule.example`（前回の釜・埋まっていれば既存の規則・まとまりを保つ分割・改善が上回れば変わる）と Property 5.6 / 5.7
  - [ ] 4.6 横断：連続投入の場面で投入のたびに残りの釜と順が変わらない（Change_Cost 0 が続く）
  - [ ] 4.7 チェックポイント
  - _Requirements: 3.1〜3.4, 4.5, 5.6, 5.7_

- [ ] 5. 文書と全体
  - [ ] 5.1 `online-cook-scheduling` の目的関数の注記（Change_Cost・2.9 の例外）、`lift-group-planning` design の `scoreSchedule` 署名（`ScoreContext`）、`lift-group-display` design（Head の導出が domain へ移った旨）
  - [ ] 5.2 ADR-0010：前回提示した提案を履歴の事実として持ち、変更に費用を付ける（判断 1〜8）
  - [ ] 5.3 全体のチェックポイント（typecheck / lint / test / fmt:check）
