# Design Document

## Overview

本 spec は開始推奨の見せ方を「釜ごとに次の 1 件」から「店舗全体で次に入れる群」へ改める client 側の変更である。requirements の判断 1〜19 を、次の 6 つの機構に落とす。

1. **群の導出**（`liftGroups`）— 受信した推奨の全量を `group` で束ね、最早 `startAt` 順に並べる。`serveAt` の再計算は表示と検証のためだけ。
2. **開始の事実**（`Group_Started`）— 群の推奨が運ぶ `anchor`（合流した走行中の錨の実効 endTime）が非 null で、かつ `anchor > Corrected_Now`。群の所属（`group`）と `anchor` は engine が確定計画から決めて `CookRecommendation` で運ぶ（判断 20・`lift-group-planning` 判断 19・ADR-0008）。client は卓・serveAt・走行中 Timer から逆算しない。
3. **表示できる群の連鎖**（`visibleGroups`）— 先頭の群と、それより前の群がすべて Group_Started である群。
4. **釜ごとの提案**（`slotSuggestions`）— 表示できる群の品目のうち、全釜 idle と Prep_Lead を通ったものを釜に載せる。濃く（`now`・押せる）出す `head` は、開始推奨時刻が来たもののうち**店舗全体で先頭 arms 本**（判断 21）。それ以外は薄い `member`（押せない・準備の合図）。`head` / `member` の判別共用体で、`member` にボタンを描く経路が型から無い。
5. **ラジアルの待ち行列** — 店舗全体の待ち行列を到着順に列挙し、品目として開始する。`slotSpan ≥ 2` は押した釜から許容距離の内側で最も近い空き釜を組にする。degraded では列挙しない。
6. **撤去** — `planAnchor` / `suggestionTiming`（#27）と `nextForSlot`。時刻の語（`in m:ss` / `+m:ss`）は消える。

engine の変更は `lift-group-planning`（`recommend` が `group` / `anchor` を導く・判断 19）に属する。本 spec は engine・永続を変えない。`TimerFact.orderItem` は一度足したが読み手が無くなり撤去した（判断 20）。

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
| domain | `src/domain/wire.ts` | `toRecommendation` が `group`（非空文字列）と `anchor`（null か number）を復号する（`lift-group-planning` AC 5.7 の受け側） |
| domain | `src/domain/messages.ts` | `PREP_LEAD_MS = 60_000` |
| domain | `src/domain/store.ts` | `slotDistance`（と `position`・2 定数）を `objective.ts` から移す |
| engine | `src/engine/objective.ts` / `schedule.ts` | `slotDistance` / `position` を domain から import する（`schedule.ts:13` の import 元と `:713` の注記「正本は objective.ts」を domain へ改める） |
| client | `src/client/connection.ts` | `ClientView` に `unitOrigins` / `slotOffsets` / `affinityToleranceDistance` を足し、config 受信で写す |
| client | `src/client/components/useAudioCues.ts` | `assignedSlotDisplays(view, units, now, [])` の第 4 引数を落とす（省略可にする） |
| client | `src/client/components/liftGroups.ts`（新規） | 群・開始・表示できる群・先頭・釜ごとの提案・釜の組の導出（純粋） |
| client | `src/client/components/queueDisplay.ts` | `suggestionTiming` / `SuggestionTiming` を撤去。`QueueSuggestion` に `serveAt` を足す（注文参照は足さない）。実装では `boilSecondsOf` を export せず、推奨 → 品目 → 茹で秒 → `serveAt` の一連を `suggestedItemOf` として一つ置き、到着順の全順序 `compareArrival` と品目の表示名 `displayName` を公開した（task 0・6 の実測・事後承認を要る） |
| client | `src/client/components/slotDisplay.ts` | idle の `next` を `readonly SlotSuggestion[]` へ。`nextForSlot` を撤去し、`slotSuggestions` の結果を受ける |
| client | `src/client/components/SlotBoard.tsx` | `planAnchor` と時期の語を撤去。提案の見え方を `phase` から組む。ラジアルへ待ち行列と釜の組を渡す |
| client | `src/client/components/SlotCard.tsx` | 提案を複数描く。`head` だけ丸ボタン、`member` はラベルだけ。薄 / 濃の塗り |
| client | `src/client/components/RadialMenu.tsx` | 待ち行列の列を足す（到着順・選べない品目は不活性）。プリセットの花びらは残す |
| tests | `tests/client/*`、`tests/domain/wire.*`、`tests/core/*` | 後述（「撤去・書き換え・型の追随」） |
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

### Component 1: ワイヤ — `CookRecommendation.group` / `anchor`（判断 20）

群の所属と合流の錨は engine が確定計画から決め、推奨 1 件ごとに運ぶ（`lift-group-planning` AC 5.7 / 5.8・`recommend`）。

```ts
// src/domain/messages.ts（lift-group-planning が足す）
readonly group: string;         // snapshot 内の群の識別子。同じ群の品目は同じ値。snapshot を跨いだ同一性は持たない
readonly anchor: number | null; // 合流した走行中の錨の実効 endTime。合流していなければ null
```

- 復号（`wire.ts` の `toRecommendation`）は `group` を非空文字列、`anchor` を null か number として要し、逸脱は復号失敗（`verified-wire-contract` の規律）。
- **`TimerFact.orderItem` は撤去した。** 当初 Group_Started の判定のために足したが、`anchor` が同じ事実を運ぶので client に読み手が無い（`timer-model.md`「god type にしない」）。engine の `Ordered`（`orderItem.tableId`・永続 v10）はそのまま engine 専用に戻る。ADR-0003 の Consequences を再改訂。
- 群の識別子は snapshot ごとに付け直される。client は群をビューに保持しないので（AC 1.5）、識別子の連続性は要らない。

### Component 2: engine（本 spec では変えない）

engine の変更は `lift-group-planning`（判断 18・19・ADR-0008）に属する——合流の窓 h_i、`joinedAnchor`、`recommend` の `group` / `anchor`。本 spec の Requirement 5.3 はそれを「別 spec のものとして同じブランチに入る」と扱う。

### Component 3: `liftGroups.ts` — 群・開始・連鎖・先頭・釜ごとの提案

```ts
// src/client/components/liftGroups.ts

/**
 * 群の 1 品目。開始に要る事実（品目・推奨・茹で秒・serveAt）が揃った形。
 * 注文への参照は `order` ただ一つ——`suggestion` は釜と時刻だけを持ち、注文を指さない（同じ注文を二箇所で
 * 指せば別の注文を指す状態が表現できてしまう）。
 */
export interface GroupItem {
  readonly order: PendingOrder;
  readonly suggestion: QueueSuggestion;    // slotIds / startAt / boilSeconds / serveAt（注文参照なし）
}

/** 同時に上げる群——`CookRecommendation.group` が等しい推奨の集合。engine が決め、client は逆算しない（判断 20）。 */
export interface LiftGroup {
  readonly group: string;
  readonly anchor: number | null;
  /** startAt 昇順・同値は正準順序（arrivalTime, externalOrderId, itemIndex）。 */
  readonly items: NonEmptyArray<GroupItem>;
  /** 群の最初の 1 本が始まった事実（判断 16）。卓なしは常に false。 */
  readonly started: boolean;
}

/** 受信した推奨の全量から群を導く。最早 startAt 順・同値は先頭品目の正準順序。 */
export function liftGroups(view: ClientView, corrected: number): readonly LiftGroup[];

/** 表示できる群——先頭の群と、それより前がすべて started の群（判断 19）。 */
export function visibleGroups(groups: readonly LiftGroup[]): readonly LiftGroup[];


/** 釜の提案。いま押せる先頭（濃）と、押せない後続（薄）。判断 21：先頭は店舗全体で先頭 arms 本。 */
export type SlotSuggestion =
  | { readonly role: "head"; readonly item: GroupItem }   // 濃・now・押せる（店舗全体で先頭 arms 本）
  | { readonly role: "member"; readonly item: GroupItem }; // 薄・押せない

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

1. 推奨の全量を品目と突き合わせ、茹で秒を引く（**実装注記**：`boilSecondsOf` は export せず、`queueDisplay.suggestedItemOf` が推奨 → 品目 → 茹で秒 → `serveAt` を一度に組む。レールと群で `serveAt` の等号を二度書かない）。引けない推奨は群に入れない（AC 1.3）。`serveAt = startAt + boilSeconds × 1000`。
2. 鍵は `recommendation.group`。同じ鍵の品目を束ね、`items` を startAt 昇順（同値は正準順序）に並べる。
3. `started`（AC 1.7）：`anchor !== null && anchor > corrected`。boiled（`anchor ≤ corrected`）は数えない——茹で上がりの発火で計画は残りを新しい群に組み直すので、client が先に同じ結論に達するだけである（判断 16）。同じ群の推奨は同じ `anchor` を運ぶ（engine の射影がそう定める）。
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
shown = []                                       # 表示できる品目（群の順, 群の中の順）
for g in visible:
  for item in g.items:
    if item.suggestion.slotIds のいずれかが occupied: continue          # 全釜 idle（AC 2.7）
    if corrected < item.suggestion.startAt − PREP_LEAD_MS: continue       # Prep_Lead（AC 2.1）
    shown.push(item)
heads = shown のうち startAt ≤ corrected のものを (startAt, shown の順) で並べた先頭 view.arms 本   # 判断 21・AC 1.9 / 2.4
for item in shown:
  role = heads に含まれる ? { role: "head", item } : { role: "member", item }
  for slotId in item.suggestion.slotIds: bySlot[slotOf(slotId)].push(role)   # 各釜に同じ提案（AC 2.14）
各釜の配列を startAt 昇順（同値は群の順）に並べる
```

- 「idle」は「その釜を駆動する Timer が無い」で、`slotDisplay` の idle と同じ事実（`view.sync` は表示側が見る）。
- `head` は常に `now`（濃・押せる）。`member` は薄く、`startAt` が過ぎても濃くならない（AC 2.3）。「押せる」と「濃い」は `head` にだけ在る。判断 5「薄くても押せる」は判断 21 で撤回——薄いものを早く始めたければラジアル。
- 上限は「濃いもの」にだけ置く（店舗全体で arms 本・AC 2.4 / 2.11）。表示する数には上限を置かない。同じ釜に 2 件以上並ぶのは、先頭の残りが放置されて後の群の Prep_Lead が来たときなど。カードの `actionRow` は折り返して Start を右下に留める（#26 の構造）。

#### `pairSlots`

```
occupied = view.timers の slotIds の和集合（running / boiled とも・担当外を含む）
if occupied has slot: return null                       # 起点の釜自身が埋まっていれば組めない（slotSpan 1 でも）
if slotSpan === 1: return [String(slot)]
idle = 0..unitCount×6−1 のうち occupied でなく slot でもない釜
near = idle を (slotDistance(slot, s), s) 昇順に並べ、distance ≤ affinityToleranceDistance のもの
if near.length < slotSpan − 1: return null
return [String(slot), ...near.slice(0, slotSpan − 1).map(String)]
```

- **起点の釜自身も現在の店舗全体の Timer で検査する。** ラジアルは idle のカードから開くが、開いたまま別端末がその釜を始めた snapshot が届きうる。engine は占有を検査しない（観測事実 12）ので、ここで落とさなければ同じ釜へ重ねて開始できる。`pairSlots` は描画ごとに `view` から導くため、snapshot が更新されれば行は自動的に不活性になる（ラジアルを閉じる機構は足さない——閉じるかどうかは表示の判断で、開始できないことは構造で保証する）。
- 距離は domain の `slotDistance` と `view.unitOrigins` / `view.slotOffsets`（AC 4.7）。既定 14 は斜め隣接まで。担当ユニットを跨いでよい——距離が近ければ同じ腕の届く釜である。
- 麺種プリセットのアドホック開始（`connection.start`）は既存経路のまま変えない（Requirement 5）。同じ重畳の余地は既存のもので、本 spec の範囲外として tasks に記録する。

### Component 4: `queueDisplay.ts` / `slotDisplay.ts`

- `QueueSuggestion` に `serveAt: number` を足す。注文参照は足さない——注文を指すのは `GroupItem.order`（釜の提案は `item.order` から鍵を取る）と `QueueEntry.order`（レール）で、提案そのものは釜と時刻だけを語る。`SlotBoard` の `itemOf`（提案オブジェクトの同一性で行を引く）は不要になり消える。
- `suggestionTiming` / `SuggestionTiming` を削除。
- `SlotDisplay` idle の `next: readonly SlotSuggestion[]`（空配列は提案なし）。`assignedSlotDisplays(view, units, now, bySlot = NO_SUGGESTIONS)` の第 4 引数は `ReadonlyMap<number, readonly SlotSuggestion[]>` で**省略可**（既定は空 Map）——`useAudioCues.ts:199` と 10 本以上のテストが `[]` を渡しており、省略可にすれば呼び出し側は引数を落とすだけで済む。静的検査 `tests/sync-set-batch-complete.static.test.ts` の正規表現（4 引数の呼び出し）は `SlotBoard` の呼び出しが満たす。idle は `bySlot.get(slot) ?? []` を載せるだけで、`nextForSlot` は消える。degraded で空なのは `slotSuggestions` が担う（判定を一箇所に）。
- `orderQueueEntries` は変えない（レール用・AC 5.5）。`QueueEntry.suggestion` は残す——レールが「提案あり」を語らなくても、待ち行列の行と提案の対応は待ち行列の関心事である。

### Component 5: `SlotBoard.tsx` / `SlotCard.tsx`

`suggestionOf` は時期を組まず、**判別を表示まで運ぶ**：

```ts
/** 提案の見え方。role の判別は SlotSuggestion から落とさない——「押せないのに濃い」を表示側でも表現不能にする。 */
type SuggestionView =
  | { readonly role: "head"; readonly phase: "faint" | "solid"; readonly label: string; readonly ariaLabel: string; readonly tint: string }
  | { readonly role: "member"; readonly label: string; readonly ariaLabel: string; readonly tint: string };

function suggestionOf(s: SlotSuggestion, slot, colorOf): SuggestionView
  label = [displayName(order), firmness, table, s.role === "head" ? "now" : undefined]
  ariaLabel = `Suggested — ${displayName(order)} · Slot ${slot} · ${s.role === "head" ? "now" : "queued"}`
```

- **実装注記（task 6・レビューで確定）**：品目の名は可視のラベルも aria-label も `queueDisplay.displayName(order)`（商品名の代替・NFKC 正規化・麺量があれば `名 麺量`）で呼ぶ。当初の記法は可視だけ `name size`・aria-label は `name` と読めたが、麺量の違う同名の品目は別の品目であり、支援技術にだけ麺量を落とす理由が無い。規則の定義はレール・釜カード・ラジアルの帯で 1 箇所（`displayName`）。`slot-board-suggestions.example` は麺量を持つ品目で aria-label の末尾までを固定する。

- 可視の語は空か `now`（AC 3.3・6.4）。aria-label だけが `queued` で押せないを語る（AC 3.4・3.7）。
- **実装注記（task 5・レビューで確定）**：`SlotCard` は `SuggestionView[]` を対で受けず、`noodleColor` と同じ形の resolver `suggestionOf: (SlotSuggestion) => SuggestionView` で受ける（並行する 2 配列は長さの食い違いを表現できる）。この形では上の判別共用体は**両立しない**——resolver が `member` に `role: "head"` を返せば「押せないのにボタン」が描け、`SuggestionView` の判別が二つ目の真実になる。ゆえに `SuggestionView` は `{ label, ariaLabel, tint }` の 1 形（判別を持たない）とし、丸ボタン・塗り・`data-phase` はすべて導出 `SlotSuggestion` の `role` / `phase` から取る。可視の `now` は aria-label の相の語（`now` / `soon` / `queued`）から導き、「可視の語と食い違わない」（AC 3.4）を構造にする。提案 1 件は `role="group"`（aria-label はここ。素の span/div は generic で aria-label が効かない）で、`head` のボタンは自分の aria-label を別に持つ。以下の「対で受け」「両方が判別共用体」はこの注記で読み替える。
- `SlotCard` は `display.next` と `SuggestionView[]` を対で受け、`role` で分岐する。`head` の分岐だけが丸ボタンを描き `onStartSuggested(item)` を呼ぶ。`member` の分岐にはボタンの JSX が無い（`actionStack` の丸ボタンの位置に何も置かず、ラベルの位置を揃える）。濃い塗りは `head` かつ `solid` の分岐にだけ現れ、`member` は常に薄い。**保証の所在**：導出（`SlotSuggestion`）と見え方（`SuggestionView`）の両方が判別共用体で、描画は `role` の分岐だけを持つ。それでも JSX の分岐は型が強制しないので、「`member` にボタンが無い」「`member` が濃くない」は `slot-card.example` が固定する（AC 3.6 は型と Example の両方で担う）。
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

- 列は花びらの弧の**反対側**に縦の帯として描く。花びらは `base === 0`（画面の左半分で開いた）なら右へ、`base === Math.PI`（右半分）なら左へ咲く（`RadialMenu.tsx:81`）ので、帯は左半分で開けば**左**、右半分で開けば**右**——配置は `base` から導く（`base === 0` → 帯の右端を `cx − radius − 花びら半径` に、`base === Math.PI` → 帯の左端を `cx + radius + 花びら半径` に）。帯の幅は中心のクランプ余白（`margin = radius + 60`）から `min(12rem, 余白)` を取り、余白が最小幅（8rem）に満たなければ帯を弧の**下**へ落とす。`overflow-y: auto`。
  - **実装注記（task 6・レビューで確定）**：余白は「画面端から弧の外縁（`radius` + 花びらの半径）までの実際の距離」と読む（`margin` と読めば `cx = margin` のとき帯が画面外に出る）。逃がす先は「弧の下」に固定せず、**弧の上下の余白を比べて広い側**に置く——中心は `margin` で画面内へクランプされるだけなので、下段の釜から開けば弧の下に残るのは `margin − radius − 花びらの半径 ≈ 14px` で帯が描けない。上下の余白の和は一定（画面の高さ − 弧の直径）ゆえ広い側は常にその半分以上を持ち、弧の広がりは最大 1.5π で上下とも空くため花びらと重ならない。帯は弧の側の縁を弧の外縁に揃える（下なら `top`・上なら `bottom`）。`radial-queue.example` が四隅と左右の中段から開いた帯の矩形（style から読み戻す）を画面内・8rem 以上・弧と重ならないで固定する。行は商品名・麺量・茹で加減・卓（レールと同じ語・時刻なし）。`slotIds === null` の行は `disabled`（aria-disabled・薄い塗り）で、押しても何も起きない（AC 4.5・4.9）。
- `SlotBoard` は `picker` が開いたとき、`queue` の各行に `pairSlots(picker.slot, order.slotSpan, view)` を付けて渡す。degraded では `queue: []`（AC 4.8）。
- 選択 → `connection.startOrderItem(slotIds, { externalOrderId, itemIndex })`（AC 4.2）。`slotSpan` 1 は押した釜だけ（AC 4.3）。
- 弧の項目数はプリセット数のまま（3〜6）で、幾何は変えない。

### Component 7: `connection.ts` — `ClientView` の 4 項目

`unitOrigins: readonly UnitOrigin[]`・`slotOffsets: SlotOffsets`・`affinityToleranceDistance: number`・`arms: number`（判断 21）を足し、`EMPTY_VIEW` は `defaultUnitOrigins(DEFAULT_UNIT_COUNT)` / `DEFAULT_SLOT_OFFSETS` / `DEFAULT_AFFINITY_TOLERANCE_DISTANCE`、config 受信で写す。config case の「計画のパラメータは読まない……読み手の無い写しをビューへ置かない」の注記は、読み手ができた 3 項目に限って改める（重み・許容幅は引き続き持たない）。

### Component 8: `slotDistance` の移設

`objective.ts` の `slotDistance` / `position` / `STRAIGHT_STEP_COST` / `DIAGONAL_EXTRA_COST` を `src/domain/store.ts` へ移す。domain は `slotDistance` と `position` を export し（2 定数は非公開のまま）、`objective.ts` は `affinityExcess` のために `slotDistance` を、`representativeSlot`（`:243-246`）のために `position` を `../domain/store` から import する。`schedule.ts:13` の import 元も domain へ変え、`:713` の注記「尺度の正本は objective.ts」を domain に改める。**objective から再 export しない**——残せば「距離の正本は domain」（6.7）が objective 経由の第二の入口で濁る。`tests/core/objective.{property,example}.test.ts` の `slotDistance` の import 先を `src/domain/store` に変える。算術は変えない（AC 5.7）。doc（オクタイルを選んだ理由）も一緒に移す。

## Error Handling

| 状況 | 扱い | 出所 |
| --- | --- | --- |
| 推奨の品目が待ち行列に無い・麺種がプリセットに無い | 群に入れない（提案として成立しない） | AC 1.3 |
| 推奨の `slotIds` の一部が走行中 / 茹で上がり | どの釜にも出さない。全釜が空いた時点で現れる | AC 2.7・2.8 |
| degraded | 提案もラジアルの待ち行列も空。`startOrderItem` は呼ばれない | AC 2.13・4.8・6.11 |
| 走行中の仲間が茹で上がりに転じた（同じ snapshot・Corrected_Now が進んだ） | その群は started でなくなり、後続の群は消える。発火の snapshot で残りが新しい群として届く。再計画は boiled の釜を空きとして選びうるため、Complete までは残りの提案が出ないことがある | 判断 16・AC 6.3 の例外 |
| `slotSpan ≥ 2` で許容距離の内側に空き釜が足りない | ラジアルの行を不活性にする | AC 4.5 |
| ラジアルを開いた釜自身が、開いた後の snapshot で埋まった | `pairSlots` が null を返し、全行が不活性になる（`slotSpan` 1 でも） | AC 4.9・観測事実 12 |
| ワイヤの `group` が空・`anchor` が数でも null でもない | 復号失敗（snapshot 全体を落とす・`verified-wire-contract` の規律） | AC 5.2 |

## Testing Strategy

純粋関数（`liftGroups` / `visibleGroups` / `headOf` / `slotSuggestions` / `pairSlots`）は Property、見え方（`SlotCard` / `RadialMenu`）は Example（Testing Library）。ワイヤは既存の往復 Property に `orderItem` を足す。

### 撤去・書き換え・型の追随

- **撤去**：`tests/client/suggestionTiming.property.test.ts`・`lapsedSuggestion.example.test.tsx`（#27）。`slotSuggestion.example.test.ts`（`itemOf` の参照一致・`nextForSlot` の `startAt` 最小）と `slotSuggestion.property.test.ts` は `liftGroups.ts` の性質（6.5 / 6.8 / 6.9 / 6.11）へ置き換える。
- **書き換え**：`slot-card.example.test.tsx`（idle の `next` が配列・`head` / `member` の描画）、`order-rail.example.test.tsx`（`QueueEntry` の形が変わらないことの確認のみ）、`tests/core/to-wire-timer-adjustment.example.test.ts`（`orderItem` を運ぶ）。
- **型の追随**（挙動は変えない）：`tests/domain/wireGenerators.ts` と `tests/client/generators.ts` の推奨生成器に `group` / `anchor` を足す。`assignedSlotDisplays(…, [])` を呼ぶテスト（`complete.example`・`audioCue.property`・`assignment-ui.example`・`localAuthority.property`・`degraded-slot-superimposition.{display,exploration}`）は第 4 引数を落とす。`tests/core/objective.{property,example}.test.ts` は `slotDistance` の import 先を domain へ。

### 生成器

`tests/client/generators.ts` に、**群を作る場面**を足す：batch ごとに `group` を付け、合流した batch には `anchor`（同じ値の実効 endTime を持つ走行中の仲間を併せて作る）を、それ以外は null を振る。錨が過去（boiled）の batch、待ち行列に無い品目への推奨、プリセットに無い麺種、推奨の釜と重なる走行中（全釜 idle を破る）も混ぜる。

### 性質（Requirement 6 への対応）

| # | 性質 | 検査 |
| --- | --- | --- |
| 6.1 | 群の所属 | 同じ群の任意の 2 推奨は `group` が等しい。`group` が違えば同じ卓・同じ serveAt でも別の群 |
| 6.2 / 1.10 | 一意 | `liftGroups` は担当範囲を引数に取らない（構造で保証・6.7 と同じ静的な事実）。Property は「`view.timers` / `recommendations` / `pendingOrders` を任意に並べ替え、端末ローカルの項目（`connectivity` / `sync` / `processedIds` / `lastResults` / `error`）を任意に変えても、`liftGroups` / `visibleGroups` / `headOf` が構造的に等しい」——群と品目の並びを正準順序で定義した実装を固定する。担当範囲の不変は「units A と units B で共通する釜の idle `next` が一致する」として 6.6 の隣に置く |
| 6.3 | 単調な出現 | 同じ snapshot で Corrected_Now を進める。区間の分割点は表示できる群の `anchor` **だけ**。分割点を跨がない区間では提案は消えず薄→濃だけで、走行中 Timer の `endTime` を跨いでも破れない。分割点を跨ぐ区間は例外（後述の 2 場面） |
| 6.4 | 時刻不在 | `suggestionOf` のラベルの末尾は空か `now` |
| 6.5 | 群の境界 | ある群より前に started でない群があれば、その群の品目は `slotSuggestions` に現れない |
| 6.6 | 担当外の空白 | Visible_Groups の全品目が担当外なら `assignedSlotDisplays` の idle の `next` はすべて空 |
| 6.7 | 距離の一致 | `objective.ts` が import する `slotDistance` は domain のもの（静的検査：`objective.ts` に `function slotDistance` が無い） |
| 6.8 | 全釜 idle | 現れた提案の `slotIds` は occupied と交わらない |
| 6.9 | 先頭の上限 | `head` は店舗全体で `arms` 本以下、いずれも `startAt ≤ Corrected_Now`、表示できる品目の並びの先頭から取られている。全品の `startAt` が過ぎても `arms` 本を超えない。`member` は決してボタンを持たず濃くならない |
| 6.10 | 開始の事実の一意 | `started` は群の `anchor` と Corrected_Now だけの関数。`anchor` null は決して started にならず、`anchor ≤ Corrected_Now` も started でない |
| 6.11 | 非 live の沈黙 | degraded では `slotSuggestions` が空、ラジアルの `queue` が空、`startOrderItem` が呼ばれない（既存の connection.example と同じ形） |

### 茹で上がりの 2 場面（requirements「design への申し送り」）

1. **同じ snapshot で 599 秒 → 600 秒を跨ぐ**：G1 の仲間の `endTime` が 600 秒。599 秒では G1.started が真で G2 の提案（Prep_Lead 到来済み）が見える。600 秒で G1.started が偽になり、G2 の提案は消え、G1 の残りが先頭として濃く残る。
2. **その後に発火の snapshot を受け取る**：G1 の残りが新しい `serveAt`（走行中の `endTime` と不一致）で届く。G2 は引き続き隠れる。G1 の残りは先頭の群だが、**濃く出るのは新しい配置の全釜が idle のときだけ**——発火後の再計画は boiled の釜を「今空いている」と扱う（`initialRelease` は実効 `endTime` が過去なら now）ため、残りが boiled の釜（例：index 最小の釜 0）へ置き直されることがあり、その釜のカードは boiled（Complete 待ち）で提案を載せない。Complete された時点で現れる。

**両場面で一致するのは「G2 が隠れる」ことである。** G1 の残りの見え方は釜の割当に依るので、(2) の snapshot を手書きしない——`tests/core` 側で `startOrderItemTimer` → `fireDueTimers` → `toWireSnapshot` を実際に走らせて得た snapshot を `liftGroups` / `slotSuggestions` に通す横断 Example にし、boiled の釜が index 最小の場面と最大の場面の両方を置く。

### Example

- レビューの再現：茹で 510 / 360 / 330 秒の同卓 3 品（開始予定 0 / 150 / 180 秒）。180 秒経っても押せるのは 510 秒の品目だけで、他 2 品は薄いラベルだけ。
- 6 釜・同卓 4 品・各 2 釜（engine を実走させた snapshot で検査する）：1 本目を始めた後、合流する 2 品が G1（started・`serveAt` = 走行中の `endTime`）で今（head・solid）。釜 0・1 を待つ 1 品は別の `serveAt` を持つ **G2 の唯一の head** であり、member ではない。釜 0・1 が走行中の間は全釜 idle を満たさず提案自体が出ない。到達可能な続きは 2 通り：(i) 2 品を始め、360 秒に 3 本が boiled、1 本目を Complete → G1 は pending を持たず存在せず、G2 が**先頭の群として**現れ、item4 が釜 0・1 に head・solid（item2 / 3 の釜が boiled のままでも釜 0・1 は idle）。(ii) 2 品を始めないまま 360 秒に 1 本目が発火 → 再計画は残り 3 品を **一群に再統合**する（走行中の錨は過去ゆえ誰も合流できず、3 品とも `startAt` 360 秒 / `serveAt` 720 秒の同じ batch）。旧 G1・G2 の区別は消え、3 品とも head。item4 は空いている釜 4・5 に置かれるので、発火 snapshot の時点で表示できる（釜 0・1 は boiled で出ないが、item4 の釜はそこではない）。Complete 後は全品が表示される。「G1 が started なので連鎖が通る」経路は無い——釜 0・1 が空く時点で 1 本目は必ず boiled 以降である。**この再統合の場面を「茹で上がり後も G2 が隠れる」検査に使わない**——そちらは別卓の G2 と、G1 の残りが再統合されない場面（上の 2 場面）で検査する。
- `SlotCard`：`head` に丸ボタンと aria-label `… · now` / `… · soon`、`member` にボタン無しと `… · queued`。
- `RadialMenu`：live で待ち行列の列が出る。`slotSpan` 2 で許容距離の内側に空きが無い行は不活性。degraded で列が無い。**開いたまま snapshot が更新され、起点の釜が走行中になった場面**：`slotSpan` 1 の行を含めて全行が不活性になり、選んでも `startOrderItem` が呼ばれない。
- ワイヤ：`group` 空・`anchor` 不正 → 復号失敗（`wire.example`）。往復 Property に `group` / `anchor` を足す（`wireGenerators`）。

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
12. **ワイヤの往復** — `CookRecommendation.group` / `anchor` を含めて encode → decode が恒等（`verified-wire-contract` の既存 Property の拡張）。
13. **engine 不変** — 本 spec は engine を変えない（`lift-group-planning` の変更は同 spec のテストが固定する）。

## 解決済み — 等号の前提そのものを外した（`lift-group-planning` 判断 17〜19・本 spec 判断 20）

判断 16 の Group_Started は「同じ卓の走行中 T の `endTime` が群の `serveAt` に等しい」で、その根拠は「計画が合流した残りを走行中の実効 `endTime` に一致させる」（観測事実 13）である。design レビュー（workflow・2026-09-05）で、これが自前解の尾部でしか保証されず、採用済み一片（外部計画）は錨が Boil_Sync で動いても再錨しない穴が見つかった。**計画側で直した**（(a) engine 側・PR #28 コミット cb956b4）：確定計画の合成が採用済み一片を現在の実効錨で再検証し（`keepsAnchor`——合流分は錨に一致・合流できる品目を押し出さない）、違反した一片以降を切って残した接頭辞の解放表から尾部を再計算する。ゲートの (e) も同じ述語を読む。合流する部分集合は外部解に強制しない。

本 spec への帰結：

- 表示が読む snapshot の推奨は、すべての一片（自前解・採用済み）について「合流分の `serveAt` = 走行中の実効 `endTime`」を満たす。判断 16 の等号は前提として成り立つ。
- 錨が早まって本当に合流できなくなった品目の一片は、正当な後続の batch として残る。その群は `serveAt ≠ endTime` で **started にならない**——表示は「開始済み」を要求しない（要件どおり）。
- 横断 Property を `tests/core` に置く：`receivePlan` で合流一片を採用 → 無関係な Timer を `startTimer`（仲間の adjustment が動く）→ `toWireSnapshot` の timers / recommendations を `liftGroups` に通し、合流分の群が `started` であること、届かなくなった一片の群が `started` でないことを検査する。

## naming ゲート（実装前にユーザー確認）

| 名 | 場所 | 概念境界 |
| --- | --- | --- |
| `LiftGroup.group` / `LiftGroup.anchor` | `liftGroups.ts` | engine が運ぶ群の識別子と合流の錨をそのまま持つ（client は計算しない） |
| `PREP_LEAD_MS` | `src/domain/messages.ts` | 麺を準備する猶予（60 秒）。提案が薄く現れる `startAt` までの時間 |
| `LiftGroup` / `GroupItem` | `liftGroups.ts` | 同時に上げる群と、その品目 |
| `liftGroups` / `visibleGroups` / `slotSuggestions` / `pairSlots` | `liftGroups.ts` | 群の導出・連鎖・釜ごとの提案（先頭 arms 本を含む）・釜の組。`headOf` は判断 21 で撤去 |
| `SlotSuggestion`（`role: "head" \| "member"`） | `liftGroups.ts` | 押せる先頭（濃・店舗全体で arms 本）と押せない後続（薄）。`phase` は判断 21 で撤去 |
| `RadialQueueItem` / `RadialMenu.queue` / `onSelectItem` | `RadialMenu.tsx` | ラジアルの待ち行列の行と口 |
| `ClientView.unitOrigins` / `slotOffsets` / `affinityToleranceDistance` / `arms` | `connection.ts` | config から写す 4 項目（釜の組と先頭 arms 本に要る） |
| `slotDistance`（移設） | `src/domain/store.ts` | 釜どうしの距離。engine と client が共有 |

撤去：`suggestionTiming` / `SuggestionTiming` / `planAnchor`（変数）/ `nextForSlot` / `itemOf`。engine の `Ordered`。

**表に無く実装で増えた公開名（事後承認を要る）**：`suggestedItemOf` / `compareArrival`（task 0 の実測）・`displayName`（task 6 の実測）。いずれも `queueDisplay.ts` で、既存のインライン式・非公開関数に名を与えたものであり新しい概念ではない。
