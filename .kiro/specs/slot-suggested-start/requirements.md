# Requirements Document

## Introduction

本 spec は、開始推奨（Cook_Recommendation）の提示場所を待ち行列の帯から**空いている釜のカード**へ移し、その場から**注文品目を指して開始する**操作を定義する。あわせて、その操作が「どのオーダーを茹で始めるのか」を現場が読めるよう、POS が申告する商品名を Pending_Order の事実として取り込む。

推奨は `online-cook-scheduling`（Requirement 8）が定義したとおり**提案であって指示ではない**。本 spec はその立場を変えない。変えるのは提案が**どこに現れ、どう押され、押したとき何が送られるか**の 3 点である。

現状は 3 つの嘘を抱えている。(1) 提案は「Slot 0 · 21:15」と釜を番号で名指すが、画面の釜カードに番号は無い。(2) 提案ボタンは釜の状態にも推奨時刻にも関係なく押せ、埋まっている釜へ押すと 2 本目の Timer が既存の秒読みの裏に隠れて生まれる。(3) 提案からの開始は茹で秒を client が導いて送る一方で茹で加減を送らず、Timer は常に既定の茹で加減で作られる。本 spec はこれらを機構の追加ではなく、**提案の位置を開始できる場所と一致させ、client が言い直していた導出値をサーバの事実へ戻す**ことで消す。設計哲学（`design-philosophy.md`）の「真 — 導出値を状態に昇格させない」「美 — 引き算」の直接の帰結である。

### 観測事実（実装前に確認済み・2026-09-02）

1. （2026-09-03 再取材・#24 `pending-order-list-left-rail` 後）待ち行列は盤面左端の固定幅（`w-32`）の縦レール `src/client/components/OrderRail.tsx` になった。各行は麺種名、茹で加減と卓番、待ち時間（`formatRemaining` の `mm:ss`・`:111`）を示し、担当範囲内の提案がある行にはその下に開始ボタン（`:118-133`）が 3 行積みで `Suggested` / `Slot {n}` / `HH:MM`（`wallClock`）を描く。ボタンは `aria-label` を持たず、支援技術へ渡す名前は可視テキストから計算される（`:113-117`）。釜カード（`SlotCard.tsx`）はスロット番号を表示しない。
2. `OrderRail.tsx:15-17` は「スロットカードとの重畳は作らない」と明記し、理由を「boiled の釜へ提案が付くことがあり、カードの表示状態は既存の規律（running > boiled > idle）が決めたままにし、提案はこのレールの中だけに現れる」としている。
3. `src/engine/start.ts` の `startTimer` は釜の占有を検査しない。拒否事由は `InvalidBoilSeconds` / `InvalidSlotOrNoodle` / `CapacityExceeded` の 3 つで、走行中の釜への開始はそのまま通る。同ファイルのコメントは「拒否事由は増やさない（AC 8.3）」「開始済みの品目を再び開始する要求も拒否しない」と記す。
4. 手動の開始経路（ラジアル）は idle カードにしか現れない（`SlotCard.tsx:282-320`）。ゆえに手動経路は同一釜への重畳を一度も生まない。提案ボタンだけが釜の状態と無関係に押せる。
5. `src/client/components/slotDisplay.ts:70-77` は 1 釜に複数の走行中 Timer があれば最早 `endTime` の 1 本だけを描き、走行中を茹で上がりより優先する。埋まっている釜へ提案から開始すると、新しい Timer は描かれず、先行 Timer の茹で上がりも後続の秒読みの裏に隠れる。
6. 提案からの開始は `connection.start(slotIds, noodleType, boilSeconds, { externalOrderId, itemIndex })` を送る（`SlotBoard.tsx:107-113`）。`boilSeconds` は `queueDisplay.ts` の `boilSecondsOf` が `noodlePresets` × `order.firmness` から client 側で導いた値である。ワイヤの `start` に茹で加減は無く、`startTimer` は `firmness: DEFAULT_FIRMNESS` で Timer を作る（`start.ts:118`）。
7. サーバは開始に要る事実をすべて持つ。`state.pendingOrders` の品目は `noodleType` / `firmness` / `slotSpan` / `tableId` を持ち、`SettleParams.noodlePresets` が `noodleType × firmness → boilSeconds` を保つ。
8. `recommend`（`src/engine/recommend.ts:44`）は確定計画の**全品目**を slot と `startAt` 付きで計画順に配る。担当範囲での絞り込みは client（`queueDisplay.ts`）が行う。ゆえに 1 釜に複数の推奨が時系列で並びうる。
9. `PendingOrder`（`src/domain/order.ts`）と `MenuItem`（`src/domain/store.ts:239`）はいずれも商品名を持たない。`src/ingress/noodle-spec.ts` は冒頭で「POS の語彙（商品コード・商品名）は含まない」と宣言し、麺種・茹で加減・スロット幅の 3 事実だけを返す。
10. 実 POS ペイロード（2026-09-02 にユーザー提示）は `order_items[].item_name`（例 `"プレ塩"`）と、麺量の child（`s_class_code: 65`）の `item_name`（例 `"中盛"`）を持つ。半角カナ（`"ﾈｷﾞ丼"`）も現れる。`docs/pos-records-ingress-api.md` の例と `pos-order-ingress` spec には `item_name` が現れず、同 spec の判断記録「麺の仕様を POS が名前付きで送るか → 送らない」は麺種・硬さの話であって商品名の話ではない。
11. `src/ingress/declared-text.ts` の `readDeclaredText` は Unique_Key の 4 要素専用の関門で、「読めなければ毒」の境界である。冒頭コメントは 4 要素以外へ広げないことを明記する。
12. 永続スキーマは `CURRENT_SCHEMA_VERSION = 8`（`src/engine/types.ts:42`）。`revivePendingOrder`（`src/engine/migrate.ts:149`）は形だけを検証し、`orderItem` は v7 で欠如を `null` に畳んで追加された前例がある。
13. `src/client/connection.ts:440-453` の `config` 分岐は `unitCount` と `noodlePresets` だけをビューへ写し、`menuItems` は「読み手が無い」として捨てている。本 spec の後もこの読み手は生まれない（商品名の出所は設定ではなく POS 申告値である）。
14. idle カードは上部に直前結果のバッジ、下部に丸い Start ボタンとその下の `Start` ラベルを持つ（`SlotCard.tsx:290-318`）。カードの操作は running / boiled でも「丸ボタン＋下のラベル」の一語彙で統一されている。
15. （2026-09-03 追記）`verified-wire-contract` は #25 として main にマージ済みである。ワイヤ復号は `src/domain/wire.ts` の `toClientMessage` / `toServerMessage` に集約され、`start` の品目参照の組は `toStartMessage`（`wire.ts:101-112`）が成す。shell は `store-timer-do.ts:1047-1050` で復号済みの 2 フィールドを Event の `orderItem` へ写す 2 行の射影だけを持ち、`messages.ts:40-43` のコメントは本 spec が optional を撤去することを前提に書かれている。`connection.start` の 4 番目の引数 `orderItem?`（`connection.ts:673`）が client 側の出口である。
16. ワイヤ種別集合を固定する検査が 4 本ある。`tests/offline-degradation.static.test.ts:101` / `tests/sync-set-batch-complete.static.test.ts:84` / `tests/observe/static-analysis.example.test.ts:58` の `WIRE_MESSAGE_TYPES`（7 種）と、`tests/operation-history/no-wake.static.test.ts:319` の `toClientMessage` の `case` 集合（4 種）。`grep -l WIRE_MESSAGE_TYPES` は `tests/static/wire-no-cast.test.ts` も返すが、それはコメントでの言及であり検査を持たない。往復 PBT の生成器 `tests/domain/wireGenerators.ts:131` は ClientMessage 4 種を分布し、`start` を「組あり／組なし」の 2 形で出す。
17. `src/domain/predicate.ts` の `isNonEmptyString` が「非空文字列か」の唯一の述語である。判断 9 の「欠落・空文字・型違いは `null`」はこの 1 本で書ける。
18. ワイヤ側の `PendingOrder` は `wire.ts:190-210` の `toPendingOrderFromWire` が確立し、`tableId` は `toTableId`（`:64-67`）が「欠落・`null` は `null`、非空文字列はその値、空文字・文字列以外は Decode_Failure」で見る。ServerMessage 側は Element_Validator の正規化条件を含む政策（`verified-wire-contract` 要件 2.4）であり、取り込み側の Pass_Through（判断 9）とは義務が違う。
19. `src/engine/start.ts:91-92` のコメント「拒否事由は増やさない（AC 8.3）」「開始済みの品目を再び開始する要求も拒否しない」は、判断 7 の新しい拒否 code を足した時点で偽になる。

### 確定した設計判断（すべて本要件へ演繹する）

1. **提案は idle の釜カードにだけ現れる。** running / boiled のカードには何も出さない。釜が空けば同じ情報がその場に現れるため先出しは重複であり、再評価で揺れる予告を見せない。観測事実 2 の「重畳規則を持ち込まない」は、規則を「idle カードは次に入るものを 1 件持つ」の一文にすることで満たす。
2. **開始できる場所と提案が見える場所を同じ集合にする。** 提案からの開始の口は idle カードにしか存在しないため、提案経由の同一釜への重畳（観測事実 3〜5）は client 側の防御ではなく構造で起きなくなる。engine の占有検査は導入しない（端末間の競合はスコープ外に記録する）。
3. **配置は Start の左に同形の丸ボタン。幅が無ければ上。** 既存の「丸ボタン＋下のラベル」の語彙を保ち、区別は形ではなく塗り（麺種の色＝identity の既存規約）で付ける。左は押せば即開始（ラジアルを開かない）、右は従来どおりラジアル。丸が 2 つ並ぶ幅が無いカードでは提案が Start の上へ折り返す。提案の有無・折り返しの有無に関わらず、右の Start は位置を変えない。
4. **釜ごとの提案は startAt 最小の 1 件。** 当該釜を `slotIds` に含む推奨のうち最早の `startAt` を持つものを「次」として導出する（観測事実 8）。複数釜にまたがる推奨は含まれる各釜のカードに現れ、どのカードから押しても推奨の `slotIds` 全体で開始する。
5. **時期は相対で示し、固定文言は英語にする。** `startAt` と補正済み現在時刻の差から `now`（`startAt ≤ now`）または `in mm:ss` を導出する。壁時計 `HH:MM` は用いない。`startAt` 到来前でも押せる（AC 8.2 / 8.3 を変えない）。卓は `Table {n}`。カードの固定文言を英語にするのは、#24（`pending-order-list-left-rail` 要件 3.9）がレールの固定文言を英語に固定し、カードの操作ラベルも `Start` / `Cancel` / `Complete` であるためで、日本語の固定文言はカードにも置かない。調理母語（硬さ）だけが `FIRMNESS_LABEL` 経由で入る。
6. **開始は品目を指す。** 新しい ClientMessage 種別で `slotIds` と品目の鍵（`externalOrderId` / `itemIndex`）だけを送る。`noodleType` / `firmness` / `boilSeconds` は送らない。engine が `pendingOrders` の当該品目と `noodlePresets` から導く（観測事実 6・7）。既存 `start` からは optional の `externalOrderId` / `itemIndex` を撤去し、アドホック麺茹で専用に戻す。
7. **品目が待ち行列に無ければ拒否する。** 指した品目が `pendingOrders` に無いとき engine は麺種を導けないため、新しい拒否 code で要求元へ返す。これは AC 8.3「推奨との不一致を理由に拒否しない」の例外ではなく別の事実である——同 AC が守るのは現場の選択であり、他端末が直前に開始した品目の二重調理ではない。`start.ts` の「開始済みの品目を再び開始する要求も拒否しない」はアドホック経路にのみ残る。
8. **商品名は POS 申告値を事実として持つ。** `PendingOrder` に親品目の `item_name` と麺量 child の `item_name` を足す（観測事実 10）。設定（`MenuItem`）に名前表は設けない。伝票の文字列と釜の画面の文字列が同じ出所になり、投入漏れも改名のズレも起きない。
9. **名前も素通しする。** 取り込み（POS_Ingress）では欠落・空文字・型違いは `null` に畳み、Record を拒否しない。`readDeclaredText` は用いない（観測事実 11 の境界を守る）。読む場所は麺量 child を同定している唯一の場所（`noodle-spec.ts`）とし、冒頭の「商品名は含まない」の宣言を改める。**ワイヤ側は別の義務を持つ**——`toPendingOrderFromWire` は `tableId` と同じ関門の形（観測事実 18）で 2 項目を確立し、空文字・文字列以外は Decode_Failure とする。取り込みが `null` へ畳んでいる以上、サーバが空文字を送ることは無く、送ればそれは自分の不具合である。二つの政策ではなく、取り込みと復号の義務の違いである。
10. **保存は生のまま、整形は導出。** 半角カナ等の正規化（NFKC）は表示時に行い、永続値は申告値のままとする。
11. **Timer には名前を持たせない。** 走行中カードへの名前表示はスコープ外とする（`Timer` / `TimerFact` / migrate に及ぶため）。開始の時点で品目が読めれば本 spec の目的は満たされる。
12. **待ち行列の帯は事実の一覧として残る。** ボタンだけを失い、商品名・茹で加減・卓・待ち時間を示す。提案の無い品目（計画対象外・他ユニット担当）もここで読める。
13. **`verified-wire-contract` に追随する（順序は解消済み）。** 同 spec が #25 として先に着地した。本 spec は `toClientMessage` に種別を 1 つ足し、`toStartMessage` から品目参照の組を撤去し、shell の射影と `connection.start` の 4 番目の引数を消す（観測事実 15）。種別集合を固定する検査 4 本と往復生成器（観測事実 16）は 8 種（ClientMessage 5 種）へ更新する。同 spec の Requirement 5.1「7 種の種別集合を変更しない」は同 spec 自身の不変点であり、本 spec がそれを改める。復号器の形は変えない——新種別は同じ関門に `case` を 1 つ足すだけで、cast 不在・メッセージ単位の粒度・Decode_Failure の記録はそのまま効く。
14. **ラベルの行数は固定しない。** 商品名は「特味噌ネギラーメン」のように長く、省略記号で切れば注文を取り違える。既存 `NoodleBadge` の方針（折り返す）に揃え、ラベルは内容の順（商品名と麺量、茹で加減、卓、時期）だけを定める。行数の上限は置かない。
15. **degraded では提案を出さない。** Requirement 3.11 が degraded で要求を送らないと定める以上、押せる提案を出せば「押しても何も起きない」無音の失敗になる。推奨は snapshot 由来で degraded 中は鮮度も保証されない。出さないのが、サーバが知らない品目の消費を見せないという 3.11 の立場と同じ帰結である。
16. **直前結果のバッジと提案は同居する。** バッジはカード上部、提案とラジアルはカード下部（`actionStack`）で場所を取り合わない。優先も排他も設けず両方残す。直前結果は「この釜で何を茹でたか」、提案は「次に何を入れるか」で意味が衝突しない（design で確定）。
17. **品目不在の拒否は警告帯に出す。** `connection.ts` の `error` 分岐は `TimerNotFound` だけを黙らせており、理由は「意図は達成されている」である。品目不在は意図（この品目を茹でる）が達成されていないため黙らせる側に入れない。決定は「`error` 分岐を触らない」であり、新しい code は既定で警告帯に出る（design で確定）。

### スコープ外

- engine による釜の占有検査（端末間の競合で同一釜へ 2 本目が立つ経路は残る）。導入するなら AC 8.3 の改訂を伴う独立の判断である。
- 走行中 / 茹で上がりカードへの商品名表示（`Timer` の形に及ぶ）。
- 推奨の理由（卓同期・オーダー同期）のワイヤ配信。卓番号の表示で現場が自力で読める範囲に留める。
- 設定（`StoreConfig.menuItems`）への表示名の追加。
- 押した釜数と `slotSpan` の不一致の拒否（現場の判断に委ねる既存の立場）。
- 待ち行列の帯の並び順・件数の変更。

### tasks へ落とす作業項目

- `src/engine/start.ts:91-92` のコメントを「アドホック経路（`start`）では拒否事由を増やさない」に書き換える（観測事実 19）。判断 7 の「アドホック経路にのみ残る」をコードの言葉にする。
- `src/domain/messages.ts:40-43` の「`slot-suggested-start` が品目参照を別種別へ移す」というコメントは、本 spec で optional が消えた時点で役目を終えるため撤去する。
- `verified-wire-contract/requirements.md:156`（要件 5.1「7 種の種別集合を変更しない」）に、本 spec が 8 種へ改めた旨を追記する。二つの spec が矛盾したまま残らないようにする。
- `tests/domain/wireGenerators.ts` の `genPendingOrder` に Item_Name / Size_Name（`null` と非空文字列の双方）を足し、往復 PBT が 2 項目を踏むようにする。

### naming ゲート（`naming.md`）

以下は公開シンボルであり、**実装前にユーザー確認を要する**。本 spec 内の表記は候補である。

| 候補名 | 場所 | 表明する概念境界 |
| --- | --- | --- |
| `startOrderItem` | `ClientMessage` の `type` | 注文品目を指す開始。`start` はアドホック麺茹で専用に戻る |
| `startOrderItem(slotIds, orderItem)` | client の `TimerConnection` | ワイヤと同じ語。`start` の 4 番目の optional は消える |
| `StartOrderItem` | engine の `Event` | 品目から麺種・茹で加減・茹で秒を引く遷移 |
| `OrderItemNotFound` | engine の `Rejection.code` | 指した品目が待ち行列に無い |
| `itemName` / `sizeName` | `PendingOrder` | POS 申告の商品名（親）と麺量名（child）。欠落は `null` |
| `next` | `SlotDisplay`（idle）の項目 | この釜に次に入る提案 1 件（`QueueSuggestion` をそのまま載せる） |

## Glossary

- **Cook_Recommendation（推奨）**: `online-cook-scheduling` が定義した「次に開始すべき Pending_Order・slot・開始タイミング」の提示。ワイヤ上は `CookRecommendation`（`externalOrderId` / `itemIndex` / `slotIds` / `startAt`）。指示ではなく提案である。
- **Next_Suggestion（次の提案）**: 本 spec が導入する導出概念。ある idle の釜について、その釜を `slotIds` に含む Cook_Recommendation のうち `startAt` 最小の 1 件に、開始に要る茹で秒を添えたもの。ビューに保持せず毎描画導出する。
- **Slot_Card**: 担当スロット 1 つの表示・操作 UI（`SlotCard.tsx`）。idle / running / boiled / unreceived の 4 相を持つ。
- **Idle_Slot**: 同期済みで駆動する Timer が無い釜。手動開始（ラジアル）の唯一の入口であり、本 spec で Next_Suggestion の唯一の提示場所になる。
- **Suggested_Start（提案開始）**: Idle_Slot に置く操作。押すと Next_Suggestion の品目を推奨の `slotIds` で開始する。
- **Order_Item_Start（品目からの開始）**: 注文品目の鍵と釜だけを送り、サーバが品目の事実から Timer を作る開始経路。アドホック麺茹で（`start`）と対をなす。
- **Ad_Hoc_Start（アドホック麺茹で）**: POS を経ず麺種を選んで茹でる既存 `start` 経路。Pending_Order と紐づかない。
- **Order_Rail（待ち行列のレール）**: 未着手オーダーを到着順に並べる盤面左端の縦レール（`OrderRail.tsx`・`pending-order-list-left-rail`）。本 spec 後は事実の一覧のみを担う。
- **Item_Name / Size_Name**: POS が `order_items[].item_name` / 麺量 child の `item_name` として申告する文字列。Pending_Order の事実。欠落は `null`。
- **Pass_Through（素通し原則）**: `pos-order-ingress` Requirement 14。payload の中身を拒否事由にしない。
- **Corrected_Now（補正済み現在時刻）**: client の実時刻にサーバとのオフセットを加えた時刻。残り秒と同じ導出の基準。
- **Timer_Connection**: client の接続コントローラ（`TimerConnection` / `openTimerConnection`）。UI の意図を Mode で経路選択する唯一の窓口。

## Requirements

### Requirement 1: 提案は空いている釜のカードに現れる

**User Story:** As a 厨房スタッフ, I want 次に何を入れるかが空いている釜の上に見える, so that 番号を探さず、目の前の釜で判断できる。

#### Acceptance Criteria

1. WHEN ある担当スロットが idle として導出され、その釜を `slotIds` に含む Cook_Recommendation が存在し、かつ Timer_Connection が degraded Mode でない, THE Slot_Card SHALL 当該釜の Next_Suggestion を表示する
2. THE Next_Suggestion SHALL 当該釜を `slotIds` に含む Cook_Recommendation のうち `startAt` が最小のもの 1 件から導出される
3. WHILE 担当スロットが running または boiled または unreceived であるか、Timer_Connection が degraded Mode である, THE Slot_Card SHALL 提案を一切表示しない（情報もボタンも出さない・判断 15）
4. IF Cook_Recommendation の対象品目が待ち行列に無い、または麺種が現在の `noodlePresets` に無い, THEN THE Slot_Display SHALL 当該推奨から Next_Suggestion を導出しない（既存 `boilSecondsOf` の条件を保つ）
5. WHERE 1 件の Cook_Recommendation が複数の釜を `slotIds` に含む, THE Slot_Card SHALL 含まれる各 idle 釜に同じ Next_Suggestion を表示する
6. THE Slot_Display SHALL Next_Suggestion をビューの状態として保持せず、受信済みの推奨・待ち行列・プリセット・Corrected_Now から毎描画導出する
7. THE Order_Rail SHALL 提案の開始ボタンを持たない

_出所: 判断 1・2・4・12・15, 観測事実 1・2・5・8_

### Requirement 2: 提案からの開始操作

**User Story:** As a 厨房スタッフ, I want 提案を一度押せばその品目がその釜で始まる, so that 麺種と硬さを選び直さずに済む。

#### Acceptance Criteria

1. WHEN Idle_Slot に Next_Suggestion がある, THE Slot_Card SHALL 既存の Start ボタンの左に Suggested_Start の丸ボタンを配置する。丸が 2 つ並ぶ幅が無いときは Start の上へ折り返す
2. THE Suggested_Start ボタン SHALL 既存の Start ボタンと同じ形（丸・同じアイコン）を持ち、塗りを当該品目の麺種の色とする
3. THE Slot_Card SHALL Suggested_Start の下のラベルに商品名（Item_Name と Size_Name）・茹で加減・卓（`Table {n}`）・時期をこの順で表示し、行数を固定しない
4. THE Slot_Card SHALL 時期を Corrected_Now と `startAt` の差から導出し、`startAt ≤ Corrected_Now` なら `now`、それ以外なら残りを `in mm:ss` で表示する。固定文言は英語とし、日本語の固定文言を置かない（判断 5）
5. THE Slot_Card SHALL 時期を壁時計（`HH:MM`）で表示しない
6. WHEN ユーザーが Suggested_Start を押す, THE Timer_Connection SHALL Next_Suggestion の品目の鍵と、当該推奨の `slotIds` 全体で Order_Item_Start を要求する
7. WHEN ユーザーが Suggested_Start を押す, THE Slot_Card SHALL ラジアルメニューを開かない
8. WHEN `startAt` が Corrected_Now より未来である, THE Slot_Card SHALL Suggested_Start を押せる状態に保つ（推奨時刻の到来を待たせない・AC 8.3）
9. WHEN Next_Suggestion が無い, THE Slot_Card SHALL 既存の Start ボタンを Next_Suggestion がある場合と同じ位置に保つ
10. THE Slot_Card SHALL Suggested_Start の aria-label に提案であること・品目・釜・時期を含め、命令形の文言を用いない（AC 8.2）。レールのボタン（`OrderRail.tsx:113-117`）が aria-label を持たないのは可視テキストがボタンの子であるためで、丸ボタンはラベルが兄弟要素（`SlotCard.tsx:305-318` の `actionStack`）ゆえ名前を明示しなければ AT に何も渡らない。方針の違いではなく DOM 構造の違いである
11. WHEN ユーザーが Suggested_Start を押す, THE Slot_Board SHALL 既存の Start と同じ Touch_Cue を鳴らす
12. WHILE Timer_Connection が degraded Mode である, THE Slot_Card SHALL Suggested_Start を表示しない（押しても要求を送らない操作を出さない）

_出所: 判断 3・5・14・15・16, 観測事実 14_

### Requirement 3: 品目からの開始（Order_Item_Start）

**User Story:** As a システム, I want 開始要求が「どの品目をどの釜で」だけを運ぶ, so that 麺種・茹で加減・茹で秒という事実をサーバが一箇所から導ける。

#### Acceptance Criteria

1. THE ClientMessage SHALL Order_Item_Start の種別を持ち、その内容を `slotIds`・`externalOrderId`・`itemIndex` の 3 項目とする
2. THE Order_Item_Start SHALL `noodleType` / `firmness` / `boilSeconds` を運ばない
3. WHEN サーバが Order_Item_Start を受ける, THE engine SHALL `pendingOrders` から当該品目を引き、その `noodleType` と `firmness` を Timer に写し、`boilSeconds` を `noodlePresets` の `noodleType × firmness` から導く
4. WHEN Order_Item_Start が受理される, THE engine SHALL Timer を生成し、当該品目を Pending_Order 集合から除き、これを再計算の契機とする（AC 8.4 と同じ帰結）
5. IF 指した品目が `pendingOrders` に無い, THEN THE engine SHALL 状態を変更せず、品目不在の拒否 code を要求元へ返す
6. IF 当該品目の `noodleType` が `noodlePresets` に無い, THEN THE engine SHALL 状態を変更せず、既存の `InvalidSlotOrNoodle` で拒否する
7. THE engine SHALL Order_Item_Start に対して釜の占有・推奨との一致・`slotIds` の数と `slotSpan` の一致を検査しない（AC 8.3）
8. THE engine SHALL Order_Item_Start の受理時に既存 `start` と同じ Effect 列（`Persist` 先頭・`SetAlarm`・`Broadcast(snapshot)`）を生成する
9. THE ClientMessage の `start` SHALL `externalOrderId` / `itemIndex` を持たず、Ad_Hoc_Start 専用となる
10. WHEN Ad_Hoc_Start（`start`）が受理される, THE engine SHALL 従来どおり Pending_Order 集合に触れない
11. THE Timer_Connection SHALL degraded Mode で Suggested_Start の要求を送らず、ローカルにも Timer を立てない（サーバが知らない品目の消費を見せない・既存 `start` の degraded 分岐と同じ立場）

_出所: 判断 6・7・17, 観測事実 3・6・7_

### Requirement 4: 商品名を事実として取り込む

**User Story:** As a 厨房スタッフ, I want 伝票に印字された商品名がそのまま釜の画面に出る, so that どのオーダーを茹でるのか迷わない。

#### Acceptance Criteria

1. THE Pending_Order SHALL Item_Name と Size_Name を持ち、それぞれ非空文字列または `null` とする
2. WHEN POS_Ingress が茹で対象の品目を Pending_Order へ写す, THE POS_Ingress SHALL 親品目の `item_name` を Item_Name に、`slotSpan` を決めた麺量 child の `item_name` を Size_Name に写す
3. IF `item_name` が欠落・`null`・空文字・文字列以外である, THEN THE POS_Ingress SHALL 当該名を `null` とし、Record も品目も拒否しない（Pass_Through）
4. THE POS_Ingress SHALL Item_Name / Size_Name の読み出しに `readDeclaredText` を用いない
5. THE POS_Ingress SHALL Item_Name / Size_Name を申告値のまま保存し、正規化・トリム・全角化を行わない
6. THE 翻訳（`noodle-spec.ts`） SHALL 麺量 child の同定を一度だけ行い、`slotSpan` と Size_Name を同じ同定結果から取る
7. THE `docs/pos-records-ingress-api.md` の例 SHALL `item_name` を親品目と child に含める
8. THE `pos-order-ingress` の AC 6.26 SHALL Item_Name / Size_Name の出所を出所表に加える

_出所: 判断 8・9・10, 観測事実 9・10・11_

### Requirement 5: 商品名の表示

**User Story:** As a 厨房スタッフ, I want 提案と待ち行列で同じ商品名が読める, so that 帯と釜を見比べても同じものを指していると分かる。

#### Acceptance Criteria

1. THE Slot_Card SHALL Suggested_Start のラベルに Item_Name と Size_Name を並べて表示する
2. THE Order_Rail SHALL 各行に Item_Name と Size_Name を表示する
3. IF Item_Name が `null` である, THEN THE 表示 SHALL `noodleType` を代わりに用いる
4. IF Size_Name が `null` である, THEN THE 表示 SHALL 麺量の表示を省く
5. THE 表示 SHALL Item_Name / Size_Name を NFKC 正規化してから描く（半角カナを全角へ）
6. THE Order_Rail SHALL 卓を省略記号で切らずに表示する
7. THE 表示 SHALL 商品名を省略記号で切らず、既存 `NoodleBadge` と同じ方針で折り返し、行数の上限を置かない

_出所: 判断 10・12・14, 観測事実 1・10_

### Requirement 6: 永続とワイヤの互換

**User Story:** As a 運用者, I want この変更が既存の永続データと設定を壊さない, so that デプロイの前後で待ち行列が失われない。

#### Acceptance Criteria

1. THE engine SHALL 永続スキーマの版を 8 から 9 へ上げる
2. WHEN 版 8 以前の永続値を読む, THE migrate SHALL Pending_Order の Item_Name / Size_Name の欠如を `null` に畳み、当該品目を落とさない
3. THE snapshot メッセージ SHALL `pendingOrders` に Item_Name / Size_Name を含む（`PendingOrder` 型をそのまま運ぶ）
4. WHEN ワイヤ復号が `pendingOrders` の要素を確立する, THE `toPendingOrderFromWire` SHALL Item_Name / Size_Name を `tableId` と同じ関門の形で見る——欠落・`null` は `null`、非空文字列はその値、空文字・文字列以外は Decode_Failure
5. THE 往復 PBT SHALL Item_Name / Size_Name が `null` の形と非空文字列の形の双方を分布する
6. THE config メッセージ SHALL 本変更で項目を増減しない
7. THE `StoreConfig` SHALL 本変更で項目を増減しない
8. THE Timer / `TimerFact` SHALL 本変更で項目を増減しない
9. THE Cook_Recommendation のワイヤ表現 SHALL 本変更で項目を増減しない

_出所: 判断 8・9・11, 観測事実 12・13・18_

### Requirement 7: 不変点

**User Story:** As a 設計者, I want 本変更が触れない範囲が明文である, so that 引き算が別の足し算を呼ばない。

#### Acceptance Criteria

1. THE 変更 SHALL `recommend` / `commit` / `schedule` の計画と推奨の導出を変更しない
2. THE 変更 SHALL Boil_Sync（`sync.ts` / `settle.ts`）を変更しない
3. THE 変更 SHALL Cook_Recommendation の到来時刻で Timer を自動開始する機構を導入しない（AC 8.2）
4. THE 変更 SHALL Alarm・`setInterval`・時刻起動の失効判定を導入せず、hibernation の適格性を保つ
5. THE 変更 SHALL running / boiled の Slot_Card の表示と操作を変更しない
6. THE 変更 SHALL 待ち行列の並び順（到着順）と件数の扱いを変更しない
7. THE 変更 SHALL 既存の拒否 code の意味を変更しない

_出所: 判断 1・11, スコープ外_

### Requirement 8: 契約変更と公開シンボルの確認

**User Story:** As a 設計者, I want 公開シンボルの追加が最小で、その名が概念境界を語る, so that 契約の変更が読める。

#### Acceptance Criteria

1. THE 変更 SHALL ClientMessage の種別を 1 つだけ追加する
2. THE 変更 SHALL ServerMessage の種別を追加しない
3. THE 変更 SHALL engine の Event 種別を 1 つだけ追加する
4. THE 変更 SHALL engine の拒否 code を 1 つだけ追加する
5. THE 変更 SHALL `PendingOrder` に項目を 2 つだけ追加する
6. THE 実装 SHALL naming ゲートの候補名を実装前にユーザー確認へ掛け、確定名を design.md の命名節に記録する
7. THE 変更 SHALL ワイヤ種別集合を固定する既存検査 4 本（観測事実 16）を 8 種へ更新し、往復 PBT の生成器が新種別を分布するようにする
8. THE 変更 SHALL `verified-wire-contract` が据えた関門の性質（cast 不在・メッセージ単位の Decode_Failure・両端の記録）を新種別にも適用し、復号を `toClientMessage` の外に書かない

_出所: 判断 13, 観測事実 15・16, naming ゲート_
