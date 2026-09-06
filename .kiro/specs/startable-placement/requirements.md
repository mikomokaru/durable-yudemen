# Requirements Document

## Introduction

本 spec は、**計画上は「今」開始できるはずの先頭が、実際には押せない釜に置かれ、それが本当に開始できる後続まで隠す**構造を直す。守るのは「常に now の提案が在る」ことではなく、**合法な次の開始が可能なのに、割当と表示規則の食い違いだけで操作できなくならない**ことである（ユーザー調査・2026-09-06・対象 6947f39）。

原因は二つの契約の食い違いにある。engine の解放表（`initialRelease`）は茹で上がった釜（boiled・Complete 前）を「今すぐ空いている」と扱い、client の占有判定（`occupiedSlots`）は Complete まで占有扱いにする。さらに群の連鎖（`visibleGroupsOf`）は未開始の先頭群で連鎖を止める。結果として、Complete で空いた釜が在っても、先頭が boiled の釜に置かれれば全提案が消える。

**方針（ユーザー推奨）**：「将来いつ空く見込みか」（解放表の予測）と「今、開始操作できるか」（対象釜に Timer が存在しない・client と同じ事実）を分ける。Complete による再計画では、ハード制約を満たして先頭群を空き釜へ置けるならその候補を生成し、未完了の釜への前回割当を守ることで開始可能な提案がゼロになる状態を避ける。**後続群を無条件に表示する変更は第一案にしない**（業務のまとまりを守る意図を崩す）。空き釜不足・複数釜・上げ窓などで開始できない場合の待ちは残す。

前提は `lift-group-planning`（解放表・釜の選択・上げ窓）、`lift-group-display`（全釜 idle・連鎖・Head）、`plan-stability`（前回の釜の第一候補・変更費用）。

### 観測事実（2026-09-06・main `Merge #34` 時点）

1. **解放表は boiled を「今」空きとする。** `initialRelease`（`schedule.ts:210-228`）は Timer の実効 endTime の最大を釜の解放時刻とし、下限を `now` に置く。boiled（`boiledAt` 非 null）の実効 endTime は過去なので `now` になり、**空き釜と同じ値**になる。関数の注記は「湯切りで麺が釜から上がるため釜は空いており、Complete は UI 上の確認であって釜の占有ではない」と述べる。
2. **client の占有は Complete まで。** `liftGroups.ts:167-173` の `occupiedSlots(view)` は snapshot の全 Timer（running / boiled とも）の釜を占有とする。表示の条件「全釜 idle」（`lift-group-display` Head の定義・性質 8：表示される提案の `slotIds` の全釜は idle）は `headsOf` / `displayableItemsOf`（`domain/lift-group.ts:113-142`）がこの集合で判定する。
3. **連鎖は未開始の先頭群で止まる。** `visibleGroupsOf`（`domain/lift-group.ts`）は最早 `startAt` 順の群の列で、先頭の群と「それより前がすべて Group_Started（`anchor > now`）」の群だけを表示する。先頭群が boiled の釜に置かれて開始できないと、後続群は本当に開始できても隠れる。
4. **釜の選択は解放時刻 → 釜距離 → index。** `chooseSlots`（`schedule.ts`）は「count 本すべてが空く最早時刻」が最小の組を候補にし、同点は釜距離、さらに index 昇順で断つ。boiled の釜と空き釜は解放時刻が同じ `now` なので、index の小さい boiled の釜が先に選ばれる。
5. **前回の釜の第一候補は解放時刻だけを見る。** `assignSlots` / `chooseSlots(…, preferred, freeBy)`（`plan-stability` AC 3.1）は、前回の釜が `release[s] ≤ freeBy`（候補の提供時刻 − 茹で時間）なら採る。boiled の釜は `release = now` なので、候補が「今」でも前回の釜として採られ続ける。
6. **Complete は再計画を起こす。** `complete.ts` → `settle` で確定計画を導き直し、snapshot を配信する。解放表は Complete で変わらない（boiled は既に `now` だった）ので、割当も変わらない。
7. **Acceptance_Gate の feasibility (c)** は解放表で検査する（`admit.ts` `feasibleRelease`）。boiled の釜に「今」置く外部計画は feasible である。
9. **計画の群の順と表示の群の順は同点の断ち方が違う。** 計画（`tableGroups`・`schedule.ts`）は卓の群を「最早到着 → `tableKey`」で並べる。表示（`liftGroupsOf`・`domain/lift-group.ts:79-84`）は群を「先頭品目の `startAt` → 到着順 `compareArrival`（arrivalTime → externalOrderId → itemIndex）」で並べ、群の中も同じ順。同時到着の「卓 a／注文 z」と「卓 b／注文 a」は、計画では卓 a（z）が先、表示では注文 a（卓 b）が先になる（レビュー反例）。**先頭 arms 本は表示の順で数える**ので、計画の順で空き釜を配っても表示の先頭に渡らない。
10. **採用済み接頭辞は再割当されない。** 確定計画の合成（`commit.ts` `livePrefix`）は採用済み一片をそのままの釜と時刻で残し、失効は `isStale`（計画対象との不一致）と「過去開始」（`commit.ts:164`・`startAt < now`）だけである。`startAt === now` で boiled の釜に置かれた採用済み一片は残り、尾部が別の品目を空き釜に「今」で置いても、先頭は接頭辞の押せない品目のまま Head が空になる（レビュー実走）。過去に受領した将来計画が時刻の到来で「今」になった場合も同じ。
8. **再現（ユーザー調査・コード変更なし・decide → Broadcast snapshot → decideView → liftGroups → slotSuggestions）。** 6 釜・arms 2・toleranceRatio 10%・上げ間隔 45 秒・Thin normal 60 秒・slotSpan 1・卓なし 8 品。表示された head から 3 秒間隔で開始し、茹で上がりの 15 秒後から釜番号の大きい順に 3 秒間隔で Complete。最初の 6 品の開始は 0 / 3 / 6 / 9 / 42 / 45 秒。72 秒に釜 1 を Complete すると、釜 0 は茹で上がり済み・未完了、釜 1 は完了済み・空き、残り A は釜 0 に「今」（先頭群）、B は釜 1 に「今」（後続群）で、**表示はどちらも出ない**。A は釜が占有扱いで非表示、B は空き釜で開始可能だが A の群が未開始なので連鎖で非表示。75 秒に釜 0 を Complete すると再開する。対照：卓なし 24 品の連続処理で、Complete を釜番号の小さい順に行うと「空き釜に開始時刻到来済みの推奨があるのに提案ゼロ」は 0 箇所、大きい順では 6 箇所（前回計画の履歴の有無に依らない）。全ケースで最終的に 24 品は処理できた。同卓 24 品・4 品ごとの卓分けでは今回の条件でこの空白は出なかった。**永続的な停止や周回による劣化ではなく、再利用時の完了順に依存して提案が途切れる問題**である。`plan-stability` の履歴は必要条件ではない。

### 確定した設計判断（2026-09-06・ユーザー推奨を反映。レビューで確定する）

1. **予測と事実を分ける。** 解放表（「将来いつ空く見込みか」）は変えない——boiled の釜は `now` に空く予測のまま。「今、開始操作できるか」は **対象釜に Timer が存在しない**（client の `occupiedSlots` と同じ事実）で判定し、engine はこの事実を計画の**釜の選択規則**に読ませる。連鎖（`visibleGroupsOf`）と全釜 idle（`headsOf`）は変えない。
2. **「今」置く配置は、Timer の無い釜を先に採る。** 候補の開始が `now` 以前（`候補の提供時刻 − 茹で時間 ≤ now`）の品目の釜の選択では、解放時刻が同点の釜のうち **Timer の無い釜を Timer の在る釜（boiled・Complete 待ち）より先に**採る。同点の断ち方は既存のまま（前回の釜 → 釜距離 → index）で、その前に「Timer の有無」を置く。候補の開始が `now` より後なら、boiled の釜はそれまでに Complete される予測に立ち、既存の規則のまま（占有は解放表の予測に委ねる）。
3. **前回の釜の第一候補は、「今」置くときは Timer の在る釜に効かない（選択規則の明記）。** `plan-stability` AC 3.1 の「候補の時刻までに空く」を、候補の開始が `now` 以前のときは「解放時刻が候補に間に合い、**かつ Timer が無い**」と読む。Timer の在る前回の釜は採らず、Timer の無い釜へ移る（釜の変更費用 L は払う——開始できない提案を守る価値は無い）。候補の開始が `now` より後なら従来どおり。同点処理だけでは変更費用が旧割当を残すため、選択規則として固定する（ユーザー指摘）。
4. **空き釜が足りなければ待つ。** 「今」置く品目が Timer の無い釜より多ければ、余りは Timer の在る釜（解放 `now`）に置かれて Complete を待つ。これは空き釜不足の待ちであり、本 spec は解消しない（後続群を無条件に出さない）。先頭群から順に Timer の無い釜を配るので、先頭群の先頭が押せない状態は空き釜不足のときだけになる。
5. **ハード制約・ゲート・上げ窓・まとまりは変えない。** Timer の在る釜に「今」置く配置は feasible のまま（外部計画が置けば採り得る。自前解は判断 2〜3 で置かない）。上げ窓・釜の排他・群のまとまり・合流の契約は既存のまま。
6. **Complete の再計画で先頭群が空き釜へ動く。** Complete で Timer が消えた釜は「Timer の無い釜」になり、次の確定計画で先頭群の「今」の配置がそこへ動く（判断 2〜3）。変更費用の釜 L は、前回に忠実な計画も同じ選択規則を通るので両候補に等しく乗り、比較を歪めない。
7. **Startable_Slot の配分順は表示の先頭の順に結び付ける（レビュー指摘 1）。** 表示の先頭は「`startAt` 昇順・同値は到着順 `compareArrival`」で数える。自前解の「今」配置は `startAt = now` で揃うので、配分順は到着順 `compareArrival` になる。計画の群の順の同点の断ち方を `tableKey` から **群の先頭品目の `compareArrival`**（arrivalTime → externalOrderId → itemIndex）へ改め、群の中では「今」置く品目に到着順で Startable_Slot を配る。これで「計画で先に置いた群」と「表示で先頭になる群」が一致し、空き釜が表示の先頭に渡る。順の変更は同時到着の同点だけに効く（決定性は保つ）。
8. **合成の接頭辞にも「開始を妨げる配置」の失効を足す（レビュー指摘 2）。** 採用済み一片に `startAt ≤ now` かつ釜に Timer が在る配置が含まれるなら、その一片は接頭辞から落とし、尾部（自前解・判断 2〜3）が置き直す。既存の「過去開始」（`startAt < now`）の失効を「開始できない配置」へ広げる形で、失効の述語は合成の一箇所に置く。過去に受領した将来計画が時刻の到来で「今」になり、その釜がまだ boiled なら同じ規則で落ちる。これは合成（維持）の契約であり、ゲートの feasibility（物理的な配置の可否）を変えるかとは別の判断（未決 3）。
9. **保証の範囲は「再計画の時点」に限る（レビュー指摘 3）。** 保証するのは、遷移（Complete・開始・発火・受理・受領）で確定計画を導き直す時点で、**表示の先頭群の先頭品目**が Startable_Slot に合法に「今」置けるなら、そこに置かれて先頭として現れること。例外は二つ——(a) 先頭品目の slotSpan に足る Startable_Slot が無い、または上げ窓・合流の契約が「今」を許さない（判断 4 の待ち。空き 1 釜・先頭 A が span 2・後続 B が span 1 なら B に時刻が来ても連鎖は止まる）。(b) 遷移なしの時刻経過だけで将来配置の `startAt` が来た場合——その配置は boiled の釜が Complete される予測で置かれており、次の遷移で判断 8 と 2〜3 が置き直す。同じ snapshot の内側では保証しない。
10. **将来配置は現在の占有を直接の優先条件にしないが、波及は許す（レビュー指摘 4）。** 候補の開始が `now` より後の配置の釜の選択は Timer の有無を見ない（判断 2）。ただし先行する「今」配置の釜が変われば解放表が変わり、将来配置の釜も変わり得る（A＝60 秒を釜 0 から 1 へ動かせば、60 秒後に空く釜が変わり C の釜も変わる）。完全不変は主張しない。

### スコープ外

- 群の連鎖の規則（`visibleGroupsOf`）と全釜 idle（`headsOf`）の変更。第一案にしない。
- boiled の釜を「占有」として解放表に載せる（Complete の時刻は予測できず、待ち時間の起点が消える）。
- Complete の自動化・boiled の自動 Complete。

## Glossary

- **Startable_Slot（開始できる釜）**: Timer（running / boiled とも）が一つも載っていない釜。client の `occupiedSlots` の補集合と同じ事実。
- **Now_Placement（「今」置く配置）**: 候補の開始時刻（候補の提供時刻 − 茹で時間）が `now` 以前の配置。表示では開始推奨時刻が来た品目に当たる。
- **Release_Table（解放表）**: 釜ごとに「いつ空く見込みか」を持つ既存の表。boiled の釜は `now`。変えない。

## Requirements

### Requirement 1: 「今」置く配置は開始できる釜を先に採る

**User Story:** As a 現場, I want 「今」と提案された品目の釜が実際に押せる釜である, so that 提案に従ってすぐ始められる。

#### Acceptance Criteria

1. WHEN 品目の候補の開始時刻が `now` 以前であるとき、THE 釜の選択 SHALL 解放時刻が同点の候補のうち Startable_Slot を、Timer の在る釜より先に採る（既存の同点処理——前回の釜・釜距離・index——はその後に適用する）
2. WHEN 品目の候補の開始時刻が `now` より後であるとき、THE 釜の選択 SHALL 既存の規則のままとする（boiled の釜はそれまでに Complete される予測。Timer の有無を見ない）
3. THE Release_Table SHALL 変えない（boiled の釜の解放時刻は `now`。下限 `now` も既存のまま）
4. WHEN Startable_Slot が「今」置く品目の数に足りないとき、THE 余りの品目 SHALL Timer の在る釜（解放 `now`）に置かれ、Complete を待つ（空き釜不足の待ちは残す）
5. THE 「今」置く品目への Startable_Slot の配分 SHALL 表示の先頭の順（`startAt` 昇順・同値は到着順 `compareArrival`）で行う——自前解の「今」配置は `startAt = now` で揃うので到着順になる。計画の群の順の同点（同時到着）の断ち方を `tableKey` から群の先頭品目の `compareArrival` へ改め、群の中では「今」置く品目に到着順で配る
6. THE 計画の群の順の変更 SHALL 同時到着の同点だけに効き、決定性（同じ入力から同じ計画）を保つ

### Requirement 2: 前回の釜の第一候補と Timer の在る釜

**User Story:** As a 設計者, I want 前回の釜を守る規則が押せない釜を守らない, so that 履歴が提案ゼロを固定しない。

#### Acceptance Criteria

1. WHEN 候補の開始時刻が `now` 以前で、前回の釜に Timer が在るとき、THE 前回の釜の第一候補 SHALL 効かず、Requirement 1 の規則で Startable_Slot を採る（釜の変更費用 L は払う）
2. WHEN 候補の開始時刻が `now` より後のとき、THE 前回の釜の第一候補 SHALL `plan-stability` AC 3.1 のまま（解放時刻が候補に間に合えば採る）
3. THE 前回に忠実な計画（`Continuity.faithful`）と候補を比べた計画 SHALL 同じ選択規則を通る（釜 L が両候補に等しく乗り、総費用の比較を歪めない）

### Requirement 3: 再計画と採用済み接頭辞

**User Story:** As a 現場, I want 釜を完了したら次に始められる品目がその釜に出る, so that 完了の順に依らず流れが途切れない。

#### Acceptance Criteria

1. WHEN Complete で釜の Timer が消え、「今」置く先頭群の品目が Timer の在る釜に置かれていたとき、THE 次の確定計画 SHALL その品目を Startable_Slot（空いた釜を含む）へ置き、snapshot の推奨がそれを運ぶ
4. WHEN 採用済み一片に `startAt ≤ now` かつ釜に Timer が在る配置が含まれるとき、THE 確定計画の合成 SHALL その一片を接頭辞から落とし（開始できない配置の失効）、尾部が Requirement 1〜2 の規則で置き直す。失効の述語は既存の「過去開始」と同じ場所に一つ置く
5. WHEN 過去に受領した将来計画の配置が時刻の到来で `startAt ≤ now` になり、その釜にまだ Timer が在るとき、THE 次の遷移の合成 SHALL 4 と同じ規則でその一片を落とす（遷移なしの時刻経過だけでは置き直さない・判断 9 (b)）
2. WHEN 上げ窓・釜の排他・slotSpan・合流の契約がその配置を許さないとき、THE 計画 SHALL 既存のとおり待つ（本 spec はハード制約を緩めない）
3. THE Acceptance_Gate SHALL 変えない（Timer の在る釜に「今」置く外部計画は feasible のまま）

### Requirement 4: 検証可能な性質

1. **開始できる先頭**：任意の遷移の直後（再計画の時点）で、**表示の先頭群の先頭品目**（`startAt` 昇順・同値は到着順で最初の品目）の slotSpan に足る Startable_Slot が在り、上げ窓・合流の契約がその品目を「今」置くことを許すなら、確定計画の推奨はその品目を Startable_Slot に `startAt ≤ now` で置き、表示（`liftGroups` → `slotSuggestions`）に先頭として現れる（採用済み接頭辞の有無に依らない・Requirement 3.4）
2. **提案ゼロにならない（再計画の時点・例外つき）**：遷移の直後に「Startable_Slot に置かれた `startAt ≤ now` の推奨が在るのに `slotSuggestions` が空」は起こらない。**例外**：表示の先頭群の先頭品目が合法に開始できない（slotSpan に足る Startable_Slot が無い・上げ窓・合流の契約）ときは、判断 4 の待ちとして連鎖が止まってよい（空き 1 釜・先頭 A が span 2・後続 B が span 1 の場面）。遷移なしの時刻経過だけで将来配置の `startAt` が来た場合は対象外（判断 9 (b)）。観測事実 8 の 24 品の対照を、完了順の昇順・降順の両方で二周目以降まで検査し、例外に当たらない空白が 0 箇所であること
3. **8 品の再現**：観測事実 8 の操作列で、72 秒の釜 1 の Complete の後、開始可能な提案が出る（A が釜 1 に「今」で先頭）
4. **場面の網羅**：同卓／別卓／卓なし、slotSpan 1／複数釜、Shown_Plan の有無、採用済み外部計画（接頭辞）の有無で 1〜2 が成り立つ
5. **不変**：上げ窓の上限・釜の排他・群のまとまり・合流の契約・解放表の値は変わらない（既存の性質がそのまま通る）
6. **将来配置は現在の占有を直接の条件にしない**：候補の開始が `now` より後の配置の釜の選択は Timer の有無に依らない——先行する「今」配置と解放表を固定すれば、本 spec の前後で同じ釜に置かれる。先行する「今」配置の釜が変わることによる波及（解放表の違い）は許す（判断 10）

### naming ゲート（`naming.md`）

| 候補名 | 場所 | 表明する概念境界 |
| --- | --- | --- |
| `Startable_Slot` / `startableSlots(timers)`（仮） | 要件語彙 / `src/domain/store.ts` か `src/domain/timer.ts` | Timer の無い釜（client の `occupiedSlots` の補集合。engine と client で共有） |
| `Now_Placement`（仮） | 要件語彙のみ | 候補の開始が `now` 以前の配置 |

### 未決（design で決める）

1. **占有の述語の置き場。** client の `occupiedSlots(view)` は `view.timers`（TimerFact）から、engine は `Timer` から引く。共通の形（`{ slotIds }[]` → 釜番号の集合）を domain に一つ置き、両方がそれを呼ぶか（`lift-group.ts` の Head と同じ規律）。推奨は共有。
2. **「候補の開始が now 以前」の判定点。** `assignSlots` は列の候補時刻（錨・合流先・firstFit で進めた時刻）を持つので、品目ごとに `候補 − 茹で時間 ≤ now` で判定できる。合流（`placeJoined`）と batch（`placeBatch`）の両経路で同じ判定を通す。
3. **ゲートで Timer の在る釜への「今」配置を落とすか。** 判断 5 は落とさない（feasibility は解放表の契約のまま）。合成の失効（判断 8・Requirement 3.4）が開始を妨げる接頭辞を落とすので、ゲートが通しても確定計画には残らない。ゲートでも落とすなら「受領した瞬間に落ちる」だけの違いで、feasibility の意味（物理的な配置の可否）を変える判断になる。推奨は落とさない。
4. **回帰の置き場。** 観測事実 8 の操作列（decide → snapshot → decideView → liftGroups → slotSuggestions）を横断テストとして `tests/client/*.crosslayer.example` に置くか、`tests/core/continuous-input.example` の隣に「連続処理（開始・発火・完了）」の harness を足すか。推奨は後者に harness を足し、24 品の完了順の性質もそこに置く。
