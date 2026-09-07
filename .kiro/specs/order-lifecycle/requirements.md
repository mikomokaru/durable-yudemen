# Requirements Document

## Introduction

本 spec は、注文の品目を**生涯を通じて一つの事実として持つ**モデルへ改める。いまは「待ち行列の品目（未着手）」と「Timer（調理中）」が別の実体で、開始で品目を消費して Timer に写し、完了で Timer を消す。そのため調理中の品目は注文として見えず（釜のカードに卓・品名が出せない・番号を注文で切れない）、厨房のキャンセルで品目が失われる。

改めた後は、**品目は開始で消費されず、状態は保存せず導出する**——品目の生涯は「未調理 → 調理中 → 調理済み」の 3 状態で完結し、自分を指す生きた Timer（走行中・茹で上がりとも）が在れば調理中、Timer が無く `completedAt` が在れば調理済み、どちらも無ければ未調理。厨房の Cancel だけが「調理中 → 未調理」へ戻す操作である。Timer は語彙もそのままで、注文品目への参照（既存の `Timer.orderItem`）を唯一の出所として持つ（Timer has 1..n Slots／Order item has 0..1 Timer／Timer has 0..1 Order item・ユーザー確定 2026-09-07）。釜側（カード・番号・音）は参照で品目を引いて注文のプロパティを読む。

**入力の前提（ユーザー確定・2026-09-07）：POS の取消は発生しない。** 取消相当の品目の削除・数量の減少・茹で対象 0 件への後着も、本 spec が扱う範囲では発生しないものとする（後着は名称・卓・麺種・茹で加減の変更通知）。この前提を理由に受理処理を黙って変えることはしない（Requirement 2）。

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

1. **品目は事実として残り、状態は導出する。** 開始で消費しない。導出の順は (1) 自分を参照する生きた Timer が在る → `cooking`（**生きた Timer は走行中だけでなく、茹で上がって Complete を待つ boiled も含む**——時間が来ただけでは `done` にならない。茹で上がりと、厨房が完了を確定することは別）、(2) Timer が無く `completedAt` が在る → `done`、(3) どちらも無い → `unstarted`。状態の enum は保存しない（Timer の存在と二重にしない・ADR-0003 の理由をそのまま守る）。第 4 の状態は作らない。
2. **参照は Timer 側だけ（`Timer.orderItem`）。** 生成時に一度書いて不変、Timer が消えれば関係も消える。品目 → Timer は「自分を指す生きた Timer」を引く導出で、状態に持たない（Order → Timer の参照は消し忘れの失敗形があるので採らない）。
3. **操作と状態の対応。** 開始＝Timer を作る（品目は残り `cooking`）／茹で上がり＝Timer は boiled として残る（引き続き `cooking`）／完了・早め上げ＝Timer を除去し、参照していた品目に `completedAt = now`（`done`）／厨房 Cancel＝Timer を除去し、参照していた品目に **`interruptedAt = now`**（調理が中断された時刻・最後の値で上書き）を記録する。完了日時は書かないので状態は `unstarted`／一括完了＝対象 Timer を除去し、**対象 Timer が参照していた各品目**に `completedAt = now`。品目に足す属性は `completedAt` と `interruptedAt` の二つ（永続 v13）。
3′. **`interruptedAt` は状態に効かない事実（ユーザー確定・2026-09-07）。** `unstarted` の条件は「生きた Timer なし ∧ `completedAt` なし」のまま。中断された品目も未調理として計画と左レールに戻り（期限内なら）、左レールはこの事実で「一度戻された品目」を色分けできる（表示は `lift-order-numbering` の design）。再び始めて完了すれば `done`（`completedAt` が優先）、再び中断されれば上書き。番号・計画の優先には使わない。参照先の無い Timer（アドホック・v12 由来）の Cancel は何も書かない。
4. **早め上げは `complete` で送る（ユーザー確定 (a)）。** client は残り 60 秒未満の 1 タップで `complete` を、60 秒以上の 2 段タップで `cancel` を送る。しきいは UI の関心事のまま（engine は残り時間で判定しない）。engine は `complete` でだけ `completedAt` を書く。
5. **調理の状態と期限（2 時間）は別の軸（レビュー P1）。** 期限切れは第 4 の状態ではなく、「未調理だが期限切れ」「調理済みで期限切れ」は普通に在る。読む集合は二つに分かれる——**計画・左レール・ラジアル**＝期限内 ∧ `unstarted`（`pendingOrders(items, timers, now)`）／**snapshot の品目集合**＝期限内 **または** 生きた Timer の参照先（`orderItemsToBroadcast`）。注文から 1 時間 59 分で 10 分茹での品目を開始し 2 時間 1 分に snapshot を送っても、Timer が残る間は品目を配信して卓・品名を引ける。期限判定を共有することと、全用途で同じ集合を読むことは別。
6. **厨房 Cancel は状態を戻し、期限は戻さない（レビュー P2）。** Cancel 後の品目は `unstarted` に戻るが、期限外なら左レール・計画には戻らない。`arrivalTime` は更新しない（「注文から 2 時間」を「最後にやり直した時刻から 2 時間」に変えない）。
7. **後着は注文情報を更新し、調理の記録は変えない（レビュー 5）。** `OrderItem` は最新の注文情報（名称・盛り・卓・麺種・茹で加減）、`Timer` はその調理を開始した時点の情報。POS の後着で、いま茹でている麺の条件は書き換えない。卓の変更ではカードは新しい卓を表示する一方、計画の `tableMembers` は Timer に残る旧卓を使う——既存の契約（`timer.ts:59`）を据え置き、その意味をここに書く。`done` の品目は同じ注文の再送で `unstarted` に戻らない（`completedAt` を保つ）。
8. **受理は変えない。生きた Timer が指す品目は消えない。** 後着の全置換は既存どおり「生きた Timer を持つ品目は置換の結果から除く」（`pending.ts:31`）。前提（POS の取消なし）を理由に受理を黙って変えず、置換が取消の意味を持たない範囲を Requirement 2 に定める。
9. **wire は「期限内または生きた Timer の参照先」の品目全件と参照を運ぶ。** snapshot は `pendingOrders` を `orderItems` に改め、`orderItemsToBroadcast` の集合（`unstarted` / `cooking` / `done`・`completedAt` 付き）を運ぶ。`TimerFact` に `orderItem: { externalOrderId, itemIndex } | null` を足す。client は状態を導出し、左レールは `pendingOrders(items, timers, correctedNow)` だけを出す。番号・卓・品名は釜のカードが `orderItemOf(timer, items)` で引く。
10. **「未調理」は保存された集合ではなく関数。** 保存する型を `PendingOrder` から `OrderItem` に改名し（`TimerState.orderItems`・永続 v13 の移行で鍵も読み替える）、読む側の導出は 4 つに限る——`itemStatusOf(item, timers)`（状態の正本）、`pendingOrders(items, timers, now)`（計画と左レールの入口＝期限 ∧ unstarted・`liveOrders` を内側に畳む）、`orderItemsToBroadcast(items, timers, now)`（snapshot の集合＝期限内 ∨ 参照先）、`orderItemOf(timer, items)`（Timer → 品目の参照解決・無ければ null＝注文なしと同じ経路）。`cookingOrders` は読み手が現れるまで作らない。語彙は Timer 側 `running`、品目側 `cooking`。
11. **solver には `pendingOrders` と `running` を渡す。** `PlanRequest.pending` は engine が導いた未調理の品目（solver は今どおり自分の `now` で期限をもう一度当てる）。`running` は走行中の Timer 全件（注文由来もアドホックも・`orderItem` 参照付き）のまま。品目全件は solver に渡さない。
12. **読む側の入口は `pendingOrders` を読む。** 計画対象・指紋・`RequestPlan.pending`・変更費用の対応・開始の照合（`cooking` の品目への開始は `OrderItemCooking` で拒否——新しい拒否事由を一つ足す。`done`・期限切れ・不在は `OrderItemNotFound`）。
13. **アドホック開始は注文を持たない Timer のまま。** 参照先の無い Timer を扱う経路は一つで、表示は麺種だけ。
14. **v12 の走行中 Timer は限定された移行例外（レビュー P1）。** 旧実装は開始時に品目を消しているので、v12 → v13 の移行（`pendingOrders` → `orderItems`・`completedAt` 欠如 → null）をしても、既に始まっている Timer の参照先は存在せず、Timer には品名・到着時刻が無いので復元できない。推測で品目を作らず、限界を明示する——旧版由来で参照先の無い Timer はそのまま動かす／カードの参照が解決できなければ注文なし相当の表示／完了・Cancel は従来どおり Timer を除去し、存在しない品目に完了日時は書かない／この旧 Timer を Cancel しても注文品目は戻らない／v13 で新しく開始した注文 Timer について参照整合を保証する。
15. **残滓（`lastResults`）は変えない。** 将来 `done` の品目から導出に置き換えられるが、本 spec の範囲外。
16. **保持量（レビュー 6）。** 通常どおり調理・完了した品目も正本に残るので、永続は以前より増える。2 時間で配信対象から外しても永続は減らない。整理（折りたたんだ期限切れ一覧からの一括削除）は別の機能として意味を持ち、そのとき生きた Timer の参照先は削除対象から外す。wire の `done` を別配列に分けても全件送る限り配信量は減らない（未決 1）。
17. **`lift-order-numbering` はこの上に載る表示。** 番号の単位「同じ実効 endTime かつ同じ注文」は `TimerFact.orderItem.externalOrderId` で切る。卓・品名も参照で引く。

### スコープ外

- POS の取消（削除・数量減少・0 件への後着）。発生しない前提。発生したときの意味は別 spec。
- Timer の語彙・構造の変更（Boil_Sync・Alarm・発火・一括完了は不変）。
- 完了した品目の保持期間・整理（別の機能）。残滓の導出化。走行中カードの表示項目のレイアウト（`lift-order-numbering` の design）。

## Glossary

- **Order_Item（注文品目・`OrderItem`）**: POS 由来の 1 品目。生涯を通じて一つの事実（旧 `PendingOrder`）。
- **Item_Status（品目の状態）**: `unstarted` / `cooking` / `done` の導出値。保存しない。
- **pendingOrders（未調理）**: 保存された集合ではなく関数。期限内 ∧ `unstarted`。計画と左レールの入口。
- **Timer**: 一回の調理の記録（既存の語彙のまま）。1..n の釜を占め、0..1 の Order_Item を指す。生きた Timer＝走行中または茹で上がり（Complete 前）。
- **completedAt**: 品目に記録する完了の事実（厨房が確定した時刻）。
- **interruptedAt**: 品目に記録する中断の事実（厨房 Cancel で調理が止められ未調理に戻った最後の時刻）。状態には効かず、表示の色分けにだけ使う。

## Requirements

### Requirement 1: 品目の生涯と状態の導出

1. THE engine SHALL 開始（`StartOrderItem`）で品目を集合から消費しない（`consumeOrder` を撤去）
2. THE domain SHALL `itemStatusOf(item, timers)` を一つの純粋関数で導く：自分を指す生きた Timer（running / boiled）が在れば `cooking`、無く `completedAt` が在れば `done`、どちらも無ければ `unstarted`
3. THE `complete`（単一・一括） SHALL Timer を消し、対象 Timer が参照していた各品目に `completedAt`（遷移の `now`）を記録する。指す品目が無ければ何もしない
4. THE `cancel` SHALL Timer を消し、参照していた品目に `interruptedAt`（遷移の `now`・上書き）を記録する。`completedAt` は書かないので品目は `unstarted` へ戻る。`arrivalTime` は更新しない。参照先が無ければ何も記録しない
5. THE 開始の照合 SHALL `pendingOrders(items, timers, now)` の品目だけを対象にし、`cooking` の品目への開始は `OrderItemCooking` で、それ以外（`done`・期限切れ・不在）は `OrderItemNotFound` で拒否する
6. THE 永続スキーマ SHALL 版を 12 から 13 へ上げ、`pendingOrders` を `orderItems` に読み替え、`completedAt` / `interruptedAt` の欠如を null に畳む
7. THE 型名 SHALL `PendingOrder` を `OrderItem` に改める（状態のフィールドは `TimerState.orderItems`）。「未調理」は `pendingOrders` 関数だけが表す

### Requirement 2: POS の後着（取消なしの前提）

1. THE 後着 SHALL 注文情報（名称・盛り・卓・麺種・茹で加減）の変更通知として扱い、`unstarted` の品目を既存どおり全置換する
2. THE 生きた Timer が指す品目 SHALL 置換の結果から除かれ、集合から消えない（既存の `pending.ts:31` の規則のまま。参照整合）
3. THE `done` の品目 SHALL 同じ注文の再送で `unstarted` に戻らない（`completedAt` を保つ）。注文情報の追随だけを受ける
4. THE 受理 SHALL 前提（POS の取消なし）を理由に変えない。前提の外（品目の削除・数量減少・0 件への後着）の意味は本 spec で定めず、置換が黙って取消の意味を持たないことを回帰で固定する

### Requirement 3: 調理の状態と期限

1. THE `pendingOrders(items, timers, now)` SHALL 期限内 ∧ `unstarted` の品目を返す（`liveOrders` を内側に畳む）
2. THE `orderItemsToBroadcast(items, timers, now)` SHALL 期限内 **または** 生きた Timer の参照先である品目を返す（調理中の品目は期限を超えても Complete まで配信され、参照を保つ）
3. WHEN 厨房 Cancel で品目が `unstarted` に戻ったとき、THE 品目 SHALL 期限内なら左レールと計画に再び現れ、期限外なら現れない
4. THE `done` の品目 SHALL 期限で読む側（計画・左レール・snapshot）から消える（保持は正本）

### Requirement 4: 読む側の入口

1. THE 計画対象・指紋・`RequestPlan.pending`・変更費用の対応 SHALL `pendingOrders(items, timers, now)` を読む（述語は domain に一つ）
2. THE snapshot SHALL `orderItems`＝`orderItemsToBroadcast(items, timers, now)` を運ぶ（`pendingOrders` フィールドは廃する）
3. THE `PlanRequest` SHALL `pending`（engine が導いた未調理の品目）と `running`（走行中の Timer 全件・`orderItem` 参照付き）を運ぶ。品目全件は運ばない。solver は `pending` に自分の `now` で期限を当てる（現行の規律）
4. THE `TimerFact` SHALL `orderItem: { externalOrderId, itemIndex } | null` を運ぶ（`toWireTimer` が `Timer.orderItem` から写す。decode は形を検証）
5. THE client の左レール SHALL `pendingOrders(orderItems, timers, correctedNow)` だけを出す（導出）。ラジアルも同じ集合
6. THE 釜のカード SHALL `orderItemOf(timer, orderItems)` で品目を引く。無ければ注文なし（アドホック・旧版由来）と同じ表示

### Requirement 5: client の操作

1. THE 走行中カードの停止ボタン SHALL 残り 60 秒未満の 1 タップで `complete` を、60 秒以上の 2 段タップで `cancel` を送る（しきいは既存の `CANCEL_GUARD_THRESHOLD_MS`）
2. THE 走行中カード SHALL `TimerFact.orderItem` で品目を引き、卓・品名を出せる（何を出すかは `lift-order-numbering` の design）

### Requirement 6: 移行（v12 → v13）

1. THE 移行 SHALL `pendingOrders` を `orderItems` に読み替え、各品目の `completedAt` / `interruptedAt` を null にする
2. THE v12 由来で参照先の無い Timer SHALL そのまま動く（発火・完了・Cancel は従来どおり）。完了しても存在しない品目に `completedAt` は書かない。Cancel しても注文品目は戻らない（限界を明記する）
3. THE v13 で新しく開始した注文 Timer SHALL 参照整合（性質 7.2）を満たす

### Requirement 7: 検証可能な性質

1. **状態の排他**：任意の品目は `unstarted` / `cooking` / `done` のちょうど一つ。boiled の Timer が指す品目は `cooking`
2. **参照の整合（v13 以降）**：生きた Timer の `orderItem` が指す品目は集合に在り、`orderItemsToBroadcast` に含まれる（期限・後着を跨いで）
3. **Cancel は状態を戻す**：`cancel` の後、その品目は `unstarted` で `interruptedAt` を持つ。期限内なら左レールと計画に再び現れ、期限外なら現れない。`arrivalTime` は不変
3′. **中断は状態に効かない**：`interruptedAt` の有無は `itemStatusOf` と `pendingOrders` の結果を変えない。再開始→完了で `done`、再中断で `interruptedAt` は上書き
4. **早め上げは完了**：残り 60 秒未満の停止は `completedAt` を書き、品目は `done`
5. **全置換の範囲**：後着は `unstarted` だけを置換し、`cooking` / `done` は注文情報の追随だけ。`done` は再送で `unstarted` に戻らない
6. **読む側の一致**：計画対象・指紋・要求・対応・開始の照合・左レール・ラジアルが同じ `pendingOrders(items, timers, now)` を見る
7. **配信の集合**：snapshot の品目集合は「期限内 ∨ 生きた Timer の参照先」。期限を超えた調理中の品目は Complete まで配信される
8. **注文情報と調理の記録**：後着で卓が変わると、カードは新しい卓、計画の `tableMembers` は Timer の旧卓（既存契約）
9. **移行**：v12 の永続は `orderItems` に読み替えられ、参照先の無い Timer は動き続け、完了・Cancel で消える。`completedAt` は書かれない
10. **不変**：Timer の集合・Boil_Sync・Alarm・一括完了・残滓は変わらない

### naming ゲート（`naming.md`）

| 候補名 | 場所 | 表明する概念境界 |
| --- | --- | --- |
| `OrderItem`（旧 `PendingOrder`） | `src/domain/order.ts` | 生涯を通じて残る注文品目の事実 |
| `TimerState.orderItems`（旧 `pendingOrders`） | `src/engine/state.ts` | 品目の集合（状態を問わない正本） |
| `OrderItem.completedAt` | `src/domain/order.ts` | 完了の事実（厨房が確定した時刻） |
| `OrderItem.interruptedAt` | `src/domain/order.ts` | 中断の事実（厨房 Cancel で未調理に戻った最後の時刻・状態に効かない・色分け用） |
| `itemStatusOf(item, timers)` | `src/domain/order.ts` | 状態の導出の正本（unstarted / cooking / done） |
| `pendingOrders(items, timers, now)` | `src/domain/order.ts` | 未調理＝期限 ∧ unstarted（計画と左レールの入口・`liveOrders` を内側に畳む） |
| `orderItemsToBroadcast(items, timers, now)` | `src/domain/order.ts` | snapshot の品目集合＝期限内 ∨ 生きた Timer の参照先 |
| `orderItemOf(timer, items)` | `src/domain/order.ts` | Timer → 品目の参照解決（釜側の入口・null＝注文なし） |
| snapshot の `orderItems`（旧 `pendingOrders`） | `src/domain/messages.ts` / `wire.ts` | 配信する品目の集合 |
| `TimerFact.orderItem` | `src/domain/timer.ts` | Timer → 品目の参照（wire） |
| `PlanRequest.pending` ＋ `running`（据え置き） | `src/engine/effect.ts` / `src/solver/request.ts` | solver の入力（導いた未調理の品目 ＋ 走行中の Timer 全件） |
| 拒否事由 `OrderItemCooking` | `src/engine/start.ts` | 調理中の品目への開始 |

`cookingOrders` は作らない（読み手が現れるまで）。`cancelledAt` は持たない（POS の取消は前提の外。厨房の中断は `interruptedAt`）。語彙は Timer 側 `running`・品目側 `cooking`。

### 未決（design で決める）

1. snapshot の `orderItems` の大きさ。「期限内 ∨ 参照先」で全件送る限り、`done` を別配列に分けても配信量は減らない。期限 2 時間の内側に限られることで足りるかを実測で見る。
