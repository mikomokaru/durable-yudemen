# Requirements Document

> **レビュー前提（2026-09-18・ユーザー指定）：まだ運用していない。** 既存データの migration・古い投影との切り替え・旧画面との互換性・Idle_Precondition・移行期間の無停止／無欠損は、今回のレビュー指摘・実装着手の承認条件に含めない。以下の移行関連の記述にもこの前提を適用する。新形式の `portions` 必須検査など、運用開始後の正しさを保証する要件はレビュー対象とする。

## Introduction

本 spec は、管理 API（Provisioning_API・`PUT /admin/policies/{policyId}` / `PUT /admin/stores/{storeId}`）へ投入するメニュー対応表 `menuItems[].sizes[]` の定義を、**釜の占有数（`slotSpan`）から麺の玉数（Portions）へ改める**。釜の占有数は玉数から導く導出値とし、設定・状態・永続・ワイヤのいずれにも保持しない。玉数は事実として `OrderItem` に載せ、ワイヤで client へ届き、画面に見せる（ユーザー要求・2026-09-18）。

動機は 2 つある。

1. **現場は玉数を見る必要がある。** 麺を釜へ落とす人が知りたいのは「何玉入れるか」であり、「何釜使うか」はその帰結である。今の `OrderItem` は帰結（`slotSpan`）しか運ばず、原因（玉数）を持たないので画面に出せない。
2. **人が釜数を入力する形は誤る。** 2026-09-14 に、中盛（1.5 玉）が 9 商品コード・51 箇所で「2 釜」と登録されていたことが見つかった（`cpsat-planner-integration/verification/menu-policy-slotspan-20260914.md`）。実データの約 2 割の杯が本来の倍の釜を占めていた。同文書は「`slotSpan` は本来は導出値である。事実は玉数で、釜数は厨房の規則から出る。設定が玉数を持ち、アプリが `slotSpan` を導く形が本筋」と結んでおり、本 spec はその計画である。

前提は `pos-order-ingress`（`NoodleSize` / `MenuItem` / `toNoodleSpec`・AC 6.24〜6.25）、`per-store-provisioning`（イデア→投影の経路・拒否型検証・投影の店舗 DO 側永続）、`order-lifecycle` / `order-item-truncation`（`OrderItem` の生涯と永続 v13〜）、および作業ツリー上の `order-flow`（永続 v14・`tableAssignedAt`・`liftIntervalSeconds` の主張対象化・2026-09-17）。

### 観測事実（2026-09-18・作業ツリー `mikomokaru/order-management` 時点）

1. **設定の形。** `NoodleSize = { code: 商品コード, slotSpan: 1〜6 の整数 }`（`src/domain/store.ts`）。`MenuItem.sizes: NonEmptyArray<NoodleSize>`。値域の正本は `SLOT_SPAN_MIN = 1` / `SLOT_SPAN_MAX = SLOTS_PER_UNIT = 6`。
2. **投入の経路。** Provisioning_API は `validateNoodleSize`（`src/registry/validate.ts:411`）で `{ code, slotSpan }` を拒否型で検証し、未知フィールドは 400 で拒む。合成（`composeEffectiveConfig`）は出口で `toMenuItems`（domain・畳み型）を通す。投影は `StoreProjection.config`（完全な `StoreConfig`）として店舗 DO へ押し込まれ、`projection` キーへ**検証なしでそのまま**永続され、`adoptProjectionConfig` が在メモリへ代入する（`store-timer-do.ts:692`）。`configMessage` は `StoreConfig` の全項目（`menuItems` を含む）を client へ配る。
3. **レジストリのイデアには版が無い。** Policy / Store は raw のまま `policy:` / `store:` キーに永続され、`loadIdeal` はそれを型注釈だけで読む。永続された Policy `pos-menu`（`chainId: yamaokaya`・priority 100・全 200 店・2026-09-14 投入）の `sizes` は `slotSpan` を持ち、`portions` を持たない。**`GET /admin/policies/{policyId}` は存在しない**ので、本番の Policy の中身は読めない（同文書 §6 未処理 1）。
4. **翻訳の経路。** `toNoodleSpec`（`src/ingress/noodle-spec.ts`）が麺量 child の商品コードで `sizes` を引き、`NoodleSpec.slotSpan = size.slotSpan` を返す。店舗 DO の `toReceivedOrders` がそれを `OrderItem.slotSpan` へ写す（`store-timer-do.ts:280`）。Order_Ingress（`POST /s/{storeId}/orders`・JSON ボディ）の `toArrivedItem` も `candidate.slotSpan` を `toSlotSpan` で読む（`domain/order.ts:333`）。
5. **`slotSpan` の読み手。** `src` で 22 ファイル・約 120 箇所（コメント含む）。engine の割当・上げ窓・Acceptance_Gate（`schedule.ts` 37 箇所）、no-op 検出（`pending.ts` の `isSameOrderItems`）、入力の写し（`digest.ts:111`）、CP-SAT のモデル（`cpsat/plan.ts` / `request.ts` / `worker.ts`）、client の釜の組（`liftGroups.ts` の `pairSlots`・`SlotBoard.tsx`）、ワイヤの復号（`wire.ts:246`）、永続の復元（`migrate.ts:245` の `reviveSlotSpan`）。**いずれも整数の釜数として読む**——「品目 1 件が要る釜の数」という意味は変わらない。
6. **永続。** `OrderItem.slotSpan` は v8 で足され、現行版は **v14**（`CURRENT_SCHEMA_VERSION`・作業ツリー）。`reviveSlotSpan` は欠如を 1 へ畳み、値域外・非整数を壊れたデータとする。テストは 88 ファイル・302 箇所が `slotSpan` に触れる（大半はフィクスチャの `slotSpan: 1`）。
7. **玉数と釜数の関係（実データ）。** コーパスの麺量マスタ（`noodle_reference.csv`・490 行・10 店舗）では例外なく——0.5 玉→1 釜・1.0→1・1.5→1・2.0→2・2.5→2。**麺種で分かれない**（つけ麺の 1.5 玉も 1 釜）。玉数は 0.5 刻みである。「1 釜（テボ）に入るのは 1.5 玉まで」という物理で全行が説明できる（ユーザー確認済みの「中盛 1.5 玉は 1 釜」を含む）。
8. **麺量の申告名。** `OrderItem.sizeName` は POS が伝票へ印字する語（`普通` / `中盛` / `大盛` / `半玉`）をそのまま運び、client の `displayName`（`queueDisplay.ts` の `SIZE_LABEL`）と Orders 画面の `BowlTile`（`OrderFlowBoard.tsx:800`）が表示する。**名前は判定に用いない**規律（`pos-order-ingress`）があるので、玉数を名前から引くことはできない。
9. **client の日本語の規律。** ユーザー向け文字列は英語で、例外は茹で加減ラベルと `SIZE_LABEL` の初期化子の中の麺量の語だけ（`offline-degradation` 要件 13.6・`tests/offline-degradation.static.test.ts`）。玉数の単位「玉」を画面へ出すなら、この例外を同じ形（初期化子 1 箇所に閉じる）で広げる必要がある。
10. **CP-SAT の計画器は同じリポジトリのコード**（`src/cpsat/*`）で、`OrderItem` を運ぶ `PlanRequest` を Queue で受ける。店舗 DO は入力の写し（`digest`）で古い並行解を無効にするので、deploy を跨いだ飛行中の要求から返った計画は採用されない。
11. **作業ツリーの状態。** `order-flow`（v14）の変更 96 ファイルが未コミットで載っている。型検査は各 Worker の生成型（`pnpm cf-typegen` / `cpsat:types` / `short-names:types` / `cpsat:transport:types` / `poc:cpsat:types`）を作れば 0 件で通る（2026-09-18 確認）。

### 確定した設計判断（本 spec の提案。ユーザー確認は task 0）

1. **設定の事実は玉数だけ。** `NoodleSize` は `{ code, portions }` になり、`slotSpan` を持たない。投入時に `slotSpan` が現れれば未知フィールドとして 400 で拒む（機械間 API では畳み込みが投入元の誤りを隠す・`per-store-provisioning` 要件 4.6）。
2. **釜数は一つの純粋関数で導く。** `slotSpanOf(portions) = ⌈portions / PORTIONS_PER_SLOT⌉`、`PORTIONS_PER_SLOT = 1.5`（1 釜に入る玉数の上限）。観測事実 7 の全行を再現する。**規則は定数であって店舗設定ではない**——10 店舗で差が無く、店舗差が実在するまで設定にしない（`HELPER_ARMS` と同じ規律・`lift-group-planning` 判断 20）。
3. **玉数は 0.5 刻み・0.5 以上・9 以下。** 上限は `SLOT_SPAN_MAX × PORTIONS_PER_SLOT = 9`（1 ユニットを跨がない・既存の上限をそのまま玉数へ写す）。刻みは `Number.isInteger(portions × 2)` で検査する。導出は半玉単位の整数演算（`⌈2p / 3⌉`）で行い、浮動小数の丸めに晒さない。
4. **`OrderItem` は玉数を運び、釜数を持たない。** `slotSpan` は「計算できるものは保持せず計算せよ」（design-philosophy「導出値は状態の関数である」）に従い、状態・永続・ワイヤから取り除く。読み手は `slotSpanOf(item.portions)` で導く。永続の版は **v15** へ上げる。
5. **v14 以前の品目は釜数から玉数を仮置きし（`portions = slotSpan`）、仮置きが読み手に届かない状態で deploy する（レビュー反映・2026-09-18）。** 逆写像は一意でない（1 釜は 0.5 / 1.0 / 1.5 のどれでもありうる）ので、仮置きの値を「投入量」として現場に見せれば嘘になる（中盛が `1玉`、半玉が `1玉`）。ゆえに **deploy の前提条件**を置く——全店で最後の受領から `ORDER_LIFETIME_MS`（2 時間）以上が経ち、走行中 Timer が無いこと。このとき v14 の品目はすべて期限切れで、待ち行列にも釜のカードにも Orders 画面にも現れず（`isLive` が読む側で除く）、計画対象にもならない。仮置きは永続に残るが読み手を持たず、`order-item-truncation` の上限で数日のうちに落ちる。前提条件は Workers Logs で検証してから deploy する（Requirement 8）。**却下案**：(a) 玉数を `number | null` で運ぶ——null の品目の釜数を別に持たねばならず、「両方ある／どちらも無い」が表現可能になる。(b) `{ portions } | { legacySlotSpan }` の和型——真だが、一度きりの移行のために全読み手が永久に 2 分岐を持つ。(c) 移行で v14 の品目を捨てる——`pending-order-expiry` 判断 1（正本は読む側の述語で絞り、掃かない）に反する。前提条件が破られた場合の残余（仮置きが最大 2 時間表示される）は design に明記する。
6. **古い形の投影を持つ店舗 DO は、受領を `unprovisioned` で返す（レビュー反映・2026-09-18）。** deploy 直後、店舗 DO の永続投影は `slotSpan` 形の `sizes` を持つ。この投影で受領を確定すれば、麺の品目が非麺として通り、**品目 0 件の受領として重複排除の番号が進み**、既存の未調理品目が除かれる——Policy を直して再送しても重複として捨てられる。ゆえに投影の `menuItems` が現行の形でない間は、受領を投影未達（`unprovisioned`）と同じ扱いにする。Worker は `unprovisioned` を一時的失敗として Arrival_Batch 全体を 5xx にし上流の再送に委ね（`worker.ts:635`・AC 5.8・Duplicate_Bias）、レジストリの再生も `deferred` で持ち越す（`store-registry-do.ts:723`）。番号は進まないので、再投入後の再送は普通に受理される。WS 接続は拒まない（`config` は古い形のまま配り、client の復号が `portions` を持たない `sizes` を落とすだけで、client は翻訳しない）。在メモリの `menuItems` は `toMenuItems` に通し、型が嘘をつかないようにする。
7. **玉数は麺種と一つのバッジで見せ、品名には含めない（改訂・ユーザー指示 2026-09-18）。** ワイヤの `WireOrderItem` に `portions` を載せ、client は麺種の名と玉数の数字を一つのチップ（`NoodleChip`・例 `REG 1.5`）に置く。単位「玉」は付けない（数字だけ・整数は小数点なし）。品名（`displayName`）は変えない——当初は品名の末尾に「1.5玉」を添える形にしたが、品名が伸びて読みにくく、麺種は色でしか判らなかった。チップは麺種の色で塗り、待ち行列の行・ラジアルの帯・釜のバッジ・Orders 画面の札で同じ形を使う。日本語の単位を持たないので client の英語 UI の例外は広げない。
8. **`sizeName` は残す。** 玉数と申告名は別の事実である（`中盛` は POS の語、1.5 は釜へ落とす量）。表示は両方を持ってよく、判定はどちらにも依らない。
9. **移行期間はワイヤに釜数を併記する（レビュー反映・2026-09-18）。** client に再読み込みの経路は無く、開いたままの旧画面は WS の再接続後も旧の復号器で動く。旧の `toOrderItemFromWire` は `slotSpan` を必須とし、無ければ snapshot 全体を落として画面が更新されなくなる。ゆえにサーバは `WireOrderItem` に `slotSpan: slotSpanOf(portions)` を**送信時に導出して併記**する。ワイヤは状態ではなく射影であり（`Timer → TimerFact` が `seq` を削ぐのと同じ層）、導出値を載せても二つの真実にはならない——新しい復号器はこれを読まない。併記は全端末が新しいバンドルで動いていることを確かめた後に外す（別 spec・未決 5）。
10. **永続の復元は版で分ける（レビュー反映・2026-09-18）。** `portions` の欠如を無条件に 1 へ畳むと、v15 で必須の値が欠けた壊れたデータも通る。復元は版を受け取り、v15 以降は `portions` 必須（欠如は `MigrationFailed`）、v8〜v14 は `slotSpan` から仮置き、v7 以前は 1 とする。
11. **CSV に無い 3 コードはユーザーが規則で確定した（2026-09-18）。** `productCode 16018` の `19749` / `19750` / `19751` は、麺種に「つけ」を含まないメニューの 3 サイズは 1 / 1.5 / 2、含むメニューは 1.5 / 2 / 2.5 という規則で 1 / 1.5 / 2 とした。投入用の JSON は `config/provisioning-sample/pos-menu-policy.json`（未追跡）に完成している。

### スコープ外

- **`PORTIONS_PER_SLOT` の店舗設定化。** 店舗差が実在するまで定数（判断 2）。
- **`GET /admin/policies/{policyId}` の追加。** 本 spec のロールアウトで「現行 Policy を読めない」ことが再び効く（観測事実 3）が、別の関心である。手元の JSON と玉数の正本（CSV）から新しい Policy を組む前提で進める（未決 1）。
- **麺仕込み数量の集計**（「あと何玉茹でるか」・`prior-art-boilit.md` 7）。玉数が `OrderItem` に載れば導出できるが、本 spec は画面に出すところまでとする。
- **`Timer` / `TimerFact` への玉数の追加。** 走行中の品目の玉数は `orderItem` 参照経由で `OrderItem` から引ける（参照が解けない Timer は麺種だけで表示する既存の経路）。共有の芯を変えない（`timer-model.md`）。
- **釜数の内訳ログ**（同文書 §6 未処理 3）。`cpsat/worker.ts` の観測は導出値で従来どおり出す。

## Glossary

- **Portions（玉数）**: 品目 1 杯の麺の玉数。0.5 刻みの正の数（0.5〜9）。設定（`NoodleSize.portions`）と品目（`OrderItem.portions`）が持つ事実。
- **Slot_Occupancy_Rule（占有規則）**: 玉数から釜数を導く唯一の規則。`slotSpanOf(portions) = ⌈portions / PORTIONS_PER_SLOT⌉`。
- **PORTIONS_PER_SLOT（釜あたり玉数）**: 1 釜（テボ）に入る玉数の上限。1.5。定数。
- **slotSpan（釜数）**: 品目 1 件が要る釜の数。従来は設定と状態が持つ値だったが、本 spec 以後は**導出値**であり、保持しない。語は engine / client の読み手の変数名として残る（意味は変わらない）。
- **Migrated_Portions（仮置きの玉数）**: v14 以前の品目に対して釜数から仮に置いた玉数（`portions = slotSpan`）。deploy の前提条件（Idle_Precondition）により読み手に届かない。
- **Idle_Precondition（静止の前提条件）**: deploy の時点で全店が最後の受領から `ORDER_LIFETIME_MS` 以上経過し、走行中 Timer を持たないこと。仮置きの玉数が表示にも計画にも届かないことの保証。
- **Stale_Projection（古い形の投影）**: `menuItems[].sizes[]` の要素に `portions` を持たない永続投影。deploy 前にレジストリが押し込んだもの。受領は `unprovisioned` で返す。
- **Wire_SlotSpan（ワイヤの釜数併記）**: 移行期間にサーバが `WireOrderItem` へ送信時に併記する導出値 `slotSpan`。旧画面の復号のためだけに在り、新しい復号器は読まない。

## Requirements

### Requirement 1: 設定は玉数を持つ

**User Story:** As a 本部の運用者, I want メニュー対応表に玉数を書く, so that 釜数の手入力による誤りが起きない。

#### Acceptance Criteria

1. THE `NoodleSize` SHALL `{ code: 商品コード, portions: Portions }` であり、`slotSpan` を持たない
2. THE Provisioning_API SHALL `sizes[]` の各要素に `portions` を必須とし、欠落を `missing-required`、非数・非有限を `type-mismatch`、0.5 刻みでない値・`PORTIONS_MIN`（0.5）未満・`PORTIONS_MAX`（9）超を `out-of-range` として 400 で拒み、イデアを変えない（拒否理由は全件集約・既存規律）
3. IF 投入値の `sizes[]` の要素に `slotSpan` が現れる, THEN THE Provisioning_API SHALL 未知フィールドとして拒む（黙って読み替えない・畳まない）
4. THE domain の畳み型の検証（`toNoodleSize` / `toMenuItems`） SHALL `portions` が Portions の値域に無い要素を落とす（既存の `slotSpan` に対する規律をそのまま写す・クランプしない）
5. THE 合成（`composeEffectiveConfig`）・イデアの型（`PolicyFields` / `StoreOverride`）・`CONFIG_FIELDS` SHALL 変えない（`menuItems` の要素の形が変わるだけで、フィールドの集合も合成規則も同じ）
6. THE `config/provisioning-sample/README.md` SHALL `menuItems` の検証範囲（`portions` の値域と刻み）を表に載せる

### Requirement 2: 釜数は一つの純粋関数で導く

**User Story:** As a 設計者, I want 玉数から釜数を導く規則が一箇所に閉じている, so that engine と client と計画器が同じ釜数を見る。

#### Acceptance Criteria

1. THE domain SHALL 純粋関数 `slotSpanOf(portions)` を一つ持ち、`⌈portions / PORTIONS_PER_SLOT⌉` を返す
2. THE `slotSpanOf` SHALL 半玉単位の整数演算（`⌈(portions × 2) / (PORTIONS_PER_SLOT × 2)⌉`）で計算し、Portions の値域の全値（0.5 刻み・0.5〜9）で整数を返す
3. THE `slotSpanOf` SHALL 観測事実 7 の表を再現する——0.5→1・1.0→1・1.5→1・2.0→2・2.5→2
4. THE `slotSpanOf` SHALL Portions の値域で `SLOT_SPAN_MIN`（1）以上 `SLOT_SPAN_MAX`（6）以下を返す（`PORTIONS_MAX = SLOT_SPAN_MAX × PORTIONS_PER_SLOT` がこれを構造で保証する）
5. THE `PORTIONS_PER_SLOT` SHALL domain の定数（1.5）であり、店舗設定・ワイヤ・環境変数のいずれからも読まない
6. THE engine / client / cpsat SHALL 釜数を `slotSpanOf` 以外の式で導かない（`Math.ceil` / 除算の再実装を各所に書かない）。検査は静的検査で行う（Requirement 9.6）

### Requirement 3: 品目は玉数を事実として運ぶ

**User Story:** As a 厨房スタッフ, I want 品目に玉数が載っている, so that 何玉入れるかを画面で読める。

#### Acceptance Criteria

1. THE `OrderItem` SHALL `portions: Portions` を持ち、`slotSpan` を持たない
2. THE `NoodleSpec`（`toNoodleSpec` の戻り値） SHALL `slotSpan` に代えて `portions` を返し、値は同定した `NoodleSize.portions` そのものである（判定と翻訳が同じ入力から導かれる規律・`pos-order-ingress` AC 6.24 は「釜数」を「玉数」に読み替える）
3. THE 店舗 DO の `toReceivedOrders` SHALL `spec.portions` を `OrderItem.portions` へ写す
4. THE Order_Ingress（`POST /s/{storeId}/orders`）の `toArrivedItem` SHALL ボディの `portions` を Portions として読み、`slotSpan` を読まない（値域外・欠落は従来どおり品目全体の拒否）
5. THE `upsertOrder` SHALL 同じ鍵の後着で `portions` を POS 由来の注文属性として更新する（`order-lifecycle` の属性 6 つのうち `slotSpan` を `portions` に置き換える）。`isSameOrderItems` は `portions` を比べる
6. THE `digest`（入力の写し） SHALL `slotSpan` に代えて `portions` を畳む（計画に効くのは玉数の事実であり、釜数はその関数である）
7. THE engine（割当・上げ窓・Acceptance_Gate・陳腐化判定・容量）・CP-SAT（対象の絞り・モデル・観測）・client（釜の組 `pairSlots`） SHALL 釜数を `slotSpanOf(item.portions)` で読む。**意味は変えない**——「品目 1 件が要る相異なる釜の数」のまま

### Requirement 4: 永続と移行

**User Story:** As a 運用者, I want deploy 前の待ち行列が壊れず読める, so that 版上げが営業を止めない。

#### Acceptance Criteria

1. THE 永続スキーマ SHALL v15 へ上がり、`OrderItem` は `portions` を持ち `slotSpan` を持たない
2. THE `migrate` SHALL 品目の復元に**永続の版**を渡し、版ごとに必須項目を分ける（判断 10）。WHEN 版が 15 以上, THE `migrate` SHALL `portions` を必須とし、欠如・値域外・非数を壊れたデータ（`MigrationFailed`）とする（クランプしない・`slotSpan` が在っても読まない）
3. WHEN 版が 8〜14 の品目（`slotSpan` あり）を復元する, THE `migrate` SHALL `portions = slotSpan`（Migrated_Portions）とする。`slotSpan` が非整数・値域外なら従来どおり壊れたデータ。欠如は従来どおり 1
4. WHEN 版が 7 以前の品目を復元する, THE `migrate` SHALL `portions = 1`（従来 `slotSpan = 1` へ畳んでいたのと同じ帰結）とする
5. THE Migrated_Portions SHALL 釜数 1〜2 について `slotSpanOf(portions) = slotSpan` を満たす（計画の占有が移行で変わらない）。釜数 3 以上では一致しない（3→2・4→3・5→4・6→4）が、現行の Policy は 3 以上を生成しないので受け入れる
6. THE 仮置きの玉数 SHALL 現場に投入量として表示されない。これは Idle_Precondition（Requirement 8.1）が保証する——前提条件の下では v14 以前の品目はすべて期限切れで、`isLive` を通す読み手（待ち行列・釜のカード・Orders 画面・計画対象）のいずれにも現れない
7. THE `docs/persisted-schema-rollback.md` §3 SHALL v15 の行を持つ（下り移行：`version` を 14 にし、各品目に `slotSpan = slotSpanOf(portions)` を書き戻す——v14 の `reviveSlotSpan` は欠如を 1 へ畳むので、書き戻さなければ大盛が 1 釜として復元される）
8. THE `CURRENT_SCHEMA_VERSION` の台帳（`engine/types.ts`） SHALL v15 の行を持つ

### Requirement 5: 投影・ワイヤ・client

**User Story:** As a 設計者, I want 設定の変化が投影とワイヤを同じ形で通る, so that 項目ごとに配信対象を選び直さない。

#### Acceptance Criteria

1. THE `configMessage` SHALL `menuItems` を新しい形（`sizes[].portions`）で配る（`StoreConfig` の全項目を配る方針に例外を作らない）
2. THE client の `toStoreConfig`（`wire.ts`） SHALL `menuItems` を domain の `toMenuItem` で復号する（既存経路・`portions` の検査は domain に一度だけ書く）
3. WHEN 店舗 DO の永続投影が Stale_Projection である（`menuItems[].sizes[]` のいずれかが `portions` を持たない）, THE 店舗 DO SHALL 受領（`receiveRecords`）を `unprovisioned` で返し、番号（`lastSequenceByTerminal`）も品目集合も変えない（判断 6）。WS 接続と `config` 配信は従来どおり行う
4. THE 店舗 DO SHALL 在メモリの `menuItems` を `toMenuItems` に通して反映する（`adoptProjectionConfig`）。Stale_Projection では `portions` を持たない `sizes` 要素と、その結果 `sizes` が空になる `MenuItem` が落ちる——AC 5.3 の門があるので翻訳には使われないが、型が指す形と値を一致させる。永続は書き換えない（hydration は `Persist` を起こさない・`order-item-truncation` 判断 8）
5. WHEN レジストリが新しい投影（`portions` 形）を押し込む（`applyProjection`）, THE 店舗 DO SHALL 以後の受領を通常どおり確定する（Stale_Projection の判定は永続投影の値から導き、別の状態を持たない）
6. THE `WireOrderItem` SHALL `portions` を持つ。`toOrderItemFromWire` は `portions` が Portions の値域に無ければ Decode_Failure（既存の `slotSpan` の関門をそのまま写す）
7. THE サーバ SHALL 移行期間、`WireOrderItem` に Wire_SlotSpan（`slotSpan: slotSpanOf(portions)`）を送信時に併記する（判断 9）。新しい `toOrderItemFromWire` はこれを読まない（在っても無くても復号は同じ）。旧の復号器はこれで snapshot を落とさない
8. THE 併記の除去 SHALL 別 spec とし、条件は「全端末が新しいバンドルで動いていることの確認」とする（未決 5）
9. THE `TimerFact` / `Timer` / `ServerMessage` の他の種別 SHALL 変えない

### Requirement 6: 玉数を画面に見せる

**User Story:** As a 厨房スタッフ, I want 札に玉数が出る, so that 中盛・大盛の語を玉数へ読み替えずに済む。

#### Acceptance Criteria

1. THE client SHALL 玉数の数字を組む関数を一つ持ち（`queueDisplay.ts` の `portionsFigure`）、`1.5` / `2` / `0.5` の形（整数は小数点なし・単位なし）を返す
2. THE client SHALL 麺種の名と玉数の数字を一つのチップ（`NoodleChip`）に置き、麺種の色で塗る。チップの語は `{noodleType} {portions}`（例 `REG 1.5`）
3. THE `displayName` SHALL 玉数を含めない（品名は従来のまま）
4. THE 待ち行列の行（`OrderRail`）・ラジアルの帯（`RadialMenu`）・Orders 画面の札（`Card` / `BowlTile`） SHALL 品名の前にチップを置く。`BowlTile` のサイズの語は従来どおり（玉数を添えない）
5. THE 釜のバッジ（`SlotCard` の `NoodleBadge`） SHALL 上がり順のチップの隣に麺種と玉数のチップを置き、読み上げの語の末尾に `· {noodleType} {portions}` を添える。注文を持たない Timer は麺種だけ（玉数を持たない）
6. THE client SHALL 単位「玉」を画面に出さない（`offline-degradation` 要件 13.6 の例外は広げない）

### Requirement 7: 計画器

**User Story:** As a 設計者, I want 計画の入力が変わらない意味で続く, so that 玉数への置き換えで計画の質が変わらない。

#### Acceptance Criteria

1. THE engine の割当（`placeBatch` ほか）・上げ窓（`liftCap`・`Σ slotSpan`）・Acceptance_Gate（相異なる `slotSpan` 個の釜）・陳腐化判定 SHALL 導出した釜数で従来と同じ判定をする——同じ場面（設定を玉数へ写し替えたもの）で採否・配置・Effect が一致する
2. THE CP-SAT の `cpsatTargets` / モデル構築 / 観測（`spans` の内訳） SHALL 導出した釜数を用いる
3. THE `PlanRequest`（Queue の要求） SHALL `OrderItem` の新しい形（`portions`）を運ぶ。deploy を跨いだ飛行中の要求の計画は、`digest` の不一致で採用されない（観測事実 10）

### Requirement 8: ロールアウト

**User Story:** As a 運用者, I want deploy の手順が書いてある, so that 切り替えで注文を失わず、仮置きの玉数を現場に見せない。

#### Acceptance Criteria

1. THE tasks SHALL deploy の前に Idle_Precondition を**検証する**手順を持つ——Workers Logs で直近 `ORDER_LIFETIME_MS` の受領（`records-received`）と `Persist` が全店で 0 件であることを確かめる。満たさなければ deploy しない（仮置きの玉数が現場に表示されるのを防ぐ・判断 5）
2. THE tasks SHALL 玉数を持つ Policy `pos-menu` の JSON（`config/provisioning-sample/pos-menu-policy.json`・判断 11）をローカルの `validatePolicy` に通す手順を持つ
3. THE tasks SHALL 「アプリ Worker と CP-SAT 計画器 Worker を同じ変更で deploy する」「直後に `PUT /admin/policies/pos-menu` を投入し、全店の投影を作り直す」「`converge` の残作業が尽きたことを確かめる」を順に持つ
4. WHILE 投入前（Stale_Projection の間）, THE 店舗 DO SHALL 受領を `unprovisioned` で返し（AC 5.3）、上流の再送に委ねる。**注文は失われない**——番号が進まないので、投影の作り直し後の再送は初着として受理される。再送の窓は上流の再送規律（`ARRIVAL_WINDOW_MS`・2 時間）で、投入までの時間がそれより短いことを手順で確かめる
5. THE tasks SHALL 投入後に、任意の店舗で受領が `settled` で確定し、品目が `portions` 付きで載ること、client の `config` に `sizes[].portions` が載ることを確かめる手順を持つ

### Requirement 9: 検証可能な性質

1. **導出の単調性**：`p₁ ≤ p₂ ⇒ slotSpanOf(p₁) ≤ slotSpanOf(p₂)`
2. **導出の値域**：Portions の全値で `SLOT_SPAN_MIN ≤ slotSpanOf(p) ≤ SLOT_SPAN_MAX` かつ整数
3. **天井の意味**：`(slotSpanOf(p) − 1) × PORTIONS_PER_SLOT < p ≤ slotSpanOf(p) × PORTIONS_PER_SLOT`
4. **整数演算**：Portions の全値（0.5 刻み・18 値）で `slotSpanOf` の結果が有理数の天井と一致する（浮動小数の丸めで 1 ずれない）
5. **移行の占有保存**：v14 の品目（`slotSpan ∈ {1, 2}`）を v15 へ移行した結果の `slotSpanOf(portions)` は元の `slotSpan` に等しい。**v15 で `portions` を欠く品目は `MigrationFailed`**（版で分けた必須検査）
6. **釜数を保持しない**：`src/domain` の `OrderItem` / `NoodleSize` / `NoodleSpec` に `slotSpan` のフィールド宣言が無い（`WireOrderItem` の Wire_SlotSpan は送信時の任意項目として別に宣言し、復号器が読まないことを検査する）。`src` に `Math.ceil` で釜数を導く式が `slotSpanOf` の定義以外に無い（静的検査）
11. **古い投影は受領を止める**：Stale_Projection を持つ店舗 DO に Record を渡すと `unprovisioned` が返り、`lastSequenceByTerminal` と `orderItems` が変わらない。同じ Record を新しい投影の後に渡すと `settled` で確定し、品目が `portions` 付きで載る
12. **旧復号器との混在**：現行（deploy 前）の `toOrderItemFromWire` は、Wire_SlotSpan を併記した新しい snapshot を復号できる。新しい復号器は Wire_SlotSpan の有無で結果が変わらない（現行の復号器はテストの中に写しとして固定する）
7. **翻訳の透過**：`toNoodleSpec` が返す `portions` は同定した `NoodleSize.portions` に等しい（`noodle-spec.property` Property 4 の読み替え）
8. **ワイヤ往復**：`portions` を持つ `WireOrderItem` の符号化→復号が恒等
9. **拒否の網羅**：`validateNoodleSize` は `slotSpan` を未知フィールド、`portions` の欠落・非数・0.5 刻み外・値域外をそれぞれの理由で拒む
10. **計画の不変**：同じ場面で、設定を `slotSpan: k` から `portions`（1→1.0・2→2.0）へ写し替えた前後で `decide` の結果（状態・Effect）が一致する（既存の scene を使う回帰）

### naming ゲート（`naming.md`・**未承認**・task 0）

| 候補 | 表明する概念境界 | 却下案 |
| --- | --- | --- |
| `NoodleSize.portions` / `OrderItem.portions` / `NoodleSpec.portions` / `WireOrderItem.portions` | 麺の玉数（0.5 刻み）。設定と品目が同じ名で持つ同じ事実 | `balls`（口語・「玉」の直訳だが業務語として定着していない）／`noodleBalls`（冗長）／`tama`（ローマ字） |
| `PORTIONS_PER_SLOT`（1.5） | 1 釜に入る玉数の上限。釜（テボ）の物理 | `SLOT_CAPACITY_PORTIONS`／`MAX_PORTIONS_PER_SLOT`（「上限」を名に持つが、割る数として読むとき長い） |
| `PORTIONS_MIN` / `PORTIONS_MAX` | 玉数の値域（0.5 / 9） | — |
| `isPortions(value)` | Portions の述語（有限・0.5 刻み・値域内）。domain の predicate と同じ形 | `isValidPortions` |
| `slotSpanOf(portions)` | 玉数→釜数の導出。`occupiedSlotsOf` / `itemKeyOf` と同じ「Of」の形 | `slotSpanFor`／`requiredSlots`（`slotSpan` の語を捨てると読み手の変数名と食い違う） |
| `portionsLabel(portions)`（client） | 玉数の札 `1.5玉` | `formatPortions` |
| 要件語彙 `Portions` / `Slot_Occupancy_Rule` / `Migrated_Portions` | 上の各項 | — |

### 未決（design で決める・ユーザー確認を要するものは task 0 に含める）

1. ~~**Policy `pos-menu` の玉数の出所。**~~ → 解決（判断 11）。9/14 投入版（`cpsat-test` worktree の `experiments/cpsat-workers/fixtures/local/pos-menu-policy.json`）を元に、CSV の玉数で 39 コード、ユーザーの規則で 3 コードを埋めた。CSV にあって対応表に無い 10 コードは本 spec では触らない。
2. **`displayName` に玉数を添えるか。** 判断 7 は「添える」（釜の待ち行列の全ての札に出る）。札が長くなる代償がある。代案は Orders 画面の `BowlTile` だけ。
3. ~~**AC 5.3 の空白の可観測性。**~~ → 解決（判断 6）。空白の受領は `unprovisioned` として Worker が 5xx で数え、既存の観測に載る。落ちる品目は無い。
4. **`GET /admin/policies/{policyId}`。** スコープ外としたが、本 spec の投入で同じ欠陥を再び踏む。別 spec として立てるかの判断。
5. **Wire_SlotSpan の除去の時期。** 全端末が新しいバンドルで動いていることをどう確かめるか（client はバンドルの版を送らない）。除去は別 spec とし、確認の手段もそこで決める。
