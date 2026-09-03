# Requirements Document

## Introduction

本 spec は、client と server の間のワイヤ契約について、**型の正本と実行時検証の対応を構造で担保する**変更を EARS 形式の要件として形式化する。型の正本は既に一箇所である（`src/domain/messages.ts`）。破れているのは検証側で、契約の型を変えても検証がそれに追随しない。本 spec は cast を取り除き、復号を契約の隣へ寄せ、コメントで頼んでいた規律を型へ移す**引き算**である。

振る舞いの変化は一方向にだけある。ClientMessage 側（shell の受け口）の受理集合・拒否集合・ワイヤ上の JSON は変わらない。ServerMessage 側（client の受け口）は意図して変わる——壊れた `snapshot` / `config` を素通しして実在しない状態を表示する現行を、Decode_Failure として破棄し直前の表示を保つ形にする。これが唯一の意図した振る舞いの変化であり、その帰結（影響範囲がメッセージ全体へ広がること・破棄が無音になりうること）は要件 2 が引き受ける。

### 観測事実（実装前に確認済み）

1. `src/client/connectivity.ts:104` の `return parsed as ServerMessage` は `type` と `serverTime` だけを検証して戻り値の型を主張する。`:97` 以降に撤去済み種別を受理する `case` が残り、`candidate.type` が `unknown` のため型検査は失敗しない。cast は `:93` と `:104` の 2 箇所。
2. `src/shell/store-timer-do.ts:151` の `parseClientMessage` はフィールド単位で検証するが、`:159` と `:171` に cast が在る。失敗は `undefined`（`:1060` で判定）、client 側は `null`。
3. `src/domain` にワイヤ復号は無い。domain の import はすべて domain 内の相対パスで、`src/engine` も外部パッケージも import しない。Brand は `src/engine/types.ts:9/12/15/18` で定義されるため、依存方向により `StoreConfig` に現れ得ない。ただしこの向きを守る検査は無い——`tests/static/boil-sync-purity.test.ts:146-160` は engine 側の対象が engine / domain だけを import することを見ており、domain から engine への import は許している。
4. 基数の縮退政策が二つあり、どちらも受け手で果たされていない。`TimerFact.slotIds`（`timer.ts:40`）と engine の `Placement.slotIds`（`schedule.ts:32`）は非空を型で保つがワイヤの受け手は検証せず、`CookRecommendation.slotIds`（`messages.ts:28`）は `readonly string[]` に落として client が `queueDisplay.ts:68` で読み飛ばす。`config` の `noodlePresets` / `slotOffsets` は基数を弱めて運び、`messages.ts:72` は「受け手が `to*` で再確立する」と記すが、`src/client` にその呼び出しは無く `connection.ts:452` はそのまま代入する。
5. `messages.ts:74` は `config` の 14 項目の列挙に「項目が増えたらここへも足す」と記す。`StoreConfig`（`store.ts:264`）は 14 項目で、`config` との差は上記 2 項目の基数だけである。
6. 既存の `to*` は二つの政策を混ぜる。公開関数 `toSlotOffsets` / `toNoodlePresets` / `toUnitOrigins` / `toMenuItems` と内部関数 `toGridPoint`（`store.ts:489`・`fallback` 引数）は不正を既定値へ畳む。内部関数 `toNoodlePreset`（`:523`）/ `toFirmnessCode`（`:567`）/ `toMenuItem`（`:596`）は `null` を返す。`GridPoint` に `null` を返す検証は無い。`toPendingOrders`（`order.ts:67`）は presets と arrivalTime を引数に取る受け口用で、arrivalTime を読むワイヤ復号には流用できない。
7. `parseClientMessage` は `boilSeconds` を `typeof === "number"` までしか見ない。値域（1〜1800 秒）・`timerId` の実在・`slotId` / `noodleType` の妥当性・上限は engine が拒否として返し（`src/engine/start.ts:26-27`）、shell が `error` で要求元へ返す。
8. client の Decode_Failure は無音である。`connectivity.ts:224-226` は pong で up を確定し、pong は auto-response で必ず返るため、snapshot が連続して復号に失敗しても接続は up のまま盤面が凍る。client から `src/observe` への経路は無く、失敗を観測可能に残す先例は `persistence.ts:254/263/304` の `console.error("[yudemen] …")` である。shell 側は `store-timer-do.ts:531` の debug flag と `:596-597` の `console.log(JSON.stringify(entry))` が Instrumentation_Log の唯一の出口である。**この経路は既定で無音である**——`OBSERVE_DEBUG` の既定は `"0"`（`wrangler.jsonc:28`）。加えて `SeamKind` は `src/observe/log.ts:173` で 4 種に閉じられ、`hibernation-observability` 要件 4.9 がそれ以外の箇所からの出力を禁じている。seam の追加は当該 spec の要件改訂を伴う。
9. `start` の `slotIds` は `readonly string[]` と宣言されるが `parseClientMessage` は非空を検証する。`start` の注文品目参照は片方だけ届いた場合をアドホック開始として通す（`toOrderItem`・AC 8.4 を根拠に承認済み）。

### 確定した設計判断

1. ワイヤ復号を `src/domain` へ集約し、両端が同一の実装を用いる（事実 1・2・3）。
2. 復号は `as` を用いず、判別と構造検証だけで戻り値の型を確立する。撤去済み種別のリテラルは union と突き合わされて自力で落ちるため、`case` の残存が実害を持てなくなる（事実 1）。
3. `ClientMessage` / `ServerMessage` は復号後の検証済み値を名指す型とし、未検証の受信物には名前を与えない。
4. 基数の保証はワイヤ型でも保持し、復号が境界で確立する。縮退させるのは Brand のみ（再確立すれば engine の語彙が client へ入る）。政策は両方向に一様で、widen は導入しない（事実 4・9）。
5. `config` の項目列挙は撤去し、`StoreConfig` そのものを運ぶ。列挙の根拠は基数の縮退であり判断 4 が消す。事実 3 により `config` の内容は `StoreConfig` と構造的に同一で、第二の一覧が無ければ取りこぼしは構造的に起こらない。列挙を「配信範囲の関門」として残す案は、双方向一致を型で強制した瞬間に否と答えられなくなるため採らない（事実 5）。
6. 復号の失敗は畳まない。畳む `to*` は復号に用いず、述語と `null` を返す要素単位の検証だけを用いる。`GridPoint` の `null` 返し検証は新設する（事実 6）。
7. Decoder の入力は文字列、Decode_Failure は `null`（事実 2 の非対称を消す）。
8. Decoder は型の一致までを見る。値域・存在・整合を Decode_Failure にすれば `error` の応答経路が消え、無音の破棄になる（事実 7）。
9. Decode_Failure の粒度はメッセージ単位とし、失敗は観測可能にする。記録は**両端とも構造化 1 行 JSON を `console.error` へ**出す形に統一する（事実 8）。Instrumentation_Log は用いない——既定で無音であり、seam の追加は `hibernation-observability` 要件 4.9 を破る。あの機構は hibernation の継ぎ目を覗く道具であって、異常を報せる道具ではない。要素単位で畳めば判断 6 に反し、連続失敗を到達性（up / down）の劣化に合流させれば到達性の概念を汚す。
10. 網羅性は全種別を分布する往復 PBT が担う。mapped type は導入しない。
11. 復号は純粋関数とする。

### 未決の判断（design 段階で確定する）

- **復号の置き場所**：`messages.ts` に同居させるか `wire.ts` を新設するか。`messages.ts` は現在型のみ（`store.ts` / `order.ts` が型と `to*` を同居させる先例はある）。
- **`null` 返し検証の共有方法**：`toNoodlePreset` / `toFirmnessCode` / `toMenuItem` を export するか、`store.ts` 側で「検証」と「既定へ畳む」を分離するか。`toGridPoint` は畳むため分離しなければ共有できない。
- **`pendingOrders` の構造検証**：`toPendingOrder` の構造部分を切り出すか、復号側に書くか。
- **注文品目参照の規則の置き場所**：現行 `toOrderItem` は shell に在り 2 箇所から呼ばれる。規則は変えず、Decoder と shell のどちらが組を成すかだけを決める。
- **要件 4.5 の禁止構文集合**：`as` のほか non-null assertion（`!`）・`<T>expr`・`satisfies` の誤用を含めるか、`as const` を例外とするか。

### スコープ外

- スキーマライブラリ（zod / valibot / arktype 等）、protobuf / gRPC の導入。`src/domain` は外部依存を持たない。
- 種別ごとの復号器を union で鍵付けする mapped type、基数を弱める型変換（widen）。
- 畳む `to*` の挙動の変更。取り込み用としては正当であり、本 spec は復号がそれを使わないことだけを定める。
- lint ルールによる型アサーション不在の保証。要件 4.5 の静的検査と二重にしない。
- 心拍（`PING_REQUEST` / `PONG_RESPONSE` / `setWebSocketAutoResponse`）。
- `start` の注文品目参照の規則の変更。`slot-suggested-start` が品目参照を別種別へ移し `start` から optional を撤去するため、本 spec は `start` の現行の形を復号するに留める。先に着地した方に後着が追随する。
- shell が Decode_Failure を `error` で要求元へ返す変更。新たな送信を伴う挙動変更である。

### naming ゲート（`naming.md`）

本 spec が導入・改名する公開シンボルは、実装前にユーザー確認を要する。対象の一覧と各名が表明する概念境界は **`design.md`「公開シンボルの確認ゲート」を正本とする**（二箇所に置けば食い違う）。

要件が固定する契約形のうち確認を要するのは、Decoder の 2 つの関門名・その置き場所・境界の述語の名・`GridPoint` の `null` 返し検証の名・Decode_Failure の記録の形である。

### tasks へ落とす作業項目

- 撤去済み種別（`started` / `cancelled` / `completed` / `boiled` / `adjusted`）を Decode_Failure にする例示テストを 1 ケース置く（事実 1 の回帰の楔）。
- `messages.ts:19-20` / `:70-74` / `:91-96`、`recommend.ts:49-50` の「基数は JSON を跨げないため受け手が再確立する」趣旨のコメントと、`queueDisplay.ts:68` の読み飛ばしを撤去する。
- `store-timer-do.ts:1060` の `=== undefined` 判定を `null` に合わせる。
- 要件 3.5 を固定する静的検査を 1 本置く（`src/domain/**` の import 先が domain 内の相対パスだけであること。既存の `boil-sync-purity` は逆向きの検査で、これを担わない）。
- 生成器は省略する optional 項目をキーごと省く（`undefined` を値として置くと JSON 直列化で落ち、往復の等価性が生成器の都合で破れる）。

## Glossary

- **Domain**: `src/domain` のドメイン契約。両端が共有する語彙の正本。外部パッケージも `src/engine` も import しない。
- **Shell**: `src/shell` の DO クラスと Effect インタプリタ。プラットフォーム作用の端。
- **Client**: `src/client` の React フロント。
- **Working_Copy**: Shell がメモリ上に保持する `TimerState`。確定の起点は `storage.put` の成功のみであり、メモリへの代入は永続化ではない。
- **Wire_Text**: WebSocket で受信した直後の未検証の文字列フレーム。pong は呼び出し側が先に判別し、Decoder へは到達しない。
- **ClientMessage**: client → server の判別共用体。`start` / `cancel` / `complete` / `adjust` の 4 種。
- **ServerMessage**: server → client の判別共用体。`snapshot` / `config` / `error` の 3 種。すべて `serverTime` を持つ。
- **Decoder**: Wire_Text から ClientMessage または ServerMessage を確立する純粋関数。Type_Conformance までを見て、失敗を Decode_Failure で返す。
- **Decode_Failure**: Decoder が検証を通せなかったときに返す `null`。例外ではない。
- **Type_Conformance**: 宣言型に対する構造の一致（判別子・項目の有無・`typeof`・入れ子・Cardinality_Guarantee・有限リテラル集合の所属）。**方向で範囲が異なる。** ClientMessage 側は上記に限り、値域・識別子の実在・他の事実との整合を含まない（拒否は Engine_Rejection が `error` として要求元へ返す）。ServerMessage 側はこれに加えて Element_Validator が課す正規化条件（余剰フィールドの除去・正の秒数・正の商品コード・`slotSpan` の域内）を含む。上限が要るのは応答経路を残すためであり、ServerMessage 側にその経路は無い。
- **Engine_Rejection**: engine が `decide` の戻り値で表す拒否（`InvalidBoilSeconds` / `InvalidSlotOrNoodle` / `TimerNotFound` / `CapacityExceeded` ほか）。shell が `error` として要求元へ返す。
- **Cardinality_Guarantee**: 型が強制する基数の保証。`NonEmptyArray` の `TimerFact.slotIds` / `start.slotIds` / `CookRecommendation.slotIds` / `MenuItem.sizes` / `StoreConfig.noodlePresets`、および 6 要素タプルの `StoreConfig.slotOffsets`。
- **Brand**: engine 側の検証済み識別子型（`TimerId` / `SlotId` / `NoodleType` / `EpochMillis`）。ワイヤでは生プリミティブへ縮退する。
- **StoreConfig**: `src/domain/store.ts:264` のサーバ権威設定（14 項目）。
- **Folding_Validator**: 不正入力を既定値へ畳む既存の `to*`（`toSlotOffsets` / `toNoodlePresets` / `toUnitOrigins` / `toMenuItems` / `toGridPoint` ほか）。取り込み用で、Decoder は用いない。
- **Element_Validator**: 不正入力を `null` で返す要素単位の検証（`toNoodlePreset` / `toFirmnessCode` / `toMenuItem`）。Decoder が共有する。
- **Instrumentation_Log**: `hibernation-observability` が定義する shell の構造化ログ。出口は `store-timer-do.ts:596-597` の一点で、debug flag が出力可否を決める（`OBSERVE_DEBUG` の既定は `"0"`）。`SeamKind` は 4 種に閉じられている。**Decode_Failure の記録には用いない**（判断 9）。
- **Round_Trip**: 妥当な値を JSON 文字列へ直列化し、Decoder で復号して元の値と深く等価であることを検査する性質。

## Requirements

### Requirement 1: 復号は契約の隣に一つだけ存在する

**User Story:** As a 未来の保守者, I want ワイヤ復号が契約の定義と同じ場所に一つだけ在ってほしい, so that 片端だけが厳密という非対称が生じない

#### Acceptance Criteria

1. THE Domain SHALL ClientMessage の Decoder と ServerMessage の Decoder をそれぞれちょうど 1 つ提供する
2. THE Decoder SHALL Wire_Text を入力とし、JSON の解釈を Decoder の内側で行う
3. WHEN Shell または Client が受信した Wire_Text を解釈する, THE Shell および THE Client SHALL Domain が提供する Decoder を用いる

_出所: 判断 1・7, 事実 1・2・3_

### Requirement 2: Decoder は型について嘘をつかない

**User Story:** As a 厨房スタッフ, I want 壊れた受信物が検証を素通りせず、破棄が無音にもならないでほしい, so that 表示が実在しない状態を映さず、凍ったときに気づける

#### Acceptance Criteria

1. THE Decoder SHALL 型アサーション（`as`）を用いずに戻り値の型を確立する
2. WHEN Decoder が値を返す, THE Decoder SHALL 戻り値の型が宣言するすべての項目（入れ子を含む）について Type_Conformance を検証済みとする
3. WHEN Decoder が ClientMessage を復号する, THE Decoder SHALL Type_Conformance までを検証し、値域・存在・整合を Decode_Failure にしない（それらは Engine_Rejection に委ねる）
4. WHEN Decoder が ServerMessage を復号する, THE Decoder SHALL Element_Validator が課す正規化条件を含めて検証する（この向きに Engine_Rejection に相当する応答経路は無い）
5. THE Decoder SHALL いかなる入力に対しても既定値への置換を行わない
6. THE Decoder SHALL いかなる入力に対しても例外を送出しない
7. THE Decode_Failure の粒度 SHALL メッセージ単位とする（壊れた要素を含む `snapshot` は timers を含めて全体が適用されない）
8. WHEN Decoder が Decode_Failure を返す, THE Shell SHALL 当該メッセージを破棄して Working_Copy を一切変更せず、構造化 1 行 JSON を `console.error` へ出して当該失敗を観測可能に残す
9. WHEN Decoder が Decode_Failure を返す, THE Client SHALL 当該メッセージを無視して表示を変更せず、Shell と同一の形の構造化 1 行 JSON を `console.error` へ出して当該失敗を観測可能に残す
10. THE 記録 SHALL Wire_Text の中身を含まない（`externalOrderId` / `tableId` は POS 由来の業務データである）
11. THE 変更 SHALL pong による up の確定を変えない（Decode_Failure を到達性の判定に持ち込まない）

_出所: 判断 2・6・8・9, 事実 1・2・6・7・8_

### Requirement 3: ワイヤ型は検証済み契約を名指す

**User Story:** As a 未来の保守者, I want ワイヤ型が「復号後の確かな形」を意味してほしい, so that 縮退の政策が一つで済み、設定の配信範囲を第二の一覧で語らずに済む

#### Acceptance Criteria

1. THE ClientMessage および THE ServerMessage SHALL 復号後の検証済み値の型として定義され、THE Domain SHALL 未検証の受信物に対する専用の型を定義しない
2. THE ClientMessage および THE ServerMessage SHALL Cardinality_Guarantee を保持する項目について、その保証を弱めない型で当該項目を宣言する
3. THE ClientMessage および THE ServerMessage SHALL Brand を生プリミティブへ縮退させた形で運び、THE Client SHALL Brand の型に依存しない
4. THE ServerMessage SHALL `config` を `{ type: "config"; serverTime: number } & StoreConfig` の形で宣言し、StoreConfig の項目を再列挙しない
5. THE Domain SHALL `src/engine` を import しない（3.3 と 3.4 が両立する根拠。Brand が StoreConfig に入り得ないことを観測ではなく依存方向で保証する）

_出所: 判断 3・4・5, 事実 3・4・5_

### Requirement 4: 往復と任意入力を性質で押さえる

**User Story:** As a 運用者, I want 契約の全種別が往復で検査されてほしい, so that 新種別の取りこぼしが放置されない

#### Acceptance Criteria

1. WHEN 妥当な ClientMessage または ServerMessage を JSON 文字列へ直列化し Decoder で復号する, THE Decoder SHALL 元の値と深く等価な値を返す
2. THE Round_Trip の検査 SHALL ServerMessage の 3 種すべてと ClientMessage の 4 種すべてを分布する生成器を用いる
3. THE テスト SHALL ClientMessage の生成器を提供し、`start` については注文品目参照を組で持つ形と持たない形の双方を分布する
4. WHEN 任意の文字列を Decoder へ与える, THE 検査 SHALL Decode_Failure または Cardinality_Guarantee を満たす検証済みの値のいずれかが返ることを確認する
5. THE 静的検査 SHALL Decoder を含むファイルに型の嘘を作れる構文が現れないことを、当該ファイル 1 本に限定した走査で固定する

_出所: 判断 10, 事実 1_

### Requirement 5: ClientMessage の受理と JSON は変わらない

**User Story:** As a 運用者, I want この変更が現場の操作とワイヤ形式に影響しないでほしい, so that 契約の厳密化が運用の劣化を招かない

#### Acceptance Criteria

1. THE 変更 SHALL ワイヤ上の JSON（7 種の種別集合・非圧縮 UTF-8 JSON テキスト・各メッセージのキー集合と階層）を変更しない
2. WHEN 本変更の前に Shell が受理していた ClientMessage の Wire_Text を Decoder へ与える, THE Decoder SHALL 同一の ClientMessage を返す（値域外の `boilSeconds` や実在しない `timerId`、片方だけの注文品目参照を含む）
3. WHEN 本変更の前に Shell が破棄していた ClientMessage の Wire_Text を Decoder へ与える, THE Decoder SHALL Decode_Failure を返す
4. THE Decoder SHALL 純粋関数であり、永続・送信・タイマー・待機のいずれの作用も持たない

_出所: 判断 8・11, 事実 7・9_
