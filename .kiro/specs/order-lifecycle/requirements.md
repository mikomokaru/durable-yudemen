# Requirements Document

## Introduction

本 spec は、注文の品目を**生涯を通じて一つの事実として持つ**モデルへ改める。いまは「待ち行列の品目（未着手）」と「Timer（調理中）」が別の実体で、開始で品目を消費して Timer に写し、完了で Timer を消す。そのため調理中の品目は注文として見えず（釜のカードに卓・品名が出せない・番号を注文で切れない）、厨房のキャンセルで品目が失われる。

改めた後は、**品目は開始で消費されず、状態は保存せず導出する**——自分を指す生きた Timer が在れば調理中、`completedAt` が在れば調理済み、どちらも無ければ未調理。Timer は語彙もそのままで、注文品目への参照（既存の `Timer.orderItem`）を唯一の出所として持つ（Timer has 1..n Slots／Order item has 0..1 Timer／Timer has 0..1 Order item・ユーザー確定 2026-09-07）。釜側（カード・番号・音）は参照で品目を引いて注文のプロパティを読む。

前提：`pos-order-ingress`（受理・後着の全置換）、`pending-order-expiry`（Live_Orders・読む側の入口）、`plan-stability`（Shown_Plan の対応）、`sync-set-batch-complete`（一括完了・残滓）、`slot-suggested-start`（開始経路）。

### 観測事実（2026-09-07・main `Merge #37` 時点）

1. `Timer.orderItem { externalOrderId, itemIndex, tableId } | null`（`engine/timer.ts`・永続 v10）は既に**注文品目への参照**。開始（`start.ts` → `createTimer`）が一度だけ書き、以後不変。null はアドホック開始。
2. 開始は品目を待ち行列から**消費**する（`start.ts` → `pending.ts` `consumeOrder`）。以後、参照の先は状態に無い。
3. wire の `TimerFact` は `id / slotIds / noodleType / firmness / startTime / endTime` だけで、参照を運ばない（`project.ts` `toWireTimer`）。ADR-0003 は「読み手が無くなったので撤去」と記す。
4. `cancel` と `complete` は engine では同形（id 指定で Timer を除去・`cancel.ts` / `complete.ts`）。`complete` は boiled を検査しない（走行中でも受ける）。client の残滓（`lastResults`）はどちらも「snapshot から消えた Timer」として同じに扱う。
5. client の Cancel ボタンは残り 60 秒（`CANCEL_GUARD_THRESHOLD_MS`）以上で 2 段タップ、未満で 1 タップ即送信だが、**送るのはどちらも `cancel`**。早め上げの意味は運んでいない。
6. POS の後着（`receive.ts` → `upsertOrder` / `removeOrder`）は注文の品目を全置換し、**生きた Timer が指す品目は置換の結果から除く**（`pending.ts:31`・running を受け取る理由）。0 件なら注文ごと除去。
7. 待ち行列を読む入口は 6 つ（`pending-order-expiry` 観測事実 3）：計画対象 `placeableTargets` / `planTargets`・snapshot の `pendingOrders`・`RequestPlan.pending`・変更費用の対応・開始の照合・client の左レール。すべて `liveOrders(pending, now)` を通る。
8. 永続は v12（`shownPlan` まで）。`PendingOrder` は `externalOrderId / itemIndex / noodleType / firmness / tableId / arrivalTime / slotSpan / itemName / sizeName`。
9. 厨房の Cancel は Timer を消すだけで待ち行列を読まない。消費済みの品目は失われる（POS の再送でしか戻らない）。

### 確定した設計判断（2026-09-07 の対話で確定）

1. **品目は事実として残り、状態は導出する。** 開始で消費しない。`unstarted`＝自分を指す生きた Timer が無く `completedAt` も無い／`cooking`＝自分を指す生きた Timer が在る／`done`＝生きた Timer が無く `completedAt` が在る。状態の enum は保存しない（Timer の存在と二重にしない・ADR-0003 の理由をそのまま守る）。
2. **参照は Timer 側だけ（`Timer.orderItem`）。** 生成時に一度書いて不変、Timer が消えれば関係も消える。品目 → Timer は「自分を指す生きた Timer」を引く導出で、状態に持たない（Order → Timer の参照は消し忘れの失敗形があるので採らない）。
3. **完了は出来事の事実として品目に書く。** `complete`（単一・一括）は Timer を消し、指していた品目に `completedAt` を記録する。これが品目に足す属性の一つ目（永続 v13）。
4. **厨房の Cancel は未調理に戻す。** `cancel` は Timer を消すだけで何も記録しない。品目は導出で `unstarted` に戻り、左レールと計画に再び現れる（誤操作・釜を空けた、の意味）。
5. **早め上げは `complete` で送る（ユーザー確定 (a)）。** client は残り 60 秒未満の 1 タップで `complete` を、60 秒以上の 2 段タップで `cancel` を送る。しきいは UI の関心事のまま（engine は残り時間で判定しない）。engine は `complete` でだけ `completedAt` を書く。
6. **POS の取消は状態で分ける。** 後着で消える品目が `unstarted` なら従来どおり除去。`cooking`（生きた Timer が指す）なら**消さず** `cancelledAt` を記録する（品目に足す属性の二つ目）。走行中カードに取消を出せるようにするため（調理を止めるか出さないかは現場の判断・Timer は触らない）。`done` の品目への取消も `cancelledAt` を記録するだけ。
7. **後着の全置換は `unstarted` にだけ効く。** `cooking` / `done` の品目には名称・卓・盛りの追随だけを行い、削除・置換はしない。生きた Timer が指す品目は消えない（整合の規則）。
8. **期限（`pending-order-expiry`）は生きた Timer が指す品目を外さない。** `liveOrders` の述語に「生きた Timer が指す品目は残す」を足す。`done` / `cancelledAt` の品目は期限で読む側から消える（履歴の保持は正本のまま・別 spec）。
9. **wire は品目全件と参照を運ぶ。** snapshot の `pendingOrders` は `unstarted` に絞らず、期限内の品目全件（`unstarted` / `cooking` / `done`・`completedAt` / `cancelledAt` を含む）。`TimerFact` に `orderItem: { externalOrderId, itemIndex } | null` を足す。client は状態を導出し、左レールは `unstarted` だけを出す。番号・卓・品名・取消は釜のカードが参照で引く。
10. **読む側の入口は `unstarted` の導出集合を読む。** 計画対象・指紋・`RequestPlan.pending`・変更費用の対応・開始の照合（`cooking` の品目への開始は `OrderItemNotFound` ではなく「調理中」で拒否——新しい拒否事由を一つ足す）。`pending-order-expiry` の `liveOrders` と同じく、述語は domain に一つ置く。
11. **アドホック開始は注文を持たない Timer のまま。** 参照先の無い Timer を扱う経路は一つで、期限や削除の隙間で参照先が無くなった Timer も同じ経路に落ちる（表示は麺種だけ）。
12. **残滓（`lastResults`）は変えない。** 将来 `done` の品目から導出に置き換えられるが、本 spec の範囲外。
13. **`lift-order-numbering` はこの上に載る表示。** 番号の単位「同じ実効 endTime かつ同じ注文」は `TimerFact.orderItem.externalOrderId` で切る。卓・品名も参照で引く。

### スコープ外

- Timer の語彙・構造の変更（Boil_Sync・Alarm・発火・一括完了は不変）。
- 完了・取消の履歴の保持期間（期限の述語に乗せる。正本の整理は別 spec）。
- 残滓の導出化。走行中カードの表示項目のレイアウト（`lift-order-numbering` の design）。

## Glossary

- **Order_Item（注文品目）**: POS 由来の 1 品目。生涯を通じて一つの事実。`PendingOrder` 型の名は据え置く（naming ゲート）。
- **Item_Status（品目の状態）**: `unstarted` / `cooking` / `done` の導出値。保存しない。
- **Timer**: 一回の調理の記録（既存の語彙のまま）。1..n の釜を占め、0..1 の Order_Item を指す。
- **completedAt / cancelledAt**: 品目に記録する出来事の事実（完了・POS の取消）。

## Requirements

### Requirement 1: 品目の生涯と状態の導出

1. THE engine SHALL 開始（`StartOrderItem`）で品目を待ち行列から消費しない（`consumeOrder` を撤去）
2. THE domain SHALL `Item_Status(item, timers)` を一つの純粋関数で導く：自分を指す生きた Timer が在れば `cooking`、無く `completedAt` が在れば `done`、どちらも無ければ `unstarted`
3. THE `complete`（単一・一括） SHALL Timer を消し、指していた品目に `completedAt`（遷移の `now`）を記録する。指す品目が無ければ何もしない
4. THE `cancel` SHALL Timer を消すだけで品目に何も記録しない（品目は `unstarted` へ戻る）
5. THE 開始の照合 SHALL `unstarted` の品目だけを対象にし、`cooking` の品目への開始は「調理中」の拒否事由で、`done` の品目への開始は `OrderItemNotFound` で拒否する
6. THE 永続スキーマ SHALL 版を 12 から 13 へ上げ、`completedAt` / `cancelledAt` の欠如を null に畳む

### Requirement 2: POS の後着

1. THE 後着の全置換 SHALL `unstarted` の品目にだけ効く。`cooking` / `done` の品目は名称（`itemName` / `sizeName`）・卓（`tableId`）・麺種・茹で加減を追随させるだけで、削除・置換しない
2. WHEN 後着で消える品目が `cooking` または `done` のとき、THE engine SHALL その品目に `cancelledAt` を記録して残す
3. THE 生きた Timer が指す品目 SHALL いかなる遷移でも集合から消えない

### Requirement 3: 期限との関係

1. THE `liveOrders` SHALL 生きた Timer が指す品目を期限に依らず残す
2. THE `done` / `cancelledAt` の品目 SHALL 期限で読む側から消える（保持は正本）

### Requirement 4: 読む側の入口

1. THE 計画対象・指紋・`RequestPlan.pending`・変更費用の対応 SHALL `unstarted` の導出集合を読む（述語は domain に一つ）
2. THE snapshot の `pendingOrders` SHALL 期限内の品目全件（状態を問わず・`completedAt` / `cancelledAt` を含む）を運ぶ
3. THE `TimerFact` SHALL `orderItem: { externalOrderId, itemIndex } | null` を運ぶ（`toWireTimer` が `Timer.orderItem` から写す。decode は形を検証）
4. THE client の左レール SHALL `unstarted` だけを出す（導出）。ラジアルも同じ集合

### Requirement 5: client の操作

1. THE 走行中カードの停止ボタン SHALL 残り 60 秒未満の 1 タップで `complete` を、60 秒以上の 2 段タップで `cancel` を送る（しきいは既存の `CANCEL_GUARD_THRESHOLD_MS`）
2. THE 走行中カード SHALL `TimerFact.orderItem` で品目を引き、卓・品名・取消（`cancelledAt`）を出せる（何を出すかは `lift-order-numbering` の design）

### Requirement 6: 検証可能な性質

1. **状態の排他**：任意の品目は `unstarted` / `cooking` / `done` のちょうど一つ
2. **参照の整合**：生きた Timer の `orderItem` が指す品目は集合に在る（期限・後着・取消を跨いで）
3. **Cancel は戻す**：`cancel` の後、その品目は `unstarted` で左レールと計画に現れる
4. **早め上げは完了**：残り 60 秒未満の停止は `completedAt` を書き、品目は `done`
5. **全置換の範囲**：後着は `unstarted` だけを置換し、`cooking` / `done` は名称・卓の追随だけ
6. **読む側の一致**：計画対象・指紋・要求・対応・開始の照合・左レールが同じ `unstarted` 集合を見る
7. **不変**：Timer の集合・Boil_Sync・Alarm・一括完了・残滓は変わらない。v12 の永続は `completedAt` / `cancelledAt` null で読める

### naming ゲート（`naming.md`）

| 候補名 | 場所 | 表明する概念境界 |
| --- | --- | --- |
| `itemStatusOf(item, timers)` / `Item_Status`（仮） | `src/domain/order.ts` | 品目の状態の導出（unstarted / cooking / done） |
| `unstartedOrders(pending, timers, now)`（仮） | `src/domain/order.ts` | 読む側が見る未調理の集合（期限 ＋ 状態） |
| `PendingOrder.completedAt` / `cancelledAt`（仮） | `src/domain/order.ts` | 出来事の事実 |
| `TimerFact.orderItem`（仮） | `src/domain/timer.ts` | Timer → 品目の参照（wire） |
| 拒否事由 `OrderItemCooking`（仮） | `src/engine/start.ts` | 調理中の品目への開始 |

`PendingOrder` の型名は据え置く（生涯を持つようになるが、改名の影響が大きい。Glossary で Order_Item と対応させる）。

### 未決（design で決める）

1. `pendingOrders` に `done` / 取消の品目を全件載せる wire の大きさ（期限 2 時間の内側に限る。問題になれば `done` を別配列にする）。
2. 一括完了（`sync-set-batch-complete`）の `completedAt` の記録先（各メンバーの品目）。
3. `cancelledAt` を持つ `cooking` の品目の表示（`lift-order-numbering` の design）。
