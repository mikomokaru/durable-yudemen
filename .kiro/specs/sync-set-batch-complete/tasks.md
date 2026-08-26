# Implementation Plan: 同時上がり群の一括消し込み（sync-set-batch-complete）

## Overview

設計（`design.md`）の骨格「クライアントに純粋関数を一つ足し、既存 `complete` の意味を広げるだけ」に厳密に対応した実装計画である。実装言語は **TypeScript（strict）**、ツールは `tooling.md` に従い **pnpm / Vitest v4 / fast-check v4 / oxlint / `tsc --noEmit`** を用いる。テスト対象はいずれも純粋関数と `openTimerConnection` の端であり、workerd を要さない（既定 pool）。

**本番コード（`src/`）で変更するファイルは 2 つだけである。**

1. `src/client/boiledGroup.ts`（新規）— 純粋関数 `boiledGroup(view, timerId, correctedNow)`。同時上がり群を押下時のビューから再構成する。
2. `src/client/connection.ts` — `openTimerConnection` が返す `complete` の実装をファンアウトへ広げる。`TimerConnection` のシグネチャは不変（docstring のみ更新）。加えて `decideServerMessage` の error 分岐で `TimerNotFound` を提示対象から外す（タスク 7.1・要件6.14）。

**`connection.ts` は 2 箇所を触るが、変更ファイルは 2 つのままである。** タスク 2.1（`complete` のファンアウト）とタスク 7.1（error 畳み込みの 1 分岐）はいずれも同一ファイル内で、新規ファイルは生じない。`ClientEvent` / `ClientView` の型・`reconcileServerConfirmed` / `dueLocalTimers`・UI 3 ファイルはどちらでも不変である。ゆえに上の「変更するファイルは 2 つだけ」と矛盾しない（design「ファンアウトが重複 complete を系統的に生む」の不変点の修正と同じ記録）。

**テスト側では次のファイルを新規作成・追記する**（本番 2 ファイルの不変点とは別の計数である）。

- `tests/client/boiledGroup.property.test.ts`（新規）— Property 1〜9。
- `tests/client/complete.example.test.ts`（追記）— 経路分けと端の観測、残滓の反映順、重複 complete の拒否の非提示。
- `tests/sync-set-batch-complete.static.test.ts`（新規）— 不変点と純粋性の静的検査。
- `vitest.config.ts`（追記）— 上の新規 static test を node 環境へ登録する 3 行。既存 13 本の static test と同一の形で、`include` と除外側の両方へ足す。
- `tests/client/connection.example.test.ts`（追記）— 既存テスト 1 件が仕様変更に追随する。running な provisional へ complete を呼ぶ形は窓口の関門（`boiledGroup` が対象 running のとき空を返す）で弾かれるため、押下前に boiled まで到達させる形へ直す。
- adapter generator の置き場（タスク 1.2）— 既定は `tests/client/boiledGroup.property.test.ts` 内。専用生成器ファイル `tests/client/boiledGroupGenerators.ts`（新規）へ切り出してもよい。**いずれの場合も `tests/client/generators.ts` は変更しない。**

**UI は変更しない。** `SlotCard.tsx` / `SlotBoard.tsx` / `components/slotDisplay.ts` に差分は生じない。Complete ボタンの呼び先（`connection.complete(timer.id)`）が不変のまま、その意味が広がる（要件7.1 / 7.2 / 7.3）。この不変はタスク 5.1 の静的検査で守る。

**サーバ契約も変更しない。** `src/domain/**` / `src/engine/**` / `src/shell/**` に差分は生じない。新しい `ClientMessage` / `ServerMessage` 種別・engine 公開関数・Effect 種別・`ClientEvent` 種別を足さず、既存 `complete` メッセージと既存 `LocalComplete` の複数回畳み込みだけで実現する（要件9 / 10）。

実装は依存順に、`boiledGroup`（群の再構成）→ `complete` のファンアウト（既存 origin × mode 経路をメンバーごとに回す）→ Example による経路分けと端の観測 → 静的検査、の順で積み上げる。宙に浮くコードを残さない。

**命名確認は不要（済）。** 本機能が導入する公開シンボルは `boiledGroup` ただ一つで、既存 `complete` の意味拡張と併せてユーザー確認済みである（design.md「命名（ユーザー確認済み・確定）」）。ゆえに実装ゲートとしての命名確認タスクを置かず、タスク 1.1 から着手する。

PBT は設計の 9 プロパティを各 1 サブタスクとして実装する。テスト系サブタスク（`*` 付き）は任意で、スキップしても中核実装は成立する。

各タスクの完了条件は共通で **`pnpm typecheck`（エラー 0）/ `pnpm lint`（error 0・warning は既存 47 件を増やさない）/ `pnpm test`（`vitest --run`・失敗 0）が通ること**。テストは watch を使わず単発実行する。`npm` / `npx` / `yarn` は用いない。

## Tasks

- [x] 1. 同時上がり群の再構成 `boiledGroup` を実装（src/client/boiledGroup.ts・新規）
  - [x] 1.1 純粋関数 `boiledGroup` を実装する
    - `src/client/boiledGroup.ts`（新規）に `boiledGroup(view: ClientView, timerId: string, correctedNow: number): readonly ClientTimer[]` を実装する。`ClientTimer` / `ClientView` は `import type { ClientTimer, ClientView } from "./connection"` の**型限定 import** で受ける（実行時の循環を作らない）
    - 対象が不在、または running（`endTime > correctedNow`）のときは空を返す（要件1.2 / 3.2）。boiled の検査は**対象について一度だけ**行い、メンバーは実効 endTime（`TimerFact.endTime`）の等値のみで集める。判定形は `endTime <= correctedNow`（`dueLocalTimers` と同一述語）
    - 対象自身を必ず含み（要件1.4）、並び順は `view.timers` の並びを保つ。新しい順序規律・許容窓・新しい型を導入しない
    - **担当射影を掛けない。** `view.timers` 全体から集め、担当ユニット外のスロットを駆動するメンバーも群の一員とする（要件4.1 / 4.2）
    - 時計・WS・DOM・localStorage に触れない（`correctedNow` は端が `now() + view.offset` で採って渡す）
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 3.1, 3.2, 4.1, 4.2, 9.4_

  - [x]* 1.2 PBT の生成器を整える（既存 generators.ts の再利用と production 型への adapter）
    - `tests/client/generators.ts` の既存 `genClientTimer` / `genClientView` / `genCorrectedNow` を再利用し、**同じ生成器を二重定義しない**。本機能に要る次元だけを追加する
    - **`genClientView` は production の `ClientView` を返さない。** `generators.ts` の `ClientView` は tests ローカルに定義された独自 interface で、`timers` / `offset` / `processedIds` / `connectivity` / `sync` / `error` の 6 フィールドしか持たない。production の `ClientView`（`src/client/connection.ts`）は 12 フィールド（上記 6 つに加え `pendingOrders` / `recommendations` / `lastResults` / `unreachableReason` / `unitCount` / `noodlePresets`）である。`boiledGroup` は production の `ClientView` を受けるため、`genClientView` の出力をそのまま渡すと `pnpm typecheck` が通らない
    - 対処は `tests/client/audioGenerators.ts` の `genAudioView` と**同形の adapter generator を本 spec 用に作る**こと。`genClientView.map((view): ClientView => ({ ... }))` で production 型へ補完し、型は `import type { ClientView } from "../../src/client/connection"` で受ける。補完の既定値は `pendingOrders: []` / `recommendations: []` / `unreachableReason: "offline"` / `unitCount: DEFAULT_UNIT_COUNT` / `noodlePresets: DEFAULT_NOODLE_PRESETS`（後 2 者は `src/domain/store` から import）
    - ただし `lastResults` は Property 8 の検査対象である。**空 Map 固定にせず、「空」と「既存残滓が在る状態」の双方を生成する**（既存残滓が在る状態で一括完了すると上書きが起きる。その入力を落とせば要件8.4 の検査が弱くなる）
    - 共有 `generators.ts` 自体を production 型へ移行する作業は**本 spec のスコープ外**とし、本 spec は adapter で受ける（`generators.ts` を書き換えると既存の全 Property テストへ波及する）
    - `endTime` を少数の候補から引く生成器を混ぜて**同値衝突を意図的に多く生む**。`endTime === correctedNow`（境界＝boiled 側）を必ず含める
    - `slotIds` に担当ユニット内・外の両方と、**同一スロットを複数メンバーが駆動する退化入力**を含める（Property 5 / 8 の前提。除外すれば要件8.4 / 8.8 が未検証になる）
    - 群外 Timer に、群メンバーと同一スロットを駆動するものを混ぜる（要件2.6 / 8.8 の前提）。対象 `timerId` は「ビュー内の boiled」「ビュー内の running」「不在」の三種を分布させる。`origin` は `server` / `local` 混在、`processedIds` は空・一部一致・無関係を混ぜる
    - 反映順は `fc.shuffledSubarray([...group], { minLength: group.length, maxLength: group.length })` で全要素の置換を得る（**fast-check 4.8.0 に `fc.shuffle` は無い**。`minLength` / `maxLength` を要素数へ固定しないと長さが縮んでメンバーが落ちる）。既存前例は `tests/registry/compose.property.test.ts` / `roster.property.test.ts` / `code-index.property.test.ts` / `tests/core/schedule.property.test.ts` / `tests/operation-history/parser-failures.property.test.ts`
    - 置き場は `tests/client/boiledGroup.property.test.ts`（新規・既存 `tests/client/*.property.test.ts` の規約に従う）内、または既存前例に倣い専用生成器ファイル `tests/client/boiledGroupGenerators.ts`（新規）。どちらでもよいが、**`generators.ts` の既存生成器を二重定義しない**規律は保つ
    - _Requirements: 1.1, 4.2, 8.4, 8.8_

  - [x]* 1.3 群が対象自身を含むことの property test
    - **Property 1: 群は対象自身を含む**
    - **Validates: Requirements 1.4**

  - [x]* 1.4 全メンバーが boiled であることの property test
    - **Property 2: 全メンバーが boiled である**
    - **Validates: Requirements 1.6, 3.1**

  - [x]* 1.5 実効 endTime 等値と漏れ無しの property test
    - **Property 3: 全メンバーの実効 endTime が対象と等しい**
    - **Validates: Requirements 1.1, 1.3**

  - [x]* 1.6 対象が running / 不在なら群を形成しないことの property test
    - **Property 4: 対象が running または不在なら群を形成しない**
    - **Validates: Requirements 1.2, 3.2**

  - [x]* 1.7 担当スコープ非依存の property test
    - **Property 5: 群は担当スコープに依存しない**
    - **Validates: Requirements 4.1, 4.2**

- [x] 2. `complete` の意味をファンアウトへ広げる（src/client/connection.ts）
  - [x] 2.1 `openTimerConnection` の `complete` をファンアウト実装にする
    - `src/client/connection.ts` の `openTimerConnection` 内 `complete` を、design「ファンアウトの形」の形に置き換える。`const at = now()` を**一度だけ**採り、`boiledGroup(view, timerId, at + view.offset)` で群を再構成する（押下時刻と群の基準時刻を同じ瞬間から導く）
    - メンバーごとに既存の origin × mode 経路を適用する——`live && member.origin === "server"` なら `watch.send({ type: "complete", timerId: member.id })` を **fire-and-forget** で発行し（送信完了を待たない・`Promise.all` を持ち込まない）、それ以外は `next = decideView(next, { kind: "LocalComplete", timerId: member.id, now: at })` で畳む
    - **`update(next)` はループの外で一度だけ呼ぶ。** 中間ビュー（群の一部だけが消えた盤面）を購読者へ notify せず、`persistence.save` もメンバー数だけ走らせない。群が空のときは `next === view` ゆえ参照同一で早期 return する
    - `TimerConnection` のシグネチャは変えない。`complete` の docstring を「その Timer と同時上がり群を完了する（単一は退化ケース）」へ更新する
    - `ClientView` / `ClientEvent` / `decideView` / `reconcileServerConfirmed` / `dueLocalTimers` には触れない（新しいイベント種別・状態・窓口を作らない）
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 5.1, 5.2, 6.3, 7.2, 8.1, 8.2, 10.3_

  - [x]* 2.2 1 件退化時の一致の property test
    - **Property 6: 1 件のときは単一消し込みと一致する**
    - **Validates: Requirements 2.2**

  - [x]* 2.3 degraded の一括除去と処理済み記録の property test
    - **Property 7: degraded の一括は全メンバーを除去し処理済みに記録する**
    - **Validates: Requirements 5.3, 5.4**

  - [x]* 2.4 残滓が反映順で最後のメンバーになることの property test
    - **Property 8: 残滓は反映順で最後のメンバーの麺種になる（ローカル畳み込み経路）**
    - 反映順は `fc.shuffledSubarray` による群の並びの置換で与える（タスク 1.2）。適用範囲を degraded / provisional 経路に**明示的に限定**し、live の反映順と占有スロットの扱い（要件8.5 の live 節 / 8.6 / 8.7）は Example が担う
    - **Validates: Requirements 8.1, 8.2, 8.4, 8.8**

  - [x]* 2.5 群に属さない Timer の不変の property test
    - **Property 9: 一括完了は群に属さない Timer を変えない**
    - **Validates: Requirements 3.2**

- [x] 3. Checkpoint - 群の再構成とファンアウトの検証
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Example テストを追記（tests/client/complete.example.test.ts）
  - 新規ファイルを作らず、`openTimerConnection` レベルの complete 遷移を既に扱う既存ファイルへ**追記**する。
  - [x]* 4.1 経路分けと端の観測の example test
    - **live × 全 server-confirmed** — 同一 endTime の boiled 2 件を hydration で受け、片方を complete → `send` が `complete` を 2 回発行し `timerId` は 2 件それぞれ。ビュー不変ゆえ `persistence.save` は呼ばれない
    - **degraded** — Connectivity を down にしてから complete → `send` はゼロ。ビューから 2 件消え、`persistence.save` は **1 回**（`update` を畳む判断の検証）
    - **混在（live）** — server-confirmed と Provisional_Timer が同一 endTime で boiled のとき、server 分は `send`、local 分はローカル除去
    - **1 件（退化）** — 同一 endTime の他メンバーが無いとき `complete` を 1 回だけ送る
    - **対象 running** — running な Timer の id で `complete` を呼んでも `send` ゼロ・ビュー不変（群が空で `update(view)` が早期 return する）
    - **担当外メンバー** — 担当ユニット外のスロットを駆動する boiled メンバーも消し込まれる
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 4.1, 4.2, 5.1, 5.2, 6.3, 1.2, 3.2_

  - [x]* 4.2 完了後の表示導出の example test
    - **完了後の idle 導出** — 群を除去した後、当該スロットを駆動する Timer が残らず、かつ `sync === "synced"` であれば `assignedSlotDisplays` が `idle` を導出する
    - **未同期での完了後は unreceived** — 再水和直後（`sync === "connecting"`）に degraded で一括完了し、当該スロットを駆動する Timer が残らないとき `idle` ではなく `unreceived` を導出する（`persistence.load()` で server-confirmed を再水和してから hydration を受けずに complete する経路で固める）
    - **完了後もスロットが占有される** — 群メンバーと同一スロットを駆動する群外 Timer が在るとき、除去後も `idle` にならず running（走行中があれば優先）または boiled になる（いずれも最早 endTime）
    - `components/slotDisplay.ts` は変更せず、既存導出の帰結として確認する
    - _Requirements: 2.5, 2.6, 2.7_

  - [x]* 4.3 残滓の反映順と占有スロットの example test
    - **degraded の畳み込み順** — 端のループは `boiledGroup` の返す並び（＝`view.timers` の並び）で `LocalComplete` を畳む。同一スロットを駆動する 2 メンバーで、並びの後のメンバーの麺種が残滓に残る（要件8.5 の degraded 節）
    - **degraded の占有スロットへの記録** — 群外 Timer が当該スロットを占有していても `recordLastResults` は残滓を記録する（要件8.8）
    - **live の占有スロットの残滓** — server-confirmed メンバーの除去が snapshot で届くとき、当該スロットが新 serverTimers または保持 provisional に占有されていれば、残滓は記録されず既存の残滓も消える（要件8.7）。値の選択規則（要件8.4）はここでは適用先を持たない
    - **同一 snapshot 内の反映順** — 同一スロットを駆動する server-confirmed 2 件を一括完了し、**中間 snapshot を受けずに**両者が消えた全量 snapshot を 1 通だけ受ける。残滓は `prevServer`（直前の保持列から server-confirmed を抽出した並び）で後に現れるメンバーの麺種になる。到着順では決まらないことを固定する
    - **混在の反映順** — 同一スロット・同一実効 endTime の provisional と server-confirmed を一括完了し、その後 server 分の除去を反映した snapshot を受けると、残滓は後に反映された server 分に従う。**保持列で最後の provisional が残るとは限らない**ことを固定する
    - `recordLastResults` / `reconcileServerConfirmed` は変更せず、既存規律の帰結として確認する
    - _Requirements: 8.4, 8.5, 8.6, 8.7, 8.8_

- [x] 5. 静的検査（Smoke）
  - [x]* 5.1 不変点のソース静的検査を実装する
    - `tests/sync-set-batch-complete.static.test.ts`（新規・既存 `tests/*.static.test.ts` の規約に倣いソーステキストを直接検査する）に次を実装する
    - (a) `src/engine/**` / `src/domain/**` / `src/shell/**` に本機能由来の差分が無いこと——同期計算・発火判定・`TimerFact` の 6 フィールド・`ClientMessage` / `ServerMessage` の種別・engine 公開関数・Effect 種別が増えていないこと
    - (b) `ClientEvent` の種別が増えていないこと（既存 `LocalComplete` の複数回畳み込みで実現している）
    - (c) UI に差分が無いこと——`components/SlotCard.tsx` / `SlotBoard.tsx` / `components/slotDisplay.ts` が一括完了のための操作要素・確認ダイアログ・視覚フィードバックを持たず、Complete の操作口が担当スロットに対してのみ描画される構造を保つこと
    - _Requirements: 4.3, 7.1, 7.3, 8.3, 9.1, 9.2, 9.3, 9.4, 10.1, 10.3_

  - [x]* 5.2 `boiledGroup.ts` の純粋性の静的検査を実装する
    - `src/client/boiledGroup.ts` が `connection.ts` から**型限定 import**（`import type`）のみを行い、時計（`Date` / `clock.ts` の実時刻）・WebSocket・DOM・localStorage を import も参照もしないことを検査する
    - 既存の純粋性検査（`tests/offline-degradation.static.test.ts` の純粋層検査）と同じ規律に追随させる
    - **`stripCommentsAndStrings` 相当は新規 static test 内に実装してよい。** 同名の関数は既存 5 ファイル（`tests/static-analysis.example.test.ts` / `tests/offline-degradation.static.test.ts` / `tests/per-store-provisioning.static.test.ts` / `tests/observe/static-analysis.example.test.ts` / `tests/client/audioWakeLock.example.test.ts`）に非 export で重複しており、新しいテストから import できない。既存 5 ファイルと同じ形に倣う
    - 共有 helper への抽出と既存 5 ファイルの移行は**本 spec のスコープ外**である。1 ファイルだけを共有 helper へ寄せても 6 箇所中 1 つだけが共有される中途半端な状態になり、既存 5 ファイルの移行は本 spec の不変点（本番の変更は `src/` の 2 ファイル）とスコープが衝突する
    - _Requirements: 9.4, 10.3_

- [x] 6. Final checkpoint - 全テストと静的検査の通過
  - `pnpm typecheck`（エラー 0）・`pnpm lint`（error 0・warning は既存 47 件を増やさない）・`pnpm test`（`vitest --run`・失敗 0）・`pnpm build` を通す。
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. 重複 complete の拒否を提示しない（要件6.11〜6.17・タスク 1〜6 の完了後に追加）
  - ファンアウトは同一メンバーへの二度目の `complete` を系統的に生む。その拒否 `TimerNotFound` は「対象が既に無い」という報告であり、利用者の意図は達成済みである。ゆえに提示しない。
  - [x] 7.1 `TimerNotFound` を提示対象から外す（src/client/connection.ts）
    - `decideServerMessage` の `case "error"` に `code === "TimerNotFound"` の分岐を足し、`view.error` を更新せず `offset` の最新化だけを行う（要件6.14）
    - それ以外の code（`InvalidSlotOrNoodle` / `CapacityExceeded` / `InvalidBoilSeconds` / `UnknownNoodle` 等）は従来どおり `view.error` を当該 code と message で立てる（要件6.15）
    - 判断は error の code のみで行い、complete / cancel / adjust の由来で区別しない（要件6.17）。`ServerMessage.error` に由来を載せない
    - engine 契約はゼロ変更のまま。`completeTimer` を冪等にしない。`ClientEvent` / `ClientView` の型・`reconcileServerConfirmed` / `dueLocalTimers`・UI 3 ファイル（`SlotCard.tsx` / `SlotBoard.tsx` / `components/slotDisplay.ts`）も不変
    - _Requirements: 6.14, 6.15, 6.17_

  - [x]* 7.2 重複 complete の拒否を提示しないことの example test（tests/client/complete.example.test.ts）
    - **再押下が起きること** — snapshot 未到着でも Complete の操作口が残り、同一メンバーへ再度 `complete` が飛ぶ（要件6.11 / 6.12）
    - **非提示** — `TimerNotFound` を受けても `view.error` は `null` のまま。`offset` だけが最新化される（要件6.14）。offset の観測は「error を立てない」と「拒否をまるごと捨てる」を区別するために要る
    - **他の拒否種別** — `CapacityExceeded` は従来どおり `view.error` を立て、その後に `TimerNotFound` が届いても既存の error が消えない（要件6.14 は「更新しない」であって「null にする」ではない）
    - **二台の端末** — `setupWithWatch` を 2 つ作り、同一 Sync_Set のメンバーを両者が押す。負けた側の `TimerNotFound` が提示されない（要件6.16）
    - _Requirements: 6.11, 6.12, 6.14, 6.15, 6.16_

- [x]* 8. SlotCard の実描画境界の example test（tests/client/complete.example.test.ts）
  - `SlotCard` 本体を `react-dom/server` の `renderToStaticMarkup` で実際に描画する。既存の `.ts` テストからは `createElement` を用い、新しい DOM / renderer 依存を追加しない
  - boiled の描画結果に `aria-label="Complete"` の `button` がちょうど 1 つ存在することを確認する。running と idle の描画結果には当該 Complete ボタンが存在しないことを確認する
  - `SlotCard.tsx` の `isBoiled` 式・分岐文字列を読む静的検査や、分岐をテスト側へ写した純粋関数テストでは代替しない。検査対象は実コンポーネントの SSR 出力とする
  - SSR では click 動作を検証しない。描画境界だけを対象とし、要件7.2を検証したと主張しない。production の `SlotCard.tsx` は変更しない
  - _Requirements: 7.1, 7.3_

## Notes

- `*` 付きサブタスクは任意（PBT・Example・静的検査）で、スキップしても中核実装は成立する。トップレベルタスクは任意化しない。
- **タスク 7（要件6.11〜6.17）は後から足した。** タスク 1〜6 の完了後のコードレビューで、当初の requirements / design が扱っていない経路——ファンアウトが生む重複 complete とその拒否の提示——が見つかったため、要件6.11〜6.17 を追加して対応した。
- 各タスクは特定の受け入れ基準を `_Requirements: x.y_` 形式で参照し、各 property test タスクは `Validates: Requirements x.y` を明記する。
- PBT は fast-check で各プロパティ **最低 100 イテレーション**、タグ形式 `Feature: sync-set-batch-complete, Property {番号}: {プロパティ本文}` を付す。PBT を自前実装しない。
- **fast-check 4.8.0 に `fc.shuffle` は無い。** 全要素の置換は `fc.shuffledSubarray([...group], { minLength: group.length, maxLength: group.length })` で得る。
- 純粋層テストは `Date.now` のスタブも `vi.useFakeTimers()` も用いない（`boiledGroup` と `decideView` はいずれも時刻を引数で受ける）。
- **既存純粋関数を再利用し二重定義しない** — 残り導出は `clock.ts`、通知冪等性は `notification.ts`、担当射影は `assignment.ts`、表示導出は `components/slotDisplay.ts` をそのまま用いる。生成器は `tests/client/generators.ts` を再利用するが、`genClientView` は tests ローカル型を返すため production `ClientView` へ補完する adapter を挟む（タスク 1.2）。
- **不変点（本番コードの計数）** — **`src/` の変更は** `src/client/boiledGroup.ts`（新規）と `src/client/connection.ts` の 2 ファイルのみ。`connection.ts` で触るのは `complete` 実装（タスク 2.1）と `decideServerMessage` の error 分岐 1 箇所（タスク 7.1）で、ファイル数は 2 のままである。テスト側の新規作成・追記（Overview の一覧）はこの計数に含めない。`src/domain/**` / `src/engine/**` / `src/shell/**`・`connection.ts` の `ClientView` / `ClientEvent` / `reconcileServerConfirmed` / `dueLocalTimers`（`decideView` はタスク 7.1 が呼ぶ `decideServerMessage` の error 分岐 1 点を除いて不変。design「ファンアウトが重複 complete を系統的に生む」の不変点の修正と同じ）・`components/slotDisplay.ts` / `SlotCard.tsx` / `SlotBoard.tsx`・`assignment.ts` / `clock.ts` / `notification.ts` / `persistence.ts` には触れない。
- **待機を持ち込まない。** live の送信は fire-and-forget のままとし、`Promise.all` 的な完了待機・進行中フラグ・クライアント側の再送機構を作らない。put が失敗したメンバーは正本に残り、次の snapshot 契機（他の確定変化に伴う全量 snapshot・再接続時の全量 hydration）で収束する（要件6.5 / 6.8 / 6.6）。
- **Boiled_Group は状態にしない。** 押下のたびに `view.timers` と補正後現在時刻から再構成する導出値であり、`ClientView` のフィールドにしない（要件9.4）。
- テストに向かない性質はタスクに含めない——サーバ側の収束（要件6.1 / 6.2 / 6.4 / 6.5 / 6.6 / 6.8）と二つの boiled 記録の窓（要件6.9 / 6.10）は既存機構の記述であり、design「Error Handling」が対応先を明示している。経路をまたぐ反映順（要件8.6 / 8.9）も規定しないことが設計判断であるため、Example は各経路内の決定性のみを固める。
- スコープ外（含めない）: `synchronize` のアルゴリズム変更、Sync_Set membership の配信、原子的な単一 snapshot、送信結果の待機・再送、`recordLastResults` と `reconcileServerConfirmed` の占有スロット扱いの非対称の解消、`tests/client/generators.ts` のローカル型から production `ClientView` への移行、静的検査 helper（`stripCommentsAndStrings`）の共有抽出と既存テストの移行。

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "1.3"] },
    { "id": 2, "tasks": ["1.4"] },
    { "id": 3, "tasks": ["1.5"] },
    { "id": 4, "tasks": ["1.6"] },
    { "id": 5, "tasks": ["1.7"] },
    { "id": 6, "tasks": ["2.2"] },
    { "id": 7, "tasks": ["2.3"] },
    { "id": 8, "tasks": ["2.4"] },
    { "id": 9, "tasks": ["2.5"] },
    { "id": 10, "tasks": ["4.1", "5.1"] },
    { "id": 11, "tasks": ["4.2", "5.2"] },
    { "id": 12, "tasks": ["4.3"] },
    { "id": 13, "tasks": ["7.1"] },
    { "id": 14, "tasks": ["7.2"] },
    { "id": 15, "tasks": ["8"] }
  ]
}
```
