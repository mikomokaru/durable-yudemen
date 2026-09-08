# Requirements Document

## Introduction

本 spec は、注文品目の正本（`TimerState.orderItems`）に **件数の上限を作り込み**、上限を超えた分を古い順に忘れる。上限は集合を増やす唯一の経路の出口で効かせ、掃除のための専用の遷移・Alarm・別の鍵を作らない——**上限を超えた集合が構造的に存在しない**（ユーザー確定・2026-09-08）。

`order-lifecycle`（#38・ADR-0013）で品目を「開始で消費せず生涯を通じて残す」に改めた時点から、`orderItems` は実質的に減らなくなった。集合を離れる経路は「POS の取消・0 件の後着（`removeOrder`）」と「後着に現れなかった品目」の 2 つだけで、**いずれも未調理の品目に限る**。`completedAt` を持つ品目は永久に残る。`pending-order-expiry` が入れた期限（`ORDER_LIFETIME_MS` = 2 時間）は**読む側の述語**であって正本を変えない（判断 1）ので、期限切れの品目も永続層には残り続ける。

正本は単一キーへ丸ごと永続され（`store-timer-do.ts:1152`）、確定のたびに全体が書き直される。ゆえに集合が伸びることは (1) いつか永続の値の上限に当たって `Persist` が落ち、以後いっさい確定できなくなる、(2) それ以前に、すべての遷移が肥大した blob の直列化を払い、hydration が同じ量の parse を払う、という 2 つの形で効く。

前提は `order-lifecycle`（品目の生涯・`completedAt` / `interruptedAt`・永続 v13）、`pending-order-expiry`（期限は読む側の述語・正本は変えない）、`pos-order-ingress`（Record の受理・後着・`arrivalTime` の引継ぎ）。

### 観測事実（2026-09-08・main `Merge #41` 時点）

1. 正本は `TimerState.orderItems`（`state.ts:41`）。`toSnapshot` がそのまま永続へ写し（`snapshot.ts:63`）、DO は単一キーへ丸ごと `put` する（`store-timer-do.ts:1152`）。確定のたびに集合の全体が書き直される。
2. **集合を増やす経路は `upsertOrder`（`pending.ts:50`）ただ一つ。** `removeOrder`（`pending.ts:101`）は縮めるだけ、`complete`（`complete.ts:52`）と `cancel`（`cancel.ts:52`）は既存の要素に厨房の事実を書くだけで件数を変えない、`start`（`start.ts:157`）は照合するだけで消費しない（order-lifecycle 判断 1）。ほかに集合を組むのは `EMPTY_STATE`（`state.ts:69`）と `migrate`（`migrate.ts:81` の `reviveOrderItems`）の 2 箇所で、いずれも「新たに作る」ではなく「空」と「復元」である。
3. 集合が**縮む**経路は 2 つだけで、どちらも `unstarted` の品目に限る——`removeOrder`（POS 取消・0 件の後着）と、後着に現れなかった同じ注文の未調理品目（`pending.ts` 規則 3）。`cooking` / `done` は残す（order-lifecycle AC 2.5：参照整合と履歴のため）。**`completedAt` を持つ品目を除く経路は存在しない。**
4. 状態の他の成員はすべて有界である。`timers` は `MAX_TIMERS` = 100（`types.ts:27`）で上限が拒否として働き、complete / cancel で除去される。`acceptedSlices` は `PLAN_TARGET_LIMIT` = 64（`schedule.ts:281`）の計画対象から組まれ、採用のたびにまるごと差し替わる。`shownPlan` は計画の大きさ。`lastSequenceByTerminal` は端末数（台帳を持たない・`state.ts` の注記）。**伸び続けるのは `orderItems` ただ一つ。**
5. 永続の値の上限は **2 MB（key + value 合わせて）**。`StoreTimerDO` は SQLite バックエンド（`wrangler.jsonc:63` の `new_sqlite_classes`）であり、Cloudflare の Durable Objects limits は SQLite backed で「key と value 合わせて 2 MB」「1 オブジェクト 10 GB」、KV backed で「key 2 KiB / value 128 KiB」。`yude-men-timer/design.md:523` の容量の見積り（「Timer 100 件 ≒ 15 KB。KV 値サイズ制限（KV バックエンドで 128 KiB）に対し十分小さい」）は **backend を移した時点で更新されないまま残った記述**であり、上限も前提（Timer だけが状態に居た頃の集合）も現状と合わない。本 spec で訂正する。
6. 代表的な `OrderItem`（日本語の商品名・麺量・卓・完了時刻つき）は JSON で **279 バイト**（実測 2026-09-08）。2 MB は約 7,500 件に相当する。1 日 900 件（300 注文 × 3 品）の店で 8 日。
7. `itemName` / `sizeName` / `externalOrderId` / `noodleType` / `tableId` は **長さを検証していない**（`toDeclaredName`・`predicate.ts:66` は「空でない文字列か」だけを見る。`itemName` / `sizeName` は Pass_Through で正規化もしない）。ゆえに **件数はバイト数の代理でしかなく、279 B は代表値であって最悪値ではない**。
8. **参照先の無い Timer を扱う経路は既に在る。** `orderItemOf`（`order.ts:238`）は参照先が集合に無ければ null を返し、釜のカードは麺種だけで表示し、`complete`（`complete.ts:53`）と `cancel`（`cancel.ts:53`）は品目に何も書かずに Timer を閉じる。v12 由来の Timer とアドホック開始が既にこの経路を通っている（order-lifecycle 判断 13：参照先の無い Timer を扱う経路は一つ）。
9. `pending-order-expiry` の未決 1 が本件を予告している——「正本の整理。…集合は伸び続ける。(a) 残す（本 spec は触らない・最も単純）、(b) 確定結果の `Persist` が出る遷移でだけ、ついでに期限切れを落とす。**推奨は (a) で始め、実機で Persist のサイズが問題になったら (b)**」。本 spec はその (b) を、期限ではなく**件数**で、しかも別の遷移としてではなく**集合の構築点そのもの**で行う。
10. no-op 検出は `isSameOrderItems`（`pending.ts:182`・`settle.ts:196`）が正本の集合を比べる。集合が縮めば普通に差分となり、`Persist` と `Broadcast` が立つ。
11. 集合の並びは**到着順ではない**。`upsertOrder` は既存の品目を元の位置のまま更新し、新しい品目は当該注文の末尾へ挿す（並びが揺れると内容の同じ再送が差分に見えるため）。到着順の全順序は `compareArrival`（`order.ts:117`・`arrivalTime` 昇順, `externalOrderId` 昇順, `itemIndex` 昇順）として別に在り、`planTargets` が読む側で整列する。

### 確定した設計判断（2026-09-08 の対話で確定）

1. **上限は集合に作り込む（ユーザー確定）。** 「古いものを掃除する」別の仕掛け（専用の遷移・Alarm・起動時のパス・別の鍵）を作らず、**集合を増やす唯一の経路（`upsertOrder`）の出口で上限を効かせる**。観測事実 2 のとおり件数を増やすのはここだけなので、これだけで集合は構造的に有界になる。掃除を別の出来事にすれば「掃除が走ったか否か」という第 2 の状態が生まれ、走っていない時間帯の振る舞いを別に語ることになる——上限が集合の性質であれば、語ることは一つで済む。
2. **上限は件数だけ（ユーザー確定）。** 時間窓による truncate は行わない。期限（`ORDER_LIFETIME_MS`）は `pending-order-expiry` 判断 1 のまま**読む側の述語**として残し、正本には効かせない。期限と保持は別の関心である——期限は「現場に見せるか」、保持は「永続に載るか」。
3. **忘れる順は古い順だけで、何も守らない（ユーザー確定）。** `cooking`（生きた Timer の参照先）も例外にしない。守る述語を一つ入れれば「上限を超えているのに落とせない」場面が生まれ、上限が上限でなくなる。落ちた場合の振る舞いは既に在る経路（観測事実 8）に落ちるだけで、新しい経路も新しい拒否も要らない。実務上は上限（4096）が `MAX_TIMERS`（100）の 40 倍あり、`cooking` が落ちるのは「4096 件の新規到着が走行中を追い越す」場面に限られる。
4. **上限は 4096 件（ユーザー確定）。** 代表値 279 B で 1.09 MB、長めの商品名（400 B）でも 1.56 MB で、2 MB のハード上限に収まる。4〜5 日分の履歴に相当する。文字列長が検証されていない（観測事実 7）以上、件数はバイト数の厳密な保証ではない——4096 は「代表値の 1 桁上のハード上限に対して、長めの入力でも収まる最大の 2 冪」として選んだ値である。
5. **「古い」は `compareArrival` で測り、残る品目の並びは変えない。** 集合の並びは到着順ではない（観測事実 11）ので、落とす対象の選定にだけ既存の全順序を使い、生き残った品目は入力の相対順序のまま返す。並べ替えれば内容の同じ再送が差分に見えて空振りの `Persist` / `Broadcast` を呼ぶ（`upsertOrder` が位置を保つのと同じ理由）。
6. **永続スキーマの版は上げない。** 集合の**形**は変わらない（要素の型も鍵も同じ）。変わるのは要素数の上界だけである。既存の v13 データが上限を超えていても移行は失敗せず、復元した時点で上限が当たる。
7. **上限は拒否事由にしない。** `MAX_TIMERS` が「これ以上は始められない」という現場への回答であるのに対し、注文の到着は現場が断れる出来事ではない。上限に当たった到着は受理され、代わりに最も古い品目が静かに落ちる。

### スコープ外

- **時間窓による正本の整理**（判断 2）。期限は読む側の述語のまま。
- **落とした品目の外部保存。** Operation History は Timer の操作（`boil-started` / `boiled` / `adjusted` / `completed` / `cancelled`）を既に tail から出しており、調理の履歴はそちらに在る。注文品目そのものを別の保管先へ流すことは本 spec では扱わない（未決 3）。
- **文字列長の検証**（観測事実 7）。バイト数を厳密に有界にするなら `itemName` 等に長さの上限を置くか、件数ではなくバイト予算で切ることになるが、いずれも別の関心である（未決 2）。
- **状態の他の成員**（観測事実 4）。すべて有界であり、本 spec は触らない。
- **上限に達したことの通知・UI。**

## Glossary

- **Order_Item_Limit（品目の上限）**: 正本 `TimerState.orderItems` が持てる件数の上限。4096 の定数。
- **Truncation（忘れる）**: 上限を超えた分を、`compareArrival` で最も古いものから落とすこと。正本を書き換える操作であり、`pending-order-expiry` の期限（読む側の述語）とは別の機構である。
- **Forgotten_Item（忘れられた品目）**: 上限超過で正本から落ちた品目。永続にも snapshot にも現れず、それを指す Timer は「参照先なし」として扱われる。

## Requirements

### Requirement 1: 上限を当てる純粋関数

**User Story:** As a 設計者, I want 上限を当てる規則が一つの純粋関数に閉じている, so that 集合が有界であることを一箇所で読める。

#### Acceptance Criteria

1. THE engine SHALL 純粋関数 `Truncate(items)` を一つ持ち、`items.length ≤ Order_Item_Limit` ならそのまま、超えるなら `compareArrival` で最も古い `items.length − Order_Item_Limit` 件を落とした値を返す
2. THE `Truncate` SHALL 生き残った品目の**相対順序を入力のまま保つ**（並べ替えない・重複を作らない・要素の内容を変えない）
3. WHEN `items.length ≤ Order_Item_Limit` のとき、THE `Truncate` SHALL **入力と同じ配列インスタンス**を返す（`liveOrders` / `pendingOrders` と同じ理由：参照同値で空振りの差分を作らない）
4. THE `Truncate` SHALL `items` だけに依存する（`now`・Timer・設定・前回の計画を読まない）。時刻を読まないことが、期限（読む側の述語）と保持（正本の性質）を別の関心として分ける
5. THE `Order_Item_Limit` SHALL 4096 の定数であり、店舗設定・ワイヤ・環境変数のいずれからも読まない（`ORDER_LIFETIME_MS` / `MAX_TIMERS` と同じ立場）
6. WHEN 落とす対象の選定で `compareArrival` が同値になる品目が在るとき、THE `Truncate` SHALL 決定的に断つ（`compareArrival` は `arrivalTime` / `externalOrderId` / `itemIndex` の 3 段で全順序であり、同値は同一の鍵を意味する。集合に同一の鍵は在りえない）

### Requirement 2: 増やす経路に作り込む

**User Story:** As a 設計者, I want 上限を超えた集合が存在しない, so that 「掃除が走ったか」を別に語らずに済む。

#### Acceptance Criteria

1. THE `upsertOrder` SHALL 返す前に `Truncate` を通す（集合を増やす唯一の経路・観測事実 2）。冪等（AC 1.3）ゆえ、上限以下の通常の到着では戻り値も参照同値の判定も従来どおりである
2. THE `migrate` SHALL 復元した `orderItems` に `Truncate` を通す（起動時に上限超過の集合を持ち込まない）。これにより「状態が上限を超えることはない」は条件つきの主張でなくなり、**すべての構築点が上限を通る**という機械的に検査できる形になる
3. THE `complete` / `cancel` / `removeOrder` / `start` SHALL 変えない（件数を増やさないので上限を当てる理由がない・観測事実 2）
4. THE 静的検査 SHALL `TimerState.orderItems` を組む場所が `EMPTY_STATE`・`upsertOrder`・`migrate` の 3 箇所に限られることを守る（新しい構築点が上限を迂回して増えることを防ぐ）
5. THE engine SHALL 掃除のための専用の遷移・Alarm・起動経路・永続の鍵を持たない（判断 1・`pending-order-expiry` 判断 1 の「新しい wake 源を増やさない」を引き継ぐ）

### Requirement 3: 忘れることの帰結

**User Story:** As a 現場, I want 品目が忘れられても釜と操作が壊れない, so that 上限が現場の事故にならない。

#### Acceptance Criteria

1. WHEN 生きた Timer の参照先が忘れられたとき、THE engine と client SHALL 既存の「参照先なし」経路を通る（`orderItemOf` が null・釜のカードは麺種だけで表示・`complete` / `cancel` は品目に何も書かず Timer を閉じる・観測事実 8）。**新しい経路も新しい拒否事由も足さない**（order-lifecycle 判断 13）
2. WHEN 忘れられた未調理の品目への `StartOrderItem` が届いたとき、THE engine SHALL 既存の `OrderItemNotFound` で拒否する（集合に無い品目は集合に無い品目である・`pending-order-expiry` AC 2.5 と同じ扱い）
3. THE engine SHALL 上限超過を拒否事由にしない（判断 7）。到着は上限に関わらず受理され、重複排除の材料（`lastSequenceByTerminal`）も従来どおり進む
4. WHEN 忘れられた注文の後着が届いたとき、THE engine SHALL 引き継ぐ起点が無いので新しい `arrivalTime` で入れ直す。これは `earliestArrival`（`pending.ts:158`）の既存の規則の帰結であり、**本 spec は「生き返らない」ことを保証しない**（`pending-order-expiry` AC 2.8 と同じ立場。4096 件先の後着は現実の運用に無い）
5. THE 忘れられた品目 SHALL snapshot にも wire にも現れない（`orderItemsToBroadcast` は正本を絞るので、正本に無いものは載らない。読む側は変更しない）

### Requirement 4: 永続と no-op

**User Story:** As a 運用者, I want 既に膨らんだ本番の状態が壊れずに縮む, so that 移行のための手順が要らない。

#### Acceptance Criteria

1. THE 永続スキーマの版 SHALL 上げない（`CURRENT_SCHEMA_VERSION` は 13 のまま）。集合の形は変わらず、変わるのは要素数の上界だけである（判断 6）
2. WHEN 上限を超える件数を持つ v13 のデータを読んだとき、THE `migrate` SHALL 成功し（`MigrationFailed` にせず）、上限を当てた集合で復元する
3. THE no-op 検出（`isSameOrderItems` / `isSameConfirmedResult`） SHALL 変えない。上限で集合が縮めば普通に差分となり、`Persist` と `Broadcast` が立つ（観測事実 10）
4. THE snapshot / wire / client SHALL 変えない（正本が縮むことは読む側から見れば品目が消えることであり、既に扱える）

### Requirement 5: 検証可能な性質

1. **有界**：任意の入力に対し `Truncate(items).length ≤ Order_Item_Limit`
2. **冪等**：`Truncate(Truncate(items)) = Truncate(items)`
3. **部分集合**：`Truncate(items) ⊆ items`（要素の内容を変えない）
4. **並び保存**：`Truncate(items)` の相対順序は `items` の相対順序に一致する
5. **恒等**：`items.length ≤ Order_Item_Limit` なら `Truncate(items)` は `items` と同じ参照
6. **落とすのは最も古い k 件**：落ちた品目はいずれも、残った品目のすべてより `compareArrival` で真に古い
7. **決定性**：同じ入力に同じ出力（入力の並びを変えても、落ちる**集合**は同じ）
8. **状態の有界性**：連続処理の harness で任意の系列の到着・開始・完了・キャンセル・後着・外部計画の受領を与えても、`TimerState.orderItems.length ≤ Order_Item_Limit` が常に成り立つ（構築点が 3 箇所に限られることの帰結を、実走で確かめる）
9. **永続の上界**：4096 件の代表的な品目 + `MAX_TIMERS` の Timer + `PLAN_TARGET_LIMIT` の `acceptedSlices` + `shownPlan` を持つ状態の `JSON.stringify` が 2 MB を下回る（実測値を tasks に記録し、回帰として固定する）
10. **走行中の自立**：品目が忘れられても、走行中 Timer の集合・実効 endTime・Alarm・`tableMembers`・Boil_Sync の結果は変わらない（`pending-order-expiry` 性質 5.9 と同じ線。忘却は品目の消失であり、Timer は開始時に写した値だけで成立する）

### naming ゲート（`naming.md`）

| 候補名 | 場所 | 表明する概念境界 |
| --- | --- | --- |
| `Order_Item_Limit` / `ORDER_ITEM_LIMIT`（仮） | 要件語彙 / `src/engine/pending.ts` | 正本が持てる件数の上限（定数） |
| `Truncate` / `truncateOrderItems`（仮） | 要件語彙 / `src/engine/pending.ts` | 上限を当てる純粋関数（正本を縮める唯一の規則） |
| `Forgotten_Item`（仮） | 要件語彙のみ | 上限超過で正本から落ちた品目 |

置き場所について。`ORDER_LIFETIME_MS` / `liveOrders` が `src/domain/order.ts` に在るのは client と engine が**同じ線を引く**必要があるためだが、上限は永続側だけの関心で client は当てない（当てる意味がない——wire に載るのは既に絞られた集合である）。ゆえに `upsertOrder` と同じ `src/engine/pending.ts` に置き、`migrate` がそこから import する。domain へ置く案は「`compareArrival` が domain に在る」ことを理由にできるが、共有されない概念を共有の場所に置けば、client 側から「なぜ当てないのか」を毎回問うことになる。**design で確定する（未決 1）。**

### 未決（design で決める）

1. **`Truncate` の置き場所。** `src/engine/pending.ts`（推奨・上の理由）か `src/domain/order.ts`（`compareArrival` と同居）か。`domain-imports` の静的検査と `offline-degradation.static` の確定集合（`src/engine` を列挙する）への影響を design で確かめる。
2. **バイト予算という代替。** 件数ではなく直列化後のバイト数で切れば、文字列長が未検証（観測事実 7）でも真に有界になる。判断 4 は件数を選んだが、`itemName` 等に長さの上限を置く別 spec と合わせて再考する余地を記録する。推奨は現状のまま（件数は決定性の検査が容易で、バイト予算は直列化の実装に性質が依存する）。
3. **忘れた件数の観測値。** `upsertOrder` が落とした件数を Operation History に数えるか。上限に当たり続けている店を運用側が知れる価値はあるが、`ReceiveCounts` に項目を足すことになる。推奨は数えない（上限は設計上の定常状態であり、異常ではない）。
4. **起動時の適用を `Persist` まで行うか。** AC 2.2 は復元した集合に上限を当てるが、それ自体では書き込まない（次の確定に乗る）。上限超過の状態がしばらく永続に残ることを許すか、hydration で 1 回だけ確定するかを design で決める。推奨は前者（hydration が `Persist` を起こさない現在の規律を壊さない）。
5. **`yude-men-timer/design.md:523` の訂正の形。** backend（SQLite）・上限（2 MB）・現在の状態の構成（Timer だけでなく `orderItems` / `acceptedSlices` / `shownPlan`）を反映した見積りへ改訂注記で置き換える。ADR を立てるか注記で足りるかを design で判断する。
