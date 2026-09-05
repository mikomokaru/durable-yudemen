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
- `placeGroup(items, release, siblings, presets, params)`——`runningAnchor` の代わりに同じ卓の走行中の提供時刻の列（`tableMembers` の値・昇順）を受ける。`joinable` / `fits` は `catchable(earliest, siblings, boil, params)`（`A ≥ earliest − h_i` を満たす最早の A）で合流の可否を判定し、`placeJoined` は `joinedServeAt`——いずれかの A が `|earliest − A| ≤ h_i` なら **earliest**、無ければ earliest より後の最早の A——に置く。残りの batch は従来どおり `placeBatch(…, max(siblings))`。
- `keepsAnchor(placements, release, siblings, targets, presets, params)`：(1) 走行中の最早より h_i を超えて手前に散らさない、(2) `isPushedOut`——合流分（`joinedAnchor` が非 null＝いずれかの A から h_i 以内）だけで解放表を進め、合流していない配置の釜が「最遅の A + h_i − 茹で時間」までに空いていたら押し出し。
- `boilMillisOf` を `schedule.ts` から export し、admit.ts の重複を消した。
- `recommend(committed, pending, running, presets, params)`：配置ごとに `joinedAnchor` を引き、`group = joined ? \`${slice}:anchor:${A}\` : \`${slice}:${serveAt}\``、`anchor = A | null`。
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
| 関数 | `isPushedOut(placements, release, anchor, targets, presets)` | 走行中の錨に合流できた品目を後ろへ押し出した配置が在るか（ハード制約 (e)）。Acceptance_Gate と自前解の性質検査が共用。レビュー対応で追加・事後承認 |
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
