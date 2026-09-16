# クラウド探索専用 solver

実測・初回のホスト休止・明示的な続行は [CLOUD_SEARCH_RESULTS.md](../CLOUD_SEARCH_RESULTS.md) に記録する。
追加時間枠でのSMAC 9設定比較は [CLOUD_SEARCH_EXTENSION_RESULTS.md](../CLOUD_SEARCH_EXTENSION_RESULTS.md) を参照。

Yamaokaya アカウント `305d89a643ac689b4204454c5493cbde` 内の
`yude-men-cpsat-search`。既存 `yude-men-cpsat-wasm-poc`、本番 engine・DO・UI・永続形式には接続も変更もしない。
URL は https://yude-men-cpsat-search.yamaokaya.workers.dev 。認証のないリクエストは401。

## 境界

- CP-SAT は既存の単一スレッド C++ WASM。SHA-256:
  `c8b89a734a15ad067e18edd08fc58d179aff63bf9922080e75fbeeecfb0223a1`。
- Node はローカルの通信・TS再生、Python はローカルのSMAC・protobuf化だけ。WorkerにPythonもNodeプロセスもない。
- 通信は数値インデックスのCPモデルprotobufのみ。注文JSON、注文ID、店舗設定原文は送信しない。
- `POST /solve-model?deterministicLimit=...`、`application/octet-stream`、1..1MiB。
  単一solve、固定時計、`0 < deterministicLimit <= 0.2`、単一スレッド。
- モデルの変数8192・制約40000の既存C++上限、WASM線形メモリ最大96MiB。
- `SEARCH_AUTH_TOKEN` は256bitランダム値。リクエストヘッダで渡し、URL・ログ・成果物に保存しない。
- `SEARCH_EXPIRES_AT=2026-09-10T06:00:00Z` 以降は認証済みでも403。期限はアクセス制御に使う実時間であり、ソルバーの打ち切り時計ではない。
- プラットフォームのCPU安全上限は10秒。通常の探索量予算はTSモデルが決める既存式のまま。
  CPU上限は厳密な10秒停止保証ではない。実行中の猶予・中断はWorkers側の仕様に従う。
- DO/KV/R2/Queue/本番service binding、routes、cronは持たない。

## 2026-09-09 の実装時に確認した注意点

互換日付2026-09-09ではNode互換が既定有効。Worker向けEmscripten生成JSは
`process.versions.node` を見てNode環境と誤判定し、初期化を拒否した。
`no_nodejs_compat` と `no_nodejs_compat_v2` の明示で解消。
WASM・生成JSのバイナリは変更していない。
[Cloudflareの互換フラグ仕様](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#nodejs-compatibility-flag)

初回のCPU上限1000msでは実履歴の大きいモデルが503。
安全化したtailで `exceededCpu` / `Worker exceeded CPU time limit.` / CPU3500msを観測した。
これは適応的な猶予を含む実測であり、1秒上限が常に3.5秒になるという意味ではない。
探索量予算を変えず、探索専用WorkerのCPU安全上限のみ10000msへ変更。

同一Workerへの4同時HTTPは4つのCPU/isolateを保証しない。
同一12モデルで逐次16.106秒、2同時16.226秒、4同時14.940秒。
isolate数はそれぞれ1/2/1だった。ウォームアップ後でも配信先やisolate再利用を制御できないため、
この短い試験から恒常的な速度倍率は主張しない。
全37正常solveのstatus・objective・solution・deterministicTimeはローカルWASMと一致した。

## 再現と運用

rootの依存は更新しない。Wrangler **4.130.0** を別CLIキャッシュで利用する。
以下はrootから実行する例。期限が過ぎた再実験は対象と新しい期限を確認してから再デプロイする。
同名Workerの存在・用途を確認し、既存の本番や他人のWorkerへ上書きしない。

```sh
# 初回だけ。既存のprivate credentialがあれば再生成しない。
node experiments/cpsat-workers/search-worker/init-secret.mjs

pnpm --package=wrangler@4.130.0 dlx wrangler types \
  experiments/cpsat-workers/search-worker/worker-configuration.d.ts \
  --config experiments/cpsat-workers/search-worker/wrangler.jsonc \
  --env-interface CpsatSearchEnv
pnpm exec tsc --noEmit --project experiments/cpsat-workers/search-worker/tsconfig.json

# デプロイは外部変更。対象確認後にだけ実行する。
pnpm --package=wrangler@4.130.0 dlx wrangler deploy \
  --config experiments/cpsat-workers/search-worker/wrangler.jsonc \
  --secrets-file experiments/cpsat-workers/fixtures/local/search-secrets.json

node experiments/cpsat-workers/tuning/check-cloud.mjs \
  experiments/cpsat-workers/fixtures/local/wasm-histories-pilot-20260909a \
  experiments/cpsat-workers/results/search-cloud-check-reproduction.json

OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 \
  experiments/cpsat-workers/fixtures/local/tuning-venv/bin/python \
  experiments/cpsat-workers/tuning/search-cloud.py \
  --output experiments/cpsat-workers/fixtures/local/cloud-search-reproduction \
  --parallel 4 --trials 12 --max-seconds 3600 --max-requests 50000 \
  --validation-seconds 600 --validation-requests 12000 --seed 20260909
```

venv、保存済み設定、実履歴の準備は [tuning/README.md](../tuning/README.md) を参照。
出力ディレクトリは新規必須。再開・自動リトライは行わない。
探索予算は全体最大1時間、最大12候補（初期値を含む）、最大50000 solver試行。
最後の600秒・12000試行を検証用に確保し、探索側はその手前で止める。
予算は次のsolveの前でチェックするため、実行中1回・終了処理などの猶予がある。
HTTPは35秒timeout、プロセス応答は45秒watchdog。

14探索履歴を各候補について最後まで再生し、既存TSの外側固定スコア合計でSMAC評価。
初期値+Sobol2候補の後、SMACが提案する候補を評価する。
6検証履歴は選択後にだけ初期値と選択値を比較する。
同一候補内の独立履歴だけ最大4並列。各履歴の再計画列は逐次。
未完了の候補は比較しない。未知ステータスや通信・制約検証エラーは全体を停止し、
UNKNOWNによりfallbackが出た候補は不適格スコアにする。nativeへ代替しない。
有効な各解は汎用CP制約とTSの業務条件を独立検証する。

`manifest.json` に入力・コード・WASM hash、依存バージョン、seed、deployment versionを固定。
各履歴の詳細はprivate `replay-*.json`、全通信の安全な計測項目はprivate `requests.jsonl`。
中断中も完了履歴は残る。選択値は自動で本番設定へ適用しない。

`collect-metrics.mjs FROM OUTPUT [TO]` はこのWorkerの設定とGraphQL計測値を読み取る。
`cpuTimeUs` はプラットフォームCPU時間の集計。適応サンプリングと遅延があるため請求書ではない。
`tail-safe.mjs OUTPUT` は55秒だけこのWorkerを監視し、認証ヘッダを除いた許可項目のみ保存する。
両方ともCloudflare資格情報を内部で読み、値を表示しない。

ローカル回帰:

```sh
# CPSAT_WRANGLERには4.130.0の実行ファイルを指定。値は資格情報ではない。
CPSAT_WRANGLER=/absolute/path/to/wrangler \
  node experiments/cpsat-workers/search-worker/check-local.mjs \
  experiments/cpsat-workers/fixtures/local/wasm-histories-pilot-20260909a \
  experiments/cpsat-workers/results/search-local-reproduction.json

OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 \
  experiments/cpsat-workers/fixtures/local/tuning-venv/bin/python \
  -m unittest discover -s experiments/cpsat-workers/tuning -p 'test_*.py'
```

ローカル検証は専用8793ポートの空きを確認し、所有するworkerdプロセスグループのみ終了する。
`--minimal` は初期化→小モデル1問だけの再現モード。通常モードは不正入力13項目と37正常solve。

### 長時間実行と監視

macOS上のSMACコーディネータはスリープ中に動かず、HTTP timeoutも厳密な実時間監視にならない。
計算はcloudでも、次のモデルを作って送るローカルプロセスは常時稼働が必要。
OSの恒久設定を変えず、実行中だけIdle Sleepを避ける場合はコマンドを `caffeinate -i` で起動する。
手動スリープやlid closeを防ぐものではない。

```sh
node experiments/cpsat-workers/tuning/monitor-cloud.mjs \
  experiments/cpsat-workers/fixtures/local/cloud-search-20260909b
```

`search-cloud-batched.py` は初期値の検証済み履歴を引き継ぎ、候補をまたいで4本の履歴を処理する。
同時実行4は候補ごとの4ではなく、全候補合計4。
SMAC ask/tellの単体テストでは、初期値・Sobol2候補の後、model-based提案まで12trialを検証している。
実データで何候補まで完了したかは結果ファイルを参照し、単体テストを探索完了の根拠にしない。
引継ぎは入力/モデル/solver hashが同じ場合だけ許可し、初回のUTC開始から1時間と試行数上限を引き継ぐ。
`--resume-after-host-sleep` は記録済みの1件のtimeoutと13件の完走履歴に限る明示的な回復操作。
任意のソルバーエラーを無視するオプションではない。失敗ログは新しい集計にも残す。

### 明示承認した追加2時間の探索

`tuning/resume-cloud.py` は初期値だけが全件評価済みで、Sobol2候補が途中の
`cloud-search-20260909b` からの明示的な延長用。任意の状態からの汎用resumeではない。
初期値20履歴と候補8履歴を再利用し、未完了の履歴だけ先頭から再生する。
元のSobol提案をseedから再構築して一致を確認し、14履歴が揃ってからSMACへtellする。
その後はモデルベース候補を最大3個ずつ、全候補合計4履歴の共有executorで評価する。
初期値の検証6履歴も再利用するが、探索の提案・選択にはそのスコアを使わない。

```sh
# 承認済みの開始時刻と新規出力先を指定する。これは2026-09-09の実行記録。
# 再実行には新しい時間枠の確認が必要。過去の開始時刻では安全に停止する。
caffeinate -i env OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 \
  experiments/cpsat-workers/fixtures/local/tuning-venv/bin/python \
  experiments/cpsat-workers/tuning/resume-cloud.py \
  --resume-run experiments/cpsat-workers/fixtures/local/cloud-search-20260909b \
  --output experiments/cpsat-workers/fixtures/local/cloud-search-20260909c \
  --approved-start 2026-09-09T06:35:53Z --max-seconds 7200
```

上限は承認開始から7200秒（準備時間を含む）。UTCとmonotonicの両方を監視し、
先に達した期限で新規求解を止める。最後の600秒は検証、60秒は終了処理のための余裕。
12候補と50000 solver試行の上限は前回からの通算で、追加50000試行ではない。
初回のホスト休止による1件の失敗もjournalに残す。自動リトライ・nativeへの代替はしない。
新しい通信失敗では、失敗時のモデルをprivate出力先に保存して全体を止める。

延長時もWorkerの再デプロイ・追加Worker作成・本番設定適用はしない。
`caffeinate -i` はローカルのSMAC/TS再生/通信プロセスが終了すると自動で解除される。
Workers側のCP-SAT自体がMac上で動くという意味ではない。
