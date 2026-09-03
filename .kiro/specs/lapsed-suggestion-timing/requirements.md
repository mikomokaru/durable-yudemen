# Requirements Document

## Introduction

本 spec は、開始推奨（Cook_Recommendation）の**時期の描き方**を定義する。放置された提案が「now」へ収束するのをやめ、計画の間隔を保ったまま現在時刻へ追随させる。

推奨は `online-cook-scheduling`（Requirement 8）が定義したとおり提案であって指示ではない。`slot-suggested-start` はそれを空いている釜のカードへ移した。本 spec はどちらの立場も変えない。変えるのは**時期という 1 つの文字列をどう導くか**だけである。

現状は 1 つの嘘を抱えている。同じ瞬間に、画面は「now, now, now」と描き、サーバに問えば「now, +02:00, +02:30」と答える（釜が空いていれば。条件は観測事実 5）。放置とは状態変化がないことで、状態変化がなければ snapshot は届かず、client は最初に受け取った絶対時刻を引き算し続ける。時間が経てば全部が過去になり、全部が「now」になる。失われるのは**順序と間隔**——どれを先に落とすべきかという計画の中身であり、提供時刻を揃えるという計画の目的そのものである。

これを機構の追加ではなく、**時期を「受け取った絶対時刻」から「計画の間隔＋現在時刻」への導出に置き換える**ことで消す。設計哲学（`design-philosophy.md`）の「真 — 導出値を状態に昇格させない」「善 — 待つなら寝かせる」「美 — 引き算」の直接の帰結である。サーバは 1 行も変わらない。

### 観測事実（実装前に確認済み・2026-09-03）

1. 提案の時期は client が毎描画で導出している。`suggestionOf`（`src/client/components/SlotBoard.tsx:239-240`）が `suggestion.startAt - correctedNow(view.offset, now)` を取り、`0` 以下なら `now`、正なら `in ${formatRemaining(...)}`（＝ `in 02:00`） と描く。壁時計は用いていない。
2. 推奨の `startAt` は snapshot を作った瞬間の `now` を錨にした絶対時刻である。`initialRelease`（`src/engine/schedule.ts:185`）が空き釜の解放を `now` に置き、`placeBatch` が提供時刻を揃えるために `startAt = serveAt − 茹で時間` を引く。ゆえに同卓・同オーダーの品目は茹で時間の差だけ `startAt` がばらける。
3. `serveAt` は `max(earliest_i, tableFloor, orderFloor)` で決まる。`tableFloor = max(earliest) − tableSyncToleranceSeconds × 1000`、`orderFloor` はオーダーごとに `max(earliest_i − orderSyncToleranceSeconds × 1000)`。既定は順に 60 秒（`src/domain/store.ts:83`）と 30 秒（同 `:80`）。
4. snapshot は状態変化のときだけ broadcast される。放置は状態変化ではないので client の `startAt` は更新されない。サーバは次の状態変化で `hasLapsedStart`（`src/engine/commit.ts:116`・`startAt < now`）により過ぎた一片を切り、その時点の `now` を錨に引き直す。
5. **実測（2026-09-03）。** 卓 5・同一オーダー・つけ 510s / REG 360s / なんこつ 330s、**釜は全部空き・外部計画の採用なし（自前解のみ）**。投入直後は `+0s / +120s / +150s`。90 秒後に WS を張り直して読むと、新しい `now` を基準に再び `+0s / +120s / +150s`。**この条件下では、サーバは導出し直すたびに間隔を保ってずらして返す。** 条件を外れると成り立たない——採用済みの外部計画があれば `hasLapsedStart` が一片を切り、残りは自前解へ落ちて配置が変わりうる。走行中 Timer があれば釜の解放時刻が絶対時刻として残り、平行移動にならない。
6. `recommend`（`src/engine/recommend.ts:44`）は Effect を返さず、`now` を引数に取らない。サーバは時刻起動の失効判定を持たない（AC 7.5）。推奨開始時刻の到来で自動開始しない（AC 8.2）。
7. `.kiro/specs/online-cook-scheduling/design.md:466` の「過ぎた `startAt` はサーバの次回再評価で陳腐化として置き換わるまで過去時刻のまま表示される」は、client が単に引き算している現状の**帰結の記述**であり、EARS 形式の受入基準ではない。
8. `QueueSuggestion`（`src/client/components/queueDisplay.ts:22-29`）は `slotIds` / `startAt` / `boilSeconds` の 3 項目を持つ公開 interface である。`nextForSlot`（`src/client/components/slotDisplay.ts:125`）と `suggestionOf`（`SlotBoard.tsx:223`）はいずれも module-local で、export されていない。
9. `orderQueueEntries`（`queueDisplay.ts:57-74`）は `assignedBySlots` で担当範囲に絞ってから、`boilSecondsOf` が `null` の推奨を落とす。`boilSecondsOf` が `null` を返すのは (a) 品目が `view.pendingOrders` にない (b) 品目の麺種が `view.noodlePresets` にない、の 2 つ。
10. **(a) は構造的に起こらない。** `settle.ts:296-303` が同一の `state` から `pendingOrders: state.pendingOrders` と `recommendations: recommend(committed)` を作り、`committed` の各一片は `planTargets(state.pendingOrders)` の品目だけを参照する（`isStale` / `livePrefix` が食い違った一片を切る）。同じ snapshot の中で、推奨が指す品目は必ず待ち行列にある。
11. **(b) は `config` と `snapshot` の到着ずれのときだけ起こる。** `view.noodlePresets` は `config` メッセージから写される（`src/client/connection.ts:452`）。`snapshot` とは別のメッセージゆえ、設定から麺種が消えた／改名された直後に、client が新しい `config` と古い `snapshot` を持つ窓がある。
12. `arms` / `toleranceRatio`（`SyncParams`）は提案のばらけに関与しない。両者が計画へ届く経路は Boil_Sync による**走行中** Timer の実効 endTime の変化ただ一つで、`admit.ts` / `schedule.ts` / `commit.ts` はどちらも参照していない（理由は `src/engine/digest.ts:55`）。ばらけを作るのは `*SyncToleranceSeconds`（`ScheduleParams`）である。

### 確定した設計判断（すべて本要件へ演繹する）

1. **`startAt` は書き換えない。** 受け取った事実は事実のまま持つ。開始要求もワイヤも永続も触れない。
2. **時期は 2 つの導出値から組む。** 計画の中身である `Plan_Offset` と、最初の 1 本までの秒読みである `Start_Lead`。表示は両者の和である。
3. **錨は受信した推奨の全量から取る。** 担当範囲で絞った後に取ると端末ごとに錨が変わり、同じ計画が 2 台で違う間隔に見える。錨は計画全体で 1 つである。
4. **卓ごと・釜ごとに錨を取らない。** 卓 A を卓 B より大きくずらすと、B の表示時刻が A の釜が空く前を指しうる。**表示された計画**が実行可能でなくなる（サーバ側の実行可能性は表示では壊れないため、根拠はここに限る）。
5. **語で錨の所在を示す。** `Start_Lead > 0` の間は `in mm:ss`（サーバの時刻そのものへの秒読み）。`Start_Lead = 0` になったら、最初の 1 本は `now`、後続は `+mm:ss`（最初の 1 本からの間隔）。同じ `in` で描き続けると**減らない秒読み**になる——1 本目を始めない限り錨は毎描画で現在へ張り付き、間隔は不変であり、`in 02:00` は永遠に `02:00` のままである。減らない秒読みは嘘である。
6. **走行中の釜がある間の保守性を受け入れる。** 一様なずらしは常に実行可能で提供時刻の同期を保つが、走行中の釜の解放は絶対時刻で動かないため、サーバの再導出より遅めに見せうる。精度を上げるには client が解放表を再現することになり、`placeBatch` の二つ目の真実を作る。採らない。
7. **サーバは変えない。** Alarm による配り直しは `recommend` が Effect を返さない構造的保証と AC 7.5 を壊す。ワイヤをオフセット表現にすることは、**釜が全部空いているときだけ成り立つ近似**を契約にする（観測事実 2 のとおり `earliest` は釜の解放時刻を含み、混雑時にオフセット構造は平行移動しない）。計画の本当の出力は絶対時刻である。
8. **`QueueSuggestion` に項目を足さない。** 錨は表示だけの関心事であり、`nextForSlot` は使わない（`startAt` 最小と `Plan_Offset` 最小は同値）。項目に持たせると「計画全体で 1 つの錨」というグローバルを各要素へ焼き込み、二つ目の錨が現れた瞬間に壊れる。`SlotBoard` が錨を 1 度導出して渡す。

9. **見えない錨の代償を受け入れる。** 錨を握る推奨が担当外のユニットにある端末では、画面に `now` が無く、最初の提案が `+03:00` と出続ける。何を基準にした `+` なのか、その画面に手がかりはない。**端末間の一致を単端末の可読性より上に置く。** 計画の同期はユニットを跨ぐ（提供時刻を揃える単位は卓であり、卓の品目は別ユニットの釜へ置かれうる）ため、錨を端末ごとに切ると同じ計画が 2 台で違う間隔に見える。緩和として `aria-label` にある `Slot n` を可視ラベルへ出す案があるが、**採らない**——足さずに理由を残す。
10. **語は `+mm:ss` にする。** `after 02:00` のような語は採らない。理由が 3 つある。(a) レールの待ち時間（`OrderRail.tsx:113`）は盤面左端の固定幅ストリップ（`w-32`・`:41`）にあり視野で隣接せず、しかも `entry.waitingMs`（経過）ゆえ**増えていく**うえ接頭辞を持たない。(b) カードは本 spec の前から `in 02:00` を描いており、レールとの同居の状況は変わらない。(c) `+` は語を要さずに間隔を語り、カードの操作行は `clamp` で幅が決まるため語を長くすると折り返しの条件が変わる（`slot-suggested-start` AC 2.9 の根拠に触る）。走行中の秒読み（`SlotCard.tsx:143`）とは同一カードに同居しない——`next` を持つのは `SlotDisplay` の idle 相だけである。

### スコープ外

- 走行中の釜を考慮した再配置（サーバの再評価が担う。判断 6）
- `slotSpan` の計画反映（`pos-order-ingress` AC 6.36 が別 spec へ繰り延べた事項。「大盛が 1 スロットで計画されるのは『まだ実装していない』状態であり、状態について嘘をつくものではない」）
- `arms` を計画へ届かせること（観測事実 12。`digest.ts:55` の判断を変えない）
- レール（`OrderRail.tsx`）の待ち時間表示

### tasks へ落とす作業項目

1. `SlotBoard.tsx` に錨の導出を置き、`suggestionOf` を時期の 3 分岐へ書き換える
2. `online-cook-scheduling/design.md:466` を改める
3. 性質（Requirement 5）を PBT で、語の 3 分岐を実描画テストで固定する

### naming ゲート（`naming.md`）

**公開シンボルを 2 件足す（実装前にユーザー確認を要する）。** 時期の算術を純粋関数として切り出し、Requirement 5 の性質 6 本を PBT で直接問うためである。切り出さない場合は `renderToStaticMarkup` と `Date.now` の固定を通して `in 02:00` の文字列から逆算する検査になり、間接的で壊れやすい。とくに性質 4（端末間の一致）は盤面を 2 枚描いて比べることになる。

| 候補名 | 種別 | 表明する概念境界 |
| --- | --- | --- |
| `suggestionTiming` | 公開関数 | 提案の `startAt` と `Plan_Anchor` と補正後現在時刻から、時期の**種別と量**を決める。文字列は作らない |
| `SuggestionTiming` | 公開型 | 時期の 3 相。`{ kind: "countdown"; ms }` / `{ kind: "now" }` / `{ kind: "offset"; ms }` |

**`countdown` の `ms` は `Start_Lead` ではない。** `Start_Lead + Plan_Offset`＝この提案自身の開始までの残りである。`lead` と名付けると Glossary の語と型の語が食い違う。`offset` の `ms` は `Plan_Offset` そのもので、Glossary と一致する。

**文字列を返さない。** `mm:ss` の整形（`formatRemaining`）と `in` / `+` の語は `SlotBoard` に残る。ゆえに `slot-suggested-start` の「表示語彙は 1 箇所に集約する」判断は保たれ、切り出しても語彙は散らない。

**`{ kind: "now" }` は `ms` を持たない。** 常に 0 である項目は情報を持たない（`predicate.ts` の `toDeclaredName` から `ok` を落としたのと同じ判断）。絶対の表示時刻は `kind === "now" ? 現在 : 現在 + ms` で導ける。

置き場は `src/client/components/queueDisplay.ts` を候補とする（`QueueSuggestion` を定義し、待ち行列と提案の導出が住む場所である）。

## Glossary

| 語 | 定義 |
| --- | --- |
| **Plan_Anchor** | 受信した推奨の全量（`view.recommendations`）の最小 `startAt`。計画が最も早く始まる時刻。 |
| **Plan_Offset** | ある提案の `startAt − Plan_Anchor`。計画の中身（誰が 1 本目から何秒後か）。サーバの事実からの導出値。 |
| **Start_Lead** | `max(0, Plan_Anchor − 補正後現在時刻)`。最初の 1 本までの秒読み。 |
| **Lapsed_Plan** | `Start_Lead = 0` の状態。計画の 1 本目が既に過ぎている。 |
| **受信した推奨の全量** | `view.recommendations` そのまま。担当範囲でも茹で秒でも絞っていない集合。 |
| **担当範囲の推奨** | `orderQueueEntries` が返す集合。`assignedBySlots` と `boilSecondsOf` の両方で絞った後。 |

## Requirements

### Requirement 1: 提案の時期は計画の間隔と現在時刻から導く

**User Story:** 厨房スタッフとして、提案を放置しても「どれを先に落とすか」と「どれだけ間を置くか」を読み続けたい。

#### Acceptance Criteria

1. WHEN 提案の時期を描く THEN client は `Start_Lead` と `Plan_Offset` と補正後現在時刻から導出する
2. WHEN `Start_Lead > 0` THEN 表示は `in mm:ss` であり、その値は `Start_Lead + Plan_Offset` である
3. WHEN `Start_Lead = 0` かつ `Plan_Offset = 0` THEN 表示は `now` である
4. WHEN `Start_Lead = 0` かつ `Plan_Offset > 0` THEN 表示は `+mm:ss` であり、その値は `Plan_Offset` である
5. THE client SHALL NOT 受信した `startAt` の値を書き換える
6. WHEN 支援技術へ名前を渡す THEN 可視ラベルと同一の時期の語を用いる（時期の語彙を二箇所に作らない）
7. WHEN 補正後現在時刻が進む THEN 時期は再導出される（既存の毎描画導出の規律を変えない）

### Requirement 2: 錨は受信した推奨の全量から取る

**User Story:** 運用者として、同じ計画が端末によって違う間隔に見えないことを保証したい。

#### Acceptance Criteria

1. THE `Plan_Anchor` SHALL BE 受信した推奨の全量の最小 `startAt` である
2. THE `Plan_Anchor` SHALL NOT be 担当範囲の推奨から取られる
3. THE `Plan_Anchor` SHALL NOT be 卓ごと・釜ごとに取られる
4. WHEN 受信した推奨が空 THEN 提案も存在しない（錨を要しない）
5. WHEN 設定変更の直後で、錨を握る推奨が開始できない（麺種がプリセットにない）THEN `now` と描かれる提案が存在しないことがある。間隔は正しく、次の snapshot で解消する
6. THE `Plan_Anchor` SHALL BE 1 度だけ導出され、全カードで共有される

### Requirement 3: 語が錨の所在を示す

**User Story:** 厨房スタッフとして、画面の数字が「今から何秒後」なのか「1 本目から何秒後」なのかを取り違えたくない。

#### Acceptance Criteria

1. THE client SHALL NOT use `in mm:ss` when `Lapsed_Plan`（減らない秒読みを描かない）
2. WHEN `Lapsed_Plan` THEN `+mm:ss` の基準は計画全体の 1 本目であり、担当範囲外の釜にありうる
3. WHEN `Lapsed_Plan` かつ 状態変化がない THEN 表示は静止する（`now` / `+mm:ss` の値が変わらない）
4. THE 時期の語 SHALL NOT 命令形を用いる（`slot-suggested-start` AC 2.10 / AC 8.2 を維持）

### Requirement 4: 不変点

**User Story:** 保守者として、この変更がサーバ・ワイヤ・永続のどこにも及ばないことを確かめたい。

#### Acceptance Criteria

1. THE 本 spec SHALL NOT 変更する `src/engine`（`recommend` / `placeBatch` / `commit` / `settle` を含む）
2. THE 本 spec SHALL NOT 変更する ワイヤ契約（`CookRecommendation` / `ServerMessage` / `ClientMessage`）
3. THE 本 spec SHALL NOT 変更する 永続スキーマ（`CURRENT_SCHEMA_VERSION`）
4. THE 本 spec SHALL NOT 変更する 開始要求（`startOrderItem` の 3 項目）
5. THE 本 spec SHALL NOT 足す `QueueSuggestion` への項目
6. THE 本 spec SHALL NOT 変更する `nextForSlot` の選び方（`startAt` 最小）
7. THE サーバ SHALL NOT 持つ 時刻起動の失効判定（AC 7.5 を維持）
8. THE client SHALL NOT 開始する 時刻到来を契機に（AC 8.2 を維持）

### Requirement 5: 検証可能な性質

**User Story:** 保守者として、導出の正しさを性質として固定したい。

#### Acceptance Criteria

1. **単調性** — 状態変化のない区間で、補正後現在時刻が進んでも各提案の表示時刻（絶対）は後退しない
2. **実行可能性** — 各提案の表示時刻（絶対）は受信した `startAt` 以上である
3. **同期の保存** — 任意の 2 提案の表示時刻の差は、それらの `startAt` の差に等しい
4. **端末間の一致** — 同じ `recommendations` と同じ補正後現在時刻から、担当範囲が違っても各提案の表示時刻は同じである
5. **秒読みとの連続性** — `Start_Lead > 0` の間、表示は変更前の `startAt − 補正後現在時刻` と一致する
6. **収束の消滅** — 任意の時刻で `now` と描かれる提案は、`Plan_Offset = 0` のものだけである

### Requirement 6: 文書の整合

**User Story:** 保守者として、文書が現実と食い違ったまま残らないことを確かめたい。

#### Acceptance Criteria

1. WHEN 本 spec を実装する THEN `.kiro/specs/online-cook-scheduling/design.md:466` の「過ぎた `startAt` は……過去時刻のまま表示される」を同じコミットで改める
2. THE 改訂 SHALL NOT 変更する AC 7.5 / AC 8.2 の本文（帰結の記述だけを改める）
