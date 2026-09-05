# Design Document

## Overview

本 spec は開始推奨の見せ方を「釜ごとに次の 1 件」から「店舗全体で次に入れる群」へ改める client 側の変更である。requirements の判断 1〜19 を、次の 6 つの機構に落とす。

1. **群の導出**（`liftGroups`）— 受信した推奨の全量から、同じ卓で `serveAt` が等しいものを一群にし、最早 `startAt` 順に並べる。卓なしは 1 品 1 群。
2. **開始の事実**（`Group_Started`）— 同じ卓の**現在も走行中**の Timer のうち `endTime` が群の `serveAt` に等しいものが在るか。そのためにワイヤの `TimerFact` が `orderItem`（品目参照と卓）を運ぶ。
3. **表示できる群の連鎖**（`visibleGroups`）— 先頭の群と、それより前の群がすべて Group_Started である群。
4. **釜ごとの提案**（`slotSuggestions`）— 表示できる群の品目のうち、その釜を含み、全釜が idle で、Prep_Lead が来たもの。群の先頭だけが押せ、濃くなる。先頭でない品目は薄く見えるだけ。
5. **ラジアルの待ち行列** — 店舗全体の待ち行列を到着順に列挙し、品目として開始する。`slotSpan ≥ 2` は押した釜から許容距離の内側で最も近い空き釜を組にする。degraded では列挙しない。
6. **撤去** — `planAnchor` / `suggestionTiming`（#27）と `nextForSlot`。時刻の語（`in m:ss` / `+m:ss`）は消える。

engine と永続は、`Ordered` を `TimerFact.orderItem` に置き換える型の合成と `toWireTimer` の 1 項目を除いて変えない。計画・採点・遷移・スキーマは触らない。

### 先行 spec との関係

- `lift-group-planning`（PR #28）が前提。走行中の仲間が在る卓の未着手は、合流できる品目の `serveAt` が走行中の実効 `endTime` に一致する（ADR-0007）。本 spec の Group_Started はこの構成に依る。
- `slot-suggested-start`（#26）の「提案は idle の釜カードにだけ現れ、そこが開始の口」「品目を指して開始する」「商品名は POS 申告値」は保つ。丸ボタン・ラベル・Start の配置も保つ（AC 3.5）。
- `lapsed-suggestion-timing`（#27）は目的ごと置き換わる。`suggestionTiming` / `planAnchor` とそのテストを撤去する（AC 7.3）。
- `timer-model.md`（steering）の「駆動オーダーの保持——client 可視なら共有事実として `TimerFact` へ」を、本 spec が実行する（判断 16）。

### 設計の中心的判断（要点）

- **導出は端で一度。** `SlotBoard` が描画ごとに `now` を一度読み、群 → 表示できる群 → 釜ごとの提案を純粋関数で導く。ビューに群も先頭も保持しない（AC 1.5・5.6）。
- **判定はすべて snapshot と Corrected_Now の関数。** 端末ごとの履歴・過去の描画を読まない（AC 1.7・1.10）。途中接続した端末が同じ結果を得る。
- **「押せる」は型で表す。** 釜の提案は `head`（押せる・薄か濃）と `member`（押せない・薄）の判別共用体で、`member` にボタンを描く経路が構造から無い（AC 3.6）。
- **全釜 idle は店舗全体の Timer で判定する。** 端末は snapshot の全 Timer を持つ（担当外を含む）。engine は占有を検査しない（観測事実 12）ので、client の構造が唯一の防御である（AC 2.7）。
- **時刻の語を持たない。** 提案の語は空か `now` の 2 つで、`formatRemaining` を提案に使う経路を消す（AC 2.5・6.4）。

## Architecture

| 層 | ファイル | 変更 |
| --- | --- | --- |
| domain | `src/domain/timer.ts` | `OrderItemOrigin` を定義し、`TimerFact.orderItem: OrderItemOrigin \| null` を足す |
| domain | `src/domain/wire.ts` | `toTimerFact` が `orderItem` を復号する（`toOrderItemOrigin`） |
| domain | `src/domain/messages.ts` | `PREP_LEAD_MS = 60_000` |
| domain | `src/domain/store.ts` | `slotDistance`（と `position`・2 定数）を `objective.ts` から移す |
| engine | `src/engine/timer.ts` | `Ordered` を削除。`Timer` は `TimerFact` から `orderItem` を継承。`createTimer` の入力型を `TimerFact["orderItem"]` へ |
| engine | `src/engine/project.ts` | `toWireTimer` が `orderItem` を写す |
| engine | `src/engine/migrate.ts` / `start.ts` / `objective.ts` | 型参照の追随（`Ordered["orderItem"]` → `TimerFact["orderItem"]`）。`slotDistance` を domain から import |
| client | `src/client/connection.ts` | `ClientView` に `unitOrigins` / `slotOffsets` / `affinityToleranceDistance` を足し、config 受信で写す |
| client | `src/client/components/liftGroups.ts`（新規） | 群・開始・表示できる群・先頭・釜ごとの提案・釜の組の導出（純粋） |
| client | `src/client/components/queueDisplay.ts` | `suggestionTiming` / `SuggestionTiming` を撤去。`QueueSuggestion` に `order` と `serveAt` を足す |
| client | `src/client/components/slotDisplay.ts` | idle の `next` を `readonly SlotSuggestion[]` へ。`nextForSlot` を撤去し、`slotSuggestions` の結果を受ける |
| client | `src/client/components/SlotBoard.tsx` | `planAnchor` と時期の語を撤去。提案の見え方を `phase` から組む。ラジアルへ待ち行列と釜の組を渡す |
| client | `src/client/components/SlotCard.tsx` | 提案を複数描く。`head` だけ丸ボタン、`member` はラベルだけ。薄 / 濃の塗り |
| client | `src/client/components/RadialMenu.tsx` | 待ち行列の列を足す（到着順・選べない品目は不活性）。プリセットの花びらは残す |
| tests | `tests/client/*`、`tests/domain/wire.*`、`tests/core/*` | 後述 |
| docs | `slot-suggested-start` / `online-cook-scheduling` / `lapsed-suggestion-timing` / ADR-0003 / `timer-model.md` | Requirement 7 |

### 描画ごとのデータフロー

```
SlotBoard（now を一度読む）
  corrected = correctedNow(view.offset, now)
  queue     = orderQueueEntries(view, units, now)         # レール用（到着順・変えない）
  groups    = liftGroups(view, corrected)                  # 全量から・最早 startAt 順・started 付き
  visible   = visibleGroups(groups)                        # 連鎖
  bySlot    = slotSuggestions(visible, view, corrected)    # Map<slot, SlotSuggestion[]>・live のみ
  displays  = assignedSlotDisplays(view, units, now, bySlot)
  SlotCard ← display.next（SlotSuggestion[]）と suggestionOf(head|member) の見え方
  RadialMenu ← queue（live のみ）・pairSlots で組めるか
```

担当範囲で絞るのは `assignedSlotDisplays`（表示）だけで、群・開始・連鎖・全釜 idle は全量で判定する（AC 1.1・1.6・2.12）。

## Components and Interfaces

### Component 1: domain — `OrderItemOrigin` と `TimerFact.orderItem`

```ts
// src/domain/timer.ts
/**
 * OrderItemOrigin — Timer が由来する注文品目への参照と卓。null はアドホック麺茹で（POS を経ない開始）。
 *
 * engine の Ordered.orderItem（ADR-0003）をそのまま共有の芯へ移した形。tableId を Timer の直下ではなく
 * ここに置くのは、(orderItem = null, tableId 非 null) という「POS を経ないのに卓を知る Timer」を型として
 * 構築不能にするため（同 ADR）。client は群の開始の判定にだけ読む（lift-group-display 判断 16）。
 */
export interface OrderItemOrigin {
  readonly externalOrderId: string;
  readonly itemIndex: number;
  /** 由来する卓。null は卓を持たない品目。 */
  readonly tableId: string | null;
}

export interface TimerFact<Id = string, Slot = string, Noodle = string, Time = number> {
  // …既存 6 項目…
  readonly orderItem: OrderItemOrigin | null;
}
```

`OrderItemOrigin` の項目は生プリミティブで、ブランド型の表現差を持たないため型パラメータを足さない。

```ts
// src/domain/wire.ts
function toOrderItemOrigin(value: unknown): OrderItemOrigin | null | undefined
//   undefined / null → null（欠如は null に畳む・engine の reviveOrderItem と同じ）
//   record で externalOrderId 非空文字列・itemIndex 非負整数・tableId が null か非空文字列 → 値
//   それ以外 → undefined（復号失敗。toTimerFact は null を返す）
```

「欠如を null に畳む」のは、旧サーバの snapshot を新 client が読む過渡のためではない（同じ Worker が配るので起きない）。engine の revive と同じ扱いに揃えて、二つの境界で「無い」の意味を変えないためである。不正値は救済しない（AC 5.2）。

`ClientTimer = TimerFact & { origin }` はそのまま `orderItem` を得る。degraded でローカルに立てる Provisional_Timer は `orderItem: null`（アドホック）。

### Component 2: engine — `Ordered` の撤去と `toWireTimer`

`engine/timer.ts` の `Ordered` を削除し、`Timer` は `TimerFact<TimerId, SlotId, NoodleType, EpochMillis>` から `orderItem` を継承する。`createTimer` の `orderItem?: TimerFact["orderItem"]`。`Ordered` の doc（用途 (1) 開始済み品目の同定・(2) 卓の同定・modification で追随しない）は `OrderItemOrigin` の doc へ移し、engine 側には「client も読む共有事実になった（lift-group-display）」を残す。

`toWireTimer` は `orderItem: timer.orderItem` を足す。他の項目は変えない。`migrate.ts` の `reviveOrderItem` の返り型を `TimerFact["orderItem"]` にする（判定は変えない）。

**engine の挙動は一行も変わらない。** 型の置き場所が動くだけで、遷移・計画・採点・永続の検査は既存のテストがそのまま通る。

### Component 3: `liftGroups.ts` — 群・開始・連鎖・先頭・釜ごとの提案

```ts
// src/client/components/liftGroups.ts

/** 群の 1 品目。開始に要る事実（推奨・品目・茹で秒・serveAt）が揃った形。 */
export interface GroupItem {
  readonly order: PendingOrder;
  readonly suggestion: QueueSuggestion;    // slotIds / startAt / boilSeconds / serveAt
}

/** 同時に上げる群。同じ卓で serveAt が等しい品目の集合。卓なしは 1 品 1 群。 */
export interface LiftGroup {
  readonly tableId: string | null;
  readonly serveAt: number;
  /** startAt 昇順・同値は正準順序（arrivalTime, externalOrderId, itemIndex）。 */
  readonly items: NonEmptyArray<GroupItem>;
  /** 群の最初の 1 本が始まった事実（判断 16）。卓なしは常に false。 */
  readonly started: boolean;
}

/** 受信した推奨の全量から群を導く。最早 startAt 順・同値は先頭品目の正準順序。 */
export function liftGroups(view: ClientView, corrected: number): readonly LiftGroup[];

/** 表示できる群——先頭の群と、それより前がすべて started の群（判断 19）。 */
export function visibleGroups(groups: readonly LiftGroup[]): readonly LiftGroup[];

/** 群の先頭——未着手のうち startAt 最小の品目（同値は全部・判断 17）。 */
export function headOf(group: LiftGroup): readonly GroupItem[];

/** 釜の提案。押せる先頭（薄 / 濃）と、押せない仲間（薄）。 */
export type SlotSuggestion =
  | { readonly role: "head"; readonly phase: "faint" | "solid"; readonly item: GroupItem }
  | { readonly role: "member"; readonly item: GroupItem };

/** 釜ごとの提案。live でなければ空。全釜 idle と Prep_Lead をここで判定する。 */
export function slotSuggestions(
  visible: readonly LiftGroup[],
  view: ClientView,
  corrected: number,
): ReadonlyMap<number, readonly SlotSuggestion[]>;

/** 押した釜から slotSpan 個の釜を組む。許容距離の内側に足りなければ null（判断 10）。 */
export function pairSlots(
  slot: number,
  slotSpan: number,
  view: ClientView,
): NonEmptyArray<string> | null;
```

#### `liftGroups` の導出

1. 推奨の全量を品目と突き合わせ、茹で秒を引く（`boilSecondsOf` を `queueDisplay.ts` から export して共用）。引けない推奨は群に入れない（AC 1.3）。`serveAt = startAt + boilSeconds × 1000`。
2. 鍵は `tableId === null ? solo(externalOrderId, itemIndex) : (tableId, serveAt)`。同じ鍵の品目を束ね、`items` を startAt 昇順（同値は正準順序）に並べる。
3. `started`（AC 1.7）：`tableId !== null && view.timers.some(t => t.orderItem?.tableId === tableId && t.endTime === serveAt && t.endTime > corrected)`。boiled（`endTime ≤ corrected`）は数えない——茹で上がりの発火で計画は残りを新しい群に組み直すので、client が先に同じ結論に達するだけである（判断 16）。`t.endTime` はワイヤの実効値で、計画が錨に使った `adjustedEndTime` と同じ値。
4. 群を最早 `startAt`（`items[0].suggestion.startAt`）昇順、同値は先頭品目の正準順序で並べる（AC 1.4）。

**卓なしの群が続くと 1 本ずつ現れる。** 卓なしは `started` を持たず、始まれば消えて次が先頭になる。並べて始めたければラジアルが残る（判断 16）。

#### `visibleGroups`

```
visible = []
for g in groups:            # 最早順
  visible.push(g)
  if !g.started: break
```

先頭は常に表示可能。以降は直前までがすべて started の間だけ続く。

#### `slotSuggestions`

```
if mode(view) !== "live": return empty
occupied = view.timers の slotIds の和集合（running / boiled とも・担当外を含む）
for g in visible:
  heads = headOf(g)
  for item in g.items:
    if item.suggestion.slotIds のいずれかが occupied: continue          # 全釜 idle（AC 2.7）
    if corrected < item.suggestion.startAt − PREP_LEAD_MS: continue       # Prep_Lead（AC 2.1）
    role = heads.includes(item)
      ? { role: "head", phase: corrected ≥ startAt ? "solid" : "faint", item }
      : { role: "member", item }
    for slotId in item.suggestion.slotIds: bySlot[slotOf(slotId)].push(role)   # 各釜に同じ提案（AC 2.14）
各釜の配列を startAt 昇順（同値は群の順）に並べる
```

- 「idle」は「その釜を駆動する Timer が無い」で、`slotDisplay` の idle と同じ事実（`view.sync` は表示側が見る）。
- `member` に `phase` は無い。先頭でない品目は `startAt` が過ぎても濃くならない（AC 2.4）。「押せる」と「濃い」は先頭にだけ在る。
- 上限は置かない（AC 2.11）。同じ釜に 2 件以上並ぶのは、G1 の残りが放置されて G2 の Prep_Lead が来たときなど。カードの `actionRow` は折り返して Start を右下に留める（#26 の構造）。

#### `pairSlots`

```
if slotSpan === 1: return [String(slot)]
idle = 0..unitCount×6−1 のうち occupied でなく slot でもない釜
near = idle を (slotDistance(slot, s), s) 昇順に並べ、distance ≤ affinityToleranceDistance のもの
if near.length < slotSpan − 1: return null
return [String(slot), ...near.slice(0, slotSpan − 1).map(String)]
```

距離は domain の `slotDistance` と `view.unitOrigins` / `view.slotOffsets`（AC 4.7）。既定 14 は斜め隣接まで。担当ユニットを跨いでよい——距離が近ければ同じ腕の届く釜である。

### Component 4: `queueDisplay.ts` / `slotDisplay.ts`

- `QueueSuggestion` に `order: PendingOrder` と `serveAt: number` を足す。`SlotBoard` の `itemOf`（提案オブジェクトの同一性で行を引く）は不要になり消える。
- `suggestionTiming` / `SuggestionTiming` を削除。
- `SlotDisplay` idle の `next: readonly SlotSuggestion[]`（空配列は提案なし）。`assignedSlotDisplays(view, units, now, bySlot)` は `bySlot.get(slot) ?? []` を載せるだけで、`nextForSlot` は消える。degraded で空なのは `slotSuggestions` が担う（判定を一箇所に）。
- `orderQueueEntries` は変えない（レール用・AC 5.5）。`QueueEntry.suggestion` は残す——レールが「提案あり」を語らなくても、待ち行列の行と提案の対応は待ち行列の関心事である。

### Component 5: `SlotBoard.tsx` / `SlotCard.tsx`

`suggestionOf` は時期を組まない：

```ts
function suggestionOf(s: SlotSuggestion, slot, colorOf): { label; ariaLabel; tint; phase: "faint" | "solid"; pressable: boolean }
  label = [name size, firmness, table, s.role === "head" && s.phase === "solid" ? "now" : undefined]
  ariaLabel = `Suggested — ${name} · Slot ${slot} · ${s.role === "head" ? (phase === "solid" ? "now" : "soon") : "queued"}`
```

- 可視の語は空か `now`（AC 3.3・6.4）。aria-label だけが `soon` / `queued` で薄・押せないを語る（AC 3.4・3.7）。
- `SlotCard` は `display.next` を順に描く。`head` は丸ボタン＋ラベル、`member` はラベルだけ（`actionStack` の丸ボタンの位置に何も置かず、ラベルの位置を揃える）。薄は `opacity` を下げ、濃は現行の塗り。`onStartSuggested(item)` は `head` からしか呼ばれない。
- `Start` ボタンと配置は変えない（AC 3.5）。

### Component 6: `RadialMenu.tsx` — 待ち行列の列

プリセットの花びらは残す。加えて **待ち行列の列**を足す：

```ts
interface RadialMenuProps {
  // …既存…
  /** 店舗全体の待ち行列（到着順）。degraded では空を渡す（列を描かない）。 */
  readonly queue: readonly RadialQueueItem[];
  readonly onSelectItem: (item: RadialQueueItem) => void;
}
export interface RadialQueueItem {
  readonly order: PendingOrder;
  /** 押した釜から組めた釜の集合。null は組めない（選べない形で示す）。 */
  readonly slotIds: NonEmptyArray<string> | null;
}
```

- 列は花びらの弧の反対側（画面の左半分で開けば右、右半分で開けば左）に縦の帯として描き、`overflow-y: auto`。行は商品名・麺量・茹で加減・卓（レールと同じ語・時刻なし）。`slotIds === null` の行は `disabled`（aria-disabled・薄い塗り）で、押しても何も起きない（AC 4.5・4.9）。
- `SlotBoard` は `picker` が開いたとき、`queue` の各行に `pairSlots(picker.slot, order.slotSpan, view)` を付けて渡す。degraded では `queue: []`（AC 4.8）。
- 選択 → `connection.startOrderItem(slotIds, { externalOrderId, itemIndex })`（AC 4.2）。`slotSpan` 1 は押した釜だけ（AC 4.3）。
- 弧の項目数はプリセット数のまま（3〜6）で、幾何は変えない。

### Component 7: `connection.ts` — `ClientView` の 3 項目

`unitOrigins: readonly UnitOrigin[]`・`slotOffsets: SlotOffsets`・`affinityToleranceDistance: number` を足し、`EMPTY_VIEW` は `defaultUnitOrigins(DEFAULT_UNIT_COUNT)` / `DEFAULT_SLOT_OFFSETS` / `DEFAULT_AFFINITY_TOLERANCE_DISTANCE`、config 受信で写す。config case の「計画のパラメータは読まない……読み手の無い写しをビューへ置かない」の注記は、読み手ができた 3 項目に限って改める（重み・許容幅は引き続き持たない）。

### Component 8: `slotDistance` の移設

`objective.ts` の `slotDistance` / `position` / `STRAIGHT_STEP_COST` / `DIAGONAL_EXTRA_COST` を `src/domain/store.ts` へ移し、`objective.ts` は import する。算術は変えない（AC 5.7）。doc（オクタイルを選んだ理由）も一緒に移す。

## Error Handling

| 状況 | 扱い | 出所 |
| --- | --- | --- |
| 推奨の品目が待ち行列に無い・麺種がプリセットに無い | 群に入れない（提案として成立しない） | AC 1.3 |
| 推奨の `slotIds` の一部が走行中 / 茹で上がり | どの釜にも出さない。全釜が空いた時点で現れる | AC 2.7・2.8 |
| degraded | 提案もラジアルの待ち行列も空。`startOrderItem` は呼ばれない | AC 2.13・4.8・6.11 |
| 走行中の仲間が茹で上がりに転じた（同じ snapshot・Corrected_Now が進んだ） | その群は started でなくなり、後続の群は消える。発火の snapshot で残りが新しい群として届く | 判断 16・AC 6.3 の例外 |
| `slotSpan ≥ 2` で許容距離の内側に空き釜が足りない | ラジアルの行を不活性にする | AC 4.5 |
| ワイヤの `orderItem` が不正（空文字・負の index） | 復号失敗（snapshot 全体を落とす・`verified-wire-contract` の規律） | AC 5.2 |
| `TimerFact.orderItem` が欠如 | null に畳む | AC 5.2 |

## Testing Strategy

純粋関数（`liftGroups` / `visibleGroups` / `headOf` / `slotSuggestions` / `pairSlots`）は Property、見え方（`SlotCard` / `RadialMenu`）は Example（Testing Library）。ワイヤは既存の往復 Property に `orderItem` を足す。engine は既存テストが型の追随だけで通る。

### 生成器

`tests/client/generators.ts` に、**群を作る場面**を足す：卓（null / t-1 / t-2）・茹で秒（プリセットから）・`startAt` を振り、`serveAt` が揃う品目を意図的に作る。走行中 Timer は `orderItem` と `endTime` を振り、「群の `serveAt` に一致する仲間」「一致しない仲間」「boiled の仲間」を場面に混ぜる。

### 性質（Requirement 6 への対応）

| # | 性質 | 検査 |
| --- | --- | --- |
| 6.1 | 群の等号（片方向） | 同じ群の任意の 2 品目は卓が同じで `serveAt` が等しい |
| 6.2 / 1.10 | 一意 | 同じ snapshot と Corrected_Now から、担当範囲を変えても `liftGroups` / `visibleGroups` / `headOf` が同じ |
| 6.3 | 単調な出現 | 同じ snapshot で Corrected_Now を進める。走行中の `endTime` を跨がない区間では、提案は消えず薄→濃だけ。跨ぐ区間は例外（後述の 2 場面） |
| 6.4 | 時刻不在 | `suggestionOf` のラベルの末尾は空か `now` |
| 6.5 | 群の境界 | ある群より前に started でない群があれば、その群の品目は `slotSuggestions` に現れない |
| 6.6 | 担当外の空白 | Visible_Groups の全品目が担当外なら `assignedSlotDisplays` の idle の `next` はすべて空 |
| 6.7 | 距離の一致 | `objective.ts` が import する `slotDistance` は domain のもの（静的検査：`objective.ts` に `function slotDistance` が無い） |
| 6.8 | 全釜 idle | 現れた提案の `slotIds` は occupied と交わらない |
| 6.9 | 先頭の一意 | `head` の品目は群の `startAt` 最小のものだけ。Corrected_Now を全品の `startAt` より後ろに置いても変わらない |
| 6.10 | 開始の事実の一意 | `started` は `view.timers` の `orderItem.tableId` / `endTime` と群の `serveAt`、Corrected_Now だけの関数。同じ卓の後の batch は started にならない |
| 6.11 | 非 live の沈黙 | degraded では `slotSuggestions` が空、ラジアルの `queue` が空、`startOrderItem` が呼ばれない（既存の connection.example と同じ形） |

### 茹で上がりの 2 場面（requirements「design への申し送り」）

1. **同じ snapshot で 599 秒 → 600 秒を跨ぐ**：G1 の仲間の `endTime` が 600 秒。599 秒では G1.started が真で G2 の提案（Prep_Lead 到来済み）が見える。600 秒で G1.started が偽になり、G2 の提案は消え、G1 の残りが先頭として濃く残る。
2. **その後に発火の snapshot を受け取る**：G1 の残りが新しい `serveAt`（走行中の `endTime` と不一致）で届く。G2 は引き続き隠れ、G1 の残りが先頭として濃い。(1) の 600 秒時点と (2) の見え方が一致する（Example で両方を並べる）。

### Example

- レビューの再現：茹で 510 / 360 / 330 秒の同卓 3 品（開始予定 0 / 150 / 180 秒）。180 秒経っても押せるのは 510 秒の品目だけで、他 2 品は薄いラベルだけ。
- 6 釜・同卓 4 品・各 2 釜：1 本目を始めた後、残り 2 品が今（head・solid）、1 品が仲間（member）として釜 0・1 の空きを待つ。釜 0 だけが空いた状態では出ない（全釜 idle）。
- `SlotCard`：`head` に丸ボタンと aria-label `… · now` / `… · soon`、`member` にボタン無しと `… · queued`。
- `RadialMenu`：live で待ち行列の列が出る。`slotSpan` 2 で許容距離の内側に空きが無い行は不活性。degraded で列が無い。
- ワイヤ：`orderItem` 欠如 → null、不正 → 復号失敗（`wire.example`）。往復 Property に `orderItem` を足す（`wireGenerators`）。

## Correctness Properties

1. **群の等号（片方向）** — Requirement 6.1。
2. **一意** — Requirement 6.2・1.10。
3. **単調な出現（例外つき）** — Requirement 6.3。
4. **時刻不在** — Requirement 6.4。
5. **群の境界** — Requirement 6.5。
6. **担当外の空白** — Requirement 6.6。
7. **距離の一致** — Requirement 6.7（静的検査）。
8. **全釜 idle** — Requirement 6.8。
9. **先頭の一意** — Requirement 6.9。
10. **開始の事実の一意** — Requirement 6.10。
11. **非 live の沈黙** — Requirement 6.11。
12. **ワイヤの往復** — `TimerFact.orderItem` を含めて encode → decode が恒等（`verified-wire-contract` の既存 Property の拡張）。
13. **engine 不変** — `Ordered` の撤去で engine の既存テストが変更なしに通る（型の追随のみ）。

## naming ゲート（実装前にユーザー確認）

| 名 | 場所 | 概念境界 |
| --- | --- | --- |
| `OrderItemOrigin` | `src/domain/timer.ts` | Timer が由来する注文品目と卓。engine の `Ordered.orderItem` の形をそのまま共有へ |
| `TimerFact.orderItem` | ワイヤ | 同上。null はアドホック |
| `PREP_LEAD_MS` | `src/domain/messages.ts` | 麺を準備する猶予（60 秒）。提案が薄く現れる `startAt` までの時間 |
| `LiftGroup` / `GroupItem` | `liftGroups.ts` | 同時に上げる群と、その品目 |
| `liftGroups` / `visibleGroups` / `headOf` / `slotSuggestions` / `pairSlots` | `liftGroups.ts` | 群の導出・連鎖・先頭・釜ごとの提案・釜の組 |
| `SlotSuggestion`（`role: "head" \| "member"`・`phase: "faint" \| "solid"`） | `liftGroups.ts` | 押せる先頭と押せない仲間、薄と濃 |
| `RadialQueueItem` / `RadialMenu.queue` / `onSelectItem` | `RadialMenu.tsx` | ラジアルの待ち行列の行と口 |
| `ClientView.unitOrigins` / `slotOffsets` / `affinityToleranceDistance` | `connection.ts` | config から写す 3 項目（釜の組に要る） |
| `slotDistance`（移設） | `src/domain/store.ts` | 釜どうしの距離。engine と client が共有 |

撤去：`suggestionTiming` / `SuggestionTiming` / `planAnchor`（変数）/ `nextForSlot` / `itemOf`。engine の `Ordered`。
