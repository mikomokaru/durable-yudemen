# 固定 protobuf の輸送検証（task 2.2、実装途中）

**2026-09-10最新状態：2.2のローカル準備は完了。** 承認後に非公開solverの無効初期版とTSのみのshimをcloud配備し、remote service bindingの拒否応答を確認した。Workers Logs queryの403で停止中。アプリは未配備、WASM求解・named entrypointのremote接続・2.5は未検証。[現在地・実行コマンド・残予算](../../../.kiro/specs/cpsat-planner-integration/verification/transport-bootstrap-cloud-20260910.md)を参照。下記はローカル実装各段階の履歴を含む。bootstrap設定で有効manifestへ切り替えたり、承認済みの128件を新しい台帳で満額取り直したりしない。

既存の [WASM 流用ガイド](../WASM_REUSE.md) のバイナリ・生成 JS を**変更せず**、汎用 ABI（case 3）に固定問題を渡す。業務モデル・オンライン codec・計画採用の実装ではない。

2026-09-10 時点では直接probeと、実StoreTimerDOの既存Effect→SOLVER bindingのshim→固定solver→実DO callbackをローカル接続済み。privateな合成操作／WS入口、再起動横断の上限台帳付き cloud ドライバはまだ接続していない。task 2.2 のチェックは付けず、2.5 の合格にも使わない。クラウド配備・実環境の合成店舗作成・cloud 求解は未実施。

続いて[実loopback HTTPの検証](../../../.kiro/specs/cpsat-planner-integration/verification/transport-loopback-local-20260910.md)を追加した。実TCPで拒否15件・private bindingへの正例2件を確認。ブラウザのCSRF／CORS／PNA動作は未検証であり、永続送出台帳も未実装のまま。

[案A](../../../.kiro/specs/cpsat-planner-integration/verification/transport-provenance-local-20260910.md)を[shimの実装・検証](../../../.kiro/specs/cpsat-planner-integration/verification/transport-shim-local-20260910.md)へ進めた。src/shellは無変更、DOサブクラスなし。H1・由来IDの実shell接続はタスク3で行い、2.2では合成fixtureと分離して「engine生成は未計測」とする。shimが作る固定要求はprobeの記録であり、元のPlanRequestの生成観測を捏造しない。

manifestの01・02は直接probe専用、03・04はshim刺激専用。各系列で小問題・難問題を1件ずつ割り当てる。直接入口はshim店舗を拒否し、shimはshim店舗以外のPlanRequestをTSへ転送するため、CP観測のstoreRef scopeが混ざらない。過去の全4店舗直接probeのレポートはその時点のmanifestで読み、新しい系列の証拠と混ぜない。

`shim.ts` は既存PlanRequestの外形と許可店舗を照合し、問題・予算・宛先をmanifestから再構成して既存の固定要求検査を通す。注文本文はCPへ渡さない。到達記録は観測schemaと別の `shimReceipts` 欄へ収集する。通常TS転送にも1 MiB上限・UTF-8／JSON検査と追加経路の失敗・遅延が生じるため、[投入前の第5承認項目](../../../.kiro/specs/cpsat-planner-integration/verification/cloud-transport-plan.md)で別途確認する。root設定は変更しない。

完全性境界はshimの入力・店舗・期限検査後のreceiptから先。実shellはSOLVERのHTTP状態を読まず例外も握るので、DO→shimの欠落やreceipt前の拒否はこの列では見えない。合成操作からの期待送出件数は推定として実測と分ける。`transportCoverage` にこの境界と永続台帳未実装を記録する。receiptだけの対も未送出とログ欠測を断定せず、未照合として扱う。

## 成果物と境界

- `generate_fixtures.py`：オフライン専用。OR-Tools 9.15.6755 で固定モデルと native 参照を生成する。
- `fixtures.json`：固定2個の protobuf（base64）・SHA-256・探索予算・native 参照。オンライン入力から任意モデルを受け取らない。
- `solver.ts`：Workers 用。C++ WASM の frozen-clock instance を遅延初期化し、最大1要求を callback 戻りまで保持する。Node/Python/業務モデルは import しない。
- `manifest.json`：許可済み4合成店舗と版の固定。**チェックイン状態は `enabled=false`・期限0で、求解できない。** 本ファイルだけを有効にして deploy する手順は提供しない。
- `check-local.mjs`：Wrangler が依存する Miniflare/workerd・esbuild を使うローカル試験。Node は刺激・検証・集計だけで、WASM をインスタンス化しない。manifest はメモリ内のビルド差し替えで2分間だけ有効にする。
- `app.ts`：承認済みの named entrypoint `CpsatTransportProbe`。既存 public handler／DOをそのまま再exportする試験専用bundleで、rootの `src/worker.ts` や配備設定にはまだ接続しない。POST `/plan` の直接probeだけ。run token・Origin・期限・版・固定店舗／問題を検査し、binding呼出直前に実送出を記録する。呼出元の意図行を実送出として二重に数えない。
- `request.ts`：承認済みの `toCpsatTransportRequest`／`dispatchCpsatTransportRequest`。共有するのは入口名ではなく輸送試験の要求。前者は信頼する呼出元が渡した認可結果・由来情報と、本文のスキーマ・固定店舗／問題・版を照合し、不一致ならnull。後者は期限述語を送出直前に評価し、bindingへ1回送り、送出と結果を記録する。認可済みの本文を受け取っただけでは送出期間内とみなさない。
- `wrangler.types.jsonc`：上記probeのbinding型だけを生成するローカル専用設定。`CpsatTransportProbeEnv` はこの設定から機械生成し、rootの `Env` へCP-SAT bindingを追加しない。`name`・`main`・assetsを持たず、配備先／配備入口を定義しない。接続先 `solver` はハーネス内のMiniflare Worker名であり、cloud上のWorker名ではない。
- `check-app-local.mjs`：実アプリ／Registry／StoreTimerDOをローカルで束ね、既存Provisioning APIで合成4店舗を作る。実WASMからそのDOへのcallbackまで通す。`pnpm test` のtools projectからも実行する。TS solverは202の代役、CP solverは実WASM。cloud用ドライバではない。

`solver.ts` の受け口は POST `/plan` の既存 `CpsatObservation`（`cpsat.request-dispatched`）に閉じる。共通parserが `probe／origin=probe／親null` または `live／origin=engine／親非null` の対応を検査し、app／solverは `fake` を拒否する。body はストリーム読出し中も16 KiB以下、問題・予算・版・店舗参照を照合する。許可された model hash から固定 protobuf を選び、storeRef は manifest の固定 DO 名へ写す。任意モデル・callback URL・注文は受け取らない。

callback は `cpsat/v1` の**試験用** envelope（トップレベルに `slices` なし）。オンラインの応答契約として再利用しない。`runtime` 欄はこの試験の初期化・線形メモリの証拠であり、計画の属性ではない。

isolate 内の上限128は補助的な制限だけ。cloud の全送出128件・並列4件・費用・期限の枠は、未実装のドライバ台帳で再起動・複数isolateをまたいで守る必要がある。現状のコードだけではこの条件を満たさない。

### 共有要求の呼出契約

probeのHTTP認可（Bearer／Origin）・method/path・16 KiBのstream読出しは入口の責務。`toCpsatTransportRequest` へ渡す `authorization` はJSON本文から作らず、入口の認可結果と由来を渡す。直接probeの由来は常に `origin.kind=probe`・`mode=probe`・親なし。本文の `origin.kind=engine` を受け入れる経路はない。

将来のEffect呼出元は、実際のPersist成功後にだけ、DO instance／decision／Effect位置／Persist観測の親ID／店舗参照を確定して渡す。共有関数は本文との一致を検査するが、storage.putが実際に成功したかを独自に知る機構ではない。Effect由来は `origin.kind=engine`・`mode=live`。既存観測スキーマが `mode=probe` の生成記録を禁じているためであり、`mode=live` を厨房向けCP計画の採用・有効化という意味には転用しない。固定問題・manifest・code版が輸送試験の範囲を示す。

期限は `app.ts` の `#enabled` のまま独立させ、入口での検査に加え、`dispatchCpsatTransportRequest` に `() => this.#enabled()` を渡す。認可／本文読出しの前のbooleanを使い回さない。送出側の期限再検査から観測・fetchまでにawaitを挟まない。求解の打ち切り時計とは無関係な、試験入口の受付期間の検査である。

窓切れで送らなかった試行は503・観測0行とする。理由は呼出元／試験台帳側で扱い、実送出件数へ混ぜない。送出済みの結果は窓が閉じた後も記録する。

**由来付きlive要求はまだfixture検証のみ。** solverの `mode=live` の入力検証は接続済み。実Effectからの固定求解はshim由来probeとして別系列で検証する。[由来の両端検証](../../../.kiro/specs/cpsat-planner-integration/verification/transport-provenance-local-20260910.md)では共通12ケースを使う。solverの正例2件は、上限0のinstanceで入力検証後の429へ到達することだけを検査し、liveの実Effect求解の成功とはしない。

[共有処理の検証記録](../../../.kiro/specs/cpsat-planner-integration/verification/transport-request-local-20260910.md)：12件の追加テストと、切り出し後の直接probe実WASM再確認。modeの取り違えを検出した途中の失敗も記録する。

## 再現

repo root で実行する。ローカル Worker 型が未生成の場合は、既存手順で `pnpm cf-typegen` と次を実行する（配備ではない）。

```sh
pnpm exec wrangler types src/cpsat/worker-configuration.d.ts \
  --config wrangler.cpsat-planner.jsonc --config wrangler.jsonc \
  --env-interface CpsatPlannerEnv --include-runtime false
pnpm exec wrangler types experiments/cpsat-workers/transport/worker-configuration.d.ts \
  --config experiments/cpsat-workers/transport/wrangler.types.jsonc \
  --env-interface CpsatTransportProbeEnv --include-runtime false
```

K-2対応でrootの `CPSAT_SOLVER`／`PLANNER_BACKEND` とVitestのCP用503代役は撤去した。rootの型は `pnpm cf-typegen` で再生成する。ハーネス自身が渡すMiniflare bindingはそのままで、型生成のためにrootへ戻さない。cloud用のbinding追加は、対象・範囲の明示承認とsolver配備を経た配備差分で別途扱う。

固定入力の照合には [tuning のロック済み環境](../tuning/README.md) を流用する。

```sh
experiments/cpsat-workers/fixtures/local/tuning-venv/bin/python \
  experiments/cpsat-workers/transport/generate_fixtures.py --check
pnpm exec tsc --noEmit --project experiments/cpsat-workers/transport/tsconfig.json
node experiments/cpsat-workers/transport/check-local.mjs /tmp/NEW-transport-report.json
node experiments/cpsat-workers/transport/check-app-local.mjs /tmp/NEW-app-transport-report.json
pnpm test --project tools tests/cpsat-transport-app.example.test.ts
pnpm test --project workers tests/shell/cpsat-transport-rejection.integration.test.ts
pnpm test --project workers tests/cpsat-transport-request.example.test.ts
pnpm test --project workers tests/cpsat-transport-shim.example.test.ts tests/shell/cpsat-transport-persist.integration.test.ts
```

レポート出力先は毎回新しいファイルを指定する。既存ファイルを上書きしない。`--check` は protobuf・モデル設定を厳密比較し、native 探索経路の差は別欄へ出す（小問題の既知最適値・負荷問題の打ち切りは毎回検査する）。新規生成時も既存 `fixtures.json` を上書きしない。

ローカルハーネスは新規の一時ディレクトリと一時 DO を使い、終了時に自身の workerd を dispose する。Cloudflare 認証・`.dev.vars`・ネットワーク上の実アプリを使わない。callback はローカル RPC の test double であり、実 StoreTimerDO への棄却試験は別の Workers pool テストで行う。

上記のtest doubleは `check-local.mjs` の場合。`check-app-local.mjs` は実StoreTimerDOと実loopback HTTPサーバを使う。remote bindingは使わない。Node入口で検査済みのOriginだけをテスト専用relayで復元し、Miniflare自身のOrigin拒否をappの拒否と混同しない。外部からの `X-Local-Test-Origin` は採用しない。従来のapp単独試験はrelay経由のまま残し、実HTTP試験と区別する。認証値は各回ランダム生成し、report／ログへ出ないことを検査する。チェックインmanifestの `origin`／`requestTokenSha256` は空で、`enabled=false` と併せて無効のまま保持する。実HTTPとブラウザ検証の区別は[最新の結果と限定](../../../.kiro/specs/cpsat-planner-integration/verification/transport-loopback-local-20260910.md)を参照。

## 今回の測定

[生レポート](../../../.kiro/specs/cpsat-planner-integration/verification/transport-local-20260909.json)、[範囲・未完了事項](../../../.kiro/specs/cpsat-planner-integration/verification/transport-local-20260909.md)。WASM と生成 JS のハッシュは毎回照合し、レポートにも保存する。

| 条件 | native | ローカル WASM |
| --- | --- | --- |
| 小問題、3変数・1制約、探索予算0.01 | OPTIMAL、目的値5、`[2,1,0]` | 同じ |
| 負荷問題、500変数・22,495制約、探索予算0.14 | UNKNOWN、消費0.14028549119800013、境界値118 | UNKNOWN、消費0.140242550894、境界値115 |

負荷問題は解を得る前の打ち切りであり、良い計画を返した例ではない。予算消費の微小な超過は協調停止の粒度で、探索量を厳密な上限や実時間の秒数とは呼ばない。異なるビルド間の途中の探索境界・消費量の不一致を、小問題の最適解不一致と混同しない。差は生レポートの `nativeComparisons` に保存する。

11回（小7・負荷4）の求解で instance は1個、初期化1回、観測した線形メモリ容量は全て32 MiB。callback 失敗1回は意図的な注入で、求解成功とは別に `failed` を記録し、その後は再初期化せず復帰する。busy 試験は callback を意図的に保留するため、性能・受理と求解の分離の証拠に使わない。

solver の176観測行に、正常／busy系列のドライバ送出・受理24行を加えて既存集計器へ渡し、因果リンクを検査した。生成0、実送出12、受理11、求解開始11、callback戻り11（delivered 10／failed 1）。無効manifest2件と不正入力6件は別系列で、求解開始・callbackはいずれも0。

**測っていないもの**：cloud CPU、128 MB isolate 全体のメモリ、30秒 waitUntil 枠の消費・余裕、同じ実 DO の求解中操作、実認証、cloud 復帰。観測スキーマの該当値は `unavailable` のままにする。WASM の時計が0の値を CPU 0として扱わない。ローカル workerd の互換日付は2026-06-26で、計画中のcloud用2026-09-09とは区別する。trap／初期化失敗の注入試験も未実施（task 5.5へ引き継ぐ）。
