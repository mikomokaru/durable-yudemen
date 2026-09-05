# Implementation Plan: 同時に上げる群の計画（lift-group-planning）

## Overview

計画の**内側を替える**変更である。層も経路も増えない——目的関数の卓同期項を入れ替え、走行中 Timer に卓の事実を宿し、`slotSpan` を割当が読むようにする。加えて `score` を計画の型から**落とす**ので、差分は足し算より引き算が多い。

実装は依存順（engine の葉 → 採点 → 配置 → 合成/ゲート → 後処理 → 状態と永続 → 作用と外周 → テスト）で進める。**葉は `project.ts` ではなく `timer.ts` の `Ordered` である**——`tableMembers` が `orderItem?.tableId` を読むので、項目の追加が射影より先に来る。`pnpm typecheck` は `tsc --noEmit` で `tsconfig.json` の `include` が `src` / `tests` / `tools` を含むため、**型検査は全体で一つの結果しか返す**。フィクスチャと生成器の更新を型変更と同じクラスタに置き、クラスタ末尾のチェックポイントで green を取る（`slot-suggested-start` で学んだ順序）。

### 型エラーの面を先に測った（実測・2026-09-04）

| 変更 | 波及 |
| --- | --- |
| `ScheduleParams` に必須 `arms` | `orderSyncWeight:` を含むリテラルが **15 ファイル**（src 4・tests 11）。うち `StoreConfig` のリテラルは `arms` を既に持つので実質は `ScheduleParams` を組む側だけ。共有フィクスチャ（`tests/storeConfigDefaults.ts` / `tests/core/scheduleScenes.ts`）で大半が畳める |
| `PlanSlice` / `CookSchedule` から `score` | 触るのは src **5 ファイル**（`schedule.ts` 型と受け口・`commit.ts` 埋め込み・`admit.ts` 比較・`settle.ts` 等価判定・`migrate.ts` 復元）と tests **7 ファイル**（`score:` のリテラルが 6・`.score` の参照が 4・重複あり） |
| `baselineSchedule` に `members` | 呼び出し元が **10 ファイル**（src 3＝`schedule.ts` / `commit.ts` / `solver/index.ts`・tests 7） |
| `scoreSchedule` に `members` | 呼び出し元が **6 ファイル**（src 4・tests 2）。うち `schedule.ts` / `commit.ts` は呼び出しごと消える |
| `committedSchedule` の戻り値から `score` | 呼び出し元が **9 ファイル**（src 4・tests 5） |
| `orderItem` の入れ子に `tableId` | `orderItem: {` のリテラルが **7 ファイル**（src 3＝`start.ts` / `timer.ts` / `client/connection.ts`・tests 4）。client 側は `TimerConnection` の引数で engine の `Ordered` とは別物ゆえ影響しない |
| `RequestPlan` に `noodlePresets` | 組む場所は `settle.ts` の 1 箇所、読む場所は shell の `requestPlan` の 1 箇所 |

`score` の撤去と `members` の追加は同じ関数群（`schedule.ts` / `commit.ts` / `admit.ts`）に落ちるので、**1 つのクラスタで両方やる**。片方だけ入れた中間状態を作ると、型検査が二度赤くなるだけで得るものがない。

### スコープ外

Boil_Sync（`sync.ts` / `settle.ts` の同期・arms 分割・`toleranceRatio`）、client の表示（`lift-group-display`）、client ワイヤ 4 種、`recommend` の形、`hasLapsedStart`、`StoreConfig` の項目と妥当域、開始時の `slotSpan` 検査、`TimerFact` への `tableId`、外部ソルバの内部実装、品目内の釜距離の採点、`tableSyncToleranceSeconds` / `orderSync*` の撤去。

## Tasks

- [x] 1. 公開シンボルの確認と要件の改訂（実装前にユーザー確認）
  - 実測・2026-09-04: ブランチ `mikomokaru/lift-group-planning` を `origin/main`（bd81904・#27 マージ後）から切った。lapsed ブランチの未コミット変更は WIP コミットで退避。`lapsed-suggestion-timing` は #27 としてマージ済みだった（spec の「未マージ」を訂正済み）。要件の改訂 6 件は適用済み。公開シンボル 7 件（内部関数 4 件は対象外）はユーザー承認済み（2026-09-04）。
  - コードを書く前に**公開シンボル 6 件**を確定する（`naming.md`）。承認が得られるまで後続へ進まない。一覧の正本は design の「公開シンボルの確認ゲート」節。
    - `TableMembers` / `tableMembers(running)`（`project.ts`・型と公開関数の対で 1 件）
    - `scoreSchedule(slices, pending, members, params)` / `baselineSchedule(pending, release, members, presets, params)`（署名の変更で 2 件）
    - `ScheduleParams.arms` / `Ordered.orderItem.tableId`（入れ子）/ `RequestPlan.noodlePresets`（型の項目で 3 件）
    - `PlanSlice.score` / `CookSchedule.score` の**削除**（同じ概念の対で 1 件）
    - `tableLagSeconds` / `armsOverflow` / `armsOverflowWeight` / `ceilSeconds` は**確認の対象にしない**——export しない内部関数であり、`naming.md` の公開シンボルに当たらない。design のゲート表に記録は残すが、承認は要らない。
  - あわせて**要件の改訂 6 件**を適用する（design の「要件への申し送り」）。承認済みだが、requirements 側の文言が変わるまでコードの根拠が spec と食い違う。
    - 観測事実 14 の訂正（`PlanRequest` は既に `noodlePresets` を運ぶ。欠けは Effect 側で、実害は入力が二箇所から来ること）
    - Glossary の Arms_Overflow を「同時刻に上がる Table_Member の本数のうち `arms` を超える分」へ
    - AC 3.1 を `Ordered.orderItem.tableId`（入れ子）へ
    - AC 4.2 に `slotIds` が相異なることを明示
    - 性質 7.2 に「ずれが 1 ミリ秒でも成り立つ」を追記
    - AC 8.4 に「`tableSyncToleranceSeconds` は `ScheduleParams` に在るが読む計算が無い」を追記
  - _Requirements: 全体_

- [x] 2. engine の葉 — 卓の事実と、その射影
  - 実測・2026-09-04: コミットを常に green に保つため、7.2 の写し（`startOrderItemTimer` が `item.tableId` を写す）・7.3 の `reviveOrderItem`（`tableId` の欠如 / 壊れを null へ）・10.3 のテストリテラル 4 ファイル（`timer.example` を含め 5 ファイル）を 2 と同じコミットで済ませた。typecheck 0・1358 テスト全通過。
  - [x] 2.1 `Ordered.orderItem` に `tableId` を宿す（型の変更だけ）
    - `orderItem: { externalOrderId; itemIndex; tableId: string | null } | null`。**直下に置かない**——`(orderItem = null, tableId 非 null)` という「POS を経ないのに卓を知る Timer」を構築不能にする。
    - `Ordered` の doc の「用途は開始済み品目の同定ひとつ」を書き換える（卓の同定が二つ目の用途）。
    - **この項目が無いと 2.2 が書けない。** `tableMembers` は `orderItem?.tableId` を読む。写す側（`startOrderItemTimer`）と永続の移行は task 7 で扱い、ここは型だけを動かす。
    - _Requirements: 3.1, 3.5_

  - [x] 2.2 `project.ts` に `tableMembers` を足す
    - `export type TableMembers = ReadonlyMap<string, NonEmptyArray<EpochMillis>>`。鍵は `tableId`、値は実効 endTime の**昇順**（`Map` の走査順は `running` の並びに依存するため、値の側で決定性を確立する）。
    - `tableId` が `null` の Timer は表に現れない（鍵を持たない）。除外の条件文を書かない——`orderItem?.tableId` が `null` なら鍵が無い、で足りる。
    - 実効 endTime は同ファイルの `adjustedEndTime` を用いる（`endTime + adjustment` を二度書かない）。
    - _Requirements: 2.1, 2.3, 3.3_

- [x] 3. 採点
  - 実測・2026-09-04: task 3〜5・6.1・7.2・8.2・8.3・10.1〜10.3 を 1 クラスタ（1 コミット）で実施。7.3 のうち `reviveAcceptedSlice` の score 検査の撤去も型整合のため同時に済ませた（版の繰り上げは 7.3 に残る）。既存テストは計画の意味論（許容幅→錨への一致・点数の撤去）に合わせて期待値を更新。typecheck 0・224 ファイル全通過。 — 卓の成員を数える
  - [x] 3.1 `ScheduleParams` に `arms` を足す
    - 重み 3・`arms` 1・許容幅 2・距離 1・レイアウト 2 の 9 値になる（`arms` は本数であって重みではない）。doc の「ちょうど 8 値」をこの内訳へ。
    - `tableSyncToleranceSeconds` の doc に「本項目を読む計算は無い（撤去候補・`online-cook-scheduling` の design に記録）」を書く。読み手がいない値を黙って残さない。
    - _Requirements: 2.4, 5.1, 6.5_

  - [x] 3.2 卓同期項を Table_Lag の和へ替える
    - `ceilSeconds(millis)`（切り上げ）を足し、`tableLagSeconds(serveTimes)` = `Σ ceilSeconds(max − t)` を書く。空列は 0。
    - **切り上げである理由をコメントに残す。** 切り捨てで揃えると、1 ms ずらした計画が wait の floor を 1 下げて lag を増やさず「真に良い」を作り、client が `serveAt` の等号で組む群を割る。既存 `toWholeSeconds` の「規則を二つ持たない」注記と衝突するので、**役割の違い**（wait は水準ゆえ切り捨て・lag は逸脱の罰ゆえ切り上げ）を明記する。
    - `serveSpread` / `excessSeconds` はオーダー同期項が使い続けるので残す。
    - _Requirements: 2.1, 2.2, 2.8, 7.2_

  - [x] 3.3 `armsOverflow` の項を足す
    - `armsOverflow(serveTimes, arms)` = 同じ `serveAt` を持つ成員を束ね `Σ max(0, 本数 − arms)`。`armsOverflowWeight(params)` = `max(0, params.tableSyncWeight − 1)`。
    - 定数を置かない（判断 8）。「卓 > arms」が式から出ることをコメントに書く。
    - _Requirements: 2.4, 7.10_

  - [x] 3.4 `scoreSchedule` の署名を替える
    - 第 3 引数に `members: TableMembers`。`Omit<PlanSlice, "score">` を `PlanSlice` へ（`:86` の段落を撤去）。
    - `scoreSlice` は当該一片の成員（`members.get(slice.tableKey) ?? []`）を受け、`placements.map(serveAt)` と連結した列で lag と arms を数える。走行中は `waitSeconds` に寄与しない（その待ちは既に実現済み）。
    - **卓なしの除外は文字列一致から従う。** 単独キーは NUL 始まりで `tableId` は非空文字列なので、`get` が当たらない。条件文を書かない。
    - `:73-77` の確定式と「3 項すべてが許容幅からの超過分で揃い、到達可能な下限 0 を持つ」を書き換える。卓同期項は Table_Lag の和・`Σ Wait_Time` の対象は Placement のみ・lag の対象は走行中を含む、と式を分ける。下限 0 は「走行中の仲間が無い卓で到達可能」に弱める（AC 3.4）。
    - _Requirements: 2.1, 2.3, 2.5, 2.9, 8.3_

- [x] 4. 配置 — 錨へ揃え、`slotSpan` 個の釜を占める（`score` の撤去を同時に行う）
  - [x] 4.1 型から `score` を落とす
    - `PlanSlice` / `CookSchedule` から `score` を削除（`AcceptedSlice extends PlanSlice {}` は名を残す——「計算の産物」と「採用したという事実」は概念が違う）。
    - `toCookSchedule` / `toPlanSlice` から `score` の検証を外す。**外部が添えても読まない**（読まない値の検証で計画を棄却しない）。
    - `event.ts:73` の「`plan.score` は外部が主張した値にすぎず、採否の根拠にしない」の注記を書き換える（主張する場所が型から消えたので、注記の対象が無くなる・AC 8.3）。
    - _Requirements: 5.6, 8.3_

  - [x] 4.2 `baselineSchedule` を採点から切り離す
    - 署名に `members: TableMembers` を足し、`scoreSchedule` の呼び出しと `score` の埋め込みを消す。この関数は「配置を決める」だけになる。
    - _Requirements: 5.6, 1.4_

  - [x] 4.3 `placeGroup` の batch 分割を `slotSpan` の合計へ
    - `batches = ceil(boilings.length / capacity)` を捨て、正準順序のまま `Σ slotSpan ≤ capacity` で詰める貪欲へ替える。
    - `slotSpan ≤ SLOT_SPAN_MAX = SLOTS_PER_UNIT = 6 ≤ capacity`（`UNIT_COUNT_MIN = 1`）ゆえ**1 品目が単独で容量を超えることは無い**。「置けない品目」の分岐を書かない（起こり得ないものに防御を置かない）。
    - 茹で時間が引けない品目を置かない既存の規律は変えない。
    - _Requirements: 1.5, 4.1, 4.5_

  - [x] 4.4 `placeBatch` を錨へ一致させ、`slotSpan` 個を割り当てる
    - `tableFloor` / `orderFloor` の 2 つの床を**撤去**し、錨 1 つへ替える。`anchor = max(max(earliest), 走行中の錨)`、`serveAt = anchor`、`startAt = anchor − boilMillis`。
    - `chooseSlots` は**中身を変えない**。渡す count が `Σ slotSpan` になるだけ。選ばれた釜を `byRelease` 昇順に並べ、`byBoil` 降順の品目へ `slotSpan` 個ずつ連続した塊で配る。
    - 錨は**batch ごとに取り直す**（batch 2 の `earliest` は進めた解放表から出る）。走行中の錨は卓の事実なのでどの batch にも同じ値が入る。
    - `:465-470` の「揃えるのは許容幅までで、それ以上は詰めない」を判断 5 の帰結へ書き換える。下限のクランプが要らない根拠（`anchor ≥ earliest_i ⟹ startAt_i ≥ その品目の全釜の解放時刻`）は `slotSpan` の下でも成り立つので残す。
    - 対応づけの主張は「**決定的**である」に留める。`slotSpan` 混在では錨の最小性は言えない（厳密解の供給は外部ソルバの役目・`chooseSlots` の既存の立場）。
    - _Requirements: 1.4, 1.5, 3.4, 4.1, 4.3, 4.4, 8.3_

- [x] 5. 合成とゲート
  - [x] 5.1 `committedSchedule` から採点を外す
    - `initialRelease` と並べて `tableMembers(running)` を導き、`baselineSchedule` へ渡す。`scoreSchedule` の呼び出しと `score` の埋め込みを消す。
    - 「採点は接頭辞を含めてやり直す」の段落は不要になる（外部の主張を総和へ流す危険が型から消えた）。尾部を再実行する規律は変えない。
    - _Requirements: 5.6_

  - [x] 5.2 `admit` を再採点で比べる形へ
    - `members = tableMembers(running)` を 1 回導き、`scoreSchedule` を 3 回呼ぶ（`arrived` / `committed` / `composed`）。`committed` の `bySlice` と `total` は 1 回の呼び出しで両方使う。
    - **基準は Committed_Plan のままである。** 段 1 (d) は対応部分和（`tableKey` で引く）、段 2 は合成後総和と現行総和。永続値は読まない。
    - `:9-12` の 2 段の説明を再採点の形へ書き換える。
    - _Requirements: 5.4, 5.6_

  - [x] 5.3 feasibility に `slotSpan` を足す
    - `feasibleRelease` で品目を 1 回引き、茹で時間の整合・`slotIds.length === order.slotSpan`・**`slotIds` が相異なること**を見る。
    - 相異性を見る理由をコメントに残す。`["3","3"]` は本数 2 を満たしながら 1 釜しか占めず、`advanceRelease` が重複を吸収するので解放表にも現れない。`slotSpan` を本数で数える設計が開けた穴を、同じ場所で閉じる。
    - _Requirements: 4.2, 5.3_

- [x] 6. 後処理 — 等価判定と指紋
  - 実測・2026-09-04: 6.2・7.2（版 10・v9 の score を捨てる）・8.1（RequestPlan.noodlePresets を engine → settle → shell で一本化）を 1 コミット（19cf60e）。7.1 の写しは task 2 のコミットで済んでいる。`tests/operation-history/timer-model.static.test.ts` の Effect 形の断言と Persist の inline snapshot（version 10）、`tests/core/digest.example.test.ts`（arms と slotSpan が指紋を動かす・12.7 相当）を追随させた。checkpoint 9・11 は typecheck 0・224 ファイル全通過で green。
  - [x] 6.1 `settle` の等価判定から `score` を外す
    - `isSameSlice` の `left.score === right.score` を落とす。`tableKey` と placements の比較で足りる。
    - 副産物として「重みだけが変わった遷移」で空振りの Persist が出なくなる（AC 7.6 の方向）。
    - _Requirements: 5.6_

  - [x] 6.2 `digestInput` に `arms` と `slotSpan` を畳む
    - 計画対象のループに `fold(order.slotSpan)`、パラメータ列に `fold(params.arms)`。
    - `:55` を「`arms` は畳む（計画が Arms_Overflow で読む）／`toleranceRatio` は畳まない（計画へ届く経路は走行中の実効 endTime ただ一つで、既に畳んである）」へ分ける。
    - `:39` の「Pending_Order は全フィールドを含める」を実装に合わせる（計画に効くフィールドを含める。表示だけに効く申告名は含めない）。
    - `:23` の無ブランド整数の列挙から `PlanSlice.score` / `CookSchedule.score` を外す。
    - _Requirements: 5.5, 8.3_

- [x] 7. 状態と永続
  - [x] 7.1 `startOrderItemTimer` が卓を写す
    - `orderItem: { externalOrderId, itemIndex, tableId: item.tableId }`。`startTimer`（アドホック）は `orderItem: null` のまま。
    - modification で卓が移っても走行中 Timer は変えない（`upsertOrder` が生きた Timer の品目を置換から除く既存の規律・AC 3.6）。**新しいコードは要らない**ことをコメントで示す。
    - _Requirements: 3.2, 3.6_

  - [x] 7.2 永続の版を 10 へ上げ、移行を両方向で書く
    - `types.ts` の `CURRENT_SCHEMA_VERSION` を 10 へ。`snapshot.ts:21` の「現行は v8」を v10 へ直す。
    - `reviveOrderItem` に `tableId` を足す。非空文字列はその値、欠如・`null`・壊れた値は `null` へ畳む。**`tableId` だけが壊れていても `orderItem` 全体を捨てない**（`orderItem` の喪失は二重調理の防止を失うが、`tableId` の喪失はその卓の同期が 1 回崩れるだけ）。
    - `reviveAcceptedSlice` から `score` の整数性検査を**外す**。外し忘れると v10 の永続データが全滅して移行失敗（店舗が起動しない）。
    - **巻き戻しが不能になる。** `migrate.ts:65-66` は上限だけを見るため v9 のコードは v10 のデータを読めない。手順は task 15.2 に残す。
    - _Requirements: 3.7, 7.5, 7.6, 8.3_

- [x] 8. 作用と外周
  - [x] 8.1 `RequestPlan` に `noodlePresets` を足す
    - `effect.ts` の Effect に項目を足し、`settle.ts` の `requestPlan` が `params.noodlePresets` を載せる（`SettleParams` が既に持っている）。`params` の注釈「8 値」を 9 値へ。
    - 理由をコメントに残す。往路の契約（`PlanRequest`）は既に運んでいるが、**要求の入力が engine と shell の二箇所から来ている**のを一箇所にする。
    - _Requirements: 5.1_

  - [x] 8.2 shell の配線
    - `requestPlan` を `noodlePresets: effect.noodlePresets` へ。`this.noodlePresets` は取り込みと config 配信で残る。
    - `scheduleParams` 束に `arms` を含め、`private arms` を廃す。移す箇所は 3 つ——`:635` の投影反映、`:667` と `:683` の config メッセージ（broadcast と hydration の 2 経路）。config ワイヤの形は変わらない（既に `arms` を運ぶ）。
    - _Requirements: 5.1, 6.2, 6.5_

  - [x] 8.3 `solver/index.ts` を新しい署名へ
    - `PlanRequest` は `running` を運ぶので、solver 側でも `initialRelease` と `tableMembers` の 2 表を作れる。`request.ts` は変更しない。
    - 返す計画は `score` を持たない（`CookSchedule` の変更に追随するだけ）。
    - _Requirements: 5.1, 5.6_

- [x] 9. チェックポイント — 型エラーの残り先を確認する
  - `pnpm typecheck` を実行する。この段階ではフィクスチャと既存テストが未了のためエラーが残るのが正常である。**出所が次に限られていること**を確認し、`src/**` に残っていれば先へ進まない。
    - `ScheduleParams` を組む tests（`tests/storeConfigDefaults.ts` / `tests/core/scheduleScenes.ts` / `tests/core/objective.*` / `tests/core/digest.example.test.ts` ほか）
    - `score` を構築・参照する 6 のテストファイル
    - `baselineSchedule` / `committedSchedule` / `scoreSchedule` / `admit` の呼び出し元テスト
    - `orderItem: {` を構築する 4 のテストファイル

- [x] 10. フィクスチャと既存テストの更新（型検査を green に戻す）
  - [x] 10.1 共有フィクスチャに `arms` と `members` を足す
    - `tests/storeConfigDefaults.ts` / `tests/core/scheduleScenes.ts` / `tests/core/schedulingScenes.ts`（**2 つある**・両方）。`ScheduleParams` に `arms: DEFAULT_ARMS`、`baselineSchedule` の呼び出しに `members`（走行中が無い場面は空の `Map`）。
    - 場面（scene）に**走行中の仲間を持つ卓**を 1 つ足す。task 11 の性質がこの場面を使う。
    - _Requirements: 7.1, 7.2_

  - [x] 10.2 `score` の参照を撤去する
    - 対象は 7 ファイル。`tests/core/{schedule,admit,plan,migrate}.example.test.ts`・`tests/core/{admit,migrate}.property.test.ts`・`tests/shell/cook-scheduling.integration.test.ts`。
    - `score:` のリテラル（期待値）を落とし、`.score` の参照（`schedule.example` に 7・`admit.example` に 5・`admit.property` に 2・統合に 1）は `scoreSchedule` を直接呼ぶ形へ寄せる。**採点を確かめたい検査は残す**——消すのは「計画が点数を持っている」という前提だけである。
    - `tests/core/objective.{property,example}.test.ts` は `scoreSchedule` の呼び出しだけなので 10.1 の署名追随で足りる。
    - _Requirements: 5.6_

  - [x] 10.3 `orderItem` のリテラルに `tableId` を足す
    - `tests/core/{to-wire-timer-adjustment,pending,migrate}.*` の 4 ファイル。多くは `tableId: null` で足りる。
    - _Requirements: 3.1_

- [x] 11. チェックポイント — 型検査・静的解析・既存テストの green
  - `pnpm typecheck` / `pnpm lint` / `pnpm test` を実行し、**すべて完全に通る**ことを確認する。既存テストの更新は task 10 で済んでいるため、ここは但し書きの無い green である。通らなければ先へ進まない。

- [x] 12. 新しいテスト
  - 実測・2026-09-04: 12.1〜12.8 を追加（`table-members.property` 新規、objective / schedule / admit / migrate / start-order-item / 統合へ追記）。場面生成器（`scheduleScenes.ts`）に slotSpan（1/2）と走行中の卓を足し、`exceedsSlotCount` を占有釜数で数える形に直した。**Property 2 は「真に大きい」ではなく「真に良くならない」で固定した**——arms 超過が立っている一片では、1 本を外すと超過が (w_table − 1) 減るため、lag の増分 w_table × ceil(Δ) と wait の節約 ≤ ceil(Δ) を差し引いて最悪で同値になる（同値はゲートが棄却する）。超過が無ければ真に大きい。design と ADR-0006 の「常に損」をこの形へ改めた。225 ファイル全通過。
  - [x] 12.1 卓の成員（`tests/core/table-members.property.test.ts`・新規）
    - **Property 11** `tableId` が `null` の走行中 Timer はどの部分和にも寄与しない／**Property 12** 単独キー（NUL 始まり）と非空 `tableId` は衝突しない。
    - _Validates: Requirements 2.1, 3.5_

  - [x] 12.2 目的関数（`tests/core/objective.property.test.ts` / `.example.test.ts`・既存へ追記）
    - **Property 7** 部分和の総和が総和に一致／**Property 8** 整数／**Property 9** 走行中の仲間が無い釜容量内の卓で卓同期項が 0／**Property 10** 同時刻の成員が `arms` 以下なら 0／**Property 13** 同じ入力で同じ値。
    - **Property 2**（採点の単調性）を PBT で。揃えた自前解の 1 本を Δ 早めた計画と比較する。`w_table` は 2〜100、Δ は **1〜999 ms と 1 秒以上の両方**。**Δ < 1 秒の側が本質**で、Table_Lag を切り捨てに戻した実装はここで落ちる。**12.4 の example と対である**——採点の側（ここ）とゲートの側（12.4）で同じ境界を両端から留めているので、片方だけ消さない。
    - example に観測事実 1 の卓（つけ 510s / REG 360s / なんこつ 330s）を置き、揃った計画で lag が 0 になることを固定する。
    - _Validates: Requirements 2.1, 2.4, 2.8, 2.9, 7.2, 7.7, 7.8, 7.9, 7.10_

  - [x] 12.3 配置（`tests/core/schedule.property.test.ts` / `.example.test.ts`・既存へ追記）
    - **Property 1** 釜容量に収まる卓で配置済みの `serveAt` が Group_Anchor に一致（走行中の錨あり／なしの両方）／**Property 3** `startAt ≥ 全釜の解放時刻の最大` かつ `serveAt = startAt + 茹で時間` かつ釜は `slotSpan` 個／**Property 14** 各 batch で `Σ slotSpan ≤ 釜数`・品目はどの batch にもちょうど 1 度。
    - example に `slotSpan` 混在（1 と 2）・釜容量を超える卓・boiled の仲間だけが残る卓を置く。
    - _Validates: Requirements 1.4, 1.5, 3.3, 3.4, 4.1, 4.4, 4.5, 7.1, 7.3_

  - [x] 12.4 ゲート（`tests/core/admit.property.test.ts` / `.example.test.ts`・既存へ追記）
    - 基準が Committed_Plan であること（自前解より良いだけの外部解が採用されない）／`slotSpan` 不一致と重複 slot の棄却／永続値を読まずに再採点すること（走行中の adjustment を動かすと採否が変わりうる）。
    - **1 ms ずらした外部計画がゲートを通らない example を 1 本置く。** 重大な境界ゆえ property だけに委ねない。**12.2 の Property 2（Δ の二域）と対である**——採点で損になることと、ゲートを通らないことは別の主張なので、両方を留める。
    - _Validates: Requirements 4.2, 5.3, 5.4, 5.6, 7.2_

  - [x] 12.5 走行中の卓（`tests/core/start-order-item.{example,property}.test.ts`・既存へ追記）
    - 品目からの開始が `tableId` を写す／アドホック（`tests/core/start.property.test.ts`）は `orderItem = null` のまま／modification で卓が移っても走行中 Timer の `tableId` が変わらない。
    - _Validates: Requirements 3.2, 3.6_

  - [x] 12.6 移行（`tests/core/migrate.{property,example}.test.ts`・既存へ追記）
    - **Property 5** v9 以前の Timer が `tableId = null` で保持され落ちない／**Property 6** v9 の `AcceptedSlice`（`score` あり）が `score` を捨てて保持され落ちない。
    - v9 の実データ形（`score` あり・`tableId` なし）を入力に置く。`score` の検査を外し忘れた実装は Property 6 で落ちる。
    - _Validates: Requirements 3.7, 7.5, 7.6_

  - [x] 12.7 指紋（`tests/core/digest.example.test.ts`・既存へ追記）
    - `arms` と `slotSpan` を変えると指紋が変わる／`toleranceRatio` を変えても（走行中の実効 endTime が動かなければ）変わらない。
    - _Validates: Requirements 5.5_

  - [x] 12.8 統合（`tests/shell/cook-scheduling.integration.test.ts`・既存へ追記）
    - 「群の 1 本目を入れた後も残りが 1 本目に揃う」を DO 越しに 1 本。同じ卓の 3 品目を入れ、1 本目の開始後に broadcast された推奨の `startAt + 茹で秒` が一致することを見る。
    - _Validates: Requirements 3.2, 3.4, 7.4_

- [x] 13. 文書の整合
  - 実測・2026-09-04: online-cook-scheduling の requirements（AC 3.3 に (d) slotSpan、AC 3.4 に (d) Arms_Overflow、確定注記へ判断 5 の改訂を追記）と design（`baselineSchedule` / `scoreSchedule` の署名とアルゴリズムを現行へ、撤去候補を記録）、pos-order-ingress AC 6.36 に解消の旨を追記。あわせて本 spec の design / requirements 7.2 / ADR-0006 の「常に損」を「損か同値（同値は棄却）」へ改めた（task 12 の実測）。（本体と同じコミット・AC 8.1 の要求）
  - [x] 13.1 `online-cook-scheduling` の requirements と design
    - requirements：Requirement 3 のハード制約に `(d) slotSpan`（相異なる `slotSpan` 個の釜）、Requirement 4 のソフト制約に Arms_Overflow、確定注記の目的関数を判断 5 の形へ。
    - design：`scoreSchedule` の節（`:245-267`）と `baselineSchedule` の節（`:208-244`）を新しい署名へ。`tableSyncToleranceSeconds` / `orderSync*` を撤去候補として記録し、前者は「`ScheduleParams` に在るが読む計算が無い」ことを書く。
    - _Requirements: 8.1, 8.4_

  - [x] 13.2 `pos-order-ingress` AC 6.36 の繰り延べを解消
    - 「engine が `slotSpan` を見て複数スロットを割り当てる変更は別 spec で扱う」に、本 spec が解消した旨を追記する。
    - _Requirements: 8.2_

- [x] 14. チェックポイント — 全体の green
  - 実測・2026-09-05: `pnpm typecheck` 0 エラー、`pnpm lint` エラー 0（警告は `tests/operation-history` の既存 no-map-spread のみ）、`pnpm fmt:check` 通過、`pnpm test` 225 ファイル 1382 件通過。
  - `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm fmt:check` を実行し、全体が通ることを確認する。
  - **実機確認は要らない。** 本 spec は client を変えず、出力は「群の `serveAt` が一致した計画」までである。見え方の確認は `lift-group-display` の担当。

- [x] 15. 独立の後続タスク（本体の差分と混ぜない）
  - [x] 15.1 `lift-group-display` への申し送り — **反映済み（確認のみ）**
    - `lift-group-display/requirements.md:72-74` に「`lift-group-planning` からの申し送り」節として既に入っている（群の中で押す順は `startAt` 順・短い品目を先に入れると群ごと遅い方へずれる・薄い段階の押下をどう絞るかは display の design で決める）。
    - 本 spec 側で書き足すことは無い。実装時に文面が現状の判断と食い違っていないかだけを見る。
    - _Requirements: 3.4_

  - [x] 15.2 永続スキーマの巻き戻し手順を 1 本にまとめる
    - 実測・2026-09-05: `docs/persisted-schema-rollback.md` を書いた（版に依らない事実、下り移行を同梱した巻き戻しビルドの手順、店舗単位の空状態、版ごとの表に v9 / v10）。`slot-suggested-start` task 10.2 はそれを指すだけに書き換えた。**訂正**: 下の「存在しないファイル」は誤り——`docs/access-enablement/rollback-runbook.md` は在る。ただし `ACCESS_REQUIRED` の切戻し手順であり、永続スキーマとは別の関心事なので、並べずに `docs/` 直下へ置いた。v10 の下り移行は `acceptedSlices` を空にする必要がある（v9 の reviver は `score` を必須にする）ことを実コードで確かめて表に書いた。
    - **spec ごとに手順書を増やさない。** `slot-suggested-start` の task 10.2 が v9 で同じ手順を「置き場は実装時に決める」としたまま未了で、`docs/` に巻き戻しの手順書は 1 本も無い（実測）。版を上げる spec のたびに増えれば、次の巻き戻しでどれを読むべきか分からなくなる。
    - 「**永続スキーマの版を上げたときの巻き戻し**」を 1 本の手順書として書く。版に依らない手順（`migrate.ts:65-66` は上限だけを見るため、旧コードは新データを読めない。Worker を戻すなら永続も戻す）と、版ごとの差（v9 で足した `itemName` / `sizeName`、v10 で足した `tableId` と落とした `score`）を表で持つ。
    - 本 spec がその 1 本を書き、`slot-suggested-start` の task 10.2 は**それを指すだけ**に書き換える（`docs/access-enablement/rollback-runbook.md` という存在しないファイルへの参照も同時に解消する）。
    - _Requirements: 3.7_

- [x] 16. コードレビュー対応（2026-09-05・main の分岐点からのレビュー）
  - 実測: 規約面は指摘なし、仕様面 2 件。(1) v9 の採用済み一片（slotSpan 2 に `slotIds: ["0"]`）が合成で維持され続けた——`isStale` が品目集合しか見なかった。`occupiesSlotSpan`（本数一致・釜番号で相異なる）を schedule.ts に置き、`isStale` と `feasibleRelease` の両方がそれを読む形にした（AC 4.6 を追加）。(2) `new Set(slotIds)` は `["0","00"]` を別の釜に数えた——同じ述語で釜番号に写してから数える（AC 4.2 に追記）。例示は `commit.example.test.ts`（新規）と `admit.example.test.ts`。
  - 差分外の既存問題として `pending.ts` の同一性判定が `slotSpan` を比べない指摘があった。本対応では触っていないが、`isStale` が現在の `slotSpan` を見るようになったため、サイズだけ変わった再送でも採用済み一片は陳腐化する（待ち行列の側の同一性は据え置き）。
  - 2 回目（同日）: 設定変更直後に届いた外部計画が、旧設定の同期結果（古い adjustment）の錨で採点され、新錨では悪化する計画が「改善」として通った。受領（plan.ts）が判定の前に settle と同じ `synchronize` を通す形にした（AC 4.7 を追加。当初は `resynchronize` を切り出したが、`synchronize` 自体が boiled を据え置いて並び順を保つので、レビューの任意指摘に従い直接共用に戻した）。例示は `plan.example.test.ts`。**申し送り（今回は分ける）**: 設定変更直後の hydration snapshot は旧 adjustment の錨で推奨を出す。表示だけの問題ではなく、**その提案に従って開始すると、開始時の再同期で計画が動き得る**。設定の適用（`applyProjection`）を遷移として settle に通すか、hydration の導出を同期後の列で行うかは別の変更で扱う。**設計上の懸念（未決）**: 釜容量を超える卓で 1 品を始めるたびに未着手だけで batch を作り直し、空いている釜があっても残りが走行中の仲間の錨ではなく次の batch へ押し出される（6 釜・同卓 4 品・各 2 釜で再現）。現行 design の分割規則どおりで実装違反ではないが、「提案に従って一まとまりを進める」意図に逆行する。→ 判断 16・ADR-0007 で「走行中の仲間が在る卓に限り、合流できる品目で最初の batch を組む」に決めた（task 17）。

- [ ] 17. 走行中の仲間が在る卓は合流できる品目で最初の batch を組む（判断 16・ADR-0007・AC 1.8〜1.10）
  - [ ] 17.1 `schedule.ts` の `placeGroup` に前段を足す
    - `runningAnchor !== null` のとき `joinable`（正準順序の貪欲・`fits` は placeBatch と同じ対応づけで `max(release of slotsOf[i]) ≤ anchor − boil_i`）で合流集合を取り、非空なら `placeBatch(joined, free, runningAnchor)` で先に置いて解放表を進め、残りを従来の詰め方へ渡す。走行中が無い卓は一行も変えない。
    - 対応づけ（chooseSlots → byRelease → byBoil で連続 span 個）は placeBatch と `fits` で**一つの関数**にする（同じ対応づけを二度書かない）。
    - _Requirements: 1.8, 1.9, 1.10_
  - [ ] 17.2 例示（`schedule.example.test.ts`）
    - レビューの再現：6 釜・同卓 4 品・各 2 釜・茹で 6 分。開始前は「3 品を今、1 品を 6 分後」。1 本目を始めた後は「2 品を今（走行中の錨に合流）、1 品を 6 分後」。
    - (a) 全釜使用中：錨 510 秒・茹で 330 秒・30 秒後に空く釜 → 合流し、startAt = 180 秒。
    - (b) 茹で時間が混在：錨までの残りより長い茹での品目は合流せず、残りの batch に回る（錨は max(earliest, runningAnchor)）。
    - (c) 1 品が複数釜：2 釜のうち片方が投入時刻までに空かなければ合流しない。
    - 走行中が無い卓：変更前と同じ配置（待ってまとめる）。走行中が boiled だけ：既存の規則に落ちる。
    - _Requirements: 1.8, 1.9, 1.10_
  - [ ] 17.3 性質（`schedule.property.test.ts`）
    - Property 16: 走行中の仲間が在る卓で、合流した品目の `serveAt` は走行中の錨に一致し、各釜の解放 ≤ `startAt`。
    - Property 17: 走行中が無い卓の配置は、batch ごとに Σ slotSpan ≤ 容量・錨 = max(earliest)（従来の性質・変更なしの回帰）。
    - Property 1（ハード制約）・決定性（Property 13）は前段を足しても保つ。
    - _Requirements: 1.4, 1.8, 1.9_
  - [ ] 17.4 文書：design の Component 3 に前段の節（済）、ADR-0007（済）、`online-cook-scheduling/design.md` の `baselineSchedule` アルゴリズム手順 2 に合流の一文を足す。
    - _Requirements: 8.1_
  - [ ] 17.5 チェックポイント（typecheck / lint / test / fmt:check）

