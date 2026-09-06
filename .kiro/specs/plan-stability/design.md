# Design Document

## Overview

前回提示した提案からの変更に費用を付け、調理者が段取りを組んだ部分（次に投入する品目とその釜・まとまり・順）を守る。新しい費用 = Business_Cost（既存の目的関数）+ Change_Cost。ハード制約は変えない。変更禁止ではなく、利益が覚え直す負担を上回れば変える。

機構は 4 つ。

1. **Shown_Plan の確定**（`settle.ts`）——確定結果の `Persist` に、選んだ計画の推奨から作った Shown_Plan を同乗させる。永続 v12。
2. **Head の共有導出**（`src/domain/lift-group.ts`・新規）——表示（`lift-group-display` 判断 19・21）と採点が**同じ関数**で Head を導く。client の `liftGroups.ts` はこれを呼ぶ形に寄せる。
3. **Change_Cost**（`src/engine/stability.ts`・新規）——旧 Shown_Plan と新しい計画の対応する品目の間で 4 種の費用を数え、`scoreSchedule` が `total` にだけ足す。
4. **自前解が前回を残す**（`schedule.ts`）——釜の第一候補と、batch の並びと分割の候補に Shown_Plan を効かせ、局所比較の費用に Change_Cost の差分を含める。

### 先行 spec との関係

- `lift-group-planning`（上げ窓まで）と `lift-group-display`（判断 21）が前提。Head の定義は表示側の判断 19・21 を engine でも読める純粋関数に切り出す（表示の挙動は変えない・AC 4.3）。
- `verified-wire-contract`：ワイヤは変えない（Shown_Plan は永続と `RequestPlan` にだけ現れる）。

## Architecture

| 層 | ファイル | 変更 |
| --- | --- | --- |
| domain | `src/domain/lift-group.ts`（新規） | 群の連鎖と Head の導出（推奨・占有釜・now・arms から）。client と engine が共有 |
| engine | `src/engine/state.ts` | `TimerState.shownPlan: ShownPlan`（`ShownItem[]`・空は比較の相手なし） |
| engine | `src/engine/snapshot.ts` / `types.ts` / `migrate.ts` | 永続 v12。v11 以前の欠如を空に畳む。`reviveShownItem` |
| engine | `src/engine/stability.ts`（新規） | `ShownPlan` / `ShownItem` / `shownPlanOf(recommendations)` / `changeCost(...)` |
| engine | `src/engine/objective.ts` | `scoreSchedule` が `ScoreContext` を受け、`total` に Change_Cost を足す。`bySlice` は変えない |
| engine | `src/engine/settle.ts` | 確定結果の `Persist` に Shown_Plan を載せる（`toWireSnapshot` の推奨と同じ値）。no-op / 棄却 / hydration では更新しない |
| engine | `src/engine/admit.ts` / `commit.ts` | 採点と自前解に旧 Shown_Plan を渡す。比較は `prev.shownPlan` に対して |
| engine | `src/engine/schedule.ts` | `chooseSlots` の第一候補（前回の釜）、batch の並び（前回の `startAt` 順を保つ）、`placeWithLifts` の局所費用に Change_Cost の差分 |
| engine | `src/engine/effect.ts` / `src/solver` | `RequestPlan.shownPlan`（外部解も同じ費用で採点されるため） |
| client | `src/client/components/liftGroups.ts` | 群の連鎖と Head の導出を domain の関数に寄せる（挙動は変えない） |
| docs | `docs/persisted-schema-rollback.md` | v12 の行 |

## Data Models

```ts
// src/engine/stability.ts
/** 前回配信対象として確定した提案の 1 品目。group は snapshot 内の識別子ゆえ持たず、まとまりは同じ群の相手の鍵で持つ。 */
export interface ShownItem {
  readonly externalOrderId: string;
  readonly itemIndex: number;
  readonly slotIds: NonEmptyArray<SlotId>;
  readonly startAt: EpochMillis;
  readonly serveAt: EpochMillis;
  readonly anchor: EpochMillis | null;
  /** 同じ群に在った品目の鍵（externalOrderId + itemIndex）。自分は含まない。 */
  readonly mates: readonly ItemKey[];
}
export type ShownPlan = readonly ShownItem[];
export const EMPTY_SHOWN_PLAN: ShownPlan = [];
/** 確定計画の配置（serveAt・anchor を持つ）と、recommend が付けた群から作る。CookRecommendation だけでは serveAt を埋められない。 */
export function shownPlanOf(schedule: CookSchedule, recommendations: readonly CookRecommendation[]): ShownPlan;
```

- **入力契約（レビュー指摘）**：`ShownItem.serveAt` は `Placement.serveAt`（窓による延期後の値・`anchor` とは違う）から、`slotIds` / `startAt` / `anchor` も `Placement` から、`mates` は同じ確定計画に対する `recommend` の出力の `group` から取る。`settle` は `committedSchedule` の結果（`CookSchedule`）と `recommend(committed)` の両方を持っているので、そこで組む。
- 群の所属は「同じ群の相手の鍵の列」で持つ（未決 1 の決定）。識別子の文字列を跨いで比べない（AC 1.5）。対称に持つので、分割の費用は組ごとに一度だけ数える（相手の鍵の辞書順で小さい側からだけ数える）。
- `TimerState.shownPlan: ShownPlan`。`EMPTY_STATE` は `EMPTY_SHOWN_PLAN`。永続 v12 は `shownPlan` を配列で持ち、欠如を空に畳む（AC 1.3）。

## Components and Interfaces

### Component 1: `src/domain/lift-group.ts` — Head の共有導出

表示側の `liftGroups` / `visibleGroups` / `slotSuggestions` から、ビューに依らない純粋な部分を切り出す。

```ts
export interface LiftItem { readonly recommendation: CookRecommendation; readonly boilSeconds: number; readonly order: PendingOrder }
export function liftGroupsOf(items: readonly LiftItem[], now: number): readonly { group: string; anchor: number | null; items: LiftItem[]; started: boolean }[];
export function visibleGroupsOf(groups): readonly ...;
/** Head——表示できる群の品目のうち、全釜 idle・Prep_Lead・開始推奨時刻が来たものを時刻順に並べた先頭 arms 本。 */
export function headsOf(visible, occupied: ReadonlySet<number>, now: number, arms: number): readonly ItemKey[];
```

- client の `liftGroups.ts` はこれらを呼び、`ClientView` からの取り出し（`suggestedItemOf`・`occupiedSlots`・`mode`）だけを残す。表示の挙動は変えない（既存の Property / Example がそのまま通ることが検証）。
- engine は Change_Cost の先頭の判定に同じ関数を呼ぶ。入力は推奨（`group` / `anchor` は `recommend` が付ける）、占有釜（遷移後の走行中の `slotIds`）、比較の時点の now、`params.arms`。

### Component 2: `changeCost`（`src/engine/stability.ts`）

```ts
export interface ChangeContext {
  readonly shown: ShownPlan;             // 旧 Shown_Plan（遷移前の状態が持つ）
  readonly running: readonly Timer[];    // 遷移後（再同期後）の Timer 集合（判断 8）
  readonly now: EpochMillis;             // 比較の時点
  readonly pending: readonly PendingOrder[];      // 品目の到着時刻（同値の順）と麺種・茹で加減（茹で秒）を引く
  readonly presets: readonly NoodlePreset[];      // 茹で秒の出所
}
/** 秒相当・整数。対応する品目（鍵が一致・双方に在る）の間でだけ数える。next は確定計画とその推奨（group / anchor 付き）。 */
export function changeCost(
  next: { readonly schedule: CookSchedule; readonly recommendations: readonly CookRecommendation[] },
  context: ChangeContext,
  params: ScheduleParams,
): number;
```

**入力契約（レビュー指摘）。** 共有導出（`headsOf`）は `LiftItem { recommendation, boilSeconds, order }` を要る——茹で秒（`boilMillisOf(order, presets)`）と到着時刻（同値の順）は `PendingOrder` から引く。旧 Shown_Plan の品目も新しい計画の品目も、`context.pending` から同じ鍵で品目を引いて `LiftItem` を組む（開始済み・キャンセル済みは `pending` に無いので自然に対応から外れる）。旧 Shown_Plan を推奨と見なすには `group` が要るが、これは `mates` を連結成分にして snapshot 内の仮の識別子を振る（識別子は比較の内側で閉じ、外に出ない）。

**単位（レビュー指摘）。** `startAt` / `serveAt` / `anchor` / `now` はミリ秒、`L = liftIntervalSeconds` は秒。窓の数と減衰の距離は `L × 1000`（ミリ秒）で数え、費用への換算には秒の `L` を使う。

手順（AC 2.1〜2.6・判断 2・3・8）：

```
Lms = liftIntervalSeconds × 1000, L = liftIntervalSeconds
pairs = 鍵が旧 Shown_Plan と next の両方に在り、context.pending にも在る品目（開始済み・キャンセル・新規は自然に外れる）
occupied = context.running の slotIds の和集合
oldHead = headsOf(liftGroupsOf(旧 Shown_Plan を LiftItem に組んだもの), occupied, now, arms)   # 両側とも同じ now・同じ Timer 集合
newHead = headsOf(liftGroupsOf(next を LiftItem に組んだもの), occupied, now, arms)
cost = 0
for k in pairs:
  if k ∈ oldHead && k ∉ newHead: cost += 2L                                   # (a) 先頭の変更
  if slotIds が変わった: cost += L                                              # (b) 釜の変更
  Δ = |startAt_new(k) − startAt_old(k)|（ミリ秒）
  if Δ > h_i(k)（ミリ秒）:                                                      # (d) 時刻の移動（h_i の内側は数えない）
    windows = ceil(Δ / Lms)
    k_far = floor(max(0, startAt_old(k) − now) / Lms)
    cost += floor(windows × L / (k_far + 1))                                   # 秒相当・遠いほど大きくならない
for (k, m) in pairs の全組（k < m・鍵の辞書順）:                                  # (c) は 2 つの検査に分ける
  if k と m が旧で同じ群 && next で group が違う: cost += L                      # (c-1) まとまりの分割（同じ群だった組にだけ）
  if sign(startAt_old(k) − startAt_old(m)) × sign(startAt_new(k) − startAt_new(m)) < 0: cost += L   # (c-2) 順の逆転（群を問わず全対応の組）
return cost
```

- **順の逆転は群を跨いで数える（レビュー指摘）。** 別群の A@10 秒・B@11 秒が A@11 秒・B@10 秒に変われば、時刻の移動が h_i の内側でも順の逆転として L が付く。分割の検査は同じ群だった組にだけ効く。
- 欠落は数えない（AC 2.4・ハード制約が閉じる）。

### Component 3: `scoreSchedule` と `ScoreContext`

```ts
export interface ScoreContext {
  readonly members: TableMembers;
  readonly lifts: LiftTable;
  readonly change: ChangeContext | null;   // null は比較の相手なし（Change_Cost 0）
}
export function scoreSchedule(slices, pending, context: ScoreContext, params): ScheduleScore;
// total = Σ bySlice + Lift_Overflow + Change_Cost（context.change が非 null のとき）
```

- `bySlice` は変えない（段 1 の枝刈りは業務費用の部分和のまま）。段 2 の総和比較に Change_Cost が乗る（AC 2.5・4.1）。
- `admit` は 3 回の採点すべてに同じ `ScoreContext` を渡す（旧 Shown_Plan は `prev.shownPlan`・Timer 集合は再同期後・now は受領時刻）。
- Change_Cost は `recommend(schedule)` の出力（`group` / `anchor` 付き）に対して数える——採点の入力は `slices` なので、`scoreSchedule` の内側で `recommend` を呼ぶか、`Placement` から同じ形を組む。**`recommend` を呼ぶ**（群の識別を二度書かない）。

### Component 4: `settle` — Shown_Plan の確定

```
nextState = { ...moved, timers: synchronize(...) }
if isSameConfirmedResult(prev, nextState): return no-op            # shownPlan は prev のまま
snapshotMessage = toWireSnapshot(nextState, params, now)          # 推奨を導く（旧 shownPlan を採点の相手にして合成）
confirmed = { ...nextState, shownPlan: shownPlanOf(snapshotMessage.recommendations) }
effects = [Persist(toSnapshot(confirmed)), Alarm, Broadcast(snapshotMessage), (RequestPlan)]
```

- `isSameConfirmedResult` は `shownPlan` を比べない（比べれば時刻経過だけで「変化」になり、AC 7.6 が禁じる空振りの Persist が出る）。Shown_Plan は確定結果の**付随物**で、確定結果が変わるときにだけ更新される（AC 1.6）。
- hydration（`toWireSnapshot` を shell が直接呼ぶ経路）は状態を変えないので Shown_Plan も更新しない（AC 1.6）。導く推奨は旧 Shown_Plan を相手に合成するので、Shown_Plan に近い形になる。
- 棄却（`receivePlan` の早期 return）は状態不変ゆえ更新しない。

### Component 5: 自前解が前回を残す（`schedule.ts`）

`baselineSchedule` / `committedSchedule` は `ChangeContext | null` を受け、`placeGroup` へ渡す。

1. **釜の第一候補**（AC 3.1）：`chooseSlots(count, release, params, preferred)` に、対応する品目の Shown_Plan の釜を渡す。全部が候補の時刻までに空く（`release[s] ≤ 候補 − 茹で時間`）ならそれを採り、無ければ既存の規則。batch（複数品目の同時配置）では `assignSlots` が品目ごとに前回の釜を先に割り当て、残りを既存の対応づけで埋める。
2. **並び**（AC 3.2）：batch の並び（茹で時間の長い順・同値は正準順序）の同値の断ち方に、前回の `startAt` 順を第一に使う（順の逆転を作らない）。
3. **分割**（AC 3.2）：`placeWithLifts` の局所費用に Change_Cost の差分を足す——**(a) 先頭の変更を含む 4 種すべて**を、当該列の品目について数える（レビュー指摘：(b)(c)(d) だけでは最も守りたい投入対象が動く。arms 1・L 45・茹で 600 秒・走行中 2 本が 600 秒に上がる表で、旧提案が A を今・B を 45 秒後なら、両方を 45 秒後へ pack すると業務費用は 45 秒改善するが A の先頭消失は 90 秒で、総費用は 45 秒悪化する）。先頭の判定は列の候補配置を仮に置いた計画に対して `headsOf` で導く（列の外の品目は現在の確定分をそのまま用いる）。pack / split の候補に、**前回のまとまりを保つ分割**（前回同じ群だった品目を同じ塊に置く）を一つ足し、3 候補の最小を採る（同点は前回を保つ側）。
4. ハード制約（釜の排他・slotSpan・上げ窓・合流の契約）は候補の生成の前に効く（AC 3.3）。

局所探索であり、生成した候補の範囲でだけ「利益が上回れば変わる」（性質 5.7）。

**実装時の追記（task 4・2026-09-06）。** 実走（連続投入の場面・性質 5.6）が 3 点を要した。
- **batch の候補の時刻は錨から「最小の span で `firstFit`」まで進める。** 錨そのものを候補にすると、錨の窓が埋まって列が次の窓へ押される場面で、前回の釜が「間に合わない」と見なされ、同じ時刻に置かれるのに釜だけが変わる。`firstFit` は時刻にも span にも単調なので、進めた時刻より手前に置かれる塊は無く feasible。合流の候補は合流先の提供時刻のまま（合流の可否を動かさない）。
- **第 4 の候補「前回の先頭を今の窓に残す分割」（`keepHeads`）。** split の接頭辞は arms で切るので、走行中が窓の一部を占めていると接頭辞ごと次の窓へ押され、先頭 1 本だけなら残れた窓を誰も使わない（arms 2・走行中 3 本が同じ窓に上がる表で、前回「今」だった 1 本が 45 秒後へ動く）。旧 Head の品目を先頭の塊にして候補の時刻の窓に置き、残りを再帰する。候補の優先順（同点）は前回のまとまり → 前回の先頭 → pack → split。S ≤ arms（手伝いが要らない）でも前回の候補は比べる。
- **第 5 の候補「前回の配置を再現する分割」（`restorePrevious`）と、容量超過の分岐でも候補を比べること（性質 5.6 / 5.7 の反例から）。** 前回のまとまり（`mates`＝同じ群）は提供時刻の一致を意味しない——走行中の錨に合流した群は一つの群のまま、窓が押した品目だけ次の窓に上がる。そのとき「前回のまとまりを保つ分割」は塊が一つで pack と同じになり、同値の並びを前回の `startAt` で断った列では split の接頭辞と余りが前回と入れ替わるため、前回の配置が候補に無く、業務費用と変更費用の両方で劣る配置が採られた（arms 3・走行中 3 本の窓に 1 本だけ合流していた卓）。前回の `serveAt` が同じ品目を塊にし、前回の `serveAt` の昇順に置く候補を最優先に足す。同じ理由で、Σ span が上限を超えて接頭辞で切る分岐も、前回の startAt で断った列では前回同じ群だった品目を接頭辞の内と外に割る（3 品の卓・上限 4・Σ span 5 で、業務費用が同点のまま前回と違う分割になり、同じ入力の再計画で変更費用 31 秒）ので、そこでも再現・まとまりの候補を足して局所費用で選ぶ。候補の優先順（同点）は 前回の配置の再現 → 前回のまとまり → 前回の先頭 → pack → split。
- **前回に忠実な計画と候補を比べた計画の 2 本を組み、総費用（業務費用 ＋ 変更費用・`scoreSchedule`）が真に下がるときだけ後者を採る（`baselineSchedule`・`Continuity.faithful`）。** 列ごとの局所比較は後続の一片への影響（上げ窓の押し出しとその変更費用）を見ないので、局所では勝つが全体では劣る候補へ計画が動き得る（実測：w_table 4・arms 2・L 62 で、卓の一片は 370 秒改善するが後続の単独品が 83 秒遅れ、変更費用 444 秒を足すと前回より 218 秒悪い計画に変わった）。忠実な計画は列の候補を比べず、前回の配置を再現する分割が在ればそれ、無ければ pack（容量超過なら接頭辞の分割）を採る。同点は忠実な側。計画は 2 回組むが n ≤ 64 で問題にならない。**性質 5.6 の言い直し**：同じ入力で続けて計画すると、同じ計画（Change_Cost 0）か総費用が真に下がる計画になる（前回を残す候補が前回の無い計画に無かった配置を見つける場面があり、それは 5.7 そのもの。実測：arms 1・L 9・w_table 0 で錨に揃えていた 2 品を別の窓に分けて業務費用 23 秒改善・変更費用 6 秒）。計画が変わるのは総費用が真に下がるときだけで、忠実な計画は前回そのもの（変更費用 0）ゆえ、now を含む業務入力を固定すれば **業務費用そのものが厳密に下がる**。ゆえに有限回で落ち着く。
- **(a) の Head は、まだ置いていない品目を Shown_Plan の配置で補った途中の計画から導く（`partialChangeCost`）。** 置いた分だけの計画で導くと、後の一片の群が連鎖から欠けて先頭が変わり、同じ計画を続けて置いても偽の 2L が付く。補った計画をそのまま `recommend` に通して群を得る（群の識別子の規則を再実装しない——レビュー指摘：二重管理すると片側の形式変更で表示は正常のまま局所比較の Head と変更費用が変わる。いま置いている卓の品目は末尾の一片に足すので、置いた品目と同じ錨・同じ提供時刻なら同じ群になる）。補いは Head にだけ使い、(b)(c)(d) の対応には入れない。

### Component 6: `RequestPlan.shownPlan`

`RequestPlan` に `shownPlan: ShownPlan` を足し、外部ソルバが同じ費用で最適化できるようにする。指紋には畳まない（AC 4.5）。`src/solver` の自前解経路は `baselineSchedule` に同じ context を渡す。

## Error Handling

| 状況 | 扱い | 出所 |
| --- | --- | --- |
| v11 以前の永続（`shownPlan` 欠如） | 空に畳む（比較の相手なし・Change_Cost 0） | AC 1.3 |
| `shownPlan` の要素が壊れている（鍵・釜・時刻の形が不正） | その要素だけ落とす（履歴の欠けは費用 0 に倒れるだけで、状態全体を失わせない） | 移行の規律 |
| 旧 Shown_Plan の品目が開始済み・キャンセル済み | 対応が無いので数えない | AC 2.3 |
| 前回の釜が候補の時刻までに空かない | 既存の規則へ落ちる（釜の変更費用 L を払う） | AC 3.1・3.3 |
| 外部計画が未着手の品目を一片から外す | `isStale` で棄却（既存） | AC 2.4 |

## Testing Strategy

- **共有導出の同値**：`src/domain/lift-group.ts` に寄せた後、client の既存 Property / Example（`liftGroups.*`・`slot-board-suggestions.*`・crosslayer）が変更なしに通る。
- **`stability.property`**（Requirement 5）：5.1 不変（同じ推奨は now・Timer 集合に依らず 0）、5.3 先頭の保護、5.4 減衰の単調非増加、5.5 対応の規律（開始済み・キャンセル・新規を足しても変わらない）、5.9 時間経過の保護。
- **`stability.example`**：4 種それぞれの費用の例（先頭 2L・釜 L・分割 L・逆転 L・時刻 1 窓 L / 遠い品目の減衰）。
- **`schedule.example`**：前回の釜が空いていればそれを採る／埋まっていれば既存の規則／前回のまとまりを保つ分割が同点で勝つ／改善が費用を上回れば変わる（5.6・5.7）。
- **`settle.example`**：確定結果の `Persist` に Shown_Plan が同乗し推奨と一致する／no-op・棄却・hydration では更新されない。
- **`migrate.*`**：v11 → v12 の二方向、壊れた要素の切り捨て。
- **`admit.example`**：前回と大きく違う外部計画が微小な改善で通らない／改善が費用を上回れば通る。
- **横断**（engine 実走）：連続投入の場面で、投入のたびに残りの釜と順が変わらないこと（Change_Cost 0 が続く）。

## naming ゲート（実装前にユーザー確認）

| 名 | 場所 | 概念境界 |
| --- | --- | --- |
| `ShownPlan` / `ShownItem` / `EMPTY_SHOWN_PLAN` / `shownPlanOf` | `src/engine/stability.ts` | 前回配信対象として確定した提案（履歴の事実）と、その 1 品目 |
| `TimerState.shownPlan` | `src/engine/state.ts` | 同上を状態に持つ |
| `changeCost` / `ChangeContext` | `src/engine/stability.ts` | 変更費用と、その比較の文脈（旧 Shown_Plan・遷移後の Timer・now） |
| `ScoreContext` | `src/engine/objective.ts` | 採点の文脈（成員表・上げ表・変更の文脈）。`scoreSchedule` の位置引数の増殖を止める |
| `liftGroupsOf` / `visibleGroupsOf` / `headsOf` / `LiftItem` | `src/domain/lift-group.ts` | 群の連鎖と Head の共有導出（表示と採点で一つ） |
| `RequestPlan.shownPlan` | `src/engine/effect.ts` | 外部ソルバへ運ぶ Shown_Plan |
| `chooseSlots(..., preferred)` | `src/engine/schedule.ts` | 前回の釜の第一候補 |

## 未決の決定（requirements の「未決」への答え）

1. 群の所属は「同じ群の相手の鍵の列」（`ShownItem.mates`）。代表品目の鍵は、代表が開始済みになると壊れる。
2. 減衰は `floor(窓の数 × L / (k + 1))`（k = 旧 `startAt` が今から何個目の上げの間隔か）。整数で単調非増加。
3. 自前解で保つ候補は釜（第一候補）とまとまり（分割の第 3 候補）の両方。局所比較の単位は `placeWithLifts` の列。
