# SMACによる評価方針の隔離実験

実装の入口は `schedule.ts` の `SchedulePreferences`、`ScheduleEvaluation`、`replayOrderHistory`。
現行engine・DO・UI・永続形式・admin契約を変更せず、CP-SATの出力を次の状態に戻す閉ループ再生を行う。
旧native pilotは [SMAC_RESULTS.md](../SMAC_RESULTS.md)、新履歴のWASM探索は
[WASM_HISTORY_RESULTS.md](../WASM_HISTORY_RESULTS.md) に記録する。
クラウド実行は [search-worker/README.md](../search-worker/README.md) を参照。
`search-cloud.py` はローカルSMACから専用Cloudflare Workerへ求解だけを委譲し、履歴単位で並列化する。
以下の `search.py` / `wasm_transport.py` の再現手順は従来どおりローカル専用。
現在の目的はWASM CP-SATを前提とした係数探索であり、ソルバーの採否判定ではない。

## 役割分担

- `schedule.ts`: 業務制約、整数CPモデル、独立採点、実行仮説の再生をTSで記述する。
- `cli.ts`: 保存済み注文・設定を既存の入力パーサーで読み、再生に渡す。
- `native_bridge.py`: 汎用制約のprotobuf化。明示的native参照モードも提供する。業務ルールは持たない。
- `wasm_transport.py` / `wasm-bridge.mjs`: 所有するローカルworkerdで全モデルを解く。ネイティブへの代替実行はない。
- `validate-solution.mjs`: WASMが返した解ベクトルの全汎用制約を独立検証する。
- `search.py`: ローカルのSMACが内側の係数を探索。既定はWASM。外側の採点は全候補で固定する。
- `audit-histories.ts`: 新履歴のハッシュ・件数・時刻・品目解釈を監査する。
- `check-wasm.mjs`: 旧nativeモードで捕捉した同一protobufをWASMと比較するためのハーネス。

Pythonはオフライン探索・ネイティブ参照にだけ使う。既存WASMはC++製のままで、Pythonを含まない。
この段階ではTSからprotobufへの直列化もPython bridge経由。TSモデル生成を本番Workerへ組み込む実装ではない。
自然言語の解析・変更承認・設定の保存も今回の実装には含めない。

## 再現

リポジトリrootで実行。Python 3.12.13、pnpm lockfileの環境を使用する。
`uv` が必要。出力ディレクトリは毎回新しい名前にする（既存結果は上書きしない）。

```sh
uv venv --python 3.12.13 experiments/cpsat-workers/fixtures/local/tuning-venv
uv pip sync --python experiments/cpsat-workers/fixtures/local/tuning-venv/bin/python \
  experiments/cpsat-workers/tuning/requirements.lock

pnpm exec tsc --noEmit --project experiments/cpsat-workers/tuning/tsconfig.json
pnpm exec vitest run --config experiments/cpsat-workers/tuning/vitest.config.ts
node --test experiments/cpsat-workers/tuning/validate-solution.test.mjs
experiments/cpsat-workers/fixtures/local/tuning-venv/bin/python \
  experiments/cpsat-workers/tuning/test_encoding.py

pnpm exec vite-node --config tools/preflight.vite.config.ts \
  experiments/cpsat-workers/tuning/audit-histories.ts

# 新履歴: 全14探索窓、最後に未使用6検証窓。全再計画をWASMで行う。
# 実行全体の予算は例として1時間。時間切れは途中結果であり探索完了ではない。
OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 \
  experiments/cpsat-workers/fixtures/local/tuning-venv/bin/python \
  experiments/cpsat-workers/tuning/search.py \
  --output experiments/cpsat-workers/fixtures/local/wasm-histories-reproduction \
  --trials 12 --max-seconds 3600 --seed 20260909

# 短い配線試験: 混雑1窓のみ、初期値を含む2候補、検証窓はまだ開けない。
OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 \
  experiments/cpsat-workers/fixtures/local/tuning-venv/bin/python \
  experiments/cpsat-workers/tuning/search.py \
  --output experiments/cpsat-workers/fixtures/local/wasm-histories-pilot-reproduction \
  --stores 239_20260905_1745_1945 --holdout '' --trials 2 --max-seconds 600

# 捕捉したWASMモデルを新規workerdで各2回照合（ネイティブ求解を禁止）。
OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1 \
  experiments/cpsat-workers/fixtures/local/tuning-venv/bin/python \
  experiments/cpsat-workers/tuning/check-wasm-transport.py \
  experiments/cpsat-workers/fixtures/local/wasm-histories-pilot-reproduction \
  --output experiments/cpsat-workers/results/wasm-histories-repeat-reproduction.json

node experiments/cpsat-workers/tuning/summarize.mjs \
  experiments/cpsat-workers/fixtures/local/wasm-histories-pilot-reproduction \
  experiments/cpsat-workers/results/wasm-histories-pilot-reproduction.json
```

探索をせず初期値だけ再生する場合は `--baseline-only`。
`--stores` / `--holdout` は店舗番号ではなく履歴IDを指定する。同じ店舗の別日窓を取り違えない。
未指定時はmanifestの分割に従い、検証店舗を探索側へ指定すると拒否する。
`--max-seconds` は起動・初期値再生・探索・検証を含む全体予算。次のsolveの前に確認するため、
実行中の1回分など最大約45秒の猶予がある。WASM内部の探索量予算とは別物。
完了済みの履歴・候補は逐次保存し、時間切れの未完了候補は選ばない。中断後の自動再開は未実装。
`summary.status` が `complete` 以外なら、全体が完了した結果とは扱わない。

ローカルworkerdは localhost:8792 (`--port` で変更可) に所有プロセスとして起動する。
既存リスナーがある場合は使い回さず停止する。固定時計、1スレッド、探索量制限で解き、
終了・失敗時には所有するプロセスグループを片付ける。Pythonはprotobuf化のみで、
WASM経路がネイティブソルバーを生成しないことをテストしている。
`--capture 3` で小・大のモデルとWASM応答を非公開保存する。

旧native pilotを再現する場合だけ、`--runtime native --corpus docs/data_samples/kenbaiki_orders
--stores 239,247 --holdout 355,364` を明示する（初期値をSMACに含める改善により候補列は旧版と異なる）。
`check-wasm` は既存の localhost:8791 専用ハーネスを呼び、各モデルを通常時計・固定時計で各3回解く。
ローカルPoCの `.dev.vars` に `POC_AUTH_TOKEN` が必要。認証値は結果に含めない。
クラウドへのデプロイやデータ送信は行わない。

入力として次のローカルファイルが必要（取得済みのものを使い、ネットワークから再取得しない）。

- `docs/data_samples/noodle_plan_histories/manifest.json` とその全JSONL（旧モードのみ `kenbaiki_orders`）
- `experiments/cpsat-workers/fixtures/local/pos-menu-policy.json`
- `experiments/cpsat-workers/fixtures/local/admin-settings.json`

入力ハッシュ・コードハッシュ・依存バージョン・seedを `manifest.json` に保存する。
生の注文参照・計画・protobufを含む結果はgitignore済みの `fixtures/local` 内だけに保存する。
設定は採取時点の現行設定で、注文当時の設定である保証はない。
サンプル店舗コード + 1000 の承認済み対応を使用し、POS購入日時はJSTとして読む。
非麺商品を除外するが、麺の未完了品目は除外せず全件完了まで走らせる。

### 新履歴の評価対象

各履歴は120分、先頭30分が助走、中央60分が購入時刻で選ぶ評価対象、末尾30分が後続注文。
全注文を時刻順に投入し、窓の終端で未完了を捨てず、全杯が上がるまで再生する。
未来の注文は計画に見せない。助走開始以前の実厨房状態は不明なので空から始める。
購入時刻と厨房到着時刻は同一と仮定する（今回のJSONLにはイベント別の取込時刻がない）。

待ち・配置・割当変更・視覚的分散の時間積分は評価対象の杯を数える。
他の注文との関係は無視せず、次の**固定した帰属規則**を使う。

- クラスタ数: 評価対象の杯を含むクラスタ。
- 上げ負荷: ローリング窓内に評価対象の杯が含まれる場合、前後の注文も含む総slot本数で採点。
- 間隔不足: 隣接2クラスタのいずれかに評価対象が含まれる場合の不足。
- 同時上げ距離・購入順逆転: 少なくとも片方が評価対象のペア。

この規則は麺揚げ時刻が評価窓の外に移っても変わらない。窓外へ遅らせて減点を消すことはできない。
各履歴の `completedItems` は全杯数、`evaluatedItems` は評価対象杯数。
`waitSummary` は評価対象の合計・平均・p95・最大・720秒超過杯数を別途示す。
新旧コーパスで採点対象範囲が異なるため、旧スコアとの数値比較は行わない。

## 固定したモデルの意味

時刻は整数秒。距離は既存レイアウトのoctile距離 `10 max(dx,dy) + 4 min(dx,dy)`、
基準隣接距離10で正規化する。cmではない。係数は0〜10000の整数、未知キー・欠落・不正値は拒否する。
目的関数内部は10倍した整数。待ち時間の係数1は探索しない。

| 項目 | 固定した評価量 | 内側の係数名 |
| --- | --- | --- |
| 待ち | 各杯の購入〜麺揚げ秒数の和。占有2でも1杯分 | 固定1 |
| 上げ負荷 | 各異なる終了時刻tで `(t-L,t]` 内のslot本数。arms超過の最初の2本 | `liftOverflowCost` |
| 重い上げ負荷 | 同じ窓でarms+2を超えた本数。前段の費用は重ねない | `severeLiftOverflowCost` |
| クラスタ | 厳密に同一秒の終了を1回として数える | `clusterCost` |
| クラスタ間隔 | 直前クラスタの杯数別目標に対する不足秒数。最後に完了したクラスタも含める | `gapShortfallWeight` |
| 同時上げの距離 | 同時に上がる別品目間の全slotペア距離の和 | `simultaneousDistanceWeight` |
| 占有2の内部距離 | 同じ品目のslot間距離の隣接基準超過 | `multiSlotDistanceWeight` |
| 占有1の周縁選好 | 全物理slotへの距離合計D(s)について `Dmax-D(s)` | `peripheralWeight` |
| 占有2の中央選好 | 使う各slotについて `D(s)-Dmin` の和 | `centralWeight` |
| 購入順の逆転 | 購入時刻が早い杯が遅く上がる品目ペア数。同時購入・同時上げは逆転でない | `purchaseInversionCost` |
| 同注文の分断 | 品目間の最短slot距離を辺とするMSTで、隣接距離より長い辺数 | `orderFragmentCost` |
| 同注文の離れ | 上記MSTの隣接距離超過の和 | `orderDistanceWeight` |
| 割当変更 | 前回提示した未投入品目のslot集合が変わった品目数。列挙順は無視 | `slotChangeCost` |

上げ負荷の両段階はソフト制約。近接した複数の終了時刻では同じ品目が複数の窓に入ることがある。
窓長Lは採取した `liftIntervalSeconds`、目標クラスタ間隔とは別で、探索で短くしない。
間隔の初期仮説は直前の杯数1/2/3/4に対し45/75/100/120秒、以後1杯につき20秒追加。
今回のpilotは標準人員・技能の単一プロファイルのみ。人員別短縮・作業待ち行列の詳細モデルはまだない。
同注文の時間差やtable同期の罰則は追加していない。table=1を全注文の同期根拠にはしない。

全品目のslot排他、slot数と範囲、茹で時間許容域は必須条件。
調理中の開始時刻とslotは固定し、終了時刻だけを元の開始+レシピ±許容幅で調整する。
調整済みの終了を新たな許容域の中心にしない。既に到来した終了イベントは到着・再計画より先に処理する。
既に麺揚げしたクラスタへの過去・同時刻の追加はしない。

## 再生と外側の採点の仮説・制限

空の厨房から始め、到着・投入・麺揚げのたびに再計画する。
調理中の全品目+購入順で先頭6杯の未投入品目を計画し、残りも順次必ず処理する。
未来の購入は計画に見せない。投入は1杯/3秒とし、遅れて投入した杯のレシピ基準を実投入へ合わせる。
この投入間隔は実行側の固定仮説で、CPの予定開始間隔を直接制約する項はまだない。

麺揚げは**計画した時刻に完了できたものとする**。実際の取り出し・湯切り・盛り付け・運搬の遅れを測った再生ではない。
従って待ちは「実注文に対する仮説的実行結果」であり、店舗の実績待ち時間ではない。
腕の超過は負担代理指標として別途減点するが、実際の茹ですぎ秒数や後工程の滞留は推定していない。
取消・機器故障・発火済み未完了Timer・履歴開始以前からの調理は今回の入力に含まない。

外側は `defaults.json` の係数で評価対象の特徴量を採点し、全候補に同じ式を使う（旧履歴は全杯対象）。
ただし注文の分断・離れは過去の全配置のMSTではなく、**同時に調理中の品目だけ**の状態を時間積分し、
`10×分断・分 + 1×余分距離・分` に置き換える。未投入の将来提案を含む実UI全体の視覚負荷は未再現。
内側のMSTは計画対象全体を採点する近似で、この時間積分そのものを最小化しているわけではない。
初期係数も外側の換算もヒアリングなしの仮説であり、人のpainの実測・校正結果ではない。

モデル生成後の変数数Vから `min(0.2, 0.04+V/50000)` の探索量を固定式で決める。
1 worker、seed=1、壁時計上限なし。deterministic timeは秒数やCPU上限の保証ではない。
FEASIBLEを成功扱いにするが最適とは呼ばない。UNKNOWN時は安全な逐次配置を使い、その候補はSMAC側で失格相当の大きな費用にする。
不正モデル・不成立・独立検査不一致・未完了・再生の行き詰まりは例外として停止し、黙って成功にしない。

独立検査は占有・レシピ・投入済み固定・全品完了を確認する。
OPTIMALの目的値はTS再計算と厳密に照合。FEASIBLEでは返された解ベクトルから目的関数を再計算し、
補助変数の木の費用を独立MSTの最小費用へ置換した値と、TSの業務特徴量による採点の**等値**を確認する。
単に「TSの点が低いからよい」で済ませず、木の非最小性とその他の項目の一致を分けている。
また、OR-Tools 9.15で報告目的値と返された解の再計算値が違うFEASIBLEを観測したため、
`reportedObjectiveMismatches` と `maxReportedObjectiveGap` に別途記録する。原因は未解決であり正常仕様とは断定しない。
SMACの外側スコアには報告目的値を使わない。WASM照合では汎用制約すべても解ベクトルから検査する。
`check-wasm` の実行終了コード0は集計完了を示すだけで、採用可を意味しない。
結果の `objectiveContractPassed` と `productionAdoption` を確認する。
既存のWASM応答を再送せず分析するには `--analyze-only`、安全な集計だけを別保存するには
`--summary-output=experiments/cpsat-workers/results/新しい名前.json` を指定する。

SMAC HPOは12個の整数係数を探索し、各候補を指定した探索履歴すべてで評価する。
初期値を必ず候補集合に含め、最大4候補はSobol design、その後はSMACのモデルに基づく提案を使う。
従って2候補の試験は初期設計のみであり、モデルに基づく本格的な探索ではない。
racing、複数seedでの統計検定、GA/ランダム探索との優劣比較は行わない。
初期値より探索用スコアが良い候補だけを選び、最後に未使用の検証履歴で初期値と比較する。
少数試行は配線と初期挙動のpilotで、12次元の十分な最適化・全店舗への一般化を意味しない。

## 参照

[SMAC公式](https://github.com/automl/SMAC3)、[SMAC論文](https://www.jmlr.org/papers/v23/21-0888.html)、
[OR-Tools CP-SAT](https://developers.google.com/optimization/cp/cp_solver)、
[Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/)。
