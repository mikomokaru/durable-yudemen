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
6. **自前解の保持**：ハード制約が許し、かつ総費用（Business_Cost + Change_Cost）が改善しない限り、自前解は Shown_Plan の釜とまとまりを保つ（同じ入力で連続して計画すると、前回と同じ計画で Change_Cost 0 か、総費用が真に下がる計画になる。総費用は単調に下がるので有限回で同じ計画に落ち着く——実装で判明：前回を残す候補は前回の無い計画に無かった配置を見つけることがあり、それは 7 の「利益が上回れば変わる」そのもの）
7. **利益が上回れば変わる**：自前解が生成して比べる候補の範囲（Requirement 3 の釜の第一候補・分割の候補）で、Business_Cost の改善が Change_Cost を上回る候補が在れば、それを採る（局所探索であり、あらゆる改善配置の存在は保証しない）
8. **移行**：v11 以前の永続は `shownPlan` 空として保持され、落ちない

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
