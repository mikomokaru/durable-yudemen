---
status: accepted
date: 2026-09-06
specs: pending-order-expiry
---

# 待ち行列の正本は変えず、純粋関数で絞った値（Live_Orders）を正として計画と表示から期限切れを外す

Pending_Order が集合を離れる経路は「開始（Timer 化）」と「POS の後着で茹で対象 0 件」の 2 つしか無かった。アプリを使わずに調理された注文、作られなかった注文は永遠に残る。本番で待ち行列は積み上がり続け、(1) 到着順の先頭 64 件（`PLAN_TARGET_LIMIT`）を死んだ注文が占めて新しい注文が計画に入らず、(2) 先頭 arms 本の「今」が死んだ注文を指し、(3) snapshot と左レールが膨らみ続ける。

**期限は状態を書き換える出来事ではなく、`now` から導く述語である。** 正本（`TimerState.pendingOrders`・永続 v12）はそのまま持ち、`src/domain/order.ts` の純粋関数 `liveOrders(pending, now)`——`arrivalTime + ORDER_LIFETIME_MS > now` の品目だけを入力の並びのまま残す（半開区間・ちょうど寿命の時点で切れる）——で絞った値を **Live_Orders** と呼び、待ち行列を読む入口のすべてがそれを正として読む。述語にする理由は 3 つ。専用の Alarm を張らない（StoreTimerDO を起こす経路は fetch / WebSocket / 既存の Timer Alarm だけで、観測目的の wake 源を増やさない）。永続の版を上げない（形は変わらず、no-op 検出 `isSamePending` / `isSameConfirmedResult` は正本の比較のまま——期限切れは遷移でも状態変化でもない）。静かな店で数時間イベントが無くても、次に読む時点の `now` で絞られるので、正本に残っていることは観測されない。起点は `arrivalTime`——上流の観測時刻（`pos-order-ingress` Requirement 8）で、「オーダー時刻」に最も近く再送で動かない事実である。幅は 2 時間の定数 `ORDER_LIFETIME_MS` で、店舗差が実在するまで設定にはしない（`liftIntervalSeconds` と同じ立場）。

**述語は一つ、入口ごとに自分の `now` で呼ぶ。** domain に置くのは engine と client が同じ式を呼ぶためで、`lift-group.ts` の Head の導出と同じ規律である。計画対象 `planTargets(pending, now)` は Live_Orders → 正準順序 → 先頭 64 件の順で組む（**絞ってから切る**。切ってから絞れば死んだ注文が枠を食う）。snapshot の `pendingOrders` は確定結果の Broadcast も hydration も `liveOrders(state.pendingOrders, now)`。外部ソルバへの要求 `RequestPlan.pending` は絞った計画対象を運び、受領時の陳腐化判定は受領時刻の Live_Orders に対して行うので、期限切れの品目を指す一片は既存の `isStale` で落ちる。変更費用の文脈 `ChangeContext.pending` を組む入口は 4 つ（`settle.deriveRecommendations`・`plan.receivePlan`・`admit`・`src/solver`）で、それぞれが自分の `now` で絞る——期限切れの旧先頭 A と生きている次品目 B が混在する状態で、B を遅らせる計画の変更費用は正しい文脈では先頭の変更 2L = 90 秒だが、A を文脈に残せば旧 Head が A になって 0 に消える（レビュー実走）。期限切れは「消えた品目」であり、開始済み・キャンセル済みと同じく対応から外れる。開始の照合は Live_Orders に対して行い、期限切れは既存の `OrderItemNotFound` で拒否する（新しい拒否事由は足さない。消費は正本に対して行う）。client は `queueDisplay` の入口で同じ述語を補正後現在時刻で呼び、snapshot の後で寿命を跨いだ品目を次の snapshot を待たずに消す。**時計の契約**：部品の境界（`SlotBoard` / `orderQueueEntries`）だけがローカル時刻 `now` から `correctedNow` を 1 回計算し、その下（`livePending` / `suggestedItemOf` / `liftGroups.ts`）は補正済みの `corrected` を受けて内部で補正しない（二重補正の経路を構造から無くす）。指紋は絞った計画対象から導くが `now` は畳まず、要求の抑制条件は変えない——期限切れそのものは遷移を起こさず、次の確定変化で生きている計画対象が残っていれば要求する。

**走行中は待ち行列に依存せず自立する。** 開始が `noodleType` / `firmness` / 茹で秒 / `orderItem` を Timer へ写し、以後の発火・完了・調整・キャンセル・Boil_Sync・Alarm・卓の成員表は `pendingOrders` を一度も読まない。これは構造として既に成り立っているので新しい写しは足さず、性質 5.9 として固定する——Timer・設定・`now`・操作を固定し、待ち行列の `arrivalTime` だけを寿命以上過去へ動かした二状態に、両状態で同じに成立する操作（既存 Timer への操作・アドホック開始・Record 受理・外部計画の受領・hydration）を与えると、Timer 集合・実効 endTime・Alarm・`tableMembers` は等しい。`StartOrderItem` は含めない（期限内では Timer が増え、期限切れでは拒否されるので、結果が等しいという主張は拒否の規則と衝突する）。守るのは「時間経過への不変」ではなく「注文期限からの独立」である。

## Considered Options

- **Alarm で状態から除去する**: 新しい wake 源を増やし、除去のためだけの `Persist` が要り、静かな店ではいつ起きるか分からない Alarm を抱える。しかも snapshot の後で寿命を跨ぐ品目は client 側で別に絞る必要が残る。述語なら読む時点で正しい。採らない。
- **受理時に弾く**: 受理の時点で生きていた注文が後から死ぬのだから、受理は判定の場所になりえない。受理（後着の全置換・重複排除の材料）を変えれば冪等の契約に触れる。受理は一行も変えない。
- **費用にする・薄く見せる**: 期限切れは業務上の事実ではなく、読まれないだけである。費用や表示に残せば 64 件の枠と先頭 arms 本を占め続ける。採らない。
- **寿命を店舗設定にする**: 店舗差は観測されていない。定数に置き、差が実在したときに設定へ上げる（`HELPER_ARMS` / `liftIntervalSeconds` と同じ判断）。
- **client だけで絞る**: サーバの計画は死んだ注文を対象にしたままで、枠と要求と推奨が死んだ注文を指す。真実が二つになる。採らない。

## Consequences

- 正本の集合は伸び続ける（`pending-order-expiry` 未決 1 は (a) 残す）。絞った値が正なので観測されない。Persist のサイズが実機で問題になったら、確定結果の `Persist` に相乗りして期限切れを落とす形を別 spec で判断する（自分では `Persist` を起こさない）。
- 観測値は足さない。「切れた瞬間」のイベントは無く、期限切れの件数を Operation History に数えない（未決 2）。
- 時計のずれの前提。`arrivalTime` は上流の時計、`now` は DO の時計（client は補正後現在時刻）。ずれが 2 時間の幅に対して無視できることを前提にする。`arrivalTime` が未来なら期限内として扱う。
- 同じ注文の後着は正本に残る最早の `arrivalTime` を引き継ぐので、期限切れの注文を変更する Record が届いても生き返らない。引き継ぐ起点が無くなった後（期限切れ → 0 品目の後着で除去 → 非空の後着）は新しい `arrivalTime` で入る——既存の受理規則の帰結で、本 spec は保証しない。
- `planTargets` / `digestInput` / `baselineSchedule` / `buildSchedule` / `suggestedItemOf` の署名に時計の引数が加わる（`committedSchedule` / `admit` / `settle` は既に持つ `now` を通す）。`digestInput` の `now` は絞るためだけで畳まない。
- 絞った値は状態にも `ClientView` にも持たない（時刻が進めば古くなる導出値）。全件が期限内なら `liveOrders` は入力と同じ配列を返し、参照同値で再描画を抑える既存の経路を壊さない。
