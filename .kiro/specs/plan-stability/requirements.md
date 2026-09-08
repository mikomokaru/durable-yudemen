# Requirements Document

## Introduction

本 spec は、調理計画の **前回提示した提案からの変更を費用にする**。新しい費用 = 現在の業務費用（既存の目的関数）+ 前回提案からの変更費用。変更禁止ではなく、変更による利益が「覚え直す負担」を上回るなら変える。釜の占有・slotSpan・上げ窓の上限などのハード制約は引き続き優先する。

守りたいものは一様ではない。調理者が既に段取りを組んだ部分——**次に投入する品目とその釜**、**一緒に扱うまとまりと投入の順**——を重く守り、遠い将来の提案は変えやすくする。計画全体を均等に固定するより、手を伸ばそうとしている対象を守る方が知的負担の軽減に直結する（ユーザー確定）。

前提は `lift-group-planning`（判断 18〜20・上げ窓まで）と `lift-group-display`（判断 20・21）。

### 観測事実（2026-09-06・main `Merge #32` 時点）

1. `TimerState`（`src/engine/state.ts:27-35`）は `timers` / `nextSeq` / `pendingOrders` / `acceptedSlices` / `requestedDigest` を持ち、**前回 broadcast した推奨は持たない**。推奨は `settle.ts` の `toWireSnapshot` が確定計画（`committedSchedule` → `recommend`）から毎回導き、broadcast したら捨てる（「導出値を状態に昇格させない」）。
2. 永続は v11（`types.ts:50`）。`StoreSnapshot` は `TimerState` の 5 項目に `lastSequenceByTerminal` を加えた形（`snapshot.ts:22-39`）。
3. 確定計画は `committedSchedule`（`commit.ts:56`）が採用済み一片の接頭辞（`livePrefix`）と、その解放表・上げ表から再実行した自前解の尾部で組む。尾部は毎回ゼロから置き直され、**前回の配置を候補にする経路は無い**。釜の選択（`chooseSlots`・`schedule.ts:1182`）は「全釜が空く最早時刻の最小化 → 釜距離 → index」で、同点は index 昇順で断つ。
4. 目的関数（`objective.ts:77-85`）は `total`（部分和の和 + 店舗全体の Lift_Overflow）と `bySlice` を返す。ゲート（`admit.ts:80-99`）は段 1 で部分和、段 2 で総和を比べる。
5. 群の識別子（`CookRecommendation.group`）は snapshot 内で閉じる（`lift-group-planning` 判断 19）。snapshot を跨いで文字列を比べる意味は無い。
6. 表示（`lift-group-display` 判断 21）は、開始推奨時刻が来た品目を時刻順に並べて店舗全体で先頭 arms 本を濃く（押せる）出す。**現場が「次に手を伸ばす対象」と認識するのは、この先頭 arms 本とその釜である。**

### 確定した設計判断（2026-09-06 の対話で確定）

1. **前回提示した内容を、履歴の事実として `TimerState` に持つ（Shown_Plan）。ユーザー承認済み（2026-09-06）**——現在の状態から復元できない過去の出力なので、「導出値を状態に昇格させない」規律の例外ではない。**定義は「配信対象として永続確定した提案」**であって「現場に見せた」ではない（現行は Persist の後に Broadcast を行い、送信失敗や接続端末ゼロでも永続は成立するため、見せたことは保証できない・レビュー指摘）。同じ `Persist` に、選んだ計画の推奨（`recommend` の出力）をそのまま Shown_Plan として載せる——確定した推奨と Shown_Plan は常に一致する。持つのは品目ごとの `slotIds` / `startAt` / `serveAt` / `anchor` / 群の所属（同じ snapshot の中でどの品目と同じ群だったか）。**Head の旗は持たない**——Head は時刻と走行中に依存するので、比較の時点で旧 Shown_Plan からも新しい計画からも同じ now・同じ Timer 集合で導く（判断 8）。永続 v12。
2. **変更費用は守りたいもので分ける。** (a) **次に投入する品目とその釜**——前回の先頭（表示の先頭 arms 本に相当する、開始推奨時刻が来た品目を時刻順に並べた先頭 arms 本）が先頭でなくなる、または釜が変わる変更は重い。(b) **まとまり**——前回同じ群だった品目が別の群に割れる、前回の投入の順（`startAt` 順）が逆転する変更に費用を付ける。(c) **開始時刻**——数秒（h_i の内側）の調整は数えず、上げの間隔（`liftIntervalSeconds`）を跨ぐ移動は重く、遠い将来（前回の `startAt` が今から遠い）ほど軽くする。
3. **比較の規律。** 開始済み・キャンセル済みで消えた品目、新規に増えた品目は変更費用にしない。**未着手の品目を推奨から消して変更費用を逃れることは許さない**——ただし費用ではなく既存のハード制約で閉じる（外部計画の一片は卓の計画対象と品目集合が一致しなければ `isStale` で棄却、卓ごと省けば合成の尾部が自前解で埋める・AC 2.4）。群の識別子は比べず、品目の対応（`externalOrderId` + `itemIndex`）とまとまりを比べる。
4. **採点に足すだけでは足りない。** 自前解の再計算（`committedSchedule` の尾部）に、前回の釜割当とまとまりを残す候補を作らせる——釜の選択は前回の釜が空いていればそれを第一候補に、群の分割と順は前回を保つ候補を先に評価し、業務費用の改善が変更費用を上回るときだけ別の配置を採る。
5. **ハード制約は常に優先。** 前回の釜が埋まっている・上げ窓の上限を超える・slotSpan を満たさない配置は候補にならない。変更費用は feasible な候補の間の選び方にだけ効く。
6. **ゲートは同じ費用で外部計画を採点する。** 前回と大きく違う計画で微小な改善を出す外部解は通りにくくなる。改善判定の基準は現行の Committed_Plan のまま。
8. **Head は保存せず、比較の時点で両側から導く（レビュー指摘）。** 確定時点の旗を保存すると、時間経過で濃くなった品目（0 秒時点で「10 秒に開始」と確定した A は旗が偽のまま 10 秒に濃くなる）を守れず、anchor の失効で後続群が自然に隠れただけの同じ計画に費用が付く。旧 Shown_Plan の Head も新しい計画の Head も、**比較の時点の now と、遷移後（再同期後）の Timer 集合**で Glossary の導出に従って計算する。遷移後の集合を使うのは「いま現場が見るもの」で両側を揃えるためで、遷移前の集合では、遷移で始まった品目の釜を旧 Shown_Plan の他の品目がまだ使えると見て、偽の先頭変更が生まれる。履歴として保持する対象（配置）と、現在の保護対象（その配置から今導く Head）は分ける。
7. **重みは秒相当で、上げの間隔から導く。** 新しい設定は足さない（判断が固まるまで）。先頭の変更 = `liftIntervalSeconds` × 2、釜の変更 = `liftIntervalSeconds`、まとまりの分割・順の逆転 = `liftIntervalSeconds`、時刻の移動 = 跨いだ上げの間隔の数 × `liftIntervalSeconds` × 減衰（前回の `startAt` が今から k 個目の間隔なら 1 / (k + 1)）。値は実機で見直す。

### スコープ外

- 表示（`lift-group-display`）の変更。表示は計画の帰結を見せるだけ。
- 外部ソルバの内部。契約（`RequestPlan` に Shown_Plan を運ぶ）は本 spec、最適化はソルバの責任。
- 走行中 Timer の調整（Boil_Sync）。

## Glossary

- **Shown_Plan（前回提示した内容）**: 直前に配信対象として永続確定した snapshot の推奨を、品目ごとの `slotIds` / `startAt` / `serveAt` / `anchor`・群の所属・Head であったかとして `TimerState` に残した履歴の事実。
- **Change_Cost（変更費用）**: 新しい計画が Shown_Plan からどれだけ違うかを秒相当で数えた値。目的関数に足す。
- **Head（先頭）**: `lift-group-display` 判断 19・21 と**同じ導出**——群を最早 `startAt` 順に並べ、表示できる群（先頭の群と、それより前がすべて Group_Started＝`anchor` 非 null かつ `anchor > now` の群）の品目のうち、全釜 idle（走行中・茹で上がりの釜を含まない）で開始推奨時刻が来たものを時刻順（同値は群の順・品目の順）に並べた先頭 arms 本。engine は推奨（`group` / `anchor`）と走行中 Timer を持つので、同じ規則で計算できる。時刻と走行中に依存するので、Shown_Plan には旗を残さず、比較の時点の now と遷移後（再同期後）の Timer 集合で、旧 Shown_Plan からも新しい計画からも同じ規則で導く（判断 8）。
- **Business_Cost（業務費用）**: 既存の目的関数（Σ Wait_Time + 卓同期 + Lift_Overflow + …）。

## Requirements

### Requirement 1: 前回提示した内容の保持

**User Story:** As a 設計者, I want 現場に見せた提案を事実として持つ, so that 次の計画がそれと比べられる。

#### Acceptance Criteria

1. THE `TimerState` SHALL `shownPlan`（Shown_Plan・品目ごとの `slotIds` / `startAt` / `serveAt` / `anchor`・群の所属。Head の旗は持たない）を持ち、`settle` が確定結果を `Persist` するたびに、同じ `Persist` に載る snapshot の推奨で置き換える（配信対象として永続確定した提案）
6. THE Shown_Plan の更新 SHALL 確定結果の `Persist` にだけ伴う——棄却（状態を変えない受領）・no-op（確定結果が直前と同一で `Persist` も `Broadcast` も出ない遷移）・hydration（接続時の全量送信・状態を変えない）では更新しない。hydration が導く推奨は Shown_Plan と違いうる（時刻が進んで自前解の尾部が動く）が、それは配信対象として確定していない
7. THE 比較 SHALL 旧 Shown_Plan（遷移前の状態が持つもの）に対して行い、選んだ計画の推奨を新 Shown_Plan として同じ `Persist` で確定する（比較の相手と確定するものを取り違えない）
2. THE Shown_Plan SHALL 現在の確定計画のキャッシュではなく履歴の事実である。確定計画は引き続き毎回導き、Shown_Plan は比較にだけ用いる
3. THE 永続スキーマ SHALL 版を 11 から 12 へ上げ、v11 以前の `shownPlan` の欠如を空（比較の相手なし・変更費用 0）に畳む
4. THE Shown_Plan SHALL `RequestPlan` で外部ソルバへ運ぶ（外部解も同じ費用で採点されるため）
5. THE Shown_Plan の群の所属 SHALL 群の識別子の文字列ではなく「同じ群に在った品目の組」として持つ（識別子は snapshot 内で閉じる・観測事実 5）

### Requirement 2: 変更費用

**User Story:** As a 厨房スタッフ, I want いま手を伸ばそうとしている対象が動かない, so that 段取りを組み直さずに済む。

#### Acceptance Criteria

1. THE 目的関数 SHALL Change_Cost を Business_Cost に足す。Change_Cost は Shown_Plan と新しい計画の**対応する品目**（`externalOrderId` + `itemIndex`）の間で数える
2. THE Change_Cost SHALL 次の 4 種を持ち、重みは秒相当で `liftIntervalSeconds` から導く（新しい設定は足さない）——(a) **先頭の変更**：比較の時点の now と遷移後の Timer 集合で導いた旧 Shown_Plan の Head に在る品目が、同じ now・同じ Timer 集合で導いた新しい計画の Head に無い（重み 2 × L）。同じ計画なら両側の Head は一致し費用 0（anchor の失効で後続群が隠れる場合を含む）、(b) **釜の変更**：対応する品目の `slotIds` が変わった（重み L）、(c) **まとまりの変更**：Shown_Plan で同じ群だった 2 品目が新しい計画で別の群になった、または対応する 2 品目の `startAt` の順が逆転した（組ごとに重み L）、(d) **時刻の移動**：対応する品目の `startAt` が h_i を超えて動いた分について、跨いだ上げの間隔の数 × L × 1 / (k + 1)（k = Shown_Plan の `startAt` が今から何個目の間隔か）
3. THE Change_Cost SHALL 開始済み・キャンセル済みで消えた品目と、新規に増えた品目を数えない
4. THE 変更 SHALL 「未着手で置ける品目を推奨から消して変更費用を逃れる」経路を費用ではなく既存のハード制約で閉じる——外部計画の一片は卓の計画対象と品目集合が一致しなければ陳腐化として棄却され（`isStale`・陳腐化A/B）、一片ごと省いた卓は合成の尾部が自前解で必ず置く（`committedSchedule`）。Change_Cost は合成後の計画（段 2）に対して数えるので、欠落した品目は比較の時点で存在しない。自前解は置ける品目を必ず置く（AC 3.4）。ゆえに欠落の費用は定めない（定めれば、消失 2L 対 分割 3L のような逃げ道の算術が生まれる・レビュー指摘）
5. THE Change_Cost SHALL 店舗全体の項として `total` にだけ足す（Lift_Overflow と同じ扱い・`lift-group-planning` AC 9.7）
6. THE Change_Cost SHALL 整数（秒相当）で閉じる

> **改訂（`pending-order-expiry` 判断 4・AC 2.4・ADR-0011・2026-09-06）:** 判断 3 と AC 2.3 の「消えた品目」（開始済み・キャンセル済み）に **期限切れ**（`arrivalTime + ORDER_LIFETIME_MS ≤ now`・`pending-order-expiry` の Expired_Order）が加わった。`ChangeContext.pending` は正本ではなく **Live_Orders**（`liveOrders(pending, now)`）で、文脈を組む 4 入口（`settle.deriveRecommendations`・`plan.receivePlan`・`admit`・`src/solver`）がそれぞれ自分の `now` で絞る。期限切れの品目は対応から外れて費用を動かさない（性質 5.5 の対応の規律に期限切れを含める）。期限切れの旧先頭を文脈に残せば、生きている次品目を遅らせる計画の先頭の変更（2L）が 0 に消える（レビュー実走：期限切れの旧先頭 A と生きている B で、B を遅らせる計画の変更費用は正しい文脈で 2L = 90 秒、A を残すと 0）。外部計画が期限切れの品目を指せば AC 2.4 の既存のハード制約（`isStale`）が棄却する——新しい費用も拒否事由も足さない。

> **改訂（`order-lifecycle` 判断 12・ADR-0013・2026-09-08）:** `ChangeContext.pending` は **`pendingOrders(items, timers, now)`**（期限内 ∧ `unstarted`・`liveOrders` を内側に畳む）。品目は開始で消費されなくなったが、対応は未調理の品目の間で数える（変わらない）——調理中（`cooking`）・調理済み（`done`）は「消えた品目」として対応から外れ、開始済み・期限切れと同じく費用を動かさない。厨房 Cancel で `unstarted` に戻った品目は（期限内なら）再び対応に入る。

### Requirement 3: 自前解が前回を残す

**User Story:** As a 設計者, I want 自前解が前回の配置を候補にする, so that 採点だけでは残らないまとまりが残る。

#### Acceptance Criteria

1. THE 自前解の釜の選択 SHALL 対応する品目の Shown_Plan の釜が空いていれば（解放時刻が候補に間に合えば）それを第一候補にし、無ければ既存の規則（最早解放 → 釜距離 → index）に落ちる
2. THE 自前解 SHALL 群の分割（batch・pack / split）で、Shown_Plan のまとまりを保つ候補を先に作り、Business_Cost の改善が Change_Cost を上回るときだけ別の分割を採る（局所比較・決定的）
3. THE 自前解 SHALL 合流の規則・上げ窓・slotSpan のハード制約を Shown_Plan より優先する（前回の釜が埋まっていれば動く）
4. THE 自前解 SHALL Shown_Plan に在った未着手の品目を、置けるならば必ず置く（既存の規律のまま——置ける品目を落とす経路は無い）

### Requirement 4: ゲートと不変点

#### Acceptance Criteria

1. THE Acceptance_Gate SHALL 外部計画を Business_Cost + Change_Cost で採点し、改善判定の基準は現行の Committed_Plan のまま（既存 AC 6.2(d)）
2. THE 変更 SHALL ハード制約（釜の排他・slotSpan・上げ窓の上限・合流の契約 (e)）を変えない
3. THE 変更 SHALL 表示（`lift-group-display`）を変えない。表示は計画の帰結を見せるだけ
4. THE 変更 SHALL Boil_Sync を変えない
5. THE Input_Fingerprint SHALL Shown_Plan を畳まない（Shown_Plan は前回の出力であり、入力の同一性では同じ計画は同じ）——ただし要求が Shown_Plan を運ぶので、外部解は最新の Shown_Plan で採点される

### Requirement 5: 検証可能な性質

1. **不変**：Shown_Plan と同じ計画は、比較の時点の now と Timer 集合に依らず Change_Cost 0（時間経過で濃くなった品目・anchor の失効で隠れた群を含む）
9. **時間経過の保護**：Shown_Plan で「10 秒に開始」だった品目は、10 秒以降の比較で旧側の Head に入り、それを先頭から外す新しい計画には 2 × L が付く
2. **消失は費用でなく棄却**：未着手で置ける品目を一片から外した外部計画は `isStale` で棄却され、卓ごと省いた計画は合成が自前解で埋める——Change_Cost が減る経路にならない
3. **先頭の保護**：Shown_Plan の Head の品目を Head から外す計画は、外さない計画より Change_Cost が 2 × L 以上大きい
4. **減衰**：同じ幅の時刻の移動は、遠い品目ほど Change_Cost が大きくならない（整数化ゆえ単調非増加）
5. **対応の規律**：開始済み・キャンセル済み・新規の品目は Change_Cost を動かさない
6. **自前解の保持（2026-09-07 改訂：実占有で検査し、配置の一致と Change_Cost = 0 を別々に検査する。保持候補 R の選択規則から従う）**：ハード制約が許し、かつ総費用（Business_Cost + Change_Cost）が改善しない限り、自前解は Shown_Plan の釜とまとまりを保つ（同じ入力で連続して計画すると、前回と同じ計画で Change_Cost 0 か、総費用が真に下がる計画になる。計画が変わるのは総費用が真に下がるときだけで、前回そのものは変更費用 0 ゆえ、now を含む業務入力を固定すれば業務費用そのものが厳密に下がり、有限回で同じ計画に落ち着く——実装で判明：前回を残す候補は前回の無い計画に無かった配置を見つけることがあり、それは 7 の「利益が上回れば変わる」そのもの）
7. **利益が上回れば変わる**：自前解が生成して比べる候補の範囲（Requirement 3 の釜の第一候補・分割の候補）で、Business_Cost の改善が Change_Cost を上回る候補が在れば、それを採る（局所探索であり、あらゆる改善配置の存在は保証しない）
8. **移行**：v11 以前の永続は `shownPlan` 空として保持され、落ちない
10. **自前解の合法性（2026-09-07）**：完成した R と F は物理的なハード制約（Requirement 7 の対象集合の `isStale`・解放表・`keepsAnchor`・`withinLiftCap`）を満たす。実占有で検査する
11. **保持は劣化しない（2026-09-07）**：摂動（時間経過・先頭の開始・新着・Complete）の後、選ばれた計画の総費用は F 単独より高くならない（選択規則から従う）。実測で重要なのは改善幅に加え、合法性・押せる提案・実際の提案変更量

### Requirement 6: 保持候補（2026-09-07 改訂・`startable-placement` のレビューで確定）

**背景。** 性質 5.6 は実占有（boiled の釜が在る状態）で落ちた（3 回に 1 回）。原因は、前回に忠実な候補（`Continuity.faithful`）を**生成器で作り直して**前回を再現しようとしていたことで、固定・下限・取り置きの規則を足しても将来の釜・分割・群まで一致する保証にならない（実測の反例 4 場面：下限 209.821 → 209 秒で総費用 +2、釜の取り置きで +40・+76・+64）。守りたい end state は「入力が変わっていないのに、調理者への提案が理由なく悪化しない」。5.6 は「生成器が前回を再現できる」性質ではなく、**候補の選択規則**として成り立たせる（ユーザー判断・2026-09-07）。

#### 確定した設計判断

9. **前回の計画は再計算せず、Shown_Plan から復元して保持候補 R にする。** 復元：`shownPlan` の品目のうち Live_Orders に在るものを、初出順の一片（現在の品目の `tableId`、卓なしは単独キー）に組み、`slotIds` / `startAt` / `serveAt` / `anchor` をそのまま持つ。群は `recommend` が付け直す（`mates` は不要）。過去開始の「今」（`startAt < now`）は **now に置き直してから**（retime：`startAt = now`・`serveAt = now + 茹で時間`）検証する。
9′. **復元した配置の錨の付け直し（2026-09-07・承認）。** 復元した配置の `anchor` は、旧 Shown_Plan の品目のうち**今回 Timer になったもの**（同じ卓の走行中の仲間で、Shown_Plan に在った品目）の実効 endTime にだけ付け直す。全走行中に付け直すと、生成器が意図して付けなかった錨が付く。
10. **復元した一片は、現在の注文・Timer・設定・採用済み接頭辞に対して、合成と同じ述語で検証する。** 一片ごとに計画順で、置ける品目に限る `isStale`（Requirement 7）・解放表の feasibility・`keepsAnchor`・`withinLiftCap`（**`cannotStart` は当てない・2026-09-07 承認**：retime の後に残るのは boiled の釜で待つ配置だけで、開始可能性は復元の後に必ず通す割当補正（`startable-placement` の loop）が守る）。不正な一片は**その位置で**その卓を生成器で再生成する（接頭辞のように「最初の不正で止める」形は、now が進むたびに前回の「今」が落ちてほぼ全再生成になり役に立たない・実測）。再生成した部分と尾部を含む **完成した R 全体**を、物理的なハード制約（Requirement 7 の対象集合の `isStale`・解放表・`keepsAnchor`・`withinLiftCap`）で検証する。R も現行の生成器を使う以上、F と同じ違反を持ち込み得る。
11. **F（現行の文脈つき生成・`startable-placement` の割当補正まで済んだ完成候補）と R を、同じ旧 Shown_Plan に対する総費用（Business_Cost + Change_Cost）で比べ、R ≤ F なら R。** 同点は前回。Shown_Plan は履歴であって現在の正しい計画ではないので、無条件には固定しない（判断 10 の検証を通ったものだけ）。
12. **`Continuity.faithful`（生成器による前回の再現）は撤去する。** 生成器の前回の釜の第一候補（AC 3.1）・まとまり・先頭・配置を保つ分割の候補（AC 3.2）は残す——復元は生成器の優先規則を置き換えず補完する（外すと 3000 場面中 42〜126 で劣る・実測）。
13. **保持の条件と計画全体の成立の条件は分ける。** `cannotStart`（`startAt ≤ now` で釜に Timer）は採用済み一片を**保持する**条件であり（復元した一片には当てない——判断 10・2026-09-07 承認：開始可能性は復元後の割当補正が守る）、生成した計画全体に一律には当てない——空き不足で boiled の釜の Complete を待つ配置（`startable-placement` AC 1.4）は合法である。述語の実装は共有しても、適用先は別。

#### Acceptance Criteria

1. THE 自前解 SHALL Shown_Plan から復元した保持候補 R を、生成した候補 F と並べて持ち、両方を同じ旧 Shown_Plan に対する総費用で採点して R ≤ F なら R を採る（同点は R）
2. THE 復元 SHALL Live_Orders に在る品目だけを初出順の一片に組み、過去開始の「今」を now に置き直し（retime）、一片ごとに判断 10 の述語で検証して、不正な一片はその位置で再生成する
3. THE 完成した R と F SHALL 物理的なハード制約（Requirement 7 の対象集合の `isStale`・解放表・`keepsAnchor`・`withinLiftCap`）を満たす。自前解だから免れる述語は無い
4. THE `Continuity.faithful` SHALL 撤去し、生成器は文脈つきの候補比較（F）だけを組む
5. THE 比較 SHALL 両候補とも遷移前の状態が持つ旧 Shown_Plan に対して行う（`plan-stability` AC 1.7）

### Requirement 7: 計画対象の「置ける品目」（2026-09-07 改訂・範囲を限定して承認）

`isStale`（一片の品目集合と卓の計画対象の一致）の対象集合を「置ける品目」にする。正本の計画対象のまま当てると、未知麺種や品目単体で上限を超える slotSpan を含む卓の一片は常に落ちる（自前解はその品目を置かないので集合が一致しない・3000 場面中 1319 一片）。

1. THE 対象集合 SHALL 期限（Live_Orders）と 64 件の制限で計画対象を決めた**後に**、茹で時間が引けること（プリセットに在る麺種）と品目単体の容量条件（`slotSpan ≤ arms + HELPER_ARMS`）で絞る。除外した分の繰り上げはしない（65 件目が入らない）
2. THE 対象集合 SHALL 現在の空き不足や上げ窓の混雑を除外理由にしない。それらは「置けない品目」ではなく「待つ品目」である
3. THE `isStale` SHALL 置ける品目の欠落と、対象外の品目の混入を引き続き棄却する
4. THE 自前解・復元・合成・外部ゲート SHALL 同じ対象集合を使う（定義は一箇所）
5. 回帰：未知麺種を含む卓の外部計画が採用できること、設定変更でその麺種が再び置けるようになると対象集合が広がり、以前の一片が欠落で落ちること

### naming ゲート（`naming.md`）

| 候補名 | 場所 | 表明する概念境界 |
| --- | --- | --- |
| `Shown_Plan` / `TimerState.shownPlan`（仮） | 要件語彙 / `state.ts` | 前回提示した内容（履歴の事実） |
| `Change_Cost` / `changeCost`（仮） | `objective.ts` または新 `stability.ts` | 前回提案からの変更費用 |
| `ShownItem`（仮） | `state.ts` | 品目ごとの `slotIds` / `startAt` / `serveAt` / 群の組 |

### 未決（design で決める）

- Shown_Plan の「群の所属」の表現（同じ群の品目の組の列か、品目ごとに群の代表品目の鍵を持つか）。
- 減衰の形（1 / (k + 1) は仮。上げの間隔の数 k の数え方を含む）。
- 自前解で「前回を保つ候補」をどこまで作るか（釜だけ／まとまりだけ／両方）と、局所比較の単位。
