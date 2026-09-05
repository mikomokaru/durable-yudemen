# Requirements Document

## Introduction

本 spec は、開始推奨の**見せ方**を「釜ごとに次の 1 件」から「店舗全体で最早の同時に上げる群」へ改める。提案は時刻を語らず、**入れてよい瞬間に現れる**。現場が読むのは「まもなく」（薄）と「今」（濃）の二相だけで、順序は出現の順が語る。

前提は `lift-group-planning` である。あちらが「同じ卓の未着手の品目の `serveAt` が一致した計画」を出力するので、client は受け取った `startAt` と茹で秒から `serveAt` を再計算し、その等号で群を組める。ワイヤは変えない。

`slot-suggested-start`（#26）が据えた「提案は idle の釜カードにだけ現れ、そこが開始の口である」「品目を指して開始する」「商品名は POS 申告値」は変えない。変えるのは、どの提案を、いつ、どんな語で出すかである。`lapsed-suggestion-timing`（未マージ）は目的ごと本 spec に置き換わる。

> **設計意図の記録:** 本 spec と対になる spec を横断する判断は `docs/adr/`（ADR 0001・0004・0005）に残す。判断の「なぜ」はそちらが正本で、本書は要件への演繹だけを担う。

### 観測事実（実装前に確認済み・2026-09-05・main `bd81904`（#27 マージ後）＋ PR #28 `lift-group-planning` 時点）

1. `nextForSlot`（`src/client/components/slotDisplay.ts:125`・非公開）は釜ごとに、その釜を含む担当範囲内の提案のうち `startAt` 最小の 1 件を idle の `next`（`QueueSuggestion | null`・`:47`）に載せる。degraded では常に `null`（`:122`）。呼び出しは `assignedSlotDisplays`（`:106`）。
2. **#27 の時期表示。** `planAnchor`（`SlotBoard.tsx:82-85`）は受信した推奨の**全量**の最小 `startAt`。`suggestionTiming`（`queueDisplay.ts:61-70`）は `startAt − planAnchor`（計画内オフセット）と `max(0, planAnchor − Corrected_Now)`（錨までの秒読み）から 3 相を返し、`SlotBoard.tsx:262-270` が `in m:ss` / `now` / `+m:ss` と描く。放置すると錨が現在へ張り付き、1 本目は `now`、以降は `+m:ss` のまま動かない。本 spec はこの 3 相と `planAnchor` を撤去する。
3. idle カードは `actionRow`（`SlotCard.tsx:336-352`）に提案の丸ボタンと Start を並べ、`display.next !== null && suggestionOf !== undefined` のときだけ提案側を描く（`:337-338`）。押下は `onStartSuggested(next)`（`:347`）。
4. 提案の押下は `connection.startOrderItem(suggestion.slotIds, item)`（`SlotBoard.tsx:165`・`connection.ts:676`）で、品目の鍵と推奨の `slotIds` 全体を送る。**`startOrderItem` は `mode(view) !== "live"` なら何もせず戻る**（`connection.ts:1006-1010`・無反応）。アドホック開始 `start` は degraded でローカルに Timer を立てる（`:1016-`）。
5. `OrderRail.tsx` は開始の口を持たない（`onStart` の出現 0）。待ち行列は到着順の事実の一覧である。
6. `RadialMenu`（`RadialMenu.tsx:21, 29`）は麺種プリセットだけを並べ、選ぶとアドホック開始になる。接続状態を知らない。待ち行列の品目を指して始める口は釜側に無い。
7. `ClientView` は config から `unitCount` と `noodlePresets` だけを写し（`connection.ts:451-452`）、`unitOrigins` / `slotOffsets` を捨てている。釜どうしの距離は client に無い。
8. 釜距離 `slotDistance` は `src/engine/objective.ts:322` にあり、`GridPoint` / `UnitOrigin`（domain）だけを用いる。client は engine を import できない（依存方向）。
9. 茹で秒は `boilSecondsOf`（`queueDisplay.ts:142`・非公開）が `noodlePresets × order.firmness` で引く。計画側（`schedule.ts` の `toBoiling`）と同じ引き方で、`startAt + 茹で秒` は両端で整数ミリ秒として一致する。
10. `CookRecommendation`（`src/domain/messages.ts:22-31`）は `startAt` を運び `serveAt` を運ばない。**`TimerFact`（`src/domain/timer.ts:40-53`）は `id` / `slotIds` / `noodleType` / `firmness` / `startTime` / `endTime` だけを運び、`orderItem` も `tableId` も運ばない**（ADR-0003 は「走行中カードに卓を表示する必要が生じたとき、その spec が判断する」と本 spec へ委ねている）。ワイヤの `endTime` は実効値（`toWireTimer`・`project.ts:30` が adjustment を畳む）。
11. 既存テスト: `tests/client/slotSuggestion.{property,example}.test.ts`（`nextForSlot`）、`slot-card.example.test.tsx`（提案ボタン）、`order-rail.example.test.tsx`、**`lapsedSuggestion.example.test.tsx` / `suggestionTiming.property.test.ts`（#27 でマージ済み・本 spec で撤去）**。
12. **engine は開始時に釜の占有を検査しない。** `startOrderItemTimer`（`src/engine/start.ts:145-146`）は「釜の占有・推奨との一致・`slotIds` の数と `slotSpan` の一致は検査しない（AC 8.3）。提案からの重畳は『押す場所が idle にしかない』ことで client 側の構造が防ぐ」と明記する。複数釜の提案で一部の釜が走行中でも、送れば走行中の釜に新しい Timer が立つ（レビューで実測）。
13. **`lift-group-planning`（PR #28）の出力。** 走行中の仲間が在る卓の未着手は、走行中の実効 `endTime` を錨として `serveAt` を揃える（合流できる品目だけ・ADR-0007）。ゆえに「群の 1 本目が始まった」後も、残りの品目の `serveAt` は走行中の仲間の `endTime`（ワイヤの実効値）に一致する。自前解は茹で時間の長い品目から順に開始時刻を置く（`assignSlots`・byBoil 降順）。
14. **`lift-group-planning` からの申し送り（順序の事故）。** 群の中で `startAt` 順を違えて短い品目を先に入れると、残りの品目は錨に届かず群ごと遅い方へずれる。レビューの再現：茹で 510 / 360 / 330 秒の同卓 3 品（開始予定 0 / 150 / 180 秒）を誰も始めないまま 180 秒経つと全品が同じ `now` になり、330 秒の品目から始めると 510 秒に上がり、続けた 510 秒の品目は 690 秒に上がって同期しない。**薄い段階だけでなく濃い段階にも同じ問題がある。**

### 確定した設計判断（すべて本要件へ演繹する・2026-09-04 の対話で確定）

1. **出すのは店舗全体で最早の群だけ。** 群の順序は群の中で最も早い `startAt`。群の全員を出す（arms を超えていても）。他の群は出さない。
2. **群の識別は client の再計算。** `serveAt = startAt + 茹で秒` を計算し、等しいものを一群とする。許容幅で「近い」を判定しない。揃っていない品目は別の群になり、揃っていないものを揃っていると言う経路を持たない。
3. **提案は startAt の 60 秒前に薄く現れる。語は無い。** 60 秒は麺を準備する猶予であり、domain の定数とする。店舗差が実在するまで設定にしない。
4. **startAt が来たら濃くなり `now` と描く。** 時刻（`in mm:ss` / 壁時計 / 秒読み）は描かない。
5. **薄くても押せる。** 提案は指示ではない。早く入れれば Boil_Sync が吸収する。**判断 17 で「押せるのは群の先頭だけ」に絞った**——先頭は薄くても押せるが、先頭でない品目は薄くても濃くても押せない。
6. **走行中・茹で上がりのカードには何も出さない。** 釜が埋まっていて 60 秒前が走行中に来た品目は、釜が空いた（Complete された）時点で現れる。薄い段階が無いことがある。
7. **次の群は「現在の群の最初の 1 本が始まった」かつ「自身の 60 秒前が来た」で現れる。** 両方を満たす。同時に見える提案の数に上限を置かない。**「始まった」の事実は判断 16 で定める（ワイヤの `TimerFact.tableId`）。表示できる群の集合は判断 19 の Visible_Groups。**
8. **担当外の端末は空白。** Visible_Groups（判断 19）のどの品目も担当範囲の釜に無い端末には何も出ない。端末間の一致を単端末の可読性より上に置く。端末同士の同期機構は要らない——全端末が同じ snapshot から同じ集合を導く。
9. **群は可視化しない。** 同じ群であることを色や縁で示さない。出た順に入れれば結果として同時に上がる。
10. **ラジアルに店舗全体の待ち行列を足す。** 到着順に列挙し、選べば品目として開始する（待ち行列から消える）。`slotSpan` 2 の品目は押した釜と、そこから `affinityToleranceDistance` の内側で最も近い空き釜を自動で組にし、内側に無ければ選べない。麺種プリセットのアドホック開始は残す。
11. **レールは到着順のまま。** 計画順にしない（再評価のたびに並びが揺れる）。
12. **`slotDistance` を domain へ移す。** engine と client の両方が使うためで、GridPoint / UnitOrigin しか用いないため domain に置ける。`ClientView` は config の `unitOrigins` / `slotOffsets` を持つ。
13. **永続・config を変えない。ワイヤは `TimerFact.tableId` の 1 項目だけ足す（判断 16）。** engine の変更は `toWireTimer` がその 1 項目を写すことに限る。それ以外は client と domain（`slotDistance` の移設・定数の追加・ワイヤ復号の 1 項目）だけである。
14. **`lapsed-suggestion-timing` は #27 として main にマージ済み。** 当初「マージしない」としたが、実測でマージされていた（2026-09-04）。本 spec がその挙動（`planAnchor` / `suggestionTiming` による間隔の追随）を置き換える。観測事実は 2026-09-05 に #27 マージ後の main へ更新済み（観測事実 2・11）。

15. **複数釜の提案は、`slotIds` の全釜が idle のときだけ表示し、押せる（レビュー指摘 1・P1）。** engine は開始時に釜の占有を検査しない（観測事実 12）ので、「釜 0 は空き・釜 1 は 30 秒後に空く」2 釜の提案を釜 0 に出して押せれば、走行中の釜 1 にも Timer が立つ。端末は snapshot の全 Timer（担当外を含む）を持つので、受信済みの状態だけで判定できる。端末間の競合ではない。一部の釜が埋まっている間は提案を出さず、全釜が空いた時点で現れる（判断 6 の複数釜版）。

16. **「群の最初の 1 本が始まった」の事実は、走行中 Timer の卓で判定する。ワイヤの `TimerFact` に `tableId: string | null` を足す（レビュー指摘 2・P2）。** 開始した品目は推奨から消え、現行のワイヤは Timer に品目参照も卓も載せない（観測事実 10）ため、途中接続した端末は走行中 Timer がどの群のものか確定できず、端末ごとの履歴で補えば端末間一致が崩れる。判定に使える事実は次の 2 つで、後者を採る。(a) `serveAt` の等号——合流した群の `serveAt` は走行中の仲間の実効 `endTime` に一致する（観測事実 13）ので、「Next_Group の `serveAt` が走行中のいずれかの `endTime` と等しい」で判定できるが、無関係な Timer の `endTime` と偶然一致しうる（`release + boil` がたまたま別卓の `endTime` に当たる）偽陽性を持つ。(b) **`TimerFact.tableId`**——engine の Timer は既に卓を持つ（ADR-0003・永続 v10）ので、`toWireTimer` が 1 項目写すだけで、復号は欠如を null に畳む（追加は後方互換）。Group_Started(G) ⇔ G の卓が非 null で、かつ同じ卓の走行中（boiled でない）Timer が在る。卓を持たない品目は単独の群で、始まれば消えるだけ（「始まったまま残る」状態が無い）。**これは判断 13 の改訂であり、ADR-0003 が本 spec へ委ねた判断そのものである。**

17. **押せるのは群の先頭だけ。順は表示の変化ではなく、いま見えている形から読める（レビュー指摘 3・P2）。** Group_Head = 群の未着手のうち `startAt` 最小の品目（同値は全部——茹で時間が同じ品目は入れ替えても揃う）。先頭は薄くても押せる（判断 5）。先頭でない品目は、Prep_Lead が来ていれば薄く**見える**が押せない（丸ボタンを描かない・ラベルだけ）。濃くなるのは先頭だけである。放置して全品の `startAt` が過ぎても、先頭は 1 本（または同値の数本）で、出現の履歴を見ていない人にも次の投入対象が分かる。先頭を始めると計画が残りを走行中の錨へ組み直し、次の先頭が決まる。「薄い品目の中で順を示す」案（番号）は判断 9（群を可視化しない・番号を出さない）と衝突するので採らない。「薄い段階の押下を最早の 1 本に限る」案は濃い段階に同じ問題を残す（観測事実 14）ので、薄・濃を問わず先頭に限る。

18. **degraded では、ラジアルの待ち行列も出さない（レビュー指摘 4・P2）。** `startOrderItem` は非 live で何もせず戻る（観測事実 4）ので、品目を選べても調理は始まらない。提案を degraded で出さない既存の規律（判断 11 の AC 2.11）と同じ理由で、ラジアルの待ち行列は degraded で列挙しない。麺種プリセットのアドホック開始は degraded でもローカルに Timer を立てる既存経路（観測事実 4）ゆえ残す。

19. **表示できる群の集合（Visible_Groups）を定め、AC 2.8 と 2.10 の衝突を解く。** 群を「群の中で最も早い `startAt`」の昇順に G1, G2, … と並べる。Gk が表示可能なのは、k = 1 であるか、G1 … G(k−1) の**すべてが** Group_Started（判断 16）であるとき。表示可能な群の品目は、それぞれ自身の Prep_Lead（判断 3）と釜の idle（判断 15）を満たしたときに現れる。担当外の空白（判断 8）は Visible_Groups の全品目について判定する——Next_Group だけを見れば「G1 は担当外だが G2 は担当内」の端末が空白になり、AC 2.8 と衝突していた。

### スコープ外

- 計画の形（`lift-group-planning` が担う）。
- 走行中カードへの「次はこれ」の先出し（以前の判断のまま出さない）。
- 群の可視化・時刻の表示・順位の表示。
- レールからの開始（ラジアルの待ち行列がその役を担う）。
- `unitOrigins` / `slotOffsets` を用いた盤面のレイアウト変更（距離の計算に読むだけ）。

### tasks へ落とす作業項目

- `slot-suggested-start` の Requirement 1.2（釜ごとに `startAt` 最小）・2.3〜2.5（ラベルの時期）・判断 5（時期の相対表示）を本 spec が改めた旨を追記する。
- `online-cook-scheduling` design「`unitOrigins` / `slotOffsets` は現時点で用途なし」を改める。
- `tests/client/slotSuggestion.*.test.ts` を群の導出へ書き換える。
- `verified-wire-contract` の decoder（`toTimerFact`）と `tests/domain` の往復 property に `tableId` を足す。`docs/adr/0003` の Consequences を改訂する。

### naming ゲート（`naming.md`）

以下は公開シンボルであり、**実装前にユーザー確認を要する**。本 spec 内の表記は候補である。

| 候補名 | 場所 | 表明する概念境界 |
| --- | --- | --- |
| `PREP_LEAD_MS`（仮） | domain の定数 | 麺を準備する猶予。提案が薄く現れる startAt までの時間 |
| `Lift_Group` | 要件語彙（識別子にしない） | 同時に上げる群。client では `serveAt` の等号で組む |
| `nextGroup`（仮） | `slotDisplay.ts` または `queueDisplay.ts` の導出 | 店舗全体で最早の群。`nextForSlot` を置き換える |
| `SlotDisplay` idle の `next` の形 | `slotDisplay.ts` | 提案の相（薄 / 濃）を持つ。既存の `QueueSuggestion` に相を添えるか、別の型にするかは design |
| `slotDistance` | domain へ移設（`store.ts` 候補） | 釜どうしの距離。engine と client が共有 |
| `ClientView.unitOrigins` / `slotOffsets` | `connection.ts` | config から写す 2 項目（距離の計算に要る） |
| ラジアルの待ち行列の口 | `RadialMenu.tsx` | 品目を選んで開始する。名は design |
| `TimerFact.tableId` | `src/domain/timer.ts`（ワイヤ） | 走行中 Timer の由来する卓。群の開始の判定にだけ読む。engine の `orderItem.tableId` と同じ語 |
| `Group_Head` / `Visible_Groups` / `All_Idle` | 要件語彙（識別子は design） | 押せる先頭・表示できる群・全釜が空き |

### `lift-group-planning` からの申し送り

- **群の中で押す順は `startAt` 順である。** 自前解は茹で時間の長い品目から順に開始時刻を置くため、現れた順（濃くなった順）に押せば必ず走行中の錨に届く。順を違えて短い品目を先に入れると、残りの品目は錨に届かず、計画側の採点の帰結として群ごと遅い方へずれる（`lift-group-planning` 判断 5）。薄い品目が同時に複数見えるとき（茹で時間の差が 60 秒未満）、この順を表示が伝えない限り事故が日常化する。**→ 判断 17 で解決した（押せるのは群の先頭だけ・薄濃を問わず）。**

## Glossary

- **Lift_Group（同時に上げる群）**: `serveAt` が等しい提案の集合。client は `startAt + 茹で秒` で `serveAt` を再計算して組む。
- **Next_Group（次の群）**: 受信した推奨の全量から組んだ群のうち、最も早い `startAt` を持つ群。店舗全体で一つ。
- **Prep_Lead（準備の猶予）**: 提案が薄く現れる、`startAt` までの時間。60 秒。domain の定数。
- **Faint / Solid（薄 / 濃）**: 提案の二相。薄は `startAt − Prep_Lead ≤ now < startAt`、濃は `startAt ≤ now`。薄には語が無く、濃は `now`。
- **Group_Started（群の開始）**: 群の卓が非 null で、同じ `tableId` を持つ走行中（boiled でない）の `TimerFact` が在る状態。次の群が現れる条件の一つ。
- **Group_Head（群の先頭）**: 群の未着手のうち `startAt` 最小の品目（同値は全部）。押せるのは先頭だけ。
- **Visible_Groups（表示できる群）**: 群を最早 `startAt` 順に並べたとき、先頭の群と、それより前の群がすべて Group_Started である群の集合。
- **All_Idle（全釜が空き）**: 推奨の `slotIds` の全釜が idle（走行中・茹で上がり・unreceived でない）である状態。snapshot の全 Timer（担当外を含む）から判定する。
- **Corrected_Now**: client の実時刻にサーバとのオフセットを加えた時刻。
- **Order_Item_Start**: 品目の鍵と釜で開始する経路（`startOrderItem`）。提案の押下とラジアルの待ち行列の両方がこれを使う。

## Requirements

### Requirement 1: 群の導出

**User Story:** As a 厨房スタッフ, I want 次に入れる群が店舗で一つに決まる, so that どの端末を見ても同じ「次」が見える。

#### Acceptance Criteria

1. THE client SHALL 受信した推奨の全量（担当範囲で絞る前）から、各推奨の `serveAt` を `startAt + 茹で秒` で再計算する
2. THE client SHALL `serveAt` が等しい推奨を一つの Lift_Group とする（許容幅を用いない）
3. THE client SHALL 茹で秒を引けない推奨（品目が待ち行列に無い・麺種がプリセットに無い）を群に入れない
4. THE Next_Group SHALL 群の中で最も早い `startAt` が最小の群とする。同値は `entries` の順（到着順）で先のもの
5. THE client SHALL Next_Group をビューに保持せず、毎描画導出する
6. THE Next_Group の導出 SHALL 担当範囲・端末に依らず、同じ推奨の全量からは同じ群を返す
7. THE client SHALL 群の Group_Started を、群の卓が非 null で、かつ同じ `tableId` を持つ走行中（boiled でない）の `TimerFact` が snapshot に在ることで判定する。端末ごとの履歴・過去の描画・推奨の消失を判定に用いない
8. THE client SHALL Visible_Groups を、群を最早 `startAt` 順に並べたときの先頭の群と、それより前の群がすべて Group_Started である群の集合として導く
9. THE client SHALL 各群の Group_Head を、群の未着手のうち `startAt` 最小の品目（同値は全部）として導く
10. THE Group_Started / Visible_Groups / Group_Head の導出 SHALL 担当範囲・端末に依らず、同じ snapshot からは同じ結果を返す

_出所: 判断 1・2・8・16・17・19, 観測事実 9・10・13_

### Requirement 2: 提案の出現

**User Story:** As a 厨房スタッフ, I want 入れてよい瞬間に釜の上に提案が現れる, so that 時刻を読まずに動ける。

#### Acceptance Criteria

1. WHEN 担当スロットが idle で、Visible_Groups の品目がその釜を `slotIds` に含み、当該推奨の `slotIds` の全釜が idle（All_Idle）で、`Corrected_Now ≥ startAt − Prep_Lead` である, THE Slot_Card SHALL 当該品目を提案として表示する
2. WHILE 提案が Group_Head で、`startAt − Prep_Lead ≤ Corrected_Now < startAt`, THE Slot_Card SHALL 提案を薄く描き、語を添えず、丸ボタンを描く
3. WHILE 提案が Group_Head で、`Corrected_Now ≥ startAt`, THE Slot_Card SHALL 提案を濃く描き、`now` と添え、丸ボタンを描く
4. WHILE 提案が Group_Head でない, THE Slot_Card SHALL 提案を薄く描き、語を添えず、丸ボタンを描かない（`Corrected_Now ≥ startAt` でも濃くしない）
5. THE Slot_Card SHALL 提案に時刻（`in mm:ss`・壁時計・秒読み・`+mm:ss`）を添えない
6. WHILE 担当スロットが running / boiled / unreceived である, THE Slot_Card SHALL 提案を一切表示しない
7. WHILE 推奨の `slotIds` のいずれかの釜が idle でない, THE Slot_Card SHALL 当該推奨をどの釜にも表示しない（一部の釜が空いていても出さない）
8. WHEN 釜が埋まっている間に `startAt − Prep_Lead` が過ぎた品目の全釜が idle になる, THE Slot_Card SHALL その時点で提案を表示する（薄い段階が無いことがある）
9. WHILE ある群より前の群に Group_Started でないものが在る, THE Slot_Card SHALL その群の品目を表示しない
10. WHEN ある群より前の群がすべて Group_Started になり、かつ 当該群の品目の `startAt − Prep_Lead` が来た, THE Slot_Card SHALL 当該群の品目を表示する
11. THE client SHALL 同時に表示する提案の数に上限を置かない
12. WHEN Visible_Groups のどの品目も端末の担当範囲の釜に無い, THE Slot_Board SHALL 提案を一切表示しない
13. WHILE Timer_Connection が degraded Mode である, THE Slot_Card SHALL 提案を表示しない
14. WHERE 1 件の推奨が複数の釜を含み All_Idle である, THE Slot_Card SHALL 含まれる各釜に同じ提案を表示する

_出所: 判断 3・4・6・7・8・15・17・19, 観測事実 1・3・12_

### Requirement 3: 提案の操作と語

**User Story:** As a 厨房スタッフ, I want 薄い提案も押せば始まる, so that 機械に待たされない。

#### Acceptance Criteria

1. WHEN ユーザーが Group_Head の提案（薄・濃を問わず）を押す, THE Timer_Connection SHALL 当該品目の鍵と推奨の `slotIds` 全体で Order_Item_Start を要求する
2. THE Slot_Card SHALL 提案が同じ群に属することを色・縁・番号で示さない
3. THE Slot_Card SHALL 提案の語に命令形を用いない。濃の語は `now` のみ
4. THE Slot_Card SHALL 提案の aria-label に品目・釜と、薄か濃かを含める。可視の語と食い違わない
5. THE Slot_Card SHALL 提案の丸ボタン・ラベル（商品名・麺量・茹で加減・卓）・Start の配置を `slot-suggested-start` の形のまま保つ
6. THE Slot_Card SHALL Group_Head でない提案に押す口を持たない（丸ボタンを描かない）。ラベルは Group_Head と同じ形で描く
7. THE Slot_Card SHALL 提案の aria-label に、押せる（Group_Head）か否かを含める

_出所: 判断 5・9・17, 観測事実 3・4・14_

### Requirement 4: ラジアルの待ち行列

**User Story:** As a 厨房スタッフ, I want 提案されていない注文も釜から品目として始められる, so that 待ち行列に品目が残らない。

#### Acceptance Criteria

1. THE Radial_Menu SHALL 店舗全体の待ち行列の品目を到着順に列挙する
2. WHEN ユーザーが待ち行列の品目を選ぶ, THE Timer_Connection SHALL 当該品目の鍵と釜で Order_Item_Start を要求する
3. WHEN 選んだ品目の `slotSpan` が 1, THE Timer_Connection SHALL 押した釜だけで開始する
4. WHEN 選んだ品目の `slotSpan` が 2 以上, THE client SHALL 押した釜と、そこから `affinityToleranceDistance` の内側で最も近い idle の釜を `slotSpan` 個になるまで組にする
5. IF `affinityToleranceDistance` の内側に足りる idle の釜が無い, THEN THE Radial_Menu SHALL 当該品目を選べない状態で示す
6. THE Radial_Menu SHALL 麺種プリセット（アドホック開始）を残す
7. THE client SHALL 釜の距離を domain の `slotDistance` と config の `unitOrigins` / `slotOffsets` から導く
8. WHILE Timer_Connection が degraded Mode である, THE Radial_Menu SHALL 待ち行列の品目を列挙しない（麺種プリセットは列挙する）
9. THE Radial_Menu SHALL 選んでも開始されない品目を選べる形で示さない（非 live・釜が足りない、のいずれも）

_出所: 判断 10・12・18, 観測事実 4・6・7・8_

### Requirement 5: 不変点と、ワイヤへの 1 項目

**User Story:** As a 設計者, I want 本変更がワイヤと engine に及ぶ範囲を 1 項目に限りたい, so that 表示の判断が契約を動かさない。

#### Acceptance Criteria

1. THE 変更 SHALL ワイヤ契約の変更を `TimerFact` への `tableId: string | null` の追加に限る。`CookRecommendation` / `ClientMessage` / `ServerMessage` の他の項目は変更しない
2. THE ワイヤ復号（`domain/wire.ts` の `toTimerFact`） SHALL `tableId` の欠如と null を null に畳み、空文字と非文字列を復号失敗とする（`verified-wire-contract` の規律・engine の `reviveOrderItem` と同じ判定）
3. THE 変更 SHALL `src/engine` の変更を `toWireTimer` が `orderItem?.tableId ?? null` を写すことに限る。計画・採点・遷移・永続スキーマを変更しない
4. THE 変更 SHALL `StoreConfig` を変更しない
5. THE 変更 SHALL レールの並び（到着順）と内容を変更しない
6. THE 変更 SHALL 提案の出現に Alarm・`setInterval`・時刻起動を用いず、既存の毎描画導出だけで行う
7. THE 変更 SHALL `slotDistance` の算術を移設のみで変更しない
8. THE 変更 SHALL 走行中カードの見え方を変更しない（`tableId` は群の開始の判定にだけ読む。表示は別の判断）

_出所: 判断 11・12・13・16_

### Requirement 6: 検証可能な性質

**User Story:** As a 保守者, I want 群の導出と出現の規則を性質として固定したい。

#### Acceptance Criteria

1. **群の等号** — 同じ Lift_Group の任意の 2 推奨は `startAt + 茹で秒` が等しく、異なる群の 2 推奨は等しくない
2. **一意** — 同じ推奨の全量から、担当範囲・端末に依らず同じ Next_Group が導かれる
3. **単調な出現** — 状態変化のない区間で Corrected_Now が進むとき、一度現れた提案は消えず、薄から濃へ一方向に変わる
4. **時刻不在** — 提案の可視の語は空か `now` のみである
5. **群の境界** — ある群より前の群に Group_Started でないものが在る限り、その群の品目が表示されることはない
6. **担当外の空白** — Visible_Groups の全品目が担当外の釜にあるとき、表示される提案は 0 件である
7. **距離の一致** — client が用いる `slotDistance` は engine の目的関数が用いるものと同一の関数である
8. **全釜 idle** — 表示される提案の `slotIds` の全釜は idle である（一部の釜が走行中の推奨は、どの釜にも表示されない）
9. **先頭の一意** — 任意の snapshot と時刻で、押せる提案（丸ボタンを持つ）は各群につき `startAt` 最小の品目（同値は全部）だけである。放置して全品の `startAt` が過ぎても変わらない
10. **開始の事実の一意** — Group_Started は snapshot（走行中の `tableId`）だけから決まり、途中接続した端末と接続し続けた端末で一致する
11. **非 live の沈黙** — degraded では、提案もラジアルの待ち行列も表示されず、`startOrderItem` が呼ばれることがない

_出所: 判断 1・2・3・4・7・8・12・15・16・17・18・19_

### Requirement 7: 文書の整合

**User Story:** As a 保守者, I want 先行 spec の記述が本変更後に嘘にならない。

#### Acceptance Criteria

1. WHEN 本 spec を実装する, THE 変更 SHALL `slot-suggested-start` の Requirement 1.2・2.3〜2.5・判断 5 に本 spec が改めた旨を同じコミットで追記する
2. THE 変更 SHALL `online-cook-scheduling` design の「`unitOrigins` / `slotOffsets` は現時点で用途なし」を改める
3. THE 変更 SHALL `lapsed-suggestion-timing` の requirements 冒頭に、本 spec が置き換える旨を追記し、`suggestionTiming` / `planAnchor` とそのテストを撤去する
4. THE 変更 SHALL ADR-0003 の「`TimerFact` には出さない」に、本 spec が `tableId` を群の開始の判定のために出すことにした旨を追記する（Consequences の改訂）

_出所: tasks へ落とす作業項目, 判断 14_
