# Design Document

> **レビュー前提（2026-09-18・ユーザー指定）：まだ運用していない。** 既存データの migration、古い投影との切り替え、旧画面との互換性、Idle_Precondition、移行期間の無停止・無欠損は今回のレビュー対象外とし、実装着手を妨げる指摘にしない。以下に残る移行設計の記述についても、この前提を適用する。玉数のモデル・導出規則・新形式の検証・表示・計画の整合性はレビュー対象とする。この前提で design に実装を妨げる指摘はない。

## Overview

メニュー対応表の麺量（`NoodleSize`）が持つ事実を釜数（`slotSpan`）から玉数（`portions`）へ改め、釜数は domain の純粋関数 `slotSpanOf(portions)` で導く。玉数は `OrderItem` に事実として載り、ワイヤで client へ届き、札に出る。釜数は設定・状態・永続・ワイヤのどこにも保持しない——「計算できるものは保持せず計算せよ」の直接の適用である。

変わるのは**値の出所**であって**意味**ではない。engine の割当・上げ窓・Acceptance_Gate・CP-SAT のモデル・client の釜の組は、従来 `item.slotSpan` と書いていた箇所で `slotSpanOf(item.portions)` を読む。同じ場面で同じ釜数が出るので、計画の判定は変わらない（Property 10）。

### 先行 spec との関係

- `pos-order-ingress`（§5・§6）：`NoodleSize.slotSpan` と「麺量から `slotSpan` へ翻訳」（AC 6.24〜6.25）を、`NoodleSize.portions` と「麺量から玉数を読み、釜数は導く」に読み替える。判定と翻訳が同じ入力から導かれる規律（Property 4）はそのまま。
- `per-store-provisioning`：イデア・合成・投影の経路は変えない。変わるのは `menuItems` の要素の形と、店舗 DO が古い形の投影の間は受領を `unprovisioned` で返すこと（Component 6）。
- `order-lifecycle` / `order-item-truncation`：`OrderItem` の生涯・上限は変えない。永続は v15。
- `lift-group-planning`（ADR-0002・AC 11）：`slotSpan` を計画のハード制約にした規律は導出値のまま引き継ぐ。
- `item-display-abbreviation`（判断 8・`SIZE_LABEL`）：麺量の語は残し、玉数の札を隣に置く。
- `cpsat-planner-integration/verification/menu-policy-slotspan-20260914.md` §3・§6：本 spec はそこで「別途計画する」とされた未処理 2 の実装である。

## Architecture

```
domain/store.ts     PORTIONS_PER_SLOT = 1.5 ・ PORTIONS_MIN / MAX ・ isPortions ・ slotSpanOf(portions)   ← 占有規則はここ一つ
                    NoodleSize { code, portions } ・ toNoodleSize（畳み型）
        │
        ├─ registry/validate.ts   validateNoodleSize：{ code, portions } を拒否型で検証（slotSpan は未知フィールド）
        │        └─ compose.ts    変更なし（toMenuItems を通すだけ）
        │
        ├─ ingress/noodle-spec.ts NoodleSpec.portions = size.portions
        │        └─ shell/store-timer-do.ts  OrderItem.portions ← spec.portions
        │                                    receiveRecords：古い形の投影なら unprovisioned（番号を進めない）
        │                                    adoptProjectionConfig：menuItems を toMenuItems に通す（型と値を揃える）
        │                                    snapshot の射影：slotSpan を併記（移行期間・旧画面の復号のため）
        │
        ├─ domain/order.ts        OrderItem.portions（slotSpan を持たない）・toArrivedItem は portions を読む
        ├─ domain/wire.ts         WireOrderItem.portions・toOrderItemFromWire は isPortions で関門
        ├─ engine/*               釜数は slotSpanOf(item.portions)・digest は portions を畳む・migrate は v15
        ├─ cpsat/*                同上
        └─ client/*               pairSlots(slot, slotSpanOf(order.portions), view)・portionsLabel を札に添える
```

原則は 3 つ。

1. **事実は一つ、導出は一つ。** 玉数だけが事実で、釜数は `slotSpanOf` の値。二つを同時に持てば必ずずれる（2026-09-14 の 9 コードがその実例である）。
2. **規則は定数で、設定ではない。** `PORTIONS_PER_SLOT` は釜（テボ）の物理であり、10 店舗で差が無い。設定にすれば投入漏れの面が一つ増え、店舗ごとに「同じ玉数が違う釜数」になる余地が生まれる。店舗差が実在した日に設定へ上げる（`liftIntervalSeconds` が 2026-09-17 にそうなったのと同じ道）。
3. **仮置きは読み手に届かせない。** 釜数から玉数への逆写像は一意でない。仮置き（`portions = slotSpan`）は占有を保つが、投入量として見せれば嘘になる。ゆえに deploy は Idle_Precondition（全店が 2 時間以上受領なし・走行中なし）の下で行い、v14 の品目がすべて期限切れで読み手を持たない状態で移行する（requirements 判断 5）。「不明」を型で運ぶ（`number | null`・和型）案は却下——一度きりの移行のために全読み手が永久に分岐を持つ。
4. **切り替えの途中で注文を失わない・画面を止めない。** 古い形の投影を持つ店舗 DO は受領を `unprovisioned` で返して上流の再送に委ね（番号を進めない）、サーバは移行期間ワイヤに導出値 `slotSpan` を併記して旧画面の復号器を落とさない。

## Data Models

### domain（`src/domain/store.ts`）

```ts
/** 1 釜（テボ）に入る玉数の上限。釜の物理であり店舗設定ではない（10 店舗で差が無い・2026-09-18）。 */
export const PORTIONS_PER_SLOT = 1.5;

/** 玉数の下限（半玉）。0 や負値は「麺の無い麺」ゆえ表現させない。 */
export const PORTIONS_MIN = 0.5;

/** 玉数の上限（= SLOT_SPAN_MAX × PORTIONS_PER_SLOT = 9）。1 品目がユニットを跨がない既存の上限を玉数へ写す。 */
export const PORTIONS_MAX = SLOT_SPAN_MAX * PORTIONS_PER_SLOT;

/** Portions の述語——有限・0.5 刻み・値域内。設定・品目・ワイヤ・永続の 4 経路が同じ関門を通る。 */
export function isPortions(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value * 2) &&
    value >= PORTIONS_MIN &&
    value <= PORTIONS_MAX
  );
}

/**
 * Slot_Occupancy_Rule — 玉数から釜数を導く唯一の規則。⌈portions / PORTIONS_PER_SLOT⌉。
 *
 * 半玉単位の整数演算（⌈2p / 3⌉）で計算する。0.5 刻みの p に対し 2p は正確な整数であり、除算の結果が
 * 整数になるのは割り切れるときだけなので、天井が浮動小数の丸めで 1 ずれることがない。
 */
export function slotSpanOf(portions: number): number {
  return Math.ceil((portions * 2) / (PORTIONS_PER_SLOT * 2));
}

export interface NoodleSize {
  readonly code: number;
  /** 当該麺量の玉数（Portions）。釜数はここから slotSpanOf で導く。 */
  readonly portions: number;
}
```

`SLOT_SPAN_MIN` / `SLOT_SPAN_MAX` は残す（導出値の値域の正本・`migrate` の旧版の復元と CP-SAT の容量判定が読む）。`toSlotSpan`（domain）は読み手が無くなるので消す。

### `OrderItem`（`src/domain/order.ts`）・`WireOrderItem`（`src/domain/wire.ts`）

```ts
export interface OrderItem {
  // …既存…
  /**
   * 麺の玉数（Portions・0.5 刻み）。麺量の商品コードから翻訳して定める事実。
   *
   * 釜数（slotSpan）は持たない——slotSpanOf(portions) の導出値であり、持てば二つの真実になる。
   * client が札に出し engine が釜数を導くので共有される事実（timer-model.md の判定）。
   */
  readonly portions: number;
}
```

`slotSpan` のフィールドは消える。`WireOrderItem extends OrderItem` は自動で追随し、`toOrderItemFromWire` の関門を `isNonNegativeInteger(slotSpan)` から `isPortions(portions)` へ替える。

**移行期間の併記（Wire_SlotSpan）。** 旧画面の復号器（deploy 前の `toOrderItemFromWire`）は `slotSpan` を非負整数として必須にしており、無ければ snapshot 全体を Decode_Failure で落とす。client に再読み込みの経路は無く、WS の再接続後も実行中の JavaScript は旧のままなので、サーバは送信時に導出値を併記する。

```ts
export interface WireOrderItem extends OrderItem {
  readonly shortName?: string;
  /**
   * 移行期間の併記（Wire_SlotSpan・2026-09-18）。deploy 前の復号器が `slotSpan` を必須とするため、旧画面が
   * snapshot を落とさないように送信時に `slotSpanOf(portions)` を載せる。**新しい復号器は読まない**——
   * ワイヤは射影であって状態ではなく、導出値を載せても真実は `portions` 一つのままである。全端末の更新を
   * 確かめた後に外す（別 spec）。
   */
  readonly slotSpan?: number;
}
```

送信側は `store-timer-do.ts` の snapshot 射影（`shortName` を被せている箇所・`:849`）で `slotSpan: slotSpanOf(item.portions)` を足す。復号側は `slotSpan` を一切見ない（性質 12）。

### 永続（v15）

| 版 | 足したもの | 落としたもの |
| --- | --- | --- |
| v15 | `OrderItem.portions`（玉数） | `OrderItem.slotSpan`（釜数・導出値になった） |

`reviveSlotSpan` を `revivePortions(o, version)` に替える。**版を受け取る**——欠如を無条件に畳めば、v15 で必須の値が欠けた壊れたデータも 1 玉として通ってしまう（レビュー反映）。`reviveOrderItems(value, version)` → `toOrderItem(value, version)` と版を渡す（既存の `migrate` は `version` を読んで上限を検査しているので、そこから下ろすだけ）。

```ts
/**
 * 永続の玉数を現行 v15 形へ写す。版で必須項目を分ける。
 * - version ≥ 15 → portions 必須。欠如・isPortions を通らない値は壊れたデータ（null）。slotSpan が在っても読まない
 *   （v15 の永続に slotSpan は無く、在っても読まないことで「二つあればどちらが正か」を問わない）。
 * - 8 ≤ version ≤ 14 → portions = slotSpan（Migrated_Portions）。slotSpan が非整数・値域外なら壊れたデータ。欠如は
 *   従来どおり 1。逆写像は一意でないので釜数 1〜2 それぞれの最頻の玉数（1.0 / 2.0）を採る。slotSpanOf(portions) は
 *   釜数 1〜2 で元に一致する（計画の占有は変わらない）。この値は Idle_Precondition の下では読み手に届かない。
 * - version ≤ 7 → 1（従来 slotSpan = 1 へ畳んでいたのと同じ帰結）。
 */
function revivePortions(o: Record<string, unknown>, version: number): number | null;
```

## Components and Interfaces

### Component 1: 占有規則（`src/domain/store.ts`）

上の Data Models のとおり。置き場所は domain——engine（割当）と client（釜の組）と cpsat（モデル）が同じ釜数を要るので、`slotDistance` と同じ理由で中立地帯に一度だけ置く。engine は再 export しない。

### Component 2: 投入の検証（`src/registry/validate.ts`）

`validateNoodleSize` の許可フィールドを `["code", "portions"]` にし、`portions` を次の順で検査する。

| 状態 | reason | detail |
| --- | --- | --- |
| 欠落 | `missing-required` | `portions は必須` |
| 非数・非有限 | `type-mismatch` | `数値である必要がある` |
| 0.5 刻みでない | `out-of-range` | `0.5 刻み（受領: 1.25）` |
| `PORTIONS_MIN` 未満・`PORTIONS_MAX` 超 | `out-of-range` | `0.5〜9（受領: 12）` |

`slotSpan` は `unknownFieldRejections` が拾う（専用の分岐を書かない——「以前の名」を特別扱いすれば、それは読み替えの入口になる）。既存の `validateNumeric` は整数を前提にしているので、刻みの検査は `isPortions` を分解した小さな関門として書く（`validateNumeric` を拡張して整数以外を通せるようにはしない——他の数値フィールドの整数性が緩む）。

### Component 3: 翻訳（`src/ingress/noodle-spec.ts`・`src/shell/store-timer-do.ts`）

`NoodleSpec.slotSpan` → `NoodleSpec.portions`。`toNoodleSpec` は `size.portions` をそのまま返す。店舗 DO の `toReceivedOrders` は `portions: spec.portions` と写す。翻訳の層は釜数を知らない——知る必要が無い（`toNoodleSpec` の doc の「3 つの事実」は「麺種・茹で加減・玉数」になる）。

Order_Ingress（`domain/order.ts` の `toArrivedItem`）は `candidate.portions` を `isPortions` で読む。`toSlotSpan` は消える。

### Component 4: engine の読み手

`item.slotSpan` を読む全箇所を `slotSpanOf(item.portions)` にする。読み手ごとに意味は変わらない。

| ファイル | 箇所 | 備考 |
| --- | --- | --- |
| `engine/schedule.ts` | 割当（`placeBatch`・配分）・容量（`Σ slotSpan ≤ 釜数`）・上げ窓（`liftCap`）・Acceptance_Gate（`placement.slotIds.length === slotSpan`）・合流判定 | 局所変数 `span` はそのまま。ホットパス（配分の内側）で毎回導くのは `Math.ceil` 1 回で、費用は無視できる |
| `engine/pending.ts` | `upsertOrder` の属性更新・`isSameOrderItems` | `portions` を写し、比べる |
| `engine/digest.ts` | `fold(order.portions)` | 事実を畳む（釜数を畳めば、同じ釜数の別の玉数が同じ写しになる） |
| `engine/admit.ts` / `commit.ts` / `lift.ts` / `start.ts` | コメントと `span` の出所 | `lift.ts` の `span = slotIds.length` は変えない（割当の実体） |
| `engine/migrate.ts` | `revivePortions` | Component 上記 |
| `cpsat/request.ts` / `plan.ts` / `worker.ts` | 対象の絞り（`slotSpanOf(item.portions) <= slotCount`）・モデル・観測の内訳 | 観測の鍵は導出値（`String(slotSpanOf(item.portions))`）のまま——「何杯が何釜を要るか」を見る目的は変わらない |

### Component 5: client

- `SlotBoard.tsx`：`pairSlots(picker.slot, slotSpanOf(order.portions), view)`。`liftGroups.ts` の `pairSlots` の引数は釜数のまま（釜を組む関数は釜数を受ける）。
- `queueDisplay.ts`：`portionsFigure(portions)`（`1.5` / `2`・単位なし）。`displayName` は変えない。
- `NoodleChip.tsx`（新規）：麺種の名と玉数を一つのチップに置く。麺種の色で塗り、文字は統一の暗色（`NoodleBadge` と同じ）。語は `{noodleType} {figure}`。
- `OrderRail.tsx` / `RadialMenu.tsx`：品名の前に `NoodleChip`。
- `SlotCard.tsx`：`NoodleBadge` に `chip` を足し、上がり順のチップの隣に置く（暗色のピル・同じ形）。読み上げは `… · {noodleType} {portions}` を末尾に添える。注文を持たない Timer はチップ無し。
- `OrderFlowBoard.tsx`：`Card` に `chip` を足し品名の前に置く。`BowlTile` はタレの行の前に置き、サイズの語は従来どおり。

```ts
/** 玉数の数字。整数は小数点なし（`2`）、半端は 1 桁（`1.5`）。単位は付けない（バッジの語・改訂 2026-09-18）。 */
export function portionsFigure(portions: number): string {
  return Number.isInteger(portions) ? String(portions) : portions.toFixed(1);
}
```

`toFixed(1)` は 0.5 刻みの値に対して `"1.5"` を返す（丸め誤差は Portions の値域に無い）。当初の「品名の末尾に `1.5玉`」は撤回した——品名が伸び、麺種は色でしか判らなかった（ユーザー指示 2026-09-18）。

### Component 6: 古い形の投影と受領の門（`src/shell/store-timer-do.ts`）

**永続投影は deploy 前の形でありうる**——型は `MenuItem[]` でも値は `slotSpan` 形の `sizes` を持つ（Stale_Projection）。この投影で受領を確定してはならない。麺の品目が非麺として通り、`arriveRecords` が**品目 0 件の受領として番号を進め**、既存の未調理品目を除き、Policy を直した後の再送が重複として捨てられる（レビュー反映・現行コードで再現済み）。

```ts
/** 投影の menuItems が現行の形か（sizes の全要素が portions を持つ）。永続の値から導き、別の状態を持たない。 */
function hasCurrentMenuShape(menuItems: unknown): boolean;

async receiveRecords(records) {
  …
  if (!provision.provisioned) return { kind: "unprovisioned" };
  // 古い形の投影（deploy 前にレジストリが押し込んだもの）で受領を確定すると番号が進んで再送が捨てられる。
  // 投影未達と同じ扱いにし、上流の再送に委ねる（Worker は 5xx・レジストリの再生は deferred）。
  if (!hasCurrentMenuShape(provision.projection.config.menuItems)) return { kind: "unprovisioned" };
  if (!provision.projection.active) return { kind: "deactivated" };
  …
}
```

- `unprovisioned` は既に一時的失敗として扱われている——Worker は Arrival_Batch 全体を 5xx にして上流の再送に委ね（`worker.ts:635`）、レジストリの保留の再生は `deferred` で持ち越す（`store-registry-do.ts:723`）。番号を進めないので、新しい投影の後の再送は初着として受理される（性質 11）。
- 判定は永続投影の値から毎回導く（`provisionState` に新しい枝を足さない）。`applyProjection` で新しい投影が入れば、次の受領から自然に通る。
- WS 接続と `config` 配信は変えない。古い形の `menuItems` は client の `toStoreConfig` が `portions` を持たない `sizes` を落とすだけで、client は翻訳しない。
- 在メモリの反映は `this.menuItems = toMenuItems(config.menuItems)` にする。門があるので翻訳には使われないが、型が指す形と値を一致させる（`liftIntervalSeconds` の欠如を畳む前例と同じ層）。永続は書き換えない（hydration は `Persist` を起こさない）。

### Component 7: レジストリのイデア

**コードで移行しない。** イデアに版は無く、`slotSpan` から `portions` への逆写像は一意でない（仮置きを本部の正本に書き込めば事実の捏造である）。正しい玉数はユーザーが確定した（requirements 判断 11・`config/provisioning-sample/pos-menu-policy.json`）。永続された Policy `pos-menu` は、deploy 直後に玉数形で `PUT` し直す。**それまでの間、`loadIdeal` → `composeEffectiveConfig` → `toMenuItems` は `slotSpan` 形の `sizes` を落とすので、その間に別の理由で再収束が走った店舗には空のメニューが押し込まれる**——その店舗は Component 6 の門を通らず（`sizes` が無ければ形は「現行」）、受領が非麺として確定しうる。ゆえに deploy から PUT までの間、Provisioning_API へ他の投入をしない（tasks 11）。

### Component 8: ロールアウト（tasks に手順として置く）

0. **Idle_Precondition の検証**：Workers Logs で直近 2 時間の `records-received` と `Persist` が全店で 0 件であることを確かめる。満たさなければ deploy しない。仮置きの玉数（Component 上記）が現場に投入量として表示されないことは、この前提条件だけが保証する。前提条件が破られた場合の残余は「v14 の期限内の品目が最大 2 時間、釜数から仮置きした玉数を札に出す」で、計画の占有は変わらない。
1. deploy 前：`pos-menu-policy.json` をローカルの `validatePolicy` に通す（`slotSpan` が 1 つでも残れば 400 になる。`null` も同じ）。
2. deploy：アプリ Worker と CP-SAT 計画器 Worker を同じ変更で出す（`PlanRequest` の形が変わる）。
3. deploy 直後：`PUT /admin/policies/pos-menu`。fan-out が全 200 店の投影を作り直す（`converge` の残作業が尽きるまで Alarm 継続）。この間は他の投入をしない（Component 7）。deploy から PUT までが上流の再送の窓（`ARRIVAL_WINDOW_MS`・2 時間）より短いことを確かめる。
4. 確認：任意の店舗で受領が `settled` になり品目が `portions` 付きで載ること、client の `config` に `sizes[].portions` が載ること、Workers Logs で `unprovisioned` 由来の 5xx が止まったこと。

### Component 9: 触らないもの

- `Timer` / `TimerFact` / `ServerMessage` の他の種別・`Sequenced`・`seq`。
- `compose.ts`・`ideal.ts`（`PolicyFields.menuItems` / `StoreOverride.menuItems` の型は `MenuItem[]` のまま）・`CONFIG_FIELDS`。
- `SIZE_LABEL`・`sizeName`・`item-display-abbreviation` の札。
- `lift.ts` の `span = slotIds.length`（割当の実体の本数）。
- `liftGroups.ts` の `pairSlots` の引数の意味（釜数）。

## Error Handling

| 経路 | 不正な `portions` | 帰結 |
| --- | --- | --- |
| Provisioning_API | 欠落・非数・刻み外・値域外・`slotSpan` の混入 | 400・理由を全件列挙・イデア不変 |
| 合成の出口・店舗 DO の反映点（`toMenuItems`） | 値域外の要素 | 当該 `sizes` 要素を落とす。`sizes` が空なら `MenuItem` を落とす（クランプしない） |
| Order_Ingress（`toArrivedItem`） | 欠落・値域外 | 品目全体の拒否（400・既存規律） |
| ワイヤ（`toOrderItemFromWire`） | 値域外 | Decode_Failure（snapshot 全体を落とす・既存の `slotSpan` の関門と同じ強さ）。併記の `slotSpan` は読まない |
| 永続（`revivePortions`） | v15 で欠如・値域外／v8〜v14 で `slotSpan` が値域外 | `MigrationFailed`（部分受理という嘘を作らない） |
| 受領（`receiveRecords`） | Stale_Projection | `unprovisioned`（番号も集合も変えない・上流の再送に委ねる） |

## Correctness Properties

requirements Requirement 9 の 10 項。置き場所——

- 1〜4（導出）：`tests/core/store-config-lookups.property` に隣接して `tests/domain/slot-span-of.property`（新規）。4 は 18 値の全数（例）。
- 5（移行の占有保存）：`tests/core/migrate.property` / `migrate.example`。
- 6（保持しない）：`tests/noodle-portions.static.test.ts`（新規）。`src/domain` の型宣言に `slotSpan:` が無いこと、`src` の `Math.ceil` を含む行のうち `PORTIONS_PER_SLOT` を割るものが `slotSpanOf` の定義だけであること。
- 7（翻訳の透過）：`tests/ingress/noodle-spec.property` Property 4 の読み替え。
- 8（ワイヤ往復）：`tests/domain/wire.property`。
- 9（拒否の網羅）：`tests/registry/validate.example`。
- 10（計画の不変）：`tests/core/schedule.example` / `plan-stability-occupancy.example` の既存 scene を玉数へ写し替え、期待値が変わらないことで固定する（新しい主張は書かず、フィクスチャの置換だけで緑のままであることが回帰）。
- 11（古い投影は受領を止める）：`tests/shell/store-timer-rehydrate.integration`——`slotSpan` 形の `sizes` を持つ永続投影の DO に Record を渡すと `unprovisioned` で、`activeTimers` の `lastSequenceByTerminal` と `orderItems` が変わらない。`applyProjection` で新しい投影を入れた後に同じ Record を渡すと `settled` で、品目が `portions` 付きで載る。
- 12（旧復号器との混在）：`tests/domain/wire-transition.example`（新規）。**deploy 前の `toOrderItemFromWire` を写しとしてテストの中に固定し**、新しいサーバの snapshot（`portions` + 併記 `slotSpan`）を復号できること。新しい復号器は併記の有無で同じ値を返すこと。

## Testing Strategy

- **フィクスチャの置換が本体である。** 88 ファイルの `slotSpan: k` を `portions: k` に置き換える（k ∈ {1, 2} が大半・`slotSpanOf` で元の釜数に戻る値を選ぶ）。生成器（`tests/core/generators.ts` / `tests/client/generators.ts` / `tests/domain/wireGenerators.ts` / `tests/ingress/noodle-spec.property`）は `fc.integer({min: SLOT_SPAN_MIN, max: SLOT_SPAN_MAX})` を Portions の生成器（0.5 刻み・`fc.integer({min: 1, max: 18}).map(n => n / 2)`）に替える。**釜数 3 以上を要る scene**（`SLOT_SPAN_MAX` を踏む検証）は `portions = k × PORTIONS_PER_SLOT` で組む。
- **全数ゲート。** 置換後に `pnpm typecheck` / `pnpm lint` / `pnpm test` を全数で回す。property は 3 回再実行（`subagent-verification-reports` の規律）。
- **統合。** `tests/shell/apply-projection.integration`（新しい形の `menuItems` が配信される）、`tests/shell/pos-records.integration`（玉数が `OrderItem` に載る）、`tests/shell/store-timer-rehydrate.integration`（**v14 の永続値を持つ DO を起こすと v15 として読め、`slotSpanOf(portions)` が元の釜数に一致する**・古い形の投影を持つ DO は受領を `unprovisioned` で返し、番号も集合も変えない・新しい投影の後は同じ Record が `settled` で確定する）。**混在。** deploy 前の `toOrderItemFromWire` の写しを固定し、併記付きの snapshot を復号できること（性質 12）。

## naming ゲート（未承認・task 0）

requirements の表のとおり。承認後、表に「承認済み・日付」を記す。

## 未決の決定（requirements の「未決」への答え）

1. **Policy の出所** → 解決済み（`config/provisioning-sample/pos-menu-policy.json`・CSV 39 コード + ユーザー規則 3 コード）。CSV にあって対応表に無い 10 コードは**本 spec では触らない**（茹で対象の範囲を変える別判断）。
2. **`displayName` に添えるか** → **添える**（判断 7）。釜へ落とす人が見るのは待ち行列の札であり、Orders 画面だけでは届かない。長さは `醤油中盛 1.5玉` 程度で、`shortName` の札が効く場面では `塩中盛 1.5玉` に収まる。
3. **空白の可観測性** → 空白そのものを無くした（Component 6）。受領は `unprovisioned` として既存の 5xx の観測に載る。
4. **`GET /admin/policies/{policyId}`** → 別 spec。本 spec の tasks に「立てる」を残す。
5. **Wire_SlotSpan の除去** → 別 spec。client がバンドルの版を送らないので「全端末が更新済み」を確かめる手段もそこで決める（候補：`config` 受信時に client がバンドルの版を返す・WS の `User-Agent` 相当の項目を継ぎ目ログに出す）。

## ADR

`docs/adr/0017-slot-occupancy-is-derived-from-portions.md`（task で書く）——「釜の占有は玉数から導く。設定も状態も釜数を持たない。規則は定数。ワイヤの併記は射影であって状態ではない」。却下案：(a) 釜数を残し玉数を足す（二つの真実）、(b) `PORTIONS_PER_SLOT` を店舗設定にする（店舗差が実在しない）、(c) 移行で玉数を null か和型にする（釜数を別に持つ／全読み手が永久に分岐を持つ）、(d) イデアを釜数から逆算して移行する（事実の捏造）、(e) 古い投影を畳んで受領を確定する（番号が進んで再送が捨てられる）。
