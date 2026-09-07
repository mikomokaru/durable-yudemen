# Design Document

## Overview

待ち行列の正本（`TimerState.pendingOrders`）は変えない。**生きている待ち行列**（Live_Orders）を domain の純粋関数一つで導き、待ち行列を読む入口のすべて（計画対象・snapshot・外部要求・変更費用の対応・開始の照合・client の左レール）が、それぞれの `now` でその関数を呼ぶ。期限は状態を書き換える出来事ではなく述語であり、Alarm も永続の版上げも要らない。走行中 Timer は開始時に値を写しているので待ち行列に依存せず、本 spec はそれを性質として固定する（requirements 判断 6）。

### 先行 spec との関係

- `pos-order-ingress`：受理（`arriveRecords` / `upsertOrder` / `removeOrder`）は一行も変えない。`arrivalTime` が上流の観測時刻である判断（AC 8.1〜8.4）に乗る。
- `online-cook-scheduling`：計画対象 `planTargets` が唯一の「何が計画対象か」の出所である規律（AC 11.2・`schedule.ts` の公開理由）を保ち、そこに `now` を通す。指紋・要求抑制の構造は変えない。
- `plan-stability`：`ChangeContext.pending` に Live_Orders を渡すだけで、期限切れは「対応の無い品目」（判断 3）として費用に倒れない。
- `lift-group-display`：client は `queueDisplay` の入口で絞る。ラジアルは左レールと同じ導出を読むので別の入口は無い。

## Architecture

```
domain/order.ts      liveOrders(pending, now)          ← 述語はここ一つ（ORDER_LIFETIME_MS と共に）
        │
        ├─ engine/schedule.ts   planTargets(pending, now)  = liveOrders → 正準順序 → 先頭 64
        │      ├─ baselineSchedule / committedSchedule / admit / digestInput / settle（要求抑制・RequestPlan.pending）
        ├─ engine/settle.ts     snapshotMessage: pendingOrders = liveOrders(state.pendingOrders, now)
        ├─ engine/settle.ts / plan.ts / admit.ts / solver   ChangeContext.pending = liveOrders(pending, now)  ← 文脈を組む入口は 4 つ、各自の now
        ├─ engine/start.ts      照合は liveOrders(state.pendingOrders, args.now).find(…)
        └─ client/components/queueDisplay.ts   livePending(view, corrected) = liveOrders(view.pendingOrders, corrected)  ← 補正は境界で 1 回
```

原則は 3 つ。

1. **述語は一つ、入口ごとに呼ぶ。** 絞った集合を状態にも `ClientView` にも持たない（時刻が進めば古くなる導出値を保持しない）。
2. **`now` は各入口が既に持つものを使う。** 遷移は `args.now` / `settle` の `now`、hydration は `toWireSnapshot` の `now`、client は `correctedNow`。新しい時計は足さない。
3. **正本と no-op 検出は触らない。** `isSamePending` は正本を比べたままにする。期限切れは遷移でも状態変化でもない。

## Data Models

変更なし。`PendingOrder` / `TimerState` / `StoreSnapshot` / wire の `snapshot` の形は同じ（永続の版は 12 のまま）。加わるのは定数と純粋関数だけ。

```ts
// src/domain/order.ts
/** Order_Lifetime — 注文の寿命（ミリ秒）。arrivalTime + ORDER_LIFETIME_MS ≤ now で期限切れ（半開区間）。 */
export const ORDER_LIFETIME_MS = 2 * 60 * 60 * 1000;

/** Live_Orders — 期限内の品目だけを、入力の並びのまま返す。now と pending だけに依存する。 */
export function liveOrders(pending: readonly PendingOrder[], now: number): readonly PendingOrder[];
```

## Components and Interfaces

### Component 1: `liveOrders`（`src/domain/order.ts`）

- `pending.filter((order) => order.arrivalTime + ORDER_LIFETIME_MS > now)`。並びを保ち、重複を作らず、入力を変えない（AC 1.1〜1.4）。
- 全件が期限内なら**入力と同じ配列を返す**（新しい配列を作らない）。`ClientView` の参照同値で再描画を抑える既存の経路（React の props 比較）を壊さないため。全件期限内が通常なので、これが既定の経路になる。
- domain に置く理由：engine と client が同じ式を呼ぶ（`lift-group.ts` の Head と同じ規律・AC 3.2）。`PendingOrder` の定義と同じファイルに置き、`compareArrival` と並べる。

### Component 2: 計画対象 `planTargets(pending, now)`（`src/engine/schedule.ts`）

- 署名を `planTargets(pending, now)` にし、`liveOrders` → 正準順序 → 先頭 `PLAN_TARGET_LIMIT` の順で組む（絞ってから切る・AC 2.1）。
- 呼び手 5 箇所に `now` を通す：`baselineSchedule` / `buildSchedule`（`schedule.ts`。`baselineSchedule` に `now: EpochMillis` を足す。`changeContext.now` と同じ値だが、`changeContext` が null の経路でも要るので引数にする）、`committedSchedule`（`commit.ts`・既に `now` を受ける）、`admit`（`admit.ts`・既に `now` を受ける）、`digestInput(pending, running, params, now)`（`digest.ts`・引数を足す）、`settle` の要求抑制（`settle.ts:111`・既に `now` を持つ）。
- `isStale(slice, targets)` は変えない。受領時の `targets` が受領時刻の Live_Orders から組まれるので、期限切れの品目を指す一片は「計画対象と一致しない」で落ちる（AC 2.3）。
- `livePrefix`（接頭辞の合成）は `targets` を受けるままで変えない。

> **改訂（`plan-stability` Requirement 7・`startable-placement`・ADR-0012・2026-09-07）:** 計画対象の絞りは **期限 → 64 件 → 置けるか** の順で二段になった——`planTargets(pending, now)`（Live_Orders → 正準順序 → 先頭 64 件・正本の計画対象）と、その出力を「茹で時間が引ける（プリセットに在る麺種）∧ `slotSpan ≤ arms + HELPER_ARMS`」で絞った **`placeableTargets(pending, now, presets, params)`**（置ける品目）。除外した分の繰り上げはしない（65 件目は入らない——絞ってから切れば、プリセットの差し替えが計画対象の範囲を動かし、指紋と要求が指す範囲と食い違う）。`isStale` に渡す対象集合（合成 `livePrefix`・尾部の残り・ゲート `prune`・復元 `retain`・自前解の一片の品目集合）は `placeableTargets`、**指紋（`digestInput`）と要求（`RequestPlan.pending`）は `planTargets` のまま**——「何が計画対象か」と「そのうち何が置けるか」は別の問いで、本 spec の判断 5（要求と指紋の範囲は正本の計画対象）は変わらない。期限切れの扱い（Live_Orders が入口）も変わらない。`baselineSchedule` は `now` の隣に `occupied`（`occupiedSlotsOf(running)`）を受ける。

### Component 3: snapshot と要求と対応（`src/engine/settle.ts` / `plan.ts`）

- `snapshotMessage(state, recommendations, now)`：`pendingOrders: liveOrders(state.pendingOrders, now)`（AC 2.2）。確定結果の Broadcast と hydration（`toWireSnapshot`）は同じ関数を通るので、両方が同時に絞られる。
- `requestPlan`：`pending: targets` のまま（`targets` が絞られている・AC 2.3）。
- **変更費用の文脈を組む入口は 4 つ**で、それぞれが自分の `now` で絞る（AC 2.4・レビュー指摘）：`settle.deriveRecommendations`（確定と hydration）、`plan.receivePlan`（受領）、`admit`（正本の `pending` から `scoreContext.change` を作り直す——`admit` の冒頭で `liveOrders(pending, now)` を取り、文脈・採点・`planTargets` の全部にそれを使う）、`src/solver`（要求の `request.pending` を自分の時計の `now` で絞って `changeContext.pending` と `baselineSchedule` に渡す）。`changeCost` の対応は `pending` に在る品目だけを見るので、期限切れは対応から外れる。
- **混在の検証（レビュー実走）**：期限切れの旧先頭 A と生きている次品目 B が在る状態で、B を 1 秒遅らせる計画の変更費用は、正しい文脈（A を除いた `pending`）では先頭の変更 2L = 90 秒、期限切れの A を文脈に残すと 0 秒になる。4 入口それぞれでこの場面を例示として固定する（`settle` / `plan` / `admit` / `solver`）。
- `digest`・`isSamePending`・`isSameConfirmedResult`：`digestInput` に `now` を足す以外は変えない（AC 2.6〜2.7）。要求は既存の抑制（`mayRequestPlan && digest !== requestedDigest && targets.length > 0`）でだけ出る。

### Component 4: 開始の照合（`src/engine/start.ts`）

- `state.pendingOrders.find(…)` を `liveOrders(state.pendingOrders, args.now).find(…)` に替える。期限切れの品目は「待ち行列に無い」ので既存の `OrderItemNotFound` で拒否される（AC 2.5）。消費（`consumeOrder`）は正本に対して行う（正本から消す。絞った集合から消しても正本は変わらない）。
- アドホック開始（`StartTimer`）は待ち行列を読まないので変えない。

### Component 5: client の入口（`src/client/components/queueDisplay.ts`）

- **時刻の契約を固定する（レビュー指摘：二重補正）。** 部品の境界（`SlotBoard` などの component と `orderQueueEntries`）だけがローカル時刻 `now` を受けて `correctedNow(view.offset, now)` を **1 回** 計算し、その下の関数（`queueDisplay.ts` / `liftGroups.ts` の全部）は **補正済みの `corrected`** を受ける。既存の `liftGroups(view, corrected)` / `slotSuggestions(…, corrected)` は既にこの契約なので、`queueDisplay.ts` 側をそれに揃える。引数名は `corrected`（補正済み）と `now`（ローカル）を混ぜない。
- `livePending(view, corrected)`：`liveOrders(view.pendingOrders, corrected)` を返す局所関数を一つ置く。内部で補正しない。
- `orderQueueEntries(view, units, now)` は境界なので `corrected` を 1 回計算し、`livePending(view, corrected)` を並べ、`suggestedItemOf(view, recommendation, corrected)` を呼ぶ（AC 3.1）。`suggestedItemOf` は `corrected` を受け、`pendingItemOf(livePending(view, corrected), recommendation)` で引く（AC 3.3）。`liftGroups(view, corrected)` は既に持つ `corrected` をそのまま `suggestedItemOf` へ渡す。**一致テスト**：非ゼロの `offset` で、左レール（`orderQueueEntries`）と釜の提案（`liftGroups` → `slotSuggestions`）が同じ品目集合を生きているとみなす（寿命の境界の 1 ms 前後で両方が同時に切り替わる）。
- `ClientView.pendingOrders` は wire のまま持つ（絞った値を状態にしない・原則 1）。ラジアル（`RadialMenu`）と `SlotBoard` は `orderQueueEntries` / `liftGroups` の結果を読むので、入口は増えない。
- 再描画：期限が来た瞬間に消えるには時計の tick で再計算されればよく、既存の秒 tick（`now` を props で流す）に乗る。新しいタイマーは足さない。

### Component 6: 走行中の独立（テストだけ）

構造は変えない。`tests/core` に性質 5.9 を置く——**現在の設定で同期済みの Timer** を持つ任意の状態と、**両状態で同じに成立する操作**（既存 Timer への操作＝発火・完了・調整・キャンセル・Boil_Sync、アドホック開始 `StartTimer`、Record 受理、外部計画の受領、hydration）について、待ち行列の `arrivalTime` だけを `ORDER_LIFETIME_MS` 以上過去へ動かした状態に同じ操作を与え、`timers`・実効 endTime・Alarm 効果・`tableMembers` が等しいことを見る（Timer・設定・`now`・操作は固定）。**`StartOrderItem` は含めない**（レビュー指摘：期限内では Timer が増え、期限切れでは `OrderItemNotFound` で拒否されるので、結果が等しいという主張は AC 2.5 と衝突する）。期限切れ品目の開始拒否は Component 4 の例示テスト（`now` だけ違う 2 本）で別に見る。**同期済みを前提にする理由（レビュー実走）**：外部計画の受領は生きている側で採用されて `settle` が再同期し、期限切れ側では全一片が `isStale` で棄却されて状態を返す（再同期しない）。未同期の入力（実効終了 30 秒 / 33 秒）では採用側だけが 31.5 秒 / 31.5 秒に揃い食い違う。「全棄却なら状態不変」の正しい帰結なので棄却を再同期させる修正はせず、property は同期済みに限定し、反例は `order-expiry-independence.example` に残す。

## Error Handling

- 期限切れは誤りではなく、拒否事由も観測値も足さない（requirements 未決 2 の推奨に従う）。
- `arrivalTime` が `now` より未来（上流の時計が進んでいる）なら期限内として扱う（`arrivalTime + L > now` は真）。未来の到着を弾くのは本 spec の関心ではない。
- 上流と DO の時計のずれは Order_Lifetime（2 時間）に対して無視できる前提（`pos-order-ingress` が受理時刻より上流の観測時刻を選んだ判断の延長・未決 3）。ずれが分単位でも 2 時間の幅の中で問題にならない。

## Testing Strategy

- **`tests/domain/order.example` / `order.property`**：`liveOrders` の冪等・単調・並び保持・境界（ちょうど寿命は含まない・1 ms 手前は含む）・全件期限内なら同じ参照。
- **`tests/core/schedule.example` / `schedule.property`**：`planTargets(pending, now)` が絞ってから切る（性質 5.4：期限切れが先頭に 64 件以上在っても生きている先頭 64 件）。
- **`tests/core/settle-*.example`**：確定結果の snapshot の `pendingOrders` が `liveOrders(state.pendingOrders, now)` に等しい（性質 5.5）。hydration も同じ。
- **`tests/core/plan.example` / `admit.example`**：期限切れの品目を指す外部計画の一片が `isStale` で落ち、合成の尾部が自前解で埋まる。`RequestPlan.pending` に期限切れが乗らない。
- **`tests/core/start-order-item.example`**：期限切れの品目への開始が `OrderItemNotFound`。同じ品目が期限内なら開始できる（`now` だけを変えた 2 本）。
- **`tests/core/stability.example`**：期限切れの品目は対応から外れて費用 0。
- **性質 5.6（無害）**：期限切れだけの待ち行列は空の待ち行列と同じ計画・snapshot・要求抑制。**性質 5.7（不変）**：期限切れの有無で `TimerState.pendingOrders` と永続 snapshot が変わらない。**性質 5.9（注文期限からの独立）**：Component 6。
- **`tests/client/order-queue.*` / `liftGroups.*`**：`correctedNow` で切れた品目が左レールとラジアルから消える。snapshot 直後は残り、時計が寿命を跨ぐと消える。
- **静的検査**：`timer-model.static` の鍵集合・`offline-degradation.static` の core ファイル集合は変わらない（新規ファイルは作らない）。

## naming ゲート（実装前にユーザー確認）

| 候補名 | 場所 | 表明する概念境界 |
| --- | --- | --- |
| `liveOrders` | `src/domain/order.ts` | 期限内の待ち行列（導出値・並びを保つ） |
| `ORDER_LIFETIME_MS` | `src/domain/order.ts` | 注文の寿命（ミリ秒の定数） |
| `livePending`（局所） | `src/client/components/queueDisplay.ts` | `ClientView` と `correctedNow` から引く client の入口 |

`planTargets` / `digestInput` / `suggestedItemOf` は既存名のまま `now` を足す。`Expired_Order` は要件語彙だけで、コードには現れない。

## 未決の決定（requirements の「未決」への答え）

1. **正本の整理**：(a) 残す。本 spec は永続層を触らない。Persist のサイズが実機で問題になったら、確定結果の `Persist` に相乗りして落とす (b) を別 spec で判断する。
2. **観測値**：数えない。期限切れは業務上の事実ではなく読まれないだけである。
3. **時計のずれ**：Error Handling に前提として明記した。
