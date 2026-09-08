# Design Document

## Overview

注文品目（`OrderItem`・旧 `PendingOrder`）を生涯を通じて一つの事実として持ち、状態（`unstarted` / `cooking` / `done`）は保存せず、Timer の参照と `completedAt` から導く。品目に足す属性は `completedAt`（完了の事実）と `interruptedAt`（中断の事実・状態に効かない）の二つ。「未調理」は関数 `pendingOrders(items, timers, now)` で、計画と左レールが読む。snapshot は `orderItemsToBroadcast(items, timers, now)`（期限内 ∨ 生きた Timer の参照先）を運び、`TimerFact` に Timer → 品目の参照を載せる。後着は状態にかかわらず注文属性だけを更新する。Timer の語彙・構造・Boil_Sync・Alarm・一括完了は変えない。

### 先行 spec との関係

- `pos-order-ingress`：受理の入口（`arriveRecords`）は同じ。`upsertOrder` の意味が「未調理の全置換」から「注文属性の更新」に変わる（Requirement 2）。
- `pending-order-expiry`：`liveOrders` は `pendingOrders` と `orderItemsToBroadcast` の内側に畳む。期限の述語は一つのまま。
- `plan-stability`：`ChangeContext.pending` は `pendingOrders` の結果。Shown_Plan の対応は未調理の品目の間で数える（変わらない）。
- `startable-placement` / `lift-group-planning`：計画は `pendingOrders` の結果を `planTargets` → `placeableTargets` に通す（変わらない）。走行中は Timer（変わらない）。
- `sync-set-batch-complete`：一括完了は client がメンバーごとに `complete` を送る。engine の `complete` が Timer ごとに `completedAt` を書くので、一括は自然に各品目へ記録される。
- `lift-order-numbering`：この上に載る表示（番号・卓・品名・中断の色分け）。

## Architecture

```
domain/order.ts    OrderItem { …POS 属性…, arrivalTime, slotSpan, completedAt: number | null, interruptedAt: number | null }
                   itemStatusOf(item, timers)                 ← 状態の正本（cooking / done / unstarted）
                   pendingOrders(items, timers, now)           ← 期限内 ∧ unstarted（liveOrders を内側に）
                   orderItemsToBroadcast(items, timers, now)   ← 期限内 ∨ 生きた Timer の参照先
                   orderItemOf(timer, items)                   ← Timer → 品目（null＝注文なし）
engine/state.ts    TimerState.orderItems（旧 pendingOrders）    永続 v13
engine/start.ts    消費しない。照合は pendingOrders。cooking への開始は OrderItemCooking
engine/complete.ts Timer を除去 ＋ 参照先に completedAt = now
engine/cancel.ts   Timer を除去 ＋ 参照先に interruptedAt = now
engine/pending.ts  upsertOrder：注文属性だけ更新・厨房の事実と生きた Timer を保持・arrivalTime 引継ぎ
engine/settle.ts   snapshot.orderItems = orderItemsToBroadcast(…)・RequestPlan.pending = pendingOrders(…) → planTargets
engine/project.ts  toWireTimer：orderItem { externalOrderId, itemIndex } | null を写す
domain/wire.ts     snapshot.orderItems / TimerFact.orderItem の decode
client             ClientView.orderItems（wire のまま）・左レール = pendingOrders(view.orderItems, view.timers, corrected)
                   釜のカード = orderItemOf(timer, view.orderItems)
```

原則。

1. **状態は保存しない。** `itemStatusOf` が唯一の導出で、engine と client が同じ関数を呼ぶ（`lift-group.ts` の Head と同じ規律）。
2. **参照は Timer 側だけ。** `Timer.orderItem` は生成時に書いて不変。品目 → Timer は導出（`timers.find(t => refersTo(t, item))`）。
3. **読む集合は二つで、期限判定は一つ。** 計画・左レール＝`pendingOrders`、snapshot＝`orderItemsToBroadcast`。どちらも `liveOrders` を内側に持つ。
4. **厨房の事実は後着で消えない。** `completedAt` / `interruptedAt` は `complete` / `cancel` だけが書き、`upsertOrder` は触らない。

## Data Models

```ts
// src/domain/order.ts
export interface OrderItem {
  readonly externalOrderId: string;
  readonly itemIndex: number;
  readonly noodleType: string;
  readonly firmness: Firmness;
  readonly tableId: string | null;
  readonly arrivalTime: number;
  readonly slotSpan: number;
  readonly itemName: string | null;
  readonly sizeName: string | null;
  /** 完了の事実（厨房が確定した時刻）。null＝未完了。complete だけが書く。 */
  readonly completedAt: number | null;
  /** 中断の事実（厨房 Cancel で未調理に戻った最後の時刻）。状態には効かない。cancel だけが書く（上書き）。 */
  readonly interruptedAt: number | null;
}
export type ItemStatus = "unstarted" | "cooking" | "done";

// src/domain/timer.ts（wire）
export interface TimerFact<…> {
  …既存…
  /** Timer → 品目の参照。null＝注文なし（アドホック・v12 由来）。itemIndex は品目の一意性のため。 */
  readonly orderItem: { readonly externalOrderId: string; readonly itemIndex: number } | null;
}

// src/engine/state.ts
export interface TimerState { …; readonly orderItems: readonly OrderItem[]; … }   // 旧 pendingOrders
// src/engine/types.ts  CURRENT_SCHEMA_VERSION = 13
```

`Timer`（engine）は変えない。`Timer.orderItem { externalOrderId, itemIndex, tableId }` はそのまま（`tableId` は開始時点の卓＝計画の錨の出所・要件判断 7）。

## Components and Interfaces

### Component 1: 状態と集合の導出（`src/domain/order.ts`）

- `itemStatusOf(item, timers)`：`timers.some(t => t.orderItem !== null && refersTo(t.orderItem, item))` → `cooking`（running / boiled を問わない。`timers` は状態の Timer 全件）；`item.completedAt !== null` → `done`；else `unstarted`。
- `pendingOrders(items, timers, now)` = `liveOrders(items, now).filter(item => itemStatusOf(item, timers) === "unstarted")`。並びは入力のまま。全件が通れば同じ参照を返す（`liveOrders` と同じ理由）。
- `orderItemsToBroadcast(items, timers, now)` = `items.filter(item => within lifetime(now) || itemStatusOf(item, timers) === "cooking")`。`liveOrders` の述語を関数として共有する（`isLive(item, now)`）。
- `orderItemOf(timer, items)`：`timer.orderItem === null` → null；`items.find(refersTo)` → 品目 or null。wire の `TimerFact` と engine の `Timer` の両方から呼べるよう、引数は `{ orderItem: { externalOrderId, itemIndex } | null }` を持つ型にする。
- `refersTo(ref, item)`：`externalOrderId` と `itemIndex` の一致。既存の `itemKeyOf` と同じ鍵。

### Component 2: engine の遷移

- **`start.ts`**：`consumeOrder` を撤去。照合は `pendingOrders(state.orderItems, state.timers, args.now)`。見つからなければ、`state.orderItems` に在って `itemStatusOf === "cooking"` なら `OrderItemCooking`、それ以外は `OrderItemNotFound`。Timer の `orderItem` は従来どおり（`tableId` は開始時点の値）。
- **`complete.ts`**：対象 Timer を除去し、`orderItemOf(timer, state.orderItems)` が在れば `completedAt: now` に更新（無ければ何もしない・移行例外）。`settle` へ。
- **`cancel.ts`**：対象 Timer を除去し、参照先が在れば `interruptedAt: now` に更新（上書き）。無ければ何もしない。
- **`pending.ts` `upsertOrder(items, timers, arrival)` / `removeOrder(items, timers, externalOrderId)`**：**Timer 集合は落とせない**（レビュー P1：`completedAt = null` の品目は Timer が在れば `cooking`、無ければ `unstarted` で、品目だけでは区別できない）。両方に `state.timers` を渡し、欠落品目の扱いを `itemStatusOf(item, timers)` で判定する。同じ鍵の品目が在れば注文属性（`noodleType` / `firmness` / `tableId` / `slotSpan` / `itemName` / `sizeName`）だけを更新し、`completedAt` / `interruptedAt` / `arrivalTime`（引継ぎ規則）を保持。無ければ `completedAt: null, interruptedAt: null` で追加。後着に無い同じ注文の品目は、`itemStatusOf === "unstarted"` なら除き、`cooking` / `done` なら残す（Requirement 2.5）。`removeOrder`（0 件・`OrderCancelled`）も同じ規則（`unstarted` だけ除く）。`isSamePending` は `orderItems` の比較に改名。
- **`settle.ts`**：`snapshotMessage` の `orderItems = orderItemsToBroadcast(state.orderItems, state.timers, now)`；`deriveRecommendations` / `requestPlan` / `ChangeContext.pending` は `pendingOrders(state.orderItems, state.timers, now)`。`planTargets(pending, now)` はその結果を受ける（`liveOrders` を二度当てても冪等）。
- **`plan.ts` / `admit.ts`**：`live = pendingOrders(...)`。
- **`digest.ts`**：`digestInput(orderItems, running, params, now)` は内部で `pendingOrders` → `planTargets`。
- **`project.ts` `toWireTimer`**：`orderItem: timer.orderItem === null ? null : { externalOrderId, itemIndex }`。
- **`migrate.ts`**：v13。`pendingOrders` → `orderItems`（各要素に `completedAt: null, interruptedAt: null`）。v13 の要素は `toOrderItem` で検証（`completedAt` / `interruptedAt` は number か null）。**注文品目が不正なら既存どおり `MigrationFailed`**（レビュー P2：個別に捨てる Shown_Plan とは失う事実の重さが違う。完了済み品目を捨てれば POS の再送で未調理として復活し得る。`migrate.ts:79` の現行の区別を維持）。`docs/persisted-schema-rollback.md` に v13 行（切戻しは `version` を 12 にし `orderItems` を `pendingOrders` に戻す。`completedAt` / `interruptedAt` は落ちる。v12 は開始済みの品目を消費する契約だったので、v13 で残していた `cooking` / `done` の品目が v12 では未着手として現れる——切戻しの注意として明記）。

### Component 3: wire（`src/domain/messages.ts` / `wire.ts` / `timer.ts`）

- snapshot：`pendingOrders` → `orderItems`（`toOrderItemFromWire`：`completedAt` / `interruptedAt` は number か null、欠如は落とす）。
- `TimerFact.orderItem`：`toTimerFact` で `null` か `{ externalOrderId: 非空 string, itemIndex: 非負整数 }` を検証。他は落とす（`verified-wire-contract` の関門）。
- Operation History（`src/operation-history/derive.ts` / `correlation.ts`）が `TimerFact` を読むなら、追加フィールドを無視できることを確認する（形の拡張だけ）。

### Component 4: client

- `ClientView.orderItems`（旧 `pendingOrders`・wire のまま）。`decideView` の snapshot 反映は名前の付け替え。
- `queueDisplay.ts`：`livePending(view, corrected)` → `pendingOrders(view.orderItems, view.timers, corrected)`（`ClientTimer` は `TimerFact` を含むので `orderItem` を持つ）。左レール・ラジアル・`suggestedItemOf` はこれを読む。
- `SlotCard` / `slotDisplay.ts`：走行中・茹で上がりのカードは `orderItemOf(display.timer, view.orderItems)` で品目を引ける（何を出すかは `lift-order-numbering`）。
- 停止ボタン：`cancelGuard` の決定に `complete` を足す——残り < `CANCEL_GUARD_THRESHOLD_MS` の 1 タップは `{ kind: "complete" }` を返し、`SlotCard` は `onComplete` を呼ぶ。それ以外は従来どおり `arm` → `cancel`。
- `orderQueueEntries` は `mode(view) !== "live"` なら空を返す（判断 18・AC 4.7）。degraded の LocalComplete / LocalCancel は Timer だけを消すので、導出した未調理に調理済みが混ざる。ラジアルの `slotSuggestions` と同じ扱いで、再接続の snapshot で復帰する。
- `persistence.ts`：`orderItems` は永続しない（従来と同じ）。**ただし Timer は永続され `toClientTimer`（`persistence.ts:136`）がリテラルで復元しているので、`Timer.orderItem` の復元経路を足す**（レビュー P2）——新しい保存データでは `orderItem` を検証して復元（`null` か `{ externalOrderId: 非空 string, itemIndex: 非負整数 }`・不正なら null に畳んで Timer は失わない）、旧 localStorage の欠如は null に畳む（Timer を失わない）。品目集合を保存しないことと、Timer の参照を復元することは別。

### Component 5: 移行例外（Requirement 6）

- 参照先の無い Timer（`orderItemOf === null`）を扱う経路はアドホックと同じ：カードは麺種だけ、`complete` / `cancel` は日時を書かない。
- 後着で参照先が補われれば以後は通常（Requirement 2.4・性質 7.9′）。

## Error Handling

- `OrderItemCooking`（新）：調理中の品目への `StartOrderItem`。状態は変えない。client は既存の拒否表示に乗せる（新しい文言は `lift-order-numbering` の design で決めるか既存の汎用文言）。
- 参照先の無い Timer の `complete` / `cancel`：エラーではない（移行例外・アドホック）。
- wire の `orderItem` が不正：snapshot 全体を落とす（既存の decode の規律。部分的に通さない）。

## Testing Strategy

- **domain**（`tests/domain/order.example` / `order.property`）：`itemStatusOf` の排他（性質 7.1・boiled は cooking）、`pendingOrders` = 期限内 ∧ unstarted、`orderItemsToBroadcast` = 期限内 ∨ 参照先（1 時間 59 分開始・2 時間 1 分の例）、`orderItemOf` の null 経路、`interruptedAt` は状態に効かない（7.3′）。
- **engine**：`start-order-item.example`（消費しない・`OrderItemCooking`・done / 期限切れは `OrderItemNotFound`）、`complete.example` / `cancel.example`（`completedAt` / `interruptedAt` の記録・参照先なしは書かない・`arrivalTime` 不変）、一括完了の各品目への記録、`pending.example` / `received-order.example`（Requirement 2：A 調理中に {A, B} 再送で A が残る・`done` は戻らない・Cancel → 再送で `interruptedAt` 保持・再開始→完了で `done`・次の Cancel でだけ上書き・後着に無い品目は unstarted だけ除く）、`settle-*`（snapshot の `orderItems`・`RequestPlan.pending`・変更費用の対応が `pendingOrders`）、`digest.example`、`migrate.example` / `migrate.property`（v12 → v13・往復・壊れた要素だけ落とす・v12 由来の参照先なし Timer が動く・完了しても `completedAt` は書かれない・再送で補われた後は書かれる）。
- **wire**（`tests/wire/*`）：`orderItems` / `TimerFact.orderItem` の往復と関門。
- **client**（`order-queue.*` / `liftGroups.*` / `slot-card.*` / `cancelGuard.*`）：左レールは `pendingOrders`、停止ボタンの `complete` / `cancel` の分岐、`orderItemOf` で卓・品名が引ける（表示は `lift-order-numbering`）。
- **横断**（`operationScenes` 拡張）：開始 → Cancel → 再開始 → 完了の系列で状態が `cooking → unstarted → cooking → done` と動き、左レールと計画が同じ集合を見る（7.6）。既存の property（schedule / commit / admit / plan-stability 5.6 実占有 / startable-placement / expiry / independence）がそのまま通る。
- **静的検査**：`timer-model.static`（鍵集合 `orderItems`・inline snapshot v13）、`offline-degradation.static`（新規 src ファイル無し）、`no-wake.static`（識別子 `context` を使わない）。

## naming ゲート（実装前にユーザー確認）

requirements の表（12 件）のとおり。加えて実装の内部名（承認済み・2026-09-07）：`ItemStatus`（型）、`isLive(item, now)`（期限の述語を関数として共有・`liveOrders` の内側）、`refersTo(ref, item)`（既存の `itemKeyOf` と同じ鍵）、`toOrderItem`（永続の検証）、`toOrderItemFromWire`（wire の検証）、`ClientView.orderItems`、`isSameOrderItems`（旧 `isSamePending`）、拒否事由 `OrderItemCooking`。

## 未決の決定（requirements の「未決」への答え）

1. snapshot の `orderItems` の大きさ：期限 2 時間の内側に限ることで足りるとして始める。実測で問題になれば `done` を送らない（client は `done` を読まない）方向で別途判断。
