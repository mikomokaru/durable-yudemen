# Implementation Plan: 過ぎた提案の時期（lapsed-suggestion-timing）

## Overview

**時期という 1 つの文字列の導出を差し替える変更である。** サーバ・ワイヤ・永続・engine は 1 行も動かない。触るのは `src/client/components/SlotBoard.tsx` と `queueDisplay.ts`（`suggestionTiming` の追加のみ）、そして帰結が変わる spec 文書である。

`slot-suggested-start` と違い型の波及がない（`QueueSuggestion` を変えないため）。ゆえに依存順のクラスタ分けは要らず、実装 → 文書 → テストの順で進む。

### 検証方針は決着済み

性質 6 本（`requirements.md` Requirement 5）は純粋な算術ゆえ、時期の算術を `suggestionTiming` として切り出して PBT で直接問う。**公開シンボル 2 件（`suggestionTiming` / `SuggestionTiming`）は naming ゲートの確認対象である**（task 1）。

切り出しても表示語彙は散らない——`suggestionTiming` は文字列を返さず、`mm:ss` の整形と `in` / `+` の語は `SlotBoard` に残る。

## Tasks

- [x] 1. 公開シンボル 2 件を確認する（**ユーザー確認が必要**）
  - `suggestionTiming`（公開関数）と `SuggestionTiming`（公開型・`{ kind: "countdown"; ms }` / `{ kind: "now" }` / `{ kind: "offset"; ms }`）。
  - 置き場は `src/client/components/queueDisplay.ts` を候補とする。
  - `{ kind: "now" }` が `ms` を持たない理由（常に 0 の項目は情報を持たない）を併せて確認する。
  - _Requirements: naming ゲート_

- [x] 2. `SlotBoard.tsx` に錨の導出を置く
  - `queue` / `displays` の導出の隣（`:73-75` 付近）に `planAnchor` を置く。`view.recommendations` が空なら `null`。
  - 1 描画で 1 度だけ導き、全カードで共有する。担当範囲の推奨からは取らない。
  - コメントは「なぜ全量から取るか」（端末ごとに錨が変わると同じ計画が 2 台で違う間隔に見える）だけを書く。
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6_

- [x] 3. `queueDisplay.ts` に `suggestionTiming` を置く
  - 文字列を作らない。`SuggestionTiming` の 3 相を返す。
  - `Plan_Offset` / `Start_Lead` はこの関数の内側に閉じる。
  - _Requirements: 1.1, 1.5_

- [x] 4. `suggestionOf` で語を当てる
  - `SlotBoard.tsx:239-240` を置き換え、`planAnchor` を引数で受ける。
  - `countdown` → `in ${formatRemaining(ms)}`（＝ `in 02:00`）、`now` → `now`、`offset` → `+${formatRemaining(ms)}`（＝ `+02:00`）。
  - `formatRemaining` は分も 2 桁ゼロ詰めである（`format.ts:16-23`）。`m:ss` ではない。
  - `aria-label` は同じ語を使い続ける（時期の語彙を二箇所に作らない）。
  - コメントは「なぜ `in` を使い続けないか」（減らない秒読みになる）だけを書く。
  - _Requirements: 1.2, 1.3, 1.4, 1.6, 3.1, 3.4, 判断 10_

- [x] 5. チェックポイント — 変更が 2 ファイルに閉じていることを確かめる
  - `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm fmt:check` が green。
  - `git diff --stat -- src` が `SlotBoard.tsx` と `queueDisplay.ts` の 2 ファイルだけを示すことを確認する（不変点の実測）。案 1 を採ったため 1 ファイルではない。
  - `git diff -- src/client/components/slotDisplay.ts src/engine src/domain` が空であることを確認する。`queueDisplay.ts` の差分は `suggestionTiming` の追加だけで、`QueueSuggestion` と `orderQueueEntries` に及ばないことを確認する。
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

- [x] 6. 性質 5.1 / 5.2 / 5.3 / 5.5 / 5.6 を PBT で検証する
  - `suggestionTiming` を直接呼ぶ。絶対の表示時刻は `kind === "now" ? 現在 : 現在 + ms`。
  - 5.1 単調性 — 現在時刻を進めても表示時刻（絶対）は後退しない
  - 5.2 実行可能性 — 表示時刻（絶対）は受け取った `startAt` 以上
  - 5.3 同期の保存 — 任意の 2 提案の表示時刻の差は `startAt` の差に等しい
  - 5.5 秒読みとの連続性 — `Start_Lead > 0` の間、表示時刻は変更前の `startAt` に等しい
  - 5.6 収束の消滅 — `kind === "now"` になるのは `Plan_Offset = 0` のときだけ
  - **5.4 はここで問えない。** `suggestionTiming` は担当範囲を知らず錨を引数で受けるだけなので、5.4 は自明に真になる。中身は「錨を全量から取る」ことであり、それは `SlotBoard` の `planAnchor` の導出に住む（task 7 へ）。
  - _Requirements: 5.1, 5.2, 5.3, 5.5, 5.6_

- [x] 7. 語の 3 分岐・静止・性質 5.4 を実描画で固定する
  - `in mm:ss` / `now` / `+mm:ss` が条件どおり出る。`aria-label` が同じ語を持つ。
  - `Lapsed_Plan` で `now` を進めても表示が変わらない（静止）。**`Date.now` の固定が要る**——`SlotBoard.tsx:69` が直接 `Date.now()` を読むため、`vi.useFakeTimers` か spy を用いる。
  - **5.4 端末間の一致** — 同じ `recommendations` から、`units` の違う盤面を 2 枚描き、両方に現れる釜の提案の時期が一致することを問う。前例は `tests/client/audioWiring.example.test.ts:136` の `renderBoard`（`renderToStaticMarkup` と偽 `connection`）。
  - `planAnchor` を純粋関数として切り出して 5.4 を問う案は**採らない**。署名から `units` を外しても「絞った配列を渡さない」ことは保証できず（`queue` から作った配列も渡せる）、結局呼び出し側を見る検査が要る。主張が住む場所で直接問う方が少ない。
  - `+` の基準が担当範囲外にありうることを注記として残す（判断 9 の理由を指す。テストでは問えない）。
  - _Requirements: 3.2, 3.3, 1.6, 5.4_

- [x] 8. 既存テストへの波及を確認する
  - 性質 5 ゆえ `Start_Lead > 0` の既存検査は通り続けるはずである。**実測で確かめる。**
  - `tests/client/slot-card.example.test.tsx` は `suggestionOf` の結果を props で受けるため影響を受けない見込み。
  - `tests/client/slotSuggestion.*.test.ts` は `nextForSlot` を問うため影響を受けない見込み。
  - 落ちた検査があれば、それが仕様変更の帰結か回帰かを分けて記録する。
  - _Requirements: 5.5, 4.6_

- [x] 9. `online-cook-scheduling/design.md:466` を改める
  - 「過ぎた `startAt` は……過去時刻のまま表示される」を、新しい帰結（間隔を保って現在へ追随する）へ改める。
  - AC 7.5 / AC 8.2 の本文は変えない。どちらも本 spec で維持される。
  - 改訂は本体の実装と同じコミットに置く（文書が嘘の状態を 1 コミットも作らない）。
  - **併せて `slot-suggested-start` の `m:ss` 表記を直す。** `formatRemaining` は分も 2 桁ゼロ詰めゆえ実際は `in 02:00` である。誤記は `requirements.md:39` / `:124`、`design.md:136` / `:446`、`tasks.md:25` / `:115` にある。マージ済み spec が出荷済みの挙動について誤った書式を語っている状態を残さない。
  - `tests/client/slot-card.example.test.tsx` の固定文字列 `in 1:20`（3 箇所）も `in 01:20` へ直す。props で渡す値ゆえ挙動の嘘ではないが、書式の 文書 として誤っている。
  - _Requirements: 6.1, 6.2_

- [x] 10. チェックポイント — 全体の green と実機確認
  - `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm fmt:check` の完全 green。
  - **実機確認。** dev サーバに店舗をプロビジョニングし、同一卓・茹で時間の違う複数品目を `POST /pos/records` で投入する（手順は `slot-suggested-start` の実機確認で確立済み）。
    - 投入直後、`in mm:ss` がばらけて出ることを確認する
    - 最初の 1 本の時刻を過ぎたあと、`now` / `+mm:ss` へ切り替わり、**全部 `now` に崩れない**ことを確認する
    - 放置し続けても表示が静止することを確認する
    - `+` が小さすぎず、`mm:ss` との区別が読めることを確認する
  - **実測（2026-09-03）。** 店舗 `9003` に同一卓・茹で 510s / 360s / 330s の 3 品目を投入し、WS の
    snapshot から実装と同じ算術で期待値を出した。`now` / `+02:00` / `+02:30` が得られ、**10 分後の
    現在時刻でも同じ値**（静止・収束しない）。変更前はこの条件で 3 つとも `now` へ崩れていた。
    字の大きさ（`+` の可読性）は算術では問えないためユーザーの目視で確認した。
  - _Requirements: 1.2, 1.3, 1.4, 3.3_

- [ ] 11. 既知の限界を記録する（**別 PR でよい**）
  - 走行中 Timer があるときの保守性の差を実測するか、未検証として残すかを決める。
  - 決めた内容を `design.md` の「既知の限界」へ反映する。
  - _Requirements: design「既知の限界」_

## 未決事項

1. **走行中 Timer があるときの保守性の差。** 未測定（task 11）。

### 未決から外したもの

**他の時間表示と混ざる懸念は無い。** 走行中の秒読み（`SlotCard.tsx:143` の `RemainingTime`）と提案の時期は同一カードに同居しない——`next` を持つのは `SlotDisplay` の idle 相だけで、走行中のカードに時期は型として現れない（`slot-suggested-start` design「提案は idle にしか現れないは型で真」）。レールの待ち時間（`OrderRail.tsx:113`）は盤面左端の固定幅ストリップ（`w-32`・`:41`）にあり視野で隣接せず、かつカードは変更前から `in mm:ss` を描いていたので同居の状況は変わらない。
