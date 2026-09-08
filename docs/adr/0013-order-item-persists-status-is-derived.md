---
status: accepted
date: 2026-09-08
specs: order-lifecycle
amends: 0003
---

# 注文品目は生涯を通じて一つの事実として残り、状態（unstarted / cooking / done）は Timer の参照と completedAt から導く

待ち行列の品目（`PendingOrder`）と Timer は別の実体で、開始で品目を消費して Timer に写し、完了・Cancel で Timer を消していた。Timer が調理中を語る唯一の事実であり、Timer は麺種・硬さ・時刻しか持たない。帰結が三つ。走行中カードは卓も品名も知らず、茹で上がる順の番号を注文で切れない（`lift-order-numbering` の要望）。厨房の Cancel は Timer を消すだけで、消費済みの品目は失われ POS の後着でしか戻らない。後着の受理には「生きた Timer が指す品目は置換の結果から除く」という規則が要り、A を調理中に同じ注文 {A, B} が再送されるだけで正本が {B} に置き換わって A の参照先が消える。目標は、走行中カードが注文・卓・品名を参照で読めること、番号を注文で切れること、厨房の Cancel が品目を待ち行列へ戻すこと。

**品目は開始で消費せず、状態は保存せず導出する。** 関係は Timer has 1..n Slots／Order item has 0..1 Timer／Timer has 0..1 Order item（ユーザー確定・2026-09-07）。導出の順は (1) 自分を参照する生きた Timer が在る → `cooking`、(2) Timer が無く `completedAt` が在る → `done`、(3) どちらも無い → `unstarted`（`itemStatusOf`）。**生きた Timer は走行中だけでなく、茹で上がって Complete を待つ boiled も含む**——時間が来ただけでは `done` にならず、茹で上がりと厨房が完了を確定することは別である。状態の enum は保存しない。Timer の存在と二重に持てば必ずズレる（ADR-0003 が「開始済みの印」を採らなかった理由をそのまま守る）。第 4 の状態は作らない。**参照は Timer 側だけ（既存の `Timer.orderItem`）に置く。** 生成時に一度書いて不変、Timer が消えれば関係も消える。品目 → Timer は「自分を指す生きた Timer」を引く導出で、状態に持たない——Order → Timer の参照は Timer が消えたときに消し忘れる失敗形（宙に浮いた参照）を持ち込む。Slot → Order（Timer を捨てて釜が品目を指す）も採らない——1 品目が複数の釜を占め（`slotSpan`）、アドホック開始は注文を持たないので、結局 Timer を作り直すことになる。品目に足す属性は二つ。**`completedAt`** は完了の事実（厨房が確定した時刻・`complete` だけが書く）、**`interruptedAt`** は中断の事実（厨房 Cancel で調理が止められ未調理に戻った最後の時刻・`cancel` だけが上書きで書く）。`interruptedAt` は状態に効かない（ユーザー確定）——`unstarted` の条件は「生きた Timer なし ∧ `completedAt` なし」のままで、左レールが「一度戻された品目」を色分けするためだけの事実である。再び始めて完了すれば `done`（`completedAt` が優先）、再び中断されれば上書き。番号・計画の優先には使わない。

**操作と状態の対応。** 開始＝Timer を作る（品目は残り `cooking`。`cooking` の品目への開始は新しい拒否事由 `OrderItemCooking`、`done`・期限切れ・不在は既存の `OrderItemNotFound`）／茹で上がり＝Timer は boiled として残る（引き続き `cooking`）／完了＝Timer を除去し、参照先の品目に `completedAt = now`／厨房 Cancel＝Timer を除去し、参照先に `interruptedAt = now`。一括完了は client がメンバーごとに `complete` を送るので、対象 Timer が参照していた各品目へ自然に記録される。**早め上げは `complete` で送る。** client の停止ボタンは残り 60 秒未満の 1 タップで `complete` を、60 秒以上の 2 段タップで `cancel` を送る（従来はどちらも `cancel` で、早め上げの意味を運んでいなかった）。しきいは UI の関心事のままで、engine は残り時間で判定せず `complete` でだけ `completedAt` を書く。走行中を一括の対象にしない規律（`sync-set-batch-complete`）は保ち、対象が走行中のとき `connection.complete` は群を作らず対象ただ 1 件を送る。**厨房 Cancel は状態を戻し、期限は戻さない。** `arrivalTime` は更新しない——「注文から 2 時間」を「最後にやり直した時刻から 2 時間」に変えない。期限内なら左レールと計画に再び現れ、期限外なら現れない。**POS の後着は注文属性だけを更新する。** 同じ品目の後着は状態にかかわらず POS 由来の属性（麺種・茹で加減・卓・盛り・名称・`slotSpan`）だけを更新し、厨房の事実（`completedAt` / `interruptedAt`）と生きた Timer を保つ。`OrderItem` は最新の注文情報、`Timer` はその調理を開始した時点の情報で、POS の後着でいま茹でている麺の条件は書き換えない（卓が移ればカードは新しい卓、計画の `tableMembers` は Timer に残る旧卓——ADR-0003 の契約を据え置く）。「未調理を全置換」も採らない——開始 → Cancel → 後着の系列で中断の事実が失われる（POS は厨房の中断時刻を持たない）。前提（ユーザー確定・2026-09-07）：**POS の取消は発生しない**。後着に現れない品目（削除・数量減少・0 件）は `unstarted` なら既存どおり除き、`cooking` / `done` なら残す（参照整合と履歴。前提の外でも壊さない）。前提を理由に受理を黙って変えるのではなく、更新の規則をここで定める。

**読む集合は二つ、期限の述語は一つ。** 調理の状態と期限（2 時間・ADR-0011）は別の軸である。期限切れは第 4 の状態ではなく、「未調理だが期限切れ」「調理済みで期限切れ」は普通に在る。計画・左レール・ラジアルが読むのは **`pendingOrders(items, timers, now)`＝期限内 ∧ `unstarted`**。snapshot が運ぶのは **`orderItemsToBroadcast(items, timers, now)`＝期限内 ∨ 生きた Timer の参照先**——注文から 1 時間 59 分で 10 分茹での品目を開始し 2 時間 1 分に snapshot を送っても、Timer が残る間は品目を配信して卓・品名を引ける。期限判定（`isLive`）を共有することと、全用途で同じ集合を読むことは別である。**「未調理」は保存された集合ではなく関数。** 保存する型を `PendingOrder` から `OrderItem`（`TimerState.orderItems`）に改名し、読む側の導出は 4 つに限る——`itemStatusOf`（状態の正本）、`pendingOrders`（計画と左レールの入口・`liveOrders` を内側に畳む）、`orderItemsToBroadcast`（snapshot の集合）、`orderItemOf(timer, items)`（Timer → 品目の参照解決・無ければ null＝注文なしと同じ経路）。`cookingOrders` は読み手が現れるまで作らない。語彙は Timer 側 `running`、品目側 `cooking`。**solver には `pendingOrders` と `running` を渡し、品目全件は渡さない。** 計画が要るのは未調理の品目と、釜を占めている Timer の事実（釜・実効 endTime・調整）で、アドホックの Timer は注文を持たずに釜を占める。品目全件を渡しても走行中の釜は導けず、`running` を落とすことはできない。

**v12 の走行中 Timer は限定された移行例外である。** 旧実装は開始時に品目を消しているので、v12 → v13 の移行（`pendingOrders` → `orderItems`・`completedAt` / `interruptedAt` の欠如 → null）をしても、既に始まっている Timer の参照先は存在せず、Timer には品名も到着時刻も無いので復元できない。推測で品目を作らず、限界を明示する——旧版由来で参照先の無い Timer はそのまま動かす、カードの参照が解決できなければ注文なし相当の表示、完了・Cancel は従来どおり Timer を除去し存在しない品目に日時は書かない、この旧 Timer を Cancel しても注文品目は戻らない。例外の適用は**操作時にも参照先が無い場合だけ**——POS がその品目を後着で送れば実際の入力で参照先が補われ（推測による復元ではない）、以後の Complete / Cancel は通常どおり記録する。v13 で新しく開始した注文 Timer については参照整合（生きた Timer の参照先は集合に在り、配信に含まれる）を保証する。**保持量は増える。** 通常どおり調理・完了した品目も正本に残るので、永続は以前より増える（ADR-0011 の「正本は伸び続ける」がここでも成り立つ）。2 時間で配信対象から外しても永続は減らない。整理（折りたたんだ期限切れ一覧からの一括削除）は別の機能として意味を持ち、そのとき生きた Timer の参照先は削除対象から外す。

## Considered Options

- **品目に状態の enum を持つ**: Timer の存在と二重になり、開始・完了・Cancel のたびに両方を書く。書き忘れが「Timer が無いのに cooking」を生む。導出なら矛盾が表現不能。採らない。
- **Order → Timer の参照を持つ**: Timer が消えたときに消し忘れる失敗形（宙に浮いた参照）を持ち込む。Timer 側の参照は Timer と運命を共にするので消し忘れが無い。採らない。
- **Slot → Order（Timer を捨てて釜が品目を指す）**: 1 品目が複数の釜を占め（`slotSpan`）、アドホック開始は注文を持たない。どちらも「釜の集合と時刻を持つ一回の調理の記録」を要り、それは Timer である。採らない。
- **Timer とは別に隠れた「調理中」の品目一覧を持つ**: 集合が三つ（未調理・調理中・Timer）になり、Timer と調理中一覧の整合を保つ遷移が要る。状態の導出で足りる。採らない。
- **POS の取消を `cancelledAt` として持つ**: 取消は発生しない前提（ユーザー確定）で、意味は別 spec。厨房の中断は `interruptedAt` で、取消と混ぜない。採らない。
- **client だけで覚える（開始した品目を `pendingOrders` から記憶する）**: 端末ごとの記憶で、再接続・他端末・hibernation 越しに残らない。真実が二つになる。採らない。
- **v12 の走行中 Timer から品目を復元する**: Timer は品名・到着時刻を持たず、推測で品目を作れば偽の待ち行列が生まれる。限界を明示し、後着で補われるのを待つ。採らない。

## Consequences

- 永続スキーマの版が上がる（v12 → v13・`pendingOrders` → `orderItems`・各品目に `completedAt` / `interruptedAt`）。注文品目が不正なら既存どおり `MigrationFailed`（個別に捨てる Shown_Plan とは失う事実の重さが違う）。切戻しは `docs/persisted-schema-rollback.md` の v13 行——v12 は開始済みの品目を消費する契約だったので、v13 で残した `cooking` / `done` の品目が v12 では未着手として現れる。
- wire は snapshot の `orderItems`（期限内 ∨ 生きた Timer の参照先・`completedAt` / `interruptedAt` 付き）と `TimerFact.orderItem: { externalOrderId, itemIndex } | null` を運ぶ。参照は鍵だけで、`tableId` は今も wire に出さない（ADR-0003 の Consequences を再改訂——読み手が現れたので参照を出すが、卓は品目から引く）。decode は形を検証し、不正は snapshot ごと落とす。client の永続（localStorage）は Timer の `orderItem` を検証して復元し、旧ブロブの欠如・不正は null に畳んで Timer を失わない。
- 拒否事由 `OrderItemCooking` が一つ増える。
- `isSameOrderItems`（旧 `isSamePending`）は 11 フィールド全部を比べる。旧 `isSameOrder` は `slotSpan` / `itemName` / `sizeName` を比べていなかったので、名称だけの後着も確定変化として永続・配信されるようになった。
- `connection.complete` は対象が走行中なら対象ただ 1 件を `complete` で送る（boiled の一括の意味は変えない）。`cancelGuard` の決定に `complete` が加わる。
- `lift-order-numbering`（番号・卓・品名・中断の色分け）はこの上に載る表示で、番号の単位「同じ実効 endTime かつ同じ注文」は `TimerFact.orderItem.externalOrderId` で切る。
- 残滓（`lastResults`）は変えない。将来 `done` の品目から導出に置き換えられるが、本 spec の範囲外。
- 正本の保持量は増え、整理は別の機能。snapshot の `orderItems` は「期限内 ∨ 参照先」で全件送る限り、`done` を別配列に分けても配信量は減らない——期限 2 時間の内側に限られることで足りるとして始め、実測で問題になれば `done` を送らない方向で別途判断する。
