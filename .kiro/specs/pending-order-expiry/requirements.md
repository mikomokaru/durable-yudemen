# Requirements Document

## Introduction

本 spec は、待ち行列（Pending_Order 集合）のうち **オーダー時刻から一定時間（既定 2 時間）を過ぎた品目を、計画と表示の対象から外す**。正本（StoreTimerDO の永続層）に持つ集合は変えず、**それを純粋関数で絞った値を「生きている待ち行列」として扱う**。計画・提案・snapshot・外部ソルバへの要求・変更費用の対応・開始の照合は、すべてこの絞った値だけを読む（ユーザー確定・2026-09-06）。

いまの仕組みでは Pending_Order が集合を離れる経路は「開始（Timer 化・`start.ts`）」と「POS の後着レコードで茹で対象 0 件（`receive.ts` の `removeOrder`）」の 2 つしかない。アプリを使わずに調理された注文、作られなかった注文は永遠に残る。本番（ユーザー不在・実オーダーを受信中）で待ち行列が積み上がり続けているのはこれで、放置すると (1) 到着順の先頭 64 件（`PLAN_TARGET_LIMIT`）を死んだ注文が占めて新しい注文が計画に入らない、(2) 先頭 arms 本の「今」が死んだ注文を指す、(3) snapshot と左レールが膨らみ続ける。

前提は `pos-order-ingress`（Record の受理・Pending_Order への翻訳・後着の全置換）、`online-cook-scheduling`（計画対象・指紋・ゲート）、`plan-stability`（Shown_Plan と変更費用の対応）。

### 観測事実（2026-09-06・main `Merge #33` 時点）

1. `TimerState.pendingOrders`（`state.ts:35`）が正本で、snapshot（`snapshot.ts:63`）はそのまま永続する。品目を集合から除くのは `start.ts:215`（開始で消費）と `receive.ts:67-69`（後着で全置換・0 件なら除去）だけ。
2. `PendingOrder.arrivalTime` は **上流の観測時刻**（`store-timer-do.ts:256`・`record.arrivalTimestampMs`）で、DO の受理時刻ではない（`pos-order-ingress` AC 8.1〜8.4：受理時刻は再送ごとに動き、`payload.datetime` は券売機の時計の申告値）。同じ注文の後着は既存の最早の `arrivalTime` を引き継ぐ（`pending.ts:28`・AC 1.8）。ゆえに「オーダー時刻」に最も近い事実は `arrivalTime` である。
3. 待ち行列を読む場所は 6 つ。(a) 計画対象 `planTargets(pending)`（`schedule.ts:396`。到着順の先頭 64 件。呼び手は `schedule.ts:366` の自前解・`commit.ts:69` の合成・`admit.ts:137` の陳腐化判定・`digest.ts:82` の指紋・`settle.ts:111` の要求抑制）。(b) snapshot の `pendingOrders`（`settle.ts:350`・hydration も同じ `toWireSnapshot`）。(c) 外部ソルバへの要求 `RequestPlan.pending`（`plan.ts:74`）と受領時の照合（`plan.ts:79, 89`）。(d) 変更費用の対応 `ChangeContext.pending`（`settle.ts:331`）。(e) 開始の照合 `start.ts:154`（待ち行列に無ければ `OrderItemNotFound` で拒否——他端末が直前に開始した場合の正常な競合として既に在る経路）。(f) client の左レール `queueDisplay.ts:128`（wire の `pendingOrders` を到着順に並べ、`correctedNow − arrivalTime` を待ち時間として出す）。
4. すべての遷移は `now` を持つ（`settle(…, now, …)`・`receive.ts:74`）。hydration も `toWireSnapshot(state, params, now)` で `now` を持つ。client は `correctedNow`（サーバ時計への補正）を持つ（`queueDisplay.ts:119`）。
5. no-op 検出（`settle.ts:193`・`isSamePending`）は正本の集合を比べる。指紋（`digest.ts:82`）は計画対象から導く（時刻は畳まない）。
6. Operation History の観測値は `ReceiveCounts`（`doDedupeSkipped` / `unknownNoodleType`・`store-timer-do.ts:943`）として受理の応答で運ぶ。
7. StoreTimerDO を起こす経路は fetch / WebSocket / 既存の Timer Alarm だけで、観測目的の起動を持たない（`operation-history-log`・`no-wake.static`）。
8. **走行中 Timer は待ち行列を読まない。** 開始（`start.ts:176-215`）は品目の `noodleType` / `firmness` / 茹で秒（プリセットから `endTime` へ）/ `orderItem { externalOrderId, itemIndex, tableId }` を Timer へ写し、同じ遷移で待ち行列から消費する（`consumeOrder`）。その後の発火・完了・調整・キャンセル・Boil_Sync・卓の成員表（`project.ts` の `tableMembers` は `timer.orderItem.tableId` を読む）は `pendingOrders` を一度も参照しない。wire の `TimerFact` も待ち行列を参照しない（client が Timer の表示に `pendingOrders` を引く箇所は無い）。

### 確定した設計判断（2026-09-06 の対話で確定）

1. **正本は変えず、絞った値を正とする（ユーザー確定）。** 期限は状態を書き換える出来事ではなく、`now` から導く述語である。永続層の `pendingOrders` はそのまま持ち、**「生きている待ち行列」＝ `pendingOrders` を純粋関数 `Live_Orders(pending, now)` で絞った値** を計画・表示・要求・照合のすべてが読む。専用の Alarm は張らない（新しい wake 源を増やさない・観測事実 7）。静かな店で数時間イベントが無くても、次に読む時点の `now` で絞られるので、正本に残っていることは観測されない。
2. **期限の起点は `arrivalTime`、幅は定数。** `arrivalTime + Order_Lifetime ≤ now` なら期限切れ（半開区間：ちょうど幅の時点で切れる）。幅は既定 2 時間の定数で、設定にはしない（店舗差が実在したときに設定へ上げる。`liftIntervalSeconds` と同じ立場）。同じ注文の後着が最早の `arrivalTime` を引き継ぐ規則（観測事実 2）はそのまま——2 時間前の注文を変更する Record が届いても生き返らない。
3. **絞る場所は「読む側」の入口一つずつで、述語は一つ。** 計画対象（`planTargets`）・snapshot・要求・変更費用の対応・開始の照合が、それぞれの `now` で同じ述語を呼ぶ。client も同じ述語を `correctedNow` で呼ぶ（次の snapshot を待たずに、時刻が来たら左レールから消える）。述語は domain に置き、engine と client が共有する（`lift-group.ts` の Head の導出と同じ規律）。
4. **期限切れは「消えた品目」として扱う。** 変更費用の対応（`plan-stability` 判断 3）で「開始済み・キャンセル済み・新規は費用を動かさない」に「期限切れ」を加える。外部計画が期限切れの品目を指せば、計画対象と一致しないので既存の `isStale` が棄却し、合成の尾部が自前解で埋める。期限切れの品目への開始は、待ち行列に無い品目への開始と同じ `OrderItemNotFound` で拒否する（新しい拒否事由は足さない）。
5. **指紋は絞った計画対象から導く。** 品目が期限を過ぎると計画対象が変わり、次の遷移で指紋が変わって要求が出る。これは「入力が変わった」そのものであり、抑制しない。
6. **走行中は待ち行列に依存せず自立する（ユーザー確定）。** 調理中に注文が 2 時間を過ぎても、走行中 Timer と同じ卓の合流の錨は変わらない。これは既に成り立っている（観測事実 8：開始が値を Timer へ写し、以後どの遷移も待ち行列を読まない）ので新しい構造は足さず、**本 spec で性質として固定する**——期限切れが走行中に一切影響しないことをテストで守る。
### スコープ外

- 正本（永続層）からの物理的な除去。絞った値が正なので、残っていることは観測されない（未決 1 に整理の選択肢を残す）。
- 期限切れの通知・一覧（「2 時間前に来て作られていない注文」を見せる UI）。観測値として数えるかは未決 2。
- 走行中 Timer・茹で上がり・Boil_Sync。事実であり期限は無い。
- 幅の設定化・店舗ごとの値。

## Glossary

- **Live_Orders（生きている待ち行列）**: `pendingOrders` のうち `arrivalTime + Order_Lifetime > now` の品目だけを到着順に残した値。純粋関数の導出値で、状態には持たない。計画・表示・要求・照合が読む唯一の待ち行列。
- **Order_Lifetime（注文の寿命）**: 期限の幅。既定 2 時間の定数（ミリ秒）。
- **Expired_Order（期限切れの品目）**: `pendingOrders` に在るが Live_Orders に無い品目。正本には残るが、どこからも読まれない。
- **Pending_Order**: `pos-order-ingress` の語彙のまま（未着手オーダーの 1 品目・正本は永続層）。

## Requirements

### Requirement 1: 生きている待ち行列の導出

**User Story:** As a 設計者, I want 待ち行列を読む場所が一つの述語で絞られている, so that 死んだ注文が計画にも表示にも現れない。

#### Acceptance Criteria

1. THE domain SHALL 純粋関数 `Live_Orders(pending, now)` を一つ持ち、`arrivalTime + Order_Lifetime > now` の品目だけを、入力の並びを保って返す（並び替えない・重複を作らない・入力を変えない）
2. THE `Live_Orders` SHALL `now` と `pending` だけに依存する（Timer・設定・前回の計画を読まない）
3. THE `Order_Lifetime` SHALL 2 時間の定数であり、店舗設定・ワイヤ・環境変数のいずれからも読まない
4. WHEN `arrivalTime + Order_Lifetime` がちょうど `now` に等しいとき、THE `Live_Orders` SHALL その品目を含めない（半開区間。境界の 1 ms を二度定義しない）
5. THE `TimerState.pendingOrders` と永続 snapshot SHALL 変えない（期限は状態を書き換えない・永続スキーマの版は上げない）

### Requirement 2: 読む側の入口で絞る

**User Story:** As a 設計者, I want 計画・提案・要求・照合が同じ生きている待ち行列を読む, so that どこかで死んだ注文が復活しない。

#### Acceptance Criteria

1. THE 計画対象 `planTargets` SHALL `now` を受け、`Live_Orders` の到着順の先頭 `PLAN_TARGET_LIMIT` 件を返す（絞ってから切る。切ってから絞れば死んだ注文が枠を食う）
2. THE snapshot（確定結果の Broadcast と hydration の両方） SHALL `pendingOrders` に `Live_Orders(state.pendingOrders, now)` を載せる（正本の集合そのものは載せない）
3. THE 外部ソルバへの要求 `RequestPlan.pending` SHALL `Live_Orders` を運ぶ。受領時の照合（`isStale`・合成）は受領時刻の `Live_Orders` に対して行う
4. THE 変更費用の対応（`ChangeContext.pending`） SHALL `Live_Orders` を渡す。期限切れの品目は対応から外れ、費用に倒れない（`plan-stability` 判断 3 の「消えた品目」）
5. WHEN 期限切れの品目への開始（`StartOrderItem`）が届いたとき、THE engine SHALL 既存の `OrderItemNotFound` で拒否する（`Live_Orders` に無い品目は待ち行列に無い品目である）
6. THE 指紋（`digestInput`） SHALL 絞った計画対象から導く。品目の期限切れで計画対象が変われば指紋が変わり、次の遷移で要求が出る
7. THE no-op 検出（`isSameConfirmedResult` / `isSamePending`） SHALL 正本の集合の比較のままとする（期限切れは状態の変化ではない。読む側で絞るので、no-op の遷移でも次の読み手は絞った値を見る）
8. THE 受理（`arriveRecords` / `upsertOrder` / `removeOrder`） SHALL 変えない。期限切れの注文の後着も正本へは従来どおり写す（最早の `arrivalTime` を引き継ぐので Live_Orders には現れない）。重複排除の材料は従来どおり進める

### Requirement 3: client も同じ述語で絞る

**User Story:** As a 現場, I want 2 時間過ぎた注文が次の snapshot を待たずに消える, so that 静かな時間帯に死んだ注文が残らない。

#### Acceptance Criteria

1. THE client の左レール（`queueDisplay`） SHALL wire の `pendingOrders` を `Live_Orders(pendingOrders, correctedNow)` で絞ってから並べる（サーバは既に絞って送るが、snapshot の後に時刻が進んで切れる品目は client が消す）
2. THE client SHALL domain の同じ述語を呼ぶ（client 側に別の式を書かない）
3. WHEN 推奨（`recommendations`）が指す品目が client の `Live_Orders` に無いとき、THE client SHALL その推奨を表示しない（既存の「待ち行列に無い推奨は捨てる」経路・`queueDisplay.ts:72` の `pendingItemOf` と同じ扱い）

### Requirement 4: 走行中の自立

**User Story:** As a 現場, I want 調理中の麺が注文の期限に左右されない, so that 2 時間を跨いだ調理が最後まで成立する。

#### Acceptance Criteria

1. THE 走行中 Timer SHALL 開始時に写した値（`noodleType` / `firmness` / `startTime` / `endTime` / `slotIds` / `orderItem`）だけで成立し、発火・完了・調整・キャンセル・Boil_Sync・Alarm・卓の成員表のいずれも `pendingOrders` を読まない（既存の構造を性質として固定する。新しい写しは足さない）
2. WHEN 走行中 Timer の由来する注文の `arrivalTime + Order_Lifetime` が `now` を過ぎたとき、THE engine SHALL その Timer・その卓の錨（`tableMembers`）・Alarm・Boil_Sync の結果を一切変えない
3. WHEN 同じ卓の未着手の品目が期限切れになったとき、THE 走行中 Timer SHALL 影響を受けず、残った生きている品目だけがその錨に合流する（期限切れの品目は「消えた品目」・判断 4）
4. THE `TimerFact`（wire） SHALL 待ち行列を参照せず、client は Timer の表示に `pendingOrders` を引かない（現状維持を明記）

### Requirement 5: 検証可能な性質

1. **冪等**：`Live_Orders(Live_Orders(p, t), t) = Live_Orders(p, t)`
2. **単調**：`t1 ≤ t2` なら `Live_Orders(p, t2) ⊆ Live_Orders(p, t1)`（時間が進んで生き返らない）
3. **並び**：`Live_Orders` は入力の相対順序を保つ
4. **枠**：期限切れの品目が到着順の先頭にどれだけ在っても、計画対象は生きている品目の先頭 64 件（死んだ注文が枠を食わない）
5. **一致**：確定結果の snapshot の `pendingOrders` と、その `now` の `Live_Orders(state.pendingOrders, now)` は等しい
6. **無害**：期限切れの品目だけが在る待ち行列は、空の待ち行列と同じ計画・同じ snapshot の `pendingOrders`・同じ要求抑制（要求しない）になる
7. **不変**：期限切れの品目の有無は `TimerState.pendingOrders` と永続 snapshot を変えない
8. **client の一致**：wire の `pendingOrders` と `correctedNow` から client が並べる左レールは、同じ `now` で server が絞った並びと同じ集合を指す
9. **走行中の自立**：任意の状態で、待ち行列の全品目を期限切れにしても（`now` を十分進める、または `arrivalTime` を十分戻す）、走行中 Timer の集合・実効 endTime・Alarm・`tableMembers` は変わらない

### naming ゲート（`naming.md`）

| 候補名 | 場所 | 表明する概念境界 |
| --- | --- | --- |
| `Live_Orders` / `liveOrders`（仮） | 要件語彙 / `src/domain/order.ts` | 期限で絞った待ち行列（導出値） |
| `Order_Lifetime` / `ORDER_LIFETIME_MS`（仮） | 要件語彙 / `src/domain/order.ts` | 期限の幅（定数） |
| `Expired_Order`（仮） | 要件語彙のみ | 正本に残るが読まれない品目 |

### 未決（design で決める）

1. **正本の整理。** 絞った値が正なので、永続層の期限切れ品目は残しても観測されない。ただし集合は伸び続ける。(a) 残す（本 spec は触らない・最も単純）、(b) 確定結果の `Persist` が出る遷移でだけ、ついでに期限切れを落とす（自分では `Persist` を起こさない。no-op 検出は落とす前の集合で行う）。推奨は (a) で始め、実機で Persist のサイズが問題になったら (b)。
2. **観測値。** 期限切れの件数を Operation History に数えるか。純粋な述語なので「切れた瞬間」のイベントは無く、数えるなら snapshot を組む時点の `pendingOrders.length − Live_Orders.length`。推奨は数えない（切れたことは業務上の事実ではなく、読まれないだけ）。
3. **時計のずれ。** `arrivalTime` は上流の時計、`now` は DO の時計。ずれが幅（2 時間）に対して無視できる前提を design に明記する（`pos-order-ingress` が既に受理時刻より上流の観測時刻を選んだ判断の延長）。
