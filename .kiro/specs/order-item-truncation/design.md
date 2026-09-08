# Design Document

## Overview

注文品目の正本（`TimerState.orderItems`）に件数の上限を作り込む。純粋関数 `truncateOrderItems(items)` を `src/engine/pending.ts` に一つ置き、**件数を増やしうる唯一の経路（`upsertOrder`）の出口**と、**永続から値が入ってくる唯一の口（`migrate`）**の 2 箇所がそれを通す。掃除のための遷移・Alarm・起動経路・永続の鍵は作らず、shell は一行も変えない——truncate はストレージ操作ではなく配列を短くすることである（requirements 観測事実 2）。

上限は件数だけ（`ORDER_ITEM_LIMIT` = 4096）。忘れる順は `compareArrival` の古い順で、`cooking` も守らない。落ちた参照先は既に在る「参照先なし」経路（`orderItemOf` が null）へ落ちるので、新しい経路も新しい拒否事由も足さない。

### 先行 spec との関係

- `order-lifecycle`（ADR-0013）：品目が生涯を通じて残る規律はそのまま。本 spec が足すのは「**ただし無限には残らない**」という一点で、状態（unstarted / cooking / done）の導出にも `completedAt` / `interruptedAt` の意味にも触れない。
- `pending-order-expiry`（ADR-0011）：期限（`ORDER_LIFETIME_MS`）は**読む側の述語**のまま。本 spec は正本を書き換える別の機構であり、`isLive` を一切呼ばない。同 spec の未決 1「正本の整理」への答えでもある（期限ではなく件数で、別の遷移としてではなく構築点で）。
- `pos-order-ingress`：受理（`arriveRecords`）と `arrivalTime` の引継ぎ規則は変えない。上限に当たった到着も従来どおり受理され、重複排除の材料も進む。
- `yude-men-timer`：`design.md:523` の容量の見積り（「KV バックエンドで 128 KiB」）を改訂注記で訂正する。

## Architecture

```
engine/pending.ts   ORDER_ITEM_LIMIT = 4096
                    truncateOrderItems(items)          ← 上限を当てる規則はここ一つ
        │
        ├─ engine/pending.ts  upsertOrder(items, timers, arrival)
        │        └─ 組み上げた next を truncate してから同一性を判定して返す   ← 件数を増やしうる唯一の経路
        │
        └─ engine/migrate.ts  migrate(raw)
                 ├─ reviveOrderItems: 要素の形 ＋ 鍵の一意性（重複は MigrationFailed）
                 └─ snapshot.orderItems = truncateOrderItems(orderItems)      ← 永続から入る唯一の口

（触らない）shell/store-timer-do.ts  put は単一キーのまま・SQL は使わない
（触らない）complete / cancel / removeOrder / start / settle の no-op 検出 / snapshot / wire / client
```

原則は 3 つ。

1. **上限は集合の性質であって出来事ではない。** 「掃除が走ったか」という第 2 の状態を作らない。上限を当てる箇所が 2 つなのは経路が 2 つだからで、規則そのものは一つの関数に閉じる。
2. **時刻を読まない。** `truncateOrderItems` は `items` だけに依存する（`now`・Timer・設定を受けない）。これが期限（読む側の述語・`now` に依存）と保持（正本の性質・`now` に依存しない）を別の関心として分ける線である。
3. **忘れた結果は既存の経路に落ちる。** 参照先を失った Timer・集合に無い品目への開始は、いずれも v12 由来の Timer とアドホック開始が既に通っている道と同じ扱いにする。

## Data Models

**変更なし。** `OrderItem` / `TimerState` / `StoreSnapshot` / wire の形は同じで、永続の版は 13 のまま（判断 6）。変わるのは `TimerState.orderItems` の要素数の上界だけである。加わるのは定数と純粋関数の 2 つ。

```ts
// src/engine/pending.ts
/** Order_Item_Limit — 正本が持てる品目の件数の上限。 */
export const ORDER_ITEM_LIMIT = 4096;

/** Truncation — 上限を超えた分を compareArrival の古い順に落とす。並びは保ち、上限以下なら入力と同じ参照。 */
export function truncateOrderItems(items: readonly OrderItem[]): readonly OrderItem[];
```

## Components and Interfaces

### Component 1: `truncateOrderItems` / `ORDER_ITEM_LIMIT`（`src/engine/pending.ts`）

```ts
export function truncateOrderItems(items: readonly OrderItem[]): readonly OrderItem[] {
  if (items.length <= ORDER_ITEM_LIMIT) return items;          // 既定の経路。O(1) で抜ける
  const drop = new Set<ItemKey>(
    [...items].sort(compareArrival).slice(0, items.length - ORDER_ITEM_LIMIT).map(itemKeyOf),
  );
  return items.filter((item) => !drop.has(itemKeyOf(item)));   // 並びは入力のまま
}
```

- **上限以下なら入力と同じ配列を返す**（AC 1.3）。`liveOrders` / `pendingOrders` と同じ理由で、参照同値を保って空振りの差分を作らない。**そしてこれが既定の経路である**——定常状態では `upsertOrder` が毎回ここで抜けるので、通常の到着は長さの比較 1 回しか払わない。
- 超過時だけ整列する。整列は**入力の複製に対して**行い（`[...items]`）、入力を変えない（AC 1.2）。落とす対象を鍵の集合として持ち、元の並びを走査して除く——「選定にだけ全順序を使い、残る品目の相対順序は入力のまま」（判断 5）を、2 段に分けることでそのまま形にする。
- **費用。** 超過分 k は定常状態では一つの到着の品目数（数件）に留まる。`upsertOrder` の入口の `items` は既に上限以下だからである（Component 2 の帰結）。k が小さくても 4097 件の整列を払うのは、k 件の選択（部分選択）に置き換えても実測で効かない規模であり、全順序で並べたほうが「落ちる集合が入力順に依らない」ことを読み取りやすいためである。
- **鍵の一意性は事前条件**（AC 1.6）。この前提の下でのみ `compareArrival` は相異なる品目に対する全順序になり、「落ちた品目はいずれも残った品目のすべてより真に古い」（性質 6）と「入力の並びを変えても落ちる集合は同じ」（性質 7）が両立する。前提は engine 側では成立しており（`upsertOrder` は `itemKeyOf` を鍵に upsert し、一つの到着の中の重複は `arrivalsOf` の Map が畳む）、破れうるのは永続からの復元だけなので、そこに関門を置く（Component 3）。
- **置き場所。** `src/engine/pending.ts`（naming ゲート承認済み）。`compareArrival` / `itemKeyOf` は `../domain/order` から既に import 可能で、新規ファイルも新しい import 方向も要らない。domain へ置かないのは、保持規則を client と共有しないためである——client は上限を当てないし、当てる意味もない（wire に載るのは既に絞られた集合である）。

### Component 2: `upsertOrder` の出口（`src/engine/pending.ts`）

```ts
  // 末尾（現在は `return isSameOrderItems(items, next) ? items : next;`）
  const bounded = truncateOrderItems(next);
  return isSameOrderItems(items, bounded) ? items : bounded;
```

- **truncate してから同一性を判定する**（順序が逆ではない）。「新しく来た品目が全体の中で最も古く、そのまま落ちる」場合、`next` は `items` と違うが `bounded` は `items` と内容が一致する。先に判定すれば新しい配列を返して空振りの `Persist` / `Broadcast` を呼ぶ。後に判定すれば元の参照へ畳める。
- 上限以下の通常の到着では `truncateOrderItems` が `next` をそのまま返すので、**戻り値も参照同値の判定も従来と完全に同じ**である（AC 2.1）。
- `removeOrder` は縮めるだけなので通さない。`arrivalsOf` / `withOrderAttributes` / `earliestArrival` / `lastIndexOfOrder` / `isSameOrderItems` はいずれも変えない。

### Component 3: `migrate`（`src/engine/migrate.ts`）

2 つを足す。どちらも `reviveOrderItems` の既存の規律（「一件でも形を満たさなければ全体を移行失敗」・部分受理しない）の延長に置く。

1. **鍵の一意性の検査**（AC 4.5）は `reviveOrderItems` の中。要素をすべて写した後に `itemKeyOf` の集合の大きさを比べ、重複が在れば `null`（＝ `MigrationFailed`）。**個別に捨てない**——重複した品目を落とせば「完了済みの品目が POS の再送で未調理として復活する」既知の害（order-lifecycle レビュー P2）に触れる。engine が作らない値なので実在しないはずであり、これは壊れた永続値を弾く関門である。
2. **上限を当てる**（AC 2.2 / 4.2）のは `migrate` が `snapshot` を組む場所で、`orderItems: truncateOrderItems(orderItems)`。検証（`reviveOrderItems`）と上限（`truncateOrderItems`）を同じ関数に混ぜないのは、前者が「解釈できるか」、後者が「どれだけ保つか」という別の問いだからである。**件数の超過それ自体は移行失敗にしない**——超過は移行が直せる欠陥である（AC 4.2）。
3. `migrate.ts` → `pending.ts` の import を足す。`pending.ts` の import は `../domain/order` / `../domain/timer` / `./timer` だけなので循環しない。

**hydration は縮めた集合を確定しない**（判断 8・AC 4.3）。`ensureLoaded` は `migrate` → `fromSnapshot` で Working_Copy を組むだけで、続く `Reconcile` は縮んだ Working_Copy 同士を比べるので `orderItems` の差分は立たない。永続が縮むのは次に `Persist` が立つ任意の確定変化のときであり、`Persist` は到着に限らずあらゆる確定変化で立つので稼働中の店では分単位で解消する。静かな店では残るが、そこでは伸びてもいない。

### Component 4: 触らないもの

明示的に変えない。読み手が「ここも直すのでは」と問い直さないために列挙する。

- **shell（`store-timer-do.ts`）**（AC 2.6）。永続は単一キーへの `put` 一回のまま、`ctx.storage.sql` は使わない。品目の削除文・品目ごとの鍵・部分更新のいずれも導入しない。
- **`complete` / `cancel` / `removeOrder` / `start`**（AC 2.3）。件数を増やさないので上限を当てる理由がない。
- **no-op 検出**（AC 4.4）。`isSameOrderItems` / `isSameConfirmedResult` は正本の比較のまま。`upsertOrder` の中で縮めば普通に差分になり、`migrate` の中で縮んだぶんは比較の両側が既に縮んだ値なので差分にならない。
- **snapshot / wire / client**（AC 4.6）。正本が縮むことは読む側から見れば品目が消えることであり、`orderItemsToBroadcast` も `orderItemOf` も既に扱える。
- **永続スキーマの版**（AC 4.1）。13 のまま。

### Component 5: 忘れることの帰結（Requirement 3・テストだけ）

新しいコードは無い。既存の経路に落ちることを性質として固定する。

- 参照先を失った Timer → `orderItemOf` が null → 釜のカードは麺種だけで表示、`complete` / `cancel` は品目に何も書かず Timer を閉じる（`complete.ts:53` の `completed === null` 分岐）。
- 忘れられた未調理の品目への `StartOrderItem` → 既存の `OrderItemNotFound`。
- 忘れられた注文の後着 → 引き継ぐ起点が無いので新しい `arrivalTime` で入り直す。**保証しない**（AC 4 の但し書き。4096 件先の後着は現実の運用に無い）。

## Error Handling

新しい拒否事由も新しい `ShellFailure` も作らない。

- `truncateOrderItems` は失敗しない（全域関数）。上限は拒否として現れず、到着は常に受理される（判断 7）。
- 追加される失敗は一つだけ——`migrate` の**鍵の重複**が既存の `MigrationFailed` になる。DO は Working_Copy を確定せず throw し、再初期化に委ねる（既存の経路・要件7.5）。
- 件数の超過は失敗ではない（AC 4.2）。

## Testing Strategy

`truncateOrderItems` は入力だけで決まる純粋関数なので、性質で覆い、境界を Example で固定する。

- **`tests/core/pending.property`**（追加）：性質 1〜7（有界・冪等・部分集合・並び保存・恒等・最も古い k 件・鍵が一意な入力での決定性）。鍵が一意な `OrderItem` 配列の生成器を `tests/core/generators.ts` に足す。
- **`tests/core/pending.example`**（追加）：ちょうど上限・上限 +1・大量超過・空・`arrivalTime` 同値を `externalOrderId` で断つ場面・落ちた品目が `cooking` である場面・「新しく来た品目がそのまま落ちて元の参照に畳まれる」場面（Component 2 の順序が効く回帰）。
- **`tests/core/order-item-bound.property`**（新規）：性質 8（件数の非増加・閉包性）。`upsertOrder` / `migrate` の出力は上限以下、`complete` / `cancel` / `fromSnapshot` / `toSnapshot` は同数、`removeOrder` は以下、`EMPTY_STATE` は 0 を、**変換ごとに独立して**検査する。`pending.property` と分けるのは、対象が `pending.ts` に閉じず `migrate` / `snapshot` / `complete` / `cancel` に跨るためで、「どの変換が件数をどう動かすか」の一覧をここ一箇所で読めるようにする。
- **`tests/core/migrate.example` / `migrate.property`**（追加）：上限超過の v13 が上限を当てて復元されること、鍵の重複が `MigrationFailed` になること、形の不正が従来どおり失敗すること。
- **`tests/core/continuous-input.example`（と同形の新しい harness）**：性質 9（状態の有界性）。到着・開始・完了・キャンセル・後着・外部計画の受領・hydration を任意の系列で与えて `orderItems.length ≤ ORDER_ITEM_LIMIT` を保つ。
- **永続サイズの回帰**（性質 10）：満杯の状態を組み、`TextEncoder` で測った UTF-8 バイト数を実測値として tasks に記録する。**ハード上界ではなく参考指標**として書く——実際に載るのは structured clone で符号化されたオブジェクトであって JSON 文字列ではない、2 MB は key + value の合算、文字列長は未検証、`lastSequenceByTerminal` は構造的に有界でない。fixture には**実運用規模の `lastSequenceByTerminal`（端末 8 台 × 56 桁）を含める**（未決 4 の答え）。
- **`tests/core/order-expiry-independence` と同形**：性質 11（走行中の自立）。品目を忘れても走行中 Timer の集合・実効 endTime・Alarm・`tableMembers`・Boil_Sync の結果が変わらない。

**既知の限界。** 性質 8 は「現在存在する変換」を列挙して検査する。将来 `orderItems` を返す新しい変換が増えれば、その性質は自動では守られない——字面の構築点を数える静的検査は成立しない（`complete` / `cancel` は `map` で新しい配列を作り、`fromSnapshot` / `toSnapshot` は写す）ため、ここは網羅の保証ではなく列挙である。性質 9（実走での有界性）が二重の網になる。

## naming ゲート（2026-09-08 承認済み）

| 名 | 場所 | 表明する概念境界 |
| --- | --- | --- |
| `Order_Item_Limit` / `ORDER_ITEM_LIMIT` | 要件語彙 / `src/engine/pending.ts` | 正本が持てる件数の上限（定数・4096） |
| `Truncation` / `truncateOrderItems` | 要件語彙 / `src/engine/pending.ts` | 上限を当てる純粋関数（正本を縮める唯一の規則） |
| `Forgotten_Item` | 要件語彙のみ | 上限超過で正本から落ちた品目 |

## 未決の決定（requirements の「未決」への答え）

1. **バイト予算という代替 → 採らない。** 件数のままとする。バイト予算は「直列化の実装」に性質が依存し（実際に載るのは structured clone であって JSON ではない）、決定性の検査が直列化の詳細に縛られる。件数はその点で安定していて、代償——バイト数の厳密な上界を与えないこと——は判断 4 で既に受け入れた既知の帰結である。文字列長の検証は `itemName` 等の入口の関心であり、別 spec に残す。
2. **忘れた件数の観測値 → 数えない。** 上限は設計上の定常状態であって異常ではない。`ReceiveCounts` に項目を足せば「異常として見る」入口を作ることになる。必要になるのは「上限に当たり続けている店を運用側が知りたい」ときで、そのときに足す。
3. **`yude-men-timer/design.md:523` の訂正 → 改訂注記で訂正し、加えて ADR-0014 を立てる。** 注記は事実の更新（backend は SQLite、上限は key + value 合わせて 2 MB、状態は Timer だけではない）に限る。一方「**注文品目の正本は有界であり、上限は掃除の出来事ではなく集合の構築点に作り込む**」は `order-lifecycle`（ADR-0013：品目は生涯を通じて残る）と `pending-order-expiry`（ADR-0011：期限は絞るのであって除かない）の両方に条件を付ける横断的な判断なので、ADR を立てる。
4. **`lastSequenceByTerminal` の有界性 → 前提として書き下す。** 端末集合が有限であること・`sequence_number` が 56 桁であることは外部契約への仮定であり、コードは検証していない。本 spec は `orderItems` だけを有界化し、仮定は design（本節）と性質 10 の fixture に明示する。仮定が崩れる場合の有界化は別 spec の関心である。
5. **鍵の一意性の関門 → `MigrationFailed`。** 「先勝ちで畳む」は採らない。`reviveOrderItems` の部分受理しない規律に反し、畳んだ側が `completedAt` を持っていれば完了済みの品目を静かに落とすことになる。壊れた永続値は再初期化に委ねるのが既存の扱いである。
