# タスク1 観測ゲート

2026-09-09、ローカル検証。判定：**1.1〜1.4の観測ゲートは合格**。fake を使った計数・相関・欠測の検証に限定する。アプリの CP-SAT 有効化、実際の WASM 求解、cloud 輸送の成立は未検証である。

## 成果物

- [観測 interface と計測位置・再実行手順](../../../../src/cpsat/OBSERVATION.md)
- [純粋 codec](../../../../src/cpsat/observation.ts)、[同期記録口](../../../../src/cpsat/observe.ts)、[純粋な集計](../../../../src/observe/cpsat.ts)
- [fake interpreter と例示試験](../../../../tests/observe/cpsat.example.test.ts)、[P14 property](../../../../tests/observe/cpsat.property.test.ts)、[CLI試験](../../../../tests/observe/cpsat-cli.example.test.ts)
- [固定fixture](../../../../tests/observe/fixtures/cpsat-counts.json)、[集計CLI](../../../../tools/observe/cpsat-summary.ts)

H1は実際の `decide` が返した RequestPlan を検出した時点、H2は fake binding の呼出直前、H3は同期 fake solve の呼出直前に、同じ公開 interface `observeCpsat` を呼ぶ。実アプリの shell／solver への配線はタスク2・3・5で行う。WIPの solver を接続済みとは扱っていない。

## 条件と実測結果

基準commit・着手時のWIPは [implementation-baseline](./implementation-baseline.md) のとおり。依存関係更新なし。Vitest 4.1.9／Wrangler 4.105.0。fixture の時刻は合成値（0〜120000 ms）、mode=fake、backend=cpsat。実際の店舗・注文・Timer は一切入力していない。

| コマンド | 結果 |
| --- | --- |
| `pnpm test --project observe` | 5ファイル・71テスト成功（既存16＋新規55） |
| `pnpm test --project workers tests/core/effect-order.property.test.ts tests/core/decide.property.test.ts tests/shell/cook-scheduling.integration.test.ts tests/shell/boil-sync-persist-failure.integration.test.ts tests/shell/store-timer-broadcast-order.integration.test.ts` | 5ファイル・21テスト成功 |
| `pnpm typecheck` | 成功。型生成方法は基準状態の記録を参照 |
| 追加したTSファイルへの `pnpm exec oxlint` | エラー・警告0 |
| `pnpm lint` | exit 0、警告79・エラー0（基準状態から警告増加なし） |
| `pnpm test --project static` | 218中215成功・3失敗。下記の既存WIPとの不整合は未解決 |

新規P14は固定seed：並び替え・重複 `20260909` ×150例、codec往復・余分な値 `20260910` ×150例、中間行削除 `20260911` ×100例。fake interpreter の `decide` 素材は既存生成器の `20260626` ×30例から RequestPlan のある状態変更列を選び、Persist 先頭を検査する。要求が見つからなければ試験は失敗する。

### 件数の非空振り

| fake の条件 | 生成 | 実送出 | solve開始 | 独立した副作用の検査 |
| --- | ---: | ---: | ---: | --- |
| Persist失敗 | 1 | 0 | 0 | put を試行、binding／solve未呼出 |
| 輸送抑制 | 1 | 0 | 0 | binding／solve未呼出 |
| binding失敗 | 1 | 1 | 0 | bindingを1回呼出、solve未呼出 |
| 202受理のみ | 1 | 1 | 0 | bindingを1回呼出、solve未呼出 |
| fake完走 | 1 | 1 | 1 | H2直後にbinding、H3直後にsolveを1回呼出 |

固定fixtureは2つのDO instanceを含み、同じdecision文字列もinstanceで区別する。全区間の結果は**生成2・送出1・求解0・Persist失敗1・construct2**。1分ごとの生成数は1／1。construct理由は合成のhibernation1／unknown1であり、実際の復帰の観測結果ではない。再送分類は不明1件で、既知の再送0を「再送なし」と報告しない。

生成・送出・受理・求解開始・求解終了・採用判断の中間行をそれぞれ消す負例は、broken-causal-link と counts=null になる。CLIでも `d-2` を除いた一時fixtureで exit 1 を確認する。一時ファイルはテスト後に除去し、共有fixtureを変更しない。

重複／逆順、複数solver invocation、ID衝突、別request、版不一致、Persist失敗後の送出、prepare失敗後の求解、保存失敗後の配信も検査する。後のDO invocationに届いた同じrequestの棄却は、元の採用判断と別に計数する。

### 欠測と時刻

sampling・保持範囲・取得範囲・exportComplete・gapが不明／不完全なら観測0と総数不明を分ける。直接probeは生成0としてfake／liveと別集計。未設定の稼働頻度上限を設定済みと扱わない。

予定serveAt=1000が共通でも、実効endTime=1100／1200、自動boiledAt=3000が共通となるfixtureをcodecで保持する。予定クラスタ・終了予定・まとめ発火を混同せず、Completeの追加欄は拒否する。実Timerへの接続は未実施。

platform invocationのCPU 0とclock-not-advancingによる欠測は別。waitUntil終端を含む上界と、単なるinvocation-end／exact指定の不適切な組を区別する。実CPU・wall time・メモリ・waitUntil余裕の測定ではなく、欄の意味と不正表現の検査である。

## 再実行

```sh
pnpm test --project observe
pnpm exec vite-node --config tools/preflight.vite.config.ts tools/observe/cpsat-summary.ts tests/observe/fixtures/cpsat-counts.json
```

正例のCLIはexit 0、usableForRates=true。これは「観測件数が利用できる」であって「solverが成功した」ではない。末端行・要求一式の丸ごと欠落は相関だけで検出できないため、取得側のcoverage証明が必要。その仕組みの実環境接続もタスク2で検証する。

## 検証時のSHA-256

| ファイル | SHA-256 |
| --- | --- |
| src/cpsat/observation.ts | `9fb1d7de691949a6478d5031699b7c9232c4826c8409b0bb6281c32fad4ba013` |
| src/cpsat/observe.ts | `e571acf1f178fb90e603e988435a767bf271647dbcfd086e6774a5096601cc23` |
| src/observe/cpsat.ts | `042f3eac2fbf45a4ec866728571582dcc752562b9580c338c444ccc23fd1cdc3` |
| tools/observe/cpsat-summary.ts | `5953290fb46f126ad90b5896ade697981665957d5368476ba12ab80948e92a2b` |
| tests/observe/cpsat.example.test.ts | `b5d29282f08183c32ad4372899bdc40c89d03b123a71244fbb37e9fa391a3249` |
| tests/observe/cpsat.property.test.ts | `43983fdcacda4be64e00fa1916bbc8d1f48bfcf0f48ab54e657ad7bd90a7bfd0` |
| tests/observe/cpsat-cli.example.test.ts | `74f00705fef426849a64f6000d65de9decfcc26d33f8b5eb2e00352e5d9ca8e7` |
| tests/observe/fixtures/cpsat-counts.json | `0f5e6bdb84c5829113486f42e37d764f676002fca3abd30c6f839074b0e035da` |

WASM／生成JSは未使用・未変更・未再ビルド。fixtureのversionsはfake-v1相当の識別と欠測であり、過去のWASM hashやSMAC profileを実行証拠として載せていない。流用はタスク2でガイドに従って照合する。

## 残る不整合と次のゲート

J-3追記（2026-09-09）：以下はタスク1完了時点の赤い基準の記録。旧採用経路を正規engineから切り離し、3失敗は解消した。[基準状態](./implementation-baseline.md)に原因・保存先・赤→緑の再実行結果を記録している。観測モジュールや既存テストの主張を緩めたものではない。

全体の静的検査で残る3失敗は今回未変更のWIPに対するもの：

1. `offline-degradation.static.test.ts` のengineファイル集合に、既存の `src/engine/cpsat-plan.ts` が含まれない。
2. `operation-history/no-wake.static.test.ts` の純粋層閉包2件が、既存WIPから到達する `src/cpsat/request.ts` を許可していない。

今回の観測moduleは実アプリ／Operation Historyへまだimportしていない。既存 plan.ts／settle.ts のhashは基準状態と同じ。これらの制約を緩めてgreenにはしておらず、後続の組み込みで依存の実体と契約を照合する必要がある。リポジトリ全テスト成功は主張しない。

次は2.1の対象・停止条件・費用枠の確認。cloudの変更は対象提示と明示承認後だけ。F-1（3.1）は命名承認と別で未承認。2.5合格と3.1承認が揃うまでReplan・要求単独列・property改訂へ進まない。
