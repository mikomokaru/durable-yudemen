# Requirements Document

## Introduction

随時到着するオーダーの調理順を決め、全オーダーの待ち時間の合計を最小にする機能である。オーダーは POS 連携（外部システム）から随時届く（オンライン到着）。決定変数は調理順・釜（slot）割当・開始時刻の 3 つである。

本機能は実装済みの Boil_Sync（`synchronized-boil-adjustment`）とは階層が異なる。Boil_Sync は**既に始まった** Timer の `endTime` を 1 次元の許容窓内でそろえる調整であり、DO 内で多項式時間の厳密解が解ける。本機能は**まだ始まっていない**オーダーの順序・slot 割当・開始時刻を決める組合せ最適化であり、NP-hard 側の問題ゆえ DO 内で厳密解を同期的に解くことはできない。両者は**共存**する（階層分担）。本機能は開始前までを担い、開始後の近接茹で上がり調整は引き続き Boil_Sync が担う。

厳密解が解けない問題への骨格は「**外部で解いた計画を注入し、DO はゲートで受け入れ判定する**」である。

- DO は常に自前の高速ヒューリスティック解（Baseline_Plan）を `decide` 内で同期的に持つ。これは外部が落ちたときのフォールバックであり、feasibility 検証の構造の供給源である。外部提案の改善判定は、Baseline_Plan と採用済み外部計画の合成である現在の確定計画（Committed_Plan）を基準に行う（基準を Baseline_Plan にすると、採用済みのより良い計画を後着の劣る計画が上書きしうるため。確定計画の単調な改善を保証する）。
- 外部ソルバー（External_Solver）への計画要求は、`decide` が Effect（`RequestPlan`）として**記述するだけ**で実行しない。shell が Service binding で投げ、受理応答（202）のみを await し、計算完了を待たない。
- 外部から届いた計画（Cook_Plan）は、受け入れゲート（Acceptance_Gate）が陳腐化・feasibility・改善の判定を一体で行い、独立単位（Plan_Unit）ごとに採用または棄却する。

機械は開始を**指示しない**。推奨（Cook_Recommendation）を提示し、人が最終決定する。人はいつでも推奨と異なるオーダーを開始でき、その事実が次の再計算の入力になる。

未着手オーダー（Pending_Order）の正本は DO の永続層である。採用された計画の有効期間は次の状態変化までであり、時間経過のみによる失効概念は導入しない。

過去の操作実測（`operation-history-log` が収集する telemetry）を External_Solver 側のパラメータ推定に用いる可能性はあるが、その利用は External_Solver の内部関心事であり本書のスコープ外である。

### 設計上の重要な制約（ユーザー確定済み・steering 整合）

- **`decide` は純粋を保つ。** 本機能の計算（Baseline_Plan の算出・Acceptance_Gate の判定）は engine の純粋変換 `(状態, イベント) → (新状態, Effect 列)` の内部で行う。最適化計算をネットワーク越しに `decide` の内部で行わない。`storage.put`・broadcast・外部要求の実行は shell が Effect として担う。
- **Effect 列の不変条件は変えない。** Effect 列は常に `Persist` を先頭に持つ（確定の起点は `storage.put` 成功のみ）。`RequestPlan` は Effect 語彙への追加であり、この順序規律の後段に乗る。
- **新しいタイミング概念を導入しない。** 計画要求の契機は状態変化（オーダー到着・キャンセル・開始・完了・計画受領など）を処理する既存の離散イベントのみ。ポーリング・`setInterval`・`waitUntil`・DO 内の外部 await を用いない。「待つなら寝かせる、抱えると漏れる」。
- **外部ソルバーは Service binding で呼ぶ専用 Worker（Solver_Worker）とする。** DO（shell）は受理応答（HTTP 202 相当・数 ms）のみを await し、計算は Solver_Worker 側の `ctx.waitUntil` が抱える。復路は DO への RPC で、これは正当な wake であって pin ではない。Queues / Workflows は採らない——耐久性・リトライ・バッチング・順序保証がいずれも不要か有害である（要求が失われても害がなく、古い結果は陳腐化ゲートで落ちる性質のため）。Containers・Python は本番経路に持ち込まない（Python は参照オラクル専用）。ソルバーの定式化・アルゴリズム選定の詳細は本書のスコープ外とし、本書は「DO 側が何を要求し、何を検証し、何を保証するか」と実行形態の制約（Requirement 12）に集中する。
- **Pending_Order は Timer と別概念である。** 共有契約 `TimerFact`（`src/domain/timer.ts`）に混ぜない（god type 化の禁止・`timer-model.md`）。client が推奨表示のために見る必要がある事実は、`TimerFact` とは別の共有概念として立てる。ワイヤ表現の具体は design フェーズで `timer-model.md` の判定（両者で共有される事実か）を通して確定する。
- **Boil_Sync の機構を変更しない。** `src/engine/sync.ts`・`settle.ts`・arms・Tolerance_Ratio・その Property 群は本機能の導入で変えない。本機能が変えるのは Running_Timer 集合の「入口」（何をいつ開始するかの推奨）だけであり、開始後の集合に対する Boil_Sync の作用は従来どおりである。

> **概念名について:** 本書に現れる `Cook_Scheduling`・`Pending_Order`・`Order_Ingress`・`Cook_Plan`・`Baseline_Plan`・`Committed_Plan`・`External_Solver`・`Solver_Worker`・`Acceptance_Gate`・`Plan_Unit`・`Input_Fingerprint`・`Cook_Recommendation`・`Table_Group`・`Slot_Affinity` 等は、要件記述のために導入した**仮の概念名**である。公開シンボル（型・公開関数・Effect 種別・状態フィールド・メッセージ種別）の確定名は、命名規律（`naming.md`）に従いユーザー確認を経て決め、design.md の命名節に記録する（`RequestPlan`・`PlanSlice`・`StoreSnapshot`・`CookSchedule` 等は確定済み）。本書の仮名は要件語彙としてそのまま残す（仮名と確定名の対応は design.md の命名節が正本）。

> **ソフト制約の列挙について:** 本書のソフト制約（同卓近接提供・同一オーダー同時提供・Slot_Affinity）はユーザーが「例えば」として挙げたものであり、**完全な列挙ではない**。追加のソフト制約が確定した場合は本書の Requirement 3 への追補として扱う。ソフト制約間および主目的との重み・優先順位の具体は確定済み（Requirement 3 の確定注記を参照）。

## Glossary

- **Cook_Scheduling（調理順スケジューリング・概念名・仮）**: 本機能の全体。未着手オーダーの調理順・slot 割当・開始時刻を決め、推奨として提示する機構。Baseline_Plan の算出と Acceptance_Gate の判定は engine の純粋変換内、外部要求の実行と計画受領の受け口は shell が担う。
- **Pending_Order（未着手オーダー・概念名・仮）**: POS 連携で到着した、まだ茹で始めていないオーダーの品目。DO の永続層が正本（SSOT）。人が開始すると既存の start 経路で Timer になり、Pending_Order 集合から除かれる。Timer とは別概念であり `TimerFact` に混ぜない。
- **Order_Ingress（オーダー注入経路・概念名・仮）**: 外部システム（POS）が Pending_Order の到着・キャンセルを DO へ届ける認可付き経路。`per-store-provisioning` の Provisioning_API（設定投入の経路）とは別の経路として立てる。
- **External_Order_Id（外部オーダー識別子・概念名・仮）**: POS 側がオーダーに付す識別子。到着の冪等判定（重複到着の同定）の鍵。
- **Order_Arrival_Time（到着時刻）**: Pending_Order が Order_Ingress 経由で受理された絶対時刻という事実。Wait_Time の起点。
- **Wait_Time（待ち時間・導出値）**: あるオーダー品目の実効茹で上がり時刻（Boil_Sync 調整後の実効 `endTime`、未開始品目は計画上の開始時刻＋茹で時間）から Order_Arrival_Time を引いた導出値。状態として保持しない。提供可能になる時刻を待ちの終点とするこの定義で**確定**（ユーザー確認済み。盛り付け時間は全品目に一律なら順序・割当の最適化に影響しない定数のため勘案しない。品目別の盛り付け時間を入れる場合は別 spec の追補とする）。
- **Cook_Plan（調理計画・概念名・仮）**: Pending_Order 集合に対する調理順・slot 割当・開始時刻の割り当て。Baseline_Plan（自前解）と External_Solver 由来の外部計画の 2 種の出所を持つ。
- **Baseline_Plan（自前解・概念名・仮）**: `decide` 内で同期的に算出する高速ヒューリスティックの Cook_Plan。常に feasible（ハード制約充足）。外部不到達時のフォールバックであり、feasibility 検証構造の供給源であり、Committed_Plan の既定部分（採用済み外部計画を持たない対象の計画）を成す。
- **Committed_Plan（確定計画・概念名・仮）**: 現在確定している Cook_Plan。採用済み外部計画の Plan_Unit と、それ以外の対象に対する Baseline_Plan の合成として導出される（導出値であり、正本は採用済み計画の事実と現在の状態）。Cook_Recommendation の導出元であり、Acceptance_Gate の改善判定の比較基準。
- **External_Solver / Solver_Worker（外部ソルバー・概念名・仮）**: DO の外で重い最適化を解く主体。実行形態は Service binding で呼ぶ専用 Worker（Solver_Worker）であり、計算を `ctx.waitUntil` で抱え、完了時に DO への RPC で計画を届ける。計画エンジンは Worker 上で完結する（TypeScript、必要なら Rust → WASM）。内部の定式化・アルゴリズムは本書のスコープ外。
- **RequestPlan（Effect・名称ユーザー確定済み）**: `decide` が返す「外部へ計画を要求せよ」という作用の記述。対象集合・パラメータ・Input_Fingerprint（要求時点の指紋）を運ぶ。shell が実行し、応答を await しない。
- **Acceptance_Gate（受け入れゲート・概念名・仮）**: 外部計画の受領イベントを処理する `decide` 内の判定。陳腐化A（対象の有効性）・陳腐化B（新着との干渉）・feasibility（ハード制約充足）・改善判定（目的関数値が Committed_Plan の対応する値より真に良い）の 4 つを一体で、Plan_Unit ごとに行う。
- **Plan_Unit（採用単位・概念名・仮）**: Cook_Plan を独立に採用/棄却できる単位。定義は design フェーズで確定する（Requirement 6 の申し送り参照。目的関数の分解可能性が成立条件）。Boil_Sync における Proximity_Cluster に相当する分解単位。
- **Input_Fingerprint（入力指紋・概念名・仮）**: 現在の計画の入力（Pending_Order 集合・Running_Timer 集合の必要事実・パラメータ）から決定的に導出される指紋（チェックサム様の値）。要求の抑制（AC 5.6）の「前回依頼時から変わったか」の比較に用い、RequestPlan に載せて外部計画へ引き継がれる（受領時に要求時点の入力を同定する手がかり）。現在の指紋は入力からの導出値であり、状態に昇格させない。永続するのは「直前に `RequestPlan` を生成した時点の Input_Fingerprint」という事実のみで、これを `decide` の決定性の組（Requirement 7.3）に含める。**版カウンタによる入力の世代管理は行わない**（ユーザー確定。計画間の新旧の順序付けは不要——採用済みのより良い計画を後着の劣る計画が置き換えないことは、改善判定の Committed_Plan 基準が保証する）。
- **Cook_Recommendation（開始推奨・概念名・仮）**: Committed_Plan から導出される「次に開始すべき Pending_Order・slot・開始タイミング」の提示。人への提案であって指示ではない。
- **Table_Group（同卓グループ・概念名・仮）**: 同じ卓の客に属するオーダー品目のまとまり。提供時刻をできるだけ近づけるソフト制約の単位。
- **Slot_Affinity（調理位置近接・概念名・仮）**: 関連する品目（同一オーダー・同一 Table_Group）を物理配置上の距離が近い調理位置でボイルするという slot 割当のソフト制約。slot の物理配置（店舗レイアウトのグリッド座標）に基づく距離で評価する（ユーザー確定。二値の隣接判定ではない）。距離はユニット間の物理的な離隔を反映しなければならない——ユニット内の並びだけを座標化すると、ユニット境界を挟んだ grid 上の隣が実際より近く評価される。レイアウトはサーバ権威設定として保持する。離隔の表現は**座標合成**（ユニット原点＋ユニット内オフセット。座標は格子単位で合成し、ユニット間距離は座標からの導出値）で確定し、距離は合成座標上のオクタイル距離とする（ユーザー確認済み。ユニット間距離の加算項という第二の設定概念は持たない）。目的関数へは**許容距離からの超過分**として計上する（隣り合う釜ならペナルティ 0。他の 2 つのソフト制約項と同じ形。Requirement 3 の確定注記を参照）。
- **ハード制約**: 違反する計画を feasible と認めない制約。slot の同時使用の排他・各時点の同時走行本数が slot 数以下・開始済み Timer の割当と `endTime` を変更しないこと。
- **ソフト制約**: 目的関数への劣後項として扱い、違反しても feasible ではある制約。同卓近接提供・同一オーダー同時提供・Slot_Affinity。
- **Timer / Running_Timer / TimerFact / decide / Effect / broadcast / StoreConfig / SSOT**: 既存語彙（`yude-men-timer`・`synchronized-boil-adjustment` の各 spec および steering に従う）。
- **Boil_Sync**: 実装済みの近接同時茹で上がり調整（`synchronized-boil-adjustment`）。本機能と共存し、開始後の調整を担う。

## Requirements

### Requirement 1: オーダーの到着とキャンセル（Order_Ingress）

**User Story:** 運用者として、POS に入ったオーダーが自動でタイマーシステムへ届き、二重登録や取りこぼしなく管理されてほしい。厨房スタッフが手で転記する手間と誤りをなくしたいからだ。

#### Acceptance Criteria

1. THE Cook_Scheduling SHALL Pending_Order の到着・キャンセルを認可付きの Order_Ingress 経由でのみ受け付け、認可されない要求を拒否して状態を変更しない
2. WHEN Order_Ingress がオーダーの到着を受理する、THE Cook_Scheduling SHALL 当該 Pending_Order（External_Order_Id・品目・Order_Arrival_Time を含む）を永続層へ書き込み、その成功後にのみ受理を応答し broadcast する
3. WHEN 同一の External_Order_Id を持つ到着が再送される、THE Cook_Scheduling SHALL 重複する Pending_Order を生成せず、初回受理と同一の確定状態へ収束させる（到着の受理は冪等である）
4. IF 到着の内容が不正（必須属性の欠落・未知の品目種別・型違反のいずれか）である、THEN THE Cook_Scheduling SHALL 当該到着を拒否し、Pending_Order 集合と Timer 集合のいずれも変更しない
5. WHEN Order_Ingress が未着手オーダーのキャンセルを受理する、THE Cook_Scheduling SHALL 当該 Pending_Order を集合から除去し、永続確定後に broadcast する
6. IF キャンセル対象の External_Order_Id に対応する Pending_Order が存在しない（未到達・既に除去済み・既に開始済みのいずれか）、THEN THE Cook_Scheduling SHALL 当該キャンセルを Pending_Order 集合に対して no-op として扱い、開始済み Timer を自動でキャンセルしない
7. THE Cook_Scheduling SHALL 到着・キャンセルの受理を状態変化として扱い、再計算（Requirement 4）の契機とする
8. WHEN Order_Ingress がオーダー内容の変更（modification）を受理する、THE Cook_Scheduling SHALL 当該変更を「キャンセル＋新規到着」へ正規化して扱い、新規到着の Order_Arrival_Time に元の到着時刻を引き継ぐ（変更で待ち時間の起点をリセットしない。独立の変更イベントは立てない）

> **確定済み（ユーザー確認）:** 開始済み品目に対する外部キャンセルは AC 1.6 のとおり Pending_Order 集合に対して no-op とし、Timer の自動キャンセルも通知表示の追加も行わない（新メッセージ種別を増やさない・現場の判断に委ねる）。Order_Ingress の認可は ADMIN_TOKEN とは別の専用 secret（ORDER_INGRESS_TOKEN・仮名）による Bearer 定数時間照合とする——POS は設定を投入する主体ではなく、Provisioning_API の鍵を POS ベンダへ渡すと運用系の書き込み口まで開いてしまうため。

### Requirement 2: 未着手オーダーの正本と可視化

**User Story:** 厨房スタッフとして、まだ茹でていないオーダーの一覧がどの端末でも同じに見えてほしい。端末や再接続のたびに待ち行列が食い違うと、二重に茹でたり取りこぼしたりするからだ。

#### Acceptance Criteria

1. THE Cook_Scheduling SHALL Pending_Order 集合の正本（SSOT）を DO の永続層に置き、外部システム（POS）の状態を正本として参照しない
2. THE Cook_Scheduling SHALL Pending_Order を Timer とは別の概念として保持し、共有契約 `TimerFact` へ Pending_Order の属性を追加しない
3. WHEN Pending_Order 集合、または Cook_Recommendation の導出元（採用済み計画を含む永続状態）が確定して変化する、THE Cook_Scheduling SHALL 永続層への書き込み成功後にのみ全端末へ broadcast する
4. WHEN ある端末が再接続して状態を再取得（hydration）する、THE Cook_Scheduling SHALL 現在確定している Pending_Order 集合と Cook_Recommendation を当該端末へ反映し、再取得完了時点で他端末と同一の内容を持たせる
5. THE Cook_Scheduling SHALL Pending_Order 集合と採用済み Cook_Plan を hibernation を跨いで永続層から再構築できる状態に保つ（rehydrate 後に揮発した推奨を復元できる）

### Requirement 3: 目的関数と制約

**User Story:** 店主として、注文された品それぞれが届くまでの待ち時間を、店全体でできるだけ短くしたい。そのうえで、同卓のお客様にはできるだけ近いタイミングで提供し、関連する麺は物理的に近い調理位置で茹でてほしい。待ち時間と現場のわかりやすさの両方が店の質だからだ。

#### Acceptance Criteria

1. THE Cook_Scheduling SHALL 計画の主目的を「全オーダー品目の Wait_Time の合計の最小化」とする
2. THE Cook_Scheduling SHALL 各品目の Wait_Time を、当該品目の実効茹で上がり時刻（未開始品目は計画上の開始時刻＋茹で時間、開始済み品目は Boil_Sync 調整後の実効 `endTime`）から当該オーダーの Order_Arrival_Time を引いた導出値として算出し、状態として保持しない
3. THE Cook_Scheduling SHALL 次のハード制約を満たさない計画を feasible と認めない: (a) 同一 slot を同一時間帯に複数品目へ割り当てない、(b) 各時点の同時走行本数を slot 数以下に保つ、(c) 開始済み Timer の slot 割当・実効 `endTime` を変更しない
4. THE Cook_Scheduling SHALL 次をソフト制約（目的関数への劣後項）として扱う: (a) 同一 Table_Group の品目の提供時刻の近接、(b) 同一オーダーの複数品目の同時提供、(c) Slot_Affinity（関連品目間の slot 物理距離のうち許容距離を超過した分の最小化）
5. WHERE ソフト制約とハード制約または主目的が衝突する、THE Cook_Scheduling SHALL ハード制約を常に優先し、ソフト制約の違反を feasibility の否定事由にしない
6. THE Cook_Scheduling SHALL 計画と推奨の導出を決定的に行う（決定性の入力の組は Requirement 7.3 に定める四つ組を正本とする）

> **確定済み（ユーザー確認）:** ソフト制約の織り込みは**整数重み付き和**とする（レキシコグラフィックは採らない。決定性のための整数演算と相性が良く、Plan_Unit ごとの分解が加算で素直に成立するため）。目的関数 = Σ Wait_Time(秒) + w_table × Σ(同一 Table_Group の提供時刻の最大差のうち許容幅 60 秒 超過分) + w_order × Σ(同一オーダーの提供時刻の最大差のうち許容幅 30 秒 超過分) + w_affinity × Σ(関連品目間の slot 物理距離のうち許容距離 超過分)。slot の物理距離は店舗レイアウト（slot のグリッド座標・サーバ権威設定）から算出する（距離尺度の具体は design で定める）。**3 項すべてを「許容幅からの超過分」の形に揃える**（ユーザー確定）——距離を生の値のまま計上すると、関連品目を同時に提供するには別 slot が必須（ハード制約 (a)）で距離が 0 になりえず、到達不能な下限が品目数に応じて底上げされ、主目的との比較を水増しするため。許容距離の既定は**斜め隣接まで**を許容する値とする（隣り合う釜ならペナルティ 0。具体値は距離尺度と同じ単位系で design が定める）。重みは w_table = 2・w_order = 3・w_affinity = 1（w_table / w_order は秒換算、w_affinity は距離換算のペナルティ係数）。主目的の集計単位は**品目単位**（オーダーと客の 1:1 対応が保証されない制約が存在しうるため）。品目単位の和とソフト制約 (b) の緊張は、w_order = 3 を最大に置き「同一オーダーはまとめる」を優先する形で対処する。ソフト制約の列挙は開いており（Introduction 参照）、追加が確定した場合は本 Requirement へ追補する。また、未開始品目の Wait_Time（AC 3.2）は Boil_Sync による開始後の調整（±h_i）を織り込まない**近似**であり、開始済み品目（調整後の実効 `endTime` を用いる）との間に定義の非対称がある。改善判定は両計画を同じ近似の上で比較するため一貫する。

### Requirement 4: 自前ヒューリスティック解（Baseline_Plan）

**User Story:** 運用者として、外部の最適化サービスが落ちていても現場の推奨が止まらないでほしい。外部依存が新しい故障点になるなら導入しない方がましだからだ。

#### Acceptance Criteria

1. WHEN 状態変化（オーダー到着・キャンセル・開始・完了・計画受領のいずれか）を処理する、THE Cook_Scheduling SHALL 当該 `decide` 呼び出し内で同期的に Baseline_Plan を算出する
2. THE Cook_Scheduling SHALL Baseline_Plan として常に feasible（Requirement 3 のハード制約をすべて満たす）な計画を返し、Pending_Order 集合が空の場合は空の計画を返す
3. THE Cook_Scheduling SHALL Baseline_Plan の算出を決定的に行う（同一入力に対し入力の列挙順に依存しない同一の計画を返す）
4. THE Cook_Scheduling SHALL External_Solver の可用性・応答の有無にかかわらず、Baseline_Plan のみで Cook_Recommendation の提示を含む全機能を成立させる（外部は改善の供給源であって前提ではない）
5. THE Cook_Scheduling SHALL Baseline_Plan の算出過程で、Acceptance_Gate の判定（feasibility 検証・目的関数値の算出）に必要な構造を併せて得る（ゲートのための追加の外部照会・別種の計算を要しない）

### Requirement 5: 外部への計画要求（RequestPlan）

**User Story:** 開発者として、重い最適化を DO の外へ逃がしつつ、DO の純粋変換と hibernation 規律を壊したくない。`decide` が外部を待ち始めた瞬間に、この設計の背骨が折れるからだ。

#### Acceptance Criteria

1. THE Cook_Scheduling SHALL 外部への計画要求を Effect（`RequestPlan`）として `decide` の戻り値に記述するだけとし、`decide` の内部でネットワーク I/O・外部呼び出しを実行しない
2. THE Cook_Scheduling SHALL `RequestPlan` の実行（Solver_Worker への Service binding 呼び出し）を shell に担わせ、shell は受理応答（HTTP 202 相当）のみを await し、計算完了を await しない
3. THE Cook_Scheduling SHALL `RequestPlan` に、計画対象（Pending_Order 集合・Running_Timer 集合の必要事実）・パラメータ・Input_Fingerprint（要求時点の指紋）を含める
4. THE Cook_Scheduling SHALL 直前に `RequestPlan` を生成した時点の Input_Fingerprint を永続する事実として保持し、版カウンタによる入力の世代管理を行わない
5. THE Cook_Scheduling SHALL `RequestPlan` の生成契機を状態変化を処理する `decide` 呼び出しに限り、ポーリング・`setInterval`・時刻起動の要求を行わない
6. IF 現在の計画の入力から導出した Input_Fingerprint が、直前に `RequestPlan` を生成した時点の Input_Fingerprint と一致する、**または計画対象の Pending_Order が空である**、THEN THE Cook_Scheduling SHALL `RequestPlan` を生成しない（要求の抑制。計画する対象が無い要求は改善しうるものが存在しないため出さない。「直前に `RequestPlan` を生成した時点の Input_Fingerprint」は永続する事実として保持し、隠れた入力にしない。確定計画と Baseline_Plan の比較を抑制条件にしない——外部計画の採用後は両者の不一致が恒常化し、抑制が機能しなくなるため）
7. THE Cook_Scheduling SHALL 外部計画の受領（採用・棄却のいずれの結果でも）自体を新たな `RequestPlan` の契機にしない（要求の連鎖・ループを作らない）
8. THE Cook_Scheduling SHALL Effect 列の不変条件（`Persist` を先頭に持つ）を維持し、`RequestPlan` を `Persist` 成功後にのみ実行する

### Requirement 6: 受け入れゲート（Acceptance_Gate）

**User Story:** 開発者として、外部から届いた計画を無条件に信じたくない。届いた頃には現場が変わっているかもしれず、制約を破る計画や改善しない計画を採用すれば、外部が新しい事故源になるからだ。

#### Acceptance Criteria

1. THE Cook_Scheduling SHALL 外部計画の受領を DO への単一の受信経路（RPC）で受け、`decide` のイベントとして純粋変換内で判定する
2. THE Acceptance_Gate SHALL 次の 4 判定を一体で行い、すべてを満たす部分のみ採用する: (a) 陳腐化A — 計画の対象が現在も有効である（キャンセル・完了・開始済みで消えていない）、(b) 陳腐化B — 計画が知らない新着 Pending_Order が計画対象と干渉しない、(c) feasibility — Requirement 3 のハード制約を満たす、(d) 改善 — 目的関数値が Committed_Plan の対応する値より真に良い（同値は棄却し、無駄な Persist / Broadcast を発生させない。比較基準を Committed_Plan とすることで確定計画の単調な改善を保証する）
3. THE Acceptance_Gate SHALL 採用・棄却の判定を Plan_Unit ごとに独立に行い、計画全体の一括採用/一括棄却を行わない（無関係な変化 1 件で全体が落ちる形にしない）
4. THE Acceptance_Gate SHALL in-flight の重複・追い越し（複数の要求が同時に飛んでいる状態・応答の到着順の入れ替わり）を (a)〜(d) の判定のみで吸収し、要求と応答の対応付け・版カウンタによる世代管理・追跡機構のいずれも設けない（採用済みのより良い計画を後着の劣る計画が置き換えないことは、改善判定 (d) の Committed_Plan 基準が保証する）
5. WHEN 1 つ以上の Plan_Unit を採用する、THE Cook_Scheduling SHALL 採用結果を永続層へ書き込み、その成功後にのみ全端末へ broadcast する
6. IF すべての Plan_Unit が棄却される、THEN THE Cook_Scheduling SHALL 状態を変更せず、Persist と Broadcast のいずれも行わない
7. THE Acceptance_Gate SHALL 判定に必要な構造を Baseline_Plan の算出過程（Requirement 4.5）から得て、判定のために外部への照会を行わない

> **design への申し送り:** Plan_Unit の独立性判定は、slot を取り合う現実（釜数が少なく全オーダーが競合する）では全体が 1 つの連結成分に潰れやすく、その場合 AC 6.3 の分解保証が空文化する。design フェーズでは厳密な非干渉に固執せず、代替の分解軸——時間帯の前方/後方での分割、または「前方の確定部分は後方の変化に影響されない」という時間的な半順序による定義——を含めて Plan_Unit の定義を確定する。ただしいずれの定義も、**目的関数（ソフト制約項を含む）が Plan_Unit ごとに分解可能であること**を満たさなければならない（AC 6.2(d) の部分比較の成立条件）。主目的（Wait_Time の品目和）は分解可能だが、ソフト制約項（Table_Group 近接・同時提供・Slot_Affinity）は品目間の相互作用であり、Plan_Unit を跨ぐペアがあると部分和に分解できない。とくに時間帯の前方/後方分割は境界を跨ぐ Table_Group を必ず生むため、この条件との衝突を踏まえて検討する。

### Requirement 7: 採用済み計画の永続と決定性

**User Story:** 開発者として、採用した計画が次のイベントで黙って消えたり、隠れた入力として決定性を壊したりしないでほしい。状態は一望でき、同じ入力からは同じ結果が出てほしいからだ。

#### Acceptance Criteria

1. WHEN 外部計画の Plan_Unit を採用する、THE Cook_Scheduling SHALL 採用された計画を「外部から届いて採用された再現不能な事実」として永続層に保持する
2. THE Cook_Scheduling SHALL 採用済み計画から導出できる値（各品目の推奨開始時刻の表示形・推奨順序など）を導出値として扱い、状態に昇格させない
3. THE Cook_Scheduling SHALL `decide` の決定性を四つ組（対象集合, パラメータ, 採用済み計画, 直前に `RequestPlan` を生成した時点の Input_Fingerprint）に対して保証する（採用済み計画と直前要求の指紋を明示的な入力とし、隠れた入力を作らない。現在の Input_Fingerprint は対象集合とパラメータからの導出値ゆえ組に含めない）
4. THE Cook_Scheduling SHALL 同一の四つ組に対する再計算を冪等にする（2 回適用した結果は 1 回適用した結果と一致する）
5. THE Cook_Scheduling SHALL 採用済み計画を時間経過のみでは失効させず、次の状態変化を処理する `decide` 内で再評価し、陳腐化しない Plan_Unit を維持し、陳腐化した Plan_Unit を Baseline_Plan の対応部分で置き換え、その合成を新しい Committed_Plan とする（有効期間は次の状態変化まで。時刻起動の失効判定を設けない）
6. IF 再評価の結果が直前の確定結果から変化しない、THEN THE Cook_Scheduling SHALL 永続層への書き込みと broadcast のいずれも行わない

### Requirement 8: 推奨提示と人の最終決定

**User Story:** 厨房スタッフとして、次にどれをどの釜に入れるべきかの推奨は見たいが、最終判断は自分がしたい。現場には機械の知らない事情（麺の在庫・客の様子・手の空き具合）があるからだ。

#### Acceptance Criteria

1. THE Cook_Scheduling SHALL Committed_Plan から Cook_Recommendation（次に開始すべき Pending_Order・slot・開始タイミング）を導出し、client が表示できる形で配信する
2. THE Cook_Scheduling SHALL 開始を強制せず、推奨した開始時刻の到来によって Timer を自動開始しない（開始の起点は常に人の操作である）
3. WHEN 人が推奨と異なる Pending_Order・slot・タイミングで開始を操作する、THE Cook_Scheduling SHALL 当該開始を推奨との不一致を理由に拒否しない（既存の start 経路が持つ拒否事由はそのまま維持する）
4. WHEN 人が Pending_Order を開始する、THE Cook_Scheduling SHALL 既存の start 経路で Timer を生成し、当該品目を Pending_Order 集合から除き、この変化を再計算（Requirement 4・5）の契機とする
5. THE Cook_Scheduling SHALL すべての端末に対して同一の Cook_Recommendation を反映し、broadcast と hydration により端末間で内容を一致させる

> **確定済み（ユーザー確認・改訂）:** POS を経ない開始は**アドホック麺茹で**として残す——オーダーの追加ではなく、麺の種類を選んで茹でる既存 start 経路の機構である。アドホック麺茹での Timer は Pending_Order と紐づかず、計画対象に入れない。開始後は Running_Timer として feasibility と Wait_Time 算出の所与の事実になる（Order_Arrival_Time を持たないため主目的の和には寄与しない）。当初の決定「設けない」は本改訂で置き換える。

### Requirement 9: Boil_Sync との共存（階層分担）

**User Story:** 開発者として、開始前の計画と開始後の調整が互いの領分を侵さないでほしい。二つの機構が同じ値を取り合えば、真実の源が二つになるからだ。

#### Acceptance Criteria

1. THE Cook_Scheduling SHALL 自身の決定範囲を未開始の Pending_Order（調理順・slot 割当・開始時刻の推奨）に限り、開始済み Timer の slot 割当・`endTime`・Adjustment を変更しない
2. THE Cook_Scheduling SHALL 開始後の近接茹で上がり調整を引き続き Boil_Sync に委ね、Boil_Sync の入力（Running_Timer 集合・arms・Tolerance_Ratio）と計算規律を変更しない
3. THE Cook_Scheduling SHALL 計画の feasibility 判定と Wait_Time 算出において、開始済み Timer の実効 `endTime`（Boil_Sync 調整後）を所与の事実として扱う
4. WHEN 人の開始により Running_Timer 集合が変化する、THE Cook_Scheduling SHALL Boil_Sync の既存の再計算（`synchronized-boil-adjustment` 要件 7）をそのまま作動させ、抑止・先回り・重複実行のいずれも行わない

### Requirement 10: 失敗パスの構造化

**User Story:** 運用者として、外部ソルバーの不調・遅延・不正応答がタイマー本体に波及しないでほしい。最適化はあくまで改善であり、その失敗で現場の計時が乱れては本末転倒だからだ。

#### Acceptance Criteria

1. IF External_Solver が不到達・タイムアウト・エラー応答のいずれかである、THEN THE Cook_Scheduling SHALL Timer 集合・Pending_Order 集合・Cook_Recommendation の導出元となる確定状態を変更せず、現在の Committed_Plan による推奨で継続する（外部の失敗を新しい失敗経路にしない。外部が一度も応答しなくても Committed_Plan は Baseline_Plan のみで成立する）
2. IF shell による `RequestPlan` の送出が失敗する、THEN THE Cook_Scheduling SHALL 当該失敗を Timer 本体の応答・状態へ伝播させず、DO 内での再試行を抱えない（次の状態変化での要求生成に委ねる）
3. IF 受領した外部計画が解析不能・スキーマ不正・Input_Fingerprint の欠落のいずれかである、THEN THE Acceptance_Gate SHALL 当該計画の全体を棄却し、状態を変更しない
4. THE Cook_Scheduling SHALL in-flight の計画要求（送出済み・未応答）の追跡状態を持たず、応答の有無を監視する Alarm・タイマーを設けない（応答が来なければ何も起きず、来れば Acceptance_Gate が判定する）
5. IF 採用結果・Pending_Order の永続層への書き込みが失敗する、THEN THE Cook_Scheduling SHALL broadcast を行わず、直前に確定した状態を保持し、後続の hydration により確定状態を回復する（既存の Persist 失敗規律を踏襲する）

### Requirement 11: 計算量と実行頻度の前提（非機能）

**User Story:** 運用者として、計画計算が現場の規模で軽量に収まり、待機中に資源を浪費しないことを保証したい。DO 内のイベント処理が重くなって発火や broadcast が遅れたり、hibernation が妨げられたりすると困るからだ。

#### Acceptance Criteria

1. THE Cook_Scheduling SHALL Baseline_Plan の算出と Acceptance_Gate の判定を、入力規模 n（Pending_Order 数 + Running_Timer 数）に対する多項式時間で完了させる（具体アルゴリズムと計算量上限の確定は design フェーズで行う）
2. THE Cook_Scheduling SHALL n の上限を Running_Timer についてはスロット数由来の既存上限、Pending_Order については計画対象の件数上限 **64 品目** で扱う——到着の受理・永続は上限なく継続し（正本を欠かない）、計画対象を Order_Arrival_Time 昇順の先頭 64 品目に限定する（ユーザー確定。超過分は Pending_Order として保持・表示され、Cook_Recommendation の対象にならず、先頭が減ると自然に計画対象へ入る。Pending_Order 数はスロット数で抑えられないため Boil_Sync 要件 8.1 の有限性根拠をそのまま流用せず、超過は Timer 本体の動作を壊さない）
3. THE Cook_Scheduling SHALL 計画に関わる一切の計算を状態変化の離散イベントを処理する `decide` 呼び出し内で完結させ、イベント間は計算を行わず hibernation を妨げない
4. THE Cook_Scheduling SHALL `setInterval`・`waitUntil`・DO 内の外部 await・常駐ポーリングを一切用いない
5. THE Cook_Scheduling SHALL External_Solver の計算を DO の実行外で行わせ、復路の受領を DO への通常の wake（RPC）として処理する（DO 側の待機の禁止は Requirement 12.2 に定める）

### Requirement 12: 外部ソルバーの実行形態（Solver_Worker・非機能）

**User Story:** 開発者として、外部ソルバーを新しい耐久機構なしの最小の形で置きたい。要求が失われても害がなく古い結果はゲートで落ちる性質なのに、Queues や Workflows の耐久性・リトライ・順序保証を持ち込めば、不要な機構が有害な複雑さになるからだ。

#### Acceptance Criteria

1. THE Cook_Scheduling SHALL External_Solver を Service binding で呼ぶ専用の Solver_Worker とし、Queues・Workflows・Containers を本番経路に用いない
2. WHEN shell が `RequestPlan` を実行する、THE Cook_Scheduling SHALL Solver_Worker からの受理応答（HTTP 202 相当）のみを await し（数 ms 規模）、計算完了の待機を DO 側に持たない
3. THE Solver_Worker SHALL 計画計算を自身の `ctx.waitUntil` で抱え、完了時に DO への RPC で計画を届ける（復路は正当な wake）
4. THE Solver_Worker SHALL 計画エンジンを Worker 上で完結させる（TypeScript、必要なら Rust → WASM）。Python は本番経路に持ち込まず、参照オラクル（テストでの正解比較）専用とする
5. THE Solver_Worker SHALL Workers の実行制約（デプロイサイズ 10 MB gzip・起動 1 秒・メモリ 128 MB・スレッドなし）の内で動作する
6. WHERE Rust → WASM を採用する、THE Cook_Scheduling SHALL WASM モジュールのサイズと起動時間を実測し、起動 1 秒制約への適合を確認したうえで採用を確定する（起動 1 秒が WASM 採用時の主制約である）
7. THE Cook_Scheduling SHALL External_Solver の非決定性（時間打ち切り・乱数により同一入力から異なる計画が届くこと）を許容し、外部計画には Acceptance_Gate の判定（feasibility・改善）の通過のみを要求する。決定性の要求（Requirement 3.6・4.3・7.3・7.4）は DO 側の計算（Baseline_Plan・Acceptance_Gate・`decide`）に限る
