# CP-SAT WASM の流用ガイド

確認日：2026-09-09。目的は、検証済みのバイナリを失ったり、TS 側の条件変更のたびに C++ を作り直したりする手戻りを防ぐこと。

**通常は `vendor/` の WASM と対になる生成 JS をそのまま使い、C++ の再ビルドから始めない。** この版は固定問題専用ではなく、`caseId=3` で `CpModelProto` を受け取れる。報酬・ペナルティ、固定 Timer、即時占有などは TS が生成するモデルに表現できるため、既存 proto・演算・資源上限の範囲なら同じ WASM を使える。新しいモデルの正しさの検証は別途必要である。

## 1. 流用する成果物を特定する

次のファイルを一組として扱う。ファイル名が同じでも内容の一致を確認する。

| `vendor/` 内のファイル | バイト数 | SHA-256（確認日の内容） |
| --- | ---: | --- |
| `cpsat_workers_poc_runtime.wasm` | 6,778,146 | `c8b89a734a15ad067e18edd08fc58d179aff63bf9922080e75fbeeecfb0223a1` |
| `cpsat_workers_poc_runtime.js` | 105,008 | `9aa103e134a4dcc5810a589dc008dc5b1c3f4d46114df05e08f4799f2b97eda8` |
| `cpsat_workers_poc_runtime.d.ts` | 694 | `d169f6170a45104b4d1139979b9c7f6c96c426062417dd82e0d0711aad0e4e7e` |

[SHA256SUMS](vendor/SHA256SUMS) は WASM／生成 JS の2ファイルを検査する。`.d.ts` は TS 側の呼出契約であり、C++ のビルドスクリプトが自動更新するファイルではない。別ビルドの `.wasm` と `.js` を組み合わせず、生成 JS の手編集で互換問題を隠さない。

現在の WASM ハッシュは、[モデル対応後の固定問題回帰](results/deterministic-model-runtime-local.json) の `artifacts.sha256`、[クラウド探索の事前検証](results/search-cloud-check-20260909.json) の `runtime.wasmSha256` と一致する。後者は37正常求解のローカル WASM との照合記録であり、新しい組み込み全体を検証済みという意味ではない。[結果の範囲](CLOUD_SEARCH_RESULTS.md)も参照する。もっと古い PoC の結果・バイナリと取り違えない。

### バイナリを失わないための保存単位

- 上記3ファイル、`SHA256SUMS`、このガイド、[C++ wrapper](cpp/cpsat_workers_poc.cc)、[patch](patches/or-tools-wasm-single-thread.patch)、[build script](scripts/build-wasm.sh)、[OR-Tools ライセンス](LICENSE-OR-TOOLS)を一緒に保持する。依存ライブラリのライセンス表示も移動・配布時に落とさない。
- 確認日時点で `vendor/` はこの作業ツリーに存在するが、Git 未追跡である。ガイドを書いたことをコミット／リモート保存済みの保証にしない。成果物をコミット・引き渡す際には、ガイドだけでなくこの一組も保存対象に含める。今回コミット・push・外部アップロードはしていない。
- 本実装へ配置を移す場合も内容ハッシュを維持し、移動先・import・検査コマンドを同時に更新する。移動先での検査と保存を確認するまで、`experiments/` を不要な実験物として削除しない。
- source／build の一時ディレクトリや `.wrangler` キャッシュは成果物の保管場所にしない。バイナリが欠けたら、まず保存済みの同じ一組を復元する。別版を同名で置いたり、`SHA256SUMS` だけ再生成して「検査済み」にしたりしない。

## 2. 最初に行う、再ビルド不要の検査

リポジトリ root から実行する。CMake・Emscripten・Python・秘密値・クラウド接続は不要。Node はファイルと WASM の構造を検査するためだけに使い、Node 上で Workers の求解を再現する手順ではない。

```sh
(
  cd experiments/cpsat-workers/vendor
  shasum -a 256 -c SHA256SUMS
)
shasum -a 256 experiments/cpsat-workers/vendor/cpsat_workers_poc_runtime.d.ts
pnpm poc:cpsat:inspect
```

期待結果：

- WASM と JS は両方 `OK`。型定義のハッシュは第1節と一致。
- `byteLength=6778146`、`importedMemoryCount=0`、`importsPthreadRuntime=false`、`exportsSolver=true`、`exportsMemory=true`。
- export に `cpsat_solve`／`malloc`／`free`／`memory` が存在する。生成 JS 経由の関数名には先頭の `_` が付く。

**この検査は確認日に実行して通過した。** 求解・初期化・全モデルの正しさ・cloud の時間枠まで確認する検査ではない。特に inspect は import／export の構造検査であり、単独で shared memory 不使用やメモリ上限内の完走を証明しない。初期化後の `sharedWasmMemory=false` と実測は実行検証側で確認する。

## 3. 呼出契約：モデルは protobuf、戻り値は JSON

呼出とメモリ所有権の既存例は [src/runtime.ts](src/runtime.ts)、C ABI の正本は [cpp/cpsat_workers_poc.cc](cpp/cpsat_workers_poc.cc)。以下は現在のバイナリの契約である。

```ts
// Emscripten の生成 JS を通した既存の呼出形。
wasm._cpsat_solve(caseId, deterministicLimit, modelPointer, modelByteLength);
```

| 項目 | 契約 |
| --- | --- |
| `caseId=0` | 固定小問題。期待値は `OPTIMAL`、目的値5、解 `[2,1,0]` |
| `caseId=1`／`2` | 固定難問／探索段階の打ち切り fixture。`2` の presolve 無効等を通常モデル設定へ持ち込まない |
| `caseId=3` | `CpModelProto` の生バイト列を求解。注文 JSON、TS の中間表現、base64 文字列そのものは渡さない |
| `deterministicLimit` | 有限の `0 < 値 <= 1`。C++ の受付範囲であり、アプリ／探索 Worker が許可する予算とは別。秒数ではない |
| C++ 内の固定設定 | `num_workers=1`、`random_seed=1`、wall-time limit は既定の無限大。引数から変えられるのは探索量予算で、任意の `SatParameters` を受け取る ABI ではない |
| 入力上限 | protobuf は1〜1,048,576 bytes、変数8192以下、interval を含む proto の constraints 40000以下 |
| WASM メモリ | build 設定は初期32MiB・最大96MiB、growth 有効。この上限は全 JS heap や invocation 全体の資源上限ではない |
| 戻り値 | WASM heap 上の NUL 終端 UTF-8 JSON を指すポインタ。`CpSolverResponse` の protobuf ではない |
| 成功候補 | `status` が `OPTIMAL` または `FEASIBLE`。`solution` はモデル変数インデックス順のベクトル。配置への復号・制約検証は TS 側で行う |
| 解なし／入力不正 | 解なしの `objective` は `null`、`solution` は空。wrapper の拒否は `{error: ...}` で `status` がない場合がある。ポインタ0も失敗として扱う |

呼出側は `_malloc` で入力を確保し、その後の最新の `HEAPU8` にコピーする。同期呼出から戻ったら入力を解放し、戻り値は `UTF8ToString` で JS へコピーしてから、JSON parse の成否にかかわらず `_free` する。trap／例外でも確保済み領域を回収し、壊れた instance を再利用しない。memory growth 前の TypedArray view を使い続けない。

モデルは WASM が読む OR-Tools 版の proto に合わせる。未対応のフィールドや constraint が無視されたまま parse に成功する可能性を「モデル互換」と扱わない。TS codec の対応と独立検証が必要であり、JSON の整数にも JS で正確に扱える範囲の検査を残す。報告目的値は独立採点と照合し、既知の FEASIBLE の報告差・補助変数の余裕と不正配置を分ける。

## 4. どの変更なら同じバイナリを使えるか

「再ビルド不要」は「再テスト不要」ではない。Workers の JS／TS bundle の再作成と、C++→WASM の再ビルドを区別する。

| 変更 | 現 WASM | 必要な確認 |
| --- | --- | --- |
| 待ち・E1〜E9の係数、クラスタ間隔 | 流用 | TS profile／モデルと独立採点。係数・profile の識別情報を更新 |
| 固定 Timer、レシピ、G-1 の即時占有などモデルの条件 | 既存 proto の演算・上限内なら流用 | TS モデル・codec・独立参照を照合。旧モデルの成績は自動継承しない |
| 対象選択・探索量の算式・上限の引下げ | ABI の受付範囲内なら流用 | 入力・予算・CPU／メモリ／応答を再検証。対象範囲の拡大は spec も確認 |
| DO callback、認証、観測、要求抑制、配置先、CPU 設定 | 流用 | JS／TS／配備設定の検証。輸送成立・資源枠を再測定 |
| Worker の互換日付・flags、Wrangler 更新 | まず同じ WASM／JS で検証 | 第5節の生成 JS の環境判定・import・時計を確認 |
| seed、presolve 等を外から指定する新しい ABI、返却項目、C++ の上限変更 | wrapper 変更と再ビルドが必要 | ABI・型・入力検証・回帰・成果物の識別情報を更新 |
| 最大線形メモリ、link flags、Emscripten、OR-Tools fork／proto の更新 | 別ビルドとして扱う | JS と WASM をセットで作り直し、全該当回帰と新ハッシュを保存 |
| pthread／shared memory 化 | 今回の単一スレッド設計外 | 流用・再ビルドの小変更として進めず、要件・設計へ戻す |

上限超過・`UNKNOWN`・目的値差・起動失敗が出ても、最初の対応を再ビルドや上限引上げにしない。モデル、codec、入力予算、JS の環境判定、受理／求解の分離、プラットフォーム終了のどこで失敗したかを先に識別する。

## 5. Workers 側の接続で忘れやすい条件

### 生成 JS と事前コンパイル済み module を組み合わせる

既存 runtime は `.wasm` を module として import し、生成 JS の `instantiateWasm` に渡された import object で `new WebAssembly.Instance(module, imports)` を作り、`receiveInstance` へ通知する。生成 JS が提供する例外処理・WASI の import を独自の空 object に置き換えない。WASM の HTTP 配信や Node のファイル読出しをオンラインへ追加する必要はない。[Workers の WASM 読込み仕様](https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/)

### Node の環境判定を回避する

この生成 JS は `ENVIRONMENT=worker` でビルドされている。冒頭で `process.versions.node` を見るため、Node 互換のある環境では `not compiled for this environment` で拒否する。[探索 Worker の記録](search-worker/README.md)では、WASM／生成 JS を変更せず、専用 solver の互換設定で解消している。

2026-09-09確認の公式仕様では、互換日付 `2026-08-04` 以降は Node 互換が既定で有効になる。無効化には正のフラグを外し、`no_nodejs_compat` と `no_nodejs_compat_v2` の両方を使う。[互換フラグの仕様](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#nodejs-compatibility-flag)

これは **専用 solver Worker の確認事項**。同居する既存アプリの Node 依存を調べずに flags を一括変更しない。現行の探索設定・組み込み途中の設定・固定問題 PoC は日付や CLI 版が異なる。実際の対象設定と対応する CLI で検証し、古い CLI のフラグエラーを WASM の不良と誤診しない。

### 時計・instance・輸送を分ける

- 時計固定は C++ を再ビルドせず、初期化時から `env.emscripten_get_now` と `wasi_snapshot_preview1.clock_time_get` を差し替える。既存 runtime は時計 import の名前集合が変わると失敗する。この検査を黙って解除せず、変更時は固定される時計の範囲を再確認する。
- PoC runtime は host／frozen ごとに instance を持てるが、本組み込みへ2 instance の運用をコピーしない。承認済み設計の frozen 1 instance、遅延初期化、失敗後の再初期化、最大1求解・有界な busy を守る。WASM／生成 JS の流用と、PoC の TS キャッシュ実装の無条件コピーは別である。
- `solve()` は同期呼出である。WASM を別 Worker に import したことだけで、202受理・DO 操作の非ブロック・callback 完走が保証されたとはしない。既存 `src/cpsat/` の組み込み途中のコードも、そのまま検証済み adapter と扱わない。

## 6. 再ビルドが必要になったときだけ使う手順

現行 [build-wasm.sh](scripts/build-wasm.sh) の固定入力：

- fork：`https://github.com/Axelwickm/or-tools-wasm.git`
- revision：`e1453348bc43d3b0afc0c2e5a535f5c9b45326f4`
- Emscripten：`4.0.20`、Release、target：`cpsat_workers_poc_runtime`
- patch で pthread／shared-memory の link flags を使わない専用 target を作る。単に上流の配布版へ `num_workers=1` を渡す方法では代用しない。
- native の参照版：`ortools==9.15.6755`。参照はオフラインのみで、fork と同一ビルド／探索経路の保証はない。

確認日のビルド入力の SHA-256 も残す。これは**現在のソース内容の記録**であり、完全なビルド環境の attestation や、再ビルドの byte-for-byte 一致保証ではない。

| 入力 | SHA-256 |
| --- | --- |
| `cpp/cpsat_workers_poc.cc` | `f62cf6895df573ad55925f6e935f8dfc084dbcea59ee4264185f55f208db21c4` |
| `patches/or-tools-wasm-single-thread.patch` | `cbef8b24e07c3b93d83426b2439432c126967117626236df350979eb0c46292b` |
| `scripts/build-wasm.sh` | `a74264bdc69c3779eea37faa91a1d11f5cb1e650fed8f3dba7e2192ac6a7eed5` |

1. 再ビルドする理由と ABI／モデル／資源の変更範囲を記録し、現行 vendor 一式と結果を復元可能な場所に保存する。別の作業コピーでのビルドを優先する。
2. Unix 系環境・Git・CMake 3.31以降・C/C++ build tools とビルド依存を用意する。固定 fork・patch・wrapper を使い、上流の最新へ無断で置き換えない。
3. source／build tree を再利用する場合は `CPSAT_WASM_SOURCE_DIR`／`CPSAT_WASM_BUILD_DIR` に確認済みの専用パスを指定する。toolchain や設定が違う cache は混ぜず、新しい build directory を使う。既定の一時ディレクトリが残っていることを前提にしない。
4. 次を実行する。**このスクリプトは `vendor/*.wasm`・`vendor/*.js`・`vendor/SHA256SUMS` を上書きする。ガイドを読むため／通常の組み込みのために実行するコマンドではない。**

   ```sh
   pnpm poc:cpsat:build
   ```

5. 新旧のハッシュ・import／export・ABI・メモリ設定を比較する。型定義は必要な差分を別途更新し、旧結果は残す。新しいハッシュなら、同じファイル名でも別成果物として記録する。
6. 固定小問題／難問／時計固定／汎用 model 入力／無効入力後の回復／連続メモリを workerd で再検証する。モデル／codec を変えた場合は native・Python bridge との照合も行う。再ビルドだけで cloud 検証・有効化を省略しない。

過去のローカル回帰の入口は [README の再現手順](README.md)と [benchmark.mjs](scripts/benchmark.mjs)。再測定には新しい `--output` を指定して既存結果を残す。これらはローカル検証でもプロセス起動・結果ファイルの作成を伴うため、第2節の読み取り検査とは区別する。remote URL を付けることやデプロイは、対象と変更範囲の確認後にだけ行う。

## 7. spec／tasks への引き継ぎ

[design 第8節](../../.kiro/specs/cpsat-planner-integration/design.md)と [tasks](../../.kiro/specs/cpsat-planner-integration/tasks.md) の順序を変更しない。

- **Task 2.2**：第2節の検査後、既存 WASM へ固定 protobuf を渡して輸送検証をする。新しい C++ モデルや再ビルドを前提にしない。
- **Task 5.4〜5.6**：既存 WASM と proto／ABI に合わせてオンライン TS model・codec・独立検証を作る。業務条件の変更とバイナリの変更を分ける。WASM が同じでもモデル同値性・係数の妥当性は未検証のままである。
- **Task 7.7**：引き渡し manifest に WASM と生成 JS の両ハッシュ、型／ABI、モデル・codec・profile・予算・入力の識別情報、実際の配備版、保管先を残す。

このガイドの追加で Task 1・2 のゲートや F-1 の再確認を完了にしない。確認日に実行したのはハッシュと WASM 構造の読み取り検査であり、再ビルド・新たな求解・デプロイは行っていない。
