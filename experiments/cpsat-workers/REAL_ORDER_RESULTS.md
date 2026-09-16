# 実注文CP-SAT試験 — ローカル結果（2026-09-08）

**100局面 × 5反復 × 2時計モード = Workerd 1,000回はすべて有効解。ネイティブ500回とも一致した。**
ただし、現行計画の合流配置を一部固定した、単一卓・簡略目的関数の試験である。
「本番問題の完全移植に成功」「実環境で実注文を1,000件解いた」という結論ではない。

判断: **Wasm実行基盤の技術実証は継続可能。現行solverへの採用は保留。**
この入力範囲で時計停止や反復実行に起因する不成立は観測しなかった。次の主要な課題は
速度ではなく、現行の評価・合流選択を含むモデル化と、複数卓を含む入力カバレッジである。

現行engine・DO・UI・永続形式・本番設定は変更していない。追加デプロイも実注文送信も行っていない。
CP-SATはWorkerdのV8 isolate内で実行。Nodeは局面生成・検査・HTTPクライアントにのみ使用した。

## 入力と局面

[入力監査](REAL_ORDER_INPUTS.md)の10店舗300注文・943親品目から、現行POS解釈で359調理品目を抽出。
店舗番号+1000対応、ローカル商品表の利用はユーザー承認済み。設定は現在値であり過去営業時点の復元ではない。

- seed: `real-orders-20260908-v1`。提供された10店舗すべてを対象とし、196店舗からランダム抽出したわけではない。
- 空釜から現行 `decide` / `committedSchedule` で進行。記述されたeffectsは実行しない。
- POS申告日時をJST到着時刻として代用。1秒刻みで進め、開始操作はseedにより1〜6秒間隔、完了操作は実効終了後の最初のtick。
- シミュレーションで359品目すべての完了を確認。途中の候補1,116局面から店舗別hash順位で各10局面、計100局面を抽出。
- 96局面が調理中Timerを含む。待ち品目1〜14、調理中Timer最大10。全注文 `table_no=1` のため複数卓競合は未検証。
- 同じseed・入力で局面を再生成し、ファイルSHA-256の一致を確認。
- CP-SATの解を次のシミュレーション状態には戻していない。**現行engineで生成した局面への点ごとの試験**であり、CP計画に従って営業を完走した試験ではない。

局面ファイルSHA-256: `1ef1641432e83a2925df537fbaa492ff6c776daa2fe7ee77477d98b826dfe6d9`。
設定・原本・コード・Wasmのhashは [機械可読の集計](results/real-order-local-summary.json) に保存した。

## モデルの範囲

PythonでCP-SATモデルを一度構築し、同一protobuf bytesをネイティブとWasmへ渡した。
`num_workers=1`、`random_seed=1`、`max_deterministic_time=0.05`。壁時計によるsolver打ち切りは使わない。

- 各待ち品目の開始・終了時刻（基準時刻からの整数ms）と、必要本数分の物理slot選択を変数とする。
- 店舗別の茹で時間、現在Timerによるslot解放時刻、slotごとの非重複を制約にする。
- 上げ窓は終了から一定長の区間に必要本数を載せた累積容量制約。既存Timerの上げも含む。
- 調理中の卓仲間より許容範囲を超えて早く終了しない下限を課す。
- **baselineが合流先を持つ91配置は、開始とslotを固定**する。48局面がこの固定を含む。
  100局面のうち30局面は全配置が固定、70局面は自由な配置を含む。自由配置は延べ359、全配置は延べ450。
- 全配置のbaselineをヒントとして与える。既知の有効計画を持たない状態からの発見能力は測っていない。
- 最小化は `Σ(serveAt − now)`。**現行の注文・卓・距離・上げ・表示変更を含む総合評価の完全移植ではない。**
- `keepsAnchor` の全手続きをCP制約へ移植していないため、solverの `FEASIBLE` を現行制約適合と同一視しない。
  解を戻した後、現行関数で独立検査する。検査NGをbaselineへの置換で隠す処理はない。

これはモデル転送・実行・検査までの縦断試験であり、汎用スケジューラ完成版ではない。
区間変数による占有モデルの参考: [OR-Tools job shop](https://developers.google.com/optimization/scheduling/job_shop)。

## 実測

| 実行先 | 回数 | OPTIMAL | FEASIBLE | 無解・不正解・要求失敗 |
| --- | ---: | ---: | ---: | ---: |
| Native 9.15.6755 | 500 | 350 | 150 | 0 |
| Workerd 通常時計 | 500 | 350 | 150 | 0 |
| Workerd Wasm時計固定 | 500 | 350 | 150 | 0 |

独立問題数は100。上の反復を1,500種類の問題と数えない。各環境で70局面は最適性証明、30局面は予算内の暫定解。

検査したこと:

- `toCookSchedule` の形、全品目の過不足・重複、slot本数、茹で時間、現在・将来の占有。
- 現行 `isStale` / `feasibleRelease` / `withinLiftCap` / `keepsAnchor` が全1,500解で通過。
- 目的値の再計算、boundの向き、固定配置の保持、整数・Bool値の整合。
- 反復間および環境間でstatus・全変数解・目的値・bound・branches・conflictsが一致。
  deterministic消費量の環境差最大は `5.42e-20`（浮動小数点丸め差）。
- 各時計モード500要求でisolateは1つ、Wasm初期化は1回。別局面の結果が混ざる事象なし。
- 固定時計では各solveで時計import呼出し263〜221,212回、solver壁時計値0のまま復帰。
- 予算0.05に対する消費最大 `0.05357688177913564`。約7.2%超過は協調的停止の観測値で、一般上限ではない。
- 故意に壊した計画709件を棄却。欠落・重複・時間・slot・偽の合流先・重複占有に加え、上げ集中44件を含む。
- 不正認証401、メソッド405、空/1MiB超のbody413、予算0で400。壊れたprotobufは500で復帰し、その後の固定小問題が成功。
  壊れたprotobufの500は診断用ローカル経路の現状であり、公開API品質を満たしたという判定には使わない。

現行の `admit` と総合採点で「改善案として採用」されたのは **16/100局面**（各環境80/500回）。
残り84局面の有効性検査は通っているが、改善ゲートは通らない。制約適合と改善価値は別の評価である。

## メモリ・応答（参考、今回の合否には使用しない）

| 項目 | 通常時計 | 固定時計 |
| --- | ---: | ---: |
| Workerd起動〜health（ms） | 733.5 | 817.6 |
| 最初の有効solve HTTP往復（ms） | 253.4 | 262.5 |
| 初回Wasm初期化（内部計時ms） | 8 | 8 |
| warm HTTP中央値 / p95 / 最大（ms） | 3.24 / 362.30 / 756.38 | 2.86 / 328.32 / 575.53 |
| Wasm線形メモリ容量、全回 | 32 MiB | 32 MiB |

Wasmは6,778,146 bytes、pthread importなし、共有メモリなし。メモリは初期32MiB・上限96MiB。
容量不変はallocator使用量・isolate全体のピーク・リーク不在の証明ではない。
ローカルWorkerdの値を本番CPU時間やcold-start SLOへ読み替えない。
15秒のクライアントwatchdogはハング検知用であり、同期Wasmの停止機構ではない。

## 再現

リポジトリrootで実行。提供された注文JSONLと承認済み設定原本が必要。`fixtures/local/` と注文原本はGit対象外で、
顧客・注文データや認証値を公開成果物へ含めない。取得方法と固定したPolicy hashは [入力監査](REAL_ORDER_INPUTS.md) を参照。
Wasmビルド・依存関係の前提は [README](README.md)。

```sh
node experiments/cpsat-workers/scripts/init-secret.mjs
pnpm poc:cpsat:build
pnpm poc:cpsat:types
pnpm poc:cpsat:typecheck

pnpm exec vite-node --config tools/preflight.vite.config.ts \
  experiments/cpsat-workers/scripts/prepare-real-scenes.ts real-orders-20260908-v1 10

uv run --with ortools==9.15.6755 python experiments/cpsat-workers/native/real_orders.py \
  --scenes experiments/cpsat-workers/fixtures/local/real-scenes.json \
  --output experiments/cpsat-workers/fixtures/local/native-real.json \
  --count 100 --repeat 5 --budget 0.05

node experiments/cpsat-workers/scripts/benchmark-real-orders.mjs

pnpm exec vite-node --config tools/preflight.vite.config.ts \
  experiments/cpsat-workers/scripts/check-real-orders.ts \
  experiments/cpsat-workers/fixtures/local/native-real.json \
  experiments/cpsat-workers/fixtures/local/worker-real.json

node experiments/cpsat-workers/scripts/summarize-real-orders.mjs
```

生成される `native-real.json` / `worker-real.json` / `real-checks.json` は全反復の生結果を保持する。
追跡対象の `results/real-order-local-summary.json` は原本のhash・集計・再現条件のみ。
seedを変える場合は先に前回の派生成果物を別名で保存する（原本は変更しない）。
実行時間を含む結果ファイル全体のhashは再計測で変わる。局面・model bytes・解・探索統計を比較する。

`benchmark-real-orders.mjs` は127.0.0.1:8791を使い、起動したprocess groupだけを終了する。
remote URL指定やデプロイ機能はない。追加した `/solve-model` もローカルhostname限定・Bearer必須。
1MiB body / 8,192変数 / 40,000制約の上限は事故防止用で、許可範囲のすべてを検証したわけではない。

## 残る判断材料

1. 現行目的関数・合流選択のモデル化。固定91配置を外しても現行ゲートを通るか。
2. 複数卓、最大待ち件数、取消・再送・中断・釜操作遅延などを含む局面追加。
3. CP計画に従う閉ループでの完走と、状態変化後に返った古い解の扱い。
4. 対象と変更内容を確認したうえで、隔離Workerへ実注文モデル対応版を追加デプロイし、実環境で再試験。

今回の変更で現行サービスへ接続していない。以前のデプロイ済み固定問題版と今回のローカル版を区別する。

## 実装の検査

追加CLIのstrict型検査、PoC Workerの型検査、oxlint、oxfmt、`git diff --check` が通過。
再利用したPOS解釈・識別子・計画・上げ制約の既存8ファイル134テストも通過した。
拡張後のWasmで固定問題の148 solvesを再実行し、従来の一致・打ち切り・メモリ・認証・境界検査が通過。
記録は [固定問題の回帰結果](results/deterministic-model-runtime-local.json)。
