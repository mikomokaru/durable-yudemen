# Implementation Plan: 調理待ちオーダーの左レール化（pending-order-list-left-rail）

## Overview

design の骨格「器の向きを変え、行の組み方を縦幅に合わせる。導出は 1 行も足さない」に対応した実装計画である。実装言語は **TypeScript（strict）/ TSX**、ツールは `tooling.md` に従い **pnpm / Vite / React 19 / Tailwind v4 / Vitest v4 / oxlint / oxfmt** を用いる。

**変更は表示層に閉じる。** 本番コードの差分は `src/client/components/` の 2 ファイルのみである。

| 区分 | ファイル | 変更 |
| --- | --- | --- |
| source | `src/client/components/OrderQueue.tsx` → `OrderRail.tsx` | 改名し、横 1 列の帯から縦レールへ組み替える |
| source | `src/client/components/SlotBoard.tsx` | 段組みを 2 段にし、下段でレールと釜グリッドを横並びにする |
| test（新規） | `tests/client/order-rail.example.test.tsx` | 実描画テスト R1〜R9（`render` プロジェクト・`happy-dom`） |
| test（新規） | `tests/pending-order-list-left-rail.static.test.ts` | ソース静的検査 S1〜S15（`static` プロジェクト・node） |
| 設定 | `vitest.config.ts` | 静的検査ファイルを `static` の `include` と `workers` の `exclude` へ対で登録する |

**触らないもの（7）:** `tests/client/order-queue.example.test.ts`・`tests/client/format.property.test.ts`・`src/client/App.tsx`・`queueDisplay.ts`・`noodleColor.ts`・`RadialMenu.tsx`・`styles.css`。サーバ側（`src/domain` / `src/engine` / `src/shell` / `src/worker.ts`）とワイヤにも差分を出さない（要件 6.5）。

**新しい PBT を作らない。** design「Correctness Properties」が定めるとおり、本 spec 固有の property は無い。並び・待ち時間・提案の絞り込み・待ち時間の表記という全称命題はすべて既存の `orderQueueEntries` / `formatRemaining` に属し、既存テストが property 1〜6 として検証済みである。本 spec はそれらを**守る側**にある——既存テストを 1 行も書き換えずに通すこと自体が本 spec の property であり、タスク 6.1 がそれを検証する（要件 6.4）。

**命名確認は不要（済）。** 公開シンボルは `OrderRail` / `OrderRow` の 2 つで、`Suggested_Start` に独立した名を与えないことと併せてユーザー確認済みである（`requirements.md`「確定した判断」5・design「公開シンボル名の確認の記録」）。ゆえに実装ゲートとしての命名確認タスクを置かず、タスク 1.1 から着手する。

**実装の順序.** `OrderRail` の器 → 行 → 提案ボタン → `SlotBoard` の段組み → テスト → 全量検証。`OrderRail` の props（`entries: NonEmptyArray<QueueEntry>`）が確定してから `SlotBoard` が `isNonEmpty` を通す形へ移る。宙に浮くコードを残さない。

各タスクの完了条件は共通で **`pnpm typecheck` / `pnpm lint` / `pnpm test`（`vitest --run`）が通ること**。テストは watch を使わず単発実行する。

## Tasks

- [x] 1. `OrderRail` への改名と縦レールの組み立て
  - [x] 1.1 ファイルを改名し、レールの器を縦 1 列へ組み替える
    - `src/client/components/OrderQueue.tsx` を `OrderRail.tsx` へ改名し、`OrderQueue` → `OrderRail`・`OrderQueueRow` → `OrderRow`・`OrderQueueProps` → `OrderRailProps` へ改める。`wallClock`（非 export）はそのまま移す
    - props の `entries` を `readonly QueueEntry[]` から `NonEmptyArray<QueueEntry>`（`src/domain/timer.ts` から型のみ import）へ締め、`entries.length === 0` の早期 return を**撤去**する（0 件のレールを型で構築不能にする）
    - `section` に固定幅 `w-32 flex-none` と `flex flex-col`・`border-r border-line pr-[clamp(0.5rem,1.2vw,0.875rem)]` を与える。比率幅（`w-1/4` / `w-[…%]`）・`min-w-` / `max-w-`・ブレークポイント変種（`sm:` / `md:` / `min-[…]:`）・`clamp` による幅を置かない
    - `ul` を縦並び（`flex-col`）にし、`min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain` を与える。`overflow-x-auto` を撤去する
    - `aria-label="Waiting orders"` の `section`・`ul`・`li` の役割と、見出しの `Waiting orders ({entries.length})` を保つ。件数は `entries.length` の導出値であり保持しない
    - 行の `key`（`${externalOrderId}-${itemIndex}`）を保ち、`ul` 要素の identity を再描画で変えない（スクロール位置は DOM が持つ事実）
    - `useState` / `useRef` / `useEffect` / `setInterval` / `setTimeout` / `ResizeObserver` / `matchMedia` を置かない。`transition-*` / `animate-*` / `z-*` / `fixed` も置かない
    - _Requirements: 1.2, 1.3, 2.1, 2.5, 3.7, 3.8, 3.9, 4.1, 4.2, 4.4, 4.5, 4.6, 6.1, 6.11, 7.1, 7.3, 7.5, 7.7_

  - [x] 1.2 `OrderRow` を 2 行構成へ組み替える
    - 1 行目に麺種（`text-sm font-bold truncate`）、2 行目に `justify-between` で左群（茹で加減 + 卓番）と待ち時間を両端へ固定する。DOM 順は 麺種 → 茹で加減 → 卓番 → 待ち時間
    - 左群に `truncate`、待ち時間に `flex-none tabular-nums` を与える。切り詰めが起きるのは麺種名・卓番だけで、待ち時間は常に全桁が出る
    - 卓番が `null` の行では卓番の表示を省く。茹で加減は左端・待ち時間は右端に留まり、行高も変わらない
    - 茹で加減は既存 `FIRMNESS_LABEL`（`./firmness`）をそのまま引く。レール専用の茹で加減ラベルを持たない
    - 麺種色は `noodleColor(order.noodleType)` の戻り値をインライン `style={{ color }}` で与える。これがレール実装で唯一のインラインスタイル。`noodleColors` を直接 import しない
    - 文字寸法は麺種 `text-sm`（0.875rem）、茹で加減・卓番・待ち時間 `text-[0.6875rem]`。0.6875rem 未満を置かない
    - 行は `flex-none`（可視高を超えても縮まない）。背景は `bg-panel2`、枠は `border-line`。色値リテラル（`#` / `rgb(` / `hsl(` / `oklch(`）を置かない
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.10, 7.1, 7.2, 7.6_

  - [x] 1.3 提案の開始操作を 3 行へ積み替え、`aria-label` をやめる
    - `button` を横並びから 3 行（`flex-col items-start`）へ積み替える。1 行目 `Suggested`（0.6875rem・名詞形・uppercase にしない）、2 行目 釜（`Slot` / `Slots` + `slotIds.join(", ")`・0.6875rem）、3 行目 `wallClock(startAt)`（`text-xs`）
    - `PlayIcon` を置かない（`./icons` からの import を落とす）。左右 padding は `px-1.5`、上下は `py-1`
    - `min-h-[2.75rem] w-full` を与える。負のマージンを持たず、行の border box の内側に収める
    - 釜の行に `truncate` を置かない。既定の折り返しに任せ、区切りは `", "`（空白が折り返し機会になる）。6 釜でも番号を 1 つも落とさない
    - **`aria-label` を持たせない。** accessible name は 3 行の可視テキストから計算される。命令形（`Start` / `Go`）と自動開始を示唆する語を置かない
    - `suggestion === null` の行はボタンを描かない。理由別の表示も理由を覚える保持値も持たない
    - `onClick` は `onStart(order, suggestion)` のまま。推奨開始時刻の到来を契機とする配線を持たず、過去の `startAt` もそのまま出す
    - ボタンは色を持たない（`text-ink` / `bg-panel` / `border-line`）
    - _Requirements: 5.1, 5.2, 5.4, 5.5, 5.9, 6.9, 7.2, 7.4_

- [x] 2. `SlotBoard` の段組みを 2 段にする
  - [x] 2.1 下段でレールと釜グリッドを横並びにし、表示条件を 1 箇所に置く
    - import 先を `./OrderRail` へ改め、上段の横帯（`OrderQueue`）の呼び出しを消す。一覧はレールただ 1 箇所
    - `isNonEmpty(queue)`（`src/domain/timer.ts` の既存述語）を 1 回だけ通し、結果を束ねた値を見る箇所をレールを描くか否かのただ 1 箇所に保つ
    - エラー帯を `flex-none` の全幅で上段に残し、下段に `flex min-h-0 flex-1` の器を新設してレールと釜グリッドを横並びにする（既定の `align-items: stretch` で上下端が揃う）
    - 下段の器に `gap-` を置かない。区切りはレール側の `pr` と `border-r` が作る
    - 釜グリッドに左 padding（`pl-`）を置かない。`flex-1 min-w-0 min-h-0` を与え、`grid-flow-col auto-cols-fr` と各ユニットの `grid-cols-2 auto-rows-fr` は変えない
    - ビューの購読・1 秒の拍・現在時刻の読み・`orderQueueEntries` の呼び出し・`noodleColors` の `useMemo`・`onStart` ハンドラ（`connection.start` + `playTouchCue`）・ラジアルの開閉は一切変えない
    - 寸法を JS で測らない（`ResizeObserver` / `matchMedia` を足さない）。幅の変化は `flex-1` の釜グリッドが吸収する
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.7, 1.8, 2.3, 2.4, 2.5, 2.7, 2.8, 5.3, 5.6, 5.7, 5.8, 6.7, 6.10_

- [x] 3. Checkpoint - 配置の組み替えが型検査と既存テストを壊していないこと
  - `pnpm typecheck` / `pnpm lint` / `pnpm test`（`vitest --run`）を通す。
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. 実描画テスト（`tests/client/order-rail.example.test.tsx`・新規）
  - [x]* 4.1 レールの構造・DOM 順・件数を実描画で確認する（R1〜R3）
    - `render` プロジェクトが拡張子で拾う（`include: ["tests/**/*.test.tsx"]`）。`vitest.config.ts` への追記は要らない
    - `OrderRail` を単体 `render` する（`SlotBoard` を丸ごと描かない）。`QueueEntry` はテスト内で直接組み、`onStart` は `vi.fn()` を渡す
    - R1: `getByRole("region", { name: "Waiting orders" })` の内側に `list` が 1 つ、`listitem` が件数分ある
    - R2: 到着順に組んだ `entries` に対し、`getAllByRole("listitem")` のテキストが `entries` の順に対応する
    - R3: 見出しに件数が出る。件数の異なる `entries` で再描画すると、見出しの数と `listitem` の数がともに変化後の件数に一致する
    - 問い方は `getByRole` / accessible name に寄せ、クラス名を問わない（クラスの主張は静的検査が持つ）。各テストに `**Validates: Requirements x.y**` を併記する（PBT のタグ形式は用いない）
    - _Requirements: 3.7, 3.8, 7.3, 7.7_

  - [x]* 4.2 提案の accessible name と押下時の引数を実描画で確認する（R4・R8）
    - R4: `getByRole("button")` の accessible name が `Suggested`・釜の識別（`slotIds` の全て）・`HH:MM` を可視テキストと同一の語で含み、命令形（`Start` / `Go`）と自動開始を示唆する語（`Automatic` / `automatically`）を含まない
    - R8: ボタンを押すと `onStart` が 1 回呼ばれ、第 1 引数が対象の `PendingOrder`（麺種・`externalOrderId` / `itemIndex` を含む）、第 2 引数が `slotIds` の全てと `boilSeconds` を保った `suggestion` である
    - R4 は判断 6（`aria-label` をやめる）の担保でもある
    - _Requirements: 5.3, 5.4, 7.4_

  - [x]* 4.3 提案なし・卓番なし・全件描画・茹で加減の語を実描画で確認する（R5〜R7・R9）
    - R5: `suggestion: null` を含む `entries` で、`queryAllByRole("button")` の件数が提案を持つ行数と一致し、提案なしの行にはボタンが無い。行そのものは到着順の位置に残る
    - R6: `tableId: null` の行に `Table` の文字列が現れず、麺種・茹で加減の語・待ち時間の表記は現れる
    - R7: 提案を持つ件と持たない件を混ぜた `entries` に対し、`listitem` の件数が `entries` の件数と等しい
    - R9: 各 `Firmness` について、行に `FIRMNESS_LABEL[firmness]` の語がそのまま現れる
    - _Requirements: 3.3, 3.10, 4.3, 5.9, 6.9_

- [x] 5. ソース静的検査と vitest 設定への登録（`tests/pending-order-list-left-rail.static.test.ts`・新規）
  - [x]* 5.1 ファイルを新設し設定へ対で登録し、配置と出所の検査を実装する（S1〜S8）
    - `vitest.config.ts` の `static` プロジェクトの `include` と `workers` プロジェクトの `exclude` へ、このファイルを**対で**足す（片方だけでは二重実行または未実行になる）
    - 既存 `tests/*.static.test.ts` の規約に倣う。`git diff` を使わず `node:fs` で実ファイルを読み、「いま存在するソースが制約を満たすか」だけを見る。トークンの不在を見る検査はコメントと文字列リテラルを除去した実コードに対して行う（`stripCommentsAndStrings` 相当は本ファイル内に実装してよい——既存 5 ファイルと同じ形）
    - S1: `OrderRail.tsx` が存在し `OrderQueue.tsx` が存在しない。`OrderRail` を export する
    - S2: `OrderRail.tsx` に `w-32` と `flex-none` が現れ、比率幅・`min-w-` / `max-w-`・ブレークポイント変種が現れない。あわせて `SlotBoard.tsx` の釜グリッドに `pl-` が現れない
    - S3: `SlotBoard.tsx` の横並びの器に `gap-` を持つクラスが無い
    - S4: `OrderRail.tsx` に `overflow-y-auto` / `overflow-x-hidden` / `overscroll-contain` が現れ、`overflow-x-auto` が現れない
    - S5: `OrderRail.tsx` に色値リテラル（`#` 16 進・`rgb(`・`hsl(`・`oklch(`）が現れない
    - S6: `OrderRail.tsx` の `style={{ … }}` が 1 箇所のみで、そのプロパティが `color` だけである
    - S7: `OrderRail.tsx` に `useState` / `useRef` / `useEffect` / `setInterval` / `setTimeout` / `ResizeObserver` / `matchMedia` が現れない
    - S8: `OrderRail.tsx` に `transition-` / `animate-` / `@keyframes` が現れず、`styles.css` の `@keyframes`（`boiledPulse` / `badgeBlink`）と `--animate-*`（`--animate-boiled` / `--animate-badge-blink`）の集合が変更前と同一である
    - 実描画で立てる主張（ロール構造・可視文言・accessible name・DOM 順）をここへ重複させない
    - _Requirements: 1.3, 2.1, 2.2, 2.7, 2.8, 3.4, 4.1, 4.2, 4.6, 6.1, 6.7, 6.11, 7.1, 7.2, 7.5_

  - [x]* 5.2 寸法・重畳・色の出所・境界の検査を実装する（S9〜S15）
    - S9: `OrderRail.tsx` に `min-h-[2.75rem]` が現れる
    - S10: `OrderRail.tsx` に `text-sm` と `text-[0.6875rem]` が現れ、`0.6875rem` 未満の `text-[…rem]` が現れない
    - S11: `OrderRail.tsx` に `z-` を持つクラスと `fixed` が現れない（ラジアルの前面性を奪わない）
    - S12: `OrderRail.tsx` が `noodleColors` を直接 import せず、色は `noodleColor` prop 経由でのみ得る
    - S13: `src/domain` / `src/engine` / `src/shell` / `src/worker.ts` に `OrderRail` / `OrderRow` の識別子が現れない
    - S14: `orderQueueEntries` が 3 引数（`view` / `units` / `now`）を保ち、`QueueEntry` が 3 フィールド（`order` / `waitingMs` / `suggestion`）を保つ
    - S15: `OrderRail.tsx` の**文字列リテラルと JSX テキスト**に日本語が現れない（日本語コメントは規約どおり残るため対象外。合意済みの調理母語は `FIRMNESS_LABEL` 経由で入る）
    - _Requirements: 3.2, 3.6, 3.9, 5.1, 5.7, 6.3, 6.5_

- [x] 6. 不変点と全量の検証
  - [x] 6.1 既存テストの無改変を確認し、全量の検証コマンドを通す
    - `tests/client/order-queue.example.test.ts` と `tests/client/format.property.test.ts` に差分が無いことを確認する。両者が 1 行も書き換わらずに通ることが、継承 property 1〜6（並び・待ち時間・提案の絞り込み・過ぎた推奨時刻・待ち時間の表記・全置換）の不変の証拠である
    - `src/domain` / `src/engine` / `src/shell` / `src/worker.ts` とワイヤのメッセージ型に差分が無いことを確認する。本番差分が `src/client/components/OrderRail.tsx` と `SlotBoard.tsx` の 2 ファイルに収まっていることを確認する
    - `App.tsx` / `queueDisplay.ts` / `noodleColor.ts` / `RadialMenu.tsx` / `styles.css` に差分が無いことを確認する
    - `pnpm typecheck`（エラー 0。`entries: NonEmptyArray<QueueEntry>` へ `isNonEmpty` の絞り込みなしに配列を渡せないことを型が拒む）
    - `pnpm lint`（error 0・warning を既存より増やさない）・`pnpm fmt` → `pnpm fmt:check`（差分なし）・`pnpm test`（`vitest --run`・失敗 0・`static` と `render` の新規 2 ファイルが実際に実行されていること）・`pnpm build`
    - _Requirements: 6.3, 6.4, 6.5_

- [x] 7. Final checkpoint - 全テストの通過と実機確認の申し送り
  - Ensure all tests pass, ask the user if questions arise.
  - 自動検査に載らない確認事項（design「手で見る」）を残タスクとして申し送る: 残り時間の文字寸法が非表示時の 80% 以上（AC 2.2）・iPad 横 1024pt / 縦 768pt で全釜カードがスクロールなしに収まること（要件 2.3）・提案ボタンの可触領域 44px 以上と語の割れの不在（AC 5.1 / 5.2）・ラジアルがレールと重なる領域でも前面に出ること（要件 5.7）・black-translucent 表示でノッチ下に内容が潜らないこと（判断 4）。`happy-dom` はレイアウトを計算しないため、これらは実機・実寸でのみ判断できる

## Notes

- `*` 付きサブタスクは任意（実描画テスト・静的検査）で、スキップしても中核実装は成立する。トップレベルタスクは任意化しない。
- 各タスクは受け入れ基準を `_Requirements: x.y_` 形式で参照する。
- **新しい PBT タスクは無い。** design「Correctness Properties」が定めるとおり本 spec 固有の property は存在せず、既存 `orderQueueEntries` / `formatRemaining` の property 1〜6 を継承する。継承の担保はタスク 6.1（既存テストの無改変）である（要件 6.4）。
- **レール幅は固定 8rem（`w-32 flex-none`）。** AC 2.2 の 80% 下限から導出した値であり、比率・メディアクエリ・`clamp` を使わない。釜グリッドに左 padding を置かない（置くと縦向きで 79.2% となり 80% を割る）。
- **レイアウトの寸法は自動検査で測れない。** `happy-dom` は実寸を 0 として返すため、AC 2.2 と AC 5.1 の実寸は算術（design「幅の規律」「ボタン内部の幅の内訳」）と静的検査 S2 / S9 で押さえ、最終確認はタスク 7 の実機確認に置く。
- 実描画テストは `OrderRail` を単体 render し、`getByRole` / accessible name で問う。クラス名は問わない——クラスの主張は静的検査が持ち、同じ主張を両方に置かない。
- 静的検査は「描画では見えないもの」に限る。ソースの字面を見る検査は描画の結果を保証しないため、実描画で立つ主張を重複させると害になる。
- スコープ外（含めない）: 向きによる出し分け・レールの手動折りたたみ・占有スロットへの提案の抑止・`main` の `aria-label="Slots"` の見直し・`tests/client/assignment-ui.example.test.ts` の古い前提コメントの訂正（design「申し送り」）。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3"] },
    { "id": 3, "tasks": ["2.1"] },
    { "id": 4, "tasks": ["4.1", "5.1"] },
    { "id": 5, "tasks": ["4.2", "5.2"] },
    { "id": 6, "tasks": ["4.3"] },
    { "id": 7, "tasks": ["6.1"] }
  ]
}
```
