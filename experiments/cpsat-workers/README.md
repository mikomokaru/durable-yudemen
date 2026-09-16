# CP-SAT single-thread WASM / Cloudflare Workers PoC

既存の engine・Durable Object・UI・永続形式から独立した技術実証です。CP-SAT を pthread なしの WebAssembly としてビルドし、ローカル Workerd とデプロイ済み Workers で native 一致、探索量による打ち切り、時計固定、連続実行、メモリ、初回・warm 応答を測ります。

**既存 WASM を使う場合は [流用ガイド](WASM_REUSE.md) から始めてください。** 流用対象のハッシュ、生成 JS と ABI、再ビルドの要否、Workers の互換設定、成果物の保存単位をまとめています。通常の TS モデル・係数変更に C++ の再ビルドは不要です（既存 proto・演算・上限の範囲内）。

**2026-09-08、承認済みの Yamaokaya アカウントへ検証用 Worker をデプロイし、実環境でも148 solvesが成功しました。最新の判断と実測は [REMOTE_RESULTS.md](REMOTE_RESULTS.md)、デプロイ前のローカル記録は [RESULTS.md](RESULTS.md)。**

実注文の次段階は [REAL_ORDER_RESULTS.md](REAL_ORDER_RESULTS.md)。承認済みの設定で10店舗300注文から100局面を作り、ネイティブ500回・ローカルWorkerd 1,000回の制約検査が通過しました。単一卓・合流配置の一部固定・簡略目的関数という限定付きです。[入力監査](REAL_ORDER_INPUTS.md)も参照してください。**実注文用の変更は未デプロイで、remoteの148回は以前の固定問題の結果です。**

## 打ち切りの契約

`num_workers=1`、`random_seed=1`、`max_deterministic_time=指定値` を設定し、`max_time_in_seconds` は既定の無限大のままにします。API は `deterministicLimit`。**秒数でもミリ秒数でもなく、ソルバー内部の処理量を重み付けした指標の予算**です。

CP-SAT は処理の区切りで上限を確認するため、予算の厳密な不超過は保証しません。特に presolve は大きく超過することがあります。モデル生成・検証・結果の JSON 化など、予算で全面的に制限できない仕事もあります。入力サイズ制限、CPU 消費、応答時間は別に評価します。

`max_number_of_conflicts` は採用しません。OR-Tools のパラメータ定義では内部 SAT solve ごとの制限で、最適化全体の競合数上限ではないためです。[パラメータ定義](https://github.com/google/or-tools/blob/v9.15/ortools/sat/sat_parameters.proto)、[処理量カウンタの実装](https://github.com/google/or-tools/blob/v9.15/ortools/util/time_limit.h)

Workers は CPU 実行中に時計が進むことを保証しません。`setTimeout` / `Promise.race` も同じスレッドの同期 Wasm を中断できません。Workers の CPU 上限による終了は invocation の失敗であり、CP-SAT が暫定解を返す協調的な打ち切りとは別です。[時計の仕様](https://developers.cloudflare.com/workers/reference/security-model/)、[CPU 制限](https://developers.cloudflare.com/workers/platform/limits/)

## 固定問題と検査

| ケース | 問題・設定 | 検査 |
| --- | --- | --- |
| `small` | `x,y,z ∈ {0,1,2}`、AllDifferent、最大化 `2x+y` | `OPTIMAL / 5 / [2,1,0]` が native と一致 |
| `hard` | 固定 seed の最大独立集合、500 Bool・22,495 制約、既定 presolve | 予算 0.01 で `UNKNOWN` から復帰 |
| `hard-search` | 同じグラフ、`cp_model_presolve=false`、`linearization_level=0` | 予算 0.01 / 0.05 / 0.1 で分岐後に `FEASIBLE` を返す |

`hard-search` の設定は探索段階の打ち切りを検証するための fixture で、実運用向けの推奨設定ではありません。全暫定解について全辺の制約、目的値、bound をソルバーとは別の JS 実装で検査します。`UNKNOWN` の `objective` は `null`、`solution` は空で、未発見の解を目的値0の解と誤認させません。

ローカルベンチマークは時計モードごとに新しい Workerd を起動します。Node は測定クライアントであり、Wasm は Workerd の V8 isolate 内で動きます。各モードで小1 → 小25 → presolve1 → 探索低予算1 → 探索標準予算20 → 探索高予算1 → 小25、計74 solves / 26 HTTP要求です。標準予算の難問は別々の HTTP 要求で20回繰り返し、Wasm instance の再利用も記録します。さらに認証失敗2件、不正入力13件を確認します（初回 remote 記録は12件、追加の集約予算制限は別の境界検査に記録）。remote は isolate 配置・寿命を制御しないため、再利用は観測値であって合格の必須条件にはしません。

`clock=host` は通常の glue、`clock=frozen` は次の2 import を定数に置換します。

- `env.emscripten_get_now`: 固定した monotonic time
- `wasi_snapshot_preview1.clock_time_get`: realtime / monotonic / CPU clock を固定

時計固定は instance 初期化時から適用し、Wasm import の時計名一覧が変われば検証を失敗させます。各 solve の固定時計呼び出し数が正で、`solverWallTimeMs=0` でも復帰することを確認します。通常時計と固定時計の全結果について、解・status・bound・探索統計の一致も検査します。これは本番 Workers の完全な模擬ではなく、時計非進行への耐性試験です。

## 再現

通常は配布済み vendor を使い、[流用ガイド](WASM_REUSE.md)のハッシュ検査を先に行います。ローカル実行・参照検証には Node.js、pnpm、uv を使い、依存関係は root で `pnpm install --frozen-lockfile` します。C++ の再ビルドが必要な場合だけ、Unix 系 OS、Git、CMake 3.31以降、C/C++ build tools も用意します。ビルドは固定 revision の fork と Emscripten 4.0.20 を取得し、多数の C++ 依存ライブラリをコンパイルして vendor を上書きするため、通常の準備手順には含めません。

```sh
pnpm poc:cpsat:inspect
node experiments/cpsat-workers/scripts/init-secret.mjs
pnpm poc:cpsat:types
pnpm poc:cpsat:typecheck
pnpm poc:cpsat:bench
```

既存の source / build tree は `CPSAT_WASM_SOURCE_DIR` / `CPSAT_WASM_BUILD_DIR` で再利用できます。native は `uv run --with ortools==9.15.6755`。Wasm の fork は `e1453348bc43d3b0afc0c2e5a535f5c9b45326f4` に固定しています。native wheel と fork は同一ビルドではないため、任意モデルで探索経路まで一致する保証はありません。

`init-secret.mjs` は256 bitの検証用トークンを `.dev.vars`（gitignore対象、permission 0600）へ初回のみ作成します。値を表示せず、既存の有効な値は変更しません。ベンチマークはこのファイルを読み、Authorization ヘッダーで送信します。Secret を失った場合は新しいローカルトークンの生成だけではデプロイ先と一致しません。対象を再確認して remote Secret も更新する必要があります。

新しいローカル生データは `results/deterministic-auth-local.json`。`results/deterministic-local.json` は認証追加前の記録、旧 `results/local.json` は時計依存の旧実験の参考記録です。後者は現行の合格判定には使いません。別名で測定するとき:

```sh
node experiments/cpsat-workers/scripts/benchmark.mjs \
  --output experiments/cpsat-workers/results/deterministic-local-rerun.json
```

クライアント側の15秒 watchdog はハング検出用で、ソルバーの停止機構ではありません。異常時は部分結果とエラーを保存し、ベンチマークが起動した pnpm / Wrangler / Workerd の process group を終了します。起動前に使用ポートが空いていることを確認します。`CPSAT_POC_PORT` で変更できます。

ローカルではベンチマーク自身がWorkerdを起動・終了し、認証付き要求を送ります。トークンをコマンド引数やURLに埋め込む必要はありません。手動の `wrangler dev` が8791を使用している場合は、先にその手動プロセスを終了するか、測定側の `CPSAT_POC_PORT` を変更してください。

`deterministicLimit` は有限の `(0,1]`、`repeat` は整数 `1..50` のみ許可します。難問ではさらに `deterministicLimit × repeat ≤ 0.2`。旧 `timeLimitMs` 指定は400で拒否します。認証なし・誤ったトークンは `/health` を含め401で拒否し、Wasmを初期化しません。これらは PoC の入力境界であり、すべての許可された組み合わせがCPU上限内に収まる保証ではありません。

## TS評価方針とSMACの隔離実験

閉ループ再生・SMAC探索は [tuning/README.md](tuning/README.md)、実測と採否は [SMAC_RESULTS.md](SMAC_RESULTS.md)。
10店舗359杯で初期係数の完了を確認したが、12候補の探索では初期値を超えなかった。
新しい複雑モデルのlocal workerd比較ではFEASIBLE解のnative/WASM差と報告目的値の不一致を観測し、本番採用は保留。
この追加実験ではクラウドへデプロイしていない。

## 承認済みのデプロイ先と remote 再現

- アカウント: Yamaokaya / `305d89a643ac689b4204454c5493cbde`
- Worker: `yude-men-cpsat-wasm-poc`
- URL: <https://yude-men-cpsat-wasm-poc.yamaokaya.workers.dev>（Bearer 認証必須）
- CPU上限: 1,000 ms、usage model: `standard`。請求プランの詳細取得は403で未確認。プラン変更はしていません。
- 唯一の binding: `POC_AUTH_TOKEN` Secret。既存サービスの binding / route / custom domain は追加していません。

デプロイの再現コマンドは次のとおりです。**実行すると上記の検証用 Worker を更新します。現在の作業ツリーには未デプロイの実注文用拡張があるため、追加デプロイ前に対象と変更内容を再確認してください。別アカウントや現行アプリへのデプロイも対象を再確認してください。**

```sh
cd experiments/cpsat-workers
pnpm exec wrangler deploy --config wrangler.jsonc --secrets-file .dev.vars \
  --message 'Isolated CP-SAT deterministic-budget PoC; approved Yamaokaya target' \
  --autoconfig=false
```

以下はリポジトリrootから実行します。ベンチマークはこの承認済みURL以外へのSecret送信やHTTPリダイレクトを拒否します。実験データを保存し直すため、過去結果を残したい場合は `--output` で別名を指定してください。

```sh
pnpm poc:cpsat:bench --url https://yude-men-cpsat-wasm-poc.yamaokaya.workers.dev
node experiments/cpsat-workers/scripts/collect-remote-metrics.mjs
```

remote 結果は `results/deterministic-remote.json`、プラットフォーム計測は `results/remote-metrics.json`。後者はベンチマーク時刻を使い、設定・version・CPU・wall time・メモリの読取専用API問い合わせを実行します。取り込み遅延で空の場合は後から再実行してください。`CLOUDFLARE_API_TOKEN`、またはmacOSのWrangler OAuth設定を読みます。別OSでは `CPSAT_CF_AUTH_FILE` でWrangler設定ファイルを指定できます。認証値や要求ヘッダーは保存しません。

現在のOAuth権限では個別 telemetry API は403でしたが、GraphQL analytics は取得できました。失敗も結果に残し、権限を自動拡張しません。GraphQL値は集約観測であり、各 solve との一対一対応や完全な全件捕捉を主張しません。記録にはAPIスキーマの単位説明も保存します。[Workers metrics API](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/)

## デプロイしない起動検査

デプロイしない bundle / startup 検査:

```sh
pnpm exec wrangler deploy \
  --config experiments/cpsat-workers/wrangler.jsonc \
  --dry-run --outfile /tmp/cpsat-deterministic.bundle

pnpm exec wrangler check startup \
  --workerBundle /tmp/cpsat-deterministic.bundle \
  --outfile /tmp/cpsat-deterministic-startup.cpuprofile
```

## 測定値の意味と限界

- `requestedDeterministicLimit` / `deterministicTime`: 予算 / 消費した探索量。後者と `branches` / `conflicts` で進捗と超過を判断します。fixture の許容超過値は benchmark 冒頭に明記し、一般的な保証には使いません。
- `clientElapsedMs`: Worker 外のクライアントで測る HTTP 往復。モデル生成・初期化・応答変換も含みます。本番 CPU time とは異なります。
- `solverWallTimeMs` / `hostElapsedMs` / `initializationMs`: 内部時計による参考値。固定モードは Wasm の時計だけを固定するため、ローカルの JS 計時値は進みます。本番で内部時計を実時間の計測に使わないでください。
- `wasmMemoryBytes`: 線形メモリの**確保容量**であり、allocator の使用中バイト数・リーク検出・isolate 全体の peak ではありません。build 設定は初期32 MiB、最大96 MiBですが、これだけで128 MB/isolateへの適合を証明しません。
- モード別に Wasm instance をキャッシュします。同じ isolate に両モードを使うと2 instances分のメモリを消費します。ローカル測定はモードごとに別 process、初回remote測定は同じisolateで両モードを実行し、計64 MiBのWasm容量を観測しました。
- `runtime.isolateId` は要求間の再利用を識別するPoC用の値で、認証情報ではありません。remote初回HTTPは最初に観測した要求にすぎず、プラットフォーム全体のcold startを強制した測定ではありません。startup profileもローカル参考値です。本番cold-start分布、SLO、同時要求、現行の202応答＋非同期処理契約への統合は未検証です。

## ビルド・スコープ

配布版 `or-tools-wasm` の `num_workers=1` だけでは pthread link 依存を取り除けないため、fork に専用 target を追加します。`-sUSE_PTHREADS` / shared memory / Web Worker pool を使わない target をビルドし、モデル側にも `num_workers=1` を設定します。[Emscripten pthreads](https://emscripten.org/docs/porting/pthreads.html)、[Workers Wasm](https://developers.cloudflare.com/workers/runtime-apis/webassembly/)

この Worker は `workers_dev=true` / `preview_urls=false` で、認証付き検証用URLだけを公開しています。対象を確認し、ユーザーの承認後にデプロイしました。検証終了時点でもWorkerは残しています。現行の `yude-men-timer` / `yude-men-solver`、engine・DO・UI・永続形式は変更していません。

Cloudflare の時計仕様を参照し、事前コンパイル済み Wasm module の instance 化と local / dry-run 検証を使っています。compatibility date はリポジトリ規約の `2026-06-26` を維持しています。root の変更は再現用 `package.json` scripts、生成物を除外する `.oxfmtrc.json`、注文原本・ローカル設定・派生データを保護する `.gitignore` です。formatter 設定は規約どおり root に集約しています。

追加の一次資料: [Workers の上限](https://developers.cloudflare.com/workers/platform/limits/)、[Wasm module の読み込み](https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/)、[ビルド元の固定 revision](https://github.com/Axelwickm/or-tools-wasm/commit/e1453348bc43d3b0afc0c2e5a535f5c9b45326f4)。
