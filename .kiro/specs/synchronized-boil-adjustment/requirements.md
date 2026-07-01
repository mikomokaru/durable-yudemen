# Requirements Document

## Introduction

近接した複数の茹で上がりを「同時に上げられる」ようにそろえる機能である。各 Timer は「規定の茹で時間」から前後一定の **割合** まで茹で上がり時刻を調整してよい——という品質上の許容を持つ。この許容の範囲（許容調整窓）が複数の Timer どうしで重なるとき、それらを共通の茹で上がり時刻へ寄せて、厨房スタッフが一度の動作でまとめて湯切り・盛り付けできるようにする。

許容調整窓の半幅は、各 Timer の **茹で時間（Boil_Duration = endTime − startTime）に対する割合（Tolerance_Ratio、既定 10%）** で決まる。すなわち Timer i の許容半幅は `h_i = Boil_Duration_i × Tolerance_Ratio` であり、絶対秒の上限・下限によるクランプは設けない。割合方式を採る理由は、茹で時間が短いほど 1 秒の品質インパクトが大きく、固定の絶対秒（旧方式の ±15 秒）では短時間の茹で麺に過大な調整を許してしまうためである。窓を茹で時間に比例させることで、調整がもたらす品質インパクトを茹で時間によらず一定に保つ。許容半幅は Timer ごとに異なるため、許容調整窓は Timer ごとに幅の異なる **非対称** な区間の集まりになる。

調整は **双方向** である。共通の茹で上がり時刻へそろえるために、各 Timer の茹で上がりを規定時刻より早める（負方向）ことも遅らせる（正方向）こともできる。ただし、いずれの方向でも各 Timer の許容調整窓（`endTime ± h_i`）を超えてはならない。窓を超える調整は麺の品質を損なうため、決して行わない。

同時に上げられる本数の上限は **腕の本数（arms、既定 2）** に等しい。すなわち arms 本まで同時に上げられ、1 つの「セット（同時に上げる単位 = Sync_Set）」に含められる最大本数は arms 本である。許容調整窓が重なって連鎖する茹で上がりが arms 本を超えるときは、arms 本ずつの Sync_Set に分割し、セットとセットの間隔をできるだけ広くとって段階的に上げられるようにそろえる。腕の本数は店舗ごとに異なりうるため、arms はサーバ権威設定（`StoreConfig`）として店舗ごとに設定できる。同様に許容調整割合（Tolerance_Ratio、既定 10%）も `StoreConfig` に保持し、店舗ごとに設定できる。

共通茹で上がり時刻の決め方は **maximin 最適化** である。連続するセットの共通時刻（Sync_Target）の間隔の最小値を最大化するよう、各セットの Sync_Target を窓の許す範囲で離して均等に配置し、厨房の作業間隔をできるだけ広くとる。セット間隔には下限（最小インターバル）を設けず、各セットの Sync_Target が自身の Window_Intersection 内にあるという制約の下で、連続する確定セットの間隔の最小値を最大化することだけでセット間隔を決める。これは、各セットの自然な中点へ詰める旧方式（貪欲法）を置き換えるものであり、中点は最適解の一候補にすぎず目的そのものではない。

許容調整窓は **絶対優先** である。窓内へ収める配置が存在しない（Window_Intersection が空で同期不能な）セットは、同期させず規定の茹で上がり時刻（無調整）のまま残す。品質（窓内に収めること）を常に優先し、同期見送り（フォールバック）は Window_Intersection が空の場合に限る。

計算はサーバ側（DO の純粋変換 `decide` 配下）で行い、確定した結果を全端末へ broadcast して同期する。SSOT は永続層であり、各端末はサーバ確定後の事実を受け取って表示・発火に反映する。同期計算は start・cancel・boiled の離散イベント時にのみ走り、イベント間は hibernate する。同時に走行しうる Running_Timer 数はスロット（釜）数で上限が決まり（運用上は数十オーダー）、1 次元時間軸上の maximin 最適化はこの規模で軽量に収まる（具体アルゴリズムと計算量の確定は design フェーズに委ねる）。

### 設計上の重要な制約（ユーザー明示・steering 再整合）

本機能の調整機構（Boil_Sync）は **engine 内に閉じる**。共有契約 `TimerFact`（`src/domain/timer.ts`）およびワイヤ・クライアント向けメッセージには **Adjustment フィールドを持たせない**。domain の語彙は `id`・`slotIds`・`noodleType`・`firmness`・`startTime`・`endTime` のまま変えない。Adjustment は `seq`・`boiledAt` と同種の **engine 専用（engine-only）の関心事**であり、engine 内に閉じる（`timer-model.md`「片側専用の関心事は共有契約 domain に混ぜない」に従う）。

クライアントへは、調整後の実効茹で上がり時刻（Adjusted_Boil_Time）を **既存の `endTime` フィールドで射影して**伝える。engine は Timer→TimerFact 射影時に、engine 内部の Adjustment を反映した実効 `endTime` を wire に載せる（`seq` を射影で削ぐのと同じ表現境界の一部）。クライアントは調整の存在を意識しない。受け取った `endTime`（＝実効茹で上がり時刻）をそのまま用い、残り時間 = `endTime − now` を今まで通り導出する。**クライアント側に Adjustment 概念・再計算を持ち込まない**（クライアント変更不要）。

engine は元の規定茹で上がり時刻（オリジナル `endTime`）を **engine 内部の不変アンカー**として保持し、Tolerance_Window の計算と集合変化時の全体再計算に用いる。オリジナルを失わないこと（「`endTime` を書き換えない」の本旨＝アンカー保持）は engine 内で担保する。Adjustment を永続に持つか、都度 `decide` 内で導出するかは design 判断とする（再計算は全体置換ゆえ都度導出も可）。発火（boiled 遷移）は engine 内で Adjusted_Boil_Time（オリジナル `endTime` ＋ Adjustment）を基準に行う。

> **既存 steering との差分（明示）:** 本改訂により、本スペックは `steering/timer-model.md`「近接茹で上がりの終了調整」の方針（調整は engine の `decide` で行い、調整後の値は既存 `endTime` フィールドのまま client へ伝わる／ワイヤ・共有の形は変えない／新しい変換を engine へ足すだけ）に **再整合**した。従来書いていた「`endTime` 不変＋Adjustment を共有事実として別保持し client が導出する」という乖離アプローチは撤回する。Adjustment は engine-only に閉じ、client へは実効 `endTime` を射影する。ただし steering が示唆する「`endTime` を直接書き換える」に対しては、本スペックは engine 内でオリジナル `endTime` をアンカーとして保持する点だけを精緻化する——永続の正本は原則オリジナル `endTime`、wire は実効値（射影値）である。この一点の精緻化を除き、ワイヤ・共有・client の形は steering の方針どおり変えない。

> **概念名について:** 本書に現れる `Boil_Sync`・`Adjustment`・`Adjusted_Boil_Time`・`Tolerance_Ratio`・`Boil_Duration`・`Tolerance_Window`・`Proximity_Cluster`・`Sync_Set`・`Sync_Target`・`arms` 等は、要件記述のために導入した**仮の概念名**である。とりわけ旧版の `Adjust_Tolerance`（絶対秒の許容半幅）は、本改訂で意味が変わり「茹で時間に対する割合」を表す `Tolerance_Ratio` へ概念ごと置き換えた。`arms`（腕の本数）は旧版の `Max_Concurrent`（同時化上限）を、その実体である「腕の本数」へ概念を寄せて改名した仮名である。許容半幅 `h_i` は `Boil_Duration_i × Tolerance_Ratio` から求まる導出値であり、状態として保持しない。公開シンボル（型・公開関数・状態フィールド・メッセージ種別）の確定名は、命名規律（`naming.md`）に従い design / 実装フェーズでユーザー確認を経て決める。

> **共通時刻の決定について:** 同期セットの共通茹で上がり時刻（Sync_Target）は、連続するセットの Sync_Target 間隔の最小値を最大化する **maximin（バッチ間間隔の最大化）を単一の目的**として決める。各タイマーを元の `endTime` に最も近づける「合計調整量の最小化」は目的として採らない（両者は窓内での目標配置で衝突するため、現場の作業間隔を優先して maximin を採用した）。制約（各メンバーが自身の Tolerance_Window 内、1 セット arms 本以下）を満たす配置の中から最適解を選ぶ。セット間隔の下限（最小インターバル）は設けない。maximin が単独では一意に定まらない退化ケース（バッチが 1 つだけでセット間隔が存在しない場合や、最適解が複数ある場合）は、決定的タイブレーク規律で一意化する。最適解が複数あるときの一意化（決定的タイブレーク規律）の具体（例: 窓内の中点に寄せる等）や、バッチ membership 自体（どの Timer を同一セットにまとめるか）を最適化対象に含めるか否かは、design フェーズでユーザー確認を経て確定する。本書では当面、バッチ membership を `endTime` 昇順チャンク（先頭から arms 本ずつ）の決定的既定とし、その上で Sync_Target 配置を maximin 最適化する。

## Glossary

- **Boil_Sync（近接同時茹で上がり調整）**: engine 側の純粋変換が担う、許容調整窓が重なる茹で上がりを同期セットへそろえる調整機構。engine 内に閉じた機構であり、domain（共有契約）は関知しない。engine 内部で Adjustment を割り当て、Timer→TimerFact 射影時に実効 `endTime` として結果を全端末へ反映する。
- **Timer**: ゆで麺の計時単位。`id`・`slotIds`・`noodleType`・`firmness`・`startTime`・`endTime` を事実として持つ（`TimerFact`、`src/domain/timer.ts`）。残り時間は `endTime` からの導出値であって状態ではない。`TimerFact` に Adjustment フィールドは持たせない。
- **endTime（茹で上がり時刻）**: Timer の茹で上がり絶対時刻。`TimerFact` の共有事実として wire・client へ現れる。ただし wire の `endTime` は engine が射影する **実効値**（Adjustment を反映した Adjusted_Boil_Time）であり、engine はオリジナルの `endTime`（規定茹で上がり時刻）を engine 内部の不変アンカーとして別途保持する。オリジナル `endTime` は許容調整窓（Tolerance_Window）のアンカー（中心）であり、書き換えられないからこそ集合変化時の全体再計算の起点になる。
- **startTime（開始時刻）**: Timer の計時開始絶対時刻という事実（`TimerFact` の共有事実）。本機能は `startTime` を書き換えない。`Boil_Duration` の算出に用いる。
- **Boil_Duration（茹で時間）**: オリジナル `endTime − startTime` で算出する不変量。engine 内部の不変アンカー（オリジナル `endTime`）と `startTime` から常に再導出でき、許容半幅の基準になる。
- **Adjustment（調整時間・engine-only・概念名・仮）**: 同期のために engine が各 Running_Timer へ割り当てる、オリジナル `endTime` に対する **符号付き** オフセット（初期値 0）。負は茹で上がりを早める方向、正は遅らせる方向を表す。値域は当該 Timer の許容半幅により `−h_i` 以上 `+h_i` 以下（Timer ごとに異なる）。**engine 専用の関心事であり、domain・ワイヤ・クライアントには現れない**。engine は Adjusted_Boil_Time を実効 `endTime` として wire へ射影する。Adjustment を永続に持つか都度導出するかは design 判断。
- **Adjusted_Boil_Time（調整後茹で上がり時刻）**: engine が `オリジナル endTime + Adjustment` で算出する実効茹で上がり時刻。クライアントへは既存の `endTime` フィールドで射影して伝える。engine 内の発火（boiled 遷移）と、クライアントの表示・カウントダウンの基準になる。
- **Tolerance_Ratio（許容調整割合・概念名・仮）**: 各 Timer が自身の `Boil_Duration` に対して前後に調整してよい割合。既定 10%。サーバ権威設定（`StoreConfig`）として配信し、クライアントは変更できない。旧版 `Adjust_Tolerance`（絶対秒）を概念ごと置き換えたもの。
- **h_i（許容半幅・導出値）**: Running_Timer i の許容調整窓の半幅。`h_i = Boil_Duration_i × Tolerance_Ratio` で算出する。絶対秒の上限・下限によるクランプは設けない。Timer ごとに値が異なる。
- **Tolerance_Window（許容調整窓）**: ある Running_Timer i の `[endTime_i − h_i, endTime_i + h_i]`（両端を含む閉区間。`endTime_i` はオリジナル `endTime`）。当該 Timer の Adjusted_Boil_Time が取りうる範囲。窓の中心（アンカー）は engine 内部で不変のオリジナル `endTime_i`、半幅 `h_i` は不変の `Boil_Duration_i` から導出される。ゆえに engine はいつでもオリジナル `endTime_i`・`startTime_i` から一意に再導出でき、Adjustment を適用しても移動・伸縮しない。
- **Running_Timer（走行中 Timer）**: まだ茹で上がっていない Timer（engine の `boiledAt === null`）。Boil_Sync の調整対象になりうるのは Running_Timer のみ。
- **Proximity_Cluster（近接クラスタ・概念名・仮）**: 2 つの Running_Timer A・B の Tolerance_Window が重なる関係（`|endTime_A − endTime_B| ≤ h_A + h_B`）を推移的に閉じてつながる、極大の Running_Timer 集合。同期候補のまとまりであって、クラスタ内の全メンバーが必ずしも単一の共通時刻へそろうとは限らない（実際にそろうかは Sync_Set ごとの窓の積で決まる）。
- **Sync_Set（同期セット・概念名・仮）**: 一つの Proximity_Cluster を `endTime` 昇順に arms 本ずつ区切った部分集合。同時に上げる単位（バッチ）。同期可能な Sync_Set のすべてのメンバーは単一の Adjusted_Boil_Time（同時に茹で上がる）を持つ。
- **Window_Intersection（窓の積）**: ある Sync_Set の全メンバー i の Tolerance_Window の共通部分 `[max_i(endTime_i − h_i), min_i(endTime_i + h_i)]`。空でないこと（`max_i(endTime_i − h_i) ≤ min_i(endTime_i + h_i)`）が、当該セットを単一の共通時刻へそろえられる必要十分条件。
- **Sync_Target（同期目標時刻・概念名・仮）**: 同期可能な Sync_Set のメンバーがそろう共通の Adjusted_Boil_Time。当該セットの Window_Intersection 内になければならない。同一クラスタ内の各 Sync_Set の Sync_Target は、各 Sync_Target が自身の Window_Intersection 内にあるという制約の下で、連続セット間隔の最小値を最大化（maximin）するよう決める。
- **arms（腕の本数・概念名・仮）**: 同時に上げられる本数の上限であり、その実体は厨房スタッフの腕の本数。1 つの Sync_Set に含められる最大本数（= 同一の Sync_Target へそろえられる Timer の最大本数）に等しい。腕が 2 本という物理制約により既定 2。サーバ権威設定（`StoreConfig`）として店舗ごとに設定できる。旧版 `Max_Concurrent`（同時化上限）を、その実体である「腕の本数」へ概念を寄せて改名した仮名。
- **StoreConfig**: 店舗のサーバ権威設定（`src/domain/store.ts`）。クライアントは受信のみで変更不可。本機能が `StoreConfig` に保持する設定は arms・Tolerance_Ratio の 2 つであり、いずれも店舗ごとに設定できる。`StoreConfig` はこれら 2 つの正本（SSOT）である。
- **decide**: engine の唯一の純粋な状態遷移 `(状態, イベント) → (新状態, 作用)`（`src/engine/`）。Boil_Sync の計算はこの純粋変換の中で行い、`storage.put`・broadcast・`setAlarm` などの作用は端（shell）が実行する。
- **broadcast**: サーバが確定した事実を全端末へ配信する作用。SSOT（永続層）への確定後にのみ行う。

## Requirements

### Requirement 1: 許容調整窓の重なりによる近接検出（Proximity_Cluster の形成）

**User Story:** 厨房スタッフとして、規定の茹で時間に応じた割合の範囲で重なる麺を機械にまとめて認識してほしい。一緒に上げられそうな茹で上がりを 1 つのまとまりとして扱いたいからだ。

#### Acceptance Criteria

1. THE Boil_Sync SHALL Running_Timer のみを近接判定の対象とし、`boiledAt` が非 null である既に茹で上がった Timer を調整対象から除外する
2. THE Boil_Sync SHALL 各 Running_Timer i の許容半幅を `h_i = (endTime_i − startTime_i) × Tolerance_Ratio`（`endTime_i` はオリジナル `endTime`）として算出し、Tolerance_Window を `[endTime_i − h_i, endTime_i + h_i]` として engine 内部の不変アンカーであるオリジナル `endTime_i` を中心に張り、Adjusted_Boil_Time ではなくオリジナル `endTime_i` を窓の中心に用いる
3. THE Boil_Sync SHALL 2 つの Running_Timer A・B のオリジナル `endTime` の絶対時刻差が `h_A + h_B` 以下である対を、Tolerance_Window が重なる対として同一 Proximity_Cluster に連結する
4. THE Boil_Sync SHALL 窓の重なりによる連結を推移的に閉じ、各 Proximity_Cluster を窓の重なり関係の連鎖で到達可能な Running_Timer の極大集合とする。すなわち Timer A と B のオリジナル `endTime` 差が `h_A + h_B` 以下、かつ Timer B と C のオリジナル `endTime` 差が `h_B + h_C` 以下であれば、A と C のオリジナル `endTime` 差が `h_A + h_C` を超えても A・B・C を同一 Proximity_Cluster に含める
5. IF 2 つの Running_Timer A・B のオリジナル `endTime` の絶対時刻差が `h_A + h_B` にちょうど等しい、THEN THE Boil_Sync SHALL 当該 2 つの Running_Timer の Tolerance_Window が一点で接するものとして両者を同一 Proximity_Cluster に連結する（境界値を包含する）
6. IF 2 つの Running_Timer が窓の重なりの連鎖をいかにたどっても相互に到達できない、THEN THE Boil_Sync SHALL 当該 2 つの Running_Timer を異なる Proximity_Cluster に分離する
7. IF ある Proximity_Cluster に含まれる Running_Timer が 1 本のみである、THEN THE Boil_Sync SHALL 当該 Running_Timer に Adjustment 0 を割り当て、その Adjusted_Boil_Time をオリジナル `endTime` と等しく保つ
8. IF 調整対象の Running_Timer が 1 本も存在しない（Running_Timer 集合が空である）、THEN THE Boil_Sync SHALL いかなる Adjustment も生成せず、既存の Timer 集合を変更しない

### Requirement 2: 同時化の上限と Sync_Set への分割

**User Story:** 厨房スタッフとして、腕は 2 本しかないので一度に上げるのは 2 本までにそろえてほしい。窓が重なる茹で上がりが 3 本以上あっても現実に上げられる単位にまとめたいからだ。

#### Acceptance Criteria

1. THE Boil_Sync SHALL arms を 1 以上の整数（既定 2）として扱い、1 つの Sync_Set に含める Running_Timer 数を arms 本以下に制限する
2. WHEN ある Proximity_Cluster に arms を超える Running_Timer が含まれる、THE Boil_Sync SHALL 当該クラスタの Running_Timer をオリジナル `endTime` 昇順（オリジナル `endTime` が等しい場合は `seq` 昇順）で整列し、先頭から arms 本ずつ区切って複数の Sync_Set に分割する
3. WHEN ある Proximity_Cluster の Running_Timer 本数が arms の整数倍でない、THE Boil_Sync SHALL 最後の Sync_Set に残余（1 本以上 arms 本未満）を割り当てる
4. WHEN ある Proximity_Cluster に含まれる Running_Timer が arms 本以下である、THE Boil_Sync SHALL 当該クラスタの全 Running_Timer を 1 つの Sync_Set にまとめる
5. THE Boil_Sync SHALL 各 Running_Timer をちょうど 1 つの Sync_Set に割り当て、いずれの Running_Timer も重複または欠落なく分類する
6. WHERE ある Sync_Set が同期可能（Window_Intersection が空でない）で同期確定する、THE Boil_Sync SHALL 当該 Sync_Set に属するすべての Running_Timer へ単一の同一 Sync_Target を Adjusted_Boil_Time として割り当て、当該セット内の全 Running_Timer の茹で上がり時刻の差を 0 秒にする
7. IF arms が 1 未満・10 超過・非整数のいずれかの値に設定される、THEN THE Boil_Sync SHALL 既定値 2 を arms として適用し、分割処理を継続する

> **注（design への申し送り）:** バッチ membership（どの Running_Timer を同一 Sync_Set にまとめるか）をオリジナル `endTime` 昇順チャンク固定ではなく最適化対象に含めるかは、design フェーズで再検討する。本書では決定的既定として昇順チャンクを採る。

### Requirement 3: 共通時刻の決定（maximin 最適化・許容調整窓の絶対優先）

**User Story:** 厨房スタッフとして、3 本以上の窓が重なる茹で上がりは、腕が空く間隔をできるだけ均等に広くとって順に上げたい。ただし各麺の許容窓を超えてまで無理にそろえるのは困る。次のセットの準備に余裕は要るが、品質を犠牲にしてまでそろえてほしくないからだ。

#### Acceptance Criteria

1. THE Boil_Sync SHALL 各 Sync_Set の Window_Intersection を `[max_i(endTime_i − h_i), min_i(endTime_i + h_i)]`（セット内メンバー i ごとの許容半幅 `h_i`、`endTime_i` はオリジナル `endTime`）として求める
2. THE Boil_Sync SHALL ある Sync_Set を「同期可能」と判定する条件を、`max_i(endTime_i − h_i) ≤ min_i(endTime_i + h_i)`（Window_Intersection が空でない）こととする
3. THE Boil_Sync SHALL 同一クラスタ内の同期可能な Sync_Set 群の各 Sync_Target を、各 Sync_Target が当該セットの Window_Intersection 内にあるという制約を満たす割り当ての中から決定し、セット間隔の下限（最小インターバル）を課さない
4. THE Boil_Sync SHALL 制約を満たす Sync_Target 割り当てのうち、オリジナル `endTime` 昇順に並べた連続する確定 Sync_Set の Sync_Target 間隔の最小値を最大化（maximin）する割り当てを選び、窓が許す限り各セットを離して配置する
5. IF maximin を最大化する Sync_Target 割り当てが複数存在する、THEN THE Boil_Sync SHALL 決定的なタイブレーク規律により一意の割り当てを選ぶ（同一入力に対し常に同一の結果を返す。タイブレーク規律の具体は design フェーズで確定する）
6. IF ある Sync_Set が同期可能でない（Window_Intersection が空である）、THEN THE Boil_Sync SHALL 当該 Sync_Set を同期させず、当該セットのすべてのメンバーに Adjustment 0 を割り当て、それぞれの Adjusted_Boil_Time を各自のオリジナル `endTime` と等しくする（同期見送りは Window_Intersection が空の場合に限る）
7. WHILE ある Sync_Set が同期確定している、THE Boil_Sync SHALL 当該セットの各メンバー i の Adjustment を `Sync_Target − endTime_i`（`endTime_i` はオリジナル `endTime`）として割り当て、いずれのメンバーの Adjusted_Boil_Time も当該メンバーの Tolerance_Window 内（`endTime_i − h_i` 以上 `endTime_i + h_i` 以下）に収める

### Requirement 4: engine 内の符号付き調整時間と実効 endTime の射影（Adjustment を engine に閉じる）

**User Story:** 開発者として、調整機構を engine 内に閉じ込め、共有契約・ワイヤ・クライアントには Adjustment を意識させたくない。真実の源を一つに保ちつつ、クライアントは受け取った実効 `endTime` をそのまま使うだけで済ませたいからだ。

#### Acceptance Criteria

1. THE Boil_Sync SHALL 調整を engine 専用の Adjustment（オリジナル `endTime` に対する符号付きオフセット、初期値 0）として engine 内部に保持し、共有契約 `TimerFact`・ワイヤ・クライアントへ Adjustment フィールドを露出しない
2. THE Boil_Sync SHALL Timer→TimerFact 射影時に、各 Running_Timer の実効 `endTime` を Adjusted_Boil_Time（オリジナル `endTime + Adjustment`）として wire に載せ、`seq` を射影で削ぐのと同じ表現境界の一部として実効値を伝える
3. THE Boil_Sync SHALL いずれの Running_Timer i の Adjustment も `−h_i` 以上 `+h_i` 以下（`h_i = (オリジナル endTime_i − startTime_i) × Tolerance_Ratio`）に収め、当該範囲を超える調整を割り当てない
4. WHEN ある Running_Timer の現在時刻が当該 Running_Timer の Adjusted_Boil_Time 以上になる、THE Boil_Sync SHALL 当該 Running_Timer を茹で上がり（boiled）へ遷移させ、発火の基準をオリジナル `endTime` ではなく Adjusted_Boil_Time にする
5. WHERE ある Running_Timer の Adjustment が 0 である、THE Boil_Sync SHALL 当該 Running_Timer の実効 `endTime`（Adjusted_Boil_Time）をオリジナル `endTime` に等しくする
6. THE Boil_Sync SHALL 同期計算を engine の純粋変換（`decide` 配下）として行い、`storage.put`・broadcast・`setAlarm` を当該変換の内部で実行しない
7. THE Boil_Sync SHALL 各 Running_Timer i の Tolerance_Window を、engine 内部で不変に保つオリジナル `endTime_i`・`startTime_i` から `[endTime_i − h_i, endTime_i + h_i]`（`h_i = (オリジナル endTime_i − startTime_i) × Tolerance_Ratio`）として算出し、再計算のたびに当該不変のアンカーから Tolerance_Window を導出する（許容調整窓のアンカーは不変のオリジナル `endTime_i`、半幅は不変の `Boil_Duration_i` に基づき、Adjustment によって移動・伸縮しない）

### Requirement 5: サーバ計算と全端末への反映

**User Story:** 運用者として、調整はサーバで一度だけ計算し、すべての端末に同じ結果が出てほしい。端末ごとに別々の調整がされると現場が混乱するからだ。

#### Acceptance Criteria

1. THE Boil_Sync SHALL 同期調整をサーバ側で計算し、各クライアント端末は受信した実効 `endTime` をそのまま用い、Adjustment の再計算や独自算出をしない（そもそも Adjustment を受信しない）
2. WHEN Boil_Sync が新しい調整結果を確定する、THE Boil_Sync SHALL 確定結果を永続層（SSOT）へ書き込み、その書き込みが成功した後にのみ全端末へ broadcast する
3. IF 永続層への書き込みが失敗する、THEN THE Boil_Sync SHALL 全端末への broadcast を行わず、直前に確定した調整結果を保持し、SSOT を失敗前の確定状態に維持する
4. WHEN ある端末が再接続して状態を再取得（hydration）する、THE Boil_Sync SHALL 現在確定している実効 `endTime` を含む状態を当該端末へ反映し、再取得完了時点で他端末と同一の Adjusted_Boil_Time を持たせる
5. THE Boil_Sync SHALL すべての端末に対して同一の Adjusted_Boil_Time（実効 `endTime` の絶対時刻の値）を反映し、端末間で当該値を完全に一致させる
6. WHEN 一部の端末への broadcast が失敗する、THE Boil_Sync SHALL 当該端末の再接続時の hydration により確定済みの実効 `endTime` を再反映し、端末間の不一致を解消する

### Requirement 6: 調整パラメータのサーバ権威設定

**User Story:** 運用者として、許容調整割合・腕の本数（同時上限）を店舗設定として持ちたい。現場の運用に合わせて調整し、クライアントから勝手に変えられたくないからだ。

#### Acceptance Criteria

1. THE Boil_Sync SHALL arms・Tolerance_Ratio の 2 つを `StoreConfig`（サーバ権威設定）の値として参照する
2. THE Boil_Sync SHALL 既定値として arms を 2 本、Tolerance_Ratio を 10% とする
3. THE Boil_Sync SHALL 各調整パラメータの妥当域を、arms は 1 以上 10 以下の整数、Tolerance_Ratio は 1 以上 50 以下の整数パーセントと定める
4. IF `StoreConfig` の arms・Tolerance_Ratio のいずれかが未指定・非数・非整数・自身の妥当域外のいずれかである、THEN THE Boil_Sync SHALL 当該パラメータのみを当該パラメータの既定値へ畳み、妥当な他パラメータの設定値は保持したまま同期計算を継続する
5. WHERE クライアント端末が調整パラメータを受信する、THE Boil_Sync SHALL 当該パラメータを表示・導出にのみ用い、クライアント由来の変更要求を反映せず `StoreConfig` の確定値を使用し続ける

### Requirement 7: 集合変化時の再計算（追加・キャンセル・完了）

**User Story:** 厨房スタッフとして、調整した後に新しい麺を入れたり途中で取り消したりしても、そのつど正しくそろえ直してほしい。状況が変わるたびに整合が崩れると意味がないからだ。

#### Acceptance Criteria

1. WHEN 新しい Timer が開始され Running_Timer 集合が変化する、THE Boil_Sync SHALL 当該変化を処理する同一の `decide` 呼び出し内で現在の Running_Timer 集合全体に対して Proximity_Cluster・Sync_Set・Sync_Target を再計算し、各 Running_Timer の Adjustment を再計算結果で全体置換する
2. WHEN ある Timer がキャンセルされ Running_Timer 集合から除かれる、THE Boil_Sync SHALL 当該変化を処理する同一の `decide` 呼び出し内で残りの Running_Timer 集合全体に対して再計算し、各 Running_Timer の Adjustment を再計算結果で全体置換する
3. WHEN ある Running_Timer が Adjusted_Boil_Time 到達により茹で上がり（boiled）へ遷移する、THE Boil_Sync SHALL 当該変化を処理する同一の `decide` 呼び出し内で当該 Timer を以後の調整対象から除外し、残りの Running_Timer 集合全体に対して再計算し、各 Running_Timer の Adjustment を再計算結果で全体置換する
4. WHEN 再計算の結果ある Running_Timer がいずれの Sync_Set にも同期確定されなくなる（他と窓が重ならない、または Window_Intersection が空で同期見送りとなる）、THE Boil_Sync SHALL 当該 Running_Timer の Adjustment を 0 に戻し、当該 Running_Timer の実効 `endTime`（Adjusted_Boil_Time）を当該 Timer 本来のオリジナル `endTime` と一致させる
5. THE Boil_Sync SHALL 同一の Running_Timer 集合（同一の `startTime`・オリジナル `endTime`・`seq`）・同一の調整パラメータに対して、入力の列挙順に依存しない一意の決定的な再計算結果（maximin 最適解と決定的タイブレークによる一意の Sync_Target 割り当て）を生成し、かつ同期計算を 2 回適用した結果を 1 回適用した結果と一致させる（再計算は安定で冪等である）
6. WHEN 再計算により調整結果が変化する、THE Boil_Sync SHALL 変化後の確定結果を永続層へ書き込んだ後に全端末へ broadcast する
7. IF 再計算の結果が直前の確定結果から変化しない、THEN THE Boil_Sync SHALL 永続層への書き込みと broadcast のいずれも行わない
8. IF 再計算後の確定結果の永続層への書き込みが失敗する、THEN THE Boil_Sync SHALL 直前に確定した調整結果を保持して broadcast を抑止し、後続の hydration により確定結果を回復する

### Requirement 8: 再計算の計算量と実行頻度の前提（非機能）

**User Story:** 運用者として、同期計算が現場の規模で軽量に収まることを保証したい。DO 内のイベント処理が重くなって発火や broadcast が遅れたり、待機中に資源を浪費したりすると困るからだ。

#### Acceptance Criteria

1. THE Boil_Sync SHALL 同時に走行しうる Running_Timer 数の上限を、スロット（釜）数（既定 unitCount=3 × 6 = 18 程度、運用上も数十オーダー）に基づく有限値として扱い、当該本数を再計算の入力規模 n の上限とする
2. THE Boil_Sync SHALL 同期計算（Proximity_Cluster・Sync_Set・Sync_Target の算出）を start・cancel・boiled の離散イベントを処理する `decide` 呼び出し時にのみ実行し、イベント間は同期計算を行わず hibernation を妨げない
3. THE Boil_Sync SHALL 同期計算を 1 回の `decide` 呼び出し内で完結させ、`setInterval`・`waitUntil`・外部 await を用いて計算を継続的に抱えない
4. THE Boil_Sync SHALL 1 次元時間軸上の maximin 最適化を、入力規模 n（数十オーダー）に対して多項式時間（目安として O(n log n) 以上 O(n²) 以下）で完了させる（具体アルゴリズムと計算量上限の確定は design フェーズで行う）
