# Implementation Plan: 空いている釜からの提案開始（slot-suggested-start）

## Overview

提案の**位置を移す**変更である。待ち行列のレールから idle の釜カードへ移し、その場から品目を指して開始する。あわせて POS 申告の商品名を Pending_Order の事実として取り込む。機構は増えない——engine の占有検査を入れず、提案からの重畳は「押す場所が idle にしかない」ことで構造的に消える。

実装は依存順（domain の葉 → 契約 → engine → ingress → client → テスト）で進める。`pnpm typecheck` は `tsc --noEmit` で `tsconfig.json` の `include` が `src` / `tests` / `tools` を含むため、**型検査は全体で一つの結果しか返す**。生成器とフィクスチャの更新を型変更と同じクラスタに置き、クラスタ末尾のチェックポイントで green を取る（`verified-wire-contract` で学んだ順序）。

### 型エラーの面を先に測った（実測・2026-09-03）

| 変更 | 波及 |
| --- | --- |
| `PendingOrder` に必須 2 項目 | `tableId:` を含むリテラルが **25 ファイル**（src 3・tests 22） |
| `assignedSlotDisplays` に引数 1 つ | 呼び出し元が **src 2 ファイル**（`SlotBoard.tsx:68` / `useAudioCues.ts:197`）と **tests 6 ファイル** |
| `SlotDisplay` の idle に `next` | `kind: "idle"` の構築が 2 ファイル |
| `ClientMessage.start` から optional 2 項目 | `SlotBoard.tsx:110`・`toStartMessage`・種別集合の検査 4 本 |

`assignedSlotDisplays` の呼び出し元のうち `useAudioCues.ts` と tests 6 ファイル（音・劣化重畳・担当範囲）は提案を要らないため `[]` を渡すだけである。**引数追加は design の確定判断として実施する**——既定引数で隠す案は採らない（`SlotBoard` が渡し忘れたとき提案が黙って消える）。代替（`SlotDisplay` に `next` を持たせず prop で渡す）は要件 1.6 と naming ゲートの改訂を伴うため、churn 7 ファイルを理由に開き直さない。

**スコープ外**：engine の占有検査、走行中カードへの商品名表示、推奨理由のワイヤ配信、`StoreConfig.menuItems` への表示名、`slotSpan` 不一致の拒否、レールの並び順・件数。

## Tasks

- [x] 1. 公開シンボルの確認（実装前にユーザー確認）— **確定済み（2026-09-03）**
  - **要件の改訂 3 件は適用済み**（requirements `18:13` 更新・実測確認）。判断 5 と AC 2.4 が `now` / `in mm:ss` / `Table {n}` へ、AC 2.1 が「丸が 2 つ並ぶ幅が無いときは Start の上へ折り返す」へ、未決の判断節は削除された。design の申し送りは解消済みである。
  - コードを書く前に**公開シンボル 9 件**を確定する（`naming.md`）。`itemName` / `sizeName` は `PendingOrder` の 2 項目を 1 件として数える（同じ概念の対であり、片方だけ承認する意味がない）。承認が得られるまで後続へ進まない。一覧の正本は requirements の naming ゲート表と design の確認ゲート節。
    - `startOrderItem`（`ClientMessage` の `type`）/ `startOrderItem(slotIds, orderItem)`（`TimerConnection`）/ `StartOrderItem`（engine の `Event`）/ `OrderItemNotFound`（`Rejection.code`）
    - `itemName` / `sizeName`（`PendingOrder`）/ `next`（`SlotDisplay` の idle）
    - `toDeclaredName`（`src/domain/predicate.ts`）/ `sizeName`（`NoodleSpec`）/ `assignedSlotDisplays` の署名変更
  - _Requirements: 8.6_

- [x] 2. domain の葉と契約
  - [x] 2.1 `predicate.ts` に `toDeclaredName` を足す
    - `toDeclaredName(value: unknown): { readonly name: string | null } | null`。欠落・`null` は `{ name: null }`、非空文字列は `{ name: value }`、空文字・文字列以外は `null`。`ok` は置かない（常に `true` の項目は情報を持たない）。
    - `wire.ts` ではなく `predicate.ts` に置く——shell の取り込みがワイヤ境界の関門から import すると役割が混ざる。自分の型を持たず何も import しない検査という条件は `predicate.ts` の入居条件そのものである。
    - _Requirements: 4.1, 6.4_

  - [x] 2.2 `order.ts` の `PendingOrder` に 2 項目を足す
    - `itemName` / `sizeName` をいずれも `string | null` の**必須**項目として足す（要件 4.1）。
    - `toPendingOrder`（取り込み側）は Pass_Through で `null` へ畳む。`toDeclaredName(...)?.name ?? null` の形で、Record も品目も拒否しない（要件 4.3）。
    - _Requirements: 4.1, 4.3_

  - [x] 2.3 `messages.ts` の種別を足し、`start` から 2 項目を撤去
    - `startOrderItem` を足す（`slotIds: NonEmptyArray<string>` / `externalOrderId: string` / `itemIndex: number`）。組にせず平坦に置く——両方が必須なので「片方だけ在る形」が型に現れない。
    - `start` から optional の `externalOrderId` / `itemIndex` を撤去し、`:40-43` のコメント（`slot-suggested-start` が別種別へ移す旨）も撤去する。
    - _Requirements: 3.1, 3.2, 3.9, 8.1, 8.2_

  - [x] 2.4 `wire.ts` に `case` を 1 つと、`PendingOrder` の 2 項目の関門
    - `toClientMessage` の `switch` に `startOrderItem` を足し、`toStartOrderItemMessage` を書く（`toSlotIds` + `isNonEmptyString` + `isNonNegativeInteger`）。cast は書かない。
    - `toStartMessage` から品目参照の判定を撤去する。
    - `toPendingOrderFromWire` に 2 項目を足す。`toDeclaredName` を用い、空文字・文字列以外は Decode_Failure（要件 6.4）。`toTableId` も同じ受け方（スプレッドをやめて受けてから書く）へ寄せる。
    - _Requirements: 6.4, 8.8_

- [x] 3. engine — 品目から Timer を作る遷移
  - [x] 3.1 `Event` に種別を足し、`Start` から `orderItem?` を撤去
    - `StartOrderItem`（`slotIds` / `externalOrderId` / `itemIndex` / `newTimerId` / `now`）を足す。`Start` の `orderItem?` を消す。
    - _Requirements: 3.9, 8.3_

  - [x] 3.2 `rejection.ts` に拒否 code を 1 つ足す
    - `OrderItemNotFound`。既存 code の意味は変えない（要件 7.7）。
    - _Requirements: 3.5, 7.7, 8.4_

  - [x] 3.3 `start.ts` に新しい遷移を足し、`startTimer` をアドホック専用へ戻す
    - `startOrderItemTimer(state, args, params)` を書く。`pendingOrders` から品目を引き、`noodleType` / `firmness` を写し、`boilSeconds` を `noodlePresets` から導く。以降は既存の `validateStart` / `MAX_TIMERS` の検査 / `createTimer` / `consumeOrder` / `settle` を共有する（Effect 列が既存 `start` と同一になるのはこの共有の帰結）。
    - `startTimer` と一つに畳まない——「client の主張を検証して使う」と「サーバの事実から導く」で義務が違う。畳めば引数で切り替える分岐が生まれる。
    - 釜の占有・推奨との一致・`slotSpan` との一致を検査しない（要件 3.7）。
    - `:91-92` のコメントを「アドホック経路（`start`）では拒否事由を増やさない」に書き換える（要件 7 と design の申し送り）。
    - _Requirements: 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.10_

  - [x] 3.4 `decide.ts` に分岐を 1 つ足す
    - _Requirements: 3.3_

  - [x] 3.5 永続の版を 9 へ上げ、migrate で 2 項目を畳む
    - `types.ts` の `CURRENT_SCHEMA_VERSION` を 9 へ。`revivePendingOrder` は 2 項目の欠如を `null` へ畳み、品目を落とさない。
    - **巻き戻しが不能になる。** `migrate.ts:65-66` は上限だけを見るため、v8 のコードは v9 のデータを読めない。ロールバック手順（Worker を戻すなら永続も戻す）を task 10 に残す。
    - _Requirements: 6.1, 6.2_

- [x] 4. ingress — 麺量 child の名前を取れるようにする
  - [x] 4.1 `noodle-spec.ts` の child を集合から写像へ
    - `toChildCodes(...): ReadonlySet<number>` を `toChildNames(...): ReadonlyMap<number, string | null>` へ変える。`findNoodleSize` / `findFirmness` は `.has()` しか呼ばないため型注釈だけで済む（実測確認済み）。
    - `NoodleSpec` に `sizeName: string | null` を足し、`toNoodleSpec` は同定した `size.code` で写像を引く（要件 4.6 の「同じ同定結果から取る」）。
    - **同一コードで名前が食い違えば `null`**。先勝ちも後勝ちも並び順に依るため、位置に依らない結果は「申告が曖昧なら名前を持たない」ただ一つである。同名の重複は保つ。
    - 冒頭の「POS の語彙（商品コード・商品名）は含まない」宣言を改める。判定は引き続き商品コードだけで行う旨を残す。
    - _Requirements: 4.6, 4.4_

  - [x] 4.2 shell の受け口で親品目の名前を読む
    - `store-timer-do.ts:238-253` の `items.push({...})` に `itemName`（`rawItem.item_name` を `toDeclaredName` で）と `sizeName`（`spec.sizeName`）を足す。取り込みは Pass_Through で `null` へ畳む。
    - 正規化・トリム・全角化を行わない（要件 4.5）。
    - `readDeclaredText` は用いない（要件 4.4）。
    - _Requirements: 4.2, 4.3, 4.4, 4.5_

  - [x] 4.3 新しい Event の受け口を足し、`orderItem` の射影を撤去
    - `webSocketMessage` の分岐に `startOrderItem` を足し、`StartOrderItem` の Event を組む。`Start` 側の `orderItem` の 2 行の射影（`:1047-1050`）を撤去する。
    - `noodlePresets` の解決は既存の `settleParams` が担う（新しい配線を作らない）。
    - _Requirements: 3.1, 3.3_

- [x] 5. チェックポイント — 型エラーの残り先を確認する
  - `pnpm typecheck` を実行する。この段階では client と多数のフィクスチャが未了のためエラーが残るのが正常である。**出所が次に限られていること**を確認し、`src/domain` / `src/engine` / `src/ingress` / `src/shell` に残っていれば先へ進まない。
    - `src/client/**`（task 6 で対応）
    - `PendingOrder` を構築する 22 のテストファイル（task 6.6 で対応）
    - `assignedSlotDisplays` を呼ぶ 6 のテストファイル（task 6.6 で対応）
    - `tests/domain/wireGenerators.ts` / `tests/client/generators.ts`（task 6.6）

- [x] 6. client — 提案を釜カードへ移し、型検査を green に戻す
  - [x] 6.1 `slotDisplay.ts` の idle に `next` を足す
    - `{ kind: "idle"; slot: number; next: QueueSuggestion | null }`。新しい型を作らず `QueueSuggestion` をそのまま載せる。
    - `entries` を引数で受ける（`assignedSlotDisplays(view, units, now, entries)`）。`orderQueueEntries` の再呼び出しをせず、`queueDisplay.ts` からは型だけを `import type` する。
    - `next` は当該釜を `slotIds` に含む提案のうち `startAt` 最小の 1 件。同値は `entries` の順（到着順）の先着を採る（`reduce` で `<` を使えば先着が残る）。
    - degraded では `next` を `null` にする（判定をここに閉じ、`SlotCard` に条件を書かせない）。
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [x] 6.2 `SlotCard.tsx` の idle に提案の丸ボタンを足す
    - `actionStack` は `flex-col`（丸＋下のラベルの縦積み）である。提案と Start を並べる親は**その外側**に 1 枚置き（`flex-wrap` / `justify-end`）、`actionStack` 2 つをその子にする。DOM 順は `[提案, Start]`。提案は既存 `actionSlot` と同形の丸で、塗りは麺種の色。
    - **要件 2.9 が成り立つ根拠は `absolute right/bottom` の下端固定である。** 現在それを持つのは `actionStack`（`:59-62`）だが、**新しい親へ移す**（`actionStack` 側からは外す）。背が伸びるときは上へ伸びるため、折り返しても Start は右下に留まる。この配置を相対配置や上端基準へ変えると崩れる。
    - ラベルは商品名（`itemName ?? noodleType` を NFKC）・麺量・茹で加減・卓（`Table {n}`）・時期（`now` / `in mm:ss`）をこの順で、行数を固定せず折り返す。
    - `aria-label` を明示する（丸ボタンはラベルが兄弟要素ゆえ、名前を明示しなければ AT に何も渡らない）。命令形を用いない。
    - 直前結果のバッジは上部、提案は下部で場所を取り合わないため両方残す。
    - `next` が `null` のとき提案側を描かない。ラジアルは開かない。押下で既存 Start と同じ Touch_Cue を鳴らす。
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12, 5.1, 5.3, 5.4, 5.5, 5.7_

  - [x] 6.3 `OrderRail.tsx` から提案ボタンを撤去し、商品名を足す
    - `:118-133` の提案ボタンと `onStart` prop を撤去する。各行に商品名（`itemName ?? noodleType` を NFKC）と麺量を足す。卓は省略記号で切らない。
    - `Suggested` / `Slot(s)` / `wallClock` の語はレールから消える（カードへ移る）。
    - _Requirements: 1.7, 5.2, 5.6, 5.7_

  - [x] 6.4 `connection.ts` に `startOrderItem` を足し、`start` の 4 番目の引数を撤去
    - `startOrderItem(slotIds: NonEmptyArray<string>, orderItem: { externalOrderId; itemIndex })`。degraded では送らず、ローカルにも Timer を立てない（既存 `start` の degraded 分岐と同じ立場）。
    - `start` の `orderItem?`（`:673`）を撤去する。
    - _Requirements: 2.6, 3.11_

  - [x] 6.5 `SlotBoard.tsx` の配線を付け替え、`useAudioCues.ts` に `[]` を渡す
    - `SlotBoard.tsx:68`：`orderQueueEntries` の結果を `assignedSlotDisplays` へ渡す（1 描画で一度だけ導出）。`OrderRail` への `onStart` を消し、`SlotCard` へ提案の押下を渡す。
    - `useAudioCues.ts:197`：音の判定は提案を要らないため `[]` を渡す。src 側の呼び出し元はこの 2 つだけである。
    - _Requirements: 2.6_

  - [x] 6.6 生成器とフィクスチャを型検査が通る形へ直す
    - 型検査を全体で通すため、このクラスタで済ませる（`tsconfig.json` の `include` が `tests` を含む）。
    - `PendingOrder` を構築する 22 のテストファイルに 2 項目を足す（多くは `itemName: null, sizeName: null` で足りる）。
    - `assignedSlotDisplays` を呼ぶ 6 のテストファイルに `entries` を渡す（提案と無関係なものは `[]`）。
    - `tests/client/complete.example.test.ts`：`kind: "idle"` のリテラルを持つ唯一のテストであり `next` の追加が要る（`[]` を渡すだけでは通らない）。
    - `tests/domain/wireGenerators.ts`：`genPendingOrder` に 2 項目（`null` と非空文字列の双方）、`genValidClientMessage` に新種別（`start` は 1 形に戻る）。
    - `tests/client/generators.ts`：`genPendingOrder` に 2 項目を足す（狭いプールのまま。両者を統合しない理由は同ファイルのヘッダ）。
    - _Requirements: 6.5_

  - [x] 6.7 種別集合と #24 の静的検査を更新する
    - 型検査と同じクラスタで済ませる。ここを task 9 に置くと、チェックポイント 7 で静的検査が落ちることが分かっている構成になる。
    - **種別集合を固定する検査 4 本を 8 種（ClientMessage 5 種）へ。** `tests/offline-degradation.static.test.ts:101` / `tests/sync-set-batch-complete.static.test.ts:84` / `tests/observe/static-analysis.example.test.ts:58` の `WIRE_MESSAGE_TYPES` と、`tests/operation-history/no-wake.static.test.ts:319` の `toClientMessage` の `case` 集合。
    - **#24 の静的検査。** `tests/pending-order-list-left-rail.static.test.ts:512`（レールの語の規則）と `:708`（固定文言 `Suggested` / `Slot(s)`）は語がカードへ移るため更新する。`:656` / `:686` の `QueueEntry` 3 フィールドは**そのまま通る**見込み（レールが失うのはボタンだけで導出データは残る）。
    - _Requirements: 8.7_

  - [x] 6.8 レールの実描画テストを更新する（`tests/client/order-rail.example.test.tsx`・既存）
    - 6.3 でボタンを外した時点で既存の期待は落ちる。6.7 と同じ理屈で「既存テストの更新」はこのクラスタに置く。
    - 提案ボタンが無いこと／商品名と麺量が出ること／卓が切れないこと。`Suggested` / `Slot(s)` / 壁時計をレール側の期待から外す。
    - 折り返し（要件 5.7）はクラスの有無までを見る（happy-dom は CSS を計算しない・8.8 と同じ制約）。
    - _Requirements: 1.7, 5.2, 5.6_

- [x] 7. チェックポイント — 型検査と静的解析の green を確認
  - `pnpm typecheck` / `pnpm lint` / `pnpm test` を実行し、**すべて完全に通る**ことを確認する。既存テストの更新（6.6 のフィクスチャ・6.7 の静的検査・6.8 のレール）はこのクラスタで済んでいるため、ここは但し書きの無い green である。通らなければ先へ進まない。

- [x] 8. テスト
  - [x] 8.1 提案の導出（`tests/client/slotSuggestion.property.test.ts`・新規）
    - **Property 1** 当該釜の最小 `startAt`／**Property 2** 同一入力で深く等価（毎描画導出）／**Property 6** degraded では全 `next` が `null`。
    - fast-check・`numRuns: 100` 以上。「提案は idle にしか現れない」は型で真になるため書かない。
    - _Validates: Requirements 1.1, 1.2, 1.6, 2.12_

  - [x] 8.2 提案の境界（`tests/client/slotSuggestion.example.test.ts`・新規）
    - 複数釜にまたがる提案が各 idle 釜に出る／同値 `startAt` は到着順の先着／品目が待ち行列に無い・麺種がプリセットに無い推奨は `next` にならない。
    - _Validates: Requirements 1.4, 1.5_

  - [x] 8.3 品目からの開始（`tests/core/start-order-item.property.test.ts`・新規）
    - **Property 4** Timer の `noodleType` / `firmness` が品目と一致し `endTime - startTime` がプリセットの秒数と一致する／**Property 5** 当該品目だけが `pendingOrders` から消える。
    - _Validates: Requirements 3.3, 3.4_

  - [x] 8.4 開始の拒否（`tests/core/start-order-item.example.test.ts`・新規）
    - 品目不在（新 code）・麺種不在（`InvalidSlotOrNoodle`）・上限超過（`CapacityExceeded`）でいずれも状態不変。受理時の Effect 列が既存 `start` と同一。
    - _Validates: Requirements 3.5, 3.6, 3.8_

  - [x] 8.5 ワイヤ（`tests/domain/wire.property.test.ts`・既存へ追記）
    - **Property 3** `startOrderItem` が 3 項目のみを運ぶ／**Property 7** `itemName` / `sizeName` が `null` と非空文字列の双方で往復する。
    - _Validates: Requirements 3.1, 3.2, 6.5_

  - [x] 8.6 名前は判定に用いられない（`tests/ingress/noodle-spec.property.test.ts`・既存へ追記）
    - **Property 8** child の `item_name` を任意に変えても `noodleType` / `firmness` / `slotSpan` が変わらない。同一コードの重複は同名なら保ち、食い違いは `null`。
    - _Validates: Requirements 4.6_

  - [x] 8.7 移行（`tests/core/migrate.property.test.ts`・既存へ追記）
    - **Property 9** 版 8 以前の永続値で 2 項目が `null` になり品目が落ちない。
    - _Validates: Requirements 6.2_

  - [x] 8.8 カードの実描画（`tests/client/slot-card.example.test.tsx`・新規）
    - `aria-label` の内容／押下で `startOrderItem` が送られる／ラジアルを開かない／`next` の有無で Start の DOM 位置が変わらない。
    - **レイアウトの実効は問わない。** render プロジェクトは happy-dom（`vitest.config.ts:134`）で CSS を計算しないため、`flex-wrap` が実際に折り返すかは観測できない。問えるのは **DOM 順（`[提案, Start]`）と親のクラス（`flex-wrap` / `justify-end` / `absolute right/bottom`）**までであり、そこを検査する。折り返しの実際は task 9 の実機確認に置く。
    - _Validates: Requirements 2.1, 2.6, 2.7, 2.9, 2.10_

- [ ] 9. チェックポイント — 全体の green と実機確認（green は確認済み・実機は未了）
  - `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm fmt:check` を実行し、全体が通ることを確認する（静的検査の更新は 6.7 で済んでいる）。
  - **レイアウトを実機で確認する。** happy-dom は CSS を計算しないため、狭幅で丸が折り返し Start が右下に留まることは実機（`pnpm dev` か本番）でしか見えない。iPhone 幅・iPad 幅の両方で、提案がある idle カードと無い idle カードを並べて確かめる。
  - ラベルの折り返し（長い商品名）が省略記号で切れないことも同時に見る。

- [ ] 10. 独立の後続タスク（本体の差分と混ぜない）
  - [ ] 10.1 ドキュメントと他 spec の追記
    - `docs/pos-records-ingress-api.md` の例に親品目と child の `item_name` を加える（要件 4.7）。
    - `pos-order-ingress` の AC 6.26（`requirements.md:201` の出所表）に Item_Name / Size_Name の出所を加える（要件 4.8）。
    - `verified-wire-contract/requirements.md:156`（要件 5.1「7 種の種別集合を変更しない」）に、本 spec が 8 種へ改めた旨を追記する。
    - `pending-order-list-left-rail` の要件 3.9（固定文言に `Suggested` / `Slot(s)` を挙げている）に、本 spec が両語をカードへ移した旨を追記する。`verified-wire-contract` 5.1 と同じ扱いで、spec 間が矛盾したまま残らないようにする。
    - _Requirements: 4.7, 4.8_

  - [x] 10.2 ロールバック手順を残す
    - 手順書は `docs/persisted-schema-rollback.md`（版に依らない 1 本。`lift-group-planning` task 15.2 で作成）。v9 の下り移行は §3 の表の v9 行——`version` を 8 にするだけで、`itemName` / `sizeName` は v8 の reviver が読まないので放置してよい。
    - spec ごとに手順書を増やさない。版を上げる spec は同書 §3 の表に 1 行足す。
    - _Requirements: 6.1_
