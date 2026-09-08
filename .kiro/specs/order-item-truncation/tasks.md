# Implementation Plan

前提：main（#41 まで・`lift-order-numbering` 済み）。**永続スキーマの版もワイヤも client も変えない**（design Component 4）。触るのは `src/engine/pending.ts` と `src/engine/migrate.ts` の 2 ファイルと、テスト・文書だけ。shell は一行も変えない。

- [x] 0. naming ゲート（design の表）をユーザーが承認する（2026-09-08 承認：配置は `src/engine/pending.ts`・新規ファイルなし。名は `ORDER_ITEM_LIMIT` / `truncateOrderItems`、要件語彙は `Order_Item_Limit` / `Truncation` / `Forgotten_Item`）

- [x] 1. engine：`truncateOrderItems` と `ORDER_ITEM_LIMIT`
  - [x] 1.1 `src/engine/pending.ts`：`ORDER_ITEM_LIMIT = 4096` と `truncateOrderItems(items)`。上限以下なら入力と同じ参照で即座に返す。超えるなら入力の**複製**を `compareArrival` で整列して先頭 `length − ORDER_ITEM_LIMIT` 件の鍵（`itemKeyOf`）を集め、元の並びを走査して除く。`compareArrival` を `../domain/order` の import に足す（新規ファイルも新しい import 方向も作らない）
    - 実測（2026-09-08）：`src/engine/pending.ts` に `ORDER_ITEM_LIMIT = 4096` と `truncateOrderItems(items)`。`items.length <= ORDER_ITEM_LIMIT` で入力の参照をそのまま返し、超過時のみ `[...items].sort(compareArrival).slice(0, items.length - ORDER_ITEM_LIMIT)` の鍵を `Set<ItemKey>` に集めて `items.filter` で除く（選定と並びを 2 段に分ける）。import に加えたのは `compareArrival` の 1 つだけで、`pending.ts` の import 方向は変わらない（`../domain/order` / `../domain/timer` / `./timer`）
  - [x] 1.2 `tests/core/pending.property`：性質 1〜7（有界・冪等・部分集合・並び保存・恒等〈同じ参照〉・落ちるのは `compareArrival` で最も古い k 件・**鍵が一意な入力に対する**決定性〈入力順を変えても落ちる集合は同じ〉）。鍵が一意な `OrderItem` 配列の生成器を `tests/core/generators.ts` に足す
    - 実測（2026-09-08）：`tests/core/truncate-order-items.property.test.ts` に 7 件。生成器は `generators.ts` の `genUniqueOrderItems({minLength, maxLength})` / `uniqueOrderItems(length, tieRun)` / `shuffleBySeed(items, seed)`——素データは長さ・同着の連・置換の 3 つだけで、品目は添字から決定的に組む（`arrivalTime` は `floor(i / tieRun)`、`externalOrderId` は 0 詰めの `floor(i / 3)`、`itemIndex` は `i % 3`）。これで**鍵が一意**かつ**`compareArrival` の全順序が添字の順に一致**するので、落ちる集合を添字で主張できる。入力は 2 帯に分けた——上限以下（即時脱出）と上限超過（整列して落とす）で通る道が違うため。超過帯は `ORDER_ITEM_LIMIT + 1`〜`+8`（定常状態の k は一つの到着の品目数に留まるので、そこが実際に踏まれる範囲）で `numRuns: 40`。3 回再実行はいずれも 7 / 7
  - [x] 1.3 `tests/core/pending.example`：ちょうど上限・上限 +1・大量超過・空・`arrivalTime` 同値を `externalOrderId` で断つ場面・落ちた品目が `cooking`（生きた Timer の参照先）である場面
    - 実測（2026-09-08）：`tests/core/truncate-order-items.example.test.ts` に 7 件（空は同じ参照・ちょうど上限は同じ参照・上限 +1 は先頭 1 件だけ落ちる・3 倍の大量超過でも上限ちょうど・全件同着は `externalOrderId` で断つ・**集合の並びが到着順でなくても**（最も古い品目を末尾に置いても）落ちるのは古い側で残りの並びは入力のまま・**生きた Timer の参照先でも落ちる**——`orderItemOf(timer, kept)` が null になり既存の「参照先なし」経路へ落ちる）
  - [x] 1.4 **チェックポイント（実測）**：`truncateOrderItems` の費用を測る。**満杯（4096 件）の状態に単一店舗で 1000 Record を投入**し、1 回あたりの費用と総時間を記録する。design Component 1 の「即時脱出が効くのは上限に達するまで」を実測で裏づけ、受理の応答時間に対して無視できることを確かめる。**基準は「1 到着あたり p95 < 1 ms」**——下回れば現状（全整列）のまま進む。上回る場合は自動で作り替えず、**実測値（p50 / p95 / 最大 / 総時間）を添えてユーザーに諮るチェックポイントとする**（選択肢：k 件の部分選択〈`O(n)`〉へ替える／上限を下げる／そのまま受け入れる）。部分選択へ替えても「落ちる集合が入力順に依らない」ことは性質 7 が守る
    - 実測（2026-09-08・workerd / `pnpm vitest` の `|workers|` pool）：満杯 4096 件に 1 Record = 3 品目を 1000 回投入。**1 回あたり p50 = 0.36 ms / p95 = 0.40 ms / max = 0.44 ms**、`truncateOrderItems` の総時間は 約 350 ms。`arrivalTime` がばらける場合・4 件ずつ同着・**全件同着（すべての比較が第 2 の鍵の文字列比較へ落ちる最悪）**の 3 条件で差は誤差（最悪でも p95 = 0.44 ms）。**基準 p95 < 1 ms を満たすので全整列のまま進む**（部分選択へは替えない）。注記：workerd の `performance.now()` は 1 ms 粒度なので、25 回ずつのブロックで測って 1 回あたりへ割った。計測用のテストは記録後に削除した（常設のベンチは置かない）
  - _Requirements: 1.1〜1.6, 5.1〜5.7_

- [ ] 2. engine：`upsertOrder` の出口
  - [ ] 2.1 `src/engine/pending.ts`：末尾を `const bounded = truncateOrderItems(next); return isSameOrderItems(items, bounded) ? items : bounded;` にする。**truncate してから同一性を判定する**（逆にしない）。`removeOrder` / `arrivalsOf` / `withOrderAttributes` / `earliestArrival` / `lastIndexOfOrder` / `isSameOrderItems` は変えない
  - [ ] 2.2 `tests/core/pending.example`：**新しく来た品目が全体で最も古くそのまま落ち、結果が元の集合と一致するとき、`upsertOrder` は元の参照を返す**（判定順の回帰。逆順なら内容の同じ新しい配列を返して空振りの `Persist` / `Broadcast` を呼ぶ）。上限以下の通常の到着で戻り値も参照同値の判定も従来どおりであること
  - [ ] 2.3 `tests/core/receive.example`：**新規品目が即座に忘れられて `orderItems` が同値でも、`RecordsReceived` は受理として成立する**——`lastSequenceByTerminal` は進み、`settle` の `isSameLastSequence` が差分を立てて `Persist` が出る（`settle.ts:198`）。判定材料だけが進む受領が実在する既存の構造（`settle.ts:179` の注記）が、忘却の下でも壊れないことを固定する
  - _Requirements: 2.1, 2.3, 3.3, 4.4_

- [ ] 3. engine：`migrate`
  - [ ] 3.1 `src/engine/migrate.ts`：`reviveOrderItems` に**鍵の一意性の検査**を足す（要素をすべて写した後に `itemKeyOf` の集合の大きさを比べ、重複が在れば `null` ＝ `MigrationFailed`）。個別に捨てない
  - [ ] 3.2 `src/engine/migrate.ts`：`snapshot` を組む場所で `orderItems: truncateOrderItems(orderItems)`。検証（解釈できるか）と上限（どれだけ保つか）を同じ関数に混ぜない。`./pending` の import を足す（`pending.ts` の import は `../domain/order` / `../domain/timer` / `./timer` だけなので循環しない）
  - [ ] 3.3 `tests/core/migrate.example` / `migrate.property`：上限超過の v13 が**成功して**上限を当てた集合で復元されること（件数の超過は移行失敗の事由ではない）、鍵の重複が `MigrationFailed` になること、形の不正が従来どおり失敗すること
  - [ ] 3.4 `tests/core/migrate.example`：**「上限超過 **かつ** 鍵の重複あり」の永続値は、truncate が重複の片割れを落としうる場合でも先に `MigrationFailed` になる**（検証が上限より前にあることの回帰。順序が逆なら、重複が偶然落ちた入力だけ通って壊れた値が状態へ入る）
  - _Requirements: 2.2, 4.1, 4.2, 4.5_

- [ ] 4. 閉包性と有界性
  - [ ] 4.1 `tests/core/order-item-bound.property`（新規）：性質 8（件数の非増加）。`upsertOrder` / `migrate` の出力は `ORDER_ITEM_LIMIT` 以下、`complete` / `cancel` / `fromSnapshot` / `toSnapshot` は入力と同数、`removeOrder` は入力以下、`EMPTY_STATE` は 0——**変換ごとに独立して**検査する。`pending.property` と分けるのは、対象が `pending.ts` に閉じず跨るためで、「どの変換が件数をどう動かすか」の一覧をここ一箇所で読めるようにする
  - [ ] 4.2 `tests/core/continuous-input.example` と同形の harness：性質 9（状態の有界性）。到着・開始・完了・キャンセル・後着・外部計画の受領・hydration を任意の系列で与えて `orderItems.length ≤ ORDER_ITEM_LIMIT` を保つ。**性質 8 は現在の変換の列挙であって網羅ではない**（design の既知の限界）ので、これが二重の網になる
  - _Requirements: 2.4, 5.8, 5.9_

- [ ] 5. 忘れることの帰結（新しいコードは無い・既存の経路に落ちることの固定）
  - [ ] 5.1 参照先を失った Timer が既存の経路を通ること——`orderItemOf` が null、釜のカードは麺種だけ、`complete` / `cancel` は品目に何も書かず Timer を閉じる（`complete.ts:53` の `completed === null` 分岐）。忘れられた未調理の品目への `StartOrderItem` は既存の `OrderItemNotFound`
  - [ ] 5.2 `tests/core/order-expiry-independence` と同形：性質 11（走行中の自立）。品目を忘れても走行中 Timer の集合・実効 endTime・Alarm・`tableMembers`・Boil_Sync の結果は変わらない
  - [ ] 5.3 `tests/core/received-order.example`：**完全に忘れた注文の後着は、新しい `arrivalTime` で入り直す**（Requirement 3.4）。`earliestArrival`（`pending.ts:158`）の引き継ぐ起点が無くなった帰結であり、**本 spec は「生き返らない」を保証しない**——その立場そのものを回帰として固定する（`pending-order-expiry` AC 2.8 と同じ扱い）
  - [ ] 5.4 `tests/core/settle-*.example`：**忘れた品目は Broadcast の snapshot にも wire にも現れない**（Requirement 3.5 / 4.6）。`orderItemsToBroadcast` は正本を絞るので正本に無いものは載らない、を確定結果の snapshot で直接検査する。同じ場面で、その品目を指す Timer が `TimerFact` として載り続けること（参照は解けないが Timer は自立している）も併せて固定する
  - [ ] 5.5 **永続サイズの回帰**（性質 10）：満杯の状態——`ORDER_ITEM_LIMIT` 件の代表的な品目 + `MAX_TIMERS` の Timer + `PLAN_TARGET_LIMIT` の `acceptedSlices` + `shownPlan` + **実運用規模の `lastSequenceByTerminal`（端末 8 台 × 56 桁）**——を組み、`TextEncoder` で測った UTF-8 バイト数を実測値としてここに記録する。**ハード上界ではなく参考指標**であることをテストの注記に書く（structured clone で載る／key + value の合算／文字列長は未検証／`lastSequenceByTerminal` は構造的に有界でない）
  - [ ] 5.6 `tests/shell/store-timer-rehydrate.integration`（追記）：**上限超過の永続値を持つ DO を起こしても、hydration では永続値が変わらない**（`storage.get` で読み直して件数が元のまま）。続いて任意の確定変化（到着・開始・完了のいずれか）を1 回与えると、**そこで初めて永続値が `ORDER_ITEM_LIMIT` 件へ縮む**（Requirement 4.3・判断 8）。同じテストで、**新しい `put` の鍵も新しい storage 呼び出しも増えていない**こと（AC 2.5 / 2.6・掃除のための遷移も Alarm も起動経路も永続の鍵も足していない）を確かめる
  - _Requirements: 2.5, 2.6, 3.1, 3.2, 3.4, 3.5, 4.3, 4.6, 5.10, 5.11_

- [ ] 6. 文書
  - [ ] 6.1 `docs/adr/0014-order-item-set-is-bounded-not-swept.md`：注文品目の正本は有界であり、上限は掃除の出来事ではなく集合の構築点に作り込む。ADR-0013（品目は生涯を通じて残る）と ADR-0011（期限は絞るのであって除かない）の両方に条件を付ける横断的な判断として記す。**忘却は不可逆**であること、容量とのトレードオフ（4096 の根拠と、件数がバイト上界を与えないこと）を含める
  - [ ] 6.2 `yude-men-timer/design.md:523` に改訂注記：backend は SQLite（`new_sqlite_classes`）、上限は key + value 合わせて 2 MB、状態は Timer だけではない（`orderItems` / `acceptedSlices` / `shownPlan`）。**事実の更新に限る**（判断は ADR-0014 側）
  - [ ] 6.3 `order-lifecycle` と `pending-order-expiry` に改訂注記：前者には「品目は生涯を通じて残る**が、件数の上限で最も古いものから忘れられる**」、後者にはその未決 1 への答え（期限ではなく件数で、別の遷移としてではなく構築点で）
  - _Requirements: 4.1, 判断 6・8_

- [ ] 7. 全数チェックポイント（`pnpm typecheck` / `pnpm lint` 0 errors / `pnpm test` / `pnpm fmt:check`）。property は数回再実行する
