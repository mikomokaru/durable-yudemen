# Requirements Document

## Introduction

本 spec は、開始推奨の**見せ方**を「釜ごとに次の 1 件」から「店舗全体で最早の同時に上げる群」へ改める。提案は時刻を語らず、**入れてよい瞬間に現れる**。現場が読むのは「まもなく」（薄）と「今」（濃）の二相だけで、順序は出現の順が語る。

前提は `lift-group-planning` である。あちらが「同じ卓の未着手の品目の `serveAt` が一致した計画」を出力するので、client は受け取った `startAt` と茹で秒から `serveAt` を再計算し、その等号で群を組める。ワイヤは変えない。

`slot-suggested-start`（#26）が据えた「提案は idle の釜カードにだけ現れ、そこが開始の口である」「品目を指して開始する」「商品名は POS 申告値」は変えない。変えるのは、どの提案を、いつ、どんな語で出すかである。`lapsed-suggestion-timing`（未マージ）は目的ごと本 spec に置き換わる。

> **設計意図の記録:** 本 spec と対になる spec を横断する判断は `docs/adr/`（ADR 0001・0004・0005）に残す。判断の「なぜ」はそちらが正本で、本書は要件への演繹だけを担う。

### 観測事実（実装前に確認済み・2026-09-04・#26 `8904e40` 時点）

1. `nextForSlot`（`src/client/components/slotDisplay.ts:125`）は釜ごとに、その釜を含む提案のうち `startAt` 最小の 1 件を idle の `next` に載せる。degraded では `null`（`:130`）。
2. 時期は `suggestionOf`（`src/client/components/SlotBoard.tsx:223, 239-240`）が `startAt − correctedNow` から `now` / `in mm:ss` と描く。放置すると全提案が `now` に収束する（`lapsed-suggestion-timing` の観測事実）。
3. idle カードは `actionRow`（`src/client/components/SlotCard.tsx:84`）に提案の丸ボタンと Start を並べ、`display.next !== null` のときだけ提案側を描く（`:337`）。
4. 提案の押下は `connection.startOrderItem(suggestion.slotIds, item)`（`SlotBoard.tsx:145`・`connection.ts:676`）で、品目の鍵と推奨の `slotIds` 全体を送る。
5. `OrderRail.tsx` は開始の口を持たない（`onStart` の出現 0）。待ち行列は到着順の事実の一覧である。
6. `RadialMenu`（`src/client/components/RadialMenu.tsx:21, 29`）は麺種プリセットだけを並べ、選ぶとアドホック開始になる。待ち行列の品目を指して始める口は釜側に無い。
7. `ClientView` は config から `unitCount` と `noodlePresets` だけを写し（`connection.ts:452`）、`unitOrigins` / `slotOffsets` を捨てている（`online-cook-scheduling` design「現時点で用途なし」）。釜どうしの距離は client に無い。
8. 釜距離 `slotDistance` は `src/engine/objective.ts:249` にあり、`GridPoint` / `UnitOrigin`（domain）だけを用いる。client は engine を import できない（依存方向）。
9. 茹で秒は `boilSecondsOf`（`queueDisplay.ts`）が `noodlePresets × order.firmness` で引く。計画側（`schedule.ts:453`）と同じ引き方で、`startAt + 茹で秒` は両端で整数ミリ秒として一致する。
10. `CookRecommendation`（`src/domain/messages.ts:22-31`）は `startAt` を運び `serveAt` を運ばない。
11. 既存テスト: `tests/client/slotSuggestion.{property,example}.test.ts`（`nextForSlot`）、`slot-card.example.test.tsx`（提案ボタン）、`order-rail.example.test.tsx`。`lapsedSuggestion.example.test.tsx` / `suggestionTiming.property.test.ts` は未マージのブランチにある。

### 確定した設計判断（すべて本要件へ演繹する・2026-09-04 の対話で確定）

1. **出すのは店舗全体で最早の群だけ。** 群の順序は群の中で最も早い `startAt`。群の全員を出す（arms を超えていても）。他の群は出さない。
2. **群の識別は client の再計算。** `serveAt = startAt + 茹で秒` を計算し、等しいものを一群とする。許容幅で「近い」を判定しない。揃っていない品目は別の群になり、揃っていないものを揃っていると言う経路を持たない。
3. **提案は startAt の 60 秒前に薄く現れる。語は無い。** 60 秒は麺を準備する猶予であり、domain の定数とする。店舗差が実在するまで設定にしない。
4. **startAt が来たら濃くなり `now` と描く。** 時刻（`in mm:ss` / 壁時計 / 秒読み）は描かない。
5. **薄くても押せる。** 提案は指示ではない。早く入れれば Boil_Sync が吸収する。
6. **走行中・茹で上がりのカードには何も出さない。** 釜が埋まっていて 60 秒前が走行中に来た品目は、釜が空いた（Complete された）時点で現れる。薄い段階が無いことがある。
7. **次の群は「現在の群の最初の 1 本が始まった」かつ「自身の 60 秒前が来た」で現れる。** 両方を満たす。同時に見える提案の数に上限を置かない。
8. **担当外の端末は空白。** 最早の群が別ユニットの釜にある端末には何も出ない。端末間の一致を単端末の可読性より上に置く。端末同士の同期機構は要らない——全端末が同じ配列から同じ最小を取る。
9. **群は可視化しない。** 同じ群であることを色や縁で示さない。出た順に入れれば結果として同時に上がる。
10. **ラジアルに店舗全体の待ち行列を足す。** 到着順に列挙し、選べば品目として開始する（待ち行列から消える）。`slotSpan` 2 の品目は押した釜と、そこから `affinityToleranceDistance` の内側で最も近い空き釜を自動で組にし、内側に無ければ選べない。麺種プリセットのアドホック開始は残す。
11. **レールは到着順のまま。** 計画順にしない（再評価のたびに並びが揺れる）。
12. **`slotDistance` を domain へ移す。** engine と client の両方が使うためで、GridPoint / UnitOrigin しか用いないため domain に置ける。`ClientView` は config の `unitOrigins` / `slotOffsets` を持つ。
13. **ワイヤ・engine・永続・config を変えない。** 変わるのは client と domain（`slotDistance` の移設・定数の追加）だけである。
14. **`lapsed-suggestion-timing` は #27 として main にマージ済み。** 当初「マージしない」としたが、実測でマージされていた（2026-09-04）。本 spec がその挙動（`planAnchor` / `suggestionTiming` による間隔の追随）を置き換える。観測事実 1〜2・11 は #26 時点の行番号で書かれているため、design の前に #27 の実装（`suggestionTiming` / `planAnchor`）を観測事実へ足す。

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

### `lift-group-planning` からの申し送り

- **群の中で押す順は `startAt` 順である。** 自前解は茹で時間の長い品目から順に開始時刻を置くため、現れた順（濃くなった順）に押せば必ず走行中の錨に届く。順を違えて短い品目を先に入れると、残りの品目は錨に届かず、計画側の採点の帰結として群ごと遅い方へずれる（`lift-group-planning` 判断 5）。薄い品目が同時に複数見えるとき（茹で時間の差が 60 秒未満）、この順を表示が伝えない限り事故が日常化する。**薄い段階の押下を最早の 1 本に限るか、薄い品目の中で順を示すかは本 spec の design で決める**（時刻を出さない・群を可視化しないの判断は変えない）。

## Glossary

- **Lift_Group（同時に上げる群）**: `serveAt` が等しい提案の集合。client は `startAt + 茹で秒` で `serveAt` を再計算して組む。
- **Next_Group（次の群）**: 受信した推奨の全量から組んだ群のうち、最も早い `startAt` を持つ群。店舗全体で一つ。
- **Prep_Lead（準備の猶予）**: 提案が薄く現れる、`startAt` までの時間。60 秒。domain の定数。
- **Faint / Solid（薄 / 濃）**: 提案の二相。薄は `startAt − Prep_Lead ≤ now < startAt`、濃は `startAt ≤ now`。薄には語が無く、濃は `now`。
- **Group_Started（群の開始）**: 現在の Next_Group の最初の 1 本が始まった状態。次の群が現れる条件の一つ。
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

_出所: 判断 1・2・8, 観測事実 9・10_

### Requirement 2: 提案の出現

**User Story:** As a 厨房スタッフ, I want 入れてよい瞬間に釜の上に提案が現れる, so that 時刻を読まずに動ける。

#### Acceptance Criteria

1. WHEN 担当スロットが idle で、Next_Group の品目がその釜を `slotIds` に含み、`Corrected_Now ≥ startAt − Prep_Lead` である, THE Slot_Card SHALL 当該品目を提案として表示する
2. WHILE `startAt − Prep_Lead ≤ Corrected_Now < startAt`, THE Slot_Card SHALL 提案を薄く描き、語を添えない
3. WHILE `Corrected_Now ≥ startAt`, THE Slot_Card SHALL 提案を濃く描き、`now` と添える
4. THE Slot_Card SHALL 提案に時刻（`in mm:ss`・壁時計・秒読み）を添えない
5. WHILE 担当スロットが running / boiled / unreceived である, THE Slot_Card SHALL 提案を一切表示しない
6. WHEN 釜が埋まっている間に `startAt − Prep_Lead` が過ぎた品目の釜が idle になる, THE Slot_Card SHALL その時点で提案を表示する（薄い段階が無いことがある）
7. WHILE Next_Group の最初の 1 本が始まっていない, THE Slot_Card SHALL 次の群の品目を表示しない
8. WHEN Next_Group の最初の 1 本が始まり、かつ 次の群の品目の `startAt − Prep_Lead` が来た, THE Slot_Card SHALL 次の群の品目を表示する
9. THE client SHALL 同時に表示する提案の数に上限を置かない
10. WHEN Next_Group のどの品目も端末の担当範囲の釜に無い, THE Slot_Board SHALL 提案を一切表示しない
11. WHILE Timer_Connection が degraded Mode である, THE Slot_Card SHALL 提案を表示しない
12. WHERE 1 件の推奨が複数の釜を含む, THE Slot_Card SHALL 含まれる各 idle 釜に同じ提案を表示する

_出所: 判断 3・4・6・7・8, 観測事実 1・3_

### Requirement 3: 提案の操作と語

**User Story:** As a 厨房スタッフ, I want 薄い提案も押せば始まる, so that 機械に待たされない。

#### Acceptance Criteria

1. WHEN ユーザーが提案（薄・濃を問わず）を押す, THE Timer_Connection SHALL 当該品目の鍵と推奨の `slotIds` 全体で Order_Item_Start を要求する
2. THE Slot_Card SHALL 提案が同じ群に属することを色・縁・番号で示さない
3. THE Slot_Card SHALL 提案の語に命令形を用いない。濃の語は `now` のみ
4. THE Slot_Card SHALL 提案の aria-label に品目・釜と、薄か濃かを含める。可視の語と食い違わない
5. THE Slot_Card SHALL 提案の丸ボタン・ラベル（商品名・麺量・茹で加減・卓）・Start の配置を `slot-suggested-start` の形のまま保つ

_出所: 判断 5・9, 観測事実 3・4_

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

_出所: 判断 10・12, 観測事実 6・7・8_

### Requirement 5: 不変点

**User Story:** As a 設計者, I want 本変更がワイヤと engine に及ばない, so that 表示の判断が契約を動かさない。

#### Acceptance Criteria

1. THE 変更 SHALL ワイヤ契約（`CookRecommendation` / `ServerMessage` / `ClientMessage`）を変更しない
2. THE 変更 SHALL `src/engine` を変更しない
3. THE 変更 SHALL 永続スキーマと `StoreConfig` を変更しない
4. THE 変更 SHALL レールの並び（到着順）と内容を変更しない
5. THE 変更 SHALL 提案の出現に Alarm・`setInterval`・時刻起動を用いず、既存の毎描画導出だけで行う
6. THE 変更 SHALL `slotDistance` の算術を移設のみで変更しない

_出所: 判断 11・12・13_

### Requirement 6: 検証可能な性質

**User Story:** As a 保守者, I want 群の導出と出現の規則を性質として固定したい。

#### Acceptance Criteria

1. **群の等号** — 同じ Lift_Group の任意の 2 推奨は `startAt + 茹で秒` が等しく、異なる群の 2 推奨は等しくない
2. **一意** — 同じ推奨の全量から、担当範囲・端末に依らず同じ Next_Group が導かれる
3. **単調な出現** — 状態変化のない区間で Corrected_Now が進むとき、一度現れた提案は消えず、薄から濃へ一方向に変わる
4. **時刻不在** — 提案の可視の語は空か `now` のみである
5. **群の境界** — 現在の Next_Group の最初の 1 本が始まる前に、次の群の品目が表示されることはない
6. **担当外の空白** — Next_Group の全品目が担当外の釜にあるとき、表示される提案は 0 件である
7. **距離の一致** — client が用いる `slotDistance` は engine の目的関数が用いるものと同一の関数である

_出所: 判断 1・2・3・4・7・8・12_

### Requirement 7: 文書の整合

**User Story:** As a 保守者, I want 先行 spec の記述が本変更後に嘘にならない。

#### Acceptance Criteria

1. WHEN 本 spec を実装する, THE 変更 SHALL `slot-suggested-start` の Requirement 1.2・2.3〜2.5・判断 5 に本 spec が改めた旨を同じコミットで追記する
2. THE 変更 SHALL `online-cook-scheduling` design の「`unitOrigins` / `slotOffsets` は現時点で用途なし」を改める
3. THE 変更 SHALL `lapsed-suggestion-timing` の requirements 冒頭に、本 spec が置き換える旨を追記し、`suggestionTiming` / `planAnchor` とそのテストを撤去する

_出所: tasks へ落とす作業項目, 判断 14_
