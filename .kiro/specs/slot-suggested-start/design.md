# 技術設計書 — 空いている釜からの提案開始（slot-suggested-start）

## この設計が拠って立つもの

要件は 3 つの嘘を消すことを求める。提案が釜を番号で名指すこと、釜の状態と無関係に押せること、client が茹で秒を言い直すこと。設計はこれを**機構の追加ではなく位置の移動**へ翻訳する。

判断の拠り所は `design-philosophy.md` の 3 点である。

- **真** — 導出値を状態に昇格させない。茹で秒・茹で加減・麺種はサーバが持つ事実であり、client が言い直さない。提案はビューに保持せず毎描画導出する。
- **善** — 機械は指示しない。提案は提案のまま、押せる場所にだけ現れる。押しても何も起きない操作を出さない（degraded）。
- **美** — 引き算。提案からの開始で送る項目は 5 → 3 へ減り、client 側の防御（釜の占有を見る条件）は構造で不要になる。

## Overview

### 動機

現状の提案ボタンは待ち行列のレールに在り、押せる場所（idle の釜カード）と離れている。

```
src/client/components/OrderRail.tsx:118-133  提案ボタン（Suggested / Slot {n} / HH:MM の 3 行積み）
src/client/components/SlotBoard.tsx:107-113  connection.start(suggestion.slotIds, order.noodleType, suggestion.boilSeconds, {…})
src/engine/start.ts:118                      firmness: DEFAULT_FIRMNESS   ← 茹で加減は届かない
```

離れていることが 3 つの嘘の根である。釜を指すには番号を書くしかなく（カードに番号は無い）、釜の状態を見ずに押せ（`SlotCard.tsx` の外に在るため）、開始に要る事実を client 側で組み立てるしかない。

### 何を変えるか（要点）

1. 提案を `SlotCard` の idle 相へ移す。`SlotDisplay` の idle に `next` を足し、`OrderRail` からボタンを撤去する。
2. `ClientMessage` に品目を指す開始の種別を 1 つ足し、`start` から optional の 2 項目を撤去する。
3. engine に品目から Timer を作る遷移を 1 つ足す。麺種・茹で加減・茹で秒は `pendingOrders` と `noodlePresets` から導く。
4. `PendingOrder` に POS 申告の商品名 2 項目を足す。永続版を 8 → 9 へ上げる。
5. 麺量 child の同定が名前を保てるよう、`toChildCodes` の戻り値を集合から写像へ変える。

差分の見込みは、client 側で `OrderRail` から約 20 行が消え `SlotCard` に約 25 行が入る。engine は新しい遷移 1 本（約 40 行）。ingress は写像化で数行。

### 変えないもの

- 推奨の導出（`recommend` / `commit` / `schedule`）。提案の中身は今と同じものを別の場所に出すだけである。
- 釜の占有検査を engine に入れない。提案からの重畳は**押す場所が idle にしかない**ことで構造的に消える（端末間の競合は残り、スコープ外に記録済み）。
- Timer / `TimerFact` / `CookRecommendation` のワイヤ表現・`StoreConfig`・config メッセージ。
- 復号器の形。新種別は `toClientMessage` に `case` を 1 つ足すだけで、cast 不在・メッセージ単位の粒度・両端の記録はそのまま効く。

## Architecture

### 触る層と触らない層

| 層 | 変更 |
| --- | --- |
| `src/domain/order.ts` | `PendingOrder` に `itemName` / `sizeName`（`string \| null`）を足す |
| `src/domain/messages.ts` | 新種別を足し、`start` から optional 2 項目を撤去。コメントも撤去 |
| `src/domain/wire.ts` | `toClientMessage` に `case` 1 つ。`toPendingOrderFromWire` に 2 項目の関門 |
| `src/engine/event.ts` | `Event` に新種別 1 つ。`Start` から `orderItem?` を撤去 |
| `src/engine/start.ts` | 新しい遷移を足し、`startTimer` をアドホック専用へ戻す。`:91-92` のコメントを書き換え |
| `src/engine/rejection.ts` | 拒否 code を 1 つ足す |
| `src/engine/decide.ts` | 分岐を 1 つ足す |
| `src/engine/migrate.ts` | v9 を足し、`revivePendingOrder` で 2 項目の欠如を `null` へ畳む |
| `src/engine/types.ts` | `CURRENT_SCHEMA_VERSION` を 9 へ |
| `src/ingress/noodle-spec.ts` | child を写像で保持し、`NoodleSpec` に `sizeName` を足す。冒頭宣言を改める |
| `src/shell/store-timer-do.ts` | 親品目の `item_name` を読む。新 Event の受け口。`orderItem` の射影を撤去 |
| `src/client/components/slotDisplay.ts` | idle に `next` を足す |
| `src/client/components/SlotCard.tsx` | idle に提案の丸ボタンを足す |
| `src/client/components/OrderRail.tsx` | 提案ボタンを撤去し、商品名を表示 |
| `src/client/components/SlotBoard.tsx` | 配線を付け替える |
| `src/client/connection.ts` | `startOrderItem` を足し、`start` の 4 番目の引数を撤去 |
| `docs/pos-records-ingress-api.md` | 例に `item_name` を加える |

`src/engine/sync.ts` / `settle.ts` は触らない（要件 7.2）。

### 提案が流れる道

```
engine: recommend → CookRecommendation[]（全品目・slot と startAt 付き）
   │
   ▼ snapshot
client: ClientView.recommendations（全量保持）
   │
   ├─ queueDisplay: orderQueueEntries → QueueEntry（事実の一覧・ボタンなし）
   │
   └─ slotDisplay: assignedSlotDisplays → idle の next（当該釜で startAt 最小の 1 件）
         │
         ▼ 押す
      connection.startOrderItem(slotIds, orderItem)
         │
         ▼ wire（3 項目だけ）
      engine: pendingOrders から品目を引き、noodleType / firmness / boilSeconds を導く
```

**client は開始に要る事実を組み立てない。** 送るのは「どの品目を、どの釜で」だけである。

## Components and Interfaces

### Component 1: `slotDisplay.ts` — idle が「次に入るもの」を 1 件持つ

`SlotDisplay` の idle 相にだけ項目を足す。

```ts
| { readonly kind: "idle"; readonly slot: number; readonly next: QueueSuggestion | null }
```

`next` は `QueueSuggestion` をそのまま載せる。新しい型を作らない——`queueDisplay.ts` が既に「開始に要る事実がすべて揃った提案」を定義しており、それがまさに必要なものである。同じ概念を二度定義しない。

**導出は既存の関数を組み合わせる。** `orderQueueEntries` が担当範囲の絞り込みと茹で秒の引き当てを済ませているため、`assignedSlotDisplays` はその結果から釜ごとに最小 `startAt` を選ぶだけでよい。

**`entries` は引数で受ける。** `SlotBoard` は既に両方を呼んでいる（`:68` `assignedSlotDisplays` / `:71` `orderQueueEntries`）ため、内側でもう一度呼べば 1 描画で二度導出することになる。引数で受ければ導出は一度で済み、`slotDisplay.ts` → `queueDisplay.ts` の import も要らない。依存が引数に見える方が読める。

```ts
assignedSlotDisplays(view, units, now, entries: readonly QueueEntry[]): readonly SlotDisplay[]
```

公開関数のシグネチャ変更ゆえ naming ゲートの対象である。

```
idle の next を導く
  entries ← orderQueueEntries(view, units, now)        … 既存
  当該 slot を含む suggestion のうち startAt 最小の 1 件
  無ければ null
```

`boilSecondsOf` の条件（品目が待ち行列に在り、麺種がプリセットに在る）は `orderQueueEntries` の内側にあり、要件 1.4 はこれで満たされる。**新しい絞り込み条件を書かない。**

**degraded では `next` を `null` にする。** 判定を `assignedSlotDisplays` の内側に置き、`SlotCard` に「degraded なら出さない」という条件を書かせない（表示の判断を 1 箇所に閉じる）。呼び出し側は既に `ClientView` を渡しており、Mode も同じビューから読める。

`QueueSuggestion` / `QueueEntry` の型だけを `queueDisplay.ts` から `import type` する（実行時依存を持たない）。定義があちらに在るのは「待ち行列から導く提案」という出自の通りである。

### Component 2: `SlotCard.tsx` — Start の左に同形の丸ボタン

既存の `actionStack`（`:59` 定義・`:301` 使用）は丸ボタンとその下のラベルを縦に積む。提案はその左に**同じ構造をもう 1 つ**置く。

```
idle カード下部
  ┌──────────────┬──────────────┐
  │ ● Suggested   │ ● Start      │   ← 丸ボタンは同形。塗りだけが違う（麺種の色）
  │ プレ塩 中盛    │ Start        │
  │ かため Table 12│              │
  │ in 01:20      │              │
  └──────────────┴──────────────┘
```

`next` が `null` のとき左は描かず、右の Start は位置を変えない（要件 2.9）。配置は既存の `actionStack` を横に並べる親を 1 枚足すだけで、Start 側の DOM を触らない。

**`aria-label` を明示する。** レールのボタン（`OrderRail.tsx:113-117`）が `aria-label` を持たないのは可視テキストがボタンの子だからで、丸ボタンはラベルが兄弟要素ゆえ名前を明示しなければ AT に何も渡らない。方針の違いではなく DOM 構造の違いである（要件 2.10）。

**ラベルは折り返す。** 行数を固定しない（判断 14）。商品名を省略記号で切れば注文を取り違える。

**直前結果のバッジと提案は同居する（requirements の未決 1 を確定）。** バッジはカード上部、提案とラジアルはカード下部（`actionStack`）であり、場所を取り合わない。ゆえに優先も排他も要らず、両方そのまま残す。直前結果は「この釜で何を茹でたか」、提案は「次に何を入れるか」で、隣り合っていて意味が衝突しない。

**丸が 2 つ並ばない幅では折り返す。** `actionSlot` は `h-[clamp(3.5rem,39cqi,7.875rem)]` の正方形（`:66-67`）で、2 つ並べれば 78cqi と gap を要する。狭いカードでは収まらない。判定を TSX の幅分岐に書かず、並べる親に `flex-wrap` を置いて折り返させる。分岐が無いので狭幅専用の経路が生まれない。

**要件 2.9（Start の位置が変わらない）が成り立つ根拠は `flex-wrap` ではなく下端固定である。** `actionStack`（`:59-62`）は `absolute right-… bottom-…` でカードの右下に固定されており、背が伸びるときは**上へ伸びる**。DOM 順を `[提案, Start]` にすれば、折り返したとき 1 行目（上）が提案、2 行目（下）が Start になり、`justify-end` があれば Start は右端に留まる。ゆえに提案の有無で Start の位置は動かない。

この根拠は親の配置に依存する。**`actionStack` の `absolute right/bottom` を相対配置や上端基準へ変えると要件 2.9 が崩れる**——実装者が配置を触るときの制約としてここに残す。

実描画テストに狭幅のケースを 1 件置いて実測する（Testing Strategy）。

### Component 3: `messages.ts` — 種別を 1 つ足し、`start` から 2 項目を撤去

```ts
| {
    readonly type: "startOrderItem";          // 名は naming ゲートで確定する
    readonly slotIds: NonEmptyArray<string>;
    readonly externalOrderId: string;
    readonly itemIndex: number;
  }
```

`start` は `slotIds` / `noodleType` / `boilSeconds` の 3 項目に戻り、アドホック麺茹で専用になる。`messages.ts:40-43` の「`slot-suggested-start` が品目参照を別種別へ移す」というコメントは役目を終えるため撤去する。

**`externalOrderId` / `itemIndex` を組にしない。** ワイヤは平坦なままとし、`NonEmptyArray` と同じ扱い——型が要求する形は関門が確立する。組の型（`Ordered["orderItem"]`）は engine 側に既に在り、ワイヤでそれを名乗る必要がない。新種別では両方が必須なので、`verified-wire-contract` が抱えた「片方だけ在る形を型が表現できる」問題そのものが消える。

### Component 4: `wire.ts` — `case` を 1 つと、`PendingOrder` の 2 項目

`toClientMessage` の `switch` に 1 行足し、`toStartMessage` から品目参照の判定を撤去する。

```
toStartOrderItemMessage(record) → StartOrderItem | null
  slotIds ← toSlotIds(record.slotIds)                    … null なら null
  if not isNonEmptyString(record.externalOrderId) → null
  if not isNonNegativeInteger(record.itemIndex) → null
  return { type, slotIds, externalOrderId, itemIndex }
```

**`PendingOrder` の 2 項目は `toTableId` と同じ関門の形で見る**（要件 6.4）。同形の述語を 3 つ書かず、名前つきの一般形へ寄せる。置き場所は `wire.ts` ではなく `predicate.ts` である（後述）。

```ts
/** 欠落・null は null、非空文字列はその値、空文字・文字列以外は Decode_Failure。 */
function toDeclaredName(value: unknown): { readonly name: string | null } | null
```

`toTableId` はこの形の最初の例であり、3 箇所目が現れた時点で一般形へ畳むのが「重複が実在してから抽象を入れる」の適用である。ただし戻り値のキー名が項目ごとに違う（`tableId` / `itemName` / `sizeName`）ため、包む形（`{ tableId: … }`）ではなく**値だけを返す判別可能な形**にする必要がある。`string | null | undefined` の 3 値では `undefined` が「拒否」を意味することになり読めない。

**採る形**：`toDeclaredName(value): { readonly name: string | null } | null`。`ok` は置かない——戻り値が `null` でないことが「関門を通った」の全てであり、常に `true` の項目は情報を持たない（導出できるものを状態にしない、の小さな適用）。キー名が項目ごとに違う問題は、スプレッドで載せず**受けてから書く**ことで消える。

```ts
const item = toDeclaredName(record.itemName);
if (item === null) return null;
// … itemName: item.name
```

`toTableId` もこの受け方へ寄せて 4 箇所目にする（現在はスプレッド `...tableId` で載せている）。スプレッドはキー名を関門の内側に閉じ込めるため、名前が違う 4 箇所では使えない。

**置き場所は `src/domain/predicate.ts` である。** `wire.ts` に置くと、shell の取り込み（Component 7）がワイヤ境界の関門から import することになり役割が混ざる。`toDeclaredName` は自分の型を持たず何も import しない検査であり、それは `predicate.ts` の入居条件そのものである（`isRecord` / `isNonEmptyString` / `isNonNegativeInteger` と同じ棚）。`wire.ts` と shell の両方が同じ葉から取れる。

### Component 5: `engine` — 品目から Timer を作る遷移

`Event` に 1 種、`Rejection.code` に 1 つ、`decide` に分岐 1 つを足す。

```
startOrderItemTimer(state, args, params) → Outcome
  item ← state.pendingOrders から (externalOrderId, itemIndex) で引く
  if item === undefined → Rejection（品目不在）           … 状態不変
  boilSeconds ← params.noodlePresets の item.noodleType × item.firmness
  if 引けない → Rejection("InvalidSlotOrNoodle")          … 状態不変
  validated ← validateStart({ slotIds, noodleType: item.noodleType, boilSeconds })
  if not ok → validated.rejection
  if state.timers.length ≥ MAX_TIMERS → Rejection("CapacityExceeded")
  timer ← createTimer({ …, firmness: item.firmness, orderItem: 組 })
  moved ← timers に追加・nextSeq 進め・consumeOrder で当該品目を除く
  return settle(moved, …)                                 … 既存
```

**`startTimer` と一つに畳まない。** 形は似ているが義務が違う。あちらは「client が主張した麺種と茹で秒を検証して使う」、こちらは「サーバが持つ事実から導く」。畳めば引数で「導くか使うか」を切り替える分岐が生まれ、どちらの義務なのか読めなくなる（`verified-wire-contract` が `toPendingOrder` を流用しなかったのと同じ判断）。

共有するのは末尾——`validateStart` / `MAX_TIMERS` の検査 / `createTimer` / `consumeOrder` / `settle` はいずれも既存のまま呼ぶ。Effect 列が既存 `start` と同一になるのはこの共有の帰結である（要件 3.8）。

**釜の占有・推奨との一致・`slotSpan` との一致を検査しない**（要件 3.7）。`start.ts:91-92` のコメントは「アドホック経路では拒否事由を増やさない」に書き換える——新しい経路が 1 つ足すため、現在の無条件の言明は偽になる（要件 7 と tasks）。

### Component 6: `noodle-spec.ts` — 集合を写像へ

ここが本 spec で最も構造に触れる箇所である。現状は child を**コード集合**へ畳んでおり、名前が到達不能である。

```ts
// 現状（:88 付近）
function toChildCodes(rawChildItems: unknown): ReadonlySet<number>
```

`findNoodleSize` / `findFirmness` は `.has()` しか呼ばないため、**戻り値を写像に変えれば両者は型注釈だけで済む**。

```ts
/** child の商品コード → POS 申告の商品名（欠落・空文字・文字列以外は null）。 */
function toChildNames(rawChildItems: unknown): ReadonlyMap<number, string | null>
```

`NoodleSpec` に `sizeName: string | null` を足し、`toNoodleSpec` は同定した `size.code` で写像を引く。

```
size ← findNoodleSize(childNames, menuItem.sizes)        … 対応表側から走査（既存の決定性を保つ）
return { noodleType, firmness, slotSpan: size.slotSpan, sizeName: childNames.get(size.code) ?? null }
```

これで要件 4.6（同定を一度だけ行い、`slotSpan` と Size_Name を同じ同定結果から取る）が満たされる。**同定の判定基準も走査の向きも変えない**——写像のキー集合は元の集合と同一であり、「位置を捨てる」「対応表側から走る」という 2 つの不変はそのまま立つ。

**同一コードが複数現れ、名前が食い違えば `null` にする。** 先勝ちも後勝ちも並び順に依るため、どちらも「位置を捨てる」の規律を破る。位置に依らない結果は一つだけである——申告が曖昧なら名前を持たない。同じ名前が重複しているだけなら保つ（食い違いではないため曖昧さが無い）。

```
写像へ入れるとき
  既存が無い          → 入れる
  既存と同じ名前      → そのまま（曖昧さなし）
  既存と違う名前      → null を入れる（以後どちらも採らない）
```

判定に用いる商品コードの集合（キー集合）はこの規則で変わらない。曖昧になるのは名前だけであり、`slotSpan` と `firmness` の同定は影響を受けない。

冒頭の「POS の語彙（商品コード・商品名）は含まない」という宣言は、商品名を返すようになる時点で偽になるため改める。ただし返すのは**申告された名前そのもの**であって、名前で意味を判定はしない——判定は引き続き商品コードだけで行う。この区別を宣言に残す。

### Component 7: 親品目の商品名（`store-timer-do.ts:238-253`）

`toNoodleSpec` は品目の解釈を担い、親の `item_name` は解釈に用いないため受け口で直接読む。

```ts
itemName: toDeclaredName(rawItem.item_name)?.name ?? null,   // 取り込みは Pass_Through
sizeName: spec.sizeName,
```

**取り込み側は畳み、ワイヤ側は落とす。** 取り込みは Pass_Through（要件 4.3）で `null` へ畳み、Record も品目も拒否しない。ワイヤは Decode_Failure（要件 6.4）。同じ 2 項目に別の関門が付くのは、義務が違うからである——外部の申告は拒否の理由にしないが、自分が送ったものの形が違えば自分の不具合である。`toDeclaredName` は前者では `?? null` で畳む側に、後者では `null` を返す側に使われる。同じ述語が両方の義務に使えるのは、判定と処置を分けているからである。

**`readDeclaredText` は用いない**（要件 4.4）。あれは Unique_Key の 4 要素専用の「読めなければ毒」の境界であり、商品名は毒ではない。

### Component 8: `OrderRail.tsx` / `SlotBoard.tsx` — ボタンの撤去と配線

`OrderRail` から提案ボタン（`:118-133`）と `onStart` prop を撤去し、各行に商品名を足す。`SlotBoard` は `OrderRail` への `onStart` の配線を消し、`SlotCard` へ提案の押下を渡す。

`connection.start` の 4 番目の引数（`connection.ts:673`）を撤去し、`startOrderItem(slotIds, orderItem)` を足す。degraded の分岐は既存 `start` と同じ立場（送らず、ローカルにも立てない）。

## Data Models

### `PendingOrder` の 2 項目

```ts
/** POS が申告した親品目の商品名。伝票の文字列そのもの。欠落・空文字・型違いは null。 */
readonly itemName: string | null;
/** POS が申告した麺量 child の商品名。slotSpan を決めた child と同じものから取る。 */
readonly sizeName: string | null;
```

正規化しない（要件 4.5）。半角カナは申告値のまま持ち、表示時に NFKC する（要件 5.5）。**保存が事実、表示が導出**である。

### 永続の版

`CURRENT_SCHEMA_VERSION` を 8 → 9。`revivePendingOrder` は 2 項目の欠如を `null` へ畳み、品目を落とさない（要件 6.2）。`orderItem` が v7 で同じ形で入った前例がある（観測事実 12）。

**版を上げる代償を記録する。** `migrate.ts:65-66` は**上限だけ**を見る（`version > CURRENT_SCHEMA_VERSION` で `UnsupportedSchemaVersion`）。ゆえに v8 のコードは v9 のデータを読めない——デプロイ後に Worker を巻き戻した瞬間、永続済みの全 DO が起動不能になる。逆に、revive が欠如を畳む以上、**版を上げなくても v8 のコードは 2 項目を無視して動き、v9 相当のデータを読める**。

それでも上げる。版は「永続の形が変わった」という事実の記録であり、読めるかどうかとは別の主張である。`orderItem` を足した v7 が同じ判断をしている。ただし巻き戻しが不能になることは運用上の事実なので、デプロイの順序（Worker を戻すなら永続も戻す）を tasks の申し送りに残す。

### 表示の導出（状態にしない）

| 表示 | 導出元 |
| --- | --- |
| 提案の有無・中身 | `recommendations` / `pendingOrders` / `noodlePresets` / `Corrected_Now` |
| 時期（`now` / `in mm:ss`） | `startAt` と `Corrected_Now` の差 |
| 表示名 | `itemName ?? noodleType` を NFKC 正規化 |

いずれもビューに持たない（要件 1.6）。

## Algorithmic Pseudocode

### 釜ごとの `next`

```
nextForSlot(entries, slot) → QueueSuggestion | null
  事後条件: 返り値が null でなければ、その slotIds は slot を含み、entries 中で当該 slot を含む
            提案のうち startAt が最小である

  候補 ← entries の suggestion のうち slotIds が slot を含むもの
  return 候補が空なら null、でなければ startAt 最小の 1 件（同値は先着＝到着順）
```

同値の `startAt` で並びが揺れないよう、`entries` の順（到着順・`orderQueueEntries` が決定的）を保った先着を採る。`reduce` で `<` を使えば先着が残る。

### 時期の導出

```
timing(startAt, correctedNow) → "now" | { remainingMs }
  return startAt ≤ correctedNow ? "now" : { remainingMs: startAt - correctedNow }
```

壁時計を作らない（要件 2.5）。`mm:ss` の整形は既存 `formatRemaining` を使う（分も 2 桁ゼロ詰め）——待ち時間と同じ形で読めることが、同じ軸の量であることを示す。

## Error Handling

| 事象 | engine | client |
| --- | --- | --- |
| 品目が `pendingOrders` に無い | 状態不変・新しい拒否 code | `view.error` の警告帯に出る |
| 麺種がプリセットに無い | 状態不変・`InvalidSlotOrNoodle` | 同上 |
| 茹で秒が域外 | 状態不変・`InvalidBoilSeconds` | 同上 |
| 上限超過 | 状態不変・`CapacityExceeded` | 同上 |
| degraded 中 | 到達しない | ボタンを出さない（要件 1.3 / 2.12） |

`InvalidBoilSeconds` はこの経路では**設定がそうなっているときだけ**起きる。client は茹で秒を送らず、engine が `noodlePresets` から引くためである。`toFirmnessSeconds` は正の整数だけを要求して上限を持たないので、プリセットが `BOIL_SECONDS_MAX`（1800）を超える秒数を持てば到達する。現場の入力を疑う筋合いではない。

**提示する（requirements の未決 2 を確定）。決定は「`connection.ts` の `error` 分岐を触らない」である。** あの分岐は `TimerNotFound` だけを黙らせており（理由は「意図は達成されている」）、それ以外の code は警告帯に出る。新しい code は意図が達成されていない——この品目を茹でるつもりが茹でられていない——ため、黙らせる側に入れない。何も足さなければ既定で正しく振る舞う。

**品目不在は「他端末が直前に開始した」で起こりうる正常な競合である。** 拒否は状態の嘘を防ぐためであり、現場の選択を否定するものではない（判断 7）。文言は「もう始まっています」の含意を持たせる（code だけを design で決め、文言は実装時にユーザー確認）。

## Correctness Properties

「提案は idle にしか現れない」は性質として書かない。`next` を持つのは `SlotDisplay` の idle 相の型だけであり、**型で真になる**——PBT で検査する内容が無い。running / boiled に何も足さないことは要件 7.5 の担当で、実描画テストが見る。

### Property 1: 提案は当該釜の最小 `startAt`

任意のビューについて、idle の `next` が `null` でないなら、その `startAt` は「当該釜を含む担当範囲内の提案」の最小値である。

### Property 2: 提案は状態に昇格しない

同一の（ビュー・担当集合・時刻）から `assignedSlotDisplays` を二度呼べば結果は深く等価である（純粋・毎描画導出）。

### Property 3: 開始で送る項目は 3 つ

`startOrderItem` のワイヤ表現は `type` / `slotIds` / `externalOrderId` / `itemIndex` のみを持ち、`noodleType` / `firmness` / `boilSeconds` を持たない（型で表明し、往復 PBT が踏む）。

### Property 4: 品目からの開始は品目の事実を写す

`pendingOrders` に在る品目を指した `startOrderItem` が受理されるとき、生成された Timer の `noodleType` と `firmness` は当該品目のそれと一致し、`endTime - startTime` は `noodlePresets` の当該 `noodleType × firmness` の秒数と一致する。

### Property 5: 待ち行列の消費は既存と同じ

`startOrderItem` の受理後、当該品目は `pendingOrders` から消え、他の品目は変わらない（`consumeOrder` の共有の帰結）。

### Property 6: degraded では提案が出ない

Mode が degraded のとき、`assignedSlotDisplays` の全要素の `next` は `null` である。

### Property 7: 往復（2 項目を含む）

`PendingOrder` の `itemName` / `sizeName` が `null` の形と非空文字列の形の双方について、snapshot の往復が深く等価である（要件 6.5）。

### Property 8: 名前は判定に用いられない

`toNoodleSpec` の返す `noodleType` / `firmness` / `slotSpan` は、child の `item_name` を任意に変えても変わらない（同定は商品コードだけで行う）。

### Property 9: 移行は品目を落とさない

版 8 以前の永続値について、`revivePendingOrder` は 2 項目を `null` として品目を保持する。

## Testing Strategy

| ファイル | 種別 | 内容 |
| --- | --- | --- |
| `tests/client/slotSuggestion.property.test.ts`（新規） | PBT | Property 1 / 2 / 6 |
| `tests/client/slotSuggestion.example.test.ts`（新規） | 例示 | 複数釜にまたがる提案・同値 `startAt` の先着・`next` 無しの Start 位置 |
| `tests/core/start-order-item.property.test.ts`（新規） | PBT | Property 4 / 5 |
| `tests/core/start-order-item.example.test.ts`（新規） | 例示 | 品目不在・麺種不在・上限超過の各拒否で状態不変 |
| `tests/domain/wire.property.test.ts`（既存へ追記） | PBT | Property 3 / 7 |
| `tests/ingress/noodle-spec.property.test.ts`（既存へ追記） | PBT | Property 8・同一コード重複（同名は保ち、食い違いは `null`） |
| `tests/core/migrate.property.test.ts`（既存へ追記） | PBT | Property 9 |
| `tests/client/order-rail.example.test.tsx`（既存を更新） | 実描画 | ボタンの不在・商品名の表示・折り返し |
| `tests/client/slot-card.example.test.tsx`（新規） | 実描画 | 提案ボタンの `aria-label`・押下で `startOrderItem`・ラジアルを開かない・**狭幅で丸が折り返すこと**（`flex-wrap` の実効）・`next` 無しで Start の位置が変わらないこと |

**生成器の更新。** `tests/domain/wireGenerators.ts` の `genPendingOrder` に 2 項目（`null` と非空文字列の双方）を足し、`genValidClientMessage` に新種別を足す（`start` は 1 形に戻る）。`tests/client/generators.ts` の `genPendingOrder` は狭いプールのまま 2 項目を足す（両者を統合しない理由は同ファイルのヘッダ）。

**種別集合を固定する検査 4 本**（観測事実 16）を 8 種・ClientMessage 5 種へ更新する。

## Security Considerations

商品名は POS 由来の外部文字列であり、**表示に用いる**。React の JSX は既定でエスケープするため、`dangerouslySetInnerHTML` を使わない限り注入は起きない。設計上その必要は無い。

NFKC 正規化は表示のみに用い、比較・検索・鍵には用いない（現状そのような用途は無く、増やさない）。正規化を鍵に持ち込むと、同じ品目が正規化の有無で二つに見える。

記録・ログへ商品名を出さない。`verified-wire-contract` の Decode_Failure の記録は Wire_Text の中身を載せない方針で、2 項目が増えてもその方針は変わらない。

## Dependencies

新しいパッケージは無い。NFKC は `String.prototype.normalize("NFKC")`（標準）を用いる。

## 公開シンボルの確認ゲート（実装前にユーザー確認）

`naming.md` により、requirements の naming ゲート表の 6 件は実装前に確認を要する。design から 2 件を追加する。

| 候補名 | 表明する概念境界 |
| --- | --- |
| `toDeclaredName` | POS 申告の名前 1 つを確立する関門。`toTableId` を含む 4 箇所の同形を畳む。`readDeclaredText`（毒の境界）とは別物であることを名で分ける |
| `sizeName`（`NoodleSpec`） | 麺量 child の申告名。`slotSpan` と同じ同定結果から取ることを型の同居で示す |
| `assignedSlotDisplays(view, units, now, entries)` | 引数が 1 つ増える。提案の導出元を呼び出し側から渡し、1 描画で一度だけ導出することを署名で示す |

`nextForSlot` / `timing` は `slotDisplay.ts` の内部に留めるため確認の対象外とする。

## 要件への申し送り

### 固定文言の言語と時期の表記（要件 2.4・判断 5）

#24 は `tests/pending-order-list-left-rail.static.test.ts:706-712`（S15）で「`OrderRail.tsx` の文字列リテラルと JSX テキストに日本語が現れない」を固定し、合意済みの調理母語（バリカタ／かため／ふつう／やわめ）だけを `FIRMNESS_LABEL` 経由で通す形にした。カードの操作ラベルも `Start` / `Cancel` / `Complete` である。

要件 2.4 は「`startAt ≤ Corrected_Now` なら『今』」と日本語の固定文言を指定しており、そのまま実装するとカードだけに日本語の固定文言が混ざる。**判断 5（requirements `:39`）も「今」「あと m:ss」で同じ改訂が要る**——2.4 だけを直すと判断と要件が食い違う。（この段の「今」「あと m:ss」は改訂前の要件文の引用である。改訂後の語は `now` / `in mm:ss`。）

design は `Table 12` / `now` / `in 01:20` へ揃えた。卓は `Table {n}`（レールの語をそのまま使う）。

**時期に `in` の接頭辞を置く。** レールの待ち時間は行の役割から意味が決まるが、カードでは決まらない——提案の下に裸の `1:20` が出ると茹で時間と読める余地がある。`in` の一語で「これから先の時間」だと分かる。裸にするか `in` を置くかは表示の判断なので、要件 2.4 の改訂に含めてほしい。

調理母語は硬さだけという合意はそのまま効く——`かため` は `FIRMNESS_LABEL` 経由で入る。

### 要件 2.1 の「左に配置」は折り返し時に「上」になる

`actionStack` の下端固定により、幅が足りないときは提案が Start の**上**へ回る（Component 2）。要件 2.1 は「既存の Start ボタンの左に」と位置を固定しているため、**「左、幅が無ければ上」へ改めてほしい**。要件 2.9（Start の位置が変わらない）はどちらの並びでも成り立つ。

### requirements の未決 2 件は確定した

requirements の「未決の判断」節に残る 2 件（直前結果との同居・拒否時の提示）は design で確定した（Component 2 と Error Handling）。**requirements 側の当該節を消すか、確定内容を書き戻してほしい**——requirements だけを読む人には未決のままに見える。

### 設計中に確定した事実

以下は要件の修正を求めるものではない。

1. **`assignedSlotDisplays` の引数が 1 つ増える。** `entries` を受ける形にすると 1 描画での二度導出と `slotDisplay → queueDisplay` の実行時依存が消える（Component 1）。公開関数のシグネチャ変更ゆえ naming ゲートへ加えた。要件 8 の数え上げ（契約の項目）には触れない。
2. **`toChildCodes` の写像化が要件 4.6 の前提である。** 現状は child をコード集合へ畳んでおり（`noodle-spec.ts:88` 付近）、名前は到達不能である。要件 4.6 は「同じ同定結果から取る」ことだけを求めており、写像化はその唯一の実現手段である。`findNoodleSize` / `findFirmness` が `.has()` しか使わないため、判定の意味は変わらない。
3. **`toDeclaredName` は要件が数えた「公開シンボル」に含まれない。** 要件 8 は追加を「ClientMessage 1 種・Event 1 種・拒否 code 1 つ・`PendingOrder` 2 項目」に限っているが、これらは契約の項目であり、境界の述語は別枠である（`verified-wire-contract` が `isRecord` らを別枠にしたのと同じ）。要件 8 の数え上げに反しない。

## 整合の申し送り（実装時に確認）

- **#24 の静的検査は 2 箇所だけ触る見込みである。** `tests/pending-order-list-left-rail.static.test.ts` を読んだ結果、影響は次に限られる。
  - `:656` の `QUEUE_ENTRY_FIELDS = ["order", "waitingMs", "suggestion"]` と `:686`「`QueueEntry` が 3 フィールドを保つ」は**そのまま通る**。`slotDisplay` が `orderQueueEntries` を再利用して `next` を導くため、レールが失うのは**ボタンだけで導出データは残る**。
  - `:512` の「レールの語（Suggested・釜・時刻）」の規則と `:708` の固定文言（`Waiting orders` / `Table` / `Suggested` / `Slot(s)`）は、語が釜カードへ移るため更新が要る。`Slot(s)` と壁時計は本 spec が消すため、レール側の期待から外す。
  - 実行して確かめる。#24 が固定した不変（レールの幅 `w-32`・縦スクロールのみ・横スクロールなし）は本 spec が変えない。
- **デプロイの順序。** 版を 9 に上げると v8 のコードは v9 のデータを読めない（`migrate.ts:65-66` は上限だけを見る）。Worker を巻き戻すなら永続も戻す必要がある。ロールバック手順として tasks に残す。
- `verified-wire-contract/requirements.md:156`（要件 5.1「7 種」）への追記を tasks に含める（同 spec と矛盾したまま残さない）。
- `docs/pos-records-ingress-api.md` の例と `pos-order-ingress` の AC 6.26（出所表）の更新は要件 4.7 / 4.8 が求めている。実装と同じ回で入れる。
- `messages.ts:40-43` のコメント撤去（tasks）。
