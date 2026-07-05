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
- **boiled**: 実効 endTime が補正後現在時刻に達した（`endTime ≤ correctedNow`）が、まだ明示完了されていない Timer。ユーザーが消し込むべき状態。
- **complete（消し込み）**: boiled な Timer をユーザーが明示的に完了し、Timer 集合から除去する操作。
- **Boiled_Group**: 本機能が導入する識別概念。ある boiled Timer と「同時に茹で上がった」boiled Timer の集合。実効 endTime が等しい boiled Timer 群として識別する（後述の要件1で確定）。
- **Provisional_Timer**: degraded 中にクライアントがローカルで生んだ未確定の Timer（`origin === "local"`）。サーバは id を知らない。
- **Timer_Connection**: クライアント側の接続コントローラ（`TimerConnection` / `openTimerConnection`）。UI の complete インテントを Mode と対象 origin で経路選択する唯一の窓口。
- **Slot_Display**: 担当スロットごとの表示状態を導出する純粋関数群（`slotDisplay.ts`）。boiled / running を endTime と now から切り分ける。
- **Slot_Card**: 担当スロット 1 つの表示・操作 UI（`SlotCard.tsx`）。boiled のとき Complete ボタンを描画する。
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
5. WHEN 一括完了が確定したとき、THE Slot_Display SHALL 完了した各メンバーの駆動スロットを idle として導出する。

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

#### Acceptance Criteria

1. WHEN live Mode で Boiled_Group の一括完了が確定したとき、THE Yudemen_Timer SHALL Boiled_Group の全 server-confirmed メンバーが除去された状態を、サーバ権威の全量 snapshot として全端末へ反映する。
2. WHEN 一括完了がサーバで確定したとき、THE Yudemen_Timer SHALL 確定の起点を永続層への put 成功に置く（SSOT 規律を維持する）。
3. WHEN live Mode で一括完了を発行するとき、THE Timer_Connection SHALL Boiled_Group の各 server-confirmed メンバーに対して既存の complete 経路を fire-and-forget で発行し、送信完了の待機を行わない。
4. WHEN 各メンバーの complete がサーバで確定するとき、THE Yudemen_Timer SHALL メンバーごとの確定変化に対して全量 snapshot を送り、原子的な単一 snapshot を保証しない。
5. IF 一括完了の処理中に一部メンバーの除去が失敗するならば、THEN THE Yudemen_Timer SHALL 未除去のメンバーをサーバ権威の snapshot に残し、クライアントを実際の正本状態へ収束させる。
6. IF 収束機構そのもの（全量 snapshot の配信・受信）が失敗するならば、THEN THE Yudemen_Timer SHALL クライアントが正本と一時的に不整合な状態にとどまることを許容し、次回の同期契機（再接続・再同期）で収束させる。
7. WHEN Boiled_Group の完了が boiled なメンバーのみを除去するとき、THE Yudemen_Timer SHALL 残余 running 集合の同期結果（各 adjustment）を変化させない（boiled の除去は running 集合を変えないため）。

### Requirement 7: 消し込み UI のアフォーダンス

**User Story:** As a 厨房スタッフ, I want 今までどおり Complete を押すだけで同時上がりがまとめて消える, so that 新しい操作を覚えずに済む。

#### Acceptance Criteria

1. WHILE スロットが boiled である間、THE Slot_Card SHALL 当該スロットに従来と同一の Complete ボタンを 1 つ描画する。
2. WHEN ユーザーが boiled スロットの Complete ボタンを押したとき、THE Slot_Card SHALL 当該スロットの Timer を対象として一括完了を Timer_Connection へ通知する。
3. THE Slot_Card SHALL 一括完了のために新たな操作要素（別ボタン・確認ダイアログ等）を追加しない。

> 注: **（確定 / Q4）** 既存の単一 Complete ボタンが暗黙にグループを一括する。一括であることを示す新しい操作要素・確認ダイアログ・特別な視覚フィードバックは追加しない。

### Requirement 8: 直前結果（残滓）の記録

**User Story:** As a 厨房スタッフ, I want 消し込んだ釜に直前の麺種が一定時間表示される, so that 何を茹でていたか確認できる。

#### Acceptance Criteria

1. WHEN Boiled_Group のメンバーが完了により除去されるとき、THE Yudemen_Timer SHALL 除去された各メンバーの麺種（noodleType）を、その駆動スロットの直前結果（残滓）として記録する。
2. THE Yudemen_Timer SHALL 一括完了で除去された各メンバーの残滓記録を、単一消し込みと同一の規律（除去理由を問わない一様な残滓）で扱う。
3. WHEN 完了したスロットが再度 idle として表示されるとき、THE Slot_Display SHALL 記録された直前結果を既存の提示時間窓に従って提示する。

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
