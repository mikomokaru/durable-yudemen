# Requirements Document

## Introduction

券売機のイベントストリームから転送されてくる実ペイロード形式（`{ "records": [ { path, payload, arrival_timestamp_ms, sequence_number } ] }`）を受け取り、各レコードを店舗ごとの `StoreTimerDO` へ振り分けて未着手オーダー（Pending_Order）として格納する取り込み経路を新設する。

既存の `POST /s/{storeId}/orders`（Store_Path で宛先を直指定する Order_Ingress）は撤去せず併存させる。本機能が足すのは「宛先をボディから解決する」経路であり、待ち行列の正本・確定の起点といった既存規律は変えない。

### 確定済みの設計判断（ユーザー確認済み）

- **宛先はボディから解決する。** 実ペイロードの `payload.store_id` が本体に入るため、宛先を URL に載せる案は採らない。上流は設定値の単一 URL へ POST し、1 回の POST に複数の `store_id` が混在する。上流はバッチの分割を行わないため、店舗ごとに URL を分ける形は成立しない。
- **`store_id` は外部マスタの店舗コードであり、`StoreId`（推測困難なランダム base32 スラッグ）とは別物である。** `Store.storeCode` に対応させ、`storeCode → StoreId` の逆引きで宛先を解決する。永続キー `index:code`（`CODE_INDEX_KEY`）と design.md の記載は既に存在するが、書き込み・読み出しは未実装である。
- **`storeCode` は全店（active / deactivated を問わず）で一意かつ不変である。** 変更・再利用は拒否する。付け替えは新規店舗の作成として扱う。現状 `resolveBulkElement` は既存 `storeCode` を優先して変更要求を黙って無視しているが、これを明示的な拒否に改める（呼び出し元の意図を偽らない）。
- **逆引き結果を Worker の isolate-local メモでキャッシュする。** `storeCode → StoreId` が不変ゆえ TTL も無効化も持たない。未知コード（不在）はキャッシュしない。Cache API は Cloudflare Access 配下で利用不可かつ DC ローカルゆえ採らない。KV は伝播遅延ゆえ採らない。
- **認可は既存の `ORDER_INGRESS_TOKEN`（`ADMIN_TOKEN` とは別 secret・定数時間照合）を踏襲する。**
- **純粋計算（変換・逆引き索引の構築）は `src/registry/` `src/domain/` へ、作用は `src/worker.ts` と `src/shell/` へ置く既存の分離を守る。**
- **素通しが守るのは `payload` の中身である。** Pass_Through の適用対象はベンダー由来の申告値である `payload` に限る。上流が観測から付与するメタデータ（`path`・`arrival_timestamp_ms`・`sequence_number`）は層が違うため対象外であり、メタデータへ型・構造の要件を課しても素通し原則の例外にはならない（Requirement 14.10・14.11）。
- **ペイロードは素通しする（Pass_Through）。** Record の拒否事由は「retry しても直らず、かつ処理を続けられない」の 1 つのみとする。未知フィールドの混入・想定外の値・想定と異なる型はいずれも拒否事由にしない。Unique_Key を導出できなければ重複判定もストリームへの書込も進められないため、そこだけを毒とする。上流も同じ原則に立ち（上流要件 5.8 / 5.9 / 14.9 / 14.10）、上流の `types.py` はペイロードの型を意図的に定義していない。スキーマ検証を持ち込めば、ベンダーがフィールドを 1 つ増やした瞬間に全レコードが毒になる。ベンダー側の変更で受信が止まる作りを避けることが素通しの理由である（Requirement 14）。
- **恒久的失敗はレコード単位でスキップして継続し、一時的失敗はバッチ全体を落とす。** 恒久的失敗（処理を進めるために要る構造が欠けている——`path` または `payload` のキーがない・`path` が空文字・Unique_Key の 4 要素のいずれかが欠落・null・空文字——および未知の `path`）は retry しても直らないため当該レコードだけを飛ばし、バッチ自体は受理として応答する。一時的失敗（`storage.put` の失敗・スロットリング・接続断）はバッチ全体を失敗として応答し、上流の同一バッチ retry に委ねる。
- **欠落と重複のいずれかが生じる分岐では、常に重複側の挙動を選ぶ（Duplicate_Bias）。** 上流は `report_batch_item_failures` を用いず「どのレコードまで成功したか」を報告しないため、バッチ後半の一時障害は前半の二重処理を生む。重複は下流の冪等が吸収でき、欠落は後から取り戻せない。この非対称が本経路の失敗設計の芯である。
- **宛先が解決できないレコードは捨てず、2 時間だけ保留して店舗登録時に再生する。** 4xx を返せば上流は `workerRejected` を加算してレコードを捨て、5xx を返せばバッチ全体の retry で同一バッチの他店舗も止まる。ゆえに第三の道を採る。未知 `path` を捨てる上流の判断は「`path` が既知 2 値で有限」という前提に立つものであり、増える前提の店舗コードには当たらない。**保留の窓を 2 時間に限るのは、再生に意味があるのがその注文がまだ厨房で作られている可能性がある間だけだからである**（保全より即時性・後述）。
- **保全と即時性が衝突する分岐では即時性を選ぶ。** 待ち行列が表すのは今まさに厨房が茹でるべきものであり、遅れて復旧したデータは害になる（現場に存在しない注文が並ぶ）。ゆえに認可失敗・ボディ不正はそのまま 4xx を返し、データの保全を狙わない。5xx を返せば上流の bisect が単一レコードまで割る間、同一バッチの他店舗も止まり、現在の即時性を過去の保全のために損なう。Duplicate_Bias は「同じ注文が 2 回処理されるか 1 回も処理されないか」という同時性の分岐に適用される規律であり、鮮度の分岐には適用しない——両者は別の軸である。ただし捨てていることは観測できる形を保つ（認可失敗のカウンタと診断ログ）。
- **Order_Arrival_Time の起点は `arrival_timestamp_ms` とする。** これは上流ストリームが採る観測時刻であり、同一レコードを読み直しても値が変わらない唯一の候補である。受理時刻は retry ごとに動き、`payload.datetime` は券売機の時計に依存する naive JST の申告値である。「起点は受け手側の事実であって POS の主張ではない」という既存原則は覆らない。観測する地点が StoreTimerDO から上流ストリームへ移るだけであり、上下流が同じ時間軸を共有できる利点も得る。上流は `arrival_timestamp_ms` が常に非負の整数（epoch ミリ秒）であることを保証する（Upstream_Contract）。ゆえに型として解釈できない値は届かない。届けば上流の契約違反であり、Poison_Record とせず保留して専用カウンタで可視化する（Requirement 8.8〜8.11）。**値域は上流が保証しないため本経路が検査する**——窓は「受理時刻の 2 時間前から受理時刻まで」で、Unrouted_Record の保持期間と同一の根拠に立つ（Requirement 8.12〜8.15）。
- **オーダーの識別は一意キー（4 要素）で行い、キャンセル・変更は同一キーの後着レコードとして表現される。** 上流はキャンセルを表す値で処理経路を分岐させず、内容が 1 バイトでも違えば別レコードとして届ける。ゆえに同一の一意キーに対し内容の異なるレコードが複数回届き、後から届いたものが新しい状態である。上流・本経路・分析基盤の 3 者が「一意キーでグループ化して最新を採る」という同一の解釈を共有する。
- **`order_id` は識別に用いない。** 上流は `order_id` を一意キーの構成に入れず表示用フィールドとして扱い、任意に置換・削除しても一意キーが変わらないことを検証している。`order_id` ベースで識別すると上流の重複判定単位と本経路の識別単位がずれる。
- **重複排除（冪等）は上流に閉じない。** 上流の `seen` マーカーは別 sink に閉じており、転送側は `seen` を参照も登録もせず全件をそのまま POST する。retry と bisect による重複はそのまま届くため、本経路側の冪等が別途要る。
- **fan-out は同一 `store_id` 内で直列、`store_id` 間は並列とする。** 上流のパーティションキーが `store_id` で並列度が 1 であるため、同一 `store_id` のレコードはバッチ内でもバッチ間でも到着順で届く。異なる `store_id` 間の順序は保証されない。順序が意味を持つ単位が `store_id` であるという前提が上下流で一致する。

### 事前提示済みの公開シンボル（ユーザー承認済み・前提として扱う）

| シンボル | 場所 | 概念境界 |
| --- | --- | --- |
| `CodeIndex = ReadonlyMap<string, StoreId>` | `src/registry/code-index.ts` | 外部コード→宛先の逆引き（イデアからの導出値） |
| `buildCodeIndex(stores)` | 同上 | 全店から索引を再導出する純粋関数（`buildReverseIndex` と同型） |
| `storeForCode(index, storeCode)` | 同上 | 索引の単一読み出し（`storesForIdentity` と同型・基数は単数） |
| `resolveStoreCode(storeCode)` | `StoreRegistryDO` の RPC | Worker が宛先を引く唯一の経路 |

`ProvisionFailure` へ `store-code-in-use` / `store-code-immutable` の 2 種を追加することも合意済みである。

### 残る未決事項

**未決事項は 1 つを残して解消した。** 残る `[Q8]` は対応表の値のみで、設定投入で後から与えられる（表が空なら茹で対象が 0 件になるだけで構造は成立する）。ゆえに design・tasks・実装のいずれも本項の確定を待たずに進められる。

> **概念名について:** 本書に現れる `POS_Ingress`・`Arrival_Batch`・`Record`・`Store_Code`・`Code_Index`・`Code_Memo`・`Unique_Key`・`Content_Hash`・`Unrouted_Record`・`Order_Path`・`Status_Path`・`Pass_Through` は要件記述のために導入した仮の概念名である。公開シンボル（型・公開関数・URL パス・失敗種別・カウンタ名）の確定名は命名規律（`naming.md`）に従い、上表以外の新規候補は末尾「命名候補（要確認）」に列挙し、実装前にユーザー確認を要する。

## Glossary

- **Worker**: `src/worker.ts` の極薄エントリポイント。POS_Ingress では認可・宛先解決・宛先 DO への委譲のみを担う。
- **StoreRegistryDO**: 全チェーン・Policy・店舗・名簿のイデア（正本）を保持するシングルトン Durable Object。Code_Index の保持・`resolveStoreCode` の提供・Unrouted_Record の保留と再生を担う。
- **StoreTimerDO**: 店舗のタイマー状態と Pending_Order 集合の正本を保持する Durable Object。
- **POS_Ingress（仮）**: 本機能の全体。Arrival_Batch を受け、宛先店舗を解決し、Pending_Order として確定させる経路。既存 Order_Ingress（`POST /s/{storeId}/orders`）とは別の受け口として立てる。
- **Record_Forwarder（本 spec の外側）**: 券売機のイベントストリームを Arrival_Batch として POS_Ingress へ POST する上流の転送主体。毒レコードを `records` から除外して POST し、バッチ単位の retry・bisect・DLQ を持つ。設定値の単一 URL へ POST し、バッチの分割を行わない。本 spec は Record_Forwarder の実装を規定せず、両者の境界の契約（HTTP ステータスの意味）のみを定める。
- **Arrival_Batch（仮）**: POS_Ingress が受ける 1 リクエストのボディ全体。`records` 配列を持つ。上流ストリームの配信単位であり、意味的なまとまりではない（複数店舗・複数端末・複数 `path` が混在する）。
- **Record（仮）**: Arrival_Batch の `records` 配列の 1 要素。`path`・`payload`・`arrival_timestamp_ms`・`sequence_number` を持つ。
- **Order_Path（仮）**: `path` が `/lio/order` である Record。オーダー内容を運ぶ。
- **Status_Path（仮）**: `path` が `/lio/status` である Record。端末のエラー状態を運び、オーダーではない。
- **Store_Code（仮）**: 外部マスタの店舗コード。実ペイロードでは `payload.store_id`、イデアでは `Store.storeCode` として現れる同一の値。`StoreId` とは別概念である。
- **StoreId**: 店舗 DO の名前（`idFromName` のキー）かつ URL の宛先。レジストリが採番する推測困難なランダムスラッグ。
- **Code_Index（仮）**: `Store_Code → StoreId` の逆引き索引。全店舗のイデアから再導出される導出値であり、永続キー `index:code` に置く。
- **Code_Memo（仮）**: Worker の isolate-local メモ。`resolveStoreCode` の結果を同一 isolate 内で再利用する。
- **Unique_Key（一意キー・仮）**: 1 つのオーダーを指す 4 要素（`store_id`・`terminal_id`・`bill_no`・`datetime`）から決定的に導出される値。上流の重複判定単位・分析基盤の最新採用単位と同一の単位であり、本経路の `externalOrderId` の導出元となる。`order_id` は構成に含めない。
- **Content_Hash（仮）**: Record の生ペイロードの SHA-256。同一 Unique_Key の内容差（変更・キャンセル）を区別する値。
- **Sequence_Number（仮）**: 上流ストリームが採番する `sequence_number`。同一レコードを読み直しても同じ値になるため、本経路の重複排除の第一の鍵とする。
- **Arrival_Timestamp（仮）**: `arrival_timestamp_ms`。上流ストリームが記録する観測時刻であり、retry でも値が変わらない。Order_Arrival_Time の起点。
- **Unrouted_Record（宛先未解決レコード・仮）**: Store_Code が Code_Index に不在で宛先を解決できなかった Record。StoreRegistryDO が保留し、当該 Store_Code の店舗登録が確定した時点で再生する。
- **Pending_Order / PendingOrder**: 未着手オーダーの 1 品目。正本は StoreTimerDO の永続層（`online-cook-scheduling` 要件2.1）。`(externalOrderId, itemIndex)` で 1 品目を一意に指す。
- **Noodle_Size（麺量・仮）**: `child_items` に現れる麺量の指定（実データでは `s_class_code: 65` の要素。「普通」`19401` / 「大盛」`19603`）。**その有無が茹で対象かどうかの判定であり、その値が `slotSpan` を決める。** 茹で時間は変えない。
- **slotSpan**: 1 品目がスロット軸上で占める幅（要する釜の数）。Noodle_Size から翻訳して定める Pending_Order の属性。`Timer.slotIds` / `Placement.slotIds`（割り当てられた実体）に対する「要求」の側であり、両者は対を成す。
- **Order_Arrival_Time**: Pending_Order の到着時刻（絶対時刻の事実）。Wait_Time の起点であり待ち行列の並び順の基準。
- **Poison_Record（毒レコード・仮）**: retry しても直らず、かつ処理を続けられないレコード。判定の責務は上流と本経路で分かれる。
  - 上流（Record_Forwarder）が毒として `records` から除外するもの: base64 が復号できない／復号結果が JSON オブジェクトでない／`kinesis.data`・`sequenceNumber`・`approximateArrivalTimestamp` が取り出せない（worker-forwarder）。これらは POS_Ingress に届く前に `records` から除外済みであり、本経路は同一の判定を持たない。
  - POS_Ingress 自身が毒と判定するもの: `path` または `payload` のキーがない／`path` が空文字／Unique_Key の 4 要素（`store_id`・`terminal_id`・`bill_no`・`datetime`）のいずれかが欠落・null・空文字。
  未知フィールドの混入・想定外の値・想定と異なる型はいずれも毒の事由にしない（Pass_Through・Requirement 14）。
- **Pass_Through（素通し原則・仮）**: ペイロードのスキーマ検証を行わず、Record の拒否を「retry しても直らず、かつ処理を続けられない」場合のみに限る判断規律（Requirement 14）。適用対象は `payload`（ベンダー由来の申告値）のみであり、上流が付与するメタデータ（`path`・`arrival_timestamp_ms`・`sequence_number`）は対象外である。
- **Upstream_Contract（上流の契約・仮）**: 上流が付与するメタデータについて上流が保証する内容。`arrival_timestamp_ms` は常に非負の整数（epoch ミリ秒）である。上流は `arrival_epoch_millis` が datetime 型、または有限かつ非負の int / float のときだけ整数を得て、bool・文字列・非有限・負値・欠落のいずれも `_extract_kinesis_fields` で PoisonRecordError とする。ゆえに型として解釈できない値は届かない。値域は保証しない（`0` は非負ゆえ契約上は通る）。
- **Upstream_Contract_Violation（上流の契約違反・仮）**: Upstream_Contract に反するメタデータを持つ Record。上流のバグの帰結であり、起こらないはずの事象である（Requirement 8.8〜8.11）。
- **Transient_Failure（一時的失敗・仮）**: 時間をおけば解消しうる失敗。`storage.put` の失敗・DO への到達失敗・タイムアウト・スロットリング。バッチ全体の retry で回収する。
- **Permanent_Failure（恒久的失敗・仮）**: retry しても解消せず、処理を続けられない失敗。事由は Poison_Record（処理を進めるために要る構造が欠けている Record）と未知の `path` の 2 つに限る。当該レコードを飛ばして継続する。
- **Duplicate_Bias（重複優先の原則・仮）**: 欠落と重複のいずれかが生じる分岐では常に重複側を選ぶという判断規律。
- **ORDER_INGRESS_TOKEN**: POS_Ingress の Bearer 認可に用いる env secret。`ADMIN_TOKEN` とは別の secret。
- **ADMIN_TOKEN**: Provisioning_API の認可に用いる env secret。POS へは渡さない。
- **Provisioning_API**: 外部システムがチェーン・Policy・店舗・名簿を登録／更新する認可付き API（`/admin/*`）。
- **ProvisionFailure**: レジストリの登録／更新の拒否理由を表す判別可能な和型。HTTP ステータスへの対応付けは `fetch` が一箇所で行う。
- **Store_Path**: 店舗の宛先パス `/s/{storeId}/`（画面）・`/s/{storeId}/ws`（WebSocket）・`/s/{storeId}/orders`（既存 Order_Ingress）。

## Requirements

### Requirement 1: 取り込み経路と認可

**User Story:** 上流の転送主体として、設定値の単一 URL へバッチをそのまま POST したい。店舗ごとに宛先を作り分けるにはバッチの分割が要り、それは順序保証と失敗の単位を壊すからだ。

#### Acceptance Criteria

1. THE Worker SHALL POS_Ingress を `POST /pos/records` で受け付ける（Store_Code・StoreId のいずれも含まない単一のパス）。受け口の名を `orders` としないのは、この経路が Order_Path と Status_Path の双方を含む Record 群を受けるためである（`orders` と名付ければ Status_Path を受けることが名前と矛盾する）。
2. THE Worker SHALL POS_Ingress のリクエストメソッドを POST に限り、他のメソッドには HTTP 405 を返す。
3. WHEN POS_Ingress へのリクエストを受信したとき、THE Worker SHALL `ORDER_INGRESS_TOKEN` と `Authorization: Bearer <token>` を定数時間比較で照合する。
4. IF `ORDER_INGRESS_TOKEN` が未設定（空）であるとき、THEN THE Worker SHALL POS_Ingress を不許可とする。
5. IF 認可に失敗したとき、THEN THE Worker SHALL HTTP 401 を返し、当該リクエストの処理を認可判定で終える（StoreRegistryDO・StoreTimerDO のいずれへも到達させず、状態を一切変更しない。応答コードの根拠は Requirement 9.11）。
6. THE Worker SHALL POS_Ingress の認可鍵を `ORDER_INGRESS_TOKEN` のみとする（`ADMIN_TOKEN` を POS_Ingress の認可に用いない）。
7. THE Worker SHALL POS_Ingress で行う作用を、認可・宛先解決（Requirement 2）・宛先 StoreTimerDO への委譲・Unrouted_Record の保留（Requirement 11）の 4 つに限る。
8. THE Worker SHALL Arrival_Batch の解釈（Record 列の抽出・Store_Code の読み取り・店舗別グループ化・Unique_Key の導出）を `cloudflare:workers` と storage に依存しない純粋関数に委ね、Worker 自身にボディ解釈のロジックを持たせない。
9. WHEN POS_Ingress のリクエストを宛先 StoreTimerDO へ委譲するとき、THE Worker SHALL 内部 identity ヘッダ（`X-Yudemen-Identity`）を転送前に除去する（クライアント由来の同名ヘッダを透過しない不変を経路ごとの例外なく守る）。
10. THE Worker SHALL 宛先 StoreTimerDO のスタブ取得に `locationHint: "apac-ne"` を付与する（既存 WS・Order_Ingress 経路と同一の配置規律）。
11. IF リクエストボディが `records` 配列を持つ形として解釈できないとき、THEN THE POS_Ingress SHALL HTTP 400 を返し、いかなる StoreTimerDO の状態も変更しない（Requirement 9.11 のとおりデータの保全を狙わない）。
12. WHEN `records` が空配列であるとき、THE POS_Ingress SHALL バッチを受理として応答する（全件が上流で除外された結果の空配列を失敗としない）。
13. THE POS_Ingress SHALL 1 リクエストに含まれる Record 件数の上限を 1000 とし、上限を超えるバッチを Transient_Failure として応答する（上流の bisect による分割で通過させる）。100 店規模なら 1 バッチに全店が混在しても数百 Record であり、宛先 DO への RPC は店舗ごとに 1 回ゆえ Worker の subrequest 上限（Paid プランで 1000）に収まる。上限値は実測で調整する前提とする。

### Requirement 2: 宛先解決（Store_Code から StoreId への逆引き）

**User Story:** 運用者として、券売機が知っている店舗コードだけで正しい店舗 DO へオーダーが届いてほしい。URL に載る `StoreId` を上流へ配って回りたくないからだ。

#### Acceptance Criteria

1. THE StoreRegistryDO SHALL Code_Index を全店舗のイデアから再導出できる導出値として扱い、永続キー `index:code`（`CODE_INDEX_KEY`）に保持する。
2. THE StoreRegistryDO SHALL Code_Index の導出を単一の純粋関数 `buildCodeIndex(stores)` で行う。
3. WHEN 店舗イデアの書き込みが確定するとき、THE StoreRegistryDO SHALL Code_Index を全店舗から再導出し、イデアと同一の put-first の確定に含める（導出値を正本から常に再導出できる状態に保つ）。
4. THE StoreRegistryDO SHALL Code_Index の単一読み出しを純粋関数 `storeForCode(index, storeCode)` で行い、全店舗の走査を要しない形にする。
5. THE StoreRegistryDO SHALL `resolveStoreCode(storeCode)` を、Worker が宛先を引く唯一の経路として提供する。
6. IF 指定された Store_Code に対応する店舗が Code_Index に存在しないとき、THEN THE StoreRegistryDO SHALL 当該 Store_Code を未知として応答し、いかなる店舗へもフォールバックしない。
7. THE StoreRegistryDO SHALL Code_Index に非活性（`active=false`）の店舗も含める（Store_Code は全店で一意ゆえ逆引きは活性状態に依らず一意であり、非活性店舗への到着の扱いは Requirement 11 が定める）。
8. THE Worker SHALL Store_Code を DO 名として用いず、`resolveStoreCode` が返した StoreId のみを `idFromName` の引数とする。
9. THE StoreRegistryDO SHALL Code_Index を `ServerMessage` および Provisioning_API の応答以外の経路へ出さない（宛先解決は Worker とレジストリの間に閉じる）。

### Requirement 3: Store_Code の一意性と不変性

**User Story:** 運用者として、店舗コードと店舗の対応が一度決まったら黙って変わらないでほしい。対応がずれれば別の店舗の厨房に注文が流れるからだ。

#### Acceptance Criteria

1. THE StoreRegistryDO SHALL Store_Code を全店舗（`active` / `deactivated` を問わず）で一意とする。
2. IF 登録または更新の要求が、既に他店舗で使用されている Store_Code を指定するとき、THEN THE StoreRegistryDO SHALL 当該要求を HTTP 400（`ProvisionFailure` の `store-code-in-use`）で拒否し、イデアを変更しない。
3. IF 更新の要求が、対象店舗の既存 Store_Code と異なる Store_Code を指定するとき、THEN THE StoreRegistryDO SHALL 当該要求を HTTP 400（`ProvisionFailure` の `store-code-immutable`）で拒否し、イデアを変更しない（既存値を優先して変更要求を黙って無視することをしない）。
4. WHEN 更新の要求が対象店舗の既存 Store_Code と同一の値を指定したとき、THE StoreRegistryDO SHALL 当該要求を受理する（同一ボディの再送を拒否しない・冪等）。
5. IF 一括 upsert（配列ボディの `PUT /admin/stores`）のバッチ内で複数の要素が同一の Store_Code を主張するとき、THEN THE StoreRegistryDO SHALL バッチ全体を HTTP 400 で拒否し、失敗要素を列挙し、イデアを一切変更しない（既存の all-or-nothing 規律を踏襲する）。
6. THE StoreRegistryDO SHALL Store_Code の重複検出を、`detectAmbiguousAssignment` と同型の純粋関数で行う（曖昧な対応を表現可能にしない）。
7. THE StoreRegistryDO SHALL Store_Code の付け替えを新規店舗の作成として扱う（既存店舗の Store_Code を書き換える経路を持たない）。
8. WHERE 登録の要求が Store_Code を省略するとき、THE StoreRegistryDO SHALL 当該店舗を Code_Index に載せずに登録を受理する（Store_Code は任意のメタデータのままとし、POS_Ingress の宛先にならない店舗を許容する）。
9. THE StoreRegistryDO SHALL Store_Code を URL・DO 名・`ServerMessage` のいずれにも出さない（意味のある店舗名を宛先に漏らさない既存規律を維持する）。

### Requirement 4: 逆引き結果の isolate-local キャッシュ（Code_Memo）

**User Story:** 開発者として、オーダーが届くたびにレジストリ DO へ問い合わせたくない。取り込みは高頻度であり、シングルトン DO をホットパスに置けば全店の取り込みが 1 点に詰まるからだ。

#### Acceptance Criteria

1. WHEN `resolveStoreCode` が既知の Store_Code に対する StoreId を返したとき、THE Worker SHALL 当該対応を Code_Memo へ格納する。
2. WHEN Code_Memo が当該 Store_Code の対応を保持しているとき、THE Worker SHALL StoreRegistryDO へ照会せずに宛先を解決する。
3. THE Worker SHALL Code_Memo の各項目を当該 isolate の生存期間にわたり有効として扱う（Store_Code → StoreId が不変であることの帰結として、TTL・無効化・世代管理のいずれも持たない）。
4. IF `resolveStoreCode` が当該 Store_Code を未知として応答したとき、THEN THE Worker SHALL 当該結果を Code_Memo へ格納しない（不在は不変ではなく、後の店舗登録で既知に転じるため）。
5. THE Worker SHALL Code_Memo を isolate 内のメモリのみに置く（Cache API・KV・Durable Object のいずれも Code_Memo の格納先に用いない）。
6. THE Worker SHALL Code_Memo を宛先解決の高速化に限って用い、認可の判定には用いない。
7. THE Worker SHALL 1 つの Arrival_Batch に同一 Store_Code が複数回現れるとき、当該 Store_Code の解決を 1 回に畳む（同一リクエスト内で同じ照会を繰り返さない）。

### Requirement 5: Record の店舗別分配（fan-out）

**User Story:** 運用者として、1 リクエストに複数店舗のレコードが混ざっていても、それぞれの厨房に正しい順序で届いてほしい。同じ店舗のオーダーが入れ替わって届けば、待ち行列の並びが現実と食い違うからだ。

#### Acceptance Criteria

1. THE POS_Ingress SHALL 1 つの Arrival_Batch に複数の Store_Code が混在することを許容する。
2. THE POS_Ingress SHALL 1 つの Arrival_Batch 内の同一 Store_Code のレコード群を、当該店舗の StoreTimerDO への 1 回の委譲でまとめて渡す（店舗ごとに 1 呼び出し）。
3. THE POS_Ingress SHALL 同一 Store_Code のレコード群を上流が届けた順序のまま処理する（同一 Store_Code 内は直列）。
4. THE POS_Ingress SHALL 異なる Store_Code への委譲を並列に行ってよい（Store_Code 間の順序は上流も保証しないため、揃える必要がない）。
5. THE StoreTimerDO SHALL 受領したレコード群から生じる Pending_Order 集合の変化を単一の `storage.put` で確定する（1 店舗内は all-or-nothing であり、部分受理を作らない）。
6. WHEN StoreTimerDO が Pending_Order 集合の変化を確定したとき、THE StoreTimerDO SHALL 永続の成功後にのみ接続中の全クライアントへ broadcast する（確定の起点は `storage.put` 成功のみ）。
7. THE POS_Ingress SHALL 受理を表す応答を、当該応答が受理したと主張する範囲の永続確定の後にのみ返す。
8. IF いずれかの宛先店舗で Transient_Failure が生じたとき、THEN THE POS_Ingress SHALL Arrival_Batch 全体を Transient_Failure として応答する（既に確定した他店舗の分は残り、再送時の重複は Requirement 10 の冪等が吸収する。Duplicate_Bias の適用）。
9. THE POS_Ingress SHALL 宛先店舗数に比例する処理を 1 リクエスト内で完了できない場合の継続機構を持たない（レジストリの収束のような残作業＋Alarm 継続を POS_Ingress に持ち込まず、未完了は Transient_Failure として上流の再送に委ねる）。

### Requirement 6: Record から Pending_Order への写像

**User Story:** 厨房スタッフとして、券売機に入った品目がそのまま待ち行列に並んでほしい。手で転記する手間と誤りをなくしたいからだ。

#### Acceptance Criteria

1. THE POS_Ingress SHALL Record の Unique_Key を 4 要素（`store_id`・`terminal_id`・`bill_no`・`datetime`）から決定的に導出し、当該 Record が指すオーダーの識別に用いる。
2. THE POS_Ingress SHALL Unique_Key の導出規則を上流と一致させる（各要素をパーセントエンコードして `:` で連結する。上流の `seen:{unique_key}:{hash}` の `unique_key` 部と同一の値になり、障害時に上下流の突き合わせができる）。
3. THE POS_Ingress SHALL `order_id` を Unique_Key・`externalOrderId` のいずれの構成にも用いない（上流は `order_id` を表示用フィールドとして扱い、置換・削除しても一意キーが変わらないことを検証している。`order_id` ベースで識別すると上流の重複判定単位と本経路の識別単位がずれる）。
4. THE POS_Ingress SHALL Pending_Order の `externalOrderId` を Unique_Key から導出する。
5. THE POS_Ingress SHALL Order_Path の Record が持つ品目の各要素を、`(externalOrderId, itemIndex)` で一意に指せる 1 件の Pending_Order へ写す。
6. THE POS_Ingress SHALL `itemIndex` を同一 Record 内で決定的に採番する（同一ペイロードから常に同一の `itemIndex` を得る。採番規則は AC 6.21）。
7. WHEN 同一 Unique_Key に対し内容の異なる Record が後から届いたとき、THE POS_Ingress SHALL 当該 Unique_Key の Pending_Order 群を後着の内容で全置換する（後着が新しい状態である。キャンセルと変更を別経路として区別せず、上流・本経路・分析基盤の 3 者が同一の解釈を共有する）。
8. THE POS_Ingress SHALL 1 回の受領（1 店舗分の Record 群）を engine の**単一の状態遷移**として扱い、単一の `Persist` で確定する。Record ごとに遷移を起こせば `Persist` が Record 数だけ生じ、AC 5.5 の「単一の `put`」と重複判定の原子性（AC 10.7）がいずれも破れる。
9. THE POS_Ingress SHALL この単一遷移のために engine のイベント種別を 1 つ追加する（候補 `RecordsReceived`）。**既存の到着・キャンセルイベントでは表現できない**——(a) 到着イベントは非空の品目列を要求するため「茹で対象 0 件」を運べない、(b) いずれのイベントも端末 ID と `sequence_number` を運ばないため重複判定の材料を進められない、(c) Record ごとに分ければ単一 `Persist` が保てない。追加するのはイベント 1 種のみで、割り当ての算術（`placeGroup`）と既存の遷移はいずれも変更しない（Requirement 13.5）。
10. THE POS_Ingress SHALL 重複判定を engine の内側で行う（判定材料が engine 状態に属し、状態を見て決めることが engine の役目である）。shell は翻訳済みの Record 群を渡すだけで、どれが重複かを判断しない。
11. IF 後着の Record から翻訳した茹で対象が 0 件であるとき、THEN THE POS_Ingress SHALL 当該 Unique_Key の Pending_Order 群を除去する（キャンセル、および全品目が非麺へ変更された場合がここに当たる）。
12. WHERE 受領した Record から翻訳した茹で対象が 0 件であり、当該 Unique_Key の Pending_Order が存在しないとき、THE POS_Ingress SHALL Pending_Order 集合を変更せず、重複排除の判定材料のみを進める（麺を含まない注文は正常な入力である。判定材料を進めなければ、同じ注文が再送のたびに翻訳をやり直される）。
13. THE POS_Ingress SHALL 翻訳（麺の仕様の解釈）を shell 側で行い、engine へは翻訳済みの形だけを渡す（翻訳には店舗設定が要り、engine は `StoreConfig` を知らない既存の規律を保つ）。engine が受け取るのは「どの Unique_Key に、どの Pending_Order 群が対応し、どの端末のどの `sequence_number` まで進んだか」だけである。
14. THE POS_Ingress SHALL 同一 Unique_Key に対する新旧の判定を `sequence_number` の単調性ただ一つで行う（冪等の鍵と同一の基準に揃える。基準が 2 つあれば、どちらで見たかによって結論が変わる余地が生まれる。`arrival_timestamp_ms` はミリ秒の同着がありうるため順序基準に用いない）。
15. THE POS_Ingress SHALL Unique_Key の導出・Poison_Record の判定・店舗別の分配を `cloudflare:workers` と storage に依存しない純粋関数として実装する。麺の仕様への翻訳も純粋関数とするが、**その実行は宛先 StoreTimerDO の内側で行う**——翻訳には店舗設定（`noodlePresets` と対応表）が要り、それを持つのは宛先 DO だけである。ゆえに解釈は 2 段に分かれる（Worker が宛先と識別子を決め、DO が品目を決める）。
16. THE POS_Ingress SHALL `boilSeconds` を Pending_Order に持たせず、店舗の `noodlePresets` から `noodleType` × `firmness` で引ける導出値として扱う（既存 `PendingOrder` 契約の維持）。
17. THE POS_Ingress SHALL 余剰フィールドを落として正規化した Pending_Order のみを待ち行列の正本へ渡す（外部の混ぜ物を正本へ持ち込まない）。
18. IF Record の Unique_Key の 4 要素（`store_id`・`terminal_id`・`bill_no`・`datetime`）のいずれかが欠落・null、または文字列化した結果が空文字であるとき、THEN THE POS_Ingress SHALL 当該 Record を Poison_Record として飛ばし、Requirement 9 の規律で継続する（実データでは `store_id` / `terminal_id` / `bill_no` は数値で届く。空文字の判定は Unique_Key 導出時の文字列化を経た値に対して行う・AC 14.5）。
19. THE POS_Ingress SHALL `noodleType`・`firmness`・`slotSpan` のいずれも Record の商品情報から解釈して定める（POS はこれらを名前付きのフィールドとして送らず、上流もペイロードを解釈しない。解釈の責務は本経路にある）。
20. THE POS_Ingress SHALL `child_items` 配列の各要素の意味を当該要素の商品コード（`plu_no`）から判定し、配列内の位置に依らない判定とする（`child_items` は意味の異なる品目を同居させた直列の並びであり、配列の構造が意味を分けていない。位置に依れば、軸の指定が欠ける注文で解釈がずれる）。
21. THE POS_Ingress SHALL 品目が茹で対象であるかの判定を、当該品目の `child_items` に麺量（Noodle_Size）の商品コードが在るか否かで行う（麺量の指定を持たない品目は茹でない。餃子・丼・トッピング・飲料はいずれもここに含まれる）。
22. THE POS_Ingress SHALL 茹で対象でない品目を Pending_Order へ写さない。
23. THE POS_Ingress SHALL 品目が茹で対象であるかの判定に `item_type` を用いない（`item_type` は本経路の判定基準ではない。判定基準を Noodle_Size の有無ただ一つに保つ）。
24. THE POS_Ingress SHALL `slotSpan`（1 品目がスロット軸上で占める幅）を Noodle_Size の商品コードから翻訳して定める（茹で対象の判定と `slotSpan` の決定が同一の入力から導かれる。麺量は茹で時間を変えないが占有するスロット数を変える）。
25. THE POS_Ingress SHALL 翻訳した `slotSpan` を Pending_Order の属性として持たせ、POS の麺量の語彙（商品コード・商品名）を待ち行列の正本へ持ち込まない（翻訳を取り込み経路に閉じることで、engine と client は「この品目が何スロット要るか」だけを知り、POS がそれをどう表現していたかを知らない）。
26. THE POS_Ingress SHALL Pending_Order の各属性を次の出所から定める。`externalOrderId` は Unique_Key（AC 6.4）、`itemIndex` は `order_items` の位置（AC 6.34）、`arrivalTime` は `arrival_timestamp_ms`（Requirement 8.1）、`tableId` は `payload.table_no` を文字列化した値（`table_no` の欠落・0 は卓に紐づかない品目として `null` へ写す）、`noodleType` / `firmness` / `slotSpan` は商品情報からの翻訳（AC 6.19）。
27. THE POS_Ingress SHALL 既存の `toPendingOrders` の全体拒否の規律（1 品目でも不正なら到着全体を拒否）を本経路には適用しない（あちらは「1 つのオーダーの品目群」の原子性を守るための規律であり、本経路では翻訳できない品目が正常に起こりうる——非麺の品目、および対応表に無い麺種である）。本経路は品目単位で扱い、翻訳できた品目のみを Pending_Order へ写す。
28. IF 品目の `noodleType` が店舗の `noodlePresets` に存在しないとき、THEN THE POS_Ingress SHALL 当該品目を Pending_Order へ写さず、件数を観測可能な値として数える（対応表の保守漏れが静かな欠品になることを防ぐ。`boilSeconds` を引けない品目を待ち行列へ入れれば、計画にも表示にも現れない項目が正本に溜まる）。
29. THE POS_Ingress SHALL 商品コードから麺の仕様への対応をいずれも店舗設定（`StoreConfig`）が持つ対応表から引き、本コードベースの定数として持たない（硬さの選択肢コードは定数的に見えるが店舗によって異なりうる。コードに埋め込めば店舗差が現れた時点でデプロイを要する形になる。投入経路は既存の Provisioning_API → StoreRegistryDO → StoreTimerDO を用い、新しい設定系統を立てない）。
30. THE POS_Ingress SHALL 硬さの対応表を「硬さの商品コード → `Firmness`」とし、茹で秒を持たせない（茹で秒は既存の `noodlePresets` が `noodleType` × `firmness` で保つ唯一の出所である。硬さの表に秒を持たせれば同じ真実が二箇所に生まれ、麺種ごとの差も表現できない）。
31. THE POS_Ingress SHALL 対応表を関心事ごとに分けて保持する（1 枚に畳まない）。硬さの選択肢コードは増減せず、メニューはメニュー 1 件につきサイズ 3 件の組で増える（年 10 件未満）。更新の主体と頻度が異なるものを同じ表に混ぜれば、硬さコードを直すためにメニュー全体の再投入が要る形になる。
32. THE POS_Ingress SHALL 各対応表をそれぞれ単一の出所とし、同じ対応を二箇所で定めない（判定の規則をコードに散らさない）。
33. THE POS_Ingress SHALL 油の量・味の濃さの指定を Pending_Order へ写さない（いずれも茹で時間も `slotSpan` も変えない。茹で待ち行列の関心事ではない）。素通し原則により、これらの値が想定外であっても Record を拒否しない（Requirement 14）。
34. THE POS_Ingress SHALL `itemIndex` を `order_items` 配列における元の位置とする（茹で対象でない品目の位置は欠番として残す）。詰め直さないのは、番号が元のペイロードのどこから来たかという事実を保つためである。詰め直せば、対応表の改定で茹で対象の判定が変わった際に既存の待ち行列の番号がずれる。
35. THE POS_Ingress SHALL `qty` が 2 以上の品目を前提としない（上流の実データでは `qty` は常に 1 である。1 品目が 1 件の Pending_Order に対応する）。
36. 本 spec は engine の割り当て（`placeGroup` の算術）を変更しない。`slotSpan` を持たせるところまでを範囲とし、engine が `slotSpan` を見て複数スロットを割り当てる変更は別 spec で扱う（`online-cook-scheduling` の改訂）。それまで engine は現状どおり 1 品目 1 スロットで計画する——大盛が 1 スロットで計画されるのは「まだ実装していない」状態であり、状態について嘘をつくものではない。
37. `[Q8]` 対応表の中身は未提示である。構造の解釈と所在は確定した（茹で対象の判定は Noodle_Size の有無・AC 6.21、`slotSpan` は Noodle_Size から翻訳・AC 6.24、硬さは商品コード → `Firmness`・AC 6.30、対応表はいずれも `StoreConfig` が関心事ごとに分けて持つ・AC 6.29・6.31、`itemIndex` は `order_items` の位置・AC 6.34）。残るのは値のみで、設定投入で後から与えられる。残るのは値のみである——(a) メニュー（親品目の商品コード）が用いる `noodleType`（実データでは `11421`＝特味噌ネギラーメン・`116051`＝新プレ塩）とそのサイズ 3 件の商品コード、(b) 硬さの商品コード帯の全体（判明しているのは `10010`＝かため・`10011`＝ふつうの 2 値のみ）。**値は設定投入と定数定義で後から与えられるため、design と実装は本項の確定を待たずに進められる**（対応表が空なら茹で対象が 0 件になるだけで、構造は成立する）。未知の商品は想定外の値であり、Pass_Through により Record 単位の Poison_Record にはしない（Requirement 14）。対応表に無い麺種の品目単位の扱いは、既存 `src/engine/schedule.ts` の前例（茹で時間が引けない品目は配置せず、待ち行列には残して表示し推奨だけを付けない）を候補とする。

### Requirement 7: `path` による分岐

**User Story:** 開発者として、オーダーではないレコードが待ち行列へ混ざらないでほしい。端末のエラー状態を注文として解釈すれば、現場の待ち行列が汚れるからだ。

#### Acceptance Criteria

1. THE POS_Ingress SHALL 各 Record の `path` の値により当該 Record の意図を判別する。
2. THE POS_Ingress SHALL Order_Path（`/lio/order`）の Record のみを Pending_Order への写像（Requirement 6）の対象とする。
3. IF Record の `path` が本経路の既知の値のいずれでもないとき、THEN THE POS_Ingress SHALL 当該 Record を Permanent_Failure として飛ばし、未知 `path` の件数を観測可能な値として数え、Arrival_Batch の処理を継続する（未知 `path` はバッチ全体の拒否事由にしない）。
4. IF Record の `path` が未知であるとき、THEN THE POS_Ingress SHALL 当該 Record を Pending_Order 集合へ一切反映しない。
5. THE POS_Ingress SHALL Status_Path（`/lio/status`）の Record を意図的な破棄先（blackhole）へ落とし、Pending_Order 集合へ一切反映しない（端末のエラー状態は待ち行列の関心事ではない。この情報を扱う機能は別 spec として立てる）。破棄は「まだ配線していない」ことの表明であり、`path` を解さないことの帰結ではない。
6. WHEN Status_Path の Record を破棄したとき、THE POS_Ingress SHALL 破棄件数を観測可能な値として数える（届いていること自体は観測できる形を保つ。配線前に到着が絶えていれば、それは配線の前に上流を疑う材料になる）。
7. THE POS_Ingress SHALL 既知の `path` の集合を単一の定数として持つ（`path` の判別基準を二箇所に書かない）。
8. THE POS_Ingress SHALL Status_Path の Record を Permanent_Failure として扱わない（破棄という挙動は未知 `path` と同一だが事由が異なる。`/lio/status` は既知の `path` であり、本 spec が扱わないだけである）。
9. THE POS_Ingress SHALL Status_Path の破棄件数を未知 `path` の件数と別のカウンタで数える（前者は配線待ちの既知経路、後者は想定外の到着であり、混ぜれば「未知 `path` が毎秒届いている」という誤った観測になる）。
10. 本経路は Status_Path の Record が StoreTimerDO へ届く唯一の到達経路である。端末の沈黙判定と通知は上流に相当する仕組みが一切なく（上流要件 13.2 / 13.3）、DO 側で完結させる必要がある。ゆえにこれを扱う別 spec が、破棄先を実際の宛先へ差し替える形で配線する（末尾「別 spec への申し送り」を参照）。

### Requirement 8: Order_Arrival_Time の起点

**User Story:** 店主として、待ち時間の計測が信頼できる時刻から始まってほしい。再送のたびに起点が動けば、同じオーダーの待ち時間が観測のたびに変わるからだ。

#### Acceptance Criteria

1. THE POS_Ingress SHALL Pending_Order の Order_Arrival_Time を当該 Record の `arrival_timestamp_ms`（Arrival_Timestamp）から定める。
2. THE POS_Ingress SHALL Order_Arrival_Time を絶対時刻（エポックミリ秒）として保持する。
3. THE POS_Ingress SHALL `payload.datetime` を Order_Arrival_Time の起点に用いない（券売機の時計に依存する naive JST の申告値であり、タイムゾーンの明示もない）。
4. THE POS_Ingress SHALL 受理時刻（StoreTimerDO が受け取った時刻）を Order_Arrival_Time の起点に用いない（再送ごとに値が動き、同一レコードの再取り込みが待ち時間の起点を変えてしまう）。
5. THE POS_Ingress SHALL 1 件の Pending_Order の Order_Arrival_Time を単一の起点から定める（1 品目に対し 2 つの時刻を持たせない）。
6. THE POS_Ingress SHALL 届いた各 Record の `arrival_timestamp_ms` が常に非負の整数（epoch ミリ秒）であることを Upstream_Contract として前提とする（上流は `arrival_epoch_millis` が datetime 型、または有限かつ非負の int / float のときだけ整数を得る。bool・文字列・非有限・負値・欠落はいずれも上流の `_extract_kinesis_fields` で PoisonRecordError となり `records` から除外済みである。同一の判定を本経路で二重に持たない）。
7. THE POS_Ingress SHALL `payload.datetime` を Pending_Order の属性として永続しない（Order_Arrival_Time が起点の正本であり、券売機の申告値を第二の時刻として持てば必ずズレる）。
8. IF Record の `arrival_timestamp_ms` が非負の整数として解釈できない値で届いたとき、THEN THE POS_Ingress SHALL 当該 Record を Upstream_Contract_Violation として保留し、Poison_Record としない（Duplicate_Bias の適用。Poison_Record にすれば上流のバグでデータが静かに消える。保留にすれば残る）。
9. WHEN Upstream_Contract_Violation を検出したとき、THE POS_Ingress SHALL 本経路固有の観測カウンタ（候補 `upstreamContractViolation`）を 1 加算する（起こらないはずの事象として可視化し、件数が 0 でないことが上流の修正を促す契機になる）。
10. THE POS_Ingress SHALL Upstream_Contract_Violation の Record に対して受理時刻・`payload.datetime` のいずれも代替の起点として用いない（受理時刻は retry ごとに動き、`payload.datetime` は券売機の時計に依存する申告値である。起点を推測で埋めない）。
11. THE POS_Ingress SHALL Upstream_Contract_Violation の保留を Requirement 11 の保留と同一の規律で扱う（`put` 成功で確定してから受理を応答する・保持期間 2 時間・件数上限・観測）。保留の格納先を Unrouted_Record の保留領域と同一とするかは設計で定める。
12. THE POS_Ingress SHALL `arrival_timestamp_ms` の値域を「受理時刻の 2 時間前から受理時刻まで」の窓で検査する（Upstream_Contract は型のみを保証し値域を保証しないため、`arrival_timestamp_ms = 0`（1970-01-01）は契約上通る。0 が Order_Arrival_Time になれば Wait_Time が約 56 年となり、並び順の基準が Order_Arrival_Time であるため当該品目が常に先頭に来る）。
13. THE POS_Ingress SHALL 値域の下限を固定値ではなく受理時刻からの相対（2 時間前）として定める（固定の下限はコードに時代を焼き付ける。相対の窓は Unrouted_Record の保持期間と同一の根拠に立つ——その注文がまだ厨房で作られている可能性がある間だけが有効な範囲である・Requirement 11.8・9.15）。
14. THE POS_Ingress SHALL 値域の上限を受理時刻とし、未来の時刻を持つ Record を窓の外として扱う（上流が保証する遅延予算は 15 秒であり、受理時刻より後の到着時刻は時計のずれを超えた異常である）。
15. IF Record の `arrival_timestamp_ms` が値域の窓の外にあるとき、THEN THE POS_Ingress SHALL 当該 Record を Upstream_Contract_Violation と同じ扱い（保留・専用カウンタ）とし、Order_Arrival_Time を推測で埋めない。

### Requirement 9: 失敗の分類と応答（Record_Forwarder との境界契約）

**User Story:** 運用者として、1 台の券売機が壊れたメッセージを送り続けても他店舗の処理が止まらないでほしい。そして直る見込みのある失敗は自動で回収されてほしい。retry で直らない 1 件のためにバッチ全体を止めるのは、現場の待ち行列を止めることに等しいからだ。

> **部分受理を許す正当化（既存設計の禁に対する明示の判断）:** 既存設計は部分受理を「現場が欠品に気づけない嘘」として禁じている。本経路がこれを覆すのは、禁の根拠が本経路には当たらないからである。既存 Order_Ingress の全体拒否は「1 つのオーダーの品目群」という単一の意味的まとまりを守るためのもので、そこでの部分受理は「注文の一部だけ茹でる」という現場に見えない欠落を作る。本経路の Arrival_Batch は上流ストリームの配信単位にすぎず、意味的なまとまりではない（複数店舗・複数端末・複数 `path` が混在する）。ゆえに Record 間には守るべき原子性がない。一方で 1 Record 内の品目群は既存どおり単一の `storage.put` で all-or-nothing を保つ（Requirement 5.5）。**原子性の単位は Arrival_Batch ではなく Record 内の品目群である**——この置き換えが本判断の芯であり、既存の禁は Record の内側でそのまま生き続ける。

#### Acceptance Criteria

1. THE POS_Ingress SHALL 失敗を Permanent_Failure と Transient_Failure の 2 種に分類し、種別ごとに定まった 1 つの挙動を取る。
2. IF Record が Poison_Record であるとき、THEN THE POS_Ingress SHALL 当該 Record を飛ばして次の Record へ進み、Arrival_Batch の処理を継続する。
3. WHEN Poison_Record を飛ばしたとき、THE POS_Ingress SHALL 当該 Record の `sequence_number` と理由の 2 項目のみを含む診断ログを 1 行出力する（ペイロード本体をログへ出さない）。
4. WHEN Poison_Record を飛ばしたとき、THE POS_Ingress SHALL 毒レコード件数の観測カウンタを 1 加算する。
5. WHERE Arrival_Batch の全 Record が Permanent_Failure であるとき、THE POS_Ingress SHALL バッチを受理として応答する（例外を投げず正常終了する）。
6. IF いずれかの Record の処理で Transient_Failure（`storage.put` の失敗・DO への到達失敗・タイムアウト・スロットリング）が生じたとき、THEN THE POS_Ingress SHALL Arrival_Batch 全体を Transient_Failure として応答する。
7. THE POS_Ingress SHALL Transient_Failure の応答に HTTP 5xx を用い、Record_Forwarder による同一バッチの再送を成立させる。
8. THE POS_Ingress SHALL 「どの Record まで確定したか」を応答に含めない（Record_Forwarder は部分成功を扱わずバッチ単位の retry と bisect で絞り込むため、部分成功の報告は使われない）。
9. THE POS_Ingress SHALL 再送による重複を正常な入力として受け、Requirement 10 の冪等で吸収する。
10. WHERE 欠落と重複のいずれかが生じる分岐が存在するとき、THE POS_Ingress SHALL 重複側の挙動を選ぶ（重複は後から消せるが、欠落は取り戻せない）。
11. THE POS_Ingress SHALL 認可失敗に HTTP 401、ボディ不正に HTTP 400 を返し、いずれについてもデータの保全を狙わない（Record_Forwarder は 4xx を `workerRejected` として数えてバッチを継続し、当該レコードを捨てる）。**遅れて復旧したデータは害になる**——待ち行列が表すのは今まさに厨房が茹でるべきものであり、数時間前の注文を後から入れれば現場に存在しない注文が並ぶ。5xx を返せば上流の bisect が単一レコードまで割る間、同一バッチの他店舗も止まり、現在の注文の即時性を過去の注文の保全のために損なう。
12. WHEN 認可に失敗したとき、THE Worker SHALL 認可失敗の件数を観測可能な値として数え、診断ログを 1 行出力する（レコードが捨てられること自体は許容するが、捨てていることが誰にも見えない状態は許容しない。上流の `workerRejected` にはアラームが無いため、鍵の不一致に気づく手段をこちら側に持つ）。この観測は Worker 内で完結し、StoreTimerDO・StoreRegistryDO のいずれも起こさない。
13. THE POS_Ingress SHALL 宛先が解決できない Record を 4xx でも 5xx でもなく保留として扱う（Requirement 11）。
14. THE POS_Ingress SHALL Permanent_Failure の事由を Poison_Record（Glossary の定義）と未知の `path` の 2 つに限る（Pass_Through により、未知フィールド・想定外の値・想定と異なる型を恒久的失敗にしない・Requirement 14）。
15. THE POS_Ingress SHALL 保全と即時性が衝突する分岐で即時性を選ぶ（Duplicate_Bias は「同じ注文が 2 回処理されるか 1 回も処理されないか」という同時性の分岐に適用される規律であり、鮮度の分岐には適用しない。両者は別の軸である）。

### Requirement 10: 冪等（重複排除）

**User Story:** 開発者として、上流の retry で同じレコードが何度届いても待ち行列が二重にならないでほしい。上流は重複を送る前提で組まれており、重複の吸収はこちらの責務だからだ。

#### Acceptance Criteria

1. THE POS_Ingress SHALL 重複排除の鍵を `sequence_number` とする（上流ストリームが採番し、同一レコードを読み直しても同じ値になるため）。
2. WHEN 既に処理済みの `sequence_number` を持つ Record を受けたとき、THE POS_Ingress SHALL 当該 Record を状態を変更せずに読み飛ばし、`storage.put` と broadcast のいずれも新たに発生させない。
3. WHEN 重複として読み飛ばしたとき、THE POS_Ingress SHALL 本経路側の重複吸収件数の観測カウンタを 1 加算する（上流の `dedupeSkipped` とは別の事象ゆえ別名とする・Requirement 12.4）。
4. THE POS_Ingress SHALL `sequence_number` を持たない Record を Poison_Record として扱う（`[Q18]`）。上流の `_extract_kinesis_fields` は `sequenceNumber` を取り出せないレコードを毒として `records` から除外済みであり、本経路に届く Record は必ず当該値を持つ。ゆえに Unique_Key と Content_Hash による代替の冪等機構を持たない——持てば、実際には到達しない経路のために SHA-256（`crypto.subtle` の非同期作用）を純粋な解釈の中へ引き込むことになる。
5. THE POS_Ingress SHALL 重複排除の状態を端末ごとに「最後に処理した `sequence_number`」1 件として保持する（保持期間を持たない）。上流は同一 `store_id` のレコードがバッチ内でもバッチ間でも到着順で届くことを保証するため、単調性の比較 1 つで重複を弾ける。期間付きの台帳を持てば 168 時間分で約 1,200 万件になり、単調性を使えば端末数分（100 店で 300 件）で足りる。
6. THE POS_Ingress SHALL 重複排除の状態を宛先 StoreTimerDO の永続層に置く（当該店舗のレコードだけが当該店舗の重複判定に関わり、中央の重複排除台帳を持たない。上流も sink 間で共有する台帳を持たない設計である）。
7. THE POS_Ingress SHALL 重複排除の判定材料と Pending_Order 集合を**単一の `put` で同時に確定する**（別の `put` に分ければ、判定材料だけが進んで注文が入っていない状態が生じ、その注文は再送でも重複として弾かれて永久に失われる）。ゆえに判定材料は engine の永続スキーマに含める。
8. THE POS_Ingress SHALL 順序保証の前提を「同一 `store_id` 内で `sequence_number` が昇順に届く」ことに置く（上流のパーティションキーが `store_id` で並列度 1 であり、Kinesis のシャード内順序がこれを保証する）。端末ごとに判定材料を持つのは、この店舗単位の保証の部分集合として安全である（同一端末のレコードは同一 `store_id` に属するため、店舗内で順序が保たれれば端末内でも保たれる）。
9. WHEN 同一内容の Arrival_Batch が再送されたとき、THE POS_Ingress SHALL 初回受理と同一の確定状態へ収束させる。
8. THE POS_Ingress SHALL `sequence_number` を Pending_Order の属性として永続しない（重複判定と診断のための値であり、待ち行列の正本が持つ事実ではない）。

### Requirement 11: 宛先未解決レコードの保留と再生

**User Story:** 運用者として、店舗の登録がオーダーの到着より遅れたときに、その間のオーダーが黙って消えないでほしい。登録漏れは運用の事故だが、事故の代償が「気づかないうちに注文が消えていた」であってはならないからだ。

> **なぜ捨てず、かつ再送もさせないのか:** 4xx を返せば上流は `workerRejected` を加算してバッチを継続する——つまりレコードは捨てられる。しかも `workerRejected` にはアラームが設定されておらず（`poisonRecord` と `unknownPath` は 5 分合計 1 件以上で発報する）、欠落が気づかれにくい形になる。5xx を返せばバッチ全体が retry され、bisect が単一レコードまで割るまで同一バッチの他店舗も止まる。上流が未知 `path` を捨てているのは「`path` が既知 2 値で有限」という前提に立つ判断であり、増える前提の店舗コードには当てはまらない。ゆえに 2xx で受理して保留に積む。

#### Acceptance Criteria

1. IF Record の Store_Code が Code_Index に存在しないとき、THEN THE POS_Ingress SHALL 当該 Record を Unrouted_Record として保留し、Arrival_Batch を受理として応答する。
2. THE StoreRegistryDO SHALL Unrouted_Record の保留領域を保持する（Code_Index の保持者であり店舗登録の受け口でもあるため、保留と再生が同一 DO 内で閉じる）。
3. THE StoreRegistryDO SHALL Unrouted_Record の保留を `put` 成功で確定してから受理を応答する（確定の起点は `storage.put` 成功のみ）。
4. IF Unrouted_Record の保留の `put` が失敗したとき、THEN THE POS_Ingress SHALL Arrival_Batch 全体を Transient_Failure として応答する（保留できていないものを受理として応答しない）。
5. WHEN 店舗の登録が確定し、その Store_Code に一致する Unrouted_Record が保留されているとき、THE StoreRegistryDO SHALL 当該 Record を宛先 StoreTimerDO へ再生する。
6. IF 保留の要求を受けた Store_Code が既に Code_Index に既知であるとき、THEN THE StoreRegistryDO SHALL 当該リクエストの内側で保留分の再生を試み、応答を返す前に完了させる。**これがなければ保留が永久に詰まる**——`resolveStoreCode` の応答（未知）を受けた Worker が保留を積む間に再生が完走して停止すると、既知コードのキーに積まれた Record を再生する契機が誰にも残らず、次の店舗登録まで放置される。上流は同一 `store_id` を直列に送るため、応答前に再生を終えれば次バッチとの順序も守られる。再生に失敗したときは一時的失敗として応答する。
7. THE StoreRegistryDO SHALL 再生において「送り終えた最後の `sequence_number` 以下の Record だけを保留から取り除く」（RPC の完了後に当該キーを読み直し、当該値を超える要素のみを残す）。**件数で削ってはならない**——AC 11.6 の同期再生と Alarm 由来の再生は同時に走りうるため（DO は単一スレッドでも await 境界で交互に進む）、件数で削れば一方が他方の未送信分を消す。同一店舗内で `sequence_number` が昇順に届く前提（AC 10.8）があるため、この値で切れば送信済みの範囲が一意に定まる。
8. THE StoreRegistryDO SHALL 再生を同時に 1 本に限る（再生中に受けた保留の要求は追記のみを行い、走っている再生が空になるまで繰り返す過程で拾わせる）。これは正しさの要件ではなく二重送信を減らすための規律である——判定を in-memory のフラグで持つため hibernate を跨げないが、AC 11.7 の identity ベースの削除が正しさを支えるため、フラグが失われても欠落は生じない。
9. THE StoreRegistryDO SHALL 保留が空になるまで再生を再武装する（1 回の実行で全件を送り切ることを前提としない）。
10. THE StoreRegistryDO SHALL 再生を通常の取り込みと同一の写像・冪等・順序の規律で行う（再生専用の解釈経路を持たない）。
11. THE StoreRegistryDO SHALL 再生を既存の収束と同じ Alarm 継続の規律で行う。DO の Alarm は 1 本ゆえ、収束の残作業と再生の残作業を同一ハンドラで多重化する——`setAlarm` は両者の要求の最小値とし、ハンドラは両方の残作業を確認し、再生の失敗が収束の自動リトライ回数を消費しない形にする。
12. THE StoreRegistryDO SHALL Unrouted_Record の保持期間を 2 時間とし、経過した Record を破棄する。上流の DLQ リプレイ可能期間（168 時間）に合わせない——**再生に意味があるのは、その注文がまだ厨房で作られている可能性がある間だけである。** 数時間前の注文を後から待ち行列へ入れれば、現場に存在しない注文が並ぶ。窓を短く保つことで保留領域も小さくなり、件数上限に当たりにくくなる（Requirement 9.11・9.15 と同一の判断規律）。
13. WHEN Unrouted_Record を保持期間の経過により破棄するとき、THE StoreRegistryDO SHALL 破棄件数を観測可能な値として数える。
14. THE StoreRegistryDO SHALL 保留件数と保留中の Store_Code の異なり数を観測可能な値として保持する（登録漏れと不正送信の両方に気づける形にする）。
15. THE StoreRegistryDO SHALL 保留領域の件数上限を定め、上限を超える保留を診断ログとカウンタを伴って破棄する（無制限の保留はレジストリのストレージを無界に伸ばし、正当な保留の再生も遅らせる。上限値は設計で定める）。
16. THE StoreRegistryDO SHALL Unrouted_Record として Record の生値を保持する（再生のための一時保持であり、待ち行列の正本ではない。宛先が定まらない段階では品目の検証に要る `noodlePresets` が得られないため、解釈は再生時に行う）。
17. IF 宛先店舗が非活性（`deactivated`）であるとき、THEN THE POS_Ingress SHALL 当該 Record を保留せず飛ばし、非活性店舗への到着件数を観測可能な値として数える。保留しないのは、保持期間 2 時間の間に閉店店舗が再活性化される見込みが薄く、保留しても破棄されるだけだからである。使われない再生経路（再活性化を契機とする再生）を作れば、その経路はテストされないまま残る。閉店処理後の到着は業務上ありえない事象ゆえ、カウンタで気づける形にとどめる（Requirement 9.15 の「保全より即時性」と同一の判断）。
18. THE POS_Ingress SHALL 非活性店舗への到着の判定を StoreTimerDO の既存ゲートに委ね、本機能で新たな活性判定を足さない（判定を二箇所に置かない）。
19. IF 宛先店舗が未プロビジョニング（投影未受領）であるとき、THEN THE POS_Ingress SHALL 当該店舗の Record を一時的失敗として扱う（非活性とは分類が異なる）。未プロビジョニングは**一時的な状態**である——`createStore` が確定した直後、投影の押し込みは `converge` の Alarm 継続で非同期に進むため、Code_Index に載った直後の到着は投影未達で拒否されうる。これを恒久的失敗として飛ばせば、店舗開設の瞬間に届いた注文が消える。
20. WHILE 当該 Store_Code の Unrouted_Record が非空であるあいだ、THE StoreRegistryDO SHALL `resolveStoreCode` の応答を未知とする（保留分が再生されるまで直接配送を始めない）。**これは欠落を防ぐための不変である**——再生は Alarm 継続で非同期に進むため、その間に新着（大きい `sequence_number`）を直接届ければ冪等の判定材料が進み、後から再生される保留分（小さい `sequence_number`）が全件重複として弾かれる。未知として応答すれば Code_Memo にも載らず、新着も保留へ積まれて到着順が保たれる。
21. WHEN 当該 Store_Code の Unrouted_Record が空になったとき、THE StoreRegistryDO SHALL `resolveStoreCode` の応答を解決可能へ転じる。
22. THE POS_Ingress SHALL 再生時に Order_Arrival_Time の値域窓（Requirement 8.12）を再評価し、窓の外に出た Record を再保留せず破棄する（保留 → 再生 → 窓外 → 再保留の循環を作らない）。破棄件数は観測可能な値として数える。
23. THE StoreRegistryDO SHALL 保持期間の経過による失効を、保留の書き込みと再生の時点で判定する（失効のための常設 Alarm を持たない）。常設 Alarm は hibernation の規律（待つなら寝かせる）に反し、保留が無い間も DO を起こし続ける。

### Requirement 12: 観測

**User Story:** 運用者として、取り込みで何件が捨てられ何件が吸収されたかを、上流の数と突き合わせて確認したい。数が合わないことにしか異常は現れないからだ。

#### Acceptance Criteria

1. THE POS_Ingress SHALL 毒レコード件数のカウンタを上流と同名（`poisonRecord`）とする（同じ意味の値を同じ名前で数え、運用者が 2 系統の数を突き合わせられる形にする）。
2. THE POS_Ingress SHALL 未知 `path` 件数のカウンタを上流と同名（`unknownPath`）とする。
3. THE POS_Ingress SHALL 保留件数のカウンタを本経路固有の名前（候補 `unknownStorePending`）とする。
4. THE POS_Ingress SHALL 本経路側の重複吸収件数のカウンタを上流の `dedupeSkipped` とは異なる名前（候補 `doDedupeSkipped`）とする（上流の `dedupeSkipped` は「`seen` マーカーで弾いた」件数であり別の事象である。同名にすると障害時に人が混同する）。
5. THE POS_Ingress SHALL 観測値を Cloudflare 側の観測系へ出力する（上流は別名前空間の CloudWatch へ出力しており、値が合算されることはない）。
6. THE POS_Ingress SHALL 診断ログに `sequence_number` と理由の 2 項目のみを含める（ペイロード本体・個票の内容をログへ出さない）。
7. THE POS_Ingress SHALL Upstream_Contract_Violation 件数のカウンタを本経路固有の名前（候補 `upstreamContractViolation`）とし、上流のカウンタと同名にしない（上流にこの事象のカウンタは存在しない。上流から見れば自分のバグだからである）。
8. THE Worker SHALL 認可失敗の件数を本経路固有の名前（候補 `unauthorized`）で数える（Requirement 9.12。4xx で捨てられるレコードに気づく唯一の手段がこちら側の観測である）。
9. THE POS_Ingress SHALL Status_Path の破棄件数を本経路固有の名前（候補 `statusDiscarded`）で数え、未知 `path` のカウンタと分ける（Requirement 7.9）。
10. THE POS_Ingress SHALL 非活性店舗への到着件数を本経路固有の名前（候補 `deactivatedStore`）で数える（Requirement 11.15）。
11. THE POS_Ingress SHALL 対応表に無い麺種で写せなかった品目の件数を本経路固有の名前（候補 `unknownNoodleType`）で数える（AC 6.28。対応表の保守漏れが静かな欠品になることを防ぐ）。
12. THE StoreRegistryDO SHALL 保留の失効・件数上限超過・再生時の窓外による破棄の件数を、それぞれ別のカウンタで数える（候補 `heldExpired` / `heldOverflow` / `replayWindowExpired`）。3 つを 1 つに畳まないのは、原因が異なるためである——失効は登録の遅れ、上限超過は不正送信または大量の登録漏れ、窓外は再生の遅れを示す。
13. THE POS_Ingress SHALL 観測値を構造化した `console.log` として出力する（`observability.enabled` 経由で Workers Logs へ入る）。既存の Instrumentation_Log の枠には載せない——あちらは `OBSERVE_DEBUG` ゲートで既定 OFF であり、常時数えるカウンタには向かない。Operation_History にも載せない——あちらの出力対象は Timer 状態の確定差分であり、取り込みの件数はそれに当たらない。
14. THE POS_Ingress SHALL 観測のために新しい binding を追加しない（Workers Analytics Engine は集計に強いが、binding の追加と書き込みの作用が増える。突き合わせの頻度が上がった時点で移せる形に留める）。
15. THE POS_Ingress SHALL DO 内でしか判らない件数（重複吸収・未知麺種・非活性）を受領の結果に載せて返し、Worker が 1 リクエストにつき 1 行のログへまとめる（DO が個別に出力すれば 1 バッチで最大 1000 行が出て、店舗ごとに分散して読めなくなる）。

### Requirement 13: 既存経路との併存とスコープ境界

**User Story:** 保守者として、本機能が触ってよい層と触らない層、残すもの・変えないものを明確にしたい。

#### Acceptance Criteria

1. THE Worker SHALL 既存経路 `POST /s/{storeId}/orders`（Store_Path 直指定の Order_Ingress）を維持し、宛先が既知の単一店舗へ直接投入する運用・試験用の経路として残す（POS からの取り込みの正本は本経路とするが、既存経路を非推奨として明示はしない。上流が単一 URL へ複数店舗混在のバッチを送る形では既存経路を使えず、両者は用途が重ならない）。
2. THE POS_Ingress SHALL Pending_Order 集合の正本を StoreTimerDO の永続層に置き、上流ストリームおよび POS の状態を正本として参照しない。
3. THE POS_Ingress SHALL 上流ペイロードの解釈に関わる純粋計算（Arrival_Batch の解釈・Unique_Key の導出・Pending_Order への写像・麺の仕様の翻訳）を `src/ingress/` に置き、宛先解決の純粋計算（Code_Index の構築・Store_Code の衝突検出）を `src/registry/` に置く。`src/domain/` には共有契約（`PendingOrder` / `StoreConfig` の型）のみを置き、POS ペイロードの形を持ち込まない（client が知る必要のない外部形式を共有契約の中立地帯へ混ぜない）。
4. THE POS_Ingress SHALL 作用（認可・宛先解決の RPC・DO への委譲・`storage.put`・broadcast・保留と再生）を `src/worker.ts` と `src/shell/` に置く。
5. 本機能は `src/engine` の**既存の**状態遷移と割り当ての算術を変更しない。次の 3 つは除く——受領遷移（`RecordsReceived`）の追加（AC 6.9）、`slotSpan` を `PendingOrder` へ足すことに伴う型の追随、冪等の判定材料を engine 状態へ含めることに伴うスキーマ更新。engine が `slotSpan` を用いて複数スロットを割り当てる変更は別 spec で扱う（AC 6.36）。**解消済み**——`lift-group-planning` が `slotSpan` を計画のハード制約にし、割当（`placeBatch`）と Acceptance_Gate（相異なる `slotSpan` 個の釜）が読むようになった（ADR-0002）。
6. 本機能は `src/domain` の `TimerFact` 契約を変更しない（`PendingOrder` は `TimerFact` とは別の契約であり、`slotSpan` の追加は `TimerFact` に及ばない）。
7. 本機能は `PendingOrder` 型と `toPendingOrders` の検証規律を再利用し、同じ検証を二度定義しない。`PendingOrder` への `slotSpan` の追加はこの再利用の範囲内である（既存の検証に 1 属性の検証が加わるだけで、別の検証経路を立てない）。
8. 本機能は `Cook_Scheduling`（Baseline_Plan・Acceptance_Gate・Solver_Worker）の機構を変更しない。到着の受理が再計算の契機となる既存の配線をそのまま用いる。
9. 本機能は上流 Record_Forwarder の実装・送信仕様（再送戦略・バッチサイズ・送信間隔・DLQ）を規定しない。POS_Ingress は受け手側の契約と、上流が公表した HTTP ステータスの解釈に対する適合のみを定める。
10. 本機能は端末のエラー状態（Status_Path の内容）を扱う機能を含まない（Requirement 7.5）。端末の沈黙判定・エピソード化・通知・端末集合の学習はいずれも本機能の範囲外であり、別 spec が本経路の Status_Path 分岐に処理を足す形で扱う（Requirement 7.8・末尾「別 spec への申し送り」）。
11. THE POS_Ingress SHALL 非活性店舗への到着の判定を StoreTimerDO の既存ゲートに委ね、本機能で新たな活性判定を足さない（Requirement 11.16）。未プロビジョニング店舗への到着は既存ゲートと同じ判定を用いるが、**分類が異なる**——Requirement 11.17 の定めるとおり一時的失敗として扱う。
12. 本機能は麺量から `slotSpan` への翻訳を含む（POS の語彙を待ち行列の正本へ持ち込まないため、翻訳は取り込み経路の責務である・AC 6.24・6.25）。翻訳表を保持する `StoreConfig` の拡張も本機能に含む（AC 6.29）。
13. 本機能は `StoreConfig` の拡張に伴う設定投入経路の変更を含む（設定の形を定めるのが本機能であり、別 spec へ切り出せば 2 つの spec が同じ設定項目を見ることになる）。触る範囲は 4 箇所である——`StoreConfig` の型と既定値（`src/domain/store.ts`）、`StoreOverride` と `PolicyFields`（`src/registry/ideal.ts`）、合成対象フィールドの列挙と出口の検証（`src/registry/compose.ts` の `CONFIG_FIELDS`）、拒否型検証（`src/registry/validate.ts` の `ALLOWED_CONFIG_FIELDS`）。追加する項目も既存の規律に従い、未知フィールド・型不一致・値域外・必須欠落を黙って既定へ畳まず拒否する。
14. THE POS_Ingress SHALL 追加する対応表の合成規則を既存の `noodlePresets` と同一（層ごとの丸ごと置換・要素マージなし）とする（要素単位でマージすれば、有効な表がどの層に由来するかが読めなくなる）。
15. THE POS_Ingress SHALL `menuItems` の `noodleType` が `noodlePresets` に存在するかの検証を設定投入の入口では行わない（3 層の合成を経た後の組み合わせでしか判定できず、Policy がメニューを配り店舗が `noodlePresets` を上書きする段階的投入が正当なため）。整合は実行時に扱い、対応表に無い麺種の品目を取り込みの段で弾いて数える（AC 6.28）。

### Requirement 14: 素通し原則（Pass_Through）

**User Story:** 運用者として、ベンダーが券売機のペイロードにフィールドを 1 つ足しただけで受信が止まることを避けたい。ベンダー側の変更で取り込みが停まれば、現場の待ち行列が理由もなく空になるからだ。

> **拒否の基準は 1 つだけである。** 「retry しても直らず、かつ処理を続けられない」——これを満たすものだけを拒否する。Unique_Key を作れなければ重複判定もストリームへの書込もできないため処理を進められない。一方、未知フィールドがあっても書込は成立する。想定外の値は Snowflake では VARIANT のまま保持され、StoreTimerDO 側は解釈する側の責務として扱う。上流も同じ立場に立ち（上流要件 5.8 / 5.9 / 14.9 / 14.10）、上流の `types.py` はペイロードの型を意図的に定義していない。ここでスキーマ検証を持ち込めば、検証の側が先に壊れる。

> **素通しが守るのは payload の中身である。** 適用対象は `payload`、つまりベンダー由来の申告値に限る。`path`・`arrival_timestamp_ms`・`sequence_number` はベンダーではなく上流が観測から付与するメタデータで、層が違う。ゆえにメタデータへ構造・型の要件を課しても素通し原則の例外にはならない。「`path` が空文字なら Poison_Record」という既存の判定（Glossary の Poison_Record・Requirement 7）と Pass_Through が矛盾なく両立するのはこの層の違いによる。`arrival_timestamp_ms` の Upstream_Contract（Requirement 8.6）と、契約違反を拒否事由ではなく保留として扱う判断（Requirement 8.8）も同じ理由で例外にあたらない。

#### Acceptance Criteria

1. THE POS_Ingress SHALL Record の拒否事由を「retry しても直らず、かつ処理を続けられない」の 1 つに限る。
2. THE POS_Ingress SHALL 未知フィールドの混入を Record の拒否事由にしない。
3. THE POS_Ingress SHALL 想定外の値（想定範囲外の数値・想定しない列挙値・空配列など。上流が挙げる例は `error_level` の範囲外・`canceled` の値・`errors` の空配列）を Record の拒否事由にしない。
4. THE POS_Ingress SHALL `payload` 内の型が想定と異なる値を Record の拒否事由にしない。
5. WHEN 型が想定と異なる値を Unique_Key の導出に用いるとき、THE POS_Ingress SHALL 当該値を文字列化して用い、ペイロード自体を書き換えない。
6. THE POS_Ingress SHALL ペイロードのスキーマ検証を行わない（ベンダーがフィールドを追加しても受信が止まらない形を保つ）。
7. THE POS_Ingress SHALL Unique_Key の 4 要素を導出できない Record のみを、ペイロードの内容に起因する Permanent_Failure として扱う（重複判定と宛先への書込のいずれも Unique_Key を要するため、これを導出できない Record は処理を続けられない）。
8. THE POS_Ingress SHALL 想定外の値を持つ Record を通常の Record と同一の経路で処理する（素通しのための例外経路を持たない）。
9. THE POS_Ingress SHALL 余剰フィールドを落とす正規化（AC 6.17）の対象を Pending_Order へ写す値に限り、Unrouted_Record として保留する生値（AC 11.14）を書き換えない。
10. THE POS_Ingress SHALL Pass_Through の適用対象を `payload`（ベンダー由来の申告値）に限る。
11. THE POS_Ingress SHALL 上流が付与するメタデータ（`path`・`arrival_timestamp_ms`・`sequence_number`）を Pass_Through の適用対象に含めない（層が違うため、メタデータへ型・構造の要件を課すことは素通し原則の例外にあたらない）。

## 要確認事項（残る 1 項）

- **[Q8] 対応表の中身（ブロッカーではない）。** 構造の解釈と所在は確定した（Requirement 6.13〜6.28）。残るのは値のみで、設定投入によって後から与えられる。**design・tasks・実装は本項を待たずに進められる**（対応表が空なら茹で対象が 0 件になるだけで、構造は成立する）。
  - (a) メニュー（親品目の商品コード）が用いる `noodleType` と、そのサイズ 3 件の商品コード。実データでは `11421`＝特味噌ネギラーメン・`116051`＝新プレ塩が該当する。メニュー追加は年 10 件未満で、1 件につきメニュー 1・サイズ 3 の組で増える。
  - (b) 硬さの商品コード帯の全体。判明しているのは `10010`＝かため・`10011`＝ふつうの 2 値のみ。`StoreConfig` の表として投入する（AC 6.20）。
**設計と実装を止める未決事項は無い。** 残る `[Q8]` は対応表の値のみで、設定投入によって後から与えられる。

## 別 spec への申し送り（Status_Path / 端末の沈黙判定）

本 spec は Status_Path の Record を扱わない（Requirement 7.5・13.10）。ただし本経路が status の唯一の到達経路であり（Requirement 7.8）、これを扱う別 spec は本経路の Status_Path 分岐に処理を足す形になる。上流から共有された前提を以下に記録する。**本節は別 spec の設計の入力であり、本 spec の受入基準ではない。**

**責務の境界。** 上流は status の途絶を判定しない。通知・アラーム・状態遷移の算出のいずれも行わない（上流要件 13.2）。上流の合成テンプレートには、合成イベントを生成するコンポーネント・期待端末集合のデータストア・死活キーを書き込むコンポーネント・沈黙判定しきい値の設定キーのいずれも含まれず、その個数が 0 であることが受入基準である（上流要件 13.3）。**検知と通知は DO 側で完結させる必要があり、上流に相当する仕組みは一切ない。**

**しきい値。** 目安は 45 秒（ハートビート間隔 15 秒 × 3）。`design.md` がオフライン検知の方針として記録し、上流要件 13.9 が遅延予算の根拠に用いる値である。分析基盤（Snowflake）は別の値 60 秒を用いる——同一 `store_id` × `terminal_id` の連続 2 観測の間隔が 60 秒以上の区間を停止時間帯として uptime を導出し（上流要件 12.12）、エラーエピソードの区切りも 60 秒以上を新エピソードの開始とする。**2 つの値は目的が違う。** 45 秒はリアルタイム通知のしきい値、60 秒は事後集計の区間定義である。DO 側で 45 秒を採るなら Snowflake の uptime と数値は一致しない。ダッシュボードで両方を並べるときはこの差を前提とする。

**上流が保証する遅延予算。** IteratorAge アラームと DLQ 滞留アラームがいずれも正常であれば、KDS の `approximateArrivalTimestamp` から Worker への POST 完了までを 15 秒以下に保つ（上流要件 13.9）。45 秒に対して 3 分の 1 の予算である。内訳は `max_batching_window` の 1 秒と HTTP タイムアウトの 10 秒、残りが処理時間。ゆえに 45 秒で沈黙と判定したとき、正常な経路であれば「券売機が 30 秒以上送っていない」ことを意味する。経路の遅延を沈黙と誤認する余地は、アラームが正常な範囲では小さい。

**経路障害と券売機障害の切り分け（最も重要）。** 転送が止まると DO からは全台一斉の沈黙に見える。券売機が正常でも、DO 側の観測は「全店舗の全端末が同時に黙った」になる。切り分けの根拠は上流が提供し、`worker-forwarder` の IteratorAge アラームと DLQ 滞留アラームが同一ダッシュボードに並ぶ（上流要件 13.8）。

| 上流のアラーム | 意味 |
| --- | --- |
| どちらかが発報中 | 経路障害。券売機は正常な可能性が高い |
| どちらも正常 | 券売機障害 |

DO 側で全台沈黙を検知したときは、通知の前にこの区別が要る。経路障害で 390 台ぶんの通知を出せば、店舗スタッフには意味のない通知になる。**沈黙している端末数が自店の端末集合の全数に達したときは経路障害の可能性を疑う設計が勧められている**——1 店舗で全台が同時に落ちる確率より、経路が落ちる確率が高い。上流のアラーム状態を DO から直接読むことはできないため、判定は「全数沈黙かどうか」という DO 側の観測で代替する。

**端末集合の扱い。** 上流は端末マスタを持たない。`terminal_id` の値（41 / 42 / 43）を列挙・前提としてハードコードしないことが上流要件 8 であり、Property 7 がメタモルフィックテストで検証している（43 が出現しても無変更で通る）。DO 側も同じ方針を引き継ぐ——per-store DO が受信ハートビートから自店の端末集合を学習し、マスタを持たない。端末が増えたときに登録作業を要しないためである。代償として、**初めて観測するまでその端末の沈黙は検知できない**（起動時から一度も送ってこない端末は集合に入らず、沈黙にもならない）。学習した集合をどの期間保持するか（1 台が恒久的に撤去されたときにいつ集合から外すか）は DO 側の判断であり、上流に対応する仕組みがないため参考にできる前例がない。

**`errors[]` の意味。** `errors[]` は現在出ているエラーの状態スナップショットであり、発生イベントではない。同じエラーが続いている間、15 秒ごとに同じ内容が届く。イベントとして数えれば 1 つの障害が 4 件/分で増え続けるため、**エピソード化（連続した区間を 1 件に畳む）が要る**。Snowflake 側は 60 秒の間隔で区切っており、DO 側も同じ考え方を要する。空配列も意味を持つ——`errors: []` は「エラーが出ていない」という状態の報告であり、上流は空配列のまま 1 件のエントリとして保持して間引かない。**沈黙判定の入力は `errors` の中身ではなく、status レコードが届いたという事実そのものである。**

**並行運転中の注意。** カットオーバーの DNS 伝播中は、旧系へルーティングされた status が DO に届かない（上流要件 17.4）。伝播ウィンドウは 60 秒程度であり、45 秒のしきい値では切替中に一時的な沈黙判定が出る可能性がある。上流要件 17.4 は「status については 15 秒間隔ハートビートにより伝播ウィンドウ終了後に状態が収束する」ことを許容範囲として置いている。収束はするが、**その間の誤通知は防いでいない。** 切替当日は通知を抑制するか、runbook の安定確認が終わるまで沈黙通知を保留する運用を要する。

**最終観測時刻に用いる時刻。** ESM の retry と bisect で同じ status が 2 回届くことがある。沈黙判定は「最後に届いた時刻」を更新する処理ゆえ、重複しても判定は壊れない。ただし `arrival_timestamp_ms` を用いる場合、再送でも値が変わらないため**最終観測時刻が進まない**。受理時刻で更新すれば進む。Order_Arrival_Time に `arrival_timestamp_ms` を採った理由は起点の安定性（Requirement 8）だが、沈黙判定の最終観測時刻については受理時刻のほうが素直である。**用途が違うため 2 つの時刻を別々に持つのが安全である**——本 spec が受理時刻を Order_Arrival_Time の起点に用いない（AC 8.4）ことと、沈黙判定が受理時刻を最終観測時刻に用いることは、別概念ゆえ矛盾しない。

### 確定済み（本書で判断を下した点）

- ~~宛先を URL に載せるか、ボディから解決するか~~ → ボディから解決する。上流は単一 URL へ POST し、バッチを分割しない（Introduction・Requirement 1.1）。
- ~~`store_id` と `StoreId` の関係~~ → `store_id` は `Store.storeCode` に対応する外部コードであり、`storeCode → StoreId` の逆引きで宛先を解決する（Requirement 2）。
- ~~`storeCode` の一意性・可変性~~ → 全店で一意かつ不変。変更・再利用は明示的に拒否する（Requirement 3）。
- ~~逆引きのキャッシュ方式~~ → Worker の isolate-local メモ。TTL・無効化なし。未知はキャッシュしない。Cache API・KV は採らない（Requirement 4）。
- ~~認可鍵~~ → 既存の `ORDER_INGRESS_TOKEN`（`ADMIN_TOKEN` とは別 secret・定数時間照合）（Requirement 1）。
- ~~非活性店舗を Code_Index に含めるか~~ → 含める。逆引きは活性状態に依らず一意（Requirement 2.7）。
- ~~`storeCode` 省略の店舗を許すか~~ → 許す。Code_Index に載らず POS_Ingress の宛先にならないだけとする（Requirement 3.8）。
- ~~[Q4] レコード単位の部分失敗の応答~~ → 恒久的失敗はレコード単位でスキップして継続しバッチは受理、一時的失敗はバッチ全体を落として上流の retry に委ねる。部分受理を許す正当化は「原子性の単位は Arrival_Batch ではなく Record 内の品目群である」（Requirement 9 の冒頭注記）。
- ~~未知 `path` の扱い~~ → 飛ばして件数を数え、バッチの処理を継続する（Requirement 7.3）。
- ~~[Q2] `/lio/status` の扱い~~ → 未知 `path` と同一に扱い、Pending_Order 集合へ反映しない。端末エラー状態を扱う機能は別 spec とする（Requirement 7.5・13.10）。
- ~~全件が恒久的失敗のときの応答~~ → 受理として正常終了する（Requirement 9.5）。
- ~~1 店舗の永続失敗が全体の応答をどう変えるか~~ → バッチ全体を Transient_Failure として応答する。重複は冪等が吸収する（Requirement 5.8）。
- ~~部分成功をどう報告するか~~ → 報告しない。上流は `report_batch_item_failures` を用いずバッチ単位の retry と bisect で絞り込む（Requirement 9.8）。
- ~~重複と欠落のどちらを許すか~~ → 常に重複側を選ぶ（Duplicate_Bias・Requirement 9.10）。
- ~~[Q12] 未知 Store_Code の扱い~~ → 2xx で受理して保留し、店舗登録の確定を契機に再生する。保持期間は 2 時間（Requirement 11）。
- ~~[Q13] 認可失敗とボディ不正の応答コード~~ → 401 / 400 をそのまま返し、データの保全を狙わない。**遅れて復旧したデータは害になる**——待ち行列が表すのは今まさに厨房が茹でるべきもので、数時間前の注文を後から入れれば現場に存在しない注文が並ぶ。5xx は上流の bisect が単一レコードまで割る間、同一バッチの他店舗も止め、現在の即時性を過去の保全のために損なう。捨てていることに気づく手段として、認可失敗の件数と診断ログをこちら側に持つ（Requirement 9.11・9.12・12.8）。
- ~~保全と即時性のどちらを優先するか~~ → 即時性。Duplicate_Bias は同時性の分岐に適用される規律であり、鮮度の分岐には適用しない（Requirement 9.15）。この判断は Unrouted_Record の保持期間にも及ぶ——168 時間から 2 時間へ短縮した根拠がこれである（Requirement 11.8）。
- ~~冪等の状態の保持期間~~ → 期間を持たない。端末ごとに「最後に処理した `sequence_number`」1 件を保持し、単調性の比較で弾く。期間付きの台帳は約 1,200 万件になるが、単調性なら端末数分（100 店で 300 件）で足りる（Requirement 10.5）。
- ~~[Q17] `arrival_timestamp_ms` の値域~~ → 「受理時刻の 2 時間前から受理時刻まで」の窓で検査する。下限は固定値ではなく受理時刻からの相対とし（固定値はコードに時代を焼き付ける）、Unrouted_Record の保持期間と同一の根拠に立つ。窓の外は Upstream_Contract_Violation と同じ扱い（保留・専用カウンタ）とし、起点を推測で埋めない（Requirement 8.12〜8.15）。
- ~~[Q11] 観測値の出力先~~ → 構造化 `console.log`（`observability.enabled` で Workers Logs へ）。Instrumentation_Log は既定 OFF ゆえ常時のカウンタに向かず、Operation_History の出力対象は Timer 状態の確定差分ゆえ該当しない。新しい binding は追加しない（Requirement 12.10・12.11）。
- ~~[Q14] 非活性店舗への到着~~ → 保留せず飛ばして数える。保持期間 2 時間の間に再活性化される見込みが薄く、保留しても破棄されるだけである。使われない再生経路はテストされないまま残る。活性判定は StoreTimerDO の既存ゲートに委ね、二箇所に置かない（Requirement 11.13・11.14）。
- ~~[Q15] 順序基準~~ → `sequence_number` の単調性ただ一つ。冪等の鍵と同一の基準に揃える（基準が 2 つあれば結論が分かれる余地が生まれる）。`arrival_timestamp_ms` はミリ秒の同着がありうるため用いない（Requirement 6.8）。
- ~~[Q15] バッチ件数上限~~ → 1000 Record。超過は 5xx で返し上流の bisect に分割させる。100 店規模なら全店混在でも数百 Record で、店舗ごと 1 RPC ゆえ subrequest 上限（1000）に収まる。実測で調整する前提（Requirement 1.13）。
- ~~[Q5] `seen` マーカーの所在と冪等の鍵~~ → `seen` は上流の別 sink に閉じる。本経路側の冪等が別途必要で、鍵は `sequence_number`。カットオーバー期間は Unique_Key と Content_Hash の組（Requirement 10）。
- ~~[Q3] Order_Arrival_Time の起点~~ → `arrival_timestamp_ms`。retry で値が動かない唯一の候補であり、上流ストリームの観測事実ゆえ「起点は受け手側の事実」原則は覆らない（Requirement 8）。
- ~~[Q1] キャンセル・変更の表現~~ → 同一 Unique_Key の後着レコードとして届く。後着が新しい状態であり、キャンセルと変更を別経路として区別しない（Requirement 6.7）。
- ~~[Q7] `externalOrderId` の組み方~~ → Unique_Key（4 要素）から導出する。`order_id` は用いない（Requirement 6.1〜6.4）。
- ~~[Q6] fan-out の直列/並列~~ → 同一 Store_Code 内は直列、Store_Code 間は並列（Requirement 5.3・5.4）。
- ~~[Q9] 既存 `/s/{storeId}/orders` の位置づけ~~ → 維持する。運用・試験用の直接投入経路として残し、非推奨とは明示しない（Requirement 13.1）。
- ~~[Q10] POS_Ingress の URL パス~~ → `POST /pos/records`。受け口が Order_Path と Status_Path の双方を含む Record 群を受けるため `orders` とは名付けない（Requirement 1.1）。
- ~~麺の仕様を POS が名前付きで送るか~~ → 送らない。`noodleType` / `firmness` / `slotSpan` はいずれも `child_items` と親品目の商品コードから本経路が解釈する（Requirement 6.13）。表の中身は `[Q8]` として残るが設計は止めない。
- ~~対応表を定数として持つか設定として注入するか~~ → いずれも `StoreConfig` の表として外部から注入する。硬さの選択肢コードは定数的に見えるが店舗差がありうるため、コードに埋め込まない（埋め込めば店舗差が現れた時点でデプロイを要する）。**ただし表は関心事ごとに分ける**——硬さは増減せず、メニューはサイズ 3 件の組で年 10 件未満増える。混ぜれば硬さコードの修正にメニュー全体の再投入が要る（Requirement 6.20・6.22・6.23）。
- ~~硬さの表が持つ値~~ → 硬さの商品コード → `Firmness` の対応のみ。茹で秒は持たない。秒は既存 `noodlePresets` が `noodleType` × `firmness` で保つ唯一の出所であり、硬さの表に秒を持たせれば同じ真実が二箇所に生まれ、麺種ごとの差も表現できない（Requirement 6.21）。
- ~~油の量・味の濃さの扱い~~ → Pending_Order へ写さない。茹で時間も `slotSpan` も変えず、茹で待ち行列の関心事ではない。素通し原則により値が想定外でも Record は拒否しない（Requirement 6.23）。
- ~~茹で対象かどうかの判定~~ → `child_items` に麺量（Noodle_Size）の商品コードが在るか否かの一点で判定する。無い品目は茹でない（餃子・丼・トッピング・飲料はここに含まれる）。`item_type` は判定に用いない（Requirement 6.15〜6.17）。
- ~~麺量（大盛）の扱い~~ → 茹で時間は変えず、占有するスロット数を変える。Noodle_Size から `slotSpan` へ翻訳して `PendingOrder` に持たせる。**判定と翻訳が同一の入力から導かれる**——Noodle_Size の有無が茹で対象を決め、その値が `slotSpan` を決める（Requirement 6.18・6.19）。
- ~~`slotSpan` の命名~~ → `slotSpan`。`slotIds`（割り当てられた実体）に対する「要求」の側として対を成す（Glossary）。
- ~~`itemIndex` の採番~~ → `order_items` における元の位置。茹で対象でない品目の位置は欠番として残す（詰め直せば対応表の改定で既存の番号がずれる・Requirement 6.21）。
- ~~`qty` が 2 以上の品目~~ → 来ない。1 品目が 1 件の Pending_Order に対応する（Requirement 6.22）。
- ~~engine の複数スロット割り当て~~ → 本 spec の範囲外。`slotSpan` を持たせるところまでを本 spec とし、`placeGroup` の算術の変更は `online-cook-scheduling` の改訂として別に立てる。それまで大盛は 1 スロットで計画される（Requirement 6.23・13.5）。
- ~~Status_Path を本 spec でどう扱うか~~ → 意図的な破棄先（blackhole）へ落とし、件数のみ数える。未知 `path` とは別カウンタとする。配線は status DO の spec が破棄先を実際の宛先へ差し替える形で行う（Requirement 7.5・7.6・7.9・7.10）。
- ~~不正なペイロードをどこまで毒とするか~~ → 素通しする（Pass_Through）。拒否は「retry しても直らず、かつ処理を続けられない」場合のみ。未知フィールド・想定外の値・想定と異なる型は拒否事由にせず、スキーマ検証を行わない（Requirement 14）。
- ~~毒レコード判定の責務分担~~ → base64 の復号不能・JSON オブジェクトでない・`kinesis.data` / `sequenceNumber` / `approximateArrivalTimestamp` が取り出せないものは上流が `records` から除外済み。本経路が判定するのは `path` / `payload` のキー欠落・`path` の空文字・Unique_Key 4 要素の欠落・null・空文字に限る（Glossary の Poison_Record・Requirement 6.12・8.6）。
- ~~素通し原則の適用層~~ → 適用対象は `payload`（ベンダー由来の申告値）に限る。上流が付与するメタデータ（`path`・`arrival_timestamp_ms`・`sequence_number`）は対象外であり、メタデータへ型・構造の要件を課すことは素通し原則の例外にあたらない（Requirement 14.10・14.11）。
- ~~[Q16] 解釈できない `arrival_timestamp_ms` の扱い~~ → 型として解釈できない値は届かない。上流が `arrival_timestamp_ms` を常に非負の整数（epoch ミリ秒）として保証するためである（Upstream_Contract）。それでも届けば上流の契約違反であり、Poison_Record とせず保留し、本経路固有のカウンタ（候補 `upstreamContractViolation`）で可視化する。受理時刻・`payload.datetime` のいずれも代替の起点として採らない（Requirement 8.6・8.8〜8.11・12.7）。値域は保証されないため、その検査は `[Q17]` として残る。

## 命名候補（要確認 — `naming.md` の公開シンボル確認事項）

事前承認済みの 4 シンボル（`CodeIndex` / `buildCodeIndex` / `storeForCode` / `resolveStoreCode`）と `ProvisionFailure` への 2 種追加（`store-code-in-use` / `store-code-immutable`）に加えて、本機能では以下の新規公開シンボルが要りうる。いずれも実装前にユーザー確認を要する。

- **POS_Ingress の URL パス**: `POST /pos/records`（確定）。既存 `/s/{storeId}/orders`・`/admin/*`・`/entry/*` と衝突しない名前空間である。
- **Arrival_Batch と Record の型**: 候補 `ArrivalBatch` / `ArrivalRecord`。上流の実ペイロード形（未検証の生値）を表す型として `src/domain/` と `src/registry/` のどちらに置くかも判断を要する。
- **Arrival_Batch の解釈（純粋関数）**: 候補 `toArrivalBatch(raw)`（既存 `toPendingOrders` / `toOrderIntent` と同型の「生値 → 検証済みの形 または null」）。
- **Unique_Key の導出（純粋関数）**: 候補 `toUniqueKey(payload)` / `uniqueKeyOf(payload)`。上流のエンコード規則（パーセントエンコード＋`:` 連結）と一致させる契約を名前で示す案として `toForwarderUniqueKey` も検討する。
- **Content_Hash の導出**: 候補 `contentHash(raw)`。SHA-256 は `crypto.subtle` の非同期作用ゆえ純粋モジュールに置けない点の扱いを設計で定める。
- **店舗別グループ化（純粋関数）**: 候補 `groupByStoreCode(records)` / `toStoreGroups(records)`。
- **Store_Code の重複検出（純粋関数）**: 候補 `detectDuplicateStoreCode(stores)`（`detectAmbiguousAssignment` と同型）。返す衝突の型は候補 `DuplicateStoreCode`。
- **Code_Memo**: Worker のモジュールスコープに置くメモ。候補 `codeMemo`（非公開のモジュール変数とし公開シンボルにしない）／宛先解決の入口関数を候補 `resolveDestination(env, storeCode)` として公開する。
- **Unrouted_Record の型と保留領域**: 候補 `UnroutedRecord`（型）・`unrouted:{storeCode}`（永続キー書式）・`replayUnrouted(storeCode)`（再生の手続き）。「宛先未解決」という概念境界を表す語として `Orphan` 系（`OrphanRecord`）も候補に含める。
- **Order_Path / Status_Path のリテラル**: 候補 `ORDER_RECORD_PATH = "/lio/order"` / `STATUS_RECORD_PATH = "/lio/status"`、既知集合を `KNOWN_RECORD_PATHS`。
- **失敗分類の型**: 候補 `RecordOutcome`（1 Record の処理結果）と、その種別 `"accepted"` / `"duplicate"` / `"poison"` / `"unknown-path"` / `"unrouted"`。Transient_Failure は結果ではなく throw / 5xx で表すため種別に含めない案（不正な状態を表現不能にする）と、`"transient"` を含めて呼び出し側に分岐させる案のどちらを採るかを設計で判断する。
- **観測カウンタ（8 つ）**: `poisonRecord` / `unknownPath`（上流と同名・確定）、`statusDiscarded` / `unknownStorePending` / `doDedupeSkipped` / `upstreamContractViolation` / `unauthorized` / `deactivatedStore`（本経路固有・候補）。`upstreamContractViolation` は上流にカウンタが存在しない事象を数えるため同名にできない（Requirement 12.7）。出力先は構造化 `console.log` で確定（Requirement 12.11）。
- **Upstream_Contract_Violation の型**: 候補 `UpstreamContractViolation`（保留の理由を表す種別）。Requirement 11 の `UnroutedRecord` と保留領域を共有するかは設計判断であり、共有する場合は保留理由を判別できる形を要する（Requirement 8.11）。
- **`PendingOrder.slotSpan`**: 確定（ユーザー承認済み）。1 品目がスロット軸上で占める幅。`slotIds` と対を成す名として選んだ（`slotCount` のような汎用語を避ける）。`PendingOrder` の新しい共有事実であり、`TimerFact` には及ばない。
- **麺量から `slotSpan` への翻訳（純粋関数）**: 候補 `toSlotSpan(childItems, table)` / `slotSpanOf(...)`。茹で対象の判定と同一の入力から導くため、判定と翻訳を 1 つの関数で返す形（`Noodle_Size` を見つけて `slotSpan` を返し、無ければ `null`＝茹でない）も候補とする。後者なら「判定基準が 2 箇所に分かれない」ことが構造で守られる。
- **`StoreConfig` に足す対応表（2 枚・分けて持つ）**: いずれも外部から注入する（AC 6.20・6.21）。
  - 硬さ: 候補 `firmnessCodes`（硬さの商品コード → `Firmness`）。**茹で秒は持たない**——秒は既存 `noodlePresets` が `noodleType` × `firmness` で保つ唯一の出所である（AC 6.21）。
  - メニュー: 候補 `menuItems: readonly { productCode; noodleType; sizes: readonly { code; slotSpan }[] }[]`。メニュー 1 件がサイズ 3 件を伴う組で増えるため、その組を 1 エントリとして表す形を要する。
  
  既存 `noodlePresets`（麺種 → 茹で時間）には畳まず別フィールドとして立てる案を推す——`noodlePresets` は厨房の語彙（麺種と茹で時間）、上の 2 枚は POS の語彙（商品コード）であり、更新の契機も異なる（麺の種類が増えたときと、メニューが増えたとき）。`StoreConfig` を拡張するため per-store-provisioning の検証（`validateProvisioningInput`）にも対応する項目が要る。
- **既存語彙の再利用**: `PendingOrder` / `toPendingOrders` / `ORDER_INGRESS_TOKEN` / `isOrderIngressAuthorized` / `CODE_INDEX_KEY` / `IDENTITY_HEADER` / `StoreRegistryDO` / `StoreTimerDO` はそのまま用いる。
