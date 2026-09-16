# CP-SAT single-thread Wasm：Workers 実環境の検証結果

測定開始: **2026-09-08 20:44:34 JST**。対象確認・ユーザー承認後に新規の検証用Workerへデプロイしました。

## 結論

**単一スレッドCP-SAT Wasmは実環境のWorkersで動作し、時計に頼らない探索量制限で復帰しました。この固定問題のPoCは成功、実モデルでの評価に進める候補です。本採用の確定ではありません。**

通常時計・固定時計の計148 solvesすべて成功。全条件でnativeと解・status・目的値・bound・探索統計が一致しました。プラットフォーム側の集約観測では最大CPU 666.453 ms、最大isolateメモリ約74.76 MiB。設定したCPU上限1,000 msの超過失敗は観測していません。

現行engine・DO・UI・永続形式は未変更で、既存Workerへの接続もありません。

## 対象・配布物

- Account: Yamaokaya / `305d89a643ac689b4204454c5493cbde`
- Worker: `yude-men-cpsat-wasm-poc`
- URL: <https://yude-men-cpsat-wasm-poc.yamaokaya.workers.dev>（認証なしでは401）
- Version: `a8eb8beb-bbf1-4ada-982e-c8e1f7597072`
- Deploy時刻: 2026-09-08 20:44:17 JST
- `compatibility_date=2026-06-26`、`cpu_ms=1000`、`usage_model=standard` を設定取得APIでも確認。
- bindingは `POC_AUTH_TOKEN` Secretのみ。`workers_dev=true` / `preview_urls=false`。既存アプリ・custom domain・DOには接続していません。
- Upload: 6,766.35 KiB / gzip 2,369.22 KiB。Wasm本体6,776,864 bytes、glue104,791 bytes。pthread/shared memoryなし。
- native: OR-Tools 9.15.6755。Wasm: fork `e1453348bc43d3b0afc0c2e5a535f5c9b45326f4`、Emscripten4.0.20。Wrangler4.105.0。

請求プラン詳細APIは403でした。上記usage modelとCPU設定は取得できていますが、料金プラン名の確認やプラン変更は行っていません。検証用Workerは残しています。

## 一致・探索量での打ち切り

`num_workers=1`、`random_seed=1`、`max_deterministic_time`のみ有限に設定。`max_time_in_seconds`は既定の無限大です。難問は固定seedの最大独立集合、500変数・22,495制約。探索用fixtureだけpresolveを無効化し、実際に分岐後の復帰を検査します。

| 条件 | 予算 | 実消費量 | status / 目的値 | bound | 分岐 / 競合 |
| --- | ---: | ---: | --- | ---: | ---: |
| small | 0.05 | 0.0000307498 | OPTIMAL / 5 | 5 | 22 / 0 |
| hard・既定前処理 | 0.01 | 0.041361229 | UNKNOWN / null | 未評価 | 0 / 0 |
| hard-search・低予算 | 0.01 | 0.012254810 | FEASIBLE / 24 | 500 | 1,314 / 0 |
| hard-search・標準予算 | 0.05 | 0.050069252 | FEASIBLE / 27 | 499 | 3,815 / 1,111 |
| hard-search・高予算 | 0.1 | 0.100372376 | FEASIBLE / 27 | 499 | 4,814 / 2,050 |

通常時計 / 固定時計 / native の全解配列・上記統計が一致しました。比較時には丸めていません。nativeは小問題5回、各難問条件3回の計17回。Workersは各時計モードで小問題51回、前処理1回、探索低予算1回・標準予算20回・高予算1回の計74回です。全暫定解について、全辺の制約と目的値を独立したJS実装でも検査しました。目的値27の最適性は証明されていません。

**通常時計モードでも全件 `solverWallTimeMs=0`、`hostElapsedMs=0`、`initializationMs=0` でした。** 固定時計モードも同じです。これは計算が0 msだったという意味ではなく、今回の同期計算中に内部時計が進まなかった実測です。固定時計モードでは時計importを計1,553,280回呼び出しても全件復帰しました。

探索量も厳密な上限ではありません。前処理では予算の約4.14倍、標準探索では約0.14%超過しました。予算外のモデル生成・検証などもあるため、探索量をCPU時間や応答期限へ直接換算できません。[時計の仕様](https://developers.cloudflare.com/workers/reference/security-model/)、[OR-Toolsの処理量制限](https://github.com/google/or-tools/blob/v9.15/ortools/util/time_limit.h)

## 起動・応答・連続実行

以下はmacOS arm64上の外部HTTPクライアントによる往復時間で、ネットワーク込みです。CF-RayとanalyticsはいずれもNRTを観測しました。

| HTTP測定 | 通常時計 | 固定時計 |
| --- | ---: | ---: |
| 最初の小問題1 solve | 219.74 ms | 38.98 ms |
| warm 小問題25 solves / 1要求 | 171.36 ms | 69.67 ms |
| 難問・既定前処理1 solve | 693.57 ms | 400.12 ms |
| 探索低予算1 solve | 353.32 ms | 242.20 ms |
| 探索標準予算、20要求の平均 | 389.29 ms | 349.31 ms |
| 同最小–最大 | 295.69–626.95 ms | 285.15–460.24 ms |
| 探索高予算1 solve | 420.74 ms | 448.25 ms |
| 難問後の小問題25 solves / 1要求 | 68.91 ms | 66.37 ms |

両モードの52 solve要求は同じisolate IDで実行されました。各モードの最初だけWasmを初期化し、後続25要求でそのinstanceを再利用。各モード74 solves後も小問題は正解しました。これは短期の連続実行試験であり、長期リーク試験ではありません。モードは順番に測定しているため、応答時間の差を時計固定の効果とは判定しません。

デプロイ・最初の認証付きhealth・最初のsolveは成功しました。ただしプラットフォームのcold startを強制した試験ではありません。固定時計側の「最初」は既にwarmなisolate上の別Wasm instance初期化です。デプロイ時のstartup時間の数値は取得しておらず、内部時計の0を初期化コストとして扱いません。デプロイ前のローカルstartup profileは [RESULTS.md](RESULTS.md) の参考値に留めます。

## プラットフォーム側のCPU・メモリ

個別telemetry APIは現在のOAuth権限で403。権限を追加せずにGraphQL `workersInvocationsAdaptive` で次を取得しました。単位は同APIのスキーマをintrospectionで確認し、生データに保存しています。

| 集約観測値 | 最大値 |
| --- | ---: |
| 1要求のCPU time | 666,453 µs = 666.453 ms |
| 1要求のwall time | 673,163 µs = 673.163 ms |
| V8 isolate memory usage | 78,392,984 bytes ≈ 74.76 MiB |
| WebAssembly linear memory usage | 67,108,864 bytes = 64 MiB |

取得範囲は20:44:29.640–20:47:09.699 JST。21集約行、82 requests、errors 0、全行status `success`、すべて上記version / NRTでした。範囲には本体ベンチマークのほか、別isolateで成功した小問題の追加確認1要求も含みます。クライアント側は本体82要求＋追加1要求であり、analytics件数とは1件差があります。集約・取り込みの差を個別要求に突合できていないため、analyticsを完全な全件記録とはみなしません。401/400も正常なHTTP応答なので、プラットフォームの `success` はHTTP 200の意味ではありません。[Workers analytics API](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/)

各solveが返したWasm容量は全件32 MiBのまま。remoteでは同じisolate内に時計モード別の2 instancesをキャッシュしたため、プラットフォーム側のWasm合計は64 MiBになりました。上表のisolate値とWasm値は単純加算せず、それぞれのAPI項目として記録します。APIの観測最大値であって、全allocationの連続ピーク測定・allocator使用中量・長期リークなしの証明ではありません。96 MiBのbuild上限もinstance単体の上限です。

## 認証・検査結果

- remote本体の全28チェックが成功。認証なし／誤ったBearerは各モードとも401。不正入力は各12件すべて400。15秒の外部watchdog、solver error、CPU超過失敗なし。
- 追加の [remote-boundary-check.json](results/remote-boundary-check.json) で、認証なしhealthは401、難問の集約予算0.25は400、POSTは405、不明routeは404。
- 難問は `deterministicLimit × repeat ≤ 0.2` の入力制限、WorkerはCPU 1,000 msの強制上限。上限による強制終了は暫定解を返す停止ではなく、許可したすべての入力が1秒内に収まる保証もしていません。
- 認証追加後のローカルWorkerdでも148 solves、全30チェックが成功。現行ベンチマークには集約予算違反を追加し、不正入力は各13件です。
- PoCの型検査・lint、rootのformat検査、差分の空白検査が成功。現行アプリコードは未変更のため、このデプロイ追試では現行アプリ全テストを再実行していません。
- Secretはremote Secret bindingとgitignore対象の `.dev.vars` にのみ保存。ソース・実測JSONに値やAuthorizationヘッダーは保存していません。

## 採用／不採用の判断材料

今回確認できたのは、**Workersでの実行可能性と、内部時計が進まなくても探索量で協調停止できること**です。時計だけを理由に不採用にする必要はなくなりました。

本採用前に残る条件は次のとおりです。

1. 実際の最大想定モデルで、前処理の超過・予算外処理込みのCPU、応答、暫定解品質が要件を満たすこと。今回のグラフ問題は現行スケジュールの品質評価ではありません。
2. 長期反復、isolate再生成、同時要求、メモリ成長、cold-start分布を測ること。2モードのキャッシュは比較試験用であり、そのままの本番設計を推奨しません。
3. 現行の即時202応答＋非同期処理契約を維持できること。今回のPoCは同期solve完了後にHTTPを返します。engine・DO・UI・永続形式への統合変更は今回の対象外です。
4. UNKNOWN・暫定解・最適解・invocation強制終了を区別した失敗処理、および推移的依存ライセンスを確認すること。

実モデルでCPU・メモリ・応答・品質のいずれかが不足する、または既存契約を維持できない場合は不採用の材料です。今回の実測だけで本番採用や任意モデルの停止期限を保証しません。[Workers上限](https://developers.cloudflare.com/workers/platform/limits/)

## 再現コード・生データ

[README.md](README.md) にビルド・認証・デプロイ・測定のコマンドを記載しています。実環境への更新は承認済みの検証用Workerだけを対象とします。

- [benchmark.mjs](scripts/benchmark.mjs): native、local Workerd、remoteを同じ固定問題で比較
- [collect-remote-metrics.mjs](scripts/collect-remote-metrics.mjs): 設定・deployment・集約CPU／メモリの読取
- [deterministic-remote.json](results/deterministic-remote.json): 初回remote全応答・解・計時・チェック
- [remote-metrics.json](results/remote-metrics.json): 設定・version・telemetry 403・GraphQL計測と単位
- [deterministic-auth-local.json](results/deterministic-auth-local.json): 認証と追加境界検査を含むローカル再検証

初回remote生データには `completedAt` がないため、保存済みmetricsの終了時刻は収集時刻です。現行harnessは終了時刻も保存し、以降のmetrics問い合わせはその時刻までに限定します。
