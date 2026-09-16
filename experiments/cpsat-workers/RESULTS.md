# CP-SAT single-thread WASM / Workers：探索量制限の実測

これはデプロイ前のローカル実測記録です。**後続の実環境デプロイ・CPU・メモリの結果と最新判断は [REMOTE_RESULTS.md](REMOTE_RESULTS.md)** を参照してください。

測定開始: **2026-09-08 20:35:48 JST**。macOS arm64、Node.js 26.7.0、Wrangler 4.105.0、Emscripten 4.0.20。この測定時点ではCloudflareにデプロイしていません。

生データ: [deterministic-local.json](results/deterministic-local.json)。再現手順: [README.md](README.md)。startup profile: [deterministic-startup.cpuprofile](results/deterministic-startup.cpuprofile)。

## 結論

**時計に依存しない探索量制限は、今回の固定モデル・ローカル Workerd で成立しました。次の検証へ進める材料は得られましたが、実環境採用は保留です。**

`max_deterministic_time` を有限値にし、wall time の上限を設けずに実行しました。Wasm の全時計 import を固定しても、難問は探索後に暫定解を返し、小問題は最適解を返しました。通常時計と固定時計で計148 solvesが成功し、ネイティブ版との一致も確認しました。

旧 [local.json](results/local.json) は `max_time_in_seconds` を使った参考記録です。そこでの「50 msで停止した」ことを Workers 実環境での打ち切り保証とした以前の判定は撤回し、この探索量ベースの判定に置き換えます。

## ソルバー結果

native は OR-Tools 9.15.6755、Wasm は固定した fork revision。native は小問題5回、各難問条件3回。Wasm は通常時計 / 固定時計でそれぞれ、小問題51回、前処理1回、探索低予算1回、探索標準予算20回、探索高予算1回です。

| 条件 | 探索予算 | 実消費量 | 結果 / 目的値 | bound | 分岐 / 競合 |
| --- | ---: | ---: | --- | ---: | ---: |
| small | 0.05 | 0.0000307498 | OPTIMAL / 5 | 5 | 22 / 0 |
| hard・既定前処理 | 0.01 | 0.041361229 | UNKNOWN / null | 未評価 | 0 / 0 |
| hard-search・低予算 | 0.01 | 0.012254810 | FEASIBLE / 24 | 500 | 1,314 / 0 |
| hard-search・標準予算 | 0.05 | 0.050069252 | FEASIBLE / 27 | 499 | 3,815 / 1,111 |
| hard-search・高予算 | 0.1 | 0.100372376 | FEASIBLE / 27 | 499 | 4,814 / 2,050 |

全条件で、通常時計 / 固定時計 / native の解配列・status・目的値・bound・deterministic time・分岐数・競合数が一致しました（表は丸めていますが比較は丸めていません）。全暫定解の500個の値と22,495制約をJS側でも検査しました。解27は最適性を証明した値ではありません。高予算では探索量は増えましたが目的値は改善しませんでした。

時計固定モードの74 solvesでは時計 import を計1,553,280回呼び、全件 `solverWallTimeMs=0`。難問標準予算20回は毎回62,130回の固定時計呼び出し後、同一の暫定解で復帰しました。小問題だけがすぐ解けたのではなく、実際の探索を打ち切れたことを確認しています。

### 超過は残る

上限は処理の区切りで確認されます。標準探索予算0.05の超過は約0.14%でしたが、既定前処理では0.01に対し約4.14倍の0.041361229を消費しました。したがって探索量もハードな上限ではありません。

回帰検査の消費量上限は、前処理0.06、低予算探索0.015、標準探索0.055、高予算探索0.105。native の事前校正で決めた、この固定問題専用の許容値です。別モデルにこの許容差を一般化しません。モデル生成など探索量に含まれない処理もあるので、要求全体の CPU 上限と応答時間は別途評価します。

## 応答・連続実行・メモリ

時間は Worker 外のローカル HTTP クライアントによる実測。各時計モードは新しい Workerd process で実行しています。

| 項目 | 通常時計 | 固定時計 |
| --- | ---: | ---: |
| 小問題初回 HTTP（各1標本） | 92.36 ms | 79.55 ms |
| 上記の Wasm 初期化（ローカル内部時計・参考） | 13 ms | 9 ms |
| warm 小問題25 solves / 1 HTTP | 36.33 ms | 45.47 ms |
| 難問標準予算 / 1 HTTP、20回平均 | 120.13 ms | 118.76 ms |
| 同最小–最大 | 117.14–134.59 ms | 115.82–134.98 ms |
| 難問後の小問題25 solves / 1 HTTP | 15.31 ms | 14.98 ms |
| 同一 instance の連続実行 | 74 solves / 26 HTTP | 74 solves / 26 HTTP |
| 全標本の Wasm 線形メモリ容量 | 33,554,432 bytes | 33,554,432 bytes |

各モードで初回だけ初期化し、後続25 HTTP要求では同じ instance を再利用しました。不正な予算、旧 `timeLimitMs`、repeat、ケース・時計指定など12件ずつは全て400で拒否しました。15秒の外部 watchdog による打ち切り、solver error、shared memory、後続小問題の不一致はありませんでした。

メモリは32 MiBの**確保容量が増えなかった**という結果です。allocator の使用中領域が増えていないこと、長期リークがないこと、isolate 全体が上限内であることは証明していません。設定の96 MiB上限もWasm instance単体の上限にすぎません。手動で同じ isolate に両時計モードを使えば2 instances分を消費します。

## 配布物・起動

- Wasm: 6,776,864 bytes、glue: 104,791 bytes。SHA-256一致を benchmark で検査済み。
- memory import 0、pthread / `wasi_thread_spawn` import なし、全実行で `SharedArrayBuffer=false`。
- `wrangler deploy --dry-run`: bundle 6,765.04 KiB、gzip 2,368.84 KiB、bindingなし。実デプロイではありません。
- `wrangler check startup`: ローカル profile 取得成功。profile区間は11.214 ms、1 sampleの粗い参考値です。Wasmは遅延初期化なのでこの区間に初回 solve / instance 化は含みません。本番のstartup値とはみなしません。
- 保存profileのSHA-256: `b5b0c0cb82875219d032da30bfd40e2e0eb82c2aed807635662a550e86c2c592`。
- PoC typecheck、lint、root format check、diff whitespace検査、benchmarkの全26チェックが成功。root lintは既存の警告のみ。現行アプリコードは未変更なので、この追試では現行アプリの全テストを再実行していません。

## 採用判断に残る条件

時計が進まないこと**だけ**を理由に断念する必要性は下がりました。以下は未達なので本採用はまだ判断しません。

1. 対象アカウント・検証用Worker・プラン・CPU設定を確認後、限定デプロイで同じ試験を通す。実 CPU time / wall time / resource-limit failures を測る。
2. 実際の最大想定モデルで、探索量の超過と予算外処理を含む CPU 消費が許容内で、返る暫定解の品質が実用水準を満たす。今回の最大独立集合は現行スケジュールの品質試験ではない。
3. allocator / JS heapを含むメモリ、長期連続実行、isolate再生成、実cold start・同時要求を確認する。線形メモリ容量の一定だけでリークなしと判定しない。
4. 現行の即時202応答＋非同期処理の契約に適合できるか、別途確認する。今回のPoCはsolve完了後の同期HTTP応答であり、`waitUntil` が別スレッドになることは期待しない。現行engine・DO・UI・永続形式の変更を承認したものではない。
5. `UNKNOWN`、`FEASIBLE`、最適解、invocation強制終了を区別して扱えること、および配布に必要な推移的依存ライセンスを確認する。

想定モデルでCPU・メモリ・応答条件を満たさない、暫定解の品質が不足する、または現行契約を維持できない場合は不採用の材料になります。CPU上限による強制終了は結果返却の代替にはなりません。[Cloudflare上限・エラー仕様](https://developers.cloudflare.com/workers/platform/limits/)

このローカル測定時点では実環境デプロイは未実施でした。変更は `experiments/cpsat-workers/`、再現用の `package.json` scripts、生成物除外用のroot `.oxfmtrc.json` に限定しています。
