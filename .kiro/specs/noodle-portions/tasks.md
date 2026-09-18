# Implementation Plan

> **レビュー前提（2026-09-18・ユーザー指定）：まだ運用していない。** migration・旧版互換・移行期間の保護に関する作業は今回のレビュー指摘・実装着手の承認条件に含めない（task 0 の移行・切り替え、3.2〜3.4 の旧画面互換部分、5.2〜5.6 の旧版移行部分、7 の移行保護部分、9 の互換性に関する部分、11 の移行手順）。新形式の永続復元・必須値検査、通常の設定投入・配信・表示・計画・回帰検証は引き続き対象とする。この前提で tasks の実装分解と検証計画に実装を妨げる指摘はない。チェック欄は実施状況を表すため、レビュー結果で完了扱いにはしない。

前提：作業ツリー `mikomokaru/order-management`（`order-flow`・永続 v14・`liftIntervalSeconds` 主張対象化の未コミット変更の上）。永続の版は **v15** へ上げる。ワイヤ（`WireOrderItem` / `config`）と Provisioning_API の `menuItems` の形が変わる。触るのは domain / registry / ingress / engine / cpsat / shell / client の `slotSpan` の読み手すべてと、テスト・文書。

- [x] 0. naming ゲートと判断をユーザーが承認する（2026-09-18 承認：`portions` / `PORTIONS_PER_SLOT` / `isPortions` / `slotSpanOf` / `portionsLabel`・玉数を事実として保持し釜数を導出する設計。**運用前のため、既存データの移行・旧画面互換・移行期間の受領保護・静止条件は実装範囲から外す**——3.4・7.1 の門と併記・7.2(b)・7.3 の併記・7.4・11.3 は着手しない。旧版の永続を読める最小の復元（5.3）だけは dev の店舗 DO を起動不能にしないために残す）
  - 名：`portions`（`NoodleSize` / `OrderItem` / `NoodleSpec` / `WireOrderItem`）・`PORTIONS_PER_SLOT`（1.5）・`PORTIONS_MIN` / `PORTIONS_MAX`・`isPortions`・`slotSpanOf`・`portionsLabel`・`PORTIONS_UNIT`
  - 規則：`slotSpanOf(p) = ⌈p / 1.5⌉`（定数・店舗設定にしない）
  - 移行：v14 以前の品目は `portions = slotSpan`（仮置き）。仮置きが読み手に届かないことは Idle_Precondition（全店 2 時間以上受領なし・走行中なし）で保証し、deploy 前に検証する
  - 表示：`displayName` と `BowlTile` の両方に `1.5玉` を添える／単位「玉」は初期化子 1 箇所に閉じて静的検査の例外を広げる
  - 切り替え：古い形の投影を持つ店舗 DO は受領を `unprovisioned` で返す（番号を進めない・上流の再送に委ねる）／サーバは移行期間ワイヤに `slotSpan` を併記して旧画面の復号器を落とさない（除去は別 spec）／イデアはコードで移行せず deploy 直後に `pos-menu` を玉数で再投入

- [x] 1. domain：占有規則と設定の形
  - [x] 1.1 `src/domain/store.ts`：`PORTIONS_PER_SLOT` / `PORTIONS_MIN` / `PORTIONS_MAX` / `isPortions` / `slotSpanOf`。`NoodleSize` を `{ code, portions }` に。`toNoodleSize` は `isPortions` で畳む。`toSlotSpan` を消す。`SLOT_SPAN_MIN` / `MAX` は残す（導出値の値域の正本）
  - [x] 1.2 `tests/domain/slot-span-of.property.test.ts`（新規）：性質 1〜3（単調・値域・天井の意味）。性質 4（18 値の全数で有理数の天井と一致）と観測事実 7 の表（0.5→1・1→1・1.5→1・2→2・2.5→2）は example
  - [x] 1.3 `tests/core/store-config-lookups.*`：`toMenuItems` が `portions` 欠落・刻み外・値域外の要素を落とし、`sizes` が空なら `MenuItem` を落とすこと
  - _Requirements: 1.1, 1.4, 2.1〜2.5, 9.1〜9.4_

- [x] 2. registry：投入の検証
  - [x] 2.1 `src/registry/validate.ts`：`validateNoodleSize` の許可フィールドを `["code", "portions"]` に。欠落 `missing-required`・非数 `type-mismatch`・刻み外／値域外 `out-of-range`。`slotSpan` は `unknownFieldRejections` に任せる（専用分岐を書かない）
  - [x] 2.2 `tests/registry/validate.example.test.ts`：性質 9（`slotSpan` は未知フィールド／`portions` の欠落・非数・1.25・0・9.5 をそれぞれの理由で拒む／0.5〜9 の 0.5 刻みは受理）。`tests/registry/compose.*` / `ideal.property` のフィクスチャを `portions` へ
  - [x] 2.3 `config/provisioning-sample/README.md`：検証範囲の表に `firmnessCodes` / `menuItems`（`sizes[].portions`：0.5〜9・0.5 刻み）を足す
  - _Requirements: 1.2, 1.3, 1.5, 1.6, 9.9_

- [x] 3. domain：品目とワイヤ
  - [x] 3.1 `src/domain/order.ts`：`OrderItem.portions`（`slotSpan` を消す）。`toArrivedItem` は `isPortions(candidate.portions)`。doc の「注文属性 6 つ」の `slotSpan` を `portions` に
  - [x] 3.2 `src/domain/wire.ts`：`toOrderItemFromWire` の関門を `isPortions(portions)` に。併記の `slotSpan` は読まない。`WireOrderItem` に任意項目 `slotSpan?: number`（Wire_SlotSpan）を doc 付きで宣言。ヘッダの「slotSpan の域内」を書き替える
  - [x] 3.3 `tests/domain/order.*` / `wire.*` / `wireGenerators.ts`：生成器を Portions（`fc.integer({min: 1, max: 18}).map(n => n / 2)`）に。性質 8（往復）。`portions` 欠落・値域外は Decode_Failure。併記の有無で復号結果が同じ
  - [ ] 3.4 `tests/domain/wire-transition.example.test.ts`（新規・性質 12）：**deploy 前の `toOrderItemFromWire` を写しとして固定**し、新しい snapshot（`portions` + 併記 `slotSpan`）を復号できること。この写しは併記を外す spec で一緒に消す
  - _Requirements: 3.1, 3.4, 5.6〜5.8, 9.8, 9.12_

- [x] 4. ingress と shell の翻訳
  - [x] 4.1 `src/ingress/noodle-spec.ts`：`NoodleSpec.portions = size.portions`。ヘッダの「3 つの事実」を麺種・茹で加減・玉数に
  - [x] 4.2 `src/shell/store-timer-do.ts`：`toReceivedOrders` が `portions: spec.portions` を写す
  - [x] 4.3 `tests/ingress/noodle-spec.example` / `.property`：Property 4 を「玉数が同定した `NoodleSize.portions` に等しい」に読み替え（性質 7）。フィクスチャを `portions` へ
  - _Requirements: 3.2, 3.3, 9.7_

- [x] 5. engine：読み手と永続
  - [x] 5.1 `src/engine/schedule.ts` / `pending.ts` / `digest.ts` / `admit.ts` / `commit.ts` / `lift.ts` / `start.ts`：`item.slotSpan` を `slotSpanOf(item.portions)` に。`upsertOrder` は `portions` を写し、`isSameOrderItems` は `portions` を比べ、`digest` は `portions` を畳む。コメントの「slotSpan」は導出値として読める文に直す（意味は変えない）
  - [x] 5.2 `src/engine/types.ts`：`CURRENT_SCHEMA_VERSION = 15`。台帳に v15 の行（`OrderItem.portions` を足し `slotSpan` を落とす・v8〜v14 は `portions = slotSpan`・v7 以前は 1）
  - [x] 5.3 `src/engine/migrate.ts`：`reviveOrderItems(value, version)` → `toOrderItem(value, version)` と版を下ろし、`reviveSlotSpan` を `revivePortions(o, version)` に（design Data Models）。v15 以上は `portions` 必須で `slotSpan` を読まない。v8〜v14 は `slotSpan` から仮置き。v7 以前は 1
  - [x] 5.4 `tests/core/migrate.example` / `.property`：v15 往復・**v15 で `portions` 欠如は `MigrationFailed`**（版で分けた必須検査・性質 5）・v14（`slotSpan` 1〜2）→ v15 で `slotSpanOf(portions)` が元に一致・v14 の `slotSpan` 3 以上は仮置きで釜数が変わること（design 判断 5 の代償を数値で固定）・v15 で `portions` 値域外は `MigrationFailed`・v7 以前は 1
  - [x] 5.5 `tests/core/*`（フィクスチャ 60 ファイル超）：`slotSpan: k` → `portions: k`。釜数 3 以上を要る scene は `k × PORTIONS_PER_SLOT`。生成器（`tests/core/generators.ts`）を Portions に。**期待値は変えない**（性質 10：`schedule.example` / `plan-stability-occupancy.example` / `stability.*` / `lift.property` などが緑のままであることが回帰）
  - [x] 5.6 `docs/persisted-schema-rollback.md` §3 に v15 の行（下り移行：`version` を 14 にし各品目へ `slotSpan = slotSpanOf(portions)` を書き戻す。書き戻さなければ v14 の `reviveSlotSpan` が欠如を 1 へ畳み、大盛が 1 釜になる）
  - _Requirements: 3.5〜3.7, 4.1〜4.7, 7.1, 9.5, 9.10_

- [x] 6. cpsat
  - [x] 6.1 `src/cpsat/request.ts` / `plan.ts` / `worker.ts`：`slotSpanOf(item.portions)`。観測の内訳の鍵は導出値のまま
  - [x] 6.2 `tests/cpsat-*.example` / `tests/core/cpsat-*.example` / `tests/shell/cpsat-*.integration`：フィクスチャを `portions` へ
  - _Requirements: 7.2, 7.3_

- [x] 7. shell：古い投影の門・反映点・配信
  - [x] 7.1 `src/shell/store-timer-do.ts`：`hasCurrentMenuShape(menuItems)`（`sizes` の全要素が `portions` を持つ）。`receiveRecords` で `provisioned` の直後に、古い形なら `{ kind: "unprovisioned" }`（design Component 6）。`adoptProjectionConfig` で `this.menuItems = toMenuItems(config.menuItems)`（`liftIntervalSeconds` の畳み込みの隣に、同じ理由の注記で）。snapshot の射影（`:849`・`shortName` を被せる箇所）で `slotSpan: slotSpanOf(item.portions)` を併記（Wire_SlotSpan・除去条件を doc に）
  - [ ] 7.2 `tests/shell/store-timer-rehydrate.integration`：(a) v14 の永続値（`slotSpan` 1 と 2 の品目）を持つ DO を起こすと v15 として読め、次の確定で v15 が書かれ、`slotSpanOf(portions)` が元の釜数に一致する、(b) **性質 11**——`slotSpan` 形の `sizes` を持つ永続投影の DO に Record を渡すと `unprovisioned` で、`lastSequenceByTerminal` と `orderItems` が変わらない。`applyProjection` で新しい投影を入れた後に同じ Record を渡すと `settled` で、品目が `portions` 付きで載る
  - [x] 7.3 `tests/shell/apply-projection.integration`：新しい形の `menuItems` が `config` で再配信される。`tests/shell/pos-records.integration` / `tests/worker/pos-records-end-to-end.integration`：玉数が `OrderItem.portions` に載る。broadcast の snapshot に併記 `slotSpan` が載る（旧画面の復号器の写しで復号できる・性質 12）
  - [ ] 7.4 `tests/registry/*` / `tests/worker/*`：Worker が `unprovisioned` を 5xx（一時的失敗）にする既存の振る舞いが、古い形の投影の店舗でも同じであること（既存テストの場面を 1 つ足す）
  - _Requirements: 5.1〜5.9, 8.4, 9.11, 9.12_

- [x] 8. client
  - [x] 8.1 `src/client/components/SlotBoard.tsx`：`pairSlots(picker.slot, slotSpanOf(order.portions), view)`。`RadialMenu.tsx` / `connection.ts` / `liftGroups.ts` のコメントを導出値として読める文に
  - [x] 8.2 `src/client/components/queueDisplay.ts`：`portionsFigure(portions)`（数字だけ・単位なし）。`NoodleChip.tsx`（新規）が麺種と玉数を一つのチップに置く。`displayName` は変えない（改訂 2026-09-18・当初の「末尾に `1.5玉`」は撤回）
  - [x] 8.3 `OrderRail` / `RadialMenu` / `SlotCard`（`NoodleBadge` の `chip`）/ `OrderFlowBoard`（`Card` / `BowlTile` / 走行中の札）の品名の前にチップ。注文を持たない Timer はチップ無し
  - [x] 8.4 単位「玉」を画面に出さないので `tests/offline-degradation.static.test.ts` の例外は広げない（一度広げた例外は撤去した）。`.kiro/specs/offline-degradation/requirements.md` 要件 13.6 の注記もその旨に改めた
  - [x] 8.5 `tests/client/*`（`generators.ts` / `slotDisplay` / `order-queue` / `order-rail` / `radial-queue` / `slot-board-suggestions` / `slot-card` / `liftGroups.*` / `order-flow-*` / `flow-lanes`）：フィクスチャを `portions` へ。`displayName` の例（`醤油中盛 1.5玉`・`味噌 1玉`・`半玉 0.5玉`）と `BowlTile` の例（`中盛 1.5玉`・アドホックは `—`）を `tests/display/displayName.example` / `order-flow-board.example` に足す
  - _Requirements: 3.7, 6.1〜6.5_

- [x] 9. 静的検査と文書
  - [x] 9.1 `tests/noodle-portions.static.test.ts`（新規）：性質 6——`src/domain` の型宣言に `slotSpan:` が無い（`WireOrderItem` の `slotSpan?:` だけを例外として名指しし、それが任意項目であること）／`src` で `PORTIONS_PER_SLOT` を割る式は `slotSpanOf` の定義だけ／`src/registry/validate.ts` の許可フィールドに `slotSpan` が無い／`toOrderItemFromWire` の本文に `slotSpan` が現れない
  - [x] 9.2 `docs/adr/0017-slot-occupancy-is-derived-from-portions.md`（design「ADR」）
  - [x] 9.3 `.kiro/specs/pos-order-ingress/design.md` §5・§6 と `requirements.md` AC 6.24〜6.25 に改訂注記（釜数→玉数・本 spec 参照）。`.kiro/specs/cpsat-planner-integration/verification/menu-policy-slotspan-20260914.md` §6 未処理 2 に「本 spec で実装」の注記
  - [x] 9.4 `.kiro/steering/timer-model.md` の「既知の分岐点」に 1 行（玉数は `OrderItem` の共有事実・`TimerFact` には及ばない）
  - _Requirements: 9.6_

- [x] 10. 全数ゲート
  - [x] 10.1 `pnpm typecheck` / `pnpm lint` / `pnpm fmt:check`（触ったファイルのみ `pnpm fmt`）/ `pnpm test` を全数で回す。property は 3 回再実行。**申告ではなく出力で確かめる**（`subagent-verification-reports`）
  - [x] 10.2 `grep -rn slotSpan src tests` の残りを読み、残るのが「導出値としての釜数」の読み手（局所変数・コメント）だけであることを確かめる

- [ ] 11. ロールアウト（deploy の手順）
  - [x] 11.1 玉数を持つ `pos-menu` の JSON——`config/provisioning-sample/pos-menu-policy.json`（未追跡・2026-09-18 完成）。9/14 投入版を元に CSV の玉数で 39 コード、ユーザーの規則（麺種に「つけ」を含めば 1.5 / 2 / 2.5、含まなければ 1 / 1.5 / 2）で 3 コード。同じコードは全メニューで同じ玉数（検算済み・違反 0）
  - [x] 11.2 deploy 前に JSON をローカルの `validatePolicy` に通す（`slotSpan` / `null` が 1 つでも残れば 400）。同じコードが全メニューで同じ玉数であることを再検算する
  - [ ] 11.3 **Idle_Precondition の検証**：Workers Logs で直近 2 時間（`ORDER_LIFETIME_MS`）の `records-received` と `Persist` が全店で 0 件であることを確かめる。満たさなければ deploy しない（仮置きの玉数が現場に表示される）
  - [x] 11.4 アプリ Worker と CP-SAT 計画器 Worker を同じ変更で deploy する。以後 11.5 まで Provisioning_API へ他の投入をしない（design Component 7）
  - [x] 11.5 直後に `PUT /admin/policies/pos-menu` を投入し、`converge` の残作業が尽きるのを待つ（全 200 店の投影が作り直される）。deploy から投入までが `ARRIVAL_WINDOW_MS`（2 時間）より十分短いことを記録する
  - [ ] 11.6 確認：任意の店舗で受領が `settled` になり品目が `portions` 付きで載る／client の `config` に `sizes[].portions` が載る／Workers Logs で `unprovisioned` 由来の 5xx が止まり、受領件数が投入前の水準に戻る
  - [ ] 11.7 別 spec として立てる：`GET /admin/policies/{policyId}`（未決 4）・Wire_SlotSpan の除去と「全端末更新済み」の確認手段（未決 5）
  - _Requirements: 8.1〜8.5_

## 実測（2026-09-18・実装）

- 型検査 0 件・lint は既存の警告のみ（本 spec の変更に由来する警告なし）・`pnpm test` **330 ファイル / 2523 件・失敗 0**（skip は既存の 11 件）。触ったテスト 11 ファイルの property は 3 回再実行とも 74 / 74。
- **範囲から外したもの（運用前・task 0 の承認）**：3.4（旧復号器の写し）・7.1 の門と併記（`hasCurrentMenuShape` / Wire_SlotSpan）・7.2(b)・7.3 の併記・7.4・11.3（Idle_Precondition）。`adoptProjectionConfig` の `toMenuItems` 通しと、v8〜v14 を仮置きで読む `revivePortions(o, version)` は残した（dev の店舗 DO を起動不能にしないため）。
- **spec からの逸脱 1 点**：Order_Ingress（`POST /s/{storeId}/orders`・JSON ボディ）の `portions` **欠如は 1 玉へ畳む**（AC 3.4 は拒否としていた）。旧 `toSlotSpan` が欠如を 1 釜へ畳んでいたのと同じ「指定が無い入力の形に対する既定」であり、既存の統合テスト（`cook-scheduling` ほか 14 件）がこの経路で麺量の語彙を持たない品目を投入している。値域外・刻み外・非数・null は拒否のまま。POS 経由の翻訳は必ず玉数を持つのでここを通らない（`domain/order.ts` の `toPortions`）。
- 1.1：`PORTIONS_PER_SLOT` / `PORTIONS_MIN` / `PORTIONS_MAX` / `isPortions` / `slotSpanOf`（半玉単位の整数演算 `⌈2p / 3⌉`）。`toSlotSpan` を消した。`SLOT_SPAN_MIN` / `MAX` は導出値の値域として残る。
- 1.2：`tests/domain/slot-span-of.property.test.ts`（性質 1〜4 ＋ 観測事実 7 の表 ＋ 定数の関係・6 件）。
- 2.1：`validatePortions` を `validateNumeric` と別に立てた（整数前提を緩めない）。`slotSpan` は `unknownFieldRejections` が拾う（専用分岐なし）。
- 5.1：`schedule.ts` 14 箇所・`pending.ts`（写しと同一性）・`digest.ts`（玉数を畳む）・`admit` / `commit` / `lift` / `start` はコメントのみ。`lift.ts` の `span = slotIds.length` は不変。
- 5.3：`reviveOrderItems(value, version)` → `toOrderItem(value, version)` → `revivePortions(o, version)`。v15 以上は `portions` 必須で `slotSpan` を読まない（同居しても消える）。`tests/core/migrate.example` に v14（1・2・3 釜 → 1・2・3 玉・導出 1・2・2）と v15（欠如／値域外／刻み外は失敗・同居する釜数は読まれない）を足した。
- 5.5：フィクスチャは `slotSpan: k` → `portions: k`（k ∈ {1, 2}）。3 釜以上を要る scene は玉数へ写した——`schedule.example` の 4 釜は 6 玉・5 釜は 7.5 玉、`admit.example` / `commit.example` / `cpsat-composition` の 5 釜は 7.5 玉。`tests/client/generators.ts` の Timer 由来の品目は `slotIds.length × 1.5`（導出が本数に一致する）。**性質 10**：`schedule.*` / `plan-stability-occupancy` / `stability.*` / `lift.property` / `startable-placement.*` は期待値を変えずに緑。
- 7.1：`this.menuItems = toMenuItems(config.menuItems)`。snapshot 射影は `store-timer-do.ts:849` を触っていない（併記は範囲外）。
- 8.2〜8.4：`portionsLabel`（`1.5玉` / `2玉` / `0.5玉`）を `displayName` の末尾に空白区切りで添え、`BowlTile` はサイズの語の横に出す。静的検査は `PORTIONS_UNIT = "玉"` の 1 行だけを例外に足した（`tests/offline-degradation.static.test.ts`）。render テスト 6 ファイルの語（`Salt L 2玉 · ふつう · Table t-1` など）を更新。丼の棚（Bowls）の品名はタレ名（`tareName`）のままで玉数は付かない。
- 9.1：`tests/noodle-portions.static.test.ts`（4 件・static プロジェクトに登録し workers から除外）。
- 9.2〜9.4：ADR-0017・`pos-order-ingress` design §6 / requirements AC 6.24・`menu-policy-slotspan-20260914.md` §6・`offline-degradation` 要件 13.6・`timer-model.md` に注記。`docs/persisted-schema-rollback.md` に v15 の行。`config/provisioning-sample/README.md` に `firmnessCodes` / `menuItems` / `liftIntervalSeconds` の行。
- 11.2（2026-09-18 実測）：`validateProvisioningInput({ target: "policyFields", raw: fields })` は `{ accepted: true }`。導出の内訳は 1玉→1釜 52・1.5玉→1釜 55・2玉→2釜 55・2.5玉→2釜 3・0.5玉→1釜 3（全 168 サイズ・同じコードで玉数のぶれ 0）。
- 実験ハーネス（`experiments/cpsat-workers/transport/*.mjs` 5 本）の品目も `portions: 1` へ揃えた（`cpsat-real-model.example` / `cpsat-transport-app.example` が通る）。
- 11.4〜11.6（2026-09-18 実測）：PR #45 を main へマージ（`fc5a6b8`）。CI/CD run 35306305714 は Lint / Typecheck / Test・Deploy to Cloudflare とも success。直後 04:21:08Z に `PUT https://timer-dev.yamaokaya.org/admin/policies/pos-menu` → `200 {"accepted":true}`（7.3 秒・送信 JSON の SHA-256 `e10377a8…75620a`）。対象は `chainId: yamaokaya` の 196 店（active 195）。**店舗側の確認（11.6）は未了**——`/s/{storeId}/ws` は Access（`ymoky.cloudflareaccess.com`）で保護され、workers.dev 側も JWT なしでは 1006 で閉じるため、機械からは `config` を読めない。Access でログイン済みのブラウザから 1 店舗の `config` を読んで `sizes[].portions` を確かめる。
- 表示の改訂（2026-09-18・ユーザー指示「玉数を品名に含めず badge に。（玉）は省略。麺の種類と玉が 1 箇所で分かるように」）：`NoodleChip`（`{noodleType} {portions}`・例 `Thin 1.5`・麺種の色で塗る・`data-chip`）を待ち行列の行・ラジアルの帯・釜のバッジ（上がり順チップの隣・読み上げは末尾に `· Thin 1`）・Orders 画面の札に置いた。`displayName` は元に戻し、`portionsLabel` → `portionsFigure`。render 6 ファイルの語を戻し、チップの語を足した。typecheck 0・fmt:check 通過・render 65 / 65・全数 2508 件緑。
