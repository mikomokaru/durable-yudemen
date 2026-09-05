# Requirements Document

## Introduction

本 spec は、調理計画（Cook_Scheduling）の**計画側**を、現場の想定に合わせて改める。想定は「次に何を茹でるかを迷わず決められること」であり、待ち時間の最小化と提供時刻の同期はその順序を決める採点基準である。

計画が語るべき単位は**同時に上げる群**（Lift_Group）である。同じ卓の未着手の品目は一群をなし、群の中では茹で上がりが一致するように開始時刻が茹で時間の差だけずれる。この「揃える」を、制約でも保証でもなく、**目的関数が選ぶ結果**として得る。自前解も外部解も同じ物差しで採点され、揃えない計画は採点で負ける。

表示（client）は別 spec が担う。本 spec はワイヤを変えない。client は受け取った `startAt` と茹で秒から `serveAt` を再計算し、その等号で群を読む。ゆえに本 spec の出力は「群の中の `serveAt` が一致した計画」であり、それが表示の前提になる。

現状との差は 4 点である。(1) 計画は許容幅の内側に散らすだけで一致させない。(2) 走行中の仲間を群に留められない（Timer が卓を知らない）。(3) `slotSpan` を割当が読まない。(4) `arms` を計画が見ない。本 spec は (1)(2)(3)(4) を改め、Boil_Sync には触れない。

> **設計意図の記録:** 本 spec と対になる spec を横断する判断は `docs/adr/`（ADR 0001〜0003）に残す。判断の「なぜ」はそちらが正本で、本書は要件への演繹だけを担う。

> 判断 5・7・8・9・11 は 2026-09-04 のレビュー（目的関数が走行中を採点に含めないと一致が採点の帰結にならない、ほか）を受けて書き直し、同日ユーザーが承認した。

### 観測事実（実装前に確認済み・2026-09-04）

1. `placeBatch`（`src/engine/schedule.ts:494-508`）は卓の床 `tableFloor = max(earliest) − tableSyncToleranceSeconds × 1000` とオーダーの床を引き、`serveAt = max(earliest, tableFloor, orderFloor)` とする。同ファイル `:465-470` のコメントは「揃えるのは許容幅までで、それ以上は詰めない」と明記する。既定（卓 60 秒・オーダー 30 秒）では、つけ 510s / REG 360s / なんこつ 330s の卓は `serveAt` が 510 / 480 / 480 と散り、一致しない。
2. `initialRelease`（`schedule.ts:185-203`）は `running` を釜の解放時刻にしか使わない。卓の床は batch（未着手の品目）だけで計算され、同じ卓の走行中 Timer は計画の錨にならない。boiled の実効 endTime は定義上過去である（同関数のコメント）。
3. `Timer` は `orderItem`（`src/engine/timer.ts:60`・v7 で追加・欠如は `null`）を持つが卓を持たない。開始時に `consumeOrder` が PendingOrder を除くため、走行中 Timer の卓は状態から辿れない。帰結として、群の最初の 1 本を始めた瞬間に残りは「その 1 本抜き」で再計画され、群は崩れる。
4. 目的関数（`src/engine/objective.ts`）の卓同期項は `serveSpread`（最遅 − 最早・`:194-203`）のうち許容幅を超えた分（`excessSeconds`・`:206`）× w_table である。最大差しか見ないため、3 本以上の卓で 3 本目以降を待たせる得が無く、揃えると Σ待ち時間だけが増える。この形では、自前解が揃えても外部解が許容幅の内側に散らす方が点が良く、ゲート（feasibility のみ）を通れば採用される。
5. **目的関数は Placement だけを採点し、走行中 Timer を含まない。** `scoreSchedule`（`objective.ts:94-104`）の入力は `slices` / `pending` / `params` で、`running` を受けない。ゆえに走行中の仲間へ揃える配置は、揃えない配置より Σ Wait_Time の分だけ点が悪い。
6. Σ Wait_Time は `serveAt − arrivalTime` の和（`objective.ts:122` 付近）で、揃えのための待ちを含む。採点は整数（秒換算）で閉じ、それが Acceptance_Gate の「真に良いか同値か」の前提である（`objective.ts:4, 71`）。同 `:73-77` の doc は確定式を「3 項すべてが許容幅からの超過分で揃い、到達可能な下限 0 を持つ」と述べる。
7. `AcceptedSlice.score`（`schedule.ts:53, 65`）は永続され、Acceptance_Gate の改善判定は永続された `committed.score` と外部解の score を比較する（`admit.ts:77, 101`）。採点の基準が変われば、永続された score は現在の基準とずれる。
8. `slotSpan` は PendingOrder が持つが、`placeBatch` は 1 品目に必ず 1 釜を割り当てる（`schedule.ts:510`）。engine で `slotSpan` を読むのは `migrate.ts` / `types.ts` だけである。`pos-order-ingress` AC 6.36 は「engine が `slotSpan` を見て複数スロットを割り当てる変更は別 spec（`online-cook-scheduling` の改訂）で扱う」と繰り延べている。
9. `placeGroup`（`schedule.ts:421-439`）は釜数（`capacity = release.length`）を超える群を batch に分割し、2 番目以降は進めた解放表で置く。コメントは「分割の跨ぎで生じる提供時刻の開きはソフト制約違反として計上されるだけ」と記す。釜数を超える卓では `serveAt` は一致しない。
10. `tableGroups` は計画対象の上限（`PLAN_TARGET_LIMIT = 64`・`schedule.ts:237`）の境界で Table_Group が割れる場合、計画対象に入った品目だけでグループを成す（既存 AC 11.2）。
11. `arms` は Boil_Sync だけが用いる（`src/engine/sync.ts:20/33/132-136`・1 Sync_Set の最大本数・ハード）。計画側（`admit.ts` / `schedule.ts` / `commit.ts`）は参照せず、`digest.ts:55` が「計画へ届く経路は走行中 Timer の実効 endTime の変化ただ一つ」と理由を記す。`synchronized-boil-adjustment` AC 1.1 / 1.2 は arms 分割をハード制約と定める。
12. 釜距離項（`objective.ts:151-190`）は **placements の代表 slot 1 点ずつ**の全ペア距離を見る。`representativeSlot`（`:176`）は「複数 slot 占有は代表点で足りる」として辞書式最小の slot を採る。品目自身の `slotIds` どうしの距離は構造的に計上されない。尺度 `affinityToleranceDistance`（`src/domain/store.ts:101`・既定 14）は関連品目間の距離に用いる。
13. 重みは店舗設定で、妥当域は `WEIGHT_MIN = 0` 〜 `WEIGHT_MAX = 100`（`store.ts:59-62`）、既定は `orderSyncWeight = 3` / `tableSyncWeight = 2` / `affinityWeight = 1`（`:65-71`）。0 や 1 を設定できる。
14. `RequestPlan`（`src/engine/effect.ts:30-35`）は `pending` / `running: Timer[]` / `params: ScheduleParams`（8 値）/ `digest` を運び、`noodlePresets` を運ばない。一方、往路の契約 `PlanRequest`（`src/solver/request.ts:42`）は既に `noodlePresets` を運んでおり、shell が在メモリの投影（`this.noodlePresets`）から添えている。欠けているのは Effect の側で、実害は「茹で時間が届かない」ではなく **同じ要求の入力が engine（`params`）と shell（プリセット）の二箇所から来ている** ことである。
15. `digestInput`（`src/engine/digest.ts:73`）は計画対象の Pending_Order について `externalOrderId` / `itemIndex` / `noodleType` / `firmness` / `tableId` / `arrivalTime` の 6 つを畳み、`slotSpan` / `itemName` / `sizeName` を落とす。同 `:39` のコメントは「全フィールドを含める」と書いており、実装と食い違う（現状は `slotSpan` が計画に効かないため結果として整合）。
16. Acceptance_Gate の feasibility（`src/engine/admit.ts:40, 116-117`・`feasibleRelease`）は釜の排他・解放表の整合・`serveAt = startAt + 茹で時間` を見る。群の一致は見ない。
17. `Placement`（`schedule.ts:24-46`）は `serveAt` を持ち、`PlanSlice` は Table_Group ごとの一片である。`tableId` を持たない品目は単独キー（`schedule.ts:400-406`）へ写り、単独の Table_Group になる。
18. 茹で時間は `preset.boilSeconds[order.firmness] × 1000`（`schedule.ts:453`）。client の `boilSecondsOf` も同じプリセット・同じ硬さで引くため、両端の `startAt + 茹で秒` は整数ミリ秒で一致する。
19. `upsertOrder` は生きた Timer を持つ品目を置換から除く（`online-cook-scheduling` 要件 1.8）。POS が卓を変えて再送しても、走行中 Timer は旧卓の事実を保つ。
20. 開始時、engine は `slotIds` の数と `slotSpan` の一致を検査しない（`slot-suggested-start` AC 3.7・既存 AC 8.3）。
21. `hasLapsedStart`（`src/engine/commit.ts:116`）は `startAt < now` の一片を陳腐化として切り、残りを再計画する。本 spec はこれを変えない。
22. 永続スキーマは `CURRENT_SCHEMA_VERSION = 9`（`src/engine/types.ts:42`）。`snapshot.ts:21` のコメントは「現行は v8」のまま古い。
23. ワイヤの `CookRecommendation` は `startAt` を運び `serveAt` を運ばない（`src/domain/messages.ts:22-31`）。

### 確定した設計判断（すべて本要件へ演繹する・2026-09-04 の対話で確定）

1. **第一目的は順序の提示。** 待ち時間と同期は、順序を決める採点基準として目的関数に残る。
2. **計画は待てと言ってよい。** 揃えるための開始の遅延は正しい。待ちに上限を置かない。揃えのための待ちも Σ Wait_Time に数える（定義を二つにしない）。
3. **群 = 同じ卓の、計画対象に入った未着手の品目すべて。** 計画対象の上限（64 件）で卓が割れる場合は、入った品目だけで群を成す（観測事実 10 の既存の扱いを保つ）。卓を持たない品目は単独の群。オーダーは群の単位にしない（オーダー同期は減点項としてだけ残る）。
4. **群の中の `serveAt` は一致させる。ただし制約でも保証でもなく、採点の帰結である。** 揃えられない品目は遅れて上がり、卓同期の項で計上される。揃わなければ client 側では小さい群に分かれて見えるだけで、どの層も嘘をつかない。**一致が成り立つのは群が釜容量に収まるときである**（観測事実 9）。釜数を超える群は batch に割れ、batch を跨いだ差は減点として計上される。
5. **走行中の仲間を目的関数の成員にする。** 卓同期の項を「卓の最遅の提供時刻からの各品目の遅れの和 × w_table」に変え、許容幅を使わない。**卓の成員には同じ卓の走行中 Timer（実効 endTime を `serveAt` とし、動かせない）を含める。** この形の最適点は**ただ一点** `t = max(走行中の錨, 未着手の earliest の最大)` である（共通目標 t について、t がその値以下では費用の傾きが N(1 − w_table) < 0 で下り、超えると上る。個別に早める逸脱は (w_table − 1)Δ の損）。それは Group_Anchor の定義そのものであり、**「全品目を Group_Anchor に揃える」の一文で場合分けは尽きる**。未着手の `earliest` が走行中の錨に届かないときは群ごと錨より後ろへずれ、走行中との差は Table_Lag として残る——「届く限り 1 本目に揃い、届かなければ群ごと 1 本目より後に上がる」。錨に固定した基準点で採点する案は、`earliest` が解放表（＝計画順）に依存して採点が一片で閉じなくなり、外部での再現性を失うため採らない。
6. **走行中の仲間を群に留める。** `Timer` に `tableId`（engine 専用・永続・client ワイヤに出さない）を持たせる。`tableId` はオーダーの事実で、`orderItem` と同じ資格で Timer が持つ。計画の `serveAt` を開始時に Timer へ写す案（導出値の昇格）は採らない。**modification で卓が移っても走行中 Timer の `tableId` は追随しない**（観測事実 19）。その Timer は既に旧卓の群として茹でている事実であり、再送で届いた未着手の品目は新しい卓の群に入る。
7. **採点が走行中を読む帰結を引き受ける。** (a) `scoreSchedule` は `running` を受ける。(b) Boil_Sync の adjustment が変われば走行中の `serveAt` が動き、計画の採点が動く。これは「Boil_Sync を変えない」（判断 10）の内側であり、計画が Boil_Sync の出力を所与の事実として読むという既存の立場（`online-cook-scheduling` AC 9.3）の適用である。(c) 永続された `AcceptedSlice.score` は現在の走行中と食い違いうるため、**改善判定は外部解と現行 Committed_Plan の両方を、比較の時点の `running` で採点し直す**。永続 score は比較に用いず、**`PlanSlice`（したがって `AcceptedSlice`）と `CookSchedule` から `score` を落とす**（採点は placements から決まる導出値であり、永続すれば重みや走行中の変化とずれる）。score に触れる場所は 4 つある——書き手が `baselineSchedule` と `committedSchedule`（`commit.ts:74-86` が `scoreSchedule` を呼んで埋める）、読み手が改善判定と `settle` の等価判定（`settle.ts:250`）、加えて移行 `migrate.ts:219-232` が v9 の一片に score の整数性を要求している。書き手は不要になり、採点は比較の時点だけに寄る（配置と採点の分離）。等価判定は placements の比較で足りる。移行は v9 の余剰 score を捨てる。外部計画の契約からも score を外し、ソルバが添えても読まない。**基準は Committed_Plan のままで、自前解へ移さない**——基準を自前解に取れば、採用済みのより良い計画を後着の劣る計画が上書きできる（既存 AC 6.2(d) が Committed_Plan 基準を要求する理由そのもの）。
8. **arms 超過の重みは `w_table − 1` から導く（`max(0, tableSyncWeight − 1)`）。設定も定数も増やさない。** 判断 5 は w_table > 1 のときに揃える方が点が良くなる形で、妥当域（0〜100）を変えて下限を課す案は、同じことを registry・wire・畳み込みの三箇所の検証で守ることになる。導出なら任意の w_table ≥ 1 で「卓 > arms」が式から出る。w_table = 1 では arms 項が消え、揃えるか散らすかは同点になる（自前解は構成的に揃え、外部解が散らしても真に良くならず棄却される）。w_table = 0 では散らす方が点が良く、それは「この店は卓を揃えない」と設定した帰結である。既定は 2 なので何もしなければ揃う。arms 超過は卓の群を組むときにだけ生まれる費用で、「群を組む価値の一段下に群を組む代償を置く」関係が式になっている。
9. **arms 超過はソフト制約で、実質はタイブレークである。** 項は「群の本数のうち arms を超える分 × (w_table − 1)」で、単位は秒 対 本数、既定では 1 本あたり 1 秒に相当する。Σ Wait_Time の数十秒の前ではほぼ効かず、揃え方が同点のときだけ断つ。これは「卓が arms に勝つ」という決定の忠実な形であり、係数を大きくすれば決定を裏切る。効かせるなら「arms を超えた 1 本が上げ遅れる秒数」という計測値が要り、それが実在したときに持ち込む。「卓同期 > arms 超過 > 釜距離」の全順序は要求しない（既定 w_table = 2・w_affinity = 1 で間の整数が無く、採点は整数で閉じる）。
10. **Boil_Sync は変えない。** 開始後は arms がハードのまま 2+1 に分かれる。それは腕が 2 本である物理そのもので、群は現場に見せないので矛盾は表に出ない。
11. **`slotSpan` はハード制約。品目自身の釜どうしの距離は採点しない。** 品目は `slotSpan` 個の釜を同時に占む。既存の釜距離項は代表点 1 点で見るため品目内の距離を計上できず（観測事実 12）、新しい項を建てるほどの重複は無い。**釜の選択の第一基準は既存のまま「`slotSpan` 個すべてが空く最早時刻の最小化」で、釜距離は同点が余るときだけ断つ**——採点しない値（品目内距離）のために、採点する値（Σ Wait_Time）を悪化させない。外部解の品目内距離は問わない。
12. **ワイヤを変えない。** `CookRecommendation` に `serveAt` を足さない。client は `startAt + 茹で秒` で `serveAt` を再計算し（観測事実 18）、等号で群を組む。
13. **外部ソルバは残す。** 目的関数の形が変わるので、`RequestPlan` が運ぶ内容と外部側の採点の契約を本 spec で改める。`running` は既に運んでおり、`Timer.tableId` は錨の再現に要るため Solver へは出る（client ワイヤ `TimerFact` には出さない）。`noodlePresets` を `RequestPlan` に足す（観測事実 14 の穴）。ゲートは feasibility のみで、群の一致を求めない。
14. **Input_Fingerprint に `arms` と `slotSpan` を含める。** どちらも本 spec で計画に効くようになる。
15. **許容幅の設定は残す。** `tableSyncToleranceSeconds` は計画で使われなくなり、`orderSyncToleranceSeconds` / `orderSyncWeight` は減点項としてだけ残る。撤去は別の判断とし、撤去候補として記録する。
16. **`hasLapsedStart` は変えない。**

16. **始めたまとまりを、後続品のために崩さない（コードレビュー・2026-09-05 の設計懸念への判断）。** 釜容量を超える卓で 1 品を始めるたびに、未着手だけで満杯の batch を作り直すと、空いている釜があっても残りが走行中の仲間の錨ではなく次の batch へ押し出される（6 釜・同卓 4 品・各 2 釜・茹で 6 分で再現：開始前「3 品を今、1 品を 6 分後」→ 1 品を始めると「残り 3 品を 6 分後」）。守りたいのは「まだ始めていない卓を待ってまとめる」ことではなく「始めたまとまりを崩さない」ことなので、規則を**走行中の仲間が在る卓に限って**変える：合流できる品目だけで最初の batch を組み、残りは従来どおり。走行中が無い卓は従来どおり待ってまとめる（一般化した A は、少し待てば揃えられる卓を分割しかねず、群を組む意図に逆行する）。合流の判定は「いま空いている釜」ではなく「錨 − 茹で時間までに `slotSpan` 個すべてが空くか」で行う。時間の許容幅（A′・`tableSyncToleranceSeconds` の転用）は採らない——判定が投入時刻で閉じるので不要であり、空間の許容から時間の許容は導けず、撤去候補に別の意味を与える根拠も弱い。ADR-0007。

### スコープ外

- 表示（client）。`lift-group-display` が担う。
- Boil_Sync（`sync.ts` / `settle.ts` の同期・arms 分割・`toleranceRatio`）。
- `tableSyncToleranceSeconds` / `orderSync*` の撤去。
- `TimerFact`（client ワイヤ）への `tableId` の追加。
- 外部ソルバ（Solver_Worker）の内部実装。契約の改訂までを範囲とする。
- 品目内の釜距離の採点（判断 11）。
- `lapsed-suggestion-timing`。当初「マージしない」としたが、実際には #27 として main にマージ済み（2026-09-04 に実測）。目的ごと消える点は変わらず、`lift-group-display` が置き換える。本 spec は client を触らないので、この挙動は本 spec の間そのまま残る。

### tasks へ落とす作業項目

- `schedule.ts:465-470` の「揃えるのは許容幅までで、それ以上は詰めない」を判断 5 の帰結に書き換える。
- `pos-order-ingress` AC 6.36 の繰り延べを本 spec が解消した旨を追記する。
- `online-cook-scheduling` の Requirement 3 に (d) `slotSpan` を、Requirement 4 に arms 超過を追記し、確定注記の目的関数を判断 5 の形へ改める。
- `digest.ts:55` の「arms は畳まない」と `:39` の「全フィールドを含める」を、判断 14 の後の形へ改める。
- `objective.ts` の `ScheduleParams` 説明（「重み 3・許容幅 3・レイアウト 2 のちょうど 8 値」）と `effect.ts` の `params` 注釈（「8 値」）を改める。
- `objective.ts:73-77` の確定式を判断 5 の形へ書き換える。卓同期項は「卓の成員（走行中を含む）の最遅からの遅れの和 × w_table」、Σ Wait_Time は Placement のみ。「到達可能な下限 0」は「走行中の仲間が無い卓で到達可能」に弱める（走行中が錨より早く上がる卓では差が Table_Lag に必ず残る・AC 3.4）。コードのコメントが目的関数と食い違う状態を残さない。
- `snapshot.ts:21` の「現行は v8」を v10 で直す。
- `PlanSlice`（したがって `AcceptedSlice`）と `CookSchedule` から `score` を外す。書き手 `baselineSchedule`（`schedule.ts`）と `committedSchedule`（`commit.ts:74-86`）の採点呼び出しを消し、`objective.ts:86` の `Omit<PlanSlice, "score">` を不要にする。`settle.ts:250` の等価判定を placements の比較へ、`schedule.ts:103-128` の外部計画の受け口と `migrate.ts:219-232` の v9 移行から score の検証を外す（移行は余剰の score を捨てる）。`digest.ts:23` の「score をブランド化して指紋に混ぜない」、`admit.ts:9-12` の 2 段の説明（対応部分和・合成後総和 → 再採点の形）、`event.ts:73` の「plan.score は外部が主張した値」の注記を書き換える（判断 7）。

### naming ゲート（`naming.md`）

以下は公開シンボルであり、**実装前にユーザー確認を要する**。本 spec 内の表記は候補である。

| 候補名 | 場所 | 表明する概念境界 |
| --- | --- | --- |
| `orderItem.tableId`（入れ子） | engine の `Ordered.orderItem` | Timer が由来する卓。`null` は卓なし。`orderItem` の内側に置くことで、POS を経ない Timer が卓を持つ状態を表現不能にする |
| `Lift_Group` | 要件語彙（識別子にしない） | 同時に上げる群。同じ卓の計画対象の未着手品目全部 |
| `tableLagSeconds`（仮） | `objective.ts` の卓同期項 | 卓の最遅からの各成員（走行中を含む）の遅れの和 |
| `armsOverflow`（仮） | `objective.ts` の新しい項 | 群の本数が arms を超える分 |
| `scoreSchedule(slices, pending, running, params)` | `objective.ts` | 走行中を成員として採点する |
| `ScheduleParams` の項目変更（`arms` の追加） | `objective.ts` / `effect.ts` | 採点が `arms` を読む。値の意味を定めるのは目的関数の側ゆえ `SyncParams` から借りずここへ置く。外部契約に及ぶ |
| `PlanSlice` / `CookSchedule` からの `score` の削除 | `schedule.ts` | 一片は自分の点数を持たない。採点は比較の時点の導出であって計画の一部ではない（公開型の変更ゆえ追加と同じ資格で挙げる） |
| `RequestPlan.noodlePresets` | `effect.ts` | 外部解が茹で時間を引くための出所 |

## Glossary

- **Lift_Group（同時に上げる群）**: 同じ卓の、計画対象に入った未着手の品目すべて。卓を持たない品目は単独。計画は群の中の `serveAt` を一致させようとするが、一致は採点の帰結であって保証ではない。
- **Table_Member（卓の成員）**: 採点の単位としての卓の品目。未着手の Placement と、同じ卓の走行中 Timer（実効 endTime を `serveAt` とし、動かせない）の両方。`tableId` が `null` の走行中 Timer はどの卓の成員にもならない。
- **Group_Anchor（群の錨）**: `max(同じ卓の走行中 Timer の実効 endTime の最大, 未着手の品目の earliest の最大)`。一つの max であり、走行中が boiled（実効 endTime が過去）でも錨が過去へ落ちず、`earliest` が錨を超える品目も存在しない。群が釜容量を超えて batch に割れる場合は batch ごとに取り直す。
- **earliest**: ある品目を最も早く始めたときの提供時刻。`割り当てた全釜の解放時刻の最大 + 茹で時間`。
- **Table_Lag（卓の遅れ）**: 卓の成員のうち最も遅い `serveAt` から各成員の `serveAt` までの差。卓同期の項はこの和。
- **Arms_Overflow（arms 超過）**: 同時刻（同じ `serveAt`）に上がる Table_Member の本数のうち `arms` を超える分。群の本数ではない——腕が競合するのは同時刻だけで、batch に割れて同時に上がらない本数は数えない。卓同期項と同じ成員集合の上で数える。重みは `max(0, tableSyncWeight − 1)` の導出値で、実質はタイブレーク。
- **Wait_Time**: `serveAt − arrivalTime`。揃えのための待ちを含む。
- **Acceptance_Gate**: 外部計画の受け入れ判定。feasibility は釜の排他・解放表・`serveAt = startAt + 茹で時間`・`slotSpan` の充足。群の一致は見ない。改善判定は外部解と現行 Committed_Plan を、比較の時点の `running` で採点し直して比べる（基準は Committed_Plan）。
- **Boil_Sync**: 開始後の茹で上がり調整（`synchronized-boil-adjustment`）。本 spec は触れない。

## Requirements

### Requirement 1: 群の形成

**User Story:** As a 厨房スタッフ, I want 同じ卓の麺が一緒に上がるように順に入れられる, so that 卓の丼が揃って出る。

#### Acceptance Criteria

1. THE 計画 SHALL 同じ `tableId` を持つ、計画対象に入った未着手の品目すべてを一つの Lift_Group とする
2. THE 計画 SHALL `tableId` を持たない品目を単独の Lift_Group とする
3. THE 計画 SHALL オーダー（`externalOrderId`）を Lift_Group の単位にしない
4. WHEN 釜容量に収まる Lift_Group を配置する, THE 自前解 SHALL 各品目の `serveAt` を Group_Anchor に一致させる
5. WHEN Lift_Group が釜容量を超える, THE 自前解 SHALL 群を batch に分け、**batch ごとに Group_Anchor を取り直して** batch の中で AC 1.4 を満たし、batch を跨いだ差を卓同期の項で計上する
6. THE 計画 SHALL Lift_Group の中の `serveAt` の一致を制約にせず、目的関数の採点の結果として得る
7. THE 計画 SHALL 揃えるための開始の遅延に上限を置かない
8. WHEN Lift_Group の卓に走行中の仲間が無い, THE 自前解 SHALL AC 1.4 / 1.5 のとおり、待つことも含めて群をまとめる（空いている釜に入る品目だけを先に出さない）
9. WHEN Lift_Group の卓に走行中の仲間が在る, THE 自前解 SHALL 走行中の錨に**合流できる**品目だけで最初の batch を組み、合流できない品目のために合流できる品目を押し出さない。合流できるとは、品目の `slotSpan` 個の相異なる釜すべてが「錨 − 茹で時間」までに空くことである（いま空いているかではなく、逆算した投入時刻までに空くか。錨 510 秒・茹で 330 秒なら 30 秒後に空く釜でも合流できる）
10. WHEN 走行中の錨に合流できる品目が無い（走行中が boiled だけで錨が過去、または茹で時間が錨までの残りより長い）, THE 自前解 SHALL 残りの品目で AC 1.5 のとおり次の batch を組み直す

_出所: 判断 1・2・3・4・5・16, 観測事実 1・9・10・17_

### Requirement 2: 目的関数

**User Story:** As a 設計者, I want 自前解と外部解が同じ物差しで「揃える」を選ぶ, so that ゲートに一致を求めずに済む。

> **前提:** 本要件と Requirement 1・3・7 は既定 `tableSyncWeight = 2` を前提とする。w_table ≤ 1 に設定した店では揃える方が点が良くならず（w_table = 1 で同点、0 で散らす方が良い）、それは「この店は卓を揃えない」と設定した帰結である。w_table = 0 の店では自前解が自分の目的関数の最適から離れる（散らす方が点が良いのに構成的に揃える）ため、外部解が常に自前解を上書きしうる。妥当域は変えない。

#### Acceptance Criteria

1. THE 目的関数 SHALL 卓同期の項を、卓の成員（未着手の Placement と同じ卓の走行中 Timer）のうち最遅の `serveAt` からの各成員の遅れの和（Table_Lag の和）× w_table とする。`tableId` が `null` の走行中 Timer はどの卓の成員にもならない（卓なし同士を束ねず、単独キーの一片の成員にもしない）
2. THE 卓同期の項 SHALL 許容幅（`tableSyncToleranceSeconds`）を用いない
3. THE 目的関数 SHALL 走行中 Timer の `serveAt` を実効 endTime（Boil_Sync 調整後）とし、動かせない成員として扱う
4. THE 目的関数 SHALL Arms_Overflow の項を持ち、その重みを `max(0, tableSyncWeight − 1)` から導く（設定項目も定数も足さない）
5. THE 目的関数 SHALL Σ Wait_Time に揃えるための待ちを含める（`serveAt − arrivalTime` の定義を変えない）
6. THE 目的関数 SHALL オーダー同期の項（既存の形＝同一オーダー内の最大差の許容超過分）と釜距離の項を残す
7. THE 目的関数 SHALL 品目自身の `slotIds` どうしの距離を採点しない
8. THE 目的関数 SHALL 整数（秒換算）で閉じる
9. THE 目的関数の各項 SHALL 卓（Table_Group と、その卓の走行中 Timer）の内部に閉じ、総和が一片の部分和の和で尽きる

_出所: 判断 5・7・8・9・11, 観測事実 4・5・6・12・13_

### Requirement 3: 走行中の仲間

**User Story:** As a 厨房スタッフ, I want 群の 1 本目を入れた後も、届く限り残りが 1 本目に揃う, so that 最初の一手で同期が崩れない。

#### Acceptance Criteria

1. THE engine の `Timer` SHALL 由来する卓 `tableId`（`string | null`）を `orderItem` の内側に持つ（`orderItem: { externalOrderId; itemIndex; tableId } | null`）。卓を持たない品目は `null`。アドホック麺茹では `orderItem` 自体が `null` なので、「POS を経ないのに卓を知る Timer」は構築不能である
2. WHEN 品目からの開始（`startOrderItemTimer`）で Timer を生成する, THE engine SHALL 当該 PendingOrder の `tableId` を Timer に写す
3. THE Group_Anchor SHALL `max(同じ卓の走行中 Timer の実効 endTime の最大, 未着手の品目の earliest の最大)` とする（boiled の実効 endTime が過去でも錨は過去へ落ちない。一つの max ゆえ `earliest` が錨を超える品目は存在しない）
4. THE 自前解 SHALL 群の未着手の品目すべての `serveAt` を Group_Anchor に一致させる。走行中の仲間が錨より早く上がる場合、その差は Table_Lag として計上される
5. THE `tableId` SHALL `TimerFact`（client ワイヤ）に出さない。`RequestPlan` の `running` には出る
6. WHEN modification で品目の卓が変わる, THE engine SHALL 走行中 Timer の `tableId` を変えない（再送で届いた未着手の品目は新しい卓の群に入る）
7. THE 永続スキーマ SHALL 版を 9 から 10 へ上げる。移行は v9 以前の Timer の `tableId` の欠如を `null` に畳み（追加）、v9 の `AcceptedSlice` が持つ `score` を余剰として捨てる（除去）。score の整数性の検証（`migrate.ts:219-232`）を外さなければ v10 の永続データが読めない

_出所: 判断 5・6, 観測事実 2・3・19・22_

### Requirement 4: slotSpan と釜の選び方

**User Story:** As a 厨房スタッフ, I want 大盛が 2 釜ぶん計画される, so that 提案どおりに入れたら釜が足りないことが無い。

#### Acceptance Criteria

1. THE 計画 SHALL 品目に `slotSpan` 個の釜を割り当て、その全部が空くまで開始時刻を置かない（ハード制約）
2. THE Acceptance_Gate SHALL `slotSpan` を満たさない外部計画を feasible と認めない。満たすとは `slotIds` の本数が `slotSpan` に等しく、かつ釜が相異なることである（`["3","3"]` は本数 2 で 1 釜しか占めない）。相異なるかは**釜番号**で比べる（`["0","00"]` は表記が違うだけの 1 釜）
3. THE 自前解 SHALL 釜の選択の第一基準を「`slotSpan` 個すべてが空く最早時刻の最小化」とし、同点が余るときだけ釜距離で断つ（既存 `chooseSlots` の優先順位を変えない）
4. THE `Placement.slotIds` SHALL 割り当てた釜すべてを持つ（`Timer.slotIds` と同じ基数）
5. THE 計画 SHALL 釜容量を `slotSpan` の合計で数える（batch の分割の単位）
6. THE 確定計画の合成 SHALL 採用済み一片の配置が品目の**現在の** `slotSpan` を満たさなければ陳腐化と見なし、そこから先を自前解で置き換える（v9 で採用された 1 釜の配置は v10 の制約で再検証される。永続は書き換えない。述語は Acceptance_Gate と同じ一つ）
7. THE Acceptance_Gate SHALL 走行中の実効 endTime を、採用後に確定する Boil_Sync の同期結果（現行の設定で同期し直した値）で読む。設定の差し替えを跨いだ状態の古い adjustment で採点しない（判定の錨と確定の錨を一つにする）

_出所: 判断 11, 観測事実 8・9・12_

### Requirement 5: 外部ソルバとゲート

**User Story:** As a 設計者, I want 外部解が新しい採点で比較される, so that 揃えない外部解が自前解を上書きしない。

#### Acceptance Criteria

1. THE `RequestPlan` SHALL 改めた目的関数に要る値（重み・`arms`・レイアウト）と `noodlePresets` を運び、使われなくなった許容幅に依存しない。外部ソルバは arms 超過の重みを `max(0, tableSyncWeight − 1)` で導く（契約として明記し、別の重みで採点した外部解が同じ物差しに乗らないことを防ぐ）
2. THE `RequestPlan` の `running` SHALL `Timer.tableId` を含む（錨の再現に要る）
3. THE Acceptance_Gate SHALL feasibility を釜の排他・解放表の整合・`serveAt = startAt + 茹で時間`・`slotSpan` の充足で判定し、Lift_Group の `serveAt` の一致を求めない
4. THE Acceptance_Gate の改善判定 SHALL 基準を現行 Committed_Plan に置いたまま（既存 AC 6.2(d)）、外部解と Committed_Plan の両方を比較の時点の `running` で採点し直して比べる
5. THE Input_Fingerprint SHALL `arms` と `slotSpan` を含める
6. THE `PlanSlice`（したがって `AcceptedSlice`）および `CookSchedule` SHALL `score` を持たない。`baselineSchedule` / `committedSchedule` は採点を呼ばず、採点は比較の時点だけで行う。`settle` の等価判定は placements の比較で行い、外部計画の契約から score を外す（ソルバが添えても読まない）

_出所: 判断 7・13・14, 観測事実 7・11・14・15・16_

### Requirement 6: 不変点

**User Story:** As a 設計者, I want 本変更が触れない範囲が明文である, so that 引き算が別の足し算を呼ばない。

#### Acceptance Criteria

1. THE 変更 SHALL Boil_Sync（`sync.ts` / `settle.ts` の同期・arms 分割・`toleranceRatio`）を変更しない
2. THE 変更 SHALL client ワイヤ契約（`CookRecommendation` / `ServerMessage` / `ClientMessage` / `TimerFact`）を変更しない
3. THE 変更 SHALL `recommend` の形（確定計画の全品目を計画順に配る）を変更しない
4. THE 変更 SHALL `hasLapsedStart` の規律を変更しない
5. THE 変更 SHALL `StoreConfig` の項目と妥当域を増減・変更しない（許容幅の設定は残し、撤去候補として記録する）
6. THE 変更 SHALL 開始時に `slotIds` の数と `slotSpan` の一致を検査しない規律（既存 AC 8.3）を変更しない。計画がハード制約にした後も、開始は現場の判断に委ねる
7. THE 変更 SHALL Alarm・時刻起動の失効判定を導入しない（AC 7.5）
8. THE 変更 SHALL 推奨開始時刻の到来で Timer を自動開始しない（AC 8.2）

_出所: 判断 10・12・15・16, 観測事実 20_

### Requirement 7: 検証可能な性質

**User Story:** As a 保守者, I want 「揃える」が採点の帰結として成り立つことを性質で固定したい。

#### Acceptance Criteria

1. **錨への一致** — 釜容量に収まる任意の卓について、自前解が配置した未着手の品目の `serveAt` はすべて Group_Anchor に等しい（走行中の仲間の有無で場合を分けない。茹で時間が引けず配置されない品目は対象外）
2. **採点の単調性** — w_table ≥ 2 の下で、釜容量に収まる卓の揃えた配置から一部の品目だけを早めて `serveAt` を散らした計画は、揃えた計画より目的関数の値が真に良くならない（Arms_Overflow が無ければ真に大きい。超過が立っている一片では超過項が `w_table − 1` 減るため最悪で同値になり、同値は Acceptance_Gate が棄却する）。**ずれが 1 ミリ秒でも成り立つ**（client は `serveAt` の等号で群を組むため、秒未満のずれでも群が割れる。Table_Lag の秒換算を切り上げにすることでこれを担う・ADR-0006）
3. **実行可能性** — 自前解のすべての配置は `startAt ≥ 割り当てた全釜の解放時刻の最大` かつ `serveAt = startAt + 茹で時間` を満たし、`slotSpan` 個の釜を持つ
4. **両端の一致** — 任意の配置について、client が `startAt + 茹で秒` で再計算する `serveAt` は計画の `serveAt` と一致する
5. **移行（追加）** — v9 以前の永続 Timer は `tableId = null` として保持され、落ちない
6. **移行（除去）** — v9 の永続 `AcceptedSlice`（`score` を持つ）は v10 で `score` を捨てて保持され、落ちない（`migrate.ts:219-232` の整数性検証を外し忘れた実装はこの性質で落ちる）
7. **部分和** — 目的関数の総和は卓ごとの部分和の和に等しい
8. **整数** — 目的関数の値は整数である
9. **卓同期項の下限** — 走行中の仲間が無い、釜容量に収まる卓について、自前解の卓同期項は 0 である（下限 0 に到達できる）
10. **Arms_Overflow の下限** — 群の本数が `arms` 以下なら Arms_Overflow は 0 である

_出所: 判断 4・5・6・7・8・11・12_

### Requirement 8: 文書の整合

**User Story:** As a 保守者, I want 先行 spec の記述が本変更後に嘘にならない。

#### Acceptance Criteria

1. WHEN 本 spec を実装する, THE 変更 SHALL `online-cook-scheduling` の Requirement 3 に `slotSpan` を、Requirement 4 に Arms_Overflow を、確定注記の目的関数を判断 5 の形へ、同じコミットで改める
2. THE 変更 SHALL `pos-order-ingress` AC 6.36 の繰り延べを解消した旨を追記する
3. THE 変更 SHALL `schedule.ts:465-470`・`digest.ts:39, 55`・`objective.ts` の `ScheduleParams` 説明・`effect.ts` の `params` 注釈・`digest.ts:23` の score の注記・`objective.ts:73-77` の確定式と「3 項すべてが許容幅からの超過分で揃い、到達可能な下限 0 を持つ」（卓同期項は Table_Lag の和になり、Σ Wait_Time の対象は Placement のみ・lag の対象は走行中を含むので式は分けて書く。下限 0 は走行中の仲間が無い卓で到達可能、に弱める）・`objective.ts:86` の `Omit<PlanSlice, "score">` の段落・`admit.ts:9-12` の 2 段の説明・`event.ts:73` の「plan.score は外部が主張した値」・`snapshot.ts:21` の古い記述を改める
4. THE 変更 SHALL `tableSyncToleranceSeconds` / `orderSync*` を撤去候補として `online-cook-scheduling` の design に記録する。前者は「`ScheduleParams` に在るが読む計算が一つも無い」ことを明記する（読み手のいない値は、次の保守者が使い所を探して見つけられない）

_出所: tasks へ落とす作業項目_
