# Implementation Plan: 検証済みワイヤ契約（verified-wire-contract）

## Overview

これは境界の **引き算（subtractive）リファクタ**である。両端に手書きされた復号（`parseServerMessage` 22 行・`parseClientMessage` 48 行・`toOrderItem` 9 行）を撤去し、`src/domain/wire.ts` の Decoder 2 つへ寄せる。4 つの cast（`connectivity.ts:93` / `:104`、`store-timer-do.ts:159` / `:171`）を消し、ワイヤ型の基数を強め、`config` の 14 項目の列挙を `& StoreConfig` へ畳む。

**振る舞いの変化は一方向にだけある。** ClientMessage 側（shell の受け口）の受理集合・拒否集合は変わらない。ServerMessage 側（client の受け口）は意図して変わる——現行は cast で素通しているため、壊れた `snapshot` / `config` が今は表示へ通り、本変更後は破棄されて記録される。

実装は依存順（domain の葉 → domain の契約 → 両端 → テスト）で進める。**`predicate.ts` の新設は本体に含まれる**（`wire.ts` と `store.ts` が依存するため独立の task にできない）。複数ファイルにまたがる協調的な型変更であり、下位タスクの途中では型エラーが残りうる。

`pnpm typecheck` は `tsc --noEmit` であり、`tsconfig.json` の `include` は `src` / `tests` / `tools` を含む。**型検査は全体で一つの結果しか返す** ため、「src だけ通す」段階は作れない。ゆえに生成器の型修正（6.5）を両端の差し替えと同じクラスタに置き、**task 7 で typecheck が完全に通る**形にする。各チェックポイントで `pnpm typecheck` / `pnpm lint` / `pnpm test`（= `vitest --run`）を実行し、watch は使わない。domain のテストは既定 pool、shell の統合テストは Workers pool（`@cloudflare/vitest-pool-workers` の `cloudflareTest()`）で走る。

**スコープ外**：スキーマライブラリ・protobuf / gRPC の導入、畳む `to*` の挙動変更、心拍、`start` の注文品目参照の規則の変更（`slot-suggested-start` へ送った）、shell が Decode_Failure を `error` で要求元へ返す変更。

## Tasks

- [x] 1. 公開シンボルの確認ゲート（naming.md）— **確定済み（2026-09-03）**
  - 一覧の正本は `design.md`「公開シンボルの確認ゲート」。6 点すべてユーザー承認済み。
  - **`toClientMessage` / `toServerMessage`**：文字列から検証済み契約を確立する唯一の関門。単数の `to*` が `| null` を返す規則に乗る。境界であることは `wire.ts` が表明するため関門名で重ねない。
  - **`src/domain/wire.ts`**：ワイヤ境界の検証を集約する場所。
  - **`src/domain/predicate.ts`**：自分の型を持たない検査の唯一の持ち主。`isNonEmpty` は `timer.ts` に残る。
  - **`isRecord` / `isNonEmptyString` / `isNonNegativeInteger`**：述語の名。
  - **`toGridPoint` の署名変更**：`(value) => GridPoint | null` へ変え export する。新しい名は足さない。畳みは呼び出し側の `?? fallback` へ移す。
  - **Decode_Failure の記録の形**：`{ kind: "decode-failure", contract, messageType, field }`。`contract` は `"ClientMessage"` / `"ServerMessage"`。`direction` は Operation_Log が `send` / `recv` で持つため使わない。`at` は同 log の epoch ms と衝突するため使わない。
  - _Requirements: 1.1, 2.8, 2.9, 3.4_

- [x] 2. domain の葉（`predicate.ts` 新設・`store.ts` の分離）
  - [x] 2.1 `src/domain/predicate.ts` を新設する
    - `isRecord` / `isNonEmptyString` / `isNonNegativeInteger` を置く。何も import しない葉とし、`store.ts` / `order.ts` / `wire.ts` のいずれからも循環なく依存できる状態を保つ。
    - `isNonEmpty` は移さない（`timer.ts` の `NonEmptyArray` と同居する）。
    - _Requirements: 3.5_

  - [x] 2.2 `store.ts` の `toGridPoint` を規則に戻す
    - 署名を `toGridPoint(value: unknown): GridPoint | null` に変え、**export する**（現在は非公開で `wire.ts` から呼べない）。判定は `isRecord` を用い、現行 `:491` の `value as Record<string, unknown>` を消す。
    - 畳みを呼び出し側 7 箇所へ移す。`:458` は `toGridPoint(items[unit]) ?? defaultUnitOrigin(unit)`、`:474-479` は `toGridPoint(items[i]) ?? DEFAULT_SLOT_OFFSETS[i]`。`toUnitOrigins` / `toSlotOffsets` から見た挙動は変えない。
    - 新しい名は足さない。単数の `to*` が `| null` を返す規則（`toNoodlePreset` / `toFirmnessCode` / `toMenuItem`）に `toGridPoint` だけが従っていなかった不整合を、同時に消す。
    - _Requirements: 2.4, 2.5_

  - [x] 2.3 `store.ts` の Element_Validator 3 つを export する
    - `toNoodlePreset`（`:523`）/ `toFirmnessCode`（`:567`）/ `toMenuItem`（`:596`）を export する。実装は変えない（既に `null` を返し、余剰フィールドを落として正規化し、入れ子の基数を確立している）。
    - 畳む `to*`（`toSlotOffsets` / `toNoodlePresets` / `toUnitOrigins` / `toMenuItems`）は export も挙動も変えない。
    - _Requirements: 2.4, 2.5_

  - [x]* 2.4 畳む `to*` の挙動不変を既存テストで確認する（Property 7）
    - **Property 7: 畳む `to*` の挙動不変** — `toGridPoint` の分離前後で `toUnitOrigins` / `toSlotOffsets` の出力が変わらない。既存の `to*` テストがそのまま通ることで示す。新しいテストは書かない。
    - _Validates: Requirements 2.5_

- [x] 3. `src/domain/wire.ts` の新設（Decoder）
  - [x] 3.1 骨格と `toClientMessage`
    - 公開するのは `toClientMessage` / `toServerMessage` の 2 つだけ。`toArrayOf`（要素の写し取りを配列へ適用し、一つでも `null` なら全体を `null`）と `toSlotIds` は内部に留める。述語は `predicate.ts` から引く。
    - `toStartMessage` / `toCancelMessage` / `toCompleteMessage` / `toAdjustMessage` を書く。`toStartMessage` は `slotIds` を `toSlotIds` で確立し、`noodleType` は `typeof === "string"` まで、`boilSeconds` は `typeof === "number"` までしか見ない（空文字と値域外は `Engine_Rejection` が `error` として要求元へ返す経路を残す）。
    - 注文品目参照は現行 `toOrderItem` と同一条件（非空 `externalOrderId` かつ非負整数 `itemIndex`）で組を成し、それ以外は組を成さず `start` を通す。`exactOptionalPropertyTypes` のため `...ref` の形で載せ、`undefined` を明示的に置かない。
    - cast を 1 つも書かない。
    - _Requirements: 1.1, 1.2, 2.1, 2.2, 2.3, 2.6, 3.2, 5.2, 5.3, 5.4_

  - [x] 3.2 `toServerMessage`（`snapshot` / `config` / `error`）
    - `serverTime` を検証したうえで `type` で振り分ける。撤去済み種別は `default` へ落ちる（`case` を書けば撤去済みの形をしたリテラルを返すしかなく型検査が失敗する）。
    - `toSnapshotMessage` は `timers` / `pendingOrders` / `recommendations` を `toArrayOf` で復号する。粒度はメッセージ単位——要素が 1 つでも `null` なら `snapshot` 全体が `null`。
    - `toConfigMessage` は `StoreConfig` の 14 項目を復号する。`noodlePresets` は `toArrayOf(v, toNoodlePreset)` + `isNonEmpty`、`firmnessCodes` / `menuItems` / `unitOrigins` は対応する Element_Validator を用いる。Element_Validator が課す正規化条件（余剰フィールドの除去・正の秒数・正の商品コード・`slotSpan` の域内）を含めて検証する。
    - `pendingOrders` は `order.ts` の `toPendingOrder` を流用しない（`arrivalTime` の出所と `presets` 照合という別の義務を持つ）。共有するのは述語だけ。
    - _Requirements: 1.1, 2.2, 2.4, 2.7, 3.2_

  - [x] 3.3 `toSlotOffsetsFromWire`（6 要素タプルを cast なしで組む）
    - `noUncheckedIndexedAccess: true`（`tsconfig.json:11`）のため `items[0]` は `GridPoint | undefined` になる。`const [a, b, c, d, e, f, ...rest] = items` で 6 つの `undefined` 検査と `rest.length === 0` を見てから配列リテラルで返す。
    - `items.length === 6` の検査だけで `as SlotOffsets` を書く形は取らない（要件 4.5 が禁じる）。
    - _Requirements: 2.1, 2.2, 3.2_

  - [x]* 3.4 cast 不在の静的検査（Property 1）
    - **Property 1: cast 不在** — `src/domain/wire.ts` に `ts.SyntaxKind.AsExpression` / `NonNullExpression` / `TypeAssertionExpression` が 0 件。`as const` は `AsExpression` の型が `const` かで判別して除く。`satisfies` は対象外。
    - AST で書く（正規表現は使わない）。先例は `tests/static/boil-sync-purity.test.ts:12`（`import ts from "typescript"`）/ `:18`（`ts.SourceFile`）。走査は `wire.ts` 1 本に限る。
    - 配置 `tests/static/wire-no-cast.test.ts`。タグ `Feature: verified-wire-contract, Property 1: cast 不在`。
    - _Validates: Requirements 2.1, 4.5_

- [x] 4. `messages.ts` の型を強める
  - [x] 4.1 基数を強め `config` を `& StoreConfig` へ畳む
    - `start.slotIds` と `CookRecommendation.slotIds`（`:28`）を `NonEmptyArray<string>` にする。
    - `config` を `({ readonly type: "config"; readonly serverTime: number } & StoreConfig)` へ置き換え、14 項目の列挙を撤去する。JSON は平坦なまま変わらない。
    - **import を差し替える。** `:11` の `FirmnessCode` / `GridPoint` / `MenuItem` / `NoodlePreset` / `UnitOrigin` は列挙の撤去で未使用になる。代わりに `StoreConfig` を import する（残さないと lint が止める）。
    - **既存の型レベル検査から「第二の一覧」を消す。** `tests/domain/sync-config-server-authority.example.test.ts:18-41` は `keyof ConfigMessage` が 16 個のキー名の union と等しいことを固定している。`& StoreConfig` にしてもこの検査は通るが、判断 5 が domain から消した一覧がテスト側に残る形になり、`StoreConfig` に項目を足すとこのテストが一覧の更新を求めてくる。`Equal<keyof ConfigMessage, "type" | "serverTime" | keyof StoreConfig>` へ書き換え、一覧ではなく構造（`config` は `StoreConfig` そのものを運ぶ）を検査に言わせる。
    - `StoreConfig` 側に「`type` / `serverTime` という名の項目を持つと intersection が黙って重なる」旨の注意書きを 1 行残す。
    - `messages.ts` は型のみを保つ（実行時コードを置かない）。
    - _Requirements: 3.1, 3.2, 3.4, 5.1_

  - [x] 4.2 役目を終えたコメントを撤去する
    - `messages.ts:19-20` / `:70-74` / `:91-96` と `engine/recommend.ts:49-50` の「基数は JSON を跨げないため受け手が改めて確立する」趣旨の記述を削除する。`:74` の「項目が増えたらここへも足す」も消える。
    - _Requirements: 3.1, 3.4_

- [x] 5. チェックポイント — 型エラーの残り先を確認する
  - `pnpm typecheck` を実行する。この段階では両端の差し替えが未了のためエラーが残るのが正常である。**エラーの出所が次に限られていること**を確認し、domain 内に残っていれば先へ進まない。
    - `src/shell/store-timer-do.ts`（`parseClientMessage` の撤去待ち、および `noodlePresets` フィールドの型・6.1 参照）
    - `src/client/connectivity.ts`（`parseServerMessage` の撤去待ち）
    - `src/client/components/queueDisplay.ts`（読み飛ばしの撤去待ち）
    - `tests/client/generators.ts`（生成器の型・6.5 参照）
    - `config` をリテラルで組んでいる既存テスト 2 つ：`tests/domain/sync-config-server-authority.example.test.ts:46` 以降と `tests/client/order-queue.example.test.ts:124` 以降。非空の配列リテラルと 6 要素の `slotOffsets` なら文脈型付けで通る見込みだが、落ちた場合はリテラル側を直す（ワイヤ形式は変えない）

- [x] 6. 両端を Decoder へ差し替え、型検査を green に戻す
  - [x] 6.1 shell の受け口（`shell/store-timer-do.ts`）
    - `parseClientMessage`（`:151-198`）と `toOrderItem`（`:133-141`）を撤去し、`toClientMessage` を呼ぶ。`:1060` の `=== undefined` を `=== null` に合わせる。
    - Event の `orderItem` を組むとき、復号済みの `start` から両方の存在を読んで写す（型が独立の optional のままなので射影が 2 行残る。`slot-suggested-start` が optional を撤去した時点で消える）。
    - **`noodlePresets` フィールドの型を直す。** `:446` の `private noodlePresets: readonly NoodlePreset[]` を `NonEmptyArray<NoodlePreset>` にする。`config` が `& StoreConfig` になると `configMessage()`（`:734-744`）はこの項目を非空として返す必要があり、代入元（`:710` の `config.noodlePresets`）は `StoreConfig` 由来で既に非空である。`unitOrigins` / `slotOffsets` は `ScheduleParams`（`engine/objective.ts:44-46`）経由で既に正しい型を持つため変更は要らない。
    - Decode_Failure のとき Working_Copy を一切変更しない。
    - _Requirements: 1.3, 2.8, 3.2, 5.2, 5.3_

  - [x] 6.2 client の受け口（`client/connectivity.ts`）
    - `parseServerMessage`（`:85-106`）を撤去し、`toServerMessage` を呼ぶ。`:229` の破棄の前に記録を挟む。
    - pong による up 確定（`:224-226`）は変えない。Decode_Failure を到達性の判定に持ち込まない。
    - _Requirements: 1.3, 2.9, 2.11_

  - [x] 6.3 Decode_Failure の記録（両端）
    - 両端が同一の形の構造化 1 行 JSON を `console.error` へ出す。Instrumentation_Log は用いない（`OBSERVE_DEBUG` の既定 `"0"` により本番で無音になり、`SeamKind` への追加は `hibernation-observability` 要件 4.9 を破る）。
    - 記録に Wire_Text の中身を含めない（`externalOrderId` / `tableId` は POS 由来の業務データであり、Workers のログへ流出させない）。
    - _Requirements: 2.8, 2.9, 2.10_

  - [x] 6.4 推奨の読み飛ばしを撤去する（`client/components/queueDisplay.ts`）
    - `:68` の `if (!isNonEmpty(slotIds)) continue;` を削除する。`boilSecondsOf` が `null` を返す枝（`:70`）は整合の判定であり残す。
    - _Requirements: 3.2_

  - [x] 6.5 生成器の型を直し `genClientMessage` を新設する
    - 型検査を全体で通すために、このクラスタで済ませる（`tsconfig.json` の `include` が `tests` を含む）。
    - `genRecommendation.slotIds`（`tests/client/generators.ts:188`）を `genSlotIds`（`:90-92`）と同じく `.map((slots) => nonEmpty(slots))` を通して `NonEmptyArray<string>` にする。必要なのは `minLength` ではなく**型**である（既に `minLength: 1` になっている）。
    - `genNoodlePresets`（`:158`）の宣言型を `NonEmptyArray<NoodlePreset>` へ変える。`genWireTimer`（`:298-300`）は既に `genSlotIds` を使うため変更は要らない。
    - `genClientMessage` を新設し、4 種すべてと `start` の「注文品目参照を組で持つ形／持たない形」の双方を分布する。省略する optional 項目はキーごと省く（`undefined` を値として置くと `JSON.stringify` が落とし、往復の等価性が生成器の都合で破れる）。
    - _Requirements: 3.2, 4.2, 4.3_

- [x] 7. チェックポイント — 型検査と静的解析の green を確認
  - `pnpm typecheck` / `pnpm lint` を実行し、**完全に通る**ことを確認する。通らなければ先へ進まない。
  - `pnpm test` を実行する。この段階で落ちるのは新しい性質を未実装のテストではなく、既存テストの期待値であるべきである。落ちたテストの原因を確認し、ワイヤ形式の変更に起因するものが無いことを確かめる。

- [x] 8. テスト
  - [x] 8.1 構造的に壊す生成器を用意する（`tests/domain/wireGenerators.ts`）
    - 妥当なメッセージを生成してから壊す 5 種を置く——(1) 必須キーを 1 つ落とす、(2) 値の型を差し替える、(3) 配列を空にする、(4) `type` を撤去済み種別へ差し替える、(5) 入れ子の要素を 1 つ壊す。壊し方の一覧はこのファイルが正本になる。
    - 素の `fc.string()` も併用するが、それは JSON 解釈失敗の枝を踏むためだけの役割である（単独では `JSON.parse` が投げないことしか検査できない）。
    - _Requirements: 4.4_

  - [x]* 8.2 往復の property test（Property 2）
    - **Property 2: 往復** — 任意の妥当な `ClientMessage` / `ServerMessage` について `decode(JSON.stringify(m))` が `m` と深く等価。全 7 種を分布する。
    - 前提：生成器は正規化済みの値（サーバが実際に送りうる値）を作る。ServerMessage 側は Element_Validator が余剰フィールドを落とし値域も見るため、深い等価はこの前提の下で成立する。
    - fast-check・`numRuns: 100` 以上。配置 `tests/domain/wire.property.test.ts`（既定 pool）。タグ `Feature: verified-wire-contract, Property 2: 往復`。
    - _Validates: Requirements 4.1, 4.2_

  - [x]* 8.3 全域性の property test（Property 3）
    - **Property 3: 全域性** — 任意の入力について Decoder は例外を送出せず、`null` か検証済みの値を返す。返した場合は `Cardinality_Guarantee` を満たす。
    - 入力は 8.1 の 2 層の生成器を用いる。
    - fast-check・`numRuns: 100` 以上。配置 `tests/domain/wire.property.test.ts`。タグ `Feature: verified-wire-contract, Property 3: 全域性`。
    - _Validates: Requirements 2.6, 4.4_

  - [x]* 8.4 境界の例示テスト（回帰の楔・domain）
    - 撤去済み種別 5 種（`started` / `cancelled` / `completed` / `boiled` / `adjusted`）がいずれも Decode_Failure になる（回帰の楔）。
    - 値域外の `boilSeconds`・空文字の `noodleType`・実在しない `timerId` が通る（`Engine_Rejection` へ委ねる境界の確認）。片方だけの注文品目参照が組なしの `start` として通る。
    - 配置 `tests/domain/wire.example.test.ts`。
    - _Validates: Requirements 2.3, 5.2, 5.3_

  - [x]* 8.5 記録の可観測性 — client 側（Property 6）
    - **Property 6: Decode_Failure の可観測性** — 壊れた `snapshot` を受けたとき記録が 1 件残り、記録に Wire_Text の中身が含まれない。
    - 記録を出すのは Decoder ではなく受け口なので、domain のテストからは観測できない。`connectivity.ts` の `SocketOpener` 注入口を使い `console.error` を捕らえる。
    - 配置 `tests/client/`（既存の `connectivityWatch.integration.test.ts` の隣）。
    - _Validates: Requirements 2.9, 2.10_

  - [x]* 8.6 記録の可観測性 — shell 側（Property 6）
    - 壊れた `ClientMessage` を WS へ送ったとき、記録が 1 件残り Working_Copy が変わらないことを確認する。
    - Workers pool の統合テストになる。配置 `tests/shell/`。
    - _Validates: Requirements 2.8, 2.10_

  - [x]* 8.7 受理集合の不変を差分で確認する（Property 4・移行時のみ）
    - **Property 4: ClientMessage の受理集合の不変** — 現行 `parseClientMessage` が値を返す入力に対し `toClientMessage` は等価な値を返し、`undefined` を返す入力に対し `null` を返す。
    - 現行実装をテスト内へ写して比較する。入力は 8.1 の 2 層の生成器を用いる（素の文字列では差が出る入力に届かない）。
    - 配置 `tests/domain/wire-parity.property.test.ts`。**移行の確認後に削除する**（task 10.3）。
    - _Validates: Requirements 5.2, 5.3_

  - [x]* 8.8 domain の import 境界の静的検査（要件 3.5）
    - `src/domain/**` の import 先が domain 内の相対パスだけであることを固定する。既存の `tests/static/boil-sync-purity.test.ts:146-160` は「対象ファイルが engine か domain だけを import する」という逆向きの検査で、これを担わない。
    - 配置 `tests/static/domain-imports.test.ts`。
    - _Validates: Requirements 3.5_

- [x] 9. チェックポイント — green と既存検査の確認
  - `pnpm typecheck` / `pnpm lint` / `pnpm test` を実行し、全体が通ることを確認する。
  - `WIRE_MESSAGE_TYPES` を持つ 3 つの静的検査（`tests/offline-degradation.static.test.ts:101` / `:447`、`tests/sync-set-batch-complete.static.test.ts:84`、`tests/observe/static-analysis.example.test.ts:58`）が通ることを確かめる。`config` を `& StoreConfig` にしても `type:` リテラルの出現位置は変わらない見込みだが、実行して確認する。
  - `pnpm fmt:check` を実行する。

- [x] 10. 独立の後続タスク（本体の差分と混ぜない）
  - [x] 10.1 既存 3 箇所の述語を `predicate.ts` へ寄せる（4b の 2）
    - `engine/migrate.ts:411` と `observe/log.ts:13` の `isNonNegativeInteger` を削除して `predicate.ts` から import する。`order.ts:88-94` の `toPendingOrder` のインライン検査を名前付きの述語へ置き換える。挙動は変えない。
    - `observe/log.ts` が domain から**関数**を import するのは実行時依存として新規である（現状の先例は `observe/scenario.ts:9` の `import type` だけ）。この辺を引く判断を含む。
    - 完了後に `pnpm typecheck` / `pnpm test` を実行する。
    - _Requirements: 3.5_

  - [x] 10.2 ワイヤ生成器を `tests/domain/wireGenerators.ts` へ移設する（任意）
    - `genServerMessage`（`tests/client/generators.ts:317`）と `genWireTimer` / `genPendingOrder` / `genRecommendation` を移し、`tests/client/generators.ts` はそこから import する。契約の生成器を domain 側へ寄せる整理である。
    - **結論：採らない。** 実装後に両者を読み比べた結果、形は同じだが**義務が違う**ことが分かった。
      `tests/client/generators.ts` は狭いプール（`TIMER_ID_POOL` / `SLOT_ID_POOL` / `EXTERNAL_ORDER_ID_POOL`）
      から引いて **id の衝突と再出現を誘発する**——Reconcile の全置換・`processedIds` の刈り取り・snapshot 復活は
      衝突が起きなければ一度も踏まれない。`tests/domain/wireGenerators.ts` は逆に復号が見る形の面を広く踏むため
      域を広く取る。一つに畳めば引数でプールを切り替える分岐が生まれ、どちらの義務なのか読めなくなる
      （`domain/wire.ts` が `toPendingOrder` を流用しないのと同じ判断）。役割分担を両ファイルのヘッダへ明記した。

  - [x] 10.3 差分 PBT を削除する（task 8.7）
    - `tests/domain/wire-parity.property.test.ts` を削除する。移行の一回だけ必要な性質であり、恒久的に残せば撤去したはずの `parseClientMessage` が二つ目の真実としてテスト内に居座る。
    - 完了後に `pnpm test` を実行する。
