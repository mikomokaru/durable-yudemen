# Design Document

## Overview

走行中のスロットカードの左上マーカー（麺種バッジの prefix）に、茹で上がる順の番号（Lift_Order）を出す。番号は「同じ実効 endTime かつ同じ注文」を一単位（Lift_Unit）とした密な順位で、店舗全体で振る。あわせて、走行中・茹で上がりのカードに卓と品名を出し、左レールで一度戻された（`interruptedAt` を持つ）品目を色分けする。すべて client の導出で、状態にもワイヤにも持たない（`order-lifecycle` が運ぶ `TimerFact.orderItem` と `orderItems` を読むだけ）。

### 先行 spec との関係

- `order-lifecycle`：`TimerFact.orderItem`（Timer → 品目の参照）、snapshot の `orderItems`（調理中は Complete まで配信）、`orderItemOf`、`SlotDisplay.running/boiled.orderItem`、`QueueEntry.order.interruptedAt`。本 spec はこれらを読む。
- `lift-group-display`：バッジのマーカー規律（identity は色・状態はマーカー）を保つ。連鎖・Head・全釜 idle・提案は変えない。
- `synchronized-boil-adjustment` / `sync-set-batch-complete`：実効 endTime は `TimerFact.endTime`。同じ実効 endTime の Timer は一括で上がる。
- `pending-order-list-left-rail`：レールの語と並びは変えない。色分けだけ足す。

## Architecture

```
domain/lift-order.ts   liftOrderOf(timers, now)  →  ReadonlyMap<timerId, number>     ← 番号の正本（純粋・店舗全体）
client/slotDisplay.ts  assignedSlotDisplays: running に liftOrder を載せる（担当外を含む view.timers から導く）
client/SlotCard.tsx    NoodleBadge marker "boiling" → 番号。バッジの語は displayName(orderItem) ＋ 卓。boiled/残滓は ✓ のまま
client/OrderRail.tsx   entry.order.interruptedAt !== null → 「戻」の色分け（識ity は色・状態は記号の規律に沿って記号＋淡色）
```

原則。

1. **番号は導出値。** 描画のたびに `view.timers`（担当外を含む全件）と `correctedNow` から導く。`ClientView` にもワイヤにも持たない。
2. **単位は「同じ実効 endTime かつ同じ注文」。** 注文は `TimerFact.orderItem.externalOrderId`。注文を持たない Timer（アドホック・v12 由来で参照先なし）は 1 本 1 単位。
3. **識別は色、状態と番号はマーカー。** バッジの塗り（麺色）は変えない。

## Data Models

```ts
// src/domain/lift-order.ts
/** 走行中（残り > 0）の Timer を上がり順に番号づけする。鍵は Timer の id。 */
export function liftOrderOf(
  timers: readonly { readonly id: string; readonly endTime: number; readonly startTime: number; readonly orderItem: { readonly externalOrderId: string; readonly itemIndex: number } | null }[],
  now: number,
): ReadonlyMap<string, number>;

// src/client/components/slotDisplay.ts
{ kind: "running"; …; readonly liftOrder: number }   // 1 始まり
```

## Components and Interfaces

### Component 1: `liftOrderOf`（`src/domain/lift-order.ts`）

1. 対象 = `timers.filter(t => t.endTime > now)`（走行中。boiled は対象外）。
2. 単位の鍵 = `orderItem === null ? \`\\u0000${t.id}\` : orderItem.externalOrderId` と `endTime` の組。同じ鍵の Timer は同じ単位。
3. 単位の並び = `endTime` 昇順 → 単位内の最早 `startTime` 昇順 → `externalOrderId`（符号単位順・アドホックは id）。
4. 番号 = 並びの index + 1（密）。返す Map は Timer の id → 番号（同じ単位の Timer は同じ番号。複数釜の Timer は 1 本なので自然に同じ番号）。
5. 入力の `timers` は店舗全体（担当外を含む）。engine の `Timer` も wire の `TimerFact` も満たす構造型で受ける。決定的（同じ入力から同じ Map）。

### Component 2: `slotDisplay.ts`

- `assignedSlotDisplays(view, units, now, bySlot)` の冒頭で `const order = liftOrderOf(view.timers, correctedNow(view.offset, now))` を一度導き、running の表示に `liftOrder: order.get(earliest.id)!`（走行中は必ず在る）を載せる。boiled は載せない。
- 担当範囲の絞りはこれまでどおり表示だけ。番号は店舗全体で振ってから担当分を出す。

### Component 3: `SlotCard.tsx`

- `NoodleBadge` の `marker` に `{ kind: "order"; n: number }` を足す（既存の `"boiling"` は使わなくなる。点滅ドットは番号に置き換え、番号は点滅しない）。aria-label は `Boiling {n}: {label}`。
- **バッジの語**：running / boiled で `display.orderItem` が在れば `displayName(orderItem)`（品名 (盛り)）、無ければ従来どおり `noodleType`。**卓**は `orderItem.tableId` が在れば語の末尾に ` · Table {id}`（レールの提案と同じ語・`suggestionOf` の `Table N` と揃える）。無ければ出さない。
- boiled のマーカーは `"ready"`（✓）のまま。残滓は `"last"`（✓）のまま。
- 幅：語が長くなるので既存の折返し（`[overflow-wrap:anywhere]`）に乗る。番号は 2 桁まで想定。

### Component 4: `OrderRail.tsx`（中断の色分け）

- `entry.order.interruptedAt !== null` なら行の先頭に記号「↩」を付け、名称を淡色（`text-muted`）にする。塗りは麺色のまま（識別は色）。aria-label に `（戻された）` を添える。
- 並びと語は変えない。

### Component 5: 未確定 Timer・参照先なし

- `origin === "local"` の provisional Timer も `view.timers` に在るので同じ規則で数える（best effort・確定で揃う）。
- 参照先が解決できない Timer（アドホック・v12 由来）は語が `noodleType`、卓なし、番号は 1 本 1 単位。

## Error Handling

- `liftOrderOf` は走行中の Timer すべてに番号を与える（Map に無い id は起こらない）。boiled の id は無い（読む側は running でだけ引く）。
- `orderItem` が在るが `orderItems` に無い（期限の隙間・v12 由来）→ `orderItemOf` が null → 参照先なしの扱い。

## Testing Strategy

- **`tests/domain/lift-order.example` / `lift-order.property`**：性質 3.1（順序）・3.2（同時・同注文は同番号、同時でも注文が違えば別番号）・3.2′（同じ実効 endTime の中は最早 startTime の順）・3.3（密）・3.4（店舗全体＝担当ユニットに依らない）・3.5（複数釜は同じ番号）・アドホックは 1 本 1 単位・boiled は番号を持たない・決定性。
- **`tests/client/slotDisplay.example`**：running に `liftOrder`、boiled に無い、担当外の Timer が番号を押し上げる。
- **`tests/client/slot-card.example`**：バッジのマーカーが番号・aria-label `Boiling 2: …`・品名と卓の語・参照先なしは麺種だけ・boiled は ✓ のまま・番号は点滅しない（`animate-pulse` が無い）。
- **`tests/client/order-queue.example` / `OrderRail`**：`interruptedAt` を持つ品目の行に記号と淡色、並びは不変。
- **性質 3.6（不変）**：群・先頭・提案・音・残り時間の表示は変わらない（既存の client テストがそのまま通る）。

## 改訂（2026-09-08・#39 のマージ後・ユーザー指示）

1. **番号はバッジらしい丸チップにする。** 濃色（ピルの文字色 `#15120c`）の地に、ピルの塗りと同じ `tint` を白抜きで置く（`rounded-full` ＋ `min-w-[1.5em]`＝2 桁は横に伸びて角丸のまま）。塗りの出所はバッジの `tint` ひとつのままで、番号が新しい色を持ち込むことはない。点滅しないこと・`aria-hidden` であること・aria の接頭辞（`Boiling {n}: `）は変えない。
2. **可視の語では卓の `Table` を省く。** 釜のバッジは品名と麺量で既に長く、前に番号のチップも付くため、卓は数だけにする（`品名 麺量 · 12`）。**読み上げの語（accessible name）は `Table {n}` のまま**——文脈を持たない読み上げでは裸の数が何の数か分からなくなるため、ここは可視と読み上げを分ける。`NoodleBadge` に `spoken`（既定は可視の語）を足し、釜のバッジだけが両者を分ける。
3. 卓を数だけにするのは**釜のバッジに限る**。左レールと提案の語（`suggestionOf`）は `Table {n}` のまま——狭いのはバッジであって、レールの行や提案のラベルではない。したがって「提案の語と同じ規則」は品名（`displayName`）についてのみ成り立ち、卓の書き方は釜のバッジだけ異なる。

## naming ゲート（実装前にユーザー確認）

| 候補名 | 場所 | 表明する概念境界 |
| --- | --- | --- |
| `liftOrderOf(timers, now)` | `src/domain/lift-order.ts`（新規） | 走行中 Timer の上がり順（Lift_Unit の密な順位・店舗全体・導出値） |
| `SlotDisplay.running.liftOrder` | `src/client/components/slotDisplay.ts` | 釜のカードに出す番号 |
| `BadgeMarker "order"` | `src/client/components/SlotCard.tsx` | 番号のマーカー（点滅ドットを置き換える） |

`Lift_Unit` は要件語彙のみ。新規 src ファイル `src/domain/lift-order.ts` は `offline-degradation.static` の集合に加える（domain は対象外なら不要——確認する）。

## 未決の決定（requirements の「未決」への答え）

1. 店舗全体で振る（担当内ではない）。
2. 同じ実効 endTime かつ同じ注文を同じ番号。同じ実効 endTime の中の注文の順は最早 `startTime` → `externalOrderId`。
3. 未確定（provisional）の Timer も数える。
