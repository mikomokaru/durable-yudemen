# Requirements Document

## Introduction

走行中のスロットカードに、**茹で上がる順の番号**を出す。置き場所はカード左上の麺種バッジの prefix マーカー（いま走行中は点滅ドット、茹で上がりは ✓）で、走行中のドットを番号に置き換える。調理者が「次に上げるのはどれか」を釜の並びに依らず一目で追えるようにする（ユーザー要望・2026-09-07）。

**前提に `order-lifecycle`（2026-09-07）を置く**：品目は生涯を通じて残り、`TimerFact.orderItem` が Timer → 品目の参照を運ぶ。本 spec の判断 2′（wire に `externalOrderId` を足す）はそちらに吸収し、番号・卓・品名は参照で引く。前提は `lift-group-display`（群・先頭・全釜 idle は店舗全体で判定）、`synchronized-boil-adjustment`（実効 endTime＝Boil_Sync の調整後）、`sync-set-batch-complete`（同じ実効 endTime の Sync_Set は一括で上がる）。

### 観測事実（2026-09-07・main `Merge #37` 時点）

1. スロットカードの左上は麺種バッジ（`SlotCard.tsx` `NoodleBadge`）で、prefix マーカーは `boiling`（点滅ドット）／`ready`（✓）／`last`（✓・残滓）／`none`。マーカーは「identity は色、状態はマーカー」の分担で、aria-label は `Boiling: ` / `Ready: ` / `Last: ` の接頭辞を付ける。
2. 表示状態は `slotDisplay.ts` `assignedSlotDisplays(view, units, now, bySlot)` が担当スロットごとに導出する（running＝残り > 0・boiled＝残り ≤ 0・idle・unreceived）。担当外の Timer は `assignedTimers` で構造的に現れない。1 Timer は複数釜を駆動しうる（大盛）。
3. wire の `TimerFact.endTime` は実効 endTime（Boil_Sync の調整込み）。同じ Sync_Set の Timer は同じ実効 endTime を持ち、一括完了の対象になる。
6. **wire の `TimerFact` は注文を運ばない。** engine の `Timer.orderItem { externalOrderId, itemIndex, tableId }` は永続 v10 の事実だが、`toWireTimer`（`project.ts:30`）は `id / slotIds / noodleType / firmness / startTime / endTime` だけを写す。ADR-0003 は「client ワイヤには出さない」を、`lift-group-display` が一度出して読み手が無くなったので撤去した、と記す（読み手が現れれば出してよい）。`pendingOrders` は既に `externalOrderId` / `tableId` を wire に載せている（POS 由来の業務データとして扱い済み・`wire.ts:373`）。
4. 群・先頭・連鎖は店舗全体で判定する（`lift-group-display` AC 1.6 / 2.12）。担当範囲で絞るのは表示だけ。
5. 残り時間は状態に持たず毎描画 `now` から導く（要件 12.2 の思想）。

### 確定した設計判断（案・レビューで確定）

1. **番号は「実効 endTime の昇順」の順位で、店舗全体で振る。** 担当ユニットの内側で振ると、別ユニットの釜が先に上がるのに 1 番と出る。先頭・群と同じく店舗全体で判定し、担当範囲は表示だけで絞る（観測事実 4 と同じ規律）。
2. **番号の単位は「同じ実効 endTime かつ同じ注文」（ユーザー確定・2026-09-07）。** 同じ Sync_Set でも注文が違えば別の番号にする——上げるタイミングは同じでも、盛り付けと配膳は注文ごとに分かれるからである。同じ注文の同じ実効 endTime の Timer（大盛の 2 釜、同じ注文の 2 品）は同じ番号。番号は密（dense）に振る——1・1・2・3 であって 1・1・3・4 ではない。番号は「上げて盛る回」を表し、本数ではない。**同じ実効 endTime の中の注文の順**は、その注文の Timer のうち最早の `startTime`（先に始めた注文が先）、同値は `externalOrderId` の符号単位順で断つ（決定的）。注文を持たない Timer（アドホック開始）は 1 本 1 単位。
2′. **wire の `TimerFact` に注文の識別子を足す。** client が注文で区別するには事実が要る。`toWireTimer` に `externalOrderId: string | null`（アドホックは null）を写し、client は番号をそこから導く。`itemIndex` と `tableId` は出さない（この spec の読み手が無い。卓で分けたければ別の判断）。ADR-0003 の Consequences を改訂する（読み手が現れたので `externalOrderId` だけを出す）。番号そのものはワイヤに載せない（導出値・観測事実 5 の規律）。`verified-wire-contract` の関門（`wire.ts` の decode）に `externalOrderId` の検証（string か null）を足す。
3. **対象は走行中（残り > 0）だけ。** 茹で上がり（boiled）は ✓ のまま（もう上がっている）。残滓は ✓ のまま。
4. **番号はマーカーの置き換え**であり、新しい要素を足さない。走行中の点滅ドットを番号に替える（点滅は番号に引き継がない——番号が点滅すると読みにくい）。aria-label は `Boiling 2: Thin` の形。
5. **複数釜を駆動する Timer は 1 本として数え、駆動する各釜のカードに同じ番号を出す。** 同じ注文の別の Timer が同じ実効 endTime なら同じ番号（判断 2）。
6. **導出値であり保持しない。** 描画のたびに `view.timers` と `now` から導く純粋関数（`slotDisplay.ts` に置き、`SlotDisplay.running` に番号を載せる）。ローカルの未確定 Timer（provisional）も同じ規則で数える（best effort・確定で揃う）。
7. 番号は 1 始まり。最大は走行中の本数。二桁は想定するが三桁は想定しない（釜は最大 24）。

### スコープ外

- 茹で上がり（boiled）や残滓への番号。
- 卓（`tableId`）や品目（`itemIndex`）での区別。wire に出すのは `externalOrderId` だけ。
- 音・ラジアル・左レールへの番号の表示。
- 「次に上げる」の順番と、計画（`lift-group-planning`）の提案の順との関係付け（計画は開始の順、これは上がりの順）。

## Glossary

- **Lift_Order（上がり順）**: 走行中 Timer を「実効 endTime の昇順 → 同じ実効 endTime の中では注文の順（最早 startTime → externalOrderId）」に並べ、同じ実効 endTime かつ同じ注文を一単位とした密な順位（1 始まり）。店舗全体で一つ。
- **Lift_Unit（上げて盛る回）**: 同じ実効 endTime かつ同じ注文の走行中 Timer の組。アドホックの Timer は 1 本で 1 単位。
- **Marker（マーカー）**: 麺種バッジの prefix 記号。identity（色）と分けて状態を示す。

## Requirements

### Requirement 1: 上がり順の導出

1. THE client SHALL 走行中（残り > 0）の Timer 全件（担当外を含む店舗全体）を Lift_Unit（同じ実効 endTime かつ同じ注文。アドホックは 1 本 1 単位）に束ね、単位を「実効 endTime の昇順 → 単位内の最早 `startTime` の昇順 → `externalOrderId` の符号単位順」に並べた密な順位 Lift_Order（1 始まり）を導く純粋関数を一つ持つ
6. THE wire の `TimerFact` SHALL `externalOrderId: string | null` を運ぶ（`toWireTimer` が `Timer.orderItem?.externalOrderId ?? null` を写す）。`itemIndex` / `tableId` は運ばない。decode（`wire.ts`）は string か null 以外を落とす
7. THE 番号 SHALL ワイヤに載せない（client の導出値）
2. THE Lift_Order SHALL 描画のたびに `view.timers` と `now` から導き、状態にもワイヤにも永続にも持たない
3. THE 複数釜を駆動する Timer SHALL 1 本として数える（駆動する各釜に同じ番号）
4. THE 茹で上がり（残り ≤ 0）の Timer SHALL Lift_Order の対象にしない（番号を持たない）
5. THE `SlotDisplay.running` SHALL その釜の Timer の Lift_Order を載せる

### Requirement 2: 表示

1. THE 走行中のスロットカード SHALL 麺種バッジのマーカーに Lift_Order の番号を出す（点滅ドットを置き換える。番号は点滅しない）
2. THE 茹で上がりのカード SHALL ✓ のまま、残滓のバッジ SHALL ✓ のまま
3. THE aria-label SHALL `Boiling {n}: {noodleType}` の形にする
4. THE 番号 SHALL 麺色とは独立の記号として、バッジの文字色（濃色）で出す

### Requirement 3: 検証可能な性質

1. **順序**：番号 i のカードの実効 endTime ≤ 番号 j のカードの実効 endTime（i < j）
2. **同時・同注文**：実効 endTime が等しく注文も同じ Timer は同じ番号。実効 endTime が等しくても注文が違えば番号が違う
2′. **注文の順**：同じ実効 endTime の中では、最早 `startTime` の早い注文が小さい番号
3. **密**：出ている番号の集合は 1..k の連続（k は Lift_Unit の数）
4. **店舗全体**：担当ユニットを変えても、同じ Timer の番号は変わらない
5. **複数釜**：同じ Timer を駆動する釜のカードは同じ番号
6. **不変**：番号の導入で群・先頭・提案・音・残り時間の表示は変わらない。`TimerFact` に `externalOrderId` が増えても既存の decode・表示・永続（client は Timer を永続しない）は変わらない
7. **往復**：`externalOrderId` は wire の encode → decode で保たれ、null（アドホック）も保たれる

### naming ゲート（`naming.md`）

| 候補名 | 場所 | 表明する概念境界 |
| --- | --- | --- |
| `Lift_Order` / `liftOrderOf(timers, now, offset)`（仮） | 要件語彙 / `src/client/components/slotDisplay.ts` | 走行中 Timer の上がり順（密な順位・店舗全体・導出値） |
| `Lift_Unit`（仮） | 要件語彙のみ | 同じ実効 endTime かつ同じ注文の組（上げて盛る回） |
| `TimerFact.externalOrderId`（仮） | `src/domain/timer.ts` / `project.ts` / `wire.ts` | Timer の由来する注文（null＝アドホック）。番号の単位を切る事実 |
| `SlotDisplay.running.liftOrder`（仮） | `slotDisplay.ts` | 釜のカードに出す番号 |

### 未決（レビューで決める）

1. 番号を店舗全体で振るか（推奨）担当ユニット内で振るか。
2. ~~同じ実効 endTime を同じ番号にするか~~ → 同じ実効 endTime かつ同じ注文を同じ番号にする（ユーザー確定）。同じ実効 endTime の中の注文の順の断ち方（推奨：最早 `startTime` → `externalOrderId`）。
3. 未確定（provisional）の Timer を数えるか（推奨：数える）。
