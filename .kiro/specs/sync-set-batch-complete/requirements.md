# Requirements Document

## Introduction

同時上がり（近接同時茹で上がり）としてサーバが同期させた複数の Timer は、共通の実効茹で上がり時刻（Sync_Target）へそろえられる。厨房スタッフはそれらを「一度の湯切り動作」で上げる。ところが現状の消し込み（complete）は Timer 1 件ずつにしか作用せず、同時に上がった複数の釜を上げても、スタッフは同じ数だけ Complete ボタンを押さねばならない。

本機能は、**boiled なスロットの Complete ボタンを一度押すと、その Timer と同時に茹で上がった Timer 群（Boiled_Group）をまとめて完了する**ことを定義する。ユーザーの言葉では「片方の complete ボタンを押したら、同時上がりのすべての Timer を complete にしたい」。

本機能は既存の近接同時茹で上がり調整（synchronized-boil-adjustment / Boil_Sync）に密接に依存するが、**同期アルゴリズム（synchronize）そのものは変更しない**。同期の結果として同一 Sync_Set のメンバーが共有する「実効 endTime の一致」を、消し込みの一括対象を識別する事実として利用するにとどめる。設計哲学（`design-philosophy.md`）と `timer-model.md` / `naming.md` / `tooling.md` に従い、engine / domain 契約の変更は最小に抑え、変更が要る場合はその必然性を design で justify する。

本ドキュメントは要件のみを定める（design / tasks は後続フェーズ）。当初「要確認事項」として保留していた 4 つの設計判断（グループ識別の根拠・原子性 vs ファンアウト・担当スコープ・UI フィードバック）はユーザー確認により確定済みであり、以下の受け入れ基準へ織り込んである。

## Glossary

- **Yudemen_Timer**: ゆで麺タイマー全体のシステム（サーバ権威の DO ＋ iPad クライアント）。SSOT は永続層（サーバ全量 snapshot）。
- **Timer**: 茹でタイマーという事実（`TimerFact`）。id / slotIds / noodleType / firmness / startTime / endTime を持つ。残り秒は状態に持たず endTime から導出する。
- **effective endTime（実効 endTime / Adjusted_Boil_Time）**: engine が同期のために `endTime + adjustment` を畳んで射影した、ワイヤ上の `endTime`。クライアントが受け取る `TimerFact.endTime` はこの実効値である。クライアントは `adjustment` の存在を知らない。
- **Sync_Set**: synchronized-boil-adjustment が同期させた「同時に上げる Timer の単位」。1 Sync_Set の最大本数は `arms`（既定 2）で頭打ちになる。同期確定した Sync_Set の全メンバーは実効 endTime が完全一致する。
- **Sync_Target**: 同期確定した Sync_Set が共有する共通の実効茹で上がり時刻。
- **arms**: 同時に上げられる腕の本数（1 Sync_Set の最大本数の上限・既定 2・サーバ設定）。
- **boiled**: 実効 endTime が補正後現在時刻に達した（`endTime ≤ correctedNow`）が、まだ明示完了されていない Timer。ユーザーが消し込むべき状態。本ドキュメントで単に boiled と書くときは、この**クライアント観測の boiled** を指す。
- **engine の発火記録（`boiledAt`）**: サーバ側 engine が Timer ごとに持つ発火の記録。Alarm 発火の遷移で `boiledAt` が立つ。クライアント観測の boiled とは**別の記録**であり、同一 Timer について一時的に食い違う（クライアントが boiled と見た時点で engine はまだ `boiledAt === null` である窓が存在する）。この食い違いを前提とする受入基準は要件6.7 / 6.9 / 6.10 に置く。
- **complete（消し込み）**: boiled な Timer をユーザーが明示的に完了し、Timer 集合から除去する操作。
- **Boiled_Group**: 本機能が導入する識別概念。ある boiled Timer と「同時に茹で上がった」boiled Timer の集合。実効 endTime が等しい boiled Timer 群として識別する（後述の要件1で確定）。
- **Provisional_Timer**: degraded 中にクライアントがローカルで生んだ未確定の Timer（`origin === "local"`）。サーバは id を知らない。
- **Timer_Connection**: クライアント側の接続コントローラ（`TimerConnection` / `openTimerConnection`）。UI の complete インテントを Mode と対象 origin で経路選択する唯一の窓口。
- **Slot_Display**: 担当スロットごとの表示状態を導出する純粋関数群（`slotDisplay.ts`）。boiled / running を endTime と now から切り分ける。
- **Slot_Card**: 担当スロット 1 つの表示・操作 UI（`SlotCard.tsx`）。boiled のとき Complete ボタンを描画する。
- **Slot_Board**: 担当ボード全体の表示 UI（`SlotBoard.tsx`）。`view.error` が在るとき `role="alert"` の警告帯へ `message` をそのまま提示する（実装で確認）。
- **`TimerNotFound`**: サーバの拒否 code の一つ（`src/engine/rejection.ts`）。「対象 timerId の Timer が存在しない」ことを表す。complete / cancel / adjust のいずれの操作からも返り得る。拒否は状態を変えず、要求元の接続へ `{ type: "error", code, message }` として返る（実装で確認）。
- **sync（同期状態）**: クライアントがサーバ全量 snapshot を受け取って同期を確立したかを表すビューの区分（`connecting` / `synced` / `syncFailed`）。永続ビューの再水和直後は `connecting` である（`EMPTY_VIEW.sync` が `"connecting"` であり、`openTimerConnection` は接続前に `persistence.load()` で再水和する。実装で確認）。
- **Mode**: Connectivity から導出する経路。`up → live`（サーバ送信）/ `down → degraded`（ローカル権限）。状態として保持しない。
- **live / degraded**: それぞれ Mode の値。
- **assigned units（担当ユニット）**: クライアントが表示・操作する担当範囲。unit u は slot 6u..6u+5（`assignment.ts`）。保持は全量・表示は担当スコープの導出。

## Requirements

### Requirement 1: 同時上がりグループ（Boiled_Group）の識別

**User Story:** As a 厨房スタッフ, I want 同時に茹で上がった釜が 1 つのまとまりとして扱われる, so that それらを一度の動作でまとめて消し込める。

同期確定した Sync_Set のメンバーは実効 endTime が完全一致する（synchronized-boil-adjustment の Property 5）。クライアントは Sync_Set の membership を知らないが、実効 endTime を `TimerFact.endTime` として受け取る。ゆえに「同時上がり」を実効 endTime の一致で識別すれば、engine 契約を変えずにグループを再構成できる。**（確定 / Q1）** Boiled_Group は実効 endTime（`TimerFact.endTime`）の一致で識別する。engine / domain 契約は変更せず、Sync_Set membership の追跡・配信は行わない。

#### Acceptance Criteria

1. WHEN ユーザーが boiled な Timer T の消し込みを指示したとき、THE Timer_Connection SHALL 保持ビュー内の Timer のうち、boiled であり、かつ実効 endTime が T の実効 endTime と等しいものの集合を Boiled_Group として識別する。
2. IF 指示対象の Timer T が boiled でない（running である）ならば、THEN THE Timer_Connection SHALL Boiled_Group を形成せず、一括完了を行わない。
3. THE Timer_Connection SHALL Boiled_Group の識別に、クライアントが保持する `TimerFact.endTime`（実効 endTime）の一致のみを用いる。
4. THE Boiled_Group SHALL 指示対象の Timer T 自身を必ず含む。
5. WHEN ユーザーが boiled な Timer T の消し込みを指示し、かつ T と実効 endTime が等しい boiled な Timer が T 以外に存在しないとき、THE Boiled_Group SHALL T ただ 1 件のみで構成される。
6. WHILE ある Timer が running（実効 endTime が補正後現在時刻より未来）である間、THE Timer_Connection SHALL 当該 Timer を Boiled_Group から除外する。

### Requirement 2: 片方の消し込みでグループを一括完了する（live）

**User Story:** As a 厨房スタッフ, I want boiled なスロットの Complete を一度押すだけで同時上がりを全部消し込める, so that 上がった釜の数だけボタンを押さずに済む。

#### Acceptance Criteria

1. WHEN live Mode でユーザーが boiled な Timer T の Complete を押したとき、THE Yudemen_Timer SHALL Boiled_Group のすべてのメンバーを完了し、Timer 集合から除去する。
2. WHEN Boiled_Group が 1 件のみで構成されるとき、THE Yudemen_Timer SHALL 従来の単一消し込みと同一の結果（当該 1 件のみ除去）を生成する。
3. WHERE Boiled_Group のメンバーが server-confirmed（`origin === "server"`）であるとき、THE Timer_Connection SHALL 当該メンバーの完了をサーバ権威経路（WS 送信）で処理する。
4. WHERE Boiled_Group のメンバーが Provisional_Timer（`origin === "local"`）であるとき、THE Timer_Connection SHALL 当該メンバーの完了をローカル畳み込みで処理し、サーバへ送信しない。
5. WHILE ビューの sync が `synced` である間、WHEN あるメンバーの完了が保持ビューへ反映され、かつ当該メンバーの駆動スロットを駆動する Timer が保持ビューに残っていないとき、THE Slot_Display SHALL 当該スロットを idle として導出する。
6. WHERE あるメンバーの完了が保持ビューへ反映された後も、当該メンバーの駆動スロットを駆動する別の Timer が保持ビューに残るとき、THE Slot_Display SHALL 当該スロットを、残る Timer から running または boiled として導出する（走行中を優先し、同区分が複数あれば最早の実効 endTime を採る）。
7. WHILE ビューの sync が `synced` 以外（`connecting` または `syncFailed`）である間、WHEN あるメンバーの完了が保持ビューへ反映され、かつ当該メンバーの駆動スロットを駆動する Timer が保持ビューに残っていないとき、THE Slot_Display SHALL 当該スロットを unreceived として導出する。

> 注（idle は同期済みを要する）: 要件2.5 と 2.7 は同じ盤面（駆動 Timer が残らないスロット）を sync で分けている。`assignedSlotDisplays` は Timer が無いスロットについて `sync === "synced"` のときだけ `idle` を返し、それ以外は `unreceived` を返す（実装で確認）。この分岐は到達可能である——永続ビューの再水和直後は `sync` が `connecting` であり、hydration 前に degraded でローカル完了すれば、駆動 Timer が残らないスロットは `unreceived` として導出される。要件2.7 はこの帰結を受入基準として記録するもので、既存の `slotDisplay.ts` の挙動を変更しない。

### Requirement 3: 一括完了の対象は boiled のメンバーに限る

**User Story:** As a 厨房スタッフ, I want まだ茹で上がっていない釜を巻き込まずに消し込みたい, so that 走行中のタイマーを誤って止めない。

#### Acceptance Criteria

1. WHEN ユーザーが boiled な Timer の一括完了を指示したとき、THE Yudemen_Timer SHALL boiled なメンバーのみを完了する。
2. WHILE ある Timer が running である間、THE Yudemen_Timer SHALL 当該 Timer を一括完了の対象にしない。
3. IF 指示対象の Timer が boiled でない（running である）ならば、THEN THE Slot_Card SHALL 当該スロットに Complete ボタンを描画しない。

### Requirement 4: 担当スコープと一括完了の範囲

**User Story:** As a 厨房スタッフ, I want 自分の担当ボードで見えている釜を消し込みたい, so that 他の担当者が管理する釜を意図せず操作しない。

Boiled_Group は同一 Sync_Set 由来であり、Sync_Set が担当ユニット境界（unit = 6 slots）をまたいで形成される可能性がある。**（確定 / Q3）** 同時に茹で上がった以上、一括完了は押下者の担当ユニットに限定せず、Boiled_Group の全メンバー（担当ユニット外のスロットを駆動するものを含む）を対象に消し込む。ただし Complete の操作口（起点）自体は、従来どおり担当スロットに描画される boiled スロットのみである。

#### Acceptance Criteria

1. WHEN ユーザーが boiled な Timer の一括完了を指示したとき、THE Timer_Connection SHALL Boiled_Group の全メンバーを一括完了の対象とし、押下者の担当ユニット外のスロットを駆動するメンバーも含めて消し込む。
2. WHERE Boiled_Group のメンバーが押下者の担当ユニットのいずれのスロットも駆動しないとき、THE Timer_Connection SHALL 当該メンバーを一括完了の対象から除外せず、Boiled_Group の一員として完了する。
3. THE Slot_Card SHALL Complete の操作口を担当スロットに対してのみ描画する（一括完了の起点は担当ユニット内の boiled スロットに限られる）。

### Requirement 5: degraded（オフライン）時の一括完了

**User Story:** As a 厨房スタッフ, I want 回線が切れていても同時上がりをまとめて消し込みたい, so that オフラインでも現場の速度が落ちない。

#### Acceptance Criteria

1. WHILE degraded Mode である間、WHEN ユーザーが boiled な Timer の一括完了を指示したとき、THE Timer_Connection SHALL Boiled_Group の各メンバーをローカル完了（LocalComplete 相当）で除去する。
2. WHILE degraded Mode である間、THE Timer_Connection SHALL 一括完了に伴う WebSocket 送信を行わない。
3. WHEN degraded 中に一括完了したメンバーが Provisional_Timer であるとき、THE Timer_Connection SHALL 当該メンバーを保持ビューから除去する。
4. WHEN degraded 中に一括完了したメンバーが server-confirmed であるとき、THE Timer_Connection SHALL 当該メンバーを保持ビューから除去し、ローカル再発火を抑止するため処理済みとして記録する。
5. WHEN 回線が復帰し全量 snapshot を Reconcile として畳み込むとき、THE Timer_Connection SHALL server-confirmed のみをサーバ真実へ収束させ、Provisional_Timer は保持する（既存の Reconcile 規律を維持する）。

### Requirement 6: サーバ権威と一括完了の一貫性

**User Story:** As a 運用者, I want 一括完了がサーバの正本と矛盾なく反映される, so that 全端末が同一の状態へ収束する。

snapshot-broadcast の SSOT 規律では、確定した状態変化ごとにサーバは全量 snapshot を送る。**（確定 / Q2 = ファンアウト）** 一括完了は、クライアントが Boiled_Group の各メンバーに対して既存の complete 経路を複数回発行して実現する。新しい `ClientMessage` / `ServerMessage` 種別・engine 公開関数・Effect 種別は追加しない（サーバ契約変更ゼロ）。結果としてサーバは各確定変化ごとに全量 snapshot を送るため複数の snapshot が生じ、原子的・単一 snapshot は要求しない。全端末はサーバの各 snapshot で最終的に収束する（SSOT・結果整合）。

実装上、現行のクライアント complete は server-confirmed に対して WebSocket へ fire-and-forget で送信し（Promise を返さない）、ファンアウトは各メンバーへ complete を発行するループ／一斉送信として表現する。送信は投げっぱなし（best-effort）のままとし、`Promise.all` 的な完了待機を要する設計にはしない。

**一括を確定させる事象は存在しない。** サーバは complete を 1 件ずつ受け、1 件ごとに状態遷移と Effect 列を組む。ゆえに確定の単位は**メンバーごとの put 成功**であって、「一括完了の確定」という事象も状態も存在しない。以下の受入基準はすべてメンバー単位でトリガーを立てる。

#### Acceptance Criteria

1. WHEN live Mode で Boiled_Group のある server-confirmed メンバーの complete がサーバで確定したとき、THE Yudemen_Timer SHALL 当該メンバーが除去された状態を、サーバ権威の全量 snapshot として全端末へ反映する。
2. WHEN サーバがあるメンバーの complete を処理するとき、THE Yudemen_Timer SHALL 当該メンバーの確定の起点を、当該遷移における永続層への put 成功ただ一点に置く（SSOT 規律を維持する）。
3. WHEN live Mode で一括完了を発行するとき、THE Timer_Connection SHALL Boiled_Group の各 server-confirmed メンバーに対して既存の complete 経路を fire-and-forget で発行し、送信完了の待機を行わない。
4. WHEN 各メンバーの complete がサーバで確定するとき、THE Yudemen_Timer SHALL メンバーごとの確定変化に対して全量 snapshot を送り、原子的な単一 snapshot を保証しない。
5. IF あるメンバーの complete で永続層への put が失敗するならば、THEN THE Yudemen_Timer SHALL 当該メンバーの除去を確定させず、当該メンバーを永続層の正本に残し、当該遷移に対する全量 snapshot を送らない。
6. IF 収束機構そのもの（全量 snapshot の配信・受信）が失敗するならば、THEN THE Yudemen_Timer SHALL クライアントが正本と一時的に不整合な状態にとどまることを許容し、次回の同期契機（再接続・再同期）で収束させる。
7. WHEN Boiled_Group の完了が、engine で発火済み（`boiledAt !== null`）のメンバーのみを除去するとき、THE Yudemen_Timer SHALL 残余 running 集合の同期結果（各メンバーの adjustment）を変化させない。
8. WHEN 要件6.5 により正本に残ったメンバーが在る状態で次の snapshot 契機（他の確定変化に伴う全量 snapshot の配信、または再接続時の全量 hydration）が生じたとき、THE Yudemen_Timer SHALL 当該メンバーを含む全量 snapshot を送り、クライアントを実際の正本状態へ収束させる。
9. IF あるメンバーが、クライアント観測では boiled でありながら engine では未発火（`boiledAt === null`）である窓で、当該メンバーの complete が確定するならば、THEN THE Yudemen_Timer SHALL 当該メンバーを除いた残余 running を再同期し、残余 running の adjustment が変化することを許容する。
10. THE Yudemen_Timer SHALL 要件6.9 の再同期を、Boiled_Group の件数に依らず単一の complete と同一の規律で扱う（当該窓での再同期は単一消し込みが既に持つ性質であり、一括完了が新たに導入する挙動ではない）。
11. WHILE live Mode である間、WHEN Boiled_Group の server-confirmed メンバーへ complete を発行したとき、THE Timer_Connection SHALL 当該メンバーの除去を局所ビューへ反映せず、除去の反映をサーバの全量 snapshot の到着に委ねる。
12. WHILE 要件6.11 で発行した complete の除去を運ぶ snapshot が未到着である間、THE Slot_Card SHALL 当該メンバーの駆動スロットを boiled として表示し、Complete ボタンを描画し続ける（ゆえに同一メンバーへ再度 complete が発行され得る）。
13. IF サーバが、既に除去済みの Timer を対象とする complete を受けるならば、THEN THE Yudemen_Timer SHALL 状態を変えず、code が `TimerNotFound` の error を要求元の接続へ返す（既存 engine / shell の挙動を変更しない）。
14. WHEN クライアントが code が `TimerNotFound` の error を受けたとき、THE Timer_Connection SHALL `view.error` を更新せず、当該 error を Slot_Board の提示対象から外す（offset の最新化のみを行う）。
15. WHEN クライアントが code が `TimerNotFound` 以外（`InvalidSlotOrNoodle` / `CapacityExceeded` / `InvalidBoilSeconds` / `UnknownNoodle` 等）の error を受けたとき、THE Timer_Connection SHALL 従来どおり `view.error` を当該 code と message で更新し、THE Slot_Board SHALL 当該 message を提示する。
16. WHERE 複数の端末が同一の Sync_Set のメンバーを対象に complete を発行するとき、THE Yudemen_Timer SHALL 各端末を要件6.13 / 6.14 と同一の規律で扱う（後に届いた complete は `TimerNotFound` となり、その端末で提示されない）。
17. THE Timer_Connection SHALL 要件6.14 の非提示を error の code のみで判断し、complete / cancel / adjust のいずれに由来するかで区別しない。

> 注（なぜ `TimerNotFound` だけを落とすのか）: 要件6.11 / 6.12 は既存設計の帰結である——live 経路は局所ビューを動かさないため、Complete の操作口は snapshot 到着まで残る。ゆえに同一メンバーへの二度目の complete は起こり得る。到達経路は 2 つある。同一端末で群の別スロットを続けて押す場合と、同じ Sync_Set を見る二台目の端末が押す場合（要件4.1 が担当スコープをまたぐファンアウトを定めた帰結）である。<br>要件6.14 が `TimerNotFound` を提示対象から外すのは、この拒否が「対象が既に無い」という報告であり、**利用者の意図（この Timer を消す）は達成されている**からである。達成された意図を警告帯で報せる理由が無い。要件6.15 は、この判断が error 提示そのものを止めるものではないことを明示する——他の拒否種別は従来どおり提示する。<br>要件6.17 の帰結として、cancel 由来の `TimerNotFound` も提示されなくなる。cancel も「この Timer を消す」意図ゆえ同じ論理が通り、規律の一貫性として受け入れる。**adjust 由来の `TimerNotFound` は理屈の外に残る**——adjust は「調整したかった Timer が無い」ので意図が未達であり、提示に値する。これは `TimerNotFound` という単一の code に二つの意味（意図達成 / 意図未達）が同居しているためである。code の分離は本 spec のスコープ外とし、ここに正直に記録する。

> 注（二つの boiled 記録）: 要件6.7 が保証を限定しているのは、クライアント観測の boiled（実効 endTime ≤ 補正後現在時刻）と engine の発火記録（`boiledAt !== null`）が**別の記録**だからである。engine は Alarm 発火で `boiledAt` を立てるため、クライアントが boiled と見た直後に engine ではまだ `boiledAt === null` である窓が存在する。その窓で complete が確定するとき何が起きるかは要件6.9 が定め、それが本機能に固有でないことは要件6.10 が記録する。要件6.7 は無条件の主張ではなく、engine で発火済みのメンバーを除去する場合に限った主張である。

### Requirement 7: 消し込み UI のアフォーダンス

**User Story:** As a 厨房スタッフ, I want 今までどおり Complete を押すだけで同時上がりがまとめて消える, so that 新しい操作を覚えずに済む。

#### Acceptance Criteria

1. WHILE スロットが boiled である間、THE Slot_Card SHALL 当該スロットに従来と同一の Complete ボタンを 1 つ描画する。
2. WHEN ユーザーが boiled スロットの Complete ボタンを押したとき、THE Slot_Card SHALL 当該スロットの Timer を対象として一括完了を Timer_Connection へ通知する。
3. THE Slot_Card SHALL 一括完了のために新たな操作要素（別ボタン・確認ダイアログ等）を追加しない。

> 注: **（確定 / Q4）** 既存の単一 Complete ボタンが暗黙にグループを一括する。一括であることを示す新しい操作要素・確認ダイアログ・特別な視覚フィードバックは追加しない。

### Requirement 8: 直前結果（残滓）の記録

**User Story:** As a 厨房スタッフ, I want 消し込んだ釜に直前の麺種が一定時間表示される, so that 何を茹でていたか確認できる。

直前結果はスロットごとに 1 件しか保持されない（クライアントの `lastResults` はスロットをキーとする写像である）。一方 engine は「1 スロットを駆動する Timer は同時に 1 本まで」という排他を**課していない**（`validateStart` は非空・茹で時間範囲・容量のみを検査し、既存 Timer との `slotIds` 重複を拒否しない。実装で確認）。ゆえに同一スロットを複数メンバーが駆動する退化入力は起こり得るため、そのときどの麺種を採るかを競合規則として定める（要件8.4）。

競合規則は**反映順**で決める。反映順＝完了が保持ビュー（`view.timers` と `lastResults`）へ届く順のこと。反映順は経路で決まり、経路は 2 つある（実装で確認）。

- **degraded / provisional 経路** — `decideLocalComplete` がメンバーごとに `recordLastResults` を呼ぶ。反映順は畳み込み順（`view.timers` の並び）であり、クライアント内で決まる。
- **live の server-confirmed 経路** — サーバの全量 snapshot が届いたときに `reconcileServerConfirmed` が「消えた Timer」の残滓を導く。反映順は二段である。**snapshot 間は到着順**であり、クライアントは決められない。**同一 snapshot 内は直前の保持列順**——`reconcileServerConfirmed` は直前の保持 Timer 列から `origin === "server"` を抽出した列（`prevServer`）を走査し、新 snapshot の id 集合に無いものを消失として扱う（実装で確認）。1 つの snapshot で複数メンバーの消失が同時に判明する経路は到達可能である。中間 snapshot の配信・受信の失敗は要件6.6 が許容しており、そのとき次の全量 snapshot が複数の消失をまとめて運ぶ。

同一スロットを駆動するメンバーが両経路に分かれるとき、どちらの完了が後に届くかを設計は決められない。ゆえに要件8.5 / 8.6 は経路内の決定性のみを要求し、経路をまたぐ反映順は到着順に委ねる。これが許容できるのは残滓の位置づけによる（要件8.9）——残滓は client 専用のベストエフォートな表示制御用ローカル情報であって、SSOT ではない。

占有スロット（別の Timer が駆動中のスロット）の扱いも経路で異なり、その非対称は既存実装の規律である（要件8.7 / 8.8）。本機能は `recordLastResults` にも `reconcileServerConfirmed` にも触れないため、この非対称を導入も解消もしない。

**残滓は「記録の有無」と「記録する値」の二つの関心事に分かれる。** 記録の有無は要件8.7 / 8.8 が経路ごとに決める（live 経路は占有スロットへ記録せず既存の残滓を消去し、degraded / provisional 経路は占有を見ずに記録する）。記録される場合にどの麺種を採るかは要件8.4 が決める。要件8.4 は値の選択規則であって、記録するか否かを決めない——ゆえに live 経路で記録が見送られるスロットについて、要件8.4 は何も主張しない。両者を混ぜて読めば「記録するな」と「この値を採用せよ」が衝突して見えるが、階層が異なるため衝突は生じない。

#### Acceptance Criteria

1. WHEN Boiled_Group のメンバーが完了により除去されるとき、THE Yudemen_Timer SHALL 除去された各メンバーの麺種（noodleType）を、その駆動スロットの直前結果（残滓）として記録する（同一スロットを複数メンバーが駆動するときは要件8.4 の競合規則、占有スロットの扱いは要件8.7 / 8.8 に従う）。
2. THE Yudemen_Timer SHALL 一括完了で除去された各メンバーの残滓記録を、単一消し込みと同一の規律（除去理由を問わない一様な残滓）で扱う。
3. WHEN 完了したスロットが再度 idle として表示されるとき、THE Slot_Display SHALL 記録された直前結果を既存の提示時間窓に従って提示する。
4. WHERE Boiled_Group の複数のメンバーが同一スロットを駆動し、WHEN 要件8.7 / 8.8 に従って当該スロットへ残滓が記録されるとき、THE Yudemen_Timer SHALL 記録する麺種として、完了が保持ビューへ最後に反映されたメンバーの麺種を採用する（要件8.4 は記録する値のみを定め、記録の有無は要件8.7 / 8.8 が定める）。
5. THE Yudemen_Timer SHALL 完了が保持ビューへ反映される順を経路ごとに定める——degraded 経路および Provisional_Timer のローカル畳み込みでは Boiled_Group の畳み込み順（クライアントが保持する Timer 列の並び）、live の server-confirmed 経路では snapshot 間はサーバ全量 snapshot の到着順、同一 snapshot 内は直前の保持列順（直前の保持 Timer 列から server-confirmed を抽出した並び）である。
6. WHERE Boiled_Group の同一スロットを駆動するメンバーが、degraded / provisional 経路と live の server-confirmed 経路の双方に分かれるとき、THE Yudemen_Timer SHALL 各経路内の反映順のみを要件8.5 に従って決定的に保ち、経路をまたぐ反映順は各経路の到着順に委ねる。
7. WHERE live の server-confirmed 経路であるメンバーが除去され、かつ当該メンバーの駆動スロットを別の Timer（新しい server-confirmed または保持された Provisional_Timer）が占有するとき、THE Yudemen_Timer SHALL 当該スロットの残滓記録を見送り、当該スロットに残る既存の残滓を消去する。
8. WHERE degraded / provisional 経路であるメンバーが除去され、かつ当該メンバーの駆動スロットを別の Timer が占有するとき、THE Yudemen_Timer SHALL 占有の有無に依らず当該スロットへ当該メンバーの麺種を残滓として記録する。
9. THE Yudemen_Timer SHALL 直前結果（残滓）を、client 専用のベストエフォートな表示制御用ローカル情報として扱う（永続層の正本ではなく、リロードで失われてよい）。この位置づけの下で、要件8.5 / 8.6 が定める経路ごとの決定性をもって足りるものとする。

> 注（経路の非対称は既存規律である）: 要件8.7 / 8.8 が記述する占有スロットの扱いの差は、`reconcileServerConfirmed`（占有スロットへ記録せず既存の残滓を消去する）と `recordLastResults`（占有を見ずに記録する）の既存実装の差である（実装で確認）。本 spec は両者に触れず、既存の単一 complete / cancel の挙動を変えない。ゆえにこの非対称は本機能が導入したものではなく、一括完了によって**メンバー数だけ同じことが起きる**にとどまる。差を揃える改修は本 spec のスコープ外である。

### Requirement 9: スコープ境界（同期アルゴリズム不変）

**User Story:** As a 保守者, I want 本機能が同期計算を変えないことを保証したい, so that Boil_Sync の正しさを退行させない。

#### Acceptance Criteria

1. THE Yudemen_Timer SHALL synchronize（Proximity_Cluster 形成・Sync_Set 分割・Sync_Target の maximin 配置・Adjustment 割り当て）のアルゴリズムを変更しない。
2. THE Yudemen_Timer SHALL Sync_Set の membership 決定規律（オリジナル endTime 昇順チャンク）を変更しない。
3. THE Yudemen_Timer SHALL 発火（boiled 遷移）の判定基準（実効 endTime ≤ now + ε）を変更しない。
4. THE Boiled_Group SHALL 消し込みの一括対象を識別するためだけに用いられ、同期の membership とは独立の導出概念とする。

### Requirement 10: 契約変更の最小化と公開シンボルの確認

**User Story:** As a 保守者, I want engine / domain 契約の変更を最小に保ちたい, so that レゴ式再構成性と共有契約の中立性を守れる。

#### Acceptance Criteria

1. THE Yudemen_Timer SHALL 本機能のために `TimerFact`（domain/timer.ts の 6 フィールド）を変更しない。
2. WHERE 本機能が新しい `ClientMessage` / `ServerMessage` の種別、新しい engine の公開関数・Effect 種別、または新しいクライアント `ClientEvent` 種別の追加を要するならば、THE Yudemen_Timer SHALL それらの候補名と概念境界を、フェーズを問わず判明した時点でただちにユーザー確認へ付す（naming.md の公開シンボル確認ゲート）。
3. THE Yudemen_Timer SHALL 一括完了を既存の `complete` メッセージのファンアウトのみで実現し、新しいメッセージ種別・engine 公開関数・Effect 種別を追加しない（YAGNI・Q2 = ファンアウトの帰結）。
