# Design Document: 過ぎた提案の時期（lapsed-suggestion-timing）

## この設計が拠って立つもの

- **真** — 表示はモデルの答えと食い違わない。時期は導出値であり、受け取った絶対時刻を状態のように据え置かない。
- **善** — サーバに Alarm を張らせない。時刻の関心事は描画のたびに解ける。
- **美** — 引き算で済ませる。新しい状態も新しいワイヤ項目も足さない。触るのは 2 ファイルで、足す公開シンボルは検証のための 2 件だけである。

## Overview

### 動機

`startAt` は snapshot を作った瞬間の錨で引かれた絶対時刻である。放置は状態変化ではないので新しい snapshot は来ない。client が引き算を続けると、`startAt` が次々に過去になり、全提案が `now` へ崩れる。

失われるのは順序と間隔である。実測（requirements 観測事実 5）のとおり、**釜が全部空きで外部計画の採用がない条件下では**サーバは導出し直すたびに間隔を保って返す。画面だけがそれを捨てている。条件を外れると平行移動にならない（走行中 Timer の解放時刻は絶対時刻として残り、採用済みの外部計画があれば `hasLapsedStart` が切って自前解へ落ちる）——その場合の扱いは「既知の限界」に置く。

### 何を変えるか

時期の導出を 1 段分けるだけである。

```
変更前   時期 = fmt(startAt − 現在)                          ……過去になれば now
変更後   時期 = fmt(Start_Lead + Plan_Offset)                ……Start_Lead > 0
                Plan_Offset = 0 なら now、正なら +fmt(Plan_Offset)  ……Start_Lead = 0
```

`Plan_Offset = startAt − Plan_Anchor` が計画の中身（サーバの事実からの導出）、`Start_Lead = max(0, Plan_Anchor − 現在)` が最初の 1 本までの秒読みである。この分離が導出の根拠そのものである——前者はサーバが決め、後者は描画の時点で決まる。

### 変えないもの

`src/engine` の全体、ワイヤ契約、永続、`startOrderItem`、`QueueSuggestion`、`nextForSlot`、`orderQueueEntries`。`startAt` の値も書き換えない。`queueDisplay.ts` に触るのは関数と型を 1 つずつ足すためだけである。

## Architecture

### 触る層と触らない層

| 層 | 変更 |
| --- | --- |
| `src/engine` | なし |
| `src/domain` | なし |
| `src/client/components/queueDisplay.ts` | **`suggestionTiming` / `SuggestionTiming` の追加のみ**（`QueueSuggestion` と `orderQueueEntries` には触らない） |
| `src/client/components/slotDisplay.ts` | なし（`nextForSlot` は `startAt` 最小のまま） |
| **`src/client/components/SlotBoard.tsx`** | **錨の導出と、`suggestionOf` での語の当て方** |
| `.kiro/specs/online-cook-scheduling/design.md` | 466 行目の帰結の記述を改める |

### 錨が流れる道

```
view.recommendations（受信した全量・全端末で同一）
      │ min(startAt)
      ▼
 Plan_Anchor ──────────────┐
                           │  suggestionOf へ引数で渡す（1 描画で 1 度だけ導出）
view.offset, now ──────────┤
      │ correctedNow       │
      ▼                    ▼
 Start_Lead = max(0, Plan_Anchor − 補正後現在)
                           │
suggestion.startAt ────────┤ Plan_Offset = startAt − Plan_Anchor
                           ▼
                        時期の語
```

錨を `view.recommendations` から取るのは、**全端末が同じ配列を持つ**ためである（サーバは全量を配り、絞り込みは client が担う——`recommend.ts:19-24`）。担当範囲の推奨から取れば端末ごとに錨が変わり、同じ計画が 2 台で違う間隔に見える。

## Components and Interfaces

### Component 1: `SlotBoard.tsx` — 錨を 1 度導出する

`queue` / `displays` を導出している位置（`:73-75`）の隣に置く。1 描画で 1 度だけ導き、全カードで共有する。

```ts
// 計画の錨。受信した推奨の全量から取る——担当範囲で絞った後に取ると端末ごとに錨が変わり、
// 同じ計画が 2 台で違う間隔に見える（錨は計画全体で 1 つである）。推奨が無ければ錨も要らない。
const planAnchor =
  view.recommendations.length === 0
    ? null
    : Math.min(...view.recommendations.map((recommendation) => recommendation.startAt));
```

`null` を持つのは「推奨が無い」ことを型で語るためである。その場合カードに提案は無く（`display.next === null`）、`suggestionOf` は呼ばれない。

`Math.min(...)` の展開は推奨の件数（計画対象の上限 64）で抑えられており、毎描画でも問題にならない。件数が問題になる規模へ変わるなら `reduce` へ替えるが、いま入れる理由はない。

### Component 2: `queueDisplay.ts` — 時期の算術を切り出す

文字列を作らない純粋関数を 1 本置く。性質 6 本を PBT で直接問うための切り出しである。

```ts
/**
 * 時期の 3 相。
 *
 * `now` は `ms` を持たない——常に 0 である項目は情報を持たない。
 *
 * **`countdown` の `ms` は Start_Lead ではない。** Start_Lead は錨までの残りだが、こちらは
 * `Start_Lead + Plan_Offset`＝**この提案自身の開始までの残り**である。ゆえに `lead` と名付けない
 * （Glossary の語と型の語が食い違う）。
 */
export type SuggestionTiming =
  | { readonly kind: "countdown"; readonly ms: number }
  | { readonly kind: "now" }
  | { readonly kind: "offset"; readonly ms: number };

/**
 * 提案の時期を決める。Plan_Offset（計画の中身＝1 本目からの間隔）はサーバの事実からの導出、
 * Start_Lead（1 本目までの秒読み）は問うた時点で決まる。受け取った startAt は書き換えない。
 *
 * **文字列を作らない。** mm:ss の整形と in / + の語は SlotBoard が持つ（表示語彙は 1 箇所）。
 */
export function suggestionTiming(
  startAt: number,
  planAnchor: number,
  corrected: number, // 補正後現在時刻。correctedNow は同名 import を隠すため引数名にしない
): SuggestionTiming {
  const offset = startAt - planAnchor;
  const lead = Math.max(0, planAnchor - corrected);
  if (lead > 0) return { kind: "countdown", ms: lead + offset };
  return offset === 0 ? { kind: "now" } : { kind: "offset", ms: offset };
}
```

絶対の表示時刻は `kind === "now" ? correctedNow : correctedNow + ms` で導ける。性質はこの式で述べる。

### Component 2b: `suggestionOf` — 語を当てる

現在の 2 行（`SlotBoard.tsx:239-240`）を置き換える。`planAnchor` を引数に足す。

```ts
const timing = suggestionTiming(suggestion.startAt, planAnchor, correctedNow(view.offset, now));
// lead が尽きたら in を使わない。1 本目を始めない限り錨は現在へ張り付き offset は不変ゆえ、
// in は減らない秒読みになる。減らない秒読みは嘘である。
const timingText =
  timing.kind === "countdown"
    ? `in ${formatRemaining(timing.ms)}`
    : timing.kind === "now"
      ? "now"
      : `+${formatRemaining(timing.ms)}`;
```

`formatRemaining` は分も 2 桁ゼロ詰めである（`format.ts:16-23`）。実際の表示は `in 02:00` / `+02:00` になる。

**`aria-label` も同じ `timingText` を使い続ける。** 可視ラベルと支援技術の名前で時期の語彙が分かれない。

### Component 3: `online-cook-scheduling/design.md:466`

現在の文は client が単に引き算している帰結を述べている。本 spec でその帰結が成り立たなくなるため、放置すれば文書が嘘になる。

改訂は帰結の記述だけに閉じる。AC 7.5（サーバは時刻起動の失効判定を持たない）と AC 8.2（時刻到来で自動開始しない）の本文は変えない——どちらも本 spec で維持される。

## Data Models

新しい型は `SuggestionTiming` の 1 つである（naming ゲートで確認する）。`Plan_Anchor` は `SlotBoard.tsx` 内のローカルな数値、`Plan_Offset` / `Start_Lead` は `suggestionTiming` の内側に閉じる。

`QueueSuggestion` に `offsetMs` を足す案を検討して**捨てた**。錨は表示だけの関心事で、`nextForSlot` は使わない（`startAt` 最小と `Plan_Offset` 最小は定数シフトゆえ同値）。項目に持たせると「計画全体で 1 つの錨」というグローバルを各要素へ焼き込み、二つ目の錨が現れた瞬間に壊れる。加えて公開 interface の変更となり、生成器・既存テストへ波及する。持たない方が真であり、かつ小さい。

## 性質（Correctness Properties）

絶対の表示時刻を `D(s) = max(now, A) + (startAt_s − A)`（`A` = `Plan_Anchor`）と書く。

| # | 性質 | 証明の骨 |
| --- | --- | --- |
| 1 | 単調性 | `max(now, A)` は `now` について単調非減少。`Plan_Offset` は `now` に依らない |
| 2 | 実行可能性 | `A ≥ now` なら `D = startAt`。`A < now` なら `D = startAt + (now − A) > startAt` |
| 3 | 同期の保存 | `D(s) − D(t) = startAt_s − startAt_t`（`max(now, A)` が消える） |
| 4 | 端末間の一致 | `A` は `view.recommendations` から取り、担当範囲に依らない |
| 5 | 秒読みとの連続性 | `A ≥ now` のとき `lead + offset = (A − now) + (startAt − A) = startAt − now` |
| 6 | 収束の消滅 | `now` と描くのは `lead = 0 ∧ offset = 0` のときだけ。`offset = 0` は `startAt = A` の提案に限る |

性質 3 は「提供時刻の同期が保たれる」ことの言い換えである。`serveAt = startAt + 茹で時間` であり、全提案が同じ `max(now, A) − A` だけ後ろへ動くので `serveAt` の差も不変になる。

## 既知の限界

**走行中の釜があると保守的になる。** 釜の解放時刻は絶対時刻で動かないため、`Plan_Offset` の構造は錨と一緒に平行移動しない。一様なずらしは性質 2 のとおり常に実行可能だが、サーバの再導出より遅めに見せうる。

この差は最早の走行中 Timer の終了で `AlarmFired → settle → snapshot` が起きて解消する、と見込んでいる。**未検証である。** 精度を上げるには client が解放表を再現することになり、`placeBatch` の二つ目の真実を作るので採らない。

**設定変更の直後に `now` が消えることがある。** 錨を握る推奨の麺種がプリセットから消えていると、その推奨は提案として成立せず（`boilSecondsOf` が `null`）、`offset = 0` の提案が存在しない。最も早い提案が `+00:30` などと出る。間隔は正しく、次の snapshot で解消する。窓は `config` と `snapshot` の到着間隔である。

## Testing Strategy

| 対象 | 置き場 | 内容 |
| --- | --- | --- |
| 性質 5.1 / 5.2 / 5.3 / 5.5 / 5.6 | 新規 PBT | `suggestionTiming` を直接呼ぶ。絶対の表示時刻は `kind === "now" ? 現在 : 現在 + ms` |
| 性質 5.4（端末間の一致） | 実描画テスト | `suggestionTiming` は担当範囲を知らないため自明に真になる。中身は `SlotBoard` の `planAnchor` の導出に住むので、`units` の違う盤面 2 枚を描いて比べる |
| 語の 3 分岐 | 実描画テスト | `in mm:ss` / `now` / `+mm:ss` が条件どおり出る。`aria-label` が同じ語を持つ |
| 静止 | 実描画テスト | `Lapsed_Plan` で `now` を進めても表示が変わらない |
| 既存の秒読み | 既存テスト | 性質 5.5 ゆえ `Start_Lead > 0` の既存検査は通り続ける（**実測で確かめる**） |

**切り出しの是非は requirements の naming ゲートで決着済みである**（案 1・公開シンボル 2 件）。`suggestionTiming` は文字列を返さないため、`slot-suggested-start` の「表示語彙は 1 箇所」は保たれる。

実描画テストが受けるのは語の 3 分岐・静止・性質 5.4 である。静止の検査には `Date.now` の固定が要る——`SlotBoard.tsx:69` が直接 `Date.now()` を読むため、`now` を進めて再描画するには `vi.useFakeTimers` か spy を用いる。
