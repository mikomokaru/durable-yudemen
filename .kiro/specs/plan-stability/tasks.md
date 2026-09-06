# Implementation Plan

前提：main（#32 まで）。永続は v11 → v12。`lift-group-planning` と同じ進め方（task ごとに `[-]` → `[x]` と実測・チェックポイント・コミット）。

- [x] 0. naming ゲートの確認（design 末尾の表）——ユーザー承認済み（2026-09-06「namingOK」）

- [ ] 1. Head の共有導出（`src/domain/lift-group.ts`）
  - [ ] 1.1 `liftGroupsOf` / `visibleGroupsOf` / `headsOf` / `LiftItem` を domain に新設し、client の `liftGroups.ts` をそれを呼ぶ形に寄せる（`ClientView` からの取り出しだけを残す）
  - [ ] 1.2 client の既存テスト（`liftGroups.*`・`slot-board-suggestions.*`・crosslayer・`slotDisplay.property`）が変更なしに通ることを確認（表示の挙動は変えない・AC 4.3）
  - [ ] 1.3 チェックポイント
  - _Requirements: 4.3, Glossary Head_

- [ ] 2. Shown_Plan（状態・永続 v12・確定）
  - [ ] 2.1 `src/engine/stability.ts`：`ShownItem` / `ShownPlan` / `EMPTY_SHOWN_PLAN` / `shownPlanOf(schedule, recommendations)`（`serveAt` / `slotIds` / `startAt` / `anchor` は `Placement` から・`mates` は同じ `group` の相手の鍵）
  - [ ] 2.2 `TimerState.shownPlan`・`EMPTY_STATE`・`snapshot.ts`・`types.ts`（v12 の doc 行）・`migrate.ts`（欠如 → 空・壊れた要素は落とす）・`docs/persisted-schema-rollback.md` の v12 行
  - [ ] 2.3 `settle.ts`：確定結果の `Persist` に `shownPlanOf(snapshot.recommendations)` を載せる。`isSameConfirmedResult` は `shownPlan` を比べない。no-op / 棄却 / hydration で更新しないことを `settle.example` に
  - [ ] 2.4 `migrate.{example,property}`：v11 → v12 の二方向・壊れた要素の切り捨て
  - [ ] 2.5 チェックポイント
  - _Requirements: 1.1〜1.3, 1.5〜1.7, 5.8_

- [ ] 3. Change_Cost と採点
  - [ ] 3.1 `changeCost(next, context, params)`（design Component 2 の手順どおり・秒相当の整数・`context` に `pending` / `presets`・窓の数と減衰はミリ秒の L × 1000、費用は秒の L・順の逆転は群を跨いだ全対応の組・分割は同じ群だった組）
  - [ ] 3.2 `ScoreContext` を導入し、`scoreSchedule(slices, pending, context, params)` の `total` に Change_Cost を足す（`bySlice` は不変）。呼び出し側（`admit` 3 回・`commit`・テスト）を追随
  - [ ] 3.3 `admit`：`prev.shownPlan`・再同期後の Timer・受領時刻の now を `ChangeContext` に。`receivePlan` から渡す
  - [ ] 3.4 `stability.property`（5.1・5.3・5.4・5.5・5.9）と `stability.example`（4 種の費用の例）
  - [ ] 3.5 `admit.example`：前回と大きく違う外部計画が微小な改善で通らない／改善が費用を上回れば通る
  - [ ] 3.6 チェックポイント
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
