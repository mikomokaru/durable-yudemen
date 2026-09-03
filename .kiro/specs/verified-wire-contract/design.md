# 技術設計書 — 検証済みワイヤ契約（verified-wire-contract）

## この設計が拠って立つもの

要件は「型の正本と実行時検証の対応を構造で担保する」ことを求める。設計はそれを **2 つのファイルの新設と 4 つの cast の除去**へ翻訳する。足す機構は無い。

判断の拠り所は `design-philosophy.md` の 3 点である。

- **真** — 復号後の型は、実際に検証した形だけを主張する。`as` は「検証していないものを検証済みと言う」構文であり、境界から除く。
- **善** — 破棄を無音にしない。壊れた `snapshot` が連続したとき、盤面が凍ったことに気づける経路を残す。
- **美** — 同じ検証を二度書かない。ただし**義務が違う検証を一つに畳まない**（後述の `pendingOrders`）。

## Overview

### 動機

ワイヤ契約の型は `src/domain/messages.ts` の一箇所にある。検証はそこから離れた 2 箇所に手書きされ、片端は素通しである。型を変えても検証は追随しない。

```
src/client/connectivity.ts:93    const candidate = parsed as { type?: unknown; serverTime?: unknown }
src/client/connectivity.ts:104   return parsed as ServerMessage          ← 2 項目だけ見て全体を主張
src/shell/store-timer-do.ts:159  const candidate = parsed as Record<string, unknown>
src/shell/store-timer-do.ts:171  slotIds: candidate.slotIds as readonly string[]
```

4 つの cast がこの spec の対象である。うち `:104` が観測事実 1〜2 の原因で、残る 3 つは同じ構文の小さい版である。

### 何を変えるか（要点）

1. `src/domain/wire.ts` を新設し、`toClientMessage` / `toServerMessage` を置く。両端がこれを使う。
2. `parseServerMessage`（`connectivity.ts:85-106`・22 行）と `parseClientMessage`（`store-timer-do.ts:151-198`・48 行）を撤去する。
3. ワイヤ型の基数を強める。`start.slotIds` と `CookRecommendation.slotIds` を `NonEmptyArray<string>` にし、`config` を `& StoreConfig` にする。
4. `toGridPoint` から `null` を返す芯を抽出し、`toNoodlePreset` / `toFirmnessCode` / `toMenuItem` を export する。畳む `to*` の挙動は変えない。
5. Decode_Failure を両端で観測可能に残す。

差分の見込みは、`src/` から約 83 行が消え（`parseServerMessage` 22 行・`parseClientMessage` 48 行・`toOrderItem` 13 行）、`src/domain/wire.ts` に約 90 行、`src/domain/predicate.ts` に約 15 行が入る。`store.ts` の `toGridPoint` の分離は差し引き数行の増減に収まる。

### 変えないもの

- ワイヤ上の JSON（7 種の種別集合・キー集合・階層・非圧縮 UTF-8）。
- ClientMessage の受理集合と拒否集合。値域外の `boilSeconds`・実在しない `timerId`・片方だけの注文品目参照は、現行どおり復号を通り、engine が `Engine_Rejection` として拒否して shell が `error` を返す。
- 心拍（`PING_REQUEST` / `PONG_RESPONSE` / `setWebSocketAutoResponse`）。
- 畳む `to*` の外部から見た挙動（`toSlotOffsets` / `toNoodlePresets` / `toUnitOrigins` / `toMenuItems`）。
- hibernation の適格性。Decoder は純粋関数であり、作用を持たない。

## Architecture

### 触る層と触らない層

| 層 | 変更 |
| --- | --- |
| `src/domain/wire.ts` | **新設**。Decoder 2 つと種別ごとの内部復号器 |
| `src/domain/predicate.ts` | **新設**（本体）。`isRecord` / `isNonEmptyString` / `isNonNegativeInteger`。`wire.ts` と `store.ts` が依存するため本体と同時に入る |
| `src/domain/messages.ts` | 型の基数を強める。`config` を `& StoreConfig` へ。規律を説明するコメントを撤去。**実行時コードは置かない** |
| `src/domain/store.ts` | `toGridPoint` の分離、3 つの Element_Validator の export。挙動は不変 |
| `src/domain/order.ts` | `toPendingOrder` のインライン検査を述語へ置き換える（挙動不変・**独立の task**） |
| `src/shell/store-timer-do.ts` | `parseClientMessage` / `toOrderItem` を撤去し Decoder を呼ぶ。`=== undefined` を `=== null` へ |
| `src/client/connectivity.ts` | `parseServerMessage` を撤去し Decoder を呼ぶ。失敗を記録 |
| `src/client/components/queueDisplay.ts` | `isNonEmpty` の読み飛ばし（`:68`）を撤去 |
| `src/engine/**` | `recommend.ts:49-50` のコメント撤去と、`migrate.ts:411` の `isNonNegativeInteger` 削除（Component 4b・独立の task） |
| `src/observe/**` | `log.ts:13` の `isNonNegativeInteger` 削除（Component 4b・独立の task） |
| `tests/client/generators.ts` | `genRecommendation.slotIds` と `genNoodlePresets` の**型**を修正。型検査を通すために必須 |

依存方向は変わらない。`wire.ts` は domain 内の相対 import だけを持つ。

client の**送信**経路は変更対象に入らない。`TimerConnection.start` と `LocalStart` は既に `NonEmptyArray<string>` を持つ（Data Models 参照）。

### 復号の位置

```
Wire_Text (string)
   │
   ├─ pong 判定（呼び出し側・Decoder へ到達しない）
   │
   ▼
domain/wire.ts : to{Client,Server}Message(text) → Message | null
   │                    │
   │                    ├─ isRecord / isNonEmpty / isFirmness / isNonEmptyString / isNonNegativeInteger（述語）
   │                    ├─ toArrayOf（配列の唯一の助け）
   │                    └─ toNoodlePreset / toFirmnessCode / toMenuItem / toGridPoint（要素検証）
   ▼
Shell: Event へ写す                Client: decideView へ畳む
Decode_Failure → 破棄 + 記録        Decode_Failure → 無視 + 記録
```

## Components and Interfaces

### Component 1: `src/domain/wire.ts`（新設）— 境界の唯一の関門

**なぜ `messages.ts` に同居させないか。** `messages.ts` は現在、値の export を持たず import 4 本すべてが `import type` である。Decoder は `store.ts`（Element_Validator）・`timer.ts`（`isNonEmpty`）・`firmness.ts`（`isFirmness`）・`predicate.ts` の**実行時**検証を呼ぶため、同居させると契約の定義ファイルが実行時依存を獲得する。`store.ts` / `order.ts` が型と検証を同居させている先例はあるが、それらは「その型の検証」を隣に置いた形であり、`messages.ts` の場合は「契約の宣言」と「境界の検証」という別の役割の同居になる。分ける。

`order.ts` からは何も呼ばない（Component 4 の判断により `toPendingOrder` を流用しない）。

公開するもの。

```ts
export function toClientMessage(text: string): ClientMessage | null;
export function toServerMessage(text: string): ServerMessage | null;
```

公開はこの 2 つだけにする。`toArrayOf` と `toSlotIds` は `wire.ts` の内部に留める。`isRecord` / `isNonEmptyString` / `isNonNegativeInteger` は `predicate.ts`（Component 4b）が持ち主で、`wire.ts` はそこから引く。境界の関門は 2 つであり、助けを公開すれば関門が増えたように見える。

内部構造は種別ごとの小さな関数（`toSnapshotMessage` / `toConfigMessage` / `toErrorMessage` / `toStartMessage` ほか）と、2 つの公開関数がそれを `switch` で振り分ける形。union で鍵付けする mapped type は導入しない（要件）。cast は 1 つも書かない。

**配列の助けは `toArrayOf` の一つだけにする。** 述語（`value is readonly T[]`）では書けない箇所が多数を占めるためである。要素検証（`toNoodlePreset` / `toMenuItem` / `toGridPoint`）は入力を判定するのではなく**余剰フィールドを落とした新しいオブジェクトを返す**ので、型ガードの形に収まらない。述語で足りるのは要素が文字列の `slotIds` 3 箇所だけであり、そこは `toSlotIds` が一手で担う。助けを 2 つ持つ理由が無い。

`toArrayOf` の用途は 8 箇所（`timers` / `pendingOrders` / `recommendations` / `noodlePresets` / `firmnessCodes` / `menuItems` / `unitOrigins` / `slotOffsets`）と、`slotIds` の 3 箇所。実在する重複に対する抽象である。要素が 1 つでも `null` を返せば配列全体が `null` になる（メッセージ単位の粒度・要件 2.7）。

### Component 2: `src/domain/messages.ts` — 型の基数を強める

3 箇所が変わる。

```ts
// start（ClientMessage）
readonly slotIds: NonEmptyArray<string>;      // was readonly string[]

// CookRecommendation
readonly slotIds: NonEmptyArray<string>;      // was readonly string[]

// config（ServerMessage）
| ({ readonly type: "config"; readonly serverTime: number } & StoreConfig)
```

`config` の 14 項目の列挙が消える。`StoreConfig` に項目が増えたとき、第二の一覧が無いので取りこぼす場所が無い。JSON は平坦なまま変わらない（intersection は構造を入れ子にしない）。

撤去するコメントは `:19-20` / `:70-74` / `:91-96`。いずれも「基数は JSON を跨げないため受け手が改めて確立する」という趣旨で、Decoder がそれを実際に行うため役目を終える。

`StoreConfig` が `type` / `serverTime` という名の項目を持つと、intersection が黙って重なる（宣言時にエラーにはならず、型が両立しなければその形の値を構築できなくなる）。制約というより注意書きであり、`StoreConfig` 側に 1 行残す。

### Component 3: `src/domain/store.ts` — 要素検証の共有

`toNoodlePreset`（`:523`）/ `toFirmnessCode`（`:567`）/ `toMenuItem`（`:596`）は**そのまま export する**。既に `null` を返し、余剰フィールドを落として正規化し、入れ子の基数（`toNoodleSizes` が `NonEmptyArray | null`）まで確立している。Decoder が要求する形と一致するため、分離も改変も要らない。

`toGridPoint`（`:489`）だけは `fallback` を受けて畳む。これは既存の不整合である——単数の `to*` は `| null` を返し（`toNoodlePreset` / `toFirmnessCode` / `toMenuItem`）、畳むのは複数形（`toNoodlePresets` / `toMenuItems` / `toUnitOrigins` / `toSlotOffsets`）という規則に、`toGridPoint` だけが従っていない。新しい名を足すのではなく署名を規則へ戻す。

```ts
export function toGridPoint(value: unknown): GridPoint | null {
  if (!isRecord(value)) return null;                 // domain/predicate.ts から
  const { x, y } = value;
  if (!isGridCoordinate(x) || !isGridCoordinate(y)) return null;
  return { x, y };
}
```

畳みは呼び出し側へ移す。7 箇所すべて `store.ts` 内にあり、fallback は index ごとに異なるため元の場所に置くのが自然である。

```
:458  origins.push(toGridPoint(items[unit]) ?? defaultUnitOrigin(unit));
:474  toGridPoint(items[0]) ?? DEFAULT_SLOT_OFFSETS[0],   … 以下 6 行同形
```

これで公開シンボルが 1 つ減り、`OrNull` という前例のない接尾辞も要らず、既存の不整合も同時に消える。`toUnitOrigins` / `toSlotOffsets` から見た挙動は同一である（要件：畳む `to*` の挙動を変えない）。**`toGridPoint` は現在非公開なので export を足す**（`wire.ts` から呼べない）。

`isRecord` は `wire.ts` ではなく述語モジュール（Component 4b）に置くため、循環は生じない。述語モジュールは何も import しない葉である。結果として現行 `toGridPoint` の `value as Record<string, unknown>`（`:491`）が消える。

### Component 4: `src/domain/wire.ts` の `pendingOrders` — 畳まないが、一つにもしない

`snapshot.pendingOrders` の復号に `toPendingOrder`（`order.ts:83`）は**流用しない**。形は似ているが義務が違う。

| | `toPendingOrder`（取り込み） | Decoder（ワイヤ） |
| --- | --- | --- |
| `arrivalTime` | 引数で受ける。POS の主張を許さない | 値から読む。サーバが確定した事実 |
| `noodleType` | `presets` と照合し未知種別を弾く | 非空文字列であることだけを見る |
| 呼ばれる向き | 外部 → 自分 | 自分（server）→ 自分（client） |

`arrivalTime` の出所は真の問題である。取り込み側が値から読めるようにすれば、「待ち時間の起点を外部が操作できない」という現行の保証が消える。`presets` 照合は他の事実との整合であり、`Type_Conformance` の外にある。

したがって共有するのは**述語だけ**にする（`isRecord` / `isNonEmptyString` / `isNonNegativeInteger` / `isFirmness`）。record 単位の関数を一つに畳むと、引数で挙動を切り替える分岐が生まれ、どちらの義務なのか読めなくなる。「同じ形に見えて義務が違う二つの検証は、一つに畳まない。」

代替案（`toPendingOrder` を構造部分と整合部分に分割し前者を共有する）も検討した。共有できるのは 5 つのフィールド検査で、`arrivalTime` の扱いを両立させるには「省略可能な `arrivalTime`」という第三の形を作る必要がある。得るものより持ち込む曖昧さが大きい。採らない。

### Component 4b: `src/domain/predicate.ts`（新設・本体）— 述語の持ち主を一つにする

同じ検査が 4 つに散っている。

```
src/engine/migrate.ts:411   function isNonNegativeInteger(value: unknown): value is number
src/observe/log.ts:13       function isNonNegativeInteger(value: unknown): value is number
src/domain/order.ts:88-94   toPendingOrder が同じ検査を無名でインラインに持つ
src/shell/store-timer-do.ts toOrderItem が同じ検査を無名でインラインに持つ（wire.ts へ移って消える）
```

**述語モジュールを 1 つ立てる。** `isRecord` / `isNonEmptyString` / `isNonNegativeInteger` をここに置き、`engine/migrate.ts` と `observe/log.ts` の 2 つは削除して import する。`order.ts:88-94` のインライン検査も名前付きの述語へ置き換える（挙動は同一）。`wire.ts` と `store.ts` も同じ場所から引く。

このモジュールは何も import しない葉であり、`store.ts` / `order.ts` / `wire.ts` のいずれからも循環なく依存できる。Component 3 が `isRecord` を使えるのはこの配置の帰結である。ファイルを 1 つ増やす取引は、`isNonNegativeInteger` の持ち主を名指すという 4b の目的が要求するものであり、`isRecord` はそこへ相乗りする。

`isNonEmpty` は `timer.ts` に残す。`NonEmptyArray` の定義と同居しており、型とその述語が並ぶのは正しい配置である。述語モジュールが持つのは、自分の型を持たない検査だけである。

**依存の新しい辺。** `observe/log.ts` が domain から関数を import するのは実行時依存として新規である（現状の先例は `src/observe/scenario.ts:9` の `import type` だけで、「先例がある」とは言えない）。`engine/migrate.ts` は `engine → domain` の実行時依存が既に在るため新規でない。

**task の分け方。** 4b は 2 つに分かれる。

1. **`predicate.ts` の新設（本体）。** `wire.ts`（`isRecord` / `isNonEmptyString` / `isNonNegativeInteger`）と `store.ts`（`toGridPoint` の `isRecord`）が依存するため、本体の変更と同時に入る。独立の task にはできない。
2. **既存 3 箇所の置き換え（独立）。** `engine/migrate.ts:411` / `observe/log.ts:13` / `order.ts:88-94` を述語へ寄せる。挙動は変わらず、触るファイルが spec の主対象外に及ぶため、差分を分けた方が読める。本体が入った後でよい。

### Component 5: `src/shell/store-timer-do.ts` — 受け口の縮退

`parseClientMessage`（約 45 行）と `toOrderItem`（約 12 行）を撤去し、`toClientMessage` を呼ぶ。

**注文品目参照の組は Decoder が成す。** 現行 `toOrderItem` は `parseClientMessage` と Event 組み立ての 2 箇所から呼ばれており、判定（型の妥当性）と組み立てが混ざっている。判定は `Type_Conformance` の内側なので Decoder の役目である。規則（両方揃い型が妥当なときだけ組を成し、それ以外はアドホック開始として通す）は変えない。

**shell に何が残るか。** `start` の `externalOrderId` / `itemIndex` は独立の optional のままである（組の型表明は `slot-suggested-start` へ送った）。ゆえに復号後の型も「片方だけ在る」を表現できてしまい、shell が Event の `orderItem` を組むときに両方の存在を改めて読む必要がある。残るのは検証ではなく 2 行の射影だが、「両方揃うか、どちらも無いか」を読む場所は Decoder と shell の 2 箇所になる。これは `start` の型が組を表明するまで消えない。`slot-suggested-start` が optional を撤去した時点で shell 側は消える。

`:1060` の `=== undefined` を `=== null` に合わせる。

**`noodlePresets` フィールドの型も直る。** `config` が `& StoreConfig` になると `configMessage()`（`:734-744`）はこの項目を非空として返す必要がある。現行の宣言は `:446` の `private noodlePresets: readonly NoodlePreset[]` で、代入元（`:710` の `config.noodlePresets`）は `StoreConfig` 由来で既に非空である。宣言を `NonEmptyArray<NoodlePreset>` にすれば済む。`unitOrigins` / `slotOffsets` は `ScheduleParams`（`engine/objective.ts:44-46`）経由で既に正しい型を持つ。

### Component 6: `src/client/connectivity.ts` — 素通しの撤去

`parseServerMessage`（22 行）を撤去し `toServerMessage` を呼ぶ。`:229` の `if (message === null) return;` は残るが、`return` の前に記録が入る。

pong による up 確定（`:224-226`）は変えない（要件 2.11）。Decode_Failure は到達性の問題ではない。

### Component 7: `src/client/components/queueDisplay.ts` — 読み飛ばしの撤去

`:68` の `if (!isNonEmpty(slotIds)) continue;` を撤去する。`CookRecommendation.slotIds` が `NonEmptyArray<string>` になり、Decoder が非空を確立するため、ここで再確立する理由が消える。

## Data Models

型の変更は Component 2 の 3 箇所だけである。新しいデータ構造は導入しない。

`Cardinality_Guarantee` の対象一覧（要件 Glossary）と Decoder の確立箇所の対応。

| 項目 | 型 | 確立に使うもの |
| --- | --- | --- |
| `TimerFact.slotIds` | `NonEmptyArray<string>` | `toSlotIds` |
| `start.slotIds` | `NonEmptyArray<string>` | 同上 |
| `CookRecommendation.slotIds` | `NonEmptyArray<string>` | 同上 |
| `StoreConfig.noodlePresets` | `NonEmptyArray<NoodlePreset>` | `toArrayOf(v, toNoodlePreset)` + `isNonEmpty` |
| `StoreConfig.slotOffsets` | 6 要素タプル | `toArrayOf(v, toGridPoint)` + 長さ 6 の検査 |
| `MenuItem.sizes` | `NonEmptyArray<NoodleSize>` | `toMenuItem`（内部で確立済み） |

### 送り手側の型は既に強い（波及が無いことの確認）

`start.slotIds` を非空にしても client の送信経路は変わらない。既に非空である。

```
src/client/connection.ts:670   start(slotIds: NonEmptyArray<string>, …): void
src/client/connection.ts:149   { kind: "LocalStart"; slotIds: NonEmptyArray<string>; … }
```

`SlotBoard.tsx:82` の `connection.start([String(slot)], …)` は文脈型付けにより既にタプルとして通っている。つまり弱いのは**ワイヤ型だけ**で、送信の直前に暗黙の弱化が起きていた。本変更はその弱化を消す。

`StoreConfig.noodlePresets` 側は逆に、テストの生成器が弱い。`genNoodlePresets`（`tests/client/generators.ts:158`）は `readonly NoodlePreset[]` と宣言されており、`config & StoreConfig` の下では `NonEmptyArray<NoodlePreset>` へ変える必要がある。

## Algorithmic Pseudocode

### `toServerMessage`

```
toServerMessage(text) → ServerMessage | null
  事前条件: text は pong ではない（呼び出し側が判別済み）
  事後条件: 返り値が null でなければ、全項目が Type_Conformance を満たす

  parsed ← JSON.parse(text)  … 失敗なら null
  if not isRecord(parsed) → null
  if typeof parsed.serverTime ≠ "number" → null
  switch parsed.type
    "snapshot" → toSnapshotMessage(parsed)
    "config"   → toConfigMessage(parsed)
    "error"    → toErrorMessage(parsed)
    _          → null            ← 撤去済み種別はここへ落ちる
```

撤去済み種別に `case` を書くことは**できない**。書いた枝は撤去済みの形をしたリテラルを返すしかなく、`ServerMessage` と突き合わされて型検査が失敗する。観測事実 2 の再発は構造的に不可能になる。

### `toSnapshotMessage`

```
toSnapshotMessage(record) → Snapshot | null
  timers ← toArrayOf(record.timers, toTimerFact)          … null なら null
  orders ← toArrayOf(record.pendingOrders, toPendingOrderFromWire) … null なら null
  recs   ← toArrayOf(record.recommendations, toRecommendation) … null なら null
  return { type: "snapshot", serverTime: record.serverTime, timers, pendingOrders: orders, recommendations: recs }
```

粒度はメッセージ単位である（要件 2.7）。壊れた推奨 1 件が `timers` ごと落とす。要素単位で畳めば「畳まない」に反し、`snapshot` の全量性という権威表現の性質も濁る。代償（盤面が更新されない）は記録で可視化する。

### `toStartMessage`

```
toStartMessage(record) → Start | null
  slotIds ← toSlotIds(record.slotIds)                … null なら null
    if typeof record.noodleType ≠ "string" → null           ← 空文字は見ない（engine が拒否する）
  if typeof record.boilSeconds ≠ "number" → null          ← 値域は見ない（engine が拒否する）
  ref ← （externalOrderId が非空文字列 かつ itemIndex が非負整数）なら組、でなければ無し
  return { type: "start", slotIds, noodleType: record.noodleType, boilSeconds: record.boilSeconds, ...ref }
```

`boilSeconds` の値域（1〜1800 秒）と `noodleType` の空文字を見ないのは意図である。どちらも現行 `parseClientMessage`（`store-timer-do.ts:164-167`）が `typeof` までしか見ず、engine が拒否として扱う。

```
src/engine/start.ts:28   slotId / noodleType が未定義（空）なら InvalidSlotOrNoodle を拒否として返す
src/engine/start.ts:67   code: "InvalidSlotOrNoodle"
```

ここで Decode_Failure にすると、`InvalidBoilSeconds` / `InvalidSlotOrNoodle` が `error` として要求元へ返る経路（`snapshot-broadcast` 要件 8.1）が消え、無音の破棄になる。要件 2.3・要件 5.2・Property 4 の 3 つを同時に破る。

`externalOrderId` の非空判定と `itemIndex` の非負整数判定は現行 `toOrderItem` と同一の条件であり、組を成すか否かを決めるだけで `start` 自体を拒否しない。

### `toSlotOffsetsFromWire` — 6 要素タプルを cast なしで組む

`tsconfig.json` は `noUncheckedIndexedAccess: true`（`:11`）である。`items[0]` の型は `GridPoint | undefined` になるため、「長さ 6 を検査した」だけではタプル型に代入できない。分割代入で 6 つを個別に確立する。

```
toSlotOffsetsFromWire(value) → SlotOffsets | null
  items ← toArrayOf(value, toGridPoint)      … null なら null
  const [a, b, c, d, e, f, ...rest] = items
  if a/b/c/d/e/f のいずれかが undefined → null
  if rest.length ≠ 0 → null
  return [a, b, c, d, e, f]                          ← 配列リテラルが 6 要素タプルへ推論される
```

長さの検査を `items.length === 6` で済ませて `as SlotOffsets` を書く形は、Property 1 が禁じる。分割代入は cast を使わずに同じことを型で言う唯一の形である。

`exactOptionalPropertyTypes: true`（`:14`）のため、`toStartMessage` の `...ref` は正しい。`externalOrderId: undefined` を明示的に置く形は型検査で落ちる。

## Error Handling

| 事象 | 向き | Decoder | 受け手 |
| --- | --- | --- | --- |
| JSON 不正 | 両 | `null` | 破棄・記録 |
| 未知の種別 | 両 | `null` | 破棄・記録 |
| 項目欠落 / 型不一致 | 両 | `null` | 破棄・記録 |
| 基数不足 | 両 | `null`（メッセージ単位） | 破棄・記録 |
| 値域外 / 実在しない識別子 | client → server | **通す** | engine が `Engine_Rejection` → `error` を要求元へ |
| 値域外（正の秒数・商品コード・`slotSpan` 域） | server → client | `null`（Element_Validator が弾く） | 破棄・記録 |
| 余剰フィールド | server → client | 落として正規化 | 通常の適用 |

Shell 側の「破棄」は Working_Copy を一切変更しないことを含む。Client 側の「破棄」は表示を変更しないことを含む。方向による非対称の根拠は要件 2.3 / 2.4 にある——値域を弾かないのは応答経路を残すためであり、server → client にその経路は無い。

記録の内容は**種別と失敗箇所だけ**とし、Wire_Text の中身を載せない。`externalOrderId` / `tableId` は POS 由来の業務データであり、ログへ流出させない（Security Considerations 参照）。

## Correctness Properties

### Property 1: cast 不在（静的検査・AST）

`src/domain/wire.ts` に型の嘘を作れる構文が現れない。走査は当該 1 ファイルに限る。

**正規表現ではなく AST で書く。** 先例が同じディレクトリにある。

```
tests/static/boil-sync-purity.test.ts:12   import ts from "typescript"
tests/static/boil-sync-purity.test.ts:18   function parse(relativePath: string): ts.SourceFile
```

数えるのは `ts.SyntaxKind.AsExpression` / `NonNullExpression` / `TypeAssertionExpression` の 3 種で、いずれも 0 件であることを要求する。`as const` は `AsExpression` の型が `const` かで判別して除く。`satisfies`（`SatisfiesExpression`）は型を弱めないため対象外とする。

AST にすると 2 つの問題が消える。`\bas\s+` がコメントや文字列中の英語（"… as a …"）に当たる問題と、`!` の検出が `!==` や `!x` と衝突する問題である。正規表現で後続文字を絞る調整は要らなくなる。

### Property 2: 往復（PBT）

任意の妥当な `ClientMessage` / `ServerMessage` について `to*Message(JSON.stringify(m))` が `m` と深く等価。全 7 種を分布する。

**前提：生成器は正規化済みの値を作る。** ServerMessage 側は `toNoodlePreset` / `toFirmnessCode` / `toMenuItem` を共有するため（申し送り B）、余剰フィールドを持つ値は落とされて往復しない。値域外の値（`boilSeconds` に 0 以下、`slotSpan` の域外）も同様である。深い等価が成り立つのは、生成器が「サーバが実際に送りうる値」——`StoreConfig` を経て正規化された値——を作る場合に限る。この前提は性質の一部であって抜け穴ではない。ワイヤに載るのは常に正規化済みの値だからである。

ClientMessage 側にこの前提は要らない。`Type_Conformance` までしか見ないため、余剰フィールドの扱いだけが往復に効く（現行 `parseClientMessage` と同じく、宣言された項目だけを写す）。

### Property 3: 全域性（PBT）

任意の入力について、Decoder は例外を送出せず `null` か検証済みの値を返す。返した場合は `Cardinality_Guarantee` を満たす。

**生成器は 2 層にする。** `fc.string()` だけでは JSON として解釈できる確率がほぼゼロで、`JSON.parse` が投げないことしか検査できない。境界の入力（キー欠落・型違い・空配列・撤去済み種別・入れ子の不正）に一度も届かない。

そこで妥当なメッセージを生成してから構造的に壊す生成器を用いる。壊し方は 5 種——(1) 必須キーを 1 つ落とす、(2) 値の型を別の型へ差し替える、(3) 配列を空にする、(4) `type` を撤去済み種別へ差し替える、(5) 入れ子の要素を 1 つ壊す。素の `fc.string()` も残すが、それは JSON 解釈失敗の枝を踏むためだけの役割である。

### Property 4: ClientMessage の受理集合の不変（差分 PBT）

現行 `parseClientMessage` が値を返す入力に対し `toClientMessage` は等価な値を返し、`undefined` を返す入力に対し `null` を返す。

入力は Property 3 と同じ 2 層の生成器を用いる。素の文字列では両者の差が出る入力に届かない。

実装方法は現行実装をテスト内へ写して比較する形にする。移行の一回だけ必要な性質であり、確認後にテストごと削除してよい。恒久的に残すと撤去したはずの実装が二つ目の真実として居座る。

### Property 5: `config` の項目網羅（型検査）

`config` の項目集合は `StoreConfig` の項目集合と定義上一致する。第二の一覧が無いため、照合すべき対象そのものが存在しない。`tsc --noEmit` が通ることがこの性質の検査である。

### Property 6: Decode_Failure の可観測性（例示）

Decode_Failure が発生したとき、記録が 1 件残る。記録に Wire_Text の中身が含まれない。

### Property 7: 畳む `to*` の挙動不変（既存テスト）

`toGridPoint` の分離前後で `toUnitOrigins` / `toSlotOffsets` の出力が変わらない。既存の `to*` テストがそのまま通ることで示す。

## Testing Strategy

| ファイル | 種別 | 内容 |
| --- | --- | --- |
| `tests/domain/wire.property.test.ts` | PBT | Property 2 / 3 |
| `tests/domain/wire.example.test.ts` | 例示 | 撤去済み種別 5 種が `null`（回帰の楔）・値域外 `boilSeconds` と空文字 `noodleType` が通る・片方だけの品目参照が組なしで通る・Property 6 |
| `tests/domain/wire-parity.property.test.ts` | 差分 PBT | Property 4（移行時のみ） |
| `tests/static/wire-no-cast.test.ts` | 静的 | Property 1 |
| `tests/static/domain-imports.test.ts` | 静的 | 要件 3.5（`src/domain/**` の import 先が domain 内の相対パスだけ） |

**壊す生成器。** Property 3 / 4 が使う 2 層の生成器（妥当なメッセージ → 構造的に壊す 5 種）を `tests/domain/wireGenerators.ts` に置く。壊し方の一覧はここが正本になる。

**既存生成器の型の修正（必須）。** 必要なのは `minLength` ではなく**型**である。`genRecommendation.slotIds`（`generators.ts:188`）は既に `fc.subarray(…, { minLength: 1 })` だが、宣言型は `readonly string[]` のままである。`genSlotIds`（`:90-92`）と同じく `.map((slots) => nonEmpty(slots))` を通して `NonEmptyArray<string>` にする。`genNoodlePresets`（`:158`）の宣言型は `NonEmptyArray<NoodlePreset>` へ変える。修正が要るのはこの 2 つと、新設の `genClientMessage` の 3 つである。`genWireTimer`（`:298-300`）は既に `genSlotIds` を使っており、変更は要らない。

**既存生成器の移設（任意・独立の task）。** `genServerMessage`（`generators.ts:317`）と `genWireTimer` / `genPendingOrder` / `genRecommendation` を `tests/domain/wireGenerators.ts` へ移し、`tests/client/generators.ts` はそこから import する形は、契約の生成器を domain 側へ寄せる整理として筋が通る。ただし**要件のどれもこれを要求していない**。3 つの既存テスト（`decideView.property.test.ts` / `reconcile.property.test.ts` / `generators.smoke.test.ts`）の import 元を触るため、tasks では本体の変更と混ぜず独立の項目にする。やらなくても本 spec は成立する。

生成器は省略する optional 項目をキーごと省く。`undefined` を値として置くと `JSON.stringify` が落とし、往復の等価性が生成器の都合で破れる。

## Security Considerations

Decode_Failure の記録に Wire_Text の中身を含めない。`snapshot.pendingOrders` は `externalOrderId` / `tableId` を含み、これは POS 由来の業務データである。Workers のログは運用者が閲覧するため、失敗のたびに注文情報を書き出すことになる。記録は「どの種別の復号がどの項目で失敗したか」に留める。

入力検証としては純粋に強化である。現行 client は未検証の値をビューへ通しており（`connection.ts:452`）、本変更はそれを塞ぐ。

## Dependencies

新しいパッケージは無い。`src/domain` は外部パッケージを import しない（Glossary の `Domain`・スコープ外）。`src/engine` も import しない（要件 3.5）。`src/domain/predicate.ts` は何も import しない葉である。

## 公開シンボルの確認ゲート（**確定済み**・2026-09-03）

`naming.md` により実装前の確認を要する公開シンボル。6 点すべてユーザー承認済みである。

| 候補名 | 表明する概念境界 |
| --- | --- |
| `toClientMessage` / `toServerMessage` | **確定。** 文字列から検証済み契約を確立する唯一の関門。単数の `to*` が `| null` を返す規則（Component 3）にそのまま乗る。境界であることは `wire.ts` が表明するため関門名で重ねない |
| `src/domain/wire.ts` | **確定。** ワイヤ境界の検証を集約する場所。`messages.ts` が契約の宣言、`wire.ts` が境界の検証 |
| `src/domain/predicate.ts` | **確定。** 自分の型を持たない検査の唯一の持ち主。`isNonEmpty` は `NonEmptyArray` と同居するため `timer.ts` に残る |
| `isRecord` / `isNonEmptyString` / `isNonNegativeInteger`（**確定**） | `order.ts` / `shell` にインラインで散り、`engine/migrate.ts:411` / `observe/log.ts:13` に無名の重複がある検査の名。`isNonEmpty` / `isFirmness` の述語慣習に連なる（Component 4b） |
| `toGridPoint`（署名変更） | **確定。** `(value) => GridPoint \| null` へ変え export する。新しい名は足さない——単数の `to*` が `| null` を返す規則（`toNoodlePreset` / `toFirmnessCode` / `toMenuItem`）に `toGridPoint` だけが従っていなかった。畳みは呼び出し側の `?? fallback` へ移す |
| Decode_Failure の記録の形（**確定**） | `{ kind: "decode-failure", contract, messageType, field }`。`contract` は `"ClientMessage"` / `"ServerMessage"` で復号器と 1 対 1。受け手も向きもここから導ける。`direction` は Operation_Log が `send` / `recv` の意味で持つため使わない（`observe/log.ts:73-74`）。`messageType` は Operation_Log と同じ意味で再利用する（`:38`）。`at` は Operation_Log の epoch ms と衝突するため使わない |

`toOrderItem` は shell から `wire.ts` へ移るが、公開しない（Decoder の内部）ため確認の対象外とする。

## 要件へ反映した申し送り（requirements.md 側で反映済み）

コードを読んだ結果、要件のまま実装できない点が 2 つあった。いずれも `requirements.md` へ反映済みである。以下は判断の記録である。

### A. Instrumentation_Log 経路は既定で無音だった（要件 2.8 / 2.9 へ反映）

要件 2.7 は shell の Decode_Failure を Instrumentation_Log へ記録することを求める。しかし出力は debug flag に閉じている。

```
src/shell/store-timer-do.ts:530-532
private get instrumentationEnabled(): boolean {
  return (this.env.OBSERVE_DEBUG as string) === "1";
}
```

`OBSERVE_DEBUG` の既定は `"0"` である。この経路では、本番で復号が失敗しても記録が出ない。判断 9（失敗を観測可能にする）の目的を満たさない。

さらに seam の追加は他 spec の要件に触れる。

```
src/observe/log.ts:170-173
計装が覗く継ぎ目の種別。4 継ぎ目に限定する（要件4.9）。
export type SeamKind = "construct" | "rehydrate" | "alarm" | "broadcast";
```

`hibernation-observability` が「観測点が増殖しないことを型で表明する」ために閉じた列挙であり、`"decode"` を足すには当該 spec の要件 4.9 の改訂が必要になる。

**反映内容。** 両端を構造化 1 行 JSON の `console.error` に統一した（要件 2.8 / 2.9）。client 側の先例（`persistence.ts:254` / `:263` / `:304`）は `[yudemen]` 接頭辞つきの文字列だが、shell 側の Instrumentation_Log は `console.log(JSON.stringify(entry))`（`:597`）の 1 行 JSON である。復号失敗の記録は後者の形に揃える——Workers のログを後から引くとき、文字列連結では種別や失敗箇所で絞れない。

記録の形は `{ kind: "decode-failure", contract: "ClientMessage"|"ServerMessage", messageType, field }` 程度とし、Wire_Text の中身は含めない（要件 2.10）。`[yudemen]` 接頭辞を JSON の外へ置くか `kind` に含めるかは実装時に決める。

機構は 1 つで済み、既定で出力され、他 spec の要件に触れない。Instrumentation_Log は「hibernation の継ぎ目を覗く道具」であって「異常を報せる道具」ではない。復号失敗は後者に属する。

### B. Type_Conformance は方向で範囲が異なる（要件 2.3 / 2.4 へ反映）

もとの要件 2.3 は Decoder が `Type_Conformance` までを見て値域を Decode_Failure にしないことを求めていた。根拠は「値域を弾くと `error` の応答経路が消える」（判断 8）。この根拠は **ClientMessage 側にしか存在しない**。server → client の向きに `Engine_Rejection` に相当する応答経路は無く、client は壊れた `config` を破棄して記録する以外にできることが無い。

そして ServerMessage 側で既存の Element_Validator を共有すると、それらが持つ値域検査が入る。

```
toNoodlePreset → toFirmnessSeconds : 全 4 硬さが正の整数秒（sec <= 0 を拒否）
toFirmnessCode / toMenuItem        : isProductCode（正の整数）
toMenuItem → toNoodleSize          : slotSpan が SLOT_SPAN_MIN..MAX の域内
```

これらを避けるには、ワイヤ用に構造だけを見る検証を別に書くことになる。同じ概念が二箇所で語られ、「重複の根絶」に反する。共有する方が正しい。

**反映内容。** 要件 2.3 の主語を ClientMessage に限り、要件 2.4 として ServerMessage 側を分けた（Element_Validator の正規化条件を含めて検証する）。Glossary の `Type_Conformance` にも方向を添えた。上限が要るのは応答経路を残すためであり、応答経路が無い側に上限を置く理由が無い。

この非対称は Property 2 の前提（生成器が正規化済みの値を作る）としても現れる。要件と design で同じ言葉を使う。

なお、この非対称は恣意ではない。ClientMessage は外部（現場の端末）からの要求であり、拒否には理由を返す義務がある。ServerMessage は自分が送ったものであり、形が違えばそれは自分の不具合である——理由を返す相手がいない。

## 整合の申し送り（実装時に確認）

- **tasks に立てる独立項目**：(1) 4b の 2（`engine/migrate.ts:411` / `observe/log.ts:13` / `order.ts:88-94` の既存 3 箇所を述語へ置き換える）、(2) ワイヤ生成器の `tests/domain/wireGenerators.ts` への移設（任意）、(3) **Property 4 の差分 PBT の削除**（移行確認後。残せば撤去したはずの実装が二つ目の真実として居座る）。いずれも本体の変更と混ぜない。`predicate.ts` の新設は本体に含まれる（4b の 1）。

- `tests/offline-degradation.static.test.ts:101` / `tests/sync-set-batch-complete.static.test.ts:84` / `tests/observe/static-analysis.example.test.ts:58` の `WIRE_MESSAGE_TYPES` は 7 種のまま変わらない。ただし `:447` の照合対象は `messages.ts` である。`config` を `& StoreConfig` にすると `type:` リテラルの出現位置は変わらないため、この検査は通る見込みだが実行して確かめる。
- `tests/client/generators.ts` の 4 つの生成器を**移設する場合は**、これらを import している既存テスト（`decideView.property.test.ts` / `reconcile.property.test.ts` / `generators.smoke.test.ts`）の import 元が変わる。移設は任意である（Testing Strategy 参照）。
- `slotIds` を非空にしたとき型検査で落ちる箇所は、`minLength` ではなく**宣言型**を直す（`.map((slots) => nonEmpty(slots))` を通す）。既に `minLength: 1` でも型が `readonly string[]` のままの生成器がある（`genRecommendation`・`generators.ts:188`）。
- **第二の一覧はテスト側にも在る。** `tests/domain/sync-config-server-authority.example.test.ts:18-41` は `keyof ConfigMessage` が 16 個のキー名の union と等しいことを型で固定している。`& StoreConfig` にしてもこの検査は通るが、判断 5 が domain から消した一覧がテスト側に残る形になり、`StoreConfig` に項目を足すとこのテストが一覧の更新を求めてくる。`Equal<keyof ConfigMessage, "type" | "serverTime" | keyof StoreConfig>` へ書き換え、一覧ではなく構造を検査に言わせる（tasks 4.1）。
- `queueDisplay.ts:68` の撤去により、同関数の `boilSecondsOf` が `null` を返す枝（`:70`）だけが読み飛ばしとして残る。これは基数ではなく整合の判定であり、撤去しない。
