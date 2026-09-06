# Design Document

## Overview

「将来いつ空く見込みか」（解放表）と「今、開始操作できるか」（釜に Timer が無い）を分け、自前解の**「今」置く配置の釜の選択**にだけ後者を読ませる。計画は 2 段で組む——1 段目は従来の業務費用の計画（何を「今」置くか・時刻）を決め、2 段目は 1 段目の「今」の品目に **表示の順で** 今割り当てられる釜を配り、その配分と 1 段目の時刻の下限を固定して計画を組み直す。確定計画の合成には「開始を妨げる接頭辞」の失効を足す。連鎖・全釜 idle・解放表・ゲート・上げ窓・まとまりは変えない。

三つの概念を分けたまま持つ（レビュー指示）。

- **Startable_Slot（Timer の無い釜）**：`occupiedSlotsOf(timers)` の補集合。domain に一つ置き、engine と client が共有する（事実）。
- **今割当可能な釜（Assignable_Now）**：Startable_Slot のうち、**採用済み接頭辞の予約と、表示順で先行する配分を反映した解放表**で解放時刻が `now` 以下の釜（解放表の予測 ＋ 事実）。開始の保証（性質 4.1）はこの本数で数える。
- **解放表（予測）**：boiled の釜は `now`。変えない。

### 先行 spec との関係

- `lift-group-planning`：`baselineSchedule` の中に 2 段を置く。`chooseSlots` / `assignSlots` / `placeGroup` の規則は変えず、2 段目が「固定した配置」と「時刻の下限」を読む口を足す。
- `plan-stability`：前回の釜の第一候補は 2 段目の配分（表示順・先の品目を押しのけない範囲）に吸収する（AC 2.1〜2.3）。忠実な計画と候補比較の計画のどちらにも同じ 2 段を通す。
- `lift-group-display`：client の `occupiedSlots` を domain の関数に置き換えるだけ。連鎖・Head・全釜 idle は変えない。
- `online-cook-scheduling`：合成（`livePrefix`）の失効に「開始を妨げる配置」を足す。ゲートの feasibility は変えない（未決 3）。

## Architecture

```
domain/store.ts     occupiedSlotsOf(timers)                       ← 事実（Timer の無い釜の補集合）。client の occupiedSlots もこれ
        │
engine/commit.ts    livePrefix: 失効に blocksStart(slice, now, occupied) を足す（startAt ≤ now かつ釜に Timer）
        │            committedSchedule → baselineSchedule(…, now, occupied, changeContext)
        │
engine/schedule.ts  baselineSchedule
                      1 段目  buildSchedule(pinned = null)          ← 従来（忠実／候補比較を総費用で選ぶ）
                      配分    pinNow(stage1, release, occupied, shown, now)
                                「今」の品目を表示順（startAt → compareArrival）に並べ、
                                今割当可能な釜（release ≤ now かつ Timer なし・先行する配分を除く）を配る
                      2 段目  buildSchedule(pinned)                 ← 固定した「今」配置を先に表へ載せ、残りを下限つきで置く
                                                                      （忠実／候補比較を再び総費用で選ぶ）
        │
client/components/liftGroups.ts   occupiedSlots(view) = occupiedSlotsOf(view.timers)
```

原則。

1. **釜の選択規則は 2 段目の配分（`pinNow`）に一箇所で書く。** `chooseSlots` の同点処理は変えない。AC 1.1（Startable_Slot を先に）・AC 2.1（前回の釜は押せない釜に効かない）は配分の規則として実現する。
2. **2 段目は前倒ししない。** 1 段目の各品目の `startAt` を下限に持ち、「今」の集合は 1 段目と同じ（AC 1.8・性質 4.7）。
3. **固定した配置は接頭辞と同じ扱い。** 2 段目の前に解放表と上げ表へ載せ、置くときは表を進めない（二重に数えない）。
4. **将来配置は占有を読まない。** `occupied` は配分（「今」の品目）と合成の失効だけが読む（性質 4.6）。

## Data Models

```ts
// src/domain/store.ts
/** Timer（running / boiled とも）が載っている釜の番号。client の occupiedSlots と engine の配分が同じ事実を読む。 */
export function occupiedSlotsOf(timers: readonly { readonly slotIds: readonly string[] }[]): ReadonlySet<number>;

// src/engine/schedule.ts（内部）
/** 2 段目が読む固定。1 段目で「今」に選ばれた品目の配置（配分後の釜・startAt = now）と、全品目の startAt の下限。 */
interface Pinned {
  readonly placements: ReadonlyMap<ItemKey, Placement>;   // 「今」の品目 → 固定した配置
  readonly notBefore: ReadonlyMap<ItemKey, EpochMillis>;   // 全品目 → 1 段目の startAt（下限）
}
```

`Placement` / `PlanSlice` / `CookSchedule` / `TimerState` / wire / 永続は変えない。

## Components and Interfaces

### Component 1: `occupiedSlotsOf`（`src/domain/store.ts`）

- `slotOf` の隣に置く。入力は `{ slotIds }` を持つ列（engine の `Timer` も wire の `TimerFact` も満たす）。
- client の `occupiedSlots(view)`（`liftGroups.ts:167`）はこれを呼ぶ薄い包み（または直接置換）。`headsOf` / `displayableItemsOf` / `pairSlots` の呼び手は変えない。

### Component 2: 合成の失効 `blocksStart`（`src/engine/commit.ts`）

- `livePrefix` に `occupied: ReadonlySet<number>` を通し、`hasLapsedStart(slice, now)` の隣に `blocksStart(slice, now, occupied)`——一片のどれかの配置が `startAt ≤ now` かつ `slotIds` のどれかが `occupied` に在る——を足す。どちらかで接頭辞が切れる（Requirement 3.4〜3.5）。
- 二つを一つの述語 `cannotStart(slice, now, occupied)`（過去開始 ∨ 開始を妨げる）にまとめ、注記に「過去開始（人が始めなかった事実）」と「押せない釜（Timer が残っている事実）」の両方を書く。判定は一片単位（既存の「1 本でも過ぎていれば全体」と同じ理由）。
- ゲート（`admit`）は変えない。ゲートが通した「boiled の釜に今」の一片は、次の合成で落ちる（未決 3 の答え）。

### Component 3: 2 段の計画 `baselineSchedule`（`src/engine/schedule.ts`）

署名に `occupied: ReadonlySet<number>` を足す（`now` の隣）。`committedSchedule` は `occupiedSlotsOf(running)` を、`src/solver` は `occupiedSlotsOf(request.running)` を、テストは場面の Timer から渡す。

```
baselineSchedule(pending, release, members, lifts, presets, params, now, occupied, changeContext):
  stage1 = choose(buildSchedule(…, pinned: null))          // 既存：忠実／候補比較を総費用で
  pinned = pinNow(stage1, pending, release, occupied, changeContext?.shown, now, params)
  if pinned === null return stage1                          // 「今」の品目が無い、または配分が 1 段目と同じ
  return choose(buildSchedule(…, pinned))                   // 2 段目：同じ選び方
```

**`pinNow`（配分）**

1. 「今」の品目 = stage1 の配置のうち `startAt ≤ now`（自前解は `now` ちょうど）。表示の順に並べる：`startAt` 昇順・同値は `compareArrival`（`domain/order.ts`。表示の `liftGroupsOf` と同じ比較）。
2. 今割当可能な釜の集合 `assignable` = `release[s] ≤ now`（**入力の解放表＝採用済み接頭辞の予約を反映済み**）かつ `s ∉ occupied`。
3. 品目を順に見て、slotSpan 本を次の優先で `assignable` から取る——(a) 前回の釜（`shown` の `slotIds`）が全部 `assignable` に在ればそれ、(b) 1 段目の釜が全部在ればそれ、(c) `chooseSlots(slotSpan, assignable だけを now にした表, params)`（釜距離 → index の既存規則）。取った釜は `assignable` から除く（先行する配分を反映）。足りなければ 1 段目の釜のまま（Timer の在る釜で Complete を待つ・AC 1.4）。
4. `placements` = 品目 → `{ …stage1 の配置, slotIds: 配った釜 }`（`startAt` / `serveAt` / `anchor` は 1 段目のまま）。`notBefore` = stage1 の全配置の `startAt`。
5. 配分が 1 段目と同じ釜なら null（2 段目を組まない・決定性と計算量）。

「先の品目を押しのけない範囲で前回の釜を保つ」（AC 1.7）は、順に見て (a) を先に試す形で成り立つ——先の品目が (c) で後の品目の前回の釜を取ることは在る（先の品目が Startable_Slot を要し、それしか無いとき）。

**2 段目の `buildSchedule(…, pinned)`**

- 始めに `pinned.placements` を解放表と上げ表へ載せる（`advanceRelease` / `advanceLifts`。接頭辞と同じ）。卓の成員表にも当該卓の成員として `serveAt` を足す（`members` を写して渡す）。
- `placeGroup` は群の品目のうち `pinned.placements` に在るものを**その配置のまま**出力に加え（`assignSlots` を通さない・表を進めない）、残りの品目を従来どおり置く。固定した品目の `serveAt` は列の局所費用の卓の成員（`members`）に既に入っている。
- 残りの品目の候補時刻に下限を当てる：`assignSlots` の `earliest[i] = max(既存の earliest, notBefore[i] + boil)`、`joinable` の合流可否に `notBefore ≤ 錨 − boil` を足す（1 段目に無かった合流を作らない）。`placeWithLifts` の `t0` は候補時刻から来るので下限は `earliest` に効かせれば足りる。
- `Continuity`（前回の提案）は 1 段目と同じものを渡す。忠実／候補比較の両方を 2 段目でも組み、総費用で選ぶ（AC 2.3）。

**なぜ「今」の集合が保たれるか。** 固定した品目は 1 段目と同じ `startAt = now`。残りの品目は下限 ≥ 1 段目の `startAt > now` なので `now` にならない。固定した釜は解放 `now` の釜だけなので固定した品目の時刻も動かない。

### Component 4: 呼び手（`commit.ts` / `settle.ts` / `plan.ts` / `admit.ts` / `src/solver`）

- `committedSchedule(accepted, pending, running, now, presets, params, changeContext)`：`occupied = occupiedSlotsOf(running)` を一度作り、`livePrefix` と `baselineSchedule` へ渡す。署名は変えない（`running` から導ける）。
- `admit` は `committedSchedule` の結果を比較の基準にするだけで変えない。`src/solver` は `baselineSchedule` に `occupiedSlotsOf(request.running)` を渡す。

### Component 5: client（`src/client/components/liftGroups.ts`）

- `occupiedSlots(view)` の本体を `occupiedSlotsOf(view.timers)` に置き換える。他は変えない。

## Error Handling

- 「今」の品目に今割当可能な釜が足りない：1 段目の釜のまま（Timer の在る釜）で Complete を待つ。エラーではない（AC 1.4・判断 4）。
- 2 段目で残りの品目が下限のために遅れる：feasible のまま（下限は後ろへしか動かさない）。時刻が 1 段目より遅れ得ることは性質 4.7 に含める。
- `occupied` が解放表の外の釜を指す（設定の釜数より大きい番号）：集合には在るが解放表の index に無いので、どこにも効かない（既存の「表の外は構造で落ちる」と同じ）。

## Testing Strategy

- **harness**（`tests/core/operationScenes.ts`・新設）：`decide` → Broadcast の snapshot → `decideView` → `liftGroups` / `slotSuggestions` を回す連続処理。「表示の先頭から開始」「茹で上がりの後に釜番号順（昇順／降順）で Complete」を操作として書ける形にし、各遷移の直後に **今割当可能な Startable_Slot が先頭品目に足りるのに提案が空** を検査する述語を一つ置く（性質 4.2 の例外——空き不足・予約の排他・上げ窓・合流——を同じ述語で除く）。
- **観測事実 8 の再現**（`tests/core/startable-placement.example`）：6 釜・arms 2・10%・45 秒・Thin 60 秒・卓なし 8 品・3 秒間隔・降順 Complete。72 秒の釜 1 の Complete の後、A が釜 1 に「今」で先頭に出る。修正前は赤。
- **24 品の連続処理**（同 example）：Complete の昇順・降順、Shown_Plan の有無、採用済み接頭辞の有無で、二周目以降まで例外に当たらない空白が 0 箇所（性質 4.2）。同卓／別卓／卓なし、slotSpan 1／2。
- **レビューの反例を固定**：卓 X（−3 秒 60 秒麺・−1 秒 600 秒麺）と卓 Y（−2 秒 600 秒麺）で空き釜が Y の品目に渡る（AC 1.5）。採用済み B が Timer の無い釜 1 を 30〜90 秒で予約し A が boiled の釜 0 に「今」——A は動かず待つ（性質 4.1 の除外・AC 3.2）。釜 5 だけ空き・釜 0・1 が boiled で、A・B の再配分の後も C は「今」にならない（性質 4.7）。
- **性質**（`startable-placement.property`）：4.1（1 段目の「今」の先頭に今割当可能な釜が足りれば Startable_Slot に置かれる）、4.6（候補列・配分順・履歴・解放表を固定し `occupied` だけを変えても将来配置は同じ）、4.7（「今」の集合の不変・時刻は 1 段目以上）、4.5（既存の `schedule.property` / `commit.property` / `admit.property` / `lift-split` がそのまま通る）。
- **合成**（`commit.example`）：`startAt === now` で boiled の釜に置かれた採用済み一片が接頭辞から落ち、`startAt === now` で Timer の無い釜の一片は残る。
- **client**（`liftGroups.example`）：`occupiedSlots` の置換で結果が変わらない。

## naming ゲート（実装前にユーザー確認）

| 候補名 | 場所 | 表明する概念境界 |
| --- | --- | --- |
| `occupiedSlotsOf` | `src/domain/store.ts` | Timer の載っている釜（事実）。補集合が Startable_Slot |
| `pinNow` / `Pinned` | `src/engine/schedule.ts`（内部） | 1 段目の「今」の品目への配分と、2 段目が読む固定（配置・時刻の下限） |
| `cannotStart` | `src/engine/commit.ts`（内部） | 接頭辞の失効：過去開始 ∨ 開始を妨げる配置（`startAt ≤ now` かつ釜に Timer） |
| `operationScenes` | `tests/core/operationScenes.ts` | 連続処理の harness |

「今割当可能な釜」は `pinNow` の局所変数 `assignable` に留め、公開名にしない（解放表と `occupied` から毎回導く導出値）。

## 未決の決定（requirements の「未決」への答え）

1. 占有の述語は domain（`occupiedSlotsOf`）に一つ置き、client と engine が共有する。
2. 「候補の開始が now 以前」は 1 段目の結果（`startAt ≤ now`）で判定する。合流・batch の経路を問わない（配置の事実で見る）。
3. ゲートは変えない。合成の失効（Component 2）が閉じる。
4. 回帰は `tests/core/operationScenes.ts` の harness に置き、24 品の完了順の性質もそこから書く。
5. 2 段の組み方は Component 3（固定は接頭辞と同じ扱い・下限は `earliest` と合流可否に効かせる）。
