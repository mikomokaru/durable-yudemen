# 技術設計書 — 同時に上げる群の計画（lift-group-planning）

## この設計が拠って立つもの

- `requirements.md`（本 spec）の判断 1〜16 と Requirement 1〜8。ここでは要件を言い換えず、**要件を満たす構造**だけを述べる。
- `docs/adr/0001-lift-group-alignment-by-objective.md`（揃えるを採点の帰結にする）・`0002`（arms は計画でソフト・Boil_Sync でハード）・`0003`（Timer が卓を持つ）。判断の「なぜ」はそちらが正本。
- `.kiro/steering/design-philosophy.md`。とくに「導出値を状態に昇格させない」「計算と作用の分離」「重複の根絶」。
- `online-cook-scheduling/design.md`。本 spec はその計画側の改訂であり、そこで確立した形（`PlanSlice`・解放表・接頭辞採用・2 段のゲート）を壊さずに内側を替える。

## Overview

### 動機

計画は「同じ卓の麺を同時に上げる」を語れない。三つの欠けが同時にある。目的関数は卓の最大差の許容超過しか見ないので 3 本目以降を揃える得が無く（観測事実 4）、走行中の Timer は卓を知らないので群の錨になれず（観測事実 3）、`slotSpan` は割当が読まないので大盛が 1 釜で計画される（観測事実 8）。

### 何を変えるか（要点）

1. **卓同期の項を Table_Lag の和にし、走行中 Timer を動かせない成員として同じ和に入れる**（判断 5）。これで「全員を Group_Anchor に揃える」が目的関数の唯一の最適点になり、自前解と外部解が同じ物差しに乗る。
2. **走行中 Timer が卓の事実を持つ**（判断 6）。群の 1 本目を入れた後も、残りが 1 本目に揃う。
3. **`slotSpan` 個の釜を割り当てる**（判断 11）。釜容量は本数ではなく `slotSpan` の合計で数える。
4. **`arms` 超過をソフト制約として加える**。重みは `max(0, tableSyncWeight − 1)` の導出値で、設定も定数も足さない（判断 8・9）。
5. **`score` を計画の型から落とす**（判断 7）。採点は比較の時点だけの導出になり、配置（`baselineSchedule` / `committedSchedule`）と採点（`admit`）が分離する。
6. **要求の入力を engine 側へ一元化する**。`RequestPlan` が `noodlePresets` を運び、shell は Effect の写しを送るだけになる。

### 変えないもの

Boil_Sync（`sync.ts` / `settle.ts` の同期）・client ワイヤ 4 種・`recommend` の形・`hasLapsedStart`・`StoreConfig` の項目と妥当域・開始時の `slotSpan` 非検査・Alarm の規律。Requirement 6 の 8 項がそのまま不変点である。

`chooseSlots` の**中身も変えない**。第一基準が既に「count 本すべてが空く最早時刻の最小化」で、距離は同点の解消にしか効かない（AC 4.3 が要求する順序そのもの）。変わるのは渡す count が `batch.length` から `Σ slotSpan` になることだけである。

## Architecture

### 触る層と触らない層

| 層 | ファイル | 変更 |
| --- | --- | --- |
| domain | `store.ts` / `order.ts` / `messages.ts` / `wire.ts` | **無し**（項目も妥当域も変えない） |
| engine（射影） | `project.ts` | `tableMembers` を足す（走行中 → 卓ごとの提供時刻） |
| engine（採点） | `objective.ts` | 卓同期項の入れ替え・`armsOverflow` の追加・`ScheduleParams.arms`・署名に成員表 |
| engine（配置） | `schedule.ts` | 錨へ揃える `placeBatch`・`slotSpan` の割当と batch 分割・`score` の撤去 |
| engine（合成） | `commit.ts` | 採点を呼ばない |
| engine（ゲート） | `admit.ts` | 再採点で比較・`slotSpan` の feasibility |
| engine（後処理） | `settle.ts` / `digest.ts` | 等価判定から `score` を外す・指紋に `arms` と `slotSpan` |
| engine（状態） | `timer.ts` / `start.ts` | `orderItem` が卓を宿す |
| engine（永続） | `types.ts` / `snapshot.ts` / `migrate.ts` | v10（`tableId` の追加・`score` の除去） |
| engine（作用） | `effect.ts` | `RequestPlan.noodlePresets` |
| shell | `store-timer-do.ts` | `scheduleParams` に `arms` を含める・`requestPlan` は Effect の写しを送る |
| solver | `index.ts` | `baselineSchedule` の新しい署名に合わせる（`request.ts` は不変） |
| client | — | **無し** |

client が変わらないのは、群の識別が `startAt + 茹で秒` の等号でクライアント側に再計算されるためである（判断 12・ADR 0004）。

### 卓の成員が流れる道

```
running: Timer[]  ──┬─→ initialRelease(running, now, slotCount) ─→ SlotRelease
                    │        「その釜がいつ空くか」
                    └─→ tableMembers(running) ─────────────────→ TableMembers
                             「その卓がいつ上がるか」
                                    │
        ┌───────────────────────────┴───────────────────────────┐
        ↓                                                       ↓
  baselineSchedule(…, members, …)                     scoreSchedule(…, members, …)
  Group_Anchor = max(members[key] ∪ earliest)          Table_Lag / Arms_Overflow の成員
```

**解放表と同じ資格の第二の表を立てる。** `baselineSchedule` が `running` ではなく `SlotRelease` を受けるのは、「過去に開始しない」という事実の置き場所を表ひとつに定めるためだった（既存の注記）。卓の錨も同じ形にする——走行中 Timer から射影した表を渡し、配置と採点は表だけを読む。射影が一箇所なら、実効 endTime（`adjustedEndTime`）を二度書く余地が消える。

## Components and Interfaces

### Component 1: `project.ts` — 走行中から卓ごとの提供時刻へ

```ts
/** 卓ごとの走行中の仲間の提供時刻（実効 endTime）。鍵は tableId。値は昇順・非空。 */
export type TableMembers = ReadonlyMap<string, NonEmptyArray<EpochMillis>>;

export function tableMembers(running: readonly Timer[]): TableMembers;
```

置き場所は `project.ts` である。これは「走行中 Timer から、他が読める形へ落とす射影」であり、実効 endTime の唯一の出所（`adjustedEndTime`）と同じファイルに在るべきである——別のファイルに置けば、`endTime + adjustment` を二度書くか、射影のために `project.ts` を経由する遠回りが生まれる。`objective.ts` が要るのは型 `TableMembers` だけなので（表は呼び出し側が作る）、どこに置いても型 import で足りる。

**`tableId` が `null` の Timer は表に現れない。** 卓を持たない Timer はどの鍵にも属さないので、成員の照合（`slice.tableKey === tableId`）は分岐なしに AC 2.1 の後半を満たす。単独キー（`\u0000{externalOrderId}\u0000{itemIndex}`）は NUL で始まり、`tableId` は非空文字列（`domain/order.ts` が保証）なので、両者は決して一致しない——**「卓なし同士を束ねない」は文字列の一致という一つの規則から従い、除外の条件を書く必要がない。**

値を昇順に並べるのは決定性のためである（`Map` の走査順は挿入順＝`running` の並びに依存し、`running` の並びは状態の履歴に依存する）。錨は最大値ひとつだが、採点は各成員の遅れを足すので列の全体が要る。

### Component 2: `objective.ts` — 卓の成員を採点する

#### 署名

```ts
export function scoreSchedule(
  slices: readonly PlanSlice[],
  pending: readonly PendingOrder[],
  members: TableMembers,
  params: ScheduleParams,
): ScheduleScore;
```

`Omit<PlanSlice, "score">` が消える（`PlanSlice` が `score` を持たなくなるため）。第 3 引数は `running: Timer[]` ではなく射影表を採る——`baselineSchedule` が `SlotRelease` を採るのと同じ判断で、`admit` が 3 回採点しても射影は 1 回で済む。

#### 一片の部分和

```ts
function scoreSlice(placements, arrivals, memberEnds: readonly EpochMillis[], params): number {
  const serveTimes = [...placements.map((p) => p.serveAt), ...memberEnds];
  return (
    waitSeconds(placements, arrivals) +
    params.tableSyncWeight * tableLagSeconds(serveTimes) +
    armsOverflowWeight(params) * armsOverflow(serveTimes, params.arms) +
    params.orderSyncWeight * orderExcessSeconds(placements, params.orderSyncToleranceSeconds) +
    params.affinityWeight * affinityExcess(placements, params)
  );
}
```

- **`tableLagSeconds(serveTimes)`** = `Σ ceilSeconds(max(serveTimes) − t)`。空列は 0。**切り上げである**（`waitSeconds` の切り捨てとは規則を分ける・次節）。
- **`armsOverflow(serveTimes, arms)`** = 同じ `serveAt` を持つ成員を束ね、`Σ max(0, 本数 − arms)`。
- **`armsOverflowWeight(params)`** = `max(0, params.tableSyncWeight − 1)`。定数を置かず `params` から導く（判断 8）。
- `serveSpread` / `excessSeconds` は**オーダー同期の項が使い続ける**ので残す。卓同期だけが使わなくなる。
- `waitSeconds` は `placements` だけを見る。走行中の成員は `Wait_Time` に寄与しない（Placement ではなく、その待ちは既に実現済み）。AC 2.5 の「定義を変えない」はこの非対称のことである。

`adjustedEndTime` を `objective.ts` が呼ぶことはない——成員の提供時刻は表から届く。

#### 卓同期項だけ秒へ切り上げる

**単位を落とす規則を 2 つ持つ。** `waitSeconds` と `orderExcessSeconds` は切り捨て（既存の `toWholeSeconds`）、`tableLagSeconds` は切り上げ（`ceilSeconds`）である。規則を揃える方が一見きれいだが、揃えると**1 ミリ秒ずらした外部計画が採用される**。

揃った計画の 1 本を 1 ms だけ早めた計画を考える。`serveAt − arrivalTime` がちょうど秒の倍数だった品目では `waitSeconds` の切り捨てが 1 減る。一方 lag は切り捨てなら `floor(1 ms) = 0` で増えない。差し引き −1 点で「真に良い」ので、Acceptance_Gate の (d) と段 2 を通る。採用された計画は 1 ms だけ揃っておらず、client は `startAt + 茹で秒` の**等号**で群を組む（判断 12）ので、**この 1 ms で群が割れる**。目的関数が守るべき一致を、単位の丸めが破る。

切り上げなら任意の Δ > 0 で損か同値になり、真に良くなることはない。ずらしで節約できる wait は最大 `ceil(Δ / 1000)` 秒、lag の増分は `w_table × ceil(Δ / 1000)` 秒で、`w_table ≥ 2` ゆえ差し引きは `(w_table − 1) × ceil(Δ / 1000) ≥ 1` 以上の損である。**例外は Arms_Overflow が立っている一片**——1 本を外すと同じ `serveAt` の本数が 1 減り、超過項が `w_table − 1` 減るので、Δ が 1 秒以内なら差し引きがちょうど 0 になりうる（同値は棄却される）。超過が無ければ真に損である（実装で確認・Property 2 の反例から得た）。群全体を Δ 遅らせる方向も、wait が増えて lag が減らないので損（1 ms なら同値になりうるが、**同値は棄却される**ので採用されない）。

規則が 2 つあることの正当性は役割の違いにある。wait は**水準**（どれだけ待ったか）で、秒未満は人の知覚の粒度に無いから切り捨てる。lag は**逸脱の罰**で、ゼロでない差はすべて 1 秒以上として計上されなければ「ずらす得」が残る。差がちょうど 0 のときだけ 0 になることは切り上げでも保たれる（Property 9 の下限 0 は破れない）。

全項をミリ秒で計算する案は採らない。釜距離項（無単位の 10 / 14 / 24）と桁が 3 つずれ、`w_affinity` の校正が意味を失う（`MILLIS_PER_SECOND` の既存注記と同じ理由）。

#### `ScheduleParams` に `arms` を足す

```ts
export interface ScheduleParams {
  readonly orderSyncWeight: number;
  readonly tableSyncWeight: number;
  readonly affinityWeight: number;
  readonly arms: number;                      // ← 追加
  readonly orderSyncToleranceSeconds: number;
  readonly tableSyncToleranceSeconds: number; // ← engine の読み手が 0 になる（撤去候補）
  readonly affinityToleranceDistance: number;
  readonly unitOrigins: readonly UnitOrigin[];
  readonly slotOffsets: SlotOffsets;
}
```

`arms` をここに置くのは、値の意味を定めるのが目的関数の側だからである（`SyncParams` も `arms` を持つが、`SettleParams` が両者を継承するので実体は 1 つで足りる）。「ちょうど 8 値」という説明は 9 値へ書き換える。

**`tableSyncToleranceSeconds` は残るが誰も読まなくなる。** 型に残すのは `StoreConfig` の項目を増減しないという判断 15 の帰結である。doc に「本項目を読む計算は無い（撤去候補・`online-cook-scheduling` の design に記録）」と明記する——書かなければ、読み手はこの値の使い所を探して見つけられない。

### Component 3: `schedule.ts` — 錨へ揃え、`slotSpan` 個の釜を占める

#### 型から `score` が消える

```ts
export interface PlanSlice {
  readonly tableKey: string;
  readonly placements: readonly Placement[];
}
export interface CookSchedule {
  readonly slices: readonly PlanSlice[];
}
export interface AcceptedSlice extends PlanSlice {}
```

`AcceptedSlice` は形が `PlanSlice` と同一になるが、名は分けたままにする。「計算の産物」と「この店が採用したという再現不能な事実」は概念が違い、状態のフィールド（`acceptedSlices`）が何を保持しているかを型が語る必要がある（既存の注記がそのまま生きる）。

`CookSchedule` が `slices` 一つだけになるので、`toCookSchedule` の `score` 検証も消える。**外部が `score` を添えて送ってきても読まない**（AC 5.6）。読まない値を検証すれば、検証だけが理由で計画が棄却されうる。

#### 署名

```ts
export function baselineSchedule(
  pending: readonly PendingOrder[],
  release: SlotRelease,
  members: TableMembers,
  presets: readonly NoodlePreset[],
  params: ScheduleParams,
): CookSchedule;
```

`scoreSchedule` を呼ばない。採点は比較の時点の関心事であり、配置の関心事ではない（判断 7）。この関数から採点が消えることで、`baselineSchedule` は「配置を決める」だけの関数になる。

#### `placeGroup` — 容量は `slotSpan` の合計

現在の `batches = ceil(boilings.length / capacity)` は「1 品目 1 釜」を前提にした算術で、`slotSpan` の下では成り立たない。正準順序のまま貪欲に詰める形へ替える。

```
placeGroup(items, release, members, presets, params):
  boilings = items で茹で時間が引けるものだけ（引けない品目は置かない・既存の規律）
  capacity = release.length
  free = release
  batch = [], span = 0
  for b in boilings:                      # 正準順序（計画対象の並び）を保つ
    if span + b.slotSpan > capacity:      # 入らないので現 batch を閉じる
      placed = placeBatch(batch, free, anchorOf(members, tableKey), params)
      free = advanceRelease(free, placed); 収集; batch = [], span = 0
    batch.push(b); span += b.slotSpan
  最後の batch を同様に置く
```

`slotSpan ≤ SLOT_SPAN_MAX = SLOTS_PER_UNIT = 6 ≤ capacity`（`UNIT_COUNT_MIN = 1`）なので、**1 品目が単独で容量を超えることは構造上ありえない**。「置けない品目」の分岐を書かない根拠はここにある（起こり得ないものに防御を置かない）。

#### `placeGroup` の前段 — 走行中の仲間が在る卓は、合流できる品目で最初の batch を組む（判断 16・ADR-0007）

上の詰め方は容量を `release.length`（釜の総数）で数えるため、走行中が占めている釜まで容量に入る。群の 1 本目を始めた直後、残りが「Σ slotSpan ≤ 容量」で一つの batch に入り、走行中の釜が空くまで**全員が**錨ごと後ろへずれる（6 釜・同卓 4 品・各 2 釜・茹で 6 分：開始前は 3 品が今、1 本を始めると残り 3 品が 6 分後）。始めたまとまりを後続品のために崩している。

規則は**走行中の仲間が在る卓に限って**足す。走行中が無い卓は上の詰め方のまま（待つことも含めてまとめる・AC 1.8）。

```
placeGroup(items, release, runningAnchor, presets, params):
  boilings = 茹で時間が引ける品目（正準順序）
  free = release
  if runningAnchor !== null:
    joined = joinable(boilings, free, runningAnchor, params)
    if joined が非空:
      placed = placeBatch(joined, free, runningAnchor, params)   # 錨 = runningAnchor（下記）
      free = advanceRelease(free, placed); 収集
      boilings = boilings から joined を除く（正準順序を保つ）
  残りは上の詰め方（容量で貪欲に batch へ・錨は max(earliest, runningAnchor)）

joinable(boilings, free, anchor, params):
  joined = []
  for b in boilings:                                   # 正準順序
    if fits([...joined, b], free, anchor, params): joined.push(b)
  return joined

fits(candidate, free, anchor, params):
  totalSpan = Σ span;  if totalSpan > free.length: return false
  slotsOf = placeBatch と同じ対応づけ（chooseSlots → byRelease 昇順 → byBoil 降順で連続 span 個）
  return ∀ i: max(free[s] for s in slotsOf[i]) ≤ anchor − boilMillis_i
```

- **合流の判定は投入時刻で閉じる。** 「いま空いている釜」ではなく、`slotSpan` 個すべてが `anchor − boil_i`（逆算した投入時刻）までに空くか。錨 510 秒・茹で 330 秒なら 30 秒後に空く釜でも 180 秒に投入でき、合流できる（AC 1.9）。時間の許容幅は置かない。
- **`placeBatch(joined, free, runningAnchor)` の錨は `runningAnchor` になる。** `fits` が placeBatch と同じ対応づけで `earliest_i ≤ anchor` を確かめているので、`max(max(earliest), runningAnchor) = runningAnchor`。合流した品目は走行中と同じ `serveAt` を持つ（AC 1.4 の走行中版）。
- **3 つの場合。** (a) 全釜使用中——解放表だけが語る。投入時刻までに空く釜が `slotSpan` 個あれば合流する。(b) 茹で時間が混在——判定は品目ごとの投入時刻 `anchor − boil_i` で行い、対応づけは長い茹でに早く空く釜を与える。錨までの残りより茹で時間が長い品目（`anchor − boil_i < now`）は解放表の下限が now ゆえ合流できず、残りへ回る。(c) 1 品が複数釜——`slotSpan` 個の相異なる釜すべてが投入時刻までに空くこと。連続 span 個の対応づけで最後（最も遅く空く）の釜が判定を決める。
- **誰も合流できなければ残りは従来どおり**（AC 1.10）。走行中が boiled だけで錨が過去なら `anchor − boil_i < now` で全員が外れ、既存の `max(earliest, runningAnchor)` に落ちる（ADR-0003「錨は過去へ落ちない」と整合）。
- **貪欲は正準順序で、合流の本数を最大化しない。** 先の品目が合流を確定させると後の品目の釜が減る。最適な部分集合の選択は外部ソルバの役目で、自前解に要求するのは決定性（正準順序と placeBatch の全順序から従う）だけ。
- **採点は変えない。ゲートにはハード制約 (e) を足す。** 当初「採点もゲートも変えない」と書いたが、レビューの実測で全員を後ろへずらす配置の方が目的関数の上で真に良い（合流 4597 対 全員遅延 2887——合流分の遅れが最遅参照で全員に乗る）と分かった。ソフトのままでは外部解がその形で自前解を上書きするので、「始めたまとまりを崩す計画は成立していない」を feasibility に置く（`isPushedOut`・Component 4）。自前解は構成から満たす（Property 17）。

#### `placeBatch` — 錨へ一致させる

許容幅の床（`tableFloor` / `orderFloor`）を撤去し、錨ひとつへ置き換える。**引き算だけで済む。**

```
placeBatch(batch, release, runningAnchor: EpochMillis | null, params):
  totalSpan = Σ b.slotSpan
  slots = chooseSlots(totalSpan, release, params)          # 既存関数・count が変わるだけ
  byRelease = slots を (release[s], s) 昇順
  byBoil    = batch の index を (boilMillis 降順, index 昇順)
  cursor = 0
  for i in byBoil:                                        # 長い茹でに早く空く釜を与える
    slotsOf[i] = byRelease[cursor .. cursor + span_i)
    cursor += span_i
  earliest[i] = max(release[s] for s in slotsOf[i]) + boilMillis_i
  anchor = max(max(earliest), runningAnchor ?? −∞)         # = Group_Anchor
  for i: serveAt_i = anchor, startAt_i = anchor − boilMillis_i, slotIds_i = slotsOf[i]
```

**下限のクランプが要らないことは変わらない。** `anchor ≥ earliest_i = max(release of slotsOf[i]) + boil_i` ゆえ `startAt_i = anchor − boil_i ≥ max(release of slotsOf[i])`。割り当てた全釜について成り立つので、ハード制約違反の配置は構成から作れない。

**長い茹で → 早く空く釜の対応づけは決定的である。** 1 品目 1 釜のときはこれが錨（`max(earliest)`）を最小にする対応づけだったが、`slotSpan` が混在すると最小性は言えない——`span = 2` の品目が `byRelease` の連続 2 釜を取るため、短い茹でに早い釜を与えた方が錨が小さくなる配置が原理的にありうる。ここは貪欲法の内側であり、厳密最適の供給は外部ソルバの役目である（`chooseSlots` の既存注記と同じ立場）。要求するのは**決定性**（同じ入力から同じ対応づけ）だけで、それは `byRelease` / `byBoil` の全順序（同点を index で断つ）から従う。

`runningAnchor` は `members.get(tableKey)` の最大値（無ければ `null`）。**batch ごとに錨を取り直す**（AC 1.5）——batch 2 の `earliest` は進めた解放表から出るので、群全体の錨を使い回せば AC 1.4 が成り立たない。走行中の錨は卓の事実なのでどの batch にも同じ値が入るが、`max` の中で `earliest` に負けるだけで害はない。


#### 判断 18・19 の改訂（実装で確定・2026-09-05）

- **`ScheduleParams.toleranceRatio`** を足し、合流の窓 `joinWindowMillis(boil, params) = floor(boil × toleranceRatio / 100)` を `schedule.ts` に置く。指紋（`digest.ts`）に畳む。`RequestPlan` の `params` は SettleParams をそのまま載せるので追加の配線は無い。
- `placeGroup(items, release, siblings, presets, params)`——`runningAnchor` の代わりに同じ卓の走行中の提供時刻の列（`tableMembers` の値・昇順）を受ける。`joinable` / `fits` は `catchable(earliest, siblings, boil, params)`（`A ≥ earliest − h_i` を満たす最早の A）で合流の可否を判定し、`placeJoined` は `joinedServeAt`——いずれかの A が `|earliest − A| ≤ h_i` なら **earliest**、無ければ earliest より後の最早の A——に置く。残りの batch は従来どおり `placeBatch(…, max(siblings))`。**21.6 で改訂**：`joinable` は増分——品目ごとに `joinTarget`（非 null＝いずれかの A に h_i で届く）で判定し、確定した品目の釜を取り置いて次を単独で判定する（`fits` / `catchable` は撤去）。対応づけは `placeJoined` がそのまま置き、判定は置いた後の解放表で繰り返す（Component 10 の注記）。
- `keepsAnchor(placements, release, lifts, siblings, targets, presets, params)`：**21.6 で改訂**——配置を単位（`anchor` 付きは同じ anchor・同じ serveAt の pack、無しは 1 品）にまとめ、pack を (serveAt, startAt, 代表釜) 順に解放表と上げ表へ載せながら (a) 錨は現在の仲間に在る（21.4 のレビュー追記で先に据えた・仲間が無い卓では `anchor` を持てない）(b) 手前に散らさない (c) 集合として合流できた (d) serveAt が候補の最大から pack 全体の span で firstFit した時刻に一致、を検査し、その後 1 品の配置を同じ順に載せながら押し出し（`isPushedOut`——置いた後の表で合流できた品目が候補時刻からの firstFit より後ろ）を検査する（Component 10「(e) の契約」）。加えてどの配置も走行中の最早より h_i を超えて手前に散らさない。`joinedAnchor` の h_i 推定は撤去。
- `boilMillisOf` を `schedule.ts` から export し、admit.ts の重複を消した。
- `recommend(committed, pending, running, presets, params)`：配置ごとに `joinedAnchor` を引き、`group = joined ? \`${slice}:anchor:${A}\` : \`${slice}:${serveAt}\``、`anchor = A | null`。**21.4 で改訂**：`recommend(committed)` は `Placement.anchor` を運ぶだけで、`joinedAnchor` の推定は撤去（Component 10「`Placement.anchor`」）。引数の待ち行列・走行中・プリセット・採点パラメータは推定のためだけに要したので消える。
- 検証：`tests/core/continuous-input.example.test.ts`（arms 1〜3 × 間隔 0 / 1 / 3 / 5 秒・6 本を順に投入し、各投入の直後に空いている釜の残りがすべて `anchor` 非 null で `startAt ≤ now`、いま押せる推奨が使わない空き釜に後ろへ置かれた品目が無い）。Property 1 は「最早の走行中 − h_i より手前に散らさない・最遅 + h_i より後ろは一つに揃う」へ。`digest.example` は toleranceRatio が指紋を変える形へ。

### Component 4: `admit.ts` — 再採点で比べ、`slotSpan` を見る

#### 採点は 2 つの計画に対して 3 回

```ts
const members = tableMembers(running);
const arrivedScores  = scoreSchedule(arrived.slices,  pending, members, params).bySlice;
const committedScore = scoreSchedule(committed.slices, pending, members, params);   // bySlice と total
// 段 1 (d): arrivedScores[index] < committedScore.bySlice[tableKey に対応する index]
// 段 2   : scoreSchedule(composed.slices, pending, members, params).total < committedScore.total
```

**基準は Committed_Plan のままである**（AC 5.4）。変わったのは、比較の右辺が永続値ではなく「比較の時点の `running` で採点し直した値」になったことだけ。冒頭の 2 段の説明（`admit.ts:9-12`）を、対応部分和・合成後総和の**再採点**として書き換える。

対応部分和を `tableKey` で引く形は変えない（外部計画の一片の並びは Committed_Plan の並びと無関係・既存の注記）。

#### feasibility に `slotSpan` を足す

`feasibleRelease` は既に配置ごとに品目を引いている（`boilMillisOf`）。品目を 1 回引いて 2 つを見る形へ整える。

```
for placement in 開始時刻昇順:
  order = targets の中の当該品目             # 無ければ null（既存の落とし方）
  if placement.serveAt − placement.startAt ≠ 茹で時間(order) → null
  if placement.slotIds.length ≠ order.slotSpan → null                  # AC 4.2
  if placement.slotIds に重複がある → null                              # 下記
  各 slotId について 表の内側かつ startAt ≥ 解放時刻 → さもなくば null
```

**`slotIds` の相異性を見る。** `slotSpan = 2` を `["3","3"]` で満たす外部計画は、本数だけの検査を通り抜けて 1 釜しか占めない。`advanceRelease` は重複を吸収するので、この嘘は解放表にも現れない。`slotSpan` を本数で数える設計（AC 4.5）が新しく開けた穴なので、同じ場所で閉じる。1 品目 1 釜の現行では起こり得なかった検査である。

### Component 5: `commit.ts` — 採点を呼ばない合成

`committedSchedule` から `scoreSchedule` の呼び出しと `score` の埋め込みが消える。`running` は既に受けているので、`initialRelease` と並べて `tableMembers` を導き、`baselineSchedule` へ渡す。

```ts
const release = initialRelease(running, now, params.unitOrigins.length * SLOTS_PER_UNIT);
const members = tableMembers(running);
...
const tail = baselineSchedule(remaining, release, members, presets, params);
return { slices: [...prefix, ...tail.slices] };
```

「採点は接頭辞を含めてやり直す」という既存の注記は、**採点そのものがこの関数から出ていく**ことで不要になる（外部が主張した部分和を総和へ流す危険は、`score` が型から消えたことで構造的に消滅する）。尾部を再実行する規律は変えない。

### Component 6: `settle.ts` / `digest.ts`

- `isSameSlice` から `left.score === right.score` を落とす。placements と `tableKey` の比較で足りる。**重みだけが変わった遷移で空振りの Persist が出なくなる**（配置が同じなら確定結果は同じ）という副産物があり、AC 7.6 の方向に沿う。
- `digestInput` に 2 行足す。計画対象のループに `fold(order.slotSpan)`、パラメータ列に `fold(params.arms)`。
- `digest.ts:39` の「Pending_Order は全フィールドを含める」は、`slotSpan` を畳んだ後も `itemName` / `sizeName` を落とすので**実装に合わせて書き換える**（「計画に効くフィールドを含める。表示だけに効く申告名は含めない——変わっても計画は変わらない」）。
- `digest.ts:55` は「`arms` は畳む（計画が Arms_Overflow で読む）。`toleranceRatio` は畳まない（計画へ届く経路は走行中の実効 endTime ただ一つで、それは既に畳んである）」へ分ける。
- `digest.ts:23` の `PlanSlice.score` / `CookSchedule.score` の列挙から両者を外す（ブランドの理由自体は `adjustment` で立つ）。

### Component 7: `timer.ts` / `start.ts` — 卓は `orderItem` の内側に宿る

```ts
export interface Ordered {
  /** 由来する注文品目への参照。null はアドホック麺茹で（POS を経ない開始）。 */
  readonly orderItem: {
    readonly externalOrderId: string;
    readonly itemIndex: number;
    /** 由来する卓。null は卓を持たない品目。 */
    readonly tableId: string | null;
  } | null;
}
```

**`Timer` の直下に `tableId` を置かない。** 直下なら `(orderItem = null, tableId = "T1")`——POS を経ていないのに卓を知っている Timer——が型として構築できてしまう。卓はオーダーの事実であり、オーダーの参照の内側にあれば、その状態は**表現不能**になる（「バリデーションで弾くより、構築不能にする方が真である」）。要件 AC 3.1 の表記との差は naming ゲートで確認する。

`startOrderItemTimer` は既に当該 `PendingOrder` を引いているので、写すだけである。

```ts
orderItem: { externalOrderId: args.externalOrderId, itemIndex: args.itemIndex, tableId: item.tableId },
```

`startTimer`（アドホック）は `orderItem: null` のまま。`Ordered` の doc の「用途は開始済み品目の同定ひとつ」は、卓の同定が二つ目の用途として加わるので書き換える。

### Component 8: 永続 v10（`types.ts` / `snapshot.ts` / `migrate.ts`）

`CURRENT_SCHEMA_VERSION = 10`。移行は**二方向**である。

| 対象 | v9 の形 | v10 での扱い |
| --- | --- | --- |
| `Timer.orderItem` | `{ externalOrderId, itemIndex }` | `tableId: null` を補う（追加） |
| `Timer.orderItem.tableId` | 非空文字列 / 欠如 / 壊れた値 | そのまま / `null` / `null` へ畳む |
| `AcceptedSlice.score` | 整数（必ず在る） | 読まずに捨てる（除去） |

- `reviveOrderItem` は `tableId` を読み、非空文字列ならその値、欠如・`null`・壊れた値は `null` へ畳む。**`tableId` だけが壊れていても `orderItem` 全体を捨てない**——`orderItem` を失うと二重調理の防止が効かなくなるが、`tableId` を失うのは「その卓の同期が 1 回崩れる」だけである。既存の「壊れた紐づけは移行失敗にしない」規律の内側で、代償の軽い方に畳む。
- `reviveAcceptedSlice` から `score` の整数性検査を外す。**外し忘れると v10 の永続データが読めない**（v10 は `score` を書かないので、検査が残っていれば全 `AcceptedSlice` が `null` へ落ち、移行失敗＝店舗が起動しない）。Property 6 がこの失敗を捕る。
- `snapshot.ts:21` の「現行は v8」を v10 へ直す。

### Component 9: `effect.ts` / shell / solver — 要求の入力を一箇所にする

```ts
| {
    readonly type: "RequestPlan";
    readonly pending: readonly PendingOrder[];
    readonly running: readonly Timer[];
    readonly params: ScheduleParams;              // 重み 3・arms 1・許容幅 2・距離 1・レイアウト 2 の 9 値
    readonly noodlePresets: readonly NoodlePreset[];  // ← 追加
    readonly digest: InputDigest;
  }
```

往路の契約（`solver/request.ts` の `PlanRequest`）は**既に** `noodlePresets` を運んでおり、shell が在メモリの投影から添えている。欠けているのは Effect の側で、その帰結として**同じ要求の入力が二箇所（engine が決めた `params` と shell が持つプリセット）から来ている**。Effect が運べば、要求の内容は engine の決定として一箇所に定まり、`requestPlan` は Effect と `storeId` の写しになる。

- `settle.ts` の `requestPlan` は `params.noodlePresets` を載せる（`SettleParams` が既に持っている）。
- shell の `requestPlan` は `noodlePresets: effect.noodlePresets` に替える。`this.noodlePresets` は他の用途（取り込み・config 配信）で残る。
- shell の `scheduleParams` 束に `arms` を含め、`private arms` フィールドを廃す。`SettleParams` は `SyncParams` と `ScheduleParams` の両方を継承するので、`arms` の実体は 1 つで足りる。**同じ値の置き場を二つ持たない。** 移す箇所は 3 つ——`:635` の投影反映（`this.arms = config.arms` → `scheduleParams` の更新へ畳む）、`:667` と `:683` の config メッセージ（broadcast と hydration の 2 経路・`arms: this.scheduleParams.arms`）。config ワイヤの形は変わらない（既に `arms` を運んでいる）。
- `solver/index.ts:113` は新しい署名に合わせる。`PlanRequest` は `running` を運んでいるので、solver 側でも `initialRelease` と `tableMembers` の 2 表を作れる。`request.ts` は変更なし。

### Component 10: 上げ窓（Lift_Window）——判断 20・ADR-0009（レビュー 6 件を契約に反映・2026-09-06）

走行中の状況を「いつ上がるか」として計画に入れる。釜の解放表（`initialRelease`）・卓の成員表（`tableMembers`）と同じ資格の第三の表で、状態ではなく毎回導く。

```ts
// src/domain/store.ts
export const LIFT_INTERVAL_SECONDS_MIN = 5;
export const LIFT_INTERVAL_SECONDS_MAX = 120;
export const DEFAULT_LIFT_INTERVAL_SECONDS = 45;   // store DO は投影 config に無ければこれを採る
export const HELPER_ARMS = 2;                        // 手伝いで増える腕（物理的に 1 人）。設定にしない
export function toLiftIntervalSeconds(raw: unknown): number;   // 妥当域外・非整数・欠如 → 既定
// StoreConfig.liftIntervalSeconds: number
// src/engine/objective.ts — ScheduleParams.liftIntervalSeconds（採点と配置の両方が読む）

// src/engine/lift.ts（新規）
export interface Lift { readonly at: EpochMillis; readonly span: number }
export type LiftTable = readonly Lift[];                                   // at 昇順
export function initialLifts(running: readonly Timer[]): LiftTable;         // boiled（過去の時刻）も入れる
export function advanceLifts(lifts: LiftTable, added: readonly Lift[]): LiftTable;
/** t に span 本を足したとき、t を含む半開窓 [x, x + L) の負荷の最大。 */
export function loadWith(lifts: LiftTable, t: EpochMillis, span: number, params): number;
/** t 以降で loadWith ≤ arms + HELPER_ARMS となる最小の時刻。span > arms + HELPER_ARMS なら null。 */
export function firstFit(lifts: LiftTable, t: EpochMillis, span: number, params): EpochMillis | null;
/** 目的関数の Lift_Overflow（一意な貪欲の割当・下記）。 */
export function liftOverflow(lifts: LiftTable, params): number;
```

**窓の数え方（AC 9.3・レビュー 3）。** 窓は**半開区間** `[x, x + L)`。t を含む窓は `x ∈ (t − L, t]` で、負荷が極大になる起点は `{ e.at : t − L < e.at ≤ t }`（既存の上がり時刻）と `t` 自身だけなので、`loadWith` はその有限個を見る。ちょうど L 離れた 2 つの上がりは同じ窓に入らない（45 秒間隔を許す）。

**`firstFit` の停止性（レビュー 3・6）。** span > arms + HELPER_ARMS なら null（AC 9.12・いつまで待っても入らない）。それ以外は t から始め、`loadWith(t) > cap` なら「t を含む過負荷の窓のうち最早の起点の上がり時刻 e」について t ← e + L（半開ゆえ e はもう t を含む窓に入らない）を繰り返す。各反復で表の要素を一つ以上「t より L 以上手前」へ追い越すので、表が有限なら止まる。結果は t 以上で条件を満たす最小の時刻である（性質・`lift.property`）。

**含む窓だけを見る（AC 9.4・9.5・9.14・レビュー 2）。** 上限の検査は常に「新しい配置（または当該一片の配置）を**含む**窓」に限る。走行中だけ・過去の boiled だけで既に超えている窓は開始後の事実で、無関係な配置を落とす理由にならない。`exceedsLiftCap(表全体)` は置かない——ゲートも合成も、当該配置を足したときの `loadWith` で見る。

**Lift_Overflow の一意な定義（AC 9.6・レビュー 4）。** 上がる時刻を昇順に走査し、未割当の最早の時刻 e を起点に窓 `[e, e + L)` の負荷を取り、`max(0, 負荷 − arms)` を足して窓の内側を割当済みにする。重なる窓を二度数えない。Boil_Sync のセット分割と同じ「前から詰める」形で、外部ソルバも同じ式で再現できる。重みは L 秒/本（新しい重みを足さない）。

```
liftOverflow(lifts, L, arms):
  i = 0, total = 0
  while i < lifts.length:
    e = lifts[i].at; j = i; load = 0
    while j < lifts.length && lifts[j].at < e + L: load += lifts[j].span; j++
    total += max(0, load − arms); i = j
  return total × L(秒)
```

例：arms 2・L 45。上がり {60:2 本, 63:2 本, 105:2 本} → 窓 [60,105) 負荷 4 → 超過 2、次の窓 [105,150) 負荷 2 → 超過 0。合計 2 × 45 = 90。

**採点（`scoreSchedule`・AC 9.7）。** 店舗全体の項なので卓の内側に閉じない。**`total` にだけ足し、`bySlice` には入れない**——段 1 の (d) は枝刈り、段 2 の総和比較が単調改善を担う既存の分担（「単調改善は全体判定が担保する」）に乗る。Requirement 2.9 の例外として doc に記す。Arms_Overflow と `armsOverflowWeight` は撤去。

**配置（AC 9.8・レビュー 5）。** 合流の規則（判断 18）で「同じ時刻に上げたい品目の列」（joined の batch、または placeBatch の batch）と候補時刻 t₀ が決まった後：

```
placeWithLifts(batch, t0, release, lifts, siblingsEnds, params):
  # batch の順は配置の対応づけと同じ（茹で時間の長い順・同値は正準順序）。品目は不可分。
  # 1 品で arms + HELPER を超える品目は列に入れない（AC 9.12・toBoiling の隣で落ちている）。
  S = Σ span
  if S > arms + HELPER:
    head = Σ span ≤ arms + HELPER に収まる最長の非空の接頭辞   # 先頭の品目は必ず収まる（AC 9.12）
    return placeWithLifts(head, …) ++ placeWithLifts(残り, その表の上で t0 以降, …)
  pack  = 全員を firstFit(lifts, t0, S) に置く配置
  if S ≤ arms: return pack
  prefix = Σ span ≤ arms に収まる最長の非空の接頭辞
  if prefix が空: return pack                                            # split は候補にならない（例：arms 1 の大盛）
  split = prefix を firstFit(lifts, t0, Σ span(prefix)) に置き、残りをその表の上で再帰した配置
  cost(c) = Σ_i (serve_i − arrival_i)                                   # 待ち（候補を後ろへ動かした分を含む）
          + w_table × Σ_{m ∈ 卓の成員（走行中の仲間を含む）} (max serve − serve_m)   # 卓の遅れ
          + (liftOverflow(lifts + c) − liftOverflow(lifts))              # 手伝いの費用の差分（liftOverflow は秒相当を返す・L を重ねて掛けない）
  return cost(pack) ≤ cost(split) ? pack : split                         # 同点は pack
```

両候補を同じ既存の表に対して**実際に作って**比べる。pack が既存の上がりを避けて 135 秒後ろへ動くなら、その待ちと遅れは cost(pack) に入る。split が既存の走行中と重なれば手伝いの費用は cost(split) に入る。4 人家族（arms 2・L 45・表が空）：pack 90、split 270 → pack。9 本：先頭 4 本の列で pack（90 < 270）、残り 5 本は次の窓で 4 + 1。arms 1 の大盛（span 2 ≤ 上限 3）は split の接頭辞が空なので pack で単独に置く。

**`Placement.anchor`（AC 9.9・9.10・レビュー 1）。** 合流先の走行中の実効 endTime を配置の時点で決めて `Placement` に持ち、窓で `serveAt` が動いても変えない。`recommend` はそれを運ぶ（`joinedAnchor` の ±h_i 推定は撤去）。`AcceptedSlice` も持つので永続 v11（**v10 の一片は推定せず null**——`migrate` は純粋で設定（toleranceRatio・プリセット）を持たず h_i の窓を引けない。所属を失った合流分は合成が 1 品の単位として再検証する。代償は次の再計画まで「開始済み」が失われることで、`docs/persisted-schema-rollback.md` の v11 行に明記。レビュー追記・2026-09-06）。**`anchor` の主張は `recommend` が無条件に運ぶので、検証は `keepsAnchor` ただ一つが担う**——(a)「錨は現在の走行中の仲間の実効 endTime のいずれかに等しい・仲間が無い卓では `anchor` を持てない」は 21.4 の時点で先に据え（21.6 の pack 単位の検査はこれを含む）、ゲートと合成が同じ述語で読む。錨が Boil_Sync で ±h_i の内側に動いた採用済み一片も切られ、自前解が現在の錨で置き直す（錨は等号で運ぶ約束・判断 17）。

**(e) の契約（レビュー 4 回で確定・単位は pack）。** `keepsAnchor` は一片の配置を**単位**にまとめ、単位を一つずつ解放表と上げ表へ載せながら検査する。単位は、`anchor` を持つ配置なら「同じ `anchor`・同じ `serveAt`」の pack、`anchor` を持たない配置なら 1 品。配置は batch 単位で置かれる（`placeWithLifts` は pack 全体の span で `firstFit` する）ので、検証も同じ単位でなければ自前解を拒否する——arms 2・L 45・走行中 3 本が 54・54・66 秒に上がる表で、残り 2 品（候補 60 秒）を pack すると 60 秒の窓負荷が 5 になり両方 99 秒に置かれるが、1 品ずつの firstFit は 60 秒である。

```
release = 一片を置く前の解放表, lifts = 一片を置く前の上げ表
units = anchor 付きは (anchor, serveAt) で pack、anchor 無しは 1 品。並びは (serveAt, startAt, slotOf(slotIds[0])) 昇順
for u in units:
  if u は pack（anchor A・serveAt T・Σ span = S）:
    for p in u:
      boil = boilMillisOf(p の品目), h = joinWindowMillis(boil)
      earliestOwn_p = max(release[s] for s in p.slotIds) + boil        # 手前の単位で進めた表で
      (a) A ∈ siblings
      (b) T ≥ A − h
      (c) earliestOwn_p ≤ A + h                                        # 集合として合流できた
    candidate = max_p joinedServeAt(earliestOwn_p, siblings, boil_p)   # pack はその最遅の候補より前に上がれない
    (d) T === firstFit(lifts, candidate, S)                            # 延期の理由は窓だけ（pack 全体の span で）
  else（1 品 p・anchor 無し）:
    earliestAny = 手前の単位で進めた解放表で span 個の釜が最も早く空く時刻 + boil
    if earliestAny ≤ latest(siblings) + h:                             # 窓を当てる前に合流できた品目だけを保護
      expected = firstFit(lifts, joinedServeAt(earliestAny, siblings, boil), span)
      if p.serveAt > expected: 押し出し（守っていない）
  各配置について loadWith(lifts, serveAt, span) ≤ arms + HELPER でなければ (f)
  release = advanceRelease(release, u); lifts = advanceLifts(lifts, u)
```

- **(c) は集合の検査になる。** 空きが 1 釜だけ・仲間 60 秒で、その釜に Thin を [0,60]・[60,120] と順に置いて両方に `anchor: 60` を付けた計画は、2 つ目の単位の earliestOwn が 120 秒（手前の単位で釜が 60 秒まで埋まる）ゆえ (c) で落ちる。
- **(d) は延期の理由の検査になる。** 仲間 60 秒・残りが Thin 60 秒と茹で 600 秒で、両方を 600 秒に置き Thin に `anchor: 60` を付けた計画は、600 秒の品目が合流不能（anchor を名乗れない）で pack に入らず、Thin だけの pack の firstFit が 60 秒なので落ちる。正当な pack の待ち合わせ（上の 99 秒）は S = 2 で firstFit が 99 秒ゆえ通る。合流できる品目どうしなら、外部解が自前解と違う pack の切り方をしてもよい。
- **押し出しは、窓を当てる前に合流できた品目に限って判定する。** 合流できない品目は保護の対象外なので、仲間 60 秒・残りが茹で 300 秒と 600 秒を後の batch で 600 秒に揃える配置は押し出しではない。窓による必要な延期も押し出しではなく、走行中 4 本が 60 秒に上がる表で残りを 105 秒に置く一片は守っている。
- 自前解は構成からこの契約を満たす——`placeWithLifts` が pack（同じ候補時刻の joined の列）ごとに pack 全体の span で `firstFit` し、split すれば別の pack として順に載る。Property 17 を「一片ごとに `keepsAnchor` が真」のまま保つ。
- **単位の順（実装で確定・レビュー追記 2026-09-06）**：擬似コードは pack と 1 品を serveAt 順に混ぜて載せるが、実装は **pack をすべて載せてから 1 品を載せる**（それぞれ (serveAt, startAt, 代表釜) 順）。自前解は合流の判定を batch より先に、群を置く前の解放表で行い、上げ窓は pack を batch の 1 品より後ろの窓へ動かしうる（釜 0・2 が空き・走行中 3 本が 60 秒に上がり・釜 1 が 40 秒に空く場面で、Thin 2 品の pack は 105 秒、3 品目は 100 秒）。serveAt 順では batch の 1 品が先に載り、pack の釜を「空いていた」と読んで正当な batch を押し出しと判定する。合流分を先に載せる順は判断 16「合流できる品目で最初の batch を組み、残りは進めた表で置く」そのものである。合わせて `joinable` は増分（先に確定した品目の釜を取り置いて次を単独で判定・取り置きは無限大の解放時刻）にし、**置いた後の解放表で合流の判定を繰り返す**——先に合流した短い品目の釜がその上がりで空けば、次の品目がその釜から後の仲間に届く（仲間 66 秒と 170 秒・Thin が上がった釜 0 から Thick が [60,180] で届く）。一度で終えると batch へ回した配置をゲートが押し出しと判定する（Property 17 の実測・40000 例で成立）。

**貪欲採点の近似（レビュー 2 回目の注意・AC 9.15）。** `liftOverflow` の割当は起点を上がり時刻に限る。arms 2・L 45 で {60:1, 104:1, 105:2} は割当 [60,105) / [105,150) で超過 0 だが、窓 [104,149) には 3 本ある。「手伝いが要る窓には必ず費用が付く」定義ではないことを採点の判断として記す。ハード上限（`loadWith`）は t を含むすべての窓を見るので近似ではない。

**ゲート（`feasibleRelease`）。** 解放表と同じく `lifts` を一片ごとに進め、各配置について `loadWith(lifts_so_far, serveAt, span) > arms + HELPER_ARMS` なら feasible と認めない（(f)）。span 単独で超える配置も同じ経路で落ちる。

**合成（`livePrefix`）。** 採用済み一片の配置を `lifts` に載せ、現在の走行中と合わせて当該配置を含む窓が上限を超えれば陳腐化と見なして切る（`keepsAnchor` と同じ位置）。尾部は進めた `lifts` から置く。

**配置不能（AC 9.12・レビュー 6）。** `slotSpan > arms + HELPER_ARMS` の品目は、茹で時間が引けない品目と同じく配置しない（`toBoiling` の隣で落とす）。待ち行列に残り推奨が付かない。ラジアルからは始められる（engine は開始時に占有も上限も検査しない・既存 AC 8.3）。

**指紋・要求・client。** `liftIntervalSeconds` を `digestInput` に畳み、`RequestPlan.params` が運ぶ。外部ソルバの契約に上限・Lift_Overflow の式・`Placement.anchor` の主張を足す。client は読まない（表示は計画の startAt に従う。判断 21 はそのまま）。

## Data Models

### `TableMembers`（新規・`project.ts`）

鍵は `tableId`、値は実効 endTime の昇順非空列。**状態ではない**——`running` からの導出値であり、毎回作って捨てる（`SlotRelease` と同じ扱い）。

### `Placement`（不変）

`slotIds: NonEmptyArray<SlotId>` は既に複数釜を許す形で、`slotSpan` 個が入るようになるだけである。型は変わらない。

### `TimerState`（不変）

フィールドは 6 つのまま。`acceptedSlices` の要素が `score` を失うだけで、状態の構造は変わらない。

### 永続スキーマ v10

上の移行表のとおり。`StoreSnapshot.version` の型は `typeof CURRENT_SCHEMA_VERSION` なので、定数の更新で追随する。

## Algorithmic Pseudocode

### 目的関数（一片）

```
scoreSlice(placements, arrivals, memberEnds, params):
  serveTimes = placements.map(serveAt) ++ memberEnds
  wait  = Σ_{p ∈ placements, arrivals にある} floor((p.serveAt − arrival(p)) / 1000)
  latest = max(serveTimes)                                   # 空なら 0 を返して終わり
  lag   = Σ_{t ∈ serveTimes} ceil((latest − t) / 1000)          # 逸脱の罰ゆえ切り上げ
  over  = Σ_{t ∈ distinct(serveTimes)} max(0, count(t) − params.arms)
  return wait
       + params.tableSyncWeight * lag
       + max(0, params.tableSyncWeight − 1) * over
       + params.orderSyncWeight * orderExcessSeconds(placements, params.orderSyncToleranceSeconds)
       + params.affinityWeight * affinityExcess(placements, params)
```

すべて整数演算で閉じる。`lag` と `over` は集合の和なので走査順に依存しない。

### 最適点が Group_Anchor であること（判断 5 の検算・実装の根拠）

卓の成員を「動かせる placements（N 本）」と「動かせない走行中（提供時刻 r_j）」に分け、placements を共通目標 t（≥ すべての `earliest`）へ置く。

- `t ≤ A_run`（走行中の最大）のとき：`latest = A_run` で `lag = N(A_run − t) + Σ_j(A_run − r_j)`、`wait` は `N·t + c`。費用の t の係数は `N(1 − w)` で、`w ≥ 2` なら負——**t を上げるほど良い**ので t は `A_run` まで上がる。
- `t > A_run` のとき：`latest = t` で `lag = Σ_j(t − r_j)`、費用の係数は正——**t を上げると悪くなる**。
- 個別に 1 本だけ Δ 早めると `wait` は Δ 減り `lag` は wΔ 増えるので、`(w − 1)Δ` の損（Arms_Overflow が立っていれば超過項が `w − 1` 減り、最悪で同値。同値は棄却される）。

ゆえに**釜の割当と batch の分割を所与とすれば**、最適点は `t = max(A_run, max earliest) = Group_Anchor` のただ一点で、自前解の構成（`placeBatch`）がその点を直接置く。**自前解は、自分が選んだ割当の下で自分の目的関数の最適点に一致する**——これが「一致を制約にせず採点の帰結として得る」（AC 1.6）の実体である。

割当そのものを変えれば錨は動くので、**別の割当で外部解が自前解に勝つことは正当にありえる**（それが外部ソルバを残す理由である・判断 13）。上の議論は「揃えるか散らすか」の比較を閉じるもので、割当の最適性は主張しない。切り上げの議論（Component 2）も同じ範囲——同じ割当の上で `serveAt` をずらす計画が必ず損になることを言っている。

### 配置（1 つの Table_Group）

Component 3 の `placeGroup` / `placeBatch` の擬似コードがそのまま実装の形である。

## Error Handling

新しい失敗の種類を作らない。既存の落とし方に合流させる。

| 事象 | 扱い | 根拠 |
| --- | --- | --- |
| 茹で時間が引けない品目 | 配置しない（待ち行列に残り推奨だけが付かない） | 既存の規律（設定差し替えを跨いだ待ち行列） |
| 外部計画の `slotIds` の本数が `slotSpan` と違う / 重複がある（重複は釜番号で見る・`["0","00"]` は 1 釜） | feasible と認めない（一片で棄却＝接頭辞がそこで切れる）。述語は `occupiesSlotSpan`（schedule.ts）ただ一つで、`isStale` も読む | AC 4.2 |
| 走行中の錨に合流できた品目を、錨より後ろへ押し出した外部計画（例：合流できない 1 本のために全員を最後へ遅らせる）、または合流分を錨より手前に散らした外部計画 | feasible と認めない（ハード制約 (e)・一片で棄却）。述語は `keepsAnchor`（schedule.ts・内側で `isPushedOut`）ただ一つで、確定計画の合成と自前解の性質検査（Property 17）と共用。目的関数は最遅参照ゆえ押し出しの形を真に良いと採点するので、採点では守れない | AC 1.11 |
| 採用済み一片の卓の走行中の錨が Boil_Sync で動いた（+Δ：合流分が錨より手前 / −Δ：合流できる品目が錨より後ろ） | 合成（`livePrefix`）が `keepsAnchor` で再検証し、違反した一片以降を切って残した接頭辞の解放表から尾部を再計算する。もう届かない品目の一片は正当な後続の batch として残る | AC 4.8・判断 17 |
| 採用済み一片の配置が品目の現在の `slotSpan` を満たさない（v9 の 1 釜の配置・サイズ変更の再送） | `isStale` が陳腐化と見なし、合成の接頭辞がそこで切れて自前解が置き直す。永続は書き換えない | AC 4.6 |
| 設定（arms / toleranceRatio）の差し替えを跨いだ状態で外部計画が届く | 受領（plan.ts）は判定の前に `synchronize`（settle と同じ再同期）を通し、採用後に確定する走行中と同じ実効 endTime＝同じ錨で採点する。棄却時は同期前の状態を返す（AC 6.6） | 判断 4・AC 7.1 |
| 外部計画が `score` を添えてくる | 読まない（検証もしない） | AC 5.6 |
| 永続の `tableId` が壊れている | `tableId` だけ `null` へ畳む | 代償の軽い方（Component 8） |
| 永続の `AcceptedSlice` が形を満たさない | 全体を移行失敗（既存のまま） | 採用は再計算で復元できない事実 |
| `w_table ≤ 1` の設定 | 揃えない計画が正当になる（失敗ではない） | Requirement 2 冒頭の前提 |

## Correctness Properties

要件 Requirement 7 の 10 項をそのまま採る。番号は要件に一致させる。

1. **錨への一致** — 釜容量に収まる任意の卓で、自前解が配置した未着手の品目の `serveAt` はすべて Group_Anchor に等しい。
2. **採点の単調性** — `w_table ≥ 2` の下で、揃えた配置から一部の品目だけを早めて `serveAt` を散らした計画は、揃えた計画より目的関数の値が大きい。**ずれが 1 ミリ秒でも成り立つ**（Table_Lag の切り上げがこれを担う）。
3. **実行可能性** — `startAt ≥ 割り当てた全釜の解放時刻の最大`・`serveAt = startAt + 茹で時間`・釜は `slotSpan` 個。
4. **両端の一致** — `startAt + 茹で秒` の再計算が計画の `serveAt` と一致する。
5. **移行（追加）** — v9 以前の Timer は `tableId = null` として保持され、落ちない。
6. **移行（除去）** — v9 の `AcceptedSlice` は `score` を捨てて保持され、落ちない。
7. **部分和** — 総和は卓ごとの部分和の和に等しい。
8. **整数** — 目的関数の値は整数。
9. **卓同期項の下限** — 走行中の仲間が無い釜容量内の卓では、自前解の卓同期項は 0。
10. **Arms_Overflow の下限** — 同時刻の成員が `arms` 以下なら 0。

設計から追加で立つ性質を 4 つ置く。いずれも上の 10 項では捕れない構造の主張である。

11. **卓なしは成員にならない** — `tableId` が `null` の走行中 Timer は、どの `PlanSlice` の部分和にも寄与しない（単独キーの一片にも入らない）。
12. **成員の照合は一意** — `tableMembers` の鍵と `PlanSlice.tableKey` の一致は、卓に属する品目の一片に対してのみ成立する（NUL 始まりの単独キーは非空 `tableId` と衝突しない）。
13. **再採点の決定性** — 同じ `(slices, pending, members, params)` に対する `scoreSchedule` は常に同じ値を返し、`bySlice` の総和は `total` に厳密に一致する。
14. **batch 分割は容量で決まる** — 一片の各 batch について `Σ slotSpan ≤ 釜数` で、群の品目はどの batch にもちょうど 1 度現れる。

## Testing Strategy

engine は workerd を要さないので、既存どおり `tests/core/` の Vitest（PBT は fast-check）で閉じる。

| 対象 | ファイル | 内容 |
| --- | --- | --- |
| 目的関数 | `tests/core/objective.property.test.ts` | Property 7・8・9・10・13。`score` 参照を撤去し、成員表を渡す形へ |
| 目的関数（例） | `tests/core/objective.example.test.ts` | 観測事実 1 の卓（510/360/330）が揃った計画で lag 0 になること。1 ms ずらしが必ず値を増やすこと |
| 卓の成員 | 新規 `tests/core/table-members.property.test.ts` | Property 11・12。`tableId = null` の Timer が表に現れないこと・単独キーと非空 `tableId` が衝突しないこと |
| 配置 | `tests/core/schedule.property.test.ts` / `.example.test.ts` | Property 1・3・9・14。走行中の錨あり/なし・釜容量の内外・`slotSpan` の混在。共有の場面（`scheduleScenes.ts`）に走行中の仲間を持つ卓を足す |
| ゲート | `tests/core/admit.property.test.ts` / `.example.test.ts` | 基準が Committed_Plan であること・`slotSpan` と重複 slot の棄却・永続値を読まないこと。**1 ms ずらした外部計画がゲートを通らない例を 1 本**（重大な境界ゆえ example で明示的に固定する） |
| 移行 | `tests/core/migrate.property.test.ts` / `.example.test.ts` | Property 5・6。v9 の実データ形（`score` あり・`tableId` なし）を入力に置く |
| 走行中の卓 | `tests/core/start-order-item.example.test.ts` / `.property.test.ts` | 品目からの開始が `tableId` を写し、アドホック（`start.property.test.ts`）は `orderItem = null` のまま |
| 統合 | `tests/shell/cook-scheduling.integration.test.ts` | 「1 本目を入れた後も残りが揃う」を DO 越しに 1 本。`score` 参照を撤去 |
| 静的 | 既存の `no-wake.static.test.ts` 等 | 変更不要（Alarm の規律に触れない） |

Property 2 は「散らした計画は真に良くならない（Arms_Overflow が無ければ真に大きい）」を PBT で示す形にする——揃えた自前解を基準に、1 本の `serveAt` を Δ だけ早めた計画を作り、両者を `scoreSchedule` に通して比較する（`w_table` は 2〜100、Δ は **1〜999 ms と 1 秒以上**の両方で走らせる）。**Δ < 1 秒の側が本質である**——ここが切り上げでしか閉じない境界で、切り捨てに戻した実装はこの PBT で落ちる。

## Dependencies

新しいパッケージは無い。engine の内部依存が 1 本増える（`objective.ts` → `project.ts` の型 `TableMembers`）。`objective.ts` は `Timer` を知らないままである（表だけを受ける）ので、依存方向 `engine → domain` は保たれる。

## 公開シンボルの確認ゲート（実装前にユーザー確認・`naming.md`）

承認を要するのは**公開シンボル 6 件**である（型・公開関数・型の項目・削除）。「内部関数」の行は export しないため `naming.md` の対象外で、概念の記録として並べるだけである（承認は要らない）。

| 対象 | 候補 | 表明する概念境界 |
| --- | --- | --- |
| 型 | `TableMembers`（`project.ts`） | 卓ごとの走行中の仲間の提供時刻。解放表と同じ資格の第二の表 |
| 関数 | `tableMembers(running)` | 走行中 Timer から卓ごとの提供時刻を射影する唯一の経路 |
| 関数 | `isPushedOut(singles, release, lifts, siblings, params)`（module 内・`keepsAnchor` 経由） | 走行中の錨に合流できた品目を候補時刻からの firstFit より後ろへ押し出した配置が在るか（ハード制約 (e)）。21.6 で pack を載せた後の表の上で 1 品ずつ見る形へ改訂。Acceptance_Gate と自前解の性質検査が `keepsAnchor` で共用。レビュー対応で追加・事後承認 |
| 関数 | `occupiesSlotSpan(placement, order)` | 配置が品目の `slotSpan` を満たすか（本数一致・釜番号で相異なる）。`isStale` と Acceptance_Gate が共用する述語。コードレビュー対応で追加・事後承認 |
| 署名 | `scoreSchedule(slices, pending, members, params)` | 第 3 引数は `running` ではなく**射影表**（要件の naming ゲートは `running` と書いている・変更の提案） |
| 署名 | `baselineSchedule(pending, release, members, presets, params)` | 配置は 2 つの表と茹で時間から決まる。採点は含まない |
| 内部関数 | `tableLagSeconds` / `armsOverflow` / `armsOverflowWeight` | 卓の遅れの和 / 同時刻の本数の超過 / 卓同期から導く重み |
| 内部関数 | `ceilSeconds`（`objective.ts`） | 逸脱の罰を秒へ切り上げる。既存の `toWholeSeconds`（水準を切り捨てる）と役割で対になる |
| 型の項目 | `ScheduleParams.arms` | 採点が腕の本数を読む。外部契約に及ぶ |
| 型の項目 | `Ordered.orderItem.tableId`（**入れ子**） | 卓はオーダーの事実。直下に置けば「POS を経ないのに卓を知る Timer」が構築可能になる（要件 AC 3.1 は直下の表記・変更の提案） |
| 型の項目 | `RequestPlan.noodlePresets` | 要求の入力を engine の決定として一箇所に定める |
| 削除 | `PlanSlice.score` / `CookSchedule.score` | 一片は自分の点数を持たない。採点は比較の時点の導出 |

## 要件への申し送り

### 1. 観測事実 14 は半分だけ正しい（訂正）

「`noodlePresets` を運ばない。外部ソルバは…契約にその出所が無い」——**往路の契約（`solver/request.ts` の `PlanRequest`）は既に運んでいる**（同ファイル 42 行目）。shell が `this.noodlePresets` から添えているためである。欠けているのは `RequestPlan` Effect の側で、実害は「茹で時間が届かない」ではなく「**要求の入力が engine と shell の二箇所から来る**」ことである。AC 5.1 の変更内容は同じなので要件の結論は変わらないが、理由が違うので観測事実 14 を訂正されたい。

### 2. Arms_Overflow の数え方（Glossary の精密化を提案）

Glossary は「群の本数のうち `arms` を超える分」だが、設計は**同じ `serveAt` を持つ Table_Member の本数**で数える。理由は 2 つ。

- `arms` は腕の本数で、時刻が違えば腕は競合しない。群が釜容量を超えて batch に割れた場合、「群の本数」で数えると**同時に上がらない本数まで減点される**（7 人卓が 6 釜の店で必ず超過 1 を負う）。
- 卓同期項と同じ成員集合（Table_Member）の上で数えることで、2 つの項が 1 つの集合を共有する。集合を二つ持てば「卓の成員とは何か」が二箇所に生まれる。

群が一つの `serveAt` に揃う通常のケースでは、両者は一致する。Glossary の Arms_Overflow を「同時刻に上がる Table_Member の本数のうち `arms` を超える分」に寄せることを提案する。

### 3. `Timer.tableId` の形（AC 3.1・naming ゲート）

設計は `Ordered.orderItem` の内側に置く（Component 7）。`(orderItem = null, tableId 非 null)` という不正な状態を構築不能にするためで、要件の「`Timer` が `tableId`（`string | null`）を持つ」という表明は満たすが場所が違う。AC 3.1 と naming ゲートの表記を寄せるか、直下のまま行くかを確認されたい。

### 4. AC 4.2 に `slotIds` の相異性が要る

「`slotSpan` を満たさない外部計画を feasible と認めない」に、本数だけでなく**釜が相異なること**が含まれることを明示されたい（`["3","3"]` は本数 2 を満たしながら 1 釜しか占めない）。設計は Component 4 で検査する。

### 5. `tableSyncToleranceSeconds` は engine の読み手が 0 になる

判断 15 のとおり型と設定に残すが、**読む計算が一つも無い状態**になる。`online-cook-scheduling` の design への撤去候補の記録（AC 8.4）に、この事実（`ScheduleParams` に在るが誰も読まない）を明記されたい。読み手がいない値は、次の保守者が使い所を探して見つけられない。

### 6. 性質 7.2 はミリ秒粒度で言う必要がある

「一部の品目だけを早めて `serveAt` を散らした計画は、揃えた計画より目的関数の値が大きい」は、**秒未満のずれでも成り立たなければ意味がない**。client は `serveAt` の等号で群を組むので、1 ms のずれで群が割れる。秒への丸めを両項で揃えると（切り捨てで統一すると）この性質は Δ < 1 秒で偽になり、1 ms ずらした外部計画がゲートを通る（Component 2 の節）。設計は Table_Lag を切り上げることで閉じた。要件の性質 7.2 に「ずれが 1 ミリ秒でも成り立つ」を足されたい——この一語が無いと、実装が丸めを揃える方向へ「整理」したときに気づけない。

## 波及先への申し送り

### `lift-group-display` — 群の中で先に押す順

自前解は群の `startAt` を茹で時間の降順に置くので、**茹で時間の長い品目から入れれば残りは必ず錨に届く**。短い方を先に押すと錨がその時刻になり、長い方は届かず群ごと後ろへずれる（Requirement 3 の User Story の「届く限り」がこれ）。表示が群の中の順序を伝えないとこの事故が日常化するので、`lift-group-display` で扱われたい。ワイヤは `startAt` を運んでいるので、client 側は昇順に並べるだけで足りる（新しい値は要らない）。

### `online-cook-scheduling` — 改訂の内容（AC 8.1）

Requirement 3 のハード制約に `(d) slotSpan`（相異なる `slotSpan` 個の釜）、Requirement 4 のソフト制約に Arms_Overflow、確定注記の目的関数を本設計の `scoreSlice` の形へ。design 側は `scoreSchedule` の節（`:245-267`）と `baselineSchedule` の節（`:208-244`）が署名ごと変わる。

### テスト — `score` 参照は 9 ファイル

`tests/core/{admit,migrate,objective,plan,schedule}.*` と `tests/shell/cook-scheduling.integration.test.ts` の 9 ファイルが `score` を参照する。型から消えるので、実装と同じコミットで撤去する必要がある（型検査が落ちる）。
