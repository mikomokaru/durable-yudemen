# Requirements Document

## Introduction

本 spec は、画面に出る品目の表示名を短くする。狙いは 2 つで、**麺量の既定を語から落とすこと**と、**長い商品名に短い札（Short_Name）を与えること**である。札は初出の商品名 1 件ごとに Workers AI へ考えさせ、機械検査に通ったものだけを辞書へ入れて以後それを使う。

現状、品目の語は `displayName`（`src/client/components/queueDisplay.ts:178`）が「商品名 ＋ 麺量名」で組み、4 箇所（レール・釜バッジ・ラジアルの帯・提案ラベル）が同じ語を受け取って置いている。実データの商品名は最長 11 字（`特味噌ラーメンAセット`）で、麺量は 6 割が `普通` である。一方レールの行に入るのは全角 6 字程度しかない。結果、レールは末尾を省略記号で切り、釜バッジと提案ラベルは折り返して縦に伸びる。

**これは表示だけの spec である。** 厨房の事実には一切触れない——`OrderItem` の形も永続スキーマ（v13）も `digest` も engine も registry も変えない。札は申告された商品名をキーに引く被せ物であり、名前の出所ではない。辞書が空でも、AI が落ちても、通信が無くても、画面は現状どおり全名で動き続ける。

**札はワイヤに載って品目とともに届く**（2026-09-15 方針変更）。client は辞書を持たず、受け取った品目の `shortName` が在ればそれを表示し、無ければ全名へ戻す。辞書を引くのはサーバ側だけである。

**札の一意性は保証しない。** 異なる商品が同じ表示になりうることを承知のうえで受け入れる（判断 7）。区別は生成の指示（プロンプト）で図り、機械検査は「元の名前から文字を削っただけであること」の担保に限る。

### 観測事実（実装前に確認済み・2026-09-14）

1. 品目の語を組むのは `displayName`（`queueDisplay.ts:178`）ただ一つで、`(order.itemName ?? order.noodleType).normalize("NFKC")` に麺量名があれば空白区切りで添える。呼び出し元は `OrderRail.tsx:100`・`SlotBoard.tsx:250`（提案ラベル）・`SlotCard.tsx:463-468`（釜バッジ）・`RadialMenu.tsx:338` の 4 箇所。同ファイルのコメントは「語を組むのはここだけで、描画側は受け取った文字列を置くだけである」と規律を明記する。
2. `SlotCard.tsx:66` は「レール・釜カードの提案・ラジアルの待ち行列は同じ品目を同じ語で呼ぶ必要があり、代替と正規化の規則を描画側へ散らせば三つの真実になる」と書く。
3. 各箇所に入る全角文字数（iPad 全画面・レール表示時・実測値からの算出）。レール行は `w-32`（128px 固定・`OrderRail.tsx:44`）に `text-sm`（14px 固定・`:92`）で**約 6 字**、省略記号込みで実質 5.5 字、`↩`（中断済み）付きは 4.5 字。釜バッジはフォントが `clamp(1.0625rem, 6.4cqi, 1.4375rem)`（`SlotCard.tsx:284`）で、横向き（4 列）はカード幅が足りず 17px の下限に張り付き**約 8.4 字/行**（上がり順チップ込みの 1 行目は 6.5 字）、縦向きは約 14 字/行。ラジアルの帯は幅 128〜192px・`text-sm` で**約 11.9 字/行**。提案ラベルは `max-w-[min(9rem,60cqi)]` と `clamp(0.5625rem,1.2vh,0.6875rem)` で**約 11 字/行**（横）。
4. 溢れの扱いは箇所ごとに違う。レールだけが `truncate`（1 行・末尾省略・`OrderRail.tsx:92`、`pending-order-list-left-rail` AC 3.5）で、釜バッジ（`SlotCard.tsx:283`）・ラジアル・提案ラベル（`:111`）は折り返す。`slot-suggested-start/design.md:144`（判断 14）は「**ラベルは折り返す。** 行数を固定しない。商品名を省略記号で切れば注文を取り違える」と明記する。
5. `src/engine/digest.ts:41` は「表示だけに効く申告名（`itemName` / `sizeName`）と厨房の事実（`completedAt` / `interruptedAt`）は含めない」として、申告名を計画要求の同一性から外している。
6. `OrderItem`（`src/domain/order.ts`）は `itemName` / `sizeName` を持ち、**商品コードを持たない**。同ファイル `:60` は「設定に名前表を設けず申告値を持つのは、伝票の文字列と釜の画面の文字列を同じ出所にするためである。表を別に持てば投入漏れと改名のズレが起きる」と理由を書く。`slot-suggested-start/requirements.md:42`（判断 8）が同じ判断の出所で、同 `:58` は「設定（`StoreConfig.menuItems`）への表示名の追加」をスコープ外と名指しする。
7. 永続スキーマは `CURRENT_SCHEMA_VERSION = 13`（`src/engine/types.ts`）。`itemName` / `sizeName` は v9 で追加され、欠如は `null` で埋める。
8. 取り込み口は 2 本ある。`POST /pos/records`（POS_Ingress・取り込みの正本）は worker が生の券売機 payload を見る経路で、`plu_no` と `item_name` が同じ raw の中に並ぶ（`store-timer-do.ts:270` が既に `item_name` を読む）。`POST /s/{storeId}/orders`（Order_Ingress）は worker がボディを解釈せず DO へ転送する経路（`worker.ts:484-507`「ボディの解釈・検証・400 応答は店舗 DO の `receiveOrder` に閉じる」）で、ボディは翻訳済みの品目（`noodleType` / `firmness` / `slotSpan` / `itemName`・`wire.ts:215`）であり**商品コードを含まない**。`pos-order-ingress/requirements.md:361` は後者を「運用・試験用の経路として残す（POS からの取り込みの正本は本経路）」と決めている。
9. `StoreTimerDO` は自立性の不変（`store-timer-do.ts:337`・要件 6.1 / 6.2）により、レジストリへ一切越境せず、`STORE_REGISTRY_DO` バインディングも他 DO スタブも保持しない。設定は `applyProjection` の押し込みでのみ届く。
10. `wrangler.jsonc` の `assets.run_worker_first` は**許可リストであって既定への追加ではない**。同ファイルは「列挙しなかったパスはアセット扱いになり、アセットに一致しなければ SPA フォールバックが `index.html`（200）を返す——Worker には届かない」「`["/"]` だけを列挙していた間は `/s/{id}/ws`・`/admin/*`・`/pos/records`・`/entry/*` の全てが index.html に吸われた」と記録する。
11. `src/client/persistence.ts` は「接続が無い間は『知らない』を空で示し、hydration で受け直す」を永続の方針として明記し、待ち行列と推奨を永続しない。
12. **実 POS データ**（`docs/data_samples/kenbaiki_orders/*.jsonl` と `docs/data_samples/noodle_plan_histories/*.jsonl`・合計 2,219 行・`order_items` 6,289 件）。茹で対象の親品目名は distinct **48 件**、チェーン共通の対応表（`experiments/cpsat-workers/fixtures/local/pos-menu-policy.json` の `menuItems`）では **58 件**。長さは 4〜11 字（中央値 8.5）。上位 2 件（`特味噌ラーメン` 21%・`特味噌ネギラーメン` 13%）で 1/3 を占める。`item_name` の欠落・空文字は 0 件。
13. **麺種は 4 種しかない**（同 `menuItems`）。`REG` 51 件・`つけ` 3 件・`プレ` 3 件・`朝麺` 1 件。NFKC 正規化後に 9 字以上の親品目は **24 件で、その全部が `REG`**。非 `REG` の 5 件（`醤油つけ麺` 5 字・`味噌つけ麺` 5 字・`辛味噌つけ麺` 6 字・`朝ラーメン` 5 字・`新プレ塩` 4 字）はすべて 8 字以内である。
14. 麺量 child（`s_class_code == 65`）の申告名は **4 種のみ**。`普通` 61.7% / `中盛` 22.6% / `大盛` 14.0% / `半玉` 1.7%。親 1 件につき必ず 1 件付き、欠落は 0 件。
15. NFKC 正規化で表記が変わる親品目は **1 件だけ**（`旨辛ｽﾀﾐﾅﾗｰﾒﾝ` → `旨辛スタミナラーメン`）。他はすべて全角。親品目名に現れる非漢字・非カナは半角の `A` `B` `C`（セット名 15 件）のみ。
16. 同じ商品コードに複数の商品名が対応する例は **0 件**。同じ商品名が複数のコードを持つ例は **39 件**あり、いずれも同一商品の派生（`特味噌ラーメン` → `11411` 546 件 / `811411` 3 件）。接頭辞の規則は一定でない（`新プレ塩` は `116051` ↔ `811606`）。
17. **Workers AI のテキスト生成モデルで日本語対応を明記したものは存在しない**（統合カタログ 235 モデル中、"Japanese" の記載は埋め込みモデル `@cf/pfnet/plamo-embedding-1b` のみ）。JSON mode は `response_format` に `json_schema` を渡す形で使え、schema に沿わない場合は `JSON Mode couldn't be met` エラーが返り捕捉が必須。部分列・文字数のような制約は JSON Schema では表現できない。廃止ポリシーの文書は存在せず、実績は約 3 週間前告知、モデル ID が別モデルへ黙ってエイリアスされた前例がある（`kimi-k2.5` → `kimi-k2.6`・"higher price" と明記）。`@cf/zai-org/glm-5.3-flash` は有料の支払い方法が必須のモデル群に属する。
18. Workers KV の `list()` は各キーの `metadata` を返す（「the `name` of the key, and optionally the key's `expiration` and `metadata` values」）。1 回あたり最大 1,000 件で、続きは `cursor`。metadata の上限は 1,024 バイト、キー長の上限は 512 バイト、キー数は無制限。**KV は結果整合であり、読み取り→検査→書き込みを不可分にできない。**
19. 現行 `wrangler.jsonc` に `ai` binding は無く、KV namespace の binding も無い。secret は `ADMIN_TOKEN` / `ORDER_INGRESS_TOKEN` の 2 本で、`vars` には `PLANNER_BACKEND` / `CPSAT_ACTIVATION_ID` などが「省略で既定へ流れる形にすると、切り替えたつもりで動いていても気づけない」という理由で明示されている。
20. **root の生成 Env は `StoreTimerDO` の env でもある**（`store-timer-do.ts:345` の `class StoreTimerDO extends DurableObject<Env>`）。Workers に per-DO の binding スコープは無く、root の `wrangler.jsonc` に `ai` / `kv_namespaces` を書けば DO の env にもそれらが現れる。`wrangler.jsonc` 自身が「生成 Env 型に当該能力が現れないという形で設定構造が保証する」と記し、Operation History の `config-graph.static.test.ts` が「root は `r2_buckets` / `kv_namespaces` / `d1_databases` を持たない」を静的に閉じている（要件 1.9 / 4.10 / 4.13）。**能力を分けるには Worker を分けるしかない。**
21. **`ctx.waitUntil()` は HTTP 起点の Worker で応答後 30 秒までしか実行を延ばさない。** 期限内に解決しない Promise は**キャンセルされ**、Workers Logs に `waitUntil() tasks did not complete within the allowed time after invocation end and have been cancelled.` が出る。これを超える作業は Queue へ回すことが公式に推奨されている。

22. **永続とワイヤは同じ `OrderItem` を共有する。** `StoreSnapshot.orderItems`（`src/engine/snapshot.ts`）も `ServerMessage` の `snapshot`（`src/domain/messages.ts:100`）も `readonly OrderItem[]` である。ゆえに `OrderItem` に表示用の項目を足せば**永続スキーマが v14 になる**——ワイヤだけを変えるには、送信時に被せる別の形が要る。
23. **押し込みで受ける前例が 2 つある。** `StoreTimerDO` は設定を `applyProjection` で受け（`store-timer-do.ts:337`「pull せず push で受ける」）、外部計画を `deliverPlan` で受ける。後者の呼び手は Solver_Worker で、`wrangler.solver.jsonc` が `script_name: "yude-men-timer"` を付けた cross-script の DO binding を持つ（クラスの所有者は root ゆえ migrations はあちらに置かない）。**自立性の不変が禁じているのは pull であって push ではない。**
25. **`@cf/zai-org/glm-5.3-flash` は推論モデルである**（実測・2026-09-15・Yamaokaya アカウントで実行）。既定のままだと 1 件に **18,449ms・33.6 Neurons**（推論 1,730 文字）を要する。`chat_template_kwargs: { enable_thinking: false }` を渡すと **3,269ms・4.8 Neurons** になり、出力の質は変わらない。実データ 24 件を思考なしで流した結果は**全件が機械検査を通過**し、所要は最小 858ms・中央 1,399ms だが**裾が長く最大 26,569ms**（合計 68.0 Neurons）。
26. **既存の札を指示へ渡すと、重複が避けられる**（実測・2026-09-15）。`特味噌ネギ` を渡した `特味噌ネギラーメン` は `特味噌ラーメン` を、`味噌A` を渡した `味噌ラーメンAセット` は `味噌ラーメンA` を返し、いずれも部分列・8 字以内を満たした。無関係な札を渡しても出力は変わらない（安定）。避けるぶん札は長くなる。
24. **Durable Object は条件を満たせば約 10 秒の無活動で休眠し、メモリを失う**（WebSocket 接続は残る）。在メモリだけで保つ値は、閑散時ほど長く失われたままになる。

### 確定した設計判断（すべて本要件へ演繹する）

0. **札の能力は別 Worker に置く。** `AI` binding と `SHORT_NAMES`（KV）binding を持つのは `yude-men-short-names`（設定正本 `wrangler.short-names.jsonc`）だけで、root は service binding 1 本で中継する。root へ置けないのは観測事実 20 のためである。**保証の範囲を正確に言う**——閉じるのは「`StoreTimerDO` が **AI・KV の直接 binding** を持たない」ことであり、「札の機能へ一切到達できない」ことではない。root の `SHORT_NAMES_WORKER` は DO からも見える（`SOLVER` と同じ）。前者は生成 Env 型が閉じ、後者は `store-timer-do.ts` が参照しないという静的検査で見る。デプロイ順は**札用 Worker → root**（binding の指す service が実在しないと root の deploy が失敗する）。

   **札は札用 Worker から店舗 DO へ押し込む**（観測事実 23）。DO は辞書を**引かない**——引けば自立性の不変（pull しない）を破る。ゆえに札用 Worker が `STORE_TIMER_DO` への cross-script binding を持ち、`deliverPlan` と同じ形で押し込む。保証の言い方はこうなる——**DO は辞書を pull せず、AI と KV の直接 binding を持たない。** 押し込みを受けること自体は不変の中である。
1. **表示だけの spec である。** `OrderItem`・永続スキーマ（v13 のまま）・`digest`・engine・registry・`StoreConfig` のいずれにも触れない。札は観測事実 5 が申告名を計画の同一性から外しているのと同じ側に立つ。
2. **札のキーは NFKC 正規化後の親品目申告名である。** 商品コードを品目まで運ばない。運べば永続スキーマが v14 になり（観測事実 7）、engine・wire・migrate・同一性判定に及ぶ。名前をキーにすると副産物として 3 つが消える——同名別コード 39 件（観測事実 16）は同じキーに畳まれ、Order_Ingress 経由の品目（商品コードを持たない・観測事実 8）も札を引け、クライアントは `displayName` が既に持つ NFKC 済みの名前でそのまま引ける（観測事実 1）。失うのは「同じ名前の別商品を別の札にできる」ことだが、実データにその例は無い（観測事実 16）。
3. **判断 8（設定に名前表は設けない）を破らない。** 辞書は名前の**出所**ではなく、申告された名前を**キーに引く被せ物**である。伝票の文字列と画面の文字列が同じ出所であることは変わらず、辞書が空でも表示は成立する。`StoreConfig.menuItems` には何も足さない（観測事実 6）。
4. **札の上限は 8 コードポイント。** 表示幅ではなくコードポイントで数える——表示幅で数えると半角の `A` `B` `C` を含むセット名だけが長くなれる規則になり、レールの実測 6 字（観測事実 3）に対して読みづらい方向へ効く。
5. **8 字以内の名前には AI を呼ばない。** その場で「略さない」と決めて登録する。実データでは 48 件中 24 件がこれに当たり（観測事実 13）、AI 呼び出しが半減する。
6. **札は元の名前にある文字だけで組む（多重集合の包含）。** 文字を足さず、同じ文字を元名にある回数より多く使わない。**並び替えは許す**（2026-09-15 改訂・判断 33）。守っているのは「**元の名前に無い文字を使わせない**」ことであり、これが `特味噌` を `醤油` と言い換える取り違えを潰す芯である。同時に文字種の検査も吸収する。順序はその芯ではない——並び替えても出所の文字は変わらないので、別の商品の名を名乗ることはできない。
7. **札の一意性を保証しない。異なる商品が同じ表示になることを許容する。** 完全な防止には単一の書き手と強整合のストレージが要る——KV では読み取り→検査→書き込みを不可分にできず（観測事実 18）、別々の isolate が同時に同じ札を作れてしまう。ここに直列化の機構を建てるのは、得られる保証に対して重すぎると判断した。区別は**生成の指示**が担い、機械検査は「元の名前から削っただけであること」の担保に限る（判断 6）。**指示には既存の札の一覧を渡す**（2026-09-15 改訂・判断 30）——当初これを退けた理由（同じ商品の派生コードが機械的に別の札にされる）は、キーを商品コードから申告名へ変えた時点（判断 2）で消えていた。許容できると見る根拠は麺種の分布である——実データの麺種は 4 種で 51/58 が `REG`（観測事実 13）ゆえ、札が衝突する組はたいてい**麺・茹で秒・スロット幅が同一で、丼として交換可能**である。**これは許容の理由であって保証ではない。**
8. **麺量は AI を通さない固定表で表す。** `中盛` / `大盛` / `半玉` は**語のまま**出し（2026-09-15 改訂・当初は 1 文字へ畳んでいた）、`普通` だけ区切りごと落とす。`醤油中盛` / `味噌大盛` のように、現場が使う語のまま読める方を採る。4 語しかなく店舗によって変わらない（観測事実 14）。表に無い値は 1 文字に削らずそのまま出す——機械的に先頭 1 字を取ると `特盛`→`特` のように `特味噌` 系と紛らわしい札が生まれる。
9. **札と麺量の間に区切りを置かない。** `特味噌ネギ中`。麺量が 1 文字と決まっているので読み違えず、レールの 6 字に対して区切りの 1 字も惜しい。
10. **可視の 4 箇所すべてと `aria-label` に札を用いる。** 一部だけ略せば同じ品目が画面で二つの名を持つ（観測事実 2）。読み上げだけ全名にする非対称は置かない。
11. **人が札を書き換える経路を持たない。** 訂正の口も削除の口も作らない。**ただし恒久確定を約束もしない**——並行生成による上書き（後勝ち）は起こりうる（判断 12）。代わりに**なぜその札になったかを後から読めるようにする**（生成時刻・モデル ID・元の名前・落ちた候補を辞書の値に残す）。訂正の必要が現れたら、その時点で独立の判断として扱う。
12. **並行生成の上書きと、端末間の一時的な表示差を許容する。** 同じ名前に対する生成が複数の isolate で同時に走れば、後から書かれたエントリが残る。クライアントは起動時に一度しか辞書を取らない（判断 18）ため、取得時刻の違う端末が違う札を出している期間が生じる。どちらも正しい札であり、区別の役には立ち続ける。直列化も再取得も導入しない。
13. **失敗は「略さない」へ畳む。** 検査落ち・`JSON Mode couldn't be met`・AI 不達のいずれも、1 回だけ再試行してなお通らなければ `plain` として登録する。登録しなければ初出判定が毎回同じ名前を未知と見て AI を呼び続ける。
14. **生成には期限を置き、期限は `waitUntil` の寿命より手前に取る。** 観測事実 20 のとおり `waitUntil` は応答後 30 秒でキャンセルされる。AI の待機がこれを食い潰すと `plain` の保存に到達できず、同じ名前が毎回初出と判定されて AI を呼び続ける。ゆえに **AI の待機を打ち切る期限を設け、期限が来たら待つのをやめて `plain` の保存へ進む**。**期限は 2 段で持つ**——1 件あたりの上限と、**1 リクエストの全 Generation が共有する締切**である。`waitUntil` の寿命は呼び出し 1 回に対して与えられ、その中のすべての処理が共有するため、1 件あたりの上限だけでは初出が複数含まれるバッチ（新メニュー投入の朝）で後半の保存を守れない。保存そのものが失敗した場合、および締切に届かず着手できなかった場合はエントリが残らず次の出現で再検出されるが、これは許容する（余分な生成が増えるだけで、表示は全名のまま正しい）。
15. **「辞書に無い」と「略さないと決めた」は別の事実である。** 前者は「まだ考えていない」、後者は「考えた結果、略さない」。判別を持つ形（`{ kind: "short"; label } | { kind: "plain" }`）で表し、番兵文字列を使わない——札が `"NONE"` という商品と読める余地を作らない。
16. **押し込みとワイヤには `short` だけを載せる。** `plain`（考えた結果、略さない）は札を持たないので、押し込む対象にも品目の `shortName` にもならない——`plain` と「辞書に無い」は、受け手にとって完全に同じ挙動（全名を出す）である。判別が要るのは札用 Worker だけで、判別が要る場所にだけ判別を置く。
17. **辞書は名前ごとに 1 キーで KV に持つ。** 単一の値に畳むと、同時書き込みが他のエントリごと巻き戻す。名前ごとなら書き込みが独立し、巻き戻りは同じ名前の中に閉じる（判断 12 が許容する範囲）。全件は `list()` 1 回で読める（観測事実 18）——札は metadata に置き、値は監査の記録に使う。
18. **生成は取り込みを待たせない。** `POST /pos/records` の応答は生成の成否に一切依存せず、生成は `ctx.waitUntil` の中で走る。**初出の 1 杯は全名で出る。** これは壊れた状態ではなくフォールバックが正しく効いている状態である。
19. **初出の検出は `/pos/records` だけで行う。** Order_Ingress でボディを読むのは、worker を薄く保つ既存の規律（観測事実 8）を破る。Order_Ingress 経由の品目も、その名前が既に辞書にあれば札は出る——出ないのは「その名前が Order_Ingress にしか来たことがない」場合だけで、あの経路は運用・試験用である。
20. **client は辞書を持たない。** 取得も保持も受け渡しもしない——受け取った品目の `shortName` を置くだけである。HTTP で別系統の状態を取れば、WS 由来の事実と混ざって出所が読めなくなり、「辞書は来たが品目は来ていない」という中間状態も生まれる。**札を品目と同じ便に載せれば、その食い違いが構造的に無くなる。** 観測事実 11 の「接続が無い間は『知らない』を空で示し、hydration で受け直す」にもそのまま乗る——札は品目とともに来て、品目とともに消える。

24. **札はワイヤの品目に載せ、`OrderItem` には載せない。** 永続とワイヤは同じ `OrderItem` を共有する（観測事実 22）ので、あの型に足せば v14 になり engine が表示専用の項目を持つ。ゆえに**送信を組む時点で被せる**——ワイヤ側だけが `shortName` を持つ形にする。`digest` も `StoreSnapshot` も `migrate` も触らない。

25. **札は到着時刻で凍らない。** 送信のたびに引くので、札ができた瞬間から**既に待ち行列に在る品目にも**効く。取り込み時に品目へ焼き付ける形（v14 になる）を退けた理由でもある——あちらは札ができる前に届いた品目が永久に全名のままになる。
26. **札は DO 側で `StoreSnapshot` とは別のキーへ永続する。** 在メモリだけでは成り立たない——DO は約 10 秒の無活動で休眠してメモリを失い（観測事実 24）、復元されるのは**その商品が再び観測されたとき**だけなので、閑散時ほど札が消えたままになる。**「永続すれば必ず v14」は誤りだった**（2026-09-15 訂正）——`projection` と同じく別キーに置けば `CURRENT_SCHEMA_VERSION` にも `migrate` にも関わらない。

27. **被せる処理は 1 箇所に閉じ、通常の Broadcast と接続時の hydration の双方がそれを通る。** 二箇所で組めば「レールには札が出るのに、開き直すと全名」という食い違いが生まれる。

28. **押し込みで札が変わったときだけ、確定済みの状態をそのまま再送する。** 送信時に被せる形は「次に送るとき」しか効かず、状態が変わらない限り送信は起きない——接続中の画面が更新されない。再送するのは**既に確定した状態**であり、新しい遷移でも `Effect` でもない（`decide` を通らず `storage.put` も伴わないので、SSOT の規律はそのまま）。変わらなければ送らない。

29. **生成の要否と、観測店舗への配信は別の問いである。** 既知の名前でも押し込みの積荷には載せる——店舗 A で生成済みの商品を店舗 B が初めて観測したとき、生成を飛ばすだけでは B に札が永久に届かない。ゆえに在メモリの索引は**鍵だけの集合ではなく札を持つ辞書**であり、`generateShortName` は確定したエントリを返す。

21. **区別は生成の指示が担う。** 味の系統（醤油・味噌・特味噌・辛味噌・塩）・具（ネギ・チャーシュー・ネギチャー）・セット種別（A・B・C）・お子様向けなど、**商品を区別する文字を優先して残す**ようプロンプトで指示する。**機械検査には持ち込まない——これは技術的な制約ではなく方針の選択である。** 個々の文字が候補に残っているかは元名と候補だけで検査でき、辞書を要しない（辞書全体が要るのは他商品との衝突の判定だけである）。それでも足さないのは、多少の衝突を許容すると決めた以上（判断 7）、区別の度合いを機械が一律に裁く条件を重ねても守られる不変が生まれないためである。検査は「元の名前から削っただけであること」（判断 6）に限り、札の良し悪しはプロンプトへ預ける。
22. **モデル ID は `vars` に置く。** 観測事実 17 のエイリアス前例があり、直書きすると黙って別モデル・別価格に切り替わる。観測事実 19 の「省略で既定へ流れる形にしない」という既存の作法に乗せる。
30. **生成の指示に既存の札の一覧を渡す。** 一意性は依然として保証しないが（判断 7）、**起きにくくはできる**——実測で、衝突する札を渡した 4 ケースすべてが別の札を返した（観測事実 26）。追加の I/O は要らない：在メモリの辞書が既に札を持っている（判断 29）。避けるぶん札は長くなる（`特味噌ネギ` 5 字 → `特味噌ラーメン` 7 字）が、読めなくなるわけではない。**生成順に結果が依存する**のは事実だが、どの順でも「有効で互いに異なる札の割り当て」のどれかに落ちるだけで、欠陥ではない。

31. **推論を切って呼ぶ。** `glm-5.3-flash` は推論モデルで、既定のままだと 1 件 18.4 秒・33.6 Neurons を使う（観測事実 25）。`chat_template_kwargs: { enable_thinking: false }` で 3.3 秒・4.8 Neurons になり、出力の質は変わらなかった。**モデルを差し替えるときは、この指定が効くかを確認し直す。**

32. **待機の上限は実測から引く。** 中央 1.4 秒に対して**裾が 26.6 秒まで伸びる**（観測事実 25）。上限を中央値の近くに置くと、遅い商品が中断され——訂正の経路が無い以上（判断 11）——**恒久的に全名**になる。ゆえに裾を拾う側へ倒し、`waitUntil` の 30 秒に 2 回分と書き込みが収まるよう **1 リクエストで着手するのは 1 件**とする。収束は「当該商品の次の注文」に委ねる設計（判断 25）なので、1 件ずつでも成り立つ。

33. **札の作り方を指示で決める**（2026-09-15 追加）。`ラーメン` は**必ず省く**。`チャーシュー` / `チャーシューメン` は `チャー` と略すが、**名前にある具はどれも落とさない**（`塩ネギチャーシュー` → `塩ネギチャー`）。`Aセット` / `Bセット` / `Cセット` は**そのアルファベットを先頭へ移して**略す（`味噌ラーメンAセット` → `A味噌`）。**`お子様` と `ピリ辛` は略さずそのまま残す**（`お子様ラーメン味噌` → `お子様味噌`）。

   **具を落とす失敗は機械検査では捕まらない。** `塩ネギチャーシュー → 塩チャー` は 3 条件をすべて通るが、実在する別商品 `塩チャーシュー`（11331・7 字ゆえ全名で出る）と読み違える。札どうしの衝突ではなく「**札が別商品の全名に似る**」形なので、一意性の検査を戻しても捕まらない。直せるのは指示だけである（2026-09-15 に規則 5 を強めて解消・実測で 24 件すべて具が保たれた）。

   略さない語は**一覧として指示に書く**。機械検査には持ち込まない（判断 21 と同じ理由）——「この語を残したか」は元名と候補だけで検査できるが、多少の衝突を許容すると決めた以上、条件を重ねても守られる不変が生まれない。実測では `お子様` 3 件・`ピリ辛` 2 件のいずれも語が保たれた（`お子様味噌` / `お子様醤油` / `お子様塩` / `ピリ辛ネギ醤油`）。**実データの `ピリ辛` 3 件はいずれも 8 字以下で AI を通らない**ため、この規則は将来の名前に効く。

   **3 つ目のために部分列制約を多重集合の包含へ緩めた**（判断 6 の改訂）。`A味噌` は文字を並べ替えるので、順序を固定したままでは機械検査が弾き、該当する 15 件がすべて `plain`（全名）へ落ちる。緩めても「元名に無い文字を使わせない」という芯は残る。実測（2026-09-15・24 件）では **23 件が通過し重複は 0 件**、3 つの規則はいずれも効いた。落ちた 1 件は `塩ネギチャーシュー` に対する `塩葱?` で、**元名に無い文字（`葱` と `?`）を使ったため関門が捕らえた**——芯が働いていることの実例である。

23. **JSON mode を使う。** 素のテキストで受けると「はい、略称は『特味噌ネギ』です」のような前置きを剥がす処理が要り、その剥がし方が新しい真実になる。`JSON Mode couldn't be met` は検査落ちと同じ扱いにして経路を増やさない（判断 13）。

### 撤回した設計（2026-09-15）

- **client が辞書を HTTP で取得する形**（旧 Requirement 7）。`GET /display/short-names` と `src/client/shortNames.ts`（`fetchShortNames` / `SHORT_NAMES_URL`）、`App` の起動時取得、`shortNames` prop の 4 箇所への受け渡し、`displayName` の第 2 引数は**いずれも不要になる**。撤回の理由は判断 20 に書いた——WS 由来の事実と HTTP 由来の状態が混ざり、「辞書は来たが品目は来ていない」中間状態が生まれる。
- 旧方式で確定していた `Cache-Control`（`public, max-age=300`）と `GET` の 503 応答も、経路ごと落ちる。
- **残るもの**：`src/display/` の純粋層（検査・辞書・生成・検出）、札用 Worker の生成と KV、能力境界、麺量の 1 文字化と英語 UI の例外。

### スコープ外

- **札の一意性の保証**（判断 7）。異なる商品が同じ表示になる場合がある。防ぐには単一の書き手と強整合のストレージが要り、本 spec はそれを建てない。
- **生成の直列化**（判断 7・12）。並行生成の上書きを許容する。
- **札の訂正**（判断 11）。人が書き換える経路も消す経路も作らない。必要が現れたら独立の判断として扱う。
- **レールの切り詰めの解消。** 8 字の札でもレール（約 6 字・観測事実 3）では依然切れる。本 spec が解くのは釜バッジ（8.4 字/行）と提案ラベル（11 字/行）とラジアル（11.9 字/行）であり、レールの幅配分（卓番・待ち時間との取り合い）は別の判断である。
- `slot-suggested-start` 判断 14（ラベルは折り返す・行数を固定しない）の改訂。札は省略記号ではないので同判断と衝突しない。行数の上限は引き続き置かない。
- **商品コードの品目への搬入**（判断 2）。`StoreConfig.menuItems` への表示名の追加（判断 3・既存のスコープ外を引き継ぐ）。
- 麺量の既定（`普通`）の設定化。4 語しかなく店舗によらない（判断 8）。
- 辞書の WS 配信・プッシュ更新・再取得。メニュー改定は数か月に一度で、起動時取得で足りる（判断 20）。端末間の一時的な表示差は許容する（判断 12）。
- `Timer` / `TimerFact` への札の搬入。釜バッジは品目を引けたときだけ品名を出す既存経路（`SlotCard.tsx:463`）をそのまま使う。

### tasks へ落とす作業項目

- `src/client/components/queueDisplay.ts:172-180` の `displayName` の docstring を改める。現在は「POS 申告の商品名を優先し、無ければ麺種名で代替する」「麺量名があれば添える」とだけ書いており、札と麺量の 1 文字化を反映していない。
- `wrangler.jsonc` の `assets.run_worker_first` に `"/display/*"` を追加する（観測事実 10）。追加しなければ SPA フォールバックに吸われ、辞書の `GET` が `index.html` を返す。
- `wrangler.jsonc` に `ai` binding と KV namespace binding を追加し、`wrangler types` を実行する。
- `docs/pos-records-ingress-api.md` の例に `item_name` を加える（`slot-suggested-start/requirements.md:170`（AC 4.7）が要求したまま未実施であることを 2026-09-14 の調査で確認した。当該ファイルに `item_name` は 0 件）。本 spec は `item_name` を札のキーにするため、API 文書に現れないままにしない。
- テストのフィクスチャに実在しない商品名（`プレ塩` / `ﾈｷﾞ丼` / `特盛` / `かけ`）が使われている。本 spec が足すテストでは実データの名前（`特味噌ネギラーメン` / `新プレ塩` / `旨辛ｽﾀﾐﾅﾗｰﾒﾝ`）を使い、既存フィクスチャの是正は行わない（本 spec の変更対象ではない）。

### naming ゲート（2026-09-15 承認済み）

以下は公開シンボルであり、`naming.md` に従って実装前に確認した。**2026-09-15 に全件承認**。

| 候補名 | 場所 | 表明する概念境界 |
| --- | --- | --- |
| `Short_Name` / `shortName` | 概念・`displayName` の内部 | 商品名に与える 8 字以内の札。商品名そのものではない |
| `SHORT_NAME_MAX_LENGTH` | `queueDisplay.ts` | 8（コードポイント） |
| `applyShortNames(entries)` | `StoreTimerDO` の RPC | 札の押し込みの受け口。`deliverPlan` と同じ形（DO は pull しない） |
| `shortName` | ワイヤの品目の項目 | 送信時に被せる札。`OrderItem`（永続・engine）には現れない |
| `SIZE_LABEL` | `queueDisplay.ts` | 麺量名 → 1 文字の固定表。`普通` は空 |
| `ShortNameEntry` | 辞書のエントリ | `{ kind: "short"; label: string } \| { kind: "plain" }` |
| `SHORT_NAMES` | KV binding | 名前ごとに 1 キー。metadata に札、値に生成の記録 |
| `GET /display/short-names` | worker の経路 | `short` のエントリだけを名前 → 札の対応表として返す |
| `SHORT_NAME_MODEL` | `wrangler.jsonc` の `vars` | Workers AI のモデル ID（`@cf/zai-org/glm-5.3-flash`） |
| `SHORT_NAME_DEADLINE_MS` | 生成 | 1 件あたりの AI の待機を打ち切る期限 |
| `SHORT_NAME_REQUEST_DEADLINE_MS` | 生成 | 1 リクエストの全 Generation が共有する締切。`waitUntil` の 30 秒より十分手前に取る |
| `toShortName(candidate, name)` | 検査 | 非空・8 字以内・元名の文字だけで組まれている、の 3 条件を検査し、**正規化後の札**を返す（落ちれば null）。辞書を引数に取らない |
| `usesOnlyCharactersOf(a, b)` | 検査 | `a` が `b` の文字だけで組まれているか（多重集合の包含）。並び替えを許す。旧 `isSubsequence` を置き換えた |

## Glossary

- **Short_Name（札）**: 親品目の申告名に与える 8 コードポイント以内の表示用の短い名。元の名前の部分列であり、名前の出所ではない。**一意性を持たない**（判断 7）。
- **Declared_Name（申告名）**: POS が `order_items[].item_name` として申告する親品目の商品名。`OrderItem.itemName` が保つ事実（正規化しない）。
- **Dictionary_Key（辞書の鍵）**: Declared_Name を NFKC 正規化した文字列。KV のキーであり、配信される対応表のキーでもある。
- **Short_Name_Entry（辞書のエントリ）**: 1 つの Dictionary_Key に対する判断。`short`（札を与える）か `plain`（略さないと決めた）のいずれか。**エントリが無いこと**は「まだ考えていない」であり `plain` と別の事実である。
- **Size_Label（麺量の語）**: 麺量申告名の表示。`中盛` / `大盛` / `半玉` はそのまま・`普通` は表示しない。表に無い値は空白区切りで添える（区切りの有無が「表に在る語か」を示す）。
- **Subsequence_Constraint（部分列制約）**: 札の各文字が、元の Dictionary_Key に同じ順序で現れること。文字を足さず並び替えない。
- **Distinguishing_Characters（区別の文字）**: 味の系統・具・セット種別・対象客層など、その商品を他と分ける語。生成の指示が優先して残すよう求める対象であり、機械検査の対象ではない（判断 21）。
- **Short_Name_Dictionary（辞書）**: Dictionary_Key → Short_Name_Entry の集合。正本は KV。クライアントへは `short` のエントリだけが対応表として配られる。
- **First_Appearance（初出）**: 取り込んだ品目の Dictionary_Key が辞書にエントリを持たない状態。生成の唯一の起点。
- **Generation（生成）**: First_Appearance に対して 1 件の札を作る手続き。8 字以内なら AI を呼ばず `plain` を書き、9 字以上なら Workers AI を呼んで検査に掛ける。期限を持つ（判断 14）。
- **Generation_Budget（1 件の budget）**: 1 回の Generation が AI の待機に費やせる時間。「1 件あたりの上限」と「Request_Deadline までの残り」の小さいほうとして呼び出し側が配る。使い切ったら待つのをやめ、`plain` の保存へ進む。
- **Request_Deadline（リクエスト共通の締切）**: 1 回の `POST /pos/records` に属するすべての Generation が共有する締切。`ctx.waitUntil` の寿命が呼び出し 1 回に対して与えられる（観測事実 20）ことに対応する。この締切に届かず着手されなかった名前はエントリを持たず、次の到着で再び初出と判定される。
- **Pass_Through（素通し原則）**: `pos-order-ingress` Requirement 14。payload の中身を拒否事由にしない。本 spec では「生成の失敗が取り込みの成否に影響しない」として現れる。

## Requirements

### Requirement 1: 表示名の組み立て

**User Story:** As a 厨房スタッフ, I want 品目の名が短く出る, so that 狭いレールと釜のバッジで何の丼か読める。

#### Acceptance Criteria

1. THE `displayName` SHALL 品目の語を組む唯一の場所であり続け、札と Size_Label の規則を描画側へ持ち出さない
2. WHEN 受信した品目が `shortName` を持つ, THE `displayName` SHALL 商品名の位置にその札を置く
3. WHEN 受信した品目が `shortName` を持たない, THE `displayName` SHALL 商品名の位置に NFKC 正規化した Declared_Name をそのまま置く
4. WHEN 品目の Declared_Name が `null` である, THE `displayName` SHALL 商品名の位置に `noodleType` を置く（既存の代替規則を変えない）
5. THE `displayName` SHALL 商品名の位置と Size_Label の間に区切り文字を置かない
6. WHEN 麺量申告名が Size_Label の表に在る, THE `displayName` SHALL 当該の語を商品名の位置の直後に置く（`中盛` / `大盛` / `半玉` はそのまま）。ただし `普通` に対しては何も置かない
7. WHEN 麺量申告名が Size_Label の表に無い, THE `displayName` SHALL NFKC 正規化した麺量申告名を空白区切りで添える（既存の形を保つ）
8. WHEN 麺量申告名が `null` である, THE `displayName` SHALL 何も添えない（既存の形を保つ）
9. THE `displayName` SHALL 辞書を引かない。**引数は品目 1 つだけ**であり、client は辞書を持たない（判断 20）
10. THE `displayName` SHALL 異なる品目が同じ `shortName` を持っていても扱いを変えない（一意性を前提にしない・判断 7）

_出所: 判断 1・2・7・8・9・20・24, 観測事実 1・14・22_

### Requirement 2: 札の適用範囲

**User Story:** As a 厨房スタッフ, I want どの画面でも同じ品目が同じ名で呼ばれる, so that レールで見た丼を釜の上で見失わない。

#### Acceptance Criteria

1. THE Order_Rail・釜バッジ・ラジアルの帯・提案ラベル SHALL いずれも `displayName` の結果をそのまま置き、札の有無で語を変えない
2. THE 釜バッジ・提案ラベル・ラジアルの帯の `aria-label` SHALL 札を含む語（`displayName` の結果）を用いる
3. THE 各箇所 SHALL 溢れの扱いを変えない。レールは `truncate`、釜バッジ・ラジアル・提案ラベルは折り返しのままとし、行数の上限を新たに置かない
4. THE 本 spec SHALL 釜バッジの「品目を引けなければ `noodleType` を出す」既存経路（`SlotCard.tsx:463`）を変えない

_出所: 判断 10, 観測事実 2・3・4_

### Requirement 3: 初出の検出と生成の起動

**User Story:** As a 店舗運営, I want 新しいメニューが増えたら札が自動で用意される, so that メニュー改定のたびに人が表を作らずに済む。

#### Acceptance Criteria

1. WHEN `POST /pos/records` が受理され、Record 内の親品目の Dictionary_Key が辞書にエントリを持たない, THE Worker SHALL 当該 Dictionary_Key の Generation を `ctx.waitUntil` の中で起動する
2. THE Worker SHALL `POST /pos/records` の応答を Generation の成否・完了に依存させない
3. THE Worker SHALL `POST /s/{storeId}/orders`（Order_Ingress）のボディを解釈せず、当該経路から Generation を起動しない
4. THE Worker SHALL 既知の Dictionary_Key をメモリに保持し、既知の名前だけが届く間は KV を読まない
5. WHEN Worker のメモリに既知集合が無い（isolate の初回）, THE Worker SHALL `list()` 1 回で辞書の全キーを読み、既知集合を満たす
6. WHEN 同一の Dictionary_Key に対する Generation が複数の店舗・isolate で同時に走る, THE Worker SHALL 直列化せず、**後から書かれたエントリを最終の値とする**。先に書かれた `short` が後続の `plain` で置き換わること、およびその逆も許容する（判断 12）
7. THE 本 spec SHALL 札の一意性を検査せず、異なる Dictionary_Key が同じ札を持つ状態を不正としない（判断 7）
8. THE Worker SHALL Generation の失敗（AI 不達・例外・期限切れ）を取り込みの失敗として扱わず、記録に留める
9. THE Worker SHALL 1 つの Arrival_Batch に含まれる親品目名を Dictionary_Key へ正規化したうえで**重複を除いて**から Generation を起動する。重複除去は Dictionary_Key で行い、各キーについて**生の Declared_Name を 1 つ保つ**（同じキーに複数の表記が混ざる場合はバッチ内の先頭）。Generation には鍵と申告名の双方を渡す——鍵だけを渡すと Requirement 6 AC3 の「元の申告名を残す」を満たせない
10. THE Worker SHALL 同一リクエスト内のすべての Generation が**共有する締切**を持ち、各 Generation が AI の待機に使える時間を「1 件あたりの上限」と「締切までの残り」の小さいほうに制限する。**締切までの残りは各 Generation の着手直前に評価する**——辞書の読み取りを含む待機のあとに、評価し直さずに budget を配らない。`ctx.waitUntil` の寿命は呼び出し 1 回に対して与えられ、その中のすべての処理が共有する（観測事実 20）
11. THE Worker SHALL 1 リクエストで着手する初出の件数に上限を持ち、残り時間が新しい Generation を始めるに足りないときは着手しない
12. WHEN 締切・件数上限により着手されなかった Dictionary_Key がある, THE Worker SHALL 当該キーにエントリを書かない。**当該商品が再び注文されたとき**に改めて初出と判定され、そのときの締切で着手される——検出はバッチに現れた名前しか見ないため、他の商品の注文では拾い直されない（許容）

_出所: 判断 7・12・14・18・19, 観測事実 8・9・18・20_

### Requirement 4: 札の生成

**User Story:** As a 厨房スタッフ, I want 札が元の商品名から素直に削られている, so that 別の商品と読み違えない。

#### Acceptance Criteria

1. WHEN Dictionary_Key の長さが 8 コードポイント以下である, THE Generation SHALL AI を呼ばず `plain` のエントリを書いて終える
2. WHEN Dictionary_Key の長さが 9 コードポイント以上である, THE Generation SHALL `SHORT_NAME_MODEL` が指す Workers AI のモデルへ当該 1 件だけを渡す
3. THE Generation SHALL プロンプトに**既存の札の一覧を渡す**（判断 30）。一覧は在メモリの辞書から取り、追加の読み取りをしない
4. THE Generation SHALL プロンプトで **Distinguishing_Characters（味の系統・具・セット種別・対象客層など、商品を区別する文字）を優先して残す**よう指示する
5. THE Generation SHALL プロンプトで「元の名前から文字を削って作る・文字を足さない・並び順を変えない・8 字以内・可能な限り短く」を指示する
6. THE Generation SHALL `response_format` に `json_schema` を指定し、札 1 件を構造化出力として受け取る。あわせて `chat_template_kwargs: { enable_thinking: false }` を渡す（判断 31）
7. WHEN 生成結果が検査（Requirement 5）に通る, THE Generation SHALL `short` のエントリを書いて終える
8. WHEN 生成結果が検査に落ちる、または `JSON Mode couldn't be met` が返る、または呼び出しが失敗する, THE Generation SHALL 同じ入力で 1 回だけ再試行する
9. WHEN 再試行の結果もなお通らない, THE Generation SHALL `plain` のエントリを書いて終える
10. THE Generation SHALL AI の待機の総計を**呼び出し側から割り当てられた budget**（Requirement 3 AC10）で打ち切る。budget に達したら再試行の有無に関わらず待機をやめ、`plain` の保存へ進む
11. THE `SHORT_NAME_REQUEST_DEADLINE_MS` SHALL `waitUntil` の上限（応答後 30 秒・観測事実 20）に対して、着手済みの Generation がすべて保存を完了するに足る余裕を残す値とする
12. WHEN エントリの保存自体が失敗する, THE Generation SHALL 失敗を記録し、辞書にエントリを残さない。当該 Dictionary_Key は次の出現で再び初出と判定される（許容・判断 14）
13. WHEN Worker がエントリの存在を観測している, THE Worker SHALL 当該 Dictionary_Key に対して AI を呼ばない。既に開始済みの Generation と、他 isolate のメモリ集合への反映の遅れは許容する
14. THE Generation SHALL モデル ID を `vars` から読み、コードに直書きしない

_出所: 判断 5・12・13・14・21・22・23, 観測事実 17・20_

### Requirement 5: 生成結果の検査

**User Story:** As a 厨房スタッフ, I want 機械が作った札を機械が検めている, so that 元の商品名に無い語が札に現れない。

#### Acceptance Criteria

1. THE 検査 SHALL 候補が非空文字列であることを要求する
2. THE 検査 SHALL 候補を NFKC 正規化した長さが 8 コードポイント以下であることを要求する
3. THE 検査 SHALL 候補が Dictionary_Key にある文字だけで組まれていること（多重集合の包含・同じ文字は元名にある回数まで）を要求する。**並び順は問わない**（判断 6・33）
4. THE 検査 SHALL 上記 3 条件だけを持ち、辞書の他のエントリを参照しない
5. THE 検査 SHALL 文字種の検査を別に持たない（AC 3 が元名に無い文字を構造的に排除する）
6. THE 検査 SHALL セット種別（`A` / `B` / `C`）の保持・味の系統の保持を条件として持たない。これらは Distinguishing_Characters として**生成の指示が担う**（判断 21）。**これらの保持は元名と候補だけで検査でき、辞書を要しない**——足さないのは技術的な制約ではなく、多少の衝突を許容する方針（判断 7）に合わせた選択である
7. THE Generation SHALL **検査に用いた正規化後の文字列そのもの**を保存し、配信する。生の候補を保存しない——`特味噌ﾈｷﾞﾗｰﾒ` は正規化すれば 8 字かつ部分列だが、生は 9 コードポイントで部分列でもなく、検査した性質が表示値に成立しない
8. THE 復号 SHALL モデルの応答から候補を取り出す唯一の関門を持ち、`choices[0].message.content` が文字列でない場合（`null`・`refusal`・欠落）、JSON として解釈できない場合、`short` が文字列でない場合のいずれも候補なしとして扱う（検査落ちと同じ経路へ畳む）

_出所: 判断 6・7・21, 観測事実 13・15_

### Requirement 6: 辞書の永続

**User Story:** As a 店舗運営, I want どうしてその札になったのかが後から読める, so that 訂正の経路が無いことを承知のうえで運用を判断できる。

#### Acceptance Criteria

1. THE 辞書 SHALL KV に Dictionary_Key ごとの 1 キーとして保たれる
2. THE 各キー SHALL metadata に判別（`short` / `plain`）と、`short` の場合の札を持つ
3. THE 各キー SHALL 値に生成の記録（生成時刻・モデル ID・元の Declared_Name・落ちた候補があればそれ）を持つ
4. THE 値 SHALL 配信経路（Requirement 7）に載らない
5. THE 辞書 SHALL 全件を `list()` 1 回で読めることを前提とし、`list_complete` が偽なら `cursor` で続きを読む
6. THE 本 spec SHALL **人が**辞書のエントリを書き換える経路・削除する経路を持たない。並行生成による上書き（Requirement 3 AC 6）はこの限りでない

_出所: 判断 11・12・15・17, 観測事実 18_

### Requirement 7: 札の押し込みとワイヤへの搭載

**User Story:** As a 厨房スタッフ, I want 品目と札が同じ便で届く, so that 「名前は来たが札は来ていない」中間状態を見ずに済む。

#### Acceptance Criteria

1. WHEN 札用 Worker が `short` のエントリを確定する, THE 札用 Worker SHALL 当該の名前を観測した店舗の `StoreTimerDO` へ札を押し込む
2. THE 札用 Worker SHALL 押し込みに `short` のエントリだけを載せる。`plain` と生成の記録は押し込まない
3. THE `StoreTimerDO` SHALL 札を**押し込みでのみ**受け取り、辞書を引きに行かない（自立性の不変・観測事実 23）
4. THE `StoreTimerDO` SHALL 受け取った札を `StoreSnapshot` とは別のキーへ永続する。`CURRENT_SCHEMA_VERSION` にも `migrate` にも関わらせない（判断 26）
5. WHEN `StoreTimerDO` が品目をワイヤへ載せる, THE `StoreTimerDO` SHALL 当該品目の Declared_Name に札があれば `shortName` として添える
6. WHEN 札が無い, THE `StoreTimerDO` SHALL `shortName` を添えない（受け手は全名へ戻る）
7. THE `StoreTimerDO` SHALL 送信を組む時点で札を引き、到着時刻の札で固定しない（判断 25）
8. THE Client SHALL 札を取得も保持もしない。`shortName` を持つ品目を受け取って表示するだけである
9. WHEN 押し込みが届いていない、または届く前に品目が送られる, THE Client SHALL 全名で表示を続ける（壊れた状態ではない）
10. THE 本 spec SHALL 押し込みの到達順序を保証しない。同じ品目が、ある送信では札つき・別の送信では全名で出る期間を許容する（判断 12 と同じ範囲）
11. THE 札用 Worker SHALL **観測したすべての名前**のうち札を持つものを押し込みの積荷に載せる。既に生成済みの名前も載せる——別の店舗が初めて観測した場合、生成を飛ばすだけではその店舗に札が届かない（判断 29）
12. WHEN 押し込みが失敗する, THE 札用 Worker SHALL 記録に留め、専用の再送機構を持たない。同じ商品が次に観測されれば同じ札がまた積まれる
13. THE `StoreTimerDO` SHALL 札を被せる処理を 1 箇所に持ち、通常の Broadcast と接続時の hydration の双方をそこに通す（判断 27）
14. WHEN 押し込みによって札が実際に変わる, THE `StoreTimerDO` SHALL 確定済みの現在の状態をそのまま再送する。変わらなければ送らない（判断 28）
15. THE 再送 SHALL 新しい状態遷移でも `Effect` でもない。`decide` を通らず `storage.put` を伴わない

_出所: 判断 0・12・16・20・24・25・26・27・28・29, 観測事実 22・23・24_

### Requirement 8: 触れないもの

**User Story:** As a 開発者, I want この機能が厨房の事実に一切触れないことが検査で担保される, so that 表示の都合が計画や永続を汚さない。

#### Acceptance Criteria

1. THE 本 spec SHALL `OrderItem` の形を変えない（商品コードを足さない）
2. THE 本 spec SHALL `CURRENT_SCHEMA_VERSION` を 13 のまま保ち、migrate に分岐を足さない
3. THE 本 spec SHALL `digest` の対象を変えない
4. THE 本 spec SHALL `StoreConfig`・`StoreProjection`・レジストリのイデアに札を足さない
5. THE 本 spec SHALL `StoreTimerDO` に **AI・KV の直接 binding** を持たせない。root の `wrangler.jsonc` に `ai` / `kv_namespaces` を書かず、当該能力は `yude-men-short-names` Worker の生成 Env（`ShortNamesEnv`）だけに現れる。**root の `SHORT_NAMES_WORKER`（service binding）は DO からも見える**——「札の機能へ到達できない」ことは保証しない（`SOLVER` と同じ範囲）。そちらは `store-timer-do.ts` が当該 binding を参照しないという静的検査で見る
6. THE 本 spec SHALL ワイヤの**種別集合**を変えない。`ServerMessage` が運ぶ品目には `shortName` が増えるが、これは**ワイヤ側だけの項目**であり、`OrderItem`（永続・engine）には現れない（判断 24・AC1・AC2 がそれを閉じる）
7. THE 本 spec SHALL Operation History の記録内容を変えない

_出所: 判断 1・2・3, 観測事実 5・6・7・9_
