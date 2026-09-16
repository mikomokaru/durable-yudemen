# タスク2.1：固定問題の cloud 輸送検証計画

**2026-09-10後続の現在地：件数差の許容承認と再照合を経て2.1完了。** [初期配備記録](./transport-bootstrap-cloud-20260910.md)のとおりsolver・TSのみのshimを作成したが、ログ取得APIの403により停止中。アプリ・合成レコード・有効manifestは未変更。下記の承認待ち／未配備の記述は履歴。現時点の配備版・残送出枠・未検証は初期配備記録を正本とする。

**最新状態（2026-09-10）：配備差分で確定した8項目の投入承認を受領。ただし配備前再照合でアカウント全体のDO namespace件数が12→11となったため、未配備で停止中。** 対象DO2件・稼働版・既存取得範囲の設定は一致。[承認と再照合記録](./cloud-approval-20260910.md)を現在の状態の正本とする。2.2はローカル準備完了、2.1は差異の扱いの確認待ちで未完了。以下の「未承認」「2.2未完了」は各時点の履歴であり、後続記録で更新されている。復帰順序・bindingの扱いは[配備差分](./deployment-diff-20260910.md)を参照する。

状態：**cloud変更5項目の明示承認待ち、2.1未完了**（2026-09-09・J-1訂正、09-10・第5項追加）。以前は「では、次にいきましょう」を変更範囲・費用の承認と解釈して2.1を完了にしたが、その記録を取り消す。継続指示・命名承認を、実利用者が使うWorkerの再配備や新規リソース作成・費用枠の承認へ転用しない。配備・店舗作成・cloud求解は未実施。2.2は[shim接続のローカル検証](./transport-shim-local-20260910.md)まで実施済みで、その成果は保持するがcloudの変更許可・2.2完了・2.5合格とはしない。F-1（3.1）も独立して明示承認待ち。

**投入時期はkeep right（2026-09-09・ユーザー方針）。** 先に2.2のローカル実装・検証、配備差分・復帰手順を揃える。以後、下記5項目の承認はその準備が完了し、次が実投入となる時点で初めて依頼する。いまの承認未取得は、ローカル準備を止める理由でも、継続指示をデプロイ承認へ読み替える理由でもない。実cloudでしか確認できない2.5の輸送成立を、3.2以降の前提とする設計は変えない。

2026-09-10追加：[実loopback HTTPの検証と完全性境界](./transport-loopback-local-20260910.md)。ローカルの認可・拒否15件と正例2件を確認した。ブラウザ動作・永続台帳・private合成操作／WS入口は未検証または未実装で、2.2は引き続き未完了。

投入直前に明示承認を求める項目（すべて未承認。現時点での承認依頼ではない）：

| 項目 | 承認対象 |
| --- | --- |
| 1. 新規solver | 非公開 `yude-men-cpsat-planner-dev` を新規配備する |
| 2. 現行アプリの再配備 | **`timer-dev.yamaokaya.org` を配信中の `yude-men-timer`** にprivate検証入口を追加して再配備する。通常計画器はTSのまま、probeは下記4合成店舗に限定し、既存認証を維持する。終了時は確認済み版へ戻す |
| 3. 合成レコード作成 | Provisioning APIでチェーン `cpsat-transport-20260909` 1件、店舗 `cpsat-transport-20260909-01`〜`04` の4件を新規作成する。既存IDを上書きせず、終了時に店舗を非活性化し、レコードは残す |
| 4. 追加費用 | 本計画の回数・期間・停止条件内で追加費用US$20を予算とする。課金のハードキャップではない |
| 5. 通常TS経路へのshimの影響 | **2026-09-10追加。** 共通SOLVER bindingの変更によりshimを経由する店舗・到達経路の範囲、TS転送の遅延・失敗・追加費用、変更前後のbindingと復帰方法を明示確認する。TSを選び続けることを経路無変更の証拠にしない。型・CPU・観測設定と同様に投入条件とし、未確定なら投入しない |

5項目を明記したユーザー回答を得てから承認記録と2.1の状態を更新する。承認後も第6節の配備直前の再照合を省かない。

## 1. 確認した配備対象

[秘匿値を除いた取得結果](./cloud-targets-20260909.json) は 2026-09-09 12:10:55 UTC の読み取り調査終了時点。Cloudflare API の一覧はページ情報も保存した。アカウント内の zone は1件、custom domain は8件、DO namespace は12件で、対象 Worker に関係する行のみ記録した。これらの設定取得と、指定した合成店舗候補の管理API GET以外の業務経路には要求していない。

| 項目 | 実環境の事実 |
| --- | --- |
| アカウント | Yamaokaya / `305d89a643ac689b4204454c5493cbde` |
| 対象ドメイン | `timer-dev.yamaokaya.org` → `yude-men-timer` / environment=`production` |
| 同居する到達経路 | 同 Worker の `yude-men-timer.yamaokaya.workers.dev` と preview URL が有効。対象 Worker を指す他の custom domain・zone route は今回の全件取得には無かった |
| アプリ現稼働版 | `be146588-b3f0-4f54-9134-f5baf744d8fd`、100%、2026-09-09 07:20:35 UTC 配備 |
| アプリ deployment | `6cdfed3e-5b87-49c5-b549-b091eb4f0991` |
| StoreTimerDO | `a3ac2d321837499188ee9cb979a4efdc`、SQLite backend |
| StoreRegistryDO | `cedc7e2c44b44c828c1a96a37eee5702`、SQLite backend |
| 現在の solver binding | `SOLVER` → `yude-men-solver` / production。`CPSAT_SOLVER` と `PLANNER_BACKEND` は稼働設定に存在しない |
| TS solver 現稼働版 | `e134e93b-1208-452f-847f-cbf344777119`、100%。同じ StoreTimerDO namespace へ callback。workers.dev／preview は両方無効 |
| CP-SAT solver 候補 | `yude-men-cpsat-planner-dev` は settings／subdomain／deployments の全てが404、code=10007。今回新規配備になる |
| 認証 | アプリ `ACCESS_REQUIRED=1`。`ADMIN_TOKEN`・`ORDER_INGRESS_TOKEN` は secret binding として存在。既存 ADMIN_TOKEN による `/admin/chains` GET は200。Access policy 自体の監査や WS の認可試験は未実施 |
| 実CPU設定 | app／TS solver とも `usage_model=standard`、settings と app の version view に `limits.cpu_ms` の明示値無し。無制限とは読まない |
| ログ | app／TS solver とも enabled、head sampling=1、invocation logs=true、persist=true。traces=false、logpush=false、tail consumers=[] |
| その他 | compatibility date=`2026-06-26`、flags=[]。`OBSERVE_DEBUG=0`、`OPERATION_HISTORY_ENABLED=0` |

現行版の `wrangler versions view` では migration tag=`v2` と既存の assets 配線も確認した。版IDは復帰候補の指定であり、ローカルHEADと配備バンドルの同一性を証明するものではない。snapshot のスキーマ版とも別物である。

**domain の `dev` という名前は namespace 分離の証拠ではない。** 今回 app を更新すると、この Worker 全体と、そのコードを共有する既存 DO に影響する。UI／POS／管理／WS の既存経路も同居するため、固定店舗の限定だけでデプロイの影響までゼロとは主張しない。

ローカル `wrangler.jsonc` の `ACCESS_REQUIRED=0` と Access のプレースホルダを配備してはならない。既存の実値・secret・TS binding・assets・migration・公開範囲を維持した明示的な配備設定を作り、dry-run と配備前後の読み取りで照合する。既存WIP全体をそのまま deploy しない。

K-2対応（2026-09-10）：root `wrangler.jsonc` に先行して入っていた `CPSAT_SOLVER`／`PLANNER_BACKEND` と、Vitest側のCP用503代役を撤去した。root設定はHEADと同一。ローカルprobeのbinding型は `experiments/cpsat-workers/transport/wrangler.types.jsonc` から独立生成する（配備名・入口なし、接続先はハーネス内の `solver`）。実際の接続はMiniflareに直接渡し、cloudの候補Workerを参照しない。cloud用bindingは5項目の明示承認とsolver配備を経て、上記の個別配備設定に導入する。型生成用設定も既存WIPのsolver設定も、このまま投入するための承認済み成果物ではない。

## 2. 承認を求める変更範囲

店舗の系列はmanifestで固定する。01・02は直接probe専用、03・04は既存Effect→shim刺激専用であり、それぞれ小問題・難問題を割り当てる。各系列は異なるstoreRefを持つため、既存集計器のscope／1分窓を共有しない。過去の全4店舗直接probeの記録を新しい割当の証拠へ読み替えない。

shimのローカル実装は対象外店舗の要求をTSへ1回転送するが、経路の同一性を保証しない。routingの本文読出しに1 MiB上限とUTF-8／JSON／storeId検査が増え、shim自身の例外・CPU・遅延も新たな失敗点となる。cloud配置・この影響の評価・binding復帰の実確認は未実施であり、上表第5項の承認前に配備差分へ具体化する。

1. `yude-men-cpsat-planner-dev` を新規配備する。routes無し、workers.dev=false、preview_urls=false。CPU上限を **10,000 ms** と明示し、単一の frozen-clock WASM instance を使う。StoreTimerDO callback は上表の namespace のみ。過去の PoC／search Worker と TS solver は変更しない。
2. `yude-men-timer` に private な検証入口と固定問題への限定配線を接続する。2.2は案Aとし、StoreTimerDO本体を変更せず、既存SOLVER bindingの先の輸送shimで、許可した合成店舗の状態変更・Persist先頭から送られたPlanRequestを固定問題に向ける。固定輸送のH2／H3を観測し、H1の実shell接続はタスク3へ残す。通常店舗の計画器はTSのままとするが、共通bindingの変更でshimを経由する影響は配備差分として別途確認する。`Replan`、要求単独列、オンライン業務モデル、CP計画の採用は入れない。
3. 新規の合成チェーン `cpsat-transport-20260909` と、合成店舗 `cpsat-transport-20260909-01`〜`04` の4件だけを既存 Provisioning API で作る。チェーン一覧の候補一致0件、店舗個別GETは4件とも404と確認済み。作成直前にも未登録を確認し、衝突なら上書きせず停止する。storeCode無し、空の実利用者 roster、他チェーン・既存Policy・実注文をコピーしない。テスト専用の設定・注文・Timerのみを投入する。
4. 終了時に合成店舗を非活性にし、通常操作でテストTimerを終了させ、接続を閉じる。試験レコードは証拠として残す。既存店舗の snapshot 巻戻し・削除、DO namespace の再作成、既存チェーン／Policyの更新は行わない。
5. 観測の取得に既存 Workers Logs を用いる。新しい Tail Worker・Queue・R2・外部送信先は作らず、Operation History も有効にしない。ログ取得不能を回避するための新基盤追加は別途確認する。

private 入口の構成案は、loopback の検証ドライバ → Wrangler の認証済み remote **service binding** → app の named entrypoint → 実 StoreTimerDO → 既存 `SOLVER` binding → 輸送shim → 固定solver／202／waitUntil → 同じ StoreTimerDO の `deliverPlan`。直接probeはappの `CPSAT_SOLVER` bindingからsolverへ送り、engine生成に数えない。ローカル部分は刺激・観測のみで、求解と評価対象のDO処理はcloud上で行う。

2026-09-10・案Aの影響範囲：shimは既存PlanRequestを受けるが、decisionId・effectIndex・Persist親は受け取れない。H1の実測値を作らず、固定要求の観測はprobeとして、直接probeとの違いを試験系列側に記録する。通常店舗も共通SOLVER bindingの変更でshim経由になり得るため、TS転送の維持だけで「配備の影響なし」としない。shimの配置、経由先・認可・障害／遅延・費用・復帰の差分を準備して投入前に確認する。新しいWorker／namespaceを暗黙に追加せず、root設定も準備中は変更しない。[方針と限定](./transport-provenance-local-20260910.md)。HTTP bindingで受信先を差し替える機構は[公式資料](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/)を参照し、実配置での成立は2.3〜2.5で検証する。

remote service binding は公式の対応表と導入済み Wrangler 4.105.0 の schema（`service`／`entrypoint`／`remote`）で確認した。DO を直接 remote binding にする方式は採らない。[対応表](https://developers.cloudflare.com/workers/local-development/bindings-per-env/)、[remote bindings](https://developers.cloudflare.com/workers/local-development/#remote-bindings)。named entrypoint の接続・認可をまずローカルで検査する。remote 接続が既存 Access 方針等で成立しない場合、方針を緩めたり公開URLへ迂回せず停止して確認する。

入口は固定の店舗・問題・操作・試行上限・有効期限のmanifestに閉じ、任意店舗／任意モデル／任意callback URLを受け付けない。loopback側も実行ごとの認証とOrigin検査を行う。外向きdefault fetchや `/admin/*` へ新しい求解ルートを足さない。WS試験のidentityは private な試験経路から当該合成店舗だけへ渡し、実利用者のAccess認証や既存rosterを変更しない。想定外の店舗へのアクセスが1件でも見つかったら停止する。

命名承認済み（2.2着手時点では未実装）：

| 名前 | 境界 |
| --- | --- |
| `CpsatTransportProbe` | app の named entrypoint。固定問題の輸送検証だけを提供し、通常の計画APIではない |
| `CPSAT_TRANSPORT_PROBE` | ローカル検証ドライバから上記入口への remote service binding |
| `CPSAT_SOLVER` | appから非公開CP-SAT Workerへのbinding。作業ツリーの既存候補名を流用する |
| `toCpsatTransportRequest` | 2026-09-10追加承認。呼出元の認可結果・由来と生の要求を照合し、固定輸送要求へ変換。不一致はnull。期限窓の判定は畳まない |
| `dispatchCpsatTransportRequest` | 2026-09-10追加承認。期限を送出直前に再検査し、solver bindingへ1回送って送出・結果を観測する。再試行・代替URL・TS fallbackなし |

その他の公開型・メッセージ名が必要なら、実装前に追加確認する。試験用の入口やmanifestを本機能の永続契約に転用しない。

旧候補 `readCpsatTransportProbe`／`dispatchCpsatTransportProbe` は採用しない。`Probe` は共有処理でなく入口名に限定する。今回の2関数の命名・実装承認は、cloud変更5項目やF-1の承認を代替しない。

2026-09-10ローカル準備の追加：[private app経路の検証](./transport-app-local-20260910.md)。上記3名を使い、直接probeから実WASM・実StoreDO callbackまで接続した。認可・負例・通常TS経路もローカル確認済みだが、既存Effect配線・privateな合成操作／WS入口・全送出台帳・配備差分の準備は未完了。2.1の5項目を承認済みへ戻すものではなく、まだ投入承認を求める段階ではない。

## 3. 試験前に固定する条件（承認案）

同日後続：[shim接続のローカル検証](./transport-shim-local-20260910.md)により、既存Effectから固定問題への配線は接続済みとなった。privateな合成操作／WS入口、実loopback認可、全送出台帳と上限・停止条件、配備差分／復帰準備は残る。投入前の5項目はすべて未承認のまま。

固定protobufは2.2で2個だけ選び、cloud試験前に入力ハッシュ・期待結果・native参照結果をmanifestへ記録する。小問題は最適値既知、負荷問題は探索量で停止するものとし、TS業務モデルの実装は前倒ししない。seed=1、num_workers=1。deterministic-time予算は小問題 **0.01**、負荷問題 **0.14** とする。これは実時間の秒数ではない。条件変更は同じ試験の成功扱いにせず計画を改版する。

使う成果物は [WASM流用ガイド](../../../../experiments/cpsat-workers/WASM_REUSE.md) の fork `e1453348bc43d3b0afc0c2e5a535f5c9b45326f4`／Emscripten 4.0.20。WASM SHA-256=`c8b89a734a15ad067e18edd08fc58d179aff63bf9922080e75fbeeecfb0223a1`、生成JS=`9aa103e134a4dcc5810a589dc008dc5b1c3f4d46114df05e08f4799f2b97eda8`。2.2で両方を再照合する。今回再ビルドは前提にしない。

| 系列 | 予定件数・条件 |
| --- | --- |
| 初期化 | 新solver instanceでの初回2件を目標。初期化ログで確認し、warmをcoldと数えない。未観測なら不足扱い |
| 小問題 | 正常系8件、逐次 |
| 連続求解 | 負荷問題20件、逐次。同じinstanceの連続列を確認し、再初期化・memory growthも記録 |
| 状態変更経路 | 4店舗で各1系列。注文到着→Persist→要求の実送出、Timer開始／完了・取消と通知を既存入口で確認 |
| 並列投入 | 4件同時×4組＝16投入。無限キューを作らず、busyは独立した結果。accepted件数とsolve件数を一致と仮定しない |
| DO復帰 | 4試行。WS保持・無操作区間を挟み、同じDOのinstance交代と状態の維持を確認。idle待ちは各最大60秒・最大4回。交代なし／原因不明をhibernationと偽らない |
| 呼出元切断 | 負荷問題2件。実際の切断と全waitUntil終端を照合 |
| 負例 | 形式不正／許可外宛先等4件。solver未開始・業務副作用なしを検査。資源枯渇を意図的に起こす試験は含めない |

予定系列から生じる追加要求、初期化確認、計測準備、再送も含め **solverへの全送出試行128件まで、同時投入4件まで**。上の予定件数は128件への追加枠ではない。engineの副次的な要求も事前に数え、残枠が無ければ次の操作を投入しない。ドライバが再起動しても消費済み枠を引き継ぐローカル試験台帳を用いる（本機能の要求管理とは別）。不足を埋める自動の無限再試行はしない。

検証ドライバの業務操作は **512件**、試験由来のDO呼出・Alarm等の観測件数は **2,000件**、観測行は **20,000行**を上限とする。超過・不明なら新規投入を停止する。cloud実行枠は初回probeから **2時間**、通常試験投入は90分で止め残りをログ回収・終了確認へ充てる。無制限poll・Cron・常駐待機は追加しない。

appの配備は試験版1回＋復帰、solverは初期化確認用を含む試験版最大2回＋終了用の非公開停止版まで。同じWASMを使う。appを繰り返し配備してDO復帰の件数を作らない。冷起動／復帰が枠内で確認できなければ、対象不足として停止する。

## 4. 判定・停止条件

台帳の完全性境界：shim側はreceipt→request-dispatched→dispatch-resultから先を照合する。実shellはSOLVERのHTTP応答を読まずbinding例外も握るため、DO→shim間の欠落をこの列で検出できない。さらに現receiptは形式・店舗・期限検査後に出るので、それ以前の拒否も観測外である。「業務状態が変わったN件→M件送った」を完全な実測対応として報告しない。合成操作からの期待送出数は**推定**として別欄に置き、推定と観測が合ってもH1の代替にしない。予約した試行枠と、観測した実送出件数も別の値である。receiptだけがある場合も、未送出とログ欠測を観測だけで断定せず未照合として停止・調査する。H1の実接続は3.5以降で行う。

- **waitUntilの必要余裕は全正常例で10,000 ms以上**。応答送信／切断→全waitUntil終端の消費が20,000 ms以下、またはその消費の検証済み上界が20,000 ms以下であること。初期化・固定入力読出し・復号・検証・callback戻り・解放を含める。handler終了までの時間、観測ログが最終的に届いた時刻、過去実験の6.49秒を代用しない。[30秒の枠の定義](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)
- solverの設定CPU上限10,000 msを配備後にGETで確認する。プラットフォーム観測CPUが正常例で **8,000 msを超えたら停止して予算を見直す**。app／TS solverの明示CPU設定は現状未指定なので、公式のStandard HTTP既定30,000 msを参照値として区別して記録する。設定・CPU実測・探索量の3つを混同しない。CPU超過は例外的猶予で完了しても正常判定にしない。[CPU limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)
- WASM線形メモリは最大96 MiB。isolate全体128 MBとは別欄とする。cloudで全体メモリの数値が取得不能なら理由を残し、WASM値で埋めない。プラットフォームのmemoryエラー／trap／未終端を合格にしない。isolate数値の欠測については「数値による全体余裕は未検証」と限定し、資源エラー・終端の観測まで欠けるならゲート不成立とする。[Memory limits](https://developers.cloudflare.com/workers/platform/limits/#memory)
- 受理が求解完了より先に戻ることと、同じ店舗の独立した既存操作が求解中に完了・通知されることを照合する。単に202を返した、callbackだけが遅かった、別店舗が応答した、では合格にしない。負荷問題でプラットフォームCPU **250 ms以上** の求解を少なくとも4件含め、その間の操作進行を確認する。時計の分解能・跨るinvocationの対応が不十分なら欠測扱い。実求解の短さをsleepで補って成立とはしない。
- callbackは呼出開始ではなく `await deliverPlan` の戻りを記録する。CP envelopeはトップレベルにslices無しで、通常計画として採用・Persist・Broadcastされないことをローカルとcloudで確認する。通常の操作によるPersist／Broadcastは別に数える。
- 通常例の例外、CPU／メモリ／時間枠超過、応答欠落、誤宛先、実店舗の異常、ログ対応の欠落、予算超過見込みを見つけたら即座に新規投入を止める。busy等の予定負例を成功求解へ数えず、正常系列と分ける。
- sampling=1だけで取得の完全性を主張しない。2のゲートではプラットフォームinvocation結果、shim到達・固定要求H2／H3、台帳の投入、取得時間範囲を照合し、部分export／重複／遅延を表現する。H1は実shellで未計測と記し、合成fixtureを実測ログへ混ぜない。3計数口の実接続・稼働頻度の最終検証は3以降に残す。計測経路・期間が不明なら2.5は合格にしない。全waitUntilを覆う区間が取得できなければdesign §9へ戻す。

これは固定問題の輸送ゲートであり、オンラインモデルの正しさ・最適係数・厨房での性能目標を定める試験ではない。task7.1の本評価閾値やP1〜P16の後段試験を置き換えない。

## 5. 費用枠（承認案）

**試験による追加費用の予算をUS$20、実行量を上記の固定上限内**とする。既存契約の月額・他トラフィック・税・為替は除く。これはCloudflareに設定する課金のハードキャップではない。公開単価による予算であり、Enterpriseの個別契約と当月残枠は未確認。実行前に別単価が判明したら予算を再確認し、未知の料金をゼロ扱いしない。

参考の比例計算では、solver 128件×10,000 CPU msは **$0.0256**、Worker要求2,000件を全て別途計上しても **$0.0006**。合成4 DO＋Registryの5 DOが2時間ずっと課金対象であった場合は、5×7,200秒×0.128 GB＝4,608 GB-s、比例値 **$0.0576**。追加ログ20,000行は **$0.012**。appや読書き等は別であり、これらだけを請求額の上限とはしない。[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)、[Workers Logs pricing](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing)

特にDOの公開資料は、月次含有枠の超過分を課金単位へ切り上げるとしている。durationが次の100万GB-sの境界を越える場合は$12.50単位となるため、「少量なので請求も必ず数セント」とは報告しない。DO request／SQLiteの読書き・保管も別料金である。$20はこの不確実性への予算余地で、正確な請求額保証ではない。試験前に公開単価での保守見積りが$20以内に収まることを確認し、収まらなければ開始しない。[DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

実行中は残送出枠と観測使用量で新規投入を制限し、見積り超過／観測不能なら停止する。月次請求反映待ちの値をリアルタイム残予算と呼ばない。非活性の合成レコードは保管費が残り得るため、保存量と保管継続を引渡しに明記する。削除は別途承認する。

## 6. 復帰・配備前の最終確認

1. ローカルで試験専用差分のテスト、全経路の認可、旧CP envelope棄却、固定問題、観測の非空振りを確認する。既存WIP由来の静的検査3件はJ-3で旧採用経路を切り離して解消済み（[基準状態と再検証](./implementation-baseline.md)）。配備差分に対して改めて検査し、過去のgreenを将来の配線変更へ流用しない。
2. 配備直前に本inventoryを再取得する。app／TS solver版・DO ID・Access設定・対象IDの空き・公開範囲が変わっていたら停止する。現稼働版のバンドル／設定と今回の差分を特定し、秘密を含まない版・ハッシュを残す。ローカルHEADが同じだけでは十分でない。
3. 上記5項目の明示承認後に初めてsolver・appのcloud配備、合成店舗作成、cloud求解を行う。既存のローカル実装・検証はこの承認の代わりにならない。実値のAccess設定を維持し、通常のUI／WS／POSとTS計画は変更しない。試験manifestの期限・ハッシュ・入力・最大件数を配備前に固定する。
4. 異常時／試験終了時は投入停止→試験Timer終了・WS切断→合成店舗非活性→app復帰を基本とする。実店舗への影響があればapp復帰を優先し、試験の後始末のために遅らせない。起動中のsolverは停止指示で強制キャンセルできるとはせず、有限予算と終端ログを追う。
5. 復帰候補は `be146588-b3f0-4f54-9134-f5baf744d8fd`。既存 namespaceと業務データはそのまま。コマンド候補は `pnpm exec wrangler rollback be146588-b3f0-4f54-9134-f5baf744d8fd --name yude-men-timer`（**未実行**）。旧版への読書き互換は試験差分で確認し、version rollbackに含まれない設定もGETで照合する。初回配備のCP solverには復帰先旧版が無いため、終了用の非公開停止版を配備して任意求解・callbackを受けない状態にする。削除は行わない。
6. 復帰後も実際の注文・完了・取消の事実は巻き戻さない。遅着CP envelopeが無効果であることと、実Access設定・既存TS binding・公開経路が復帰前と同じことを確認する。

再現用の読み取りコマンド（最初に既存Wrangler認証を `pnpm exec wrangler whoami --json` で確認。出力に個人情報があるため共有記録は選別する）：

```sh
node tools/observe/cpsat-targets.mjs /path/to/existing/application/.dev.vars
pnpm exec wrangler deployments list --name yude-men-timer --json
pnpm exec wrangler versions view be146588-b3f0-4f54-9134-f5baf744d8fd --name yude-men-timer --json
```

inventoryスクリプトはGETのみ、既存OAuth／API tokenと指定ファイルのADMIN_TOKENだけを使い、値を出力しない。任意URL・solver呼出・cloud書込みは実装していない。管理ファイルを省略するとadmin欄はnullとなり、対象の空きを確認したことにはならない。今回このworktree直下には `.dev.vars` がなく、同一repoのmain worktreeにある既存ファイルを読み取り使用した（コピー・変更なし）。過去の同日取得結果を、配備直前の再確認へ代用しない。

今回のローカル確認：inventoryの構文検査・対象ファイルのoxlint／oxfmt、実API GETによる14件＋管理GET5件、本文の相対リンク検査、40小タスク／40本のRequirements行／80 AC被覆の維持を確認。アプリのコード・配備設定はこの作業では変更していないため、アプリ全体のテストやcloud輸送試験を実施したとは扱わない。
