# 実装着手時の基準状態

2026-09-09。ユーザーの実装開始指示に基づくローカル確認。タスク1の準備であり、1.1〜1.4の完了証拠でも cloud の輸送証拠でもない。

**J-2補記：着手時の基準は赤だった。** 下表の部分実行の成功と、既存WIP由来の静的検査3件の失敗を分けて記録する。J-3対応では検査を緩めず、退けたWIP経路を切り離してこの3件を解消した（後述）。初期状態のハッシュ・失敗記録は消さない。

## 出所と範囲

- HEAD: `a46f277562a5d994844e9d2c07688344b64d17b0`。未コミットの変更があるため、この commit だけでは試験状態を再現しない。
- 着手前から `.gitignore`、既存 spec、`.oxfmtrc.json`、`package.json`、`src/engine/plan.ts`、`src/engine/settle.ts`、`wrangler.jsonc` が変更済み。CP-SAT spec、`CONTEXT.md`、`experiments/`、`src/cpsat/`、`src/engine/cpsat-plan.ts`、`wrangler.cpsat-planner.jsonc` は未追跡の既存成果物だった。これらの内容を破棄・完成扱いしていない。
- この準備で変更した実行設定は `vitest.config.ts` のみ。既存の `CPSAT_SOLVER` binding に対応するローカル代役を追加した。代役は常に503を返し、受理・求解・callback 成功を偽装しない。
- Wrangler 4.105.0、Vitest 4.1.9。依存関係・lockfile の更新なし。生成した型ファイルは既存の ignore 対象で、手編集していない。
- アプリの計画器・DO・UI・永続形式、WASM／生成JS、Effect 契約は変更していない。デプロイ・クラウド要求・実データ入力・求解は実施していない。profile／モデル／WASM の版による求解証拠はこの確認にはない。

## 復旧したローカル検証環境

最初の `pnpm typecheck` は Workers の生成型不在で失敗した。次の順で再生成すると成功する。CP-SAT 側ではアプリの設定も渡し、別 Worker に定義された StoreTimerDO の RPC 型を解決する。CP-SAT の設定だけで生成すると `deliverPlan` の型が失われる。

```sh
pnpm cf-typegen
pnpm exec wrangler types src/cpsat/worker-configuration.d.ts --config wrangler.cpsat-planner.jsonc --config wrangler.jsonc --env-interface CpsatPlannerEnv --include-runtime false
pnpm typecheck
```

Workers テストの初回起動は、`yude-men-cpsat-planner-dev` の未登録で失敗した。既存 binding は削除せず、`vitest.config.ts` の補助 Worker として503の代役を登録した。これはタスク1.2の観測付き fake adapter ではない。

## 実行結果

| コマンド | 結果 | この結果が保証しないこと |
| --- | --- | --- |
| `pnpm typecheck` | 型生成後に成功 | 実行時の計画品質・cloud の動作 |
| `pnpm test --project observe` | 2ファイル・16テスト成功（変更前後） | 新しいCP-SAT観測の実装・P14成立 |
| `pnpm test --project workers tests/core/effect-order.property.test.ts tests/core/decide.property.test.ts` | 代役登録後、2ファイル・5テスト成功 | F-1の新しい例外・Replanの検証 |
| `pnpm lint` | exit 0、警告79件・エラー0件 | 警告解消。既存の警告は今回修正していない |
| `pnpm exec oxfmt --check vitest.config.ts` | 成功 | 全体の整形。全体整形は実施していない |
| `pnpm test`（Jレビュー側の報告、こちらの初期全件実行ではない） | 2ファイル3件失敗／264ファイル2001件成功 | 全件green。以下の3失敗を含む |
| `pnpm test --project static tests/offline-degradation.static.test.ts tests/operation-history/no-wake.static.test.ts` の `offline-degradation.static.test.ts`：`src/core のファイル集合が確定集合と一致する` | J-3修正前に再現。`src/engine/cpsat-plan.ts` が期待集合に対して1件余分。今回の作業ツリーでは期待31・実際32ファイル | 単に import を外すだけでは解消しない。J-3で当該ファイルを実行対象外へ保存して解消する |
| 同コマンドの `no-wake.static.test.ts`：`推移 import graph を純粋層だけに閉じ、platform・下流 client を取り込まない` | J-3修正前に再現。`plan.ts`／`settle.ts` → `cpsat-plan.ts` → `src/cpsat/request.ts` がProducerの許可された純粋層外へ到達 | J-3で呼出分岐・import・`SettleParams.planner` を外して解消する。許可リストを拡張しない |
| 同コマンドの `no-wake.static.test.ts`：`graph が Operation History 固有の純粋層と同期終端だけに閉じる` | J-3修正前に再現。同じ推移importによる純粋層外への到達 | 同じJ-3対応で解消する。正しい新経路は3.5／6.1以降で改めて検証する |

既存 property の主張・生成器は無変更。生成件数は各ソースの既定（300／200）を使用し、要求を含む場面の非空振り確認だけは既存の固定 seed `20260626`。その他の実行 seed は保存していないので、これを固定 seed の新規受入証拠としない。テスト全件の実行ではない。

最後の文は初期のこちら側の実行範囲を指す。J-3修正前の上記2ファイル再実行は **3件失敗・40件成功（43件）**、2026-09-09 22:21 JST。ユーザーレビューの全件結果と、こちらが実際に再現した部分実行を混同しない。基準を赤にした変更は既存WIPであり、タスク1の観測モジュールや2.2の固定solverが導入した回帰ではない。

今回の検査対象に含む作業ツリーの SHA-256:

| ファイル | SHA-256 |
| --- | --- |
| `vitest.config.ts`（代役登録後） | `95b19de4d07e2acbc4c5b27d2f4893e2c3754699ad88adbfb54c254143849f4f` |
| `src/engine/plan.ts`（既存WIP） | `7ab0b5f9a42ad423827a34ed5d8df674dca9b6ecf26fba05fbca3a70dc2c2fba` |
| `src/engine/settle.ts`（既存WIP） | `95279fffc877a42e6d79f4ae7a26687f3221709d00f1c2fda74687f395a953c3` |
| `tests/core/effect-order.property.test.ts` | `9c8ac920a2f429c12a0d5d64ad88000d34d6d90f8f762d19879dc03c3a502296` |
| `tests/core/decide.property.test.ts` | `a9215e7f3c27ab093264c716920024a1ab09318d14ac2395955e9a158bcadfa5` |

## J-3：退けたWIP経路の切り離し（2026-09-09）

- `src/engine/plan.ts`／`settle.ts` の `cpsatSchedule` import・`params.planner` 分岐・`SettleParams.planner` を除去した。両ファイルはHEADと同一に戻り、現時点の正規engineにはCP-SAT採用経路が無い。
- 呼出を外すだけではファイル集合の失敗が残るため、元の `src/engine/cpsat-plan.ts` は [実行対象外の原文](./archive/cpsat-plan.ts.txt) へ移した。移動前後のSHA-256は `1c1d88dc7b20d581afef64570e50ab1c40a61b8439316ae0453e16353d456a68` で一致する。破棄ではなく保存であり、WASM・生成JS・実験・観測・固定solverは変更していない。
- これはCP-SAT実装の完了や新たな設計判断ではない。tableId由来の錨／群を採用しない既決事項に合わせた撤去である。task 3.5／6.1以降で承認済みdesignどおりに作り直し、この旧経路をそのまま再接続しない。
- 修正前後とも `pnpm typecheck` 成功。`src/cpsat/*` から削除した引数・分岐への必須結合はない。
- 同じ2ファイルの静的テストは修正後 **43件すべて成功**（22:22 JST）。テスト自体のSHA-256は前後同一：offline=`f8dfcd76c18786ac9f88bf945d32e399c1083c7c6187278e5e6596191ccf9177`、no-wake=`0815fea093047247aa3303314ce2fd46ff63540666595f0d1b7f8cff37f5851d`。検査の削除・skip・期待集合／許可層の緩和はない。
- 修正後のSHA-256：plan=`3f8446c662d4e9822fcc2b089f4d104711d4eb2a2358f75a6f8c6196c953fa48`、settle=`adcedabf83f2058d34f342598aada445da299bd0eacd94b436c98543ad4d743d`。

| J-3修正後の全体再検証 | 結果 |
| --- | --- |
| `pnpm typecheck` | 成功 |
| `pnpm test` | **266ファイル・2,004テストすべて成功**。2026-09-09 22:23 JST、24.91秒。skipやテスト削除なし |
| `pnpm lint` | exit 0、警告79・エラー0。残る警告は今回の対象外 |

全体検査は現在のローカル作業ツリーに対する回帰確認であり、cloud輸送・F-1追加差分・未実装のオンラインモデルの受入証拠ではない。デプロイはしていない。

クラウド変更はJ-1の4項目が明示承認待ち。2.2は固定solverのローカル部分までであり、2.5未完了、F-1も未承認。ローカル検査のgreenをこれらの承認／ゲートへ流用しない。

## K-1／K-2追記（2026-09-10）

| 基準の更新 | 事実・扱い |
| --- | --- |
| K-1：既存全件ゲートのflake | ユーザーのローカル追試で `pnpm test` 5回中1回失敗。初回1失敗／2,004成功、続く4回2,005成功。`tests/shell/wire-decode-failure.integration.test.ts` の「記録に Wire_Text の中身（POS 由来の識別子）が入らない」。単独追試5/5成功もユーザー報告。こちら側の過去の全件成功は1回の実行結果で、安定性を示さない |
| K-1：待機機構の修正 | 修正前はWS送信後の固定50 ms待ちで捕捉を解除するため、負荷時に処理・記録を取りこぼし得た。ユーザーの別途承認後、同ファイル内の既存 `waitForRecords(lines, 1)`（上限5秒）へ1行だけ置換した。件数・PIIの両assertとhelperは無変更。固定50 msの機構を除去したのであって、flakeの消滅を実証したとはしない |
| K-2：rootから試験設定を分離 | 未配備solverへの `CPSAT_SOLVER` と `PLANNER_BACKEND` をroot `wrangler.jsonc` から撤去し、Vitestの連動するCP用503代役も削除。上記の代役登録・初期ハッシュは当時の記録として保持する。通常のTS solver代役は残す |
| K-2：ローカルprobeの型 | 型生成だけの `experiments/cpsat-workers/transport/wrangler.types.jsonc` に分離。`name`／`main`／assetsなし、ハーネス内の `solver` bindingだけを定義。機械生成の `CpsatTransportProbeEnv` を試験appで使い、rootの `Env` にCP bindingを戻さない。ランタイム接続は従来どおりMiniflareの自前binding |

これらはcloud承認・配備でも、2.2／2.5の完了でもない。K-1の修正承認は公開関数の命名確認やF-1承認を代替しない。

K-2後の再検証：2026-09-10 11:54 JST、型検査2種成功、全件は1回の実行で267ファイル／2,006件成功（25.29秒、設定分離の検査を1件追加）、lintは既存79警告／エラー0。ローカルprobeの生レポートを別ファイルへ保存した（生成0／送出7／求解開始4）。[コマンド・範囲・ハッシュ](./transport-app-local-20260910.md)を参照。**この実行時点ではK-1は未修正**であり、その全件成功を解消の根拠にしない。

K-1修正後（同日12:09 JST）：独立コミット `37754652a9d165cd6de35e41da0bf80b98313f94` に対象テスト1ファイルだけを含めた。CP-SATの差分・記録は含めていない。単独5回はいずれも2件成功、全件は1回で267ファイル／2,006件成功（25.16秒）、型検査成功、lintは既存79警告／エラー0。検査は未コミット作業を含むローカルツリー上で行った。根拠は固定待ちの機構の除去であって、greenの回数によるflake消滅の主張ではない。helperの `>= count` と後続の厳密件数assertという強さは隣と同じで、settleのための固定待ちは追加していない。

## 次の着手点

追記（2026-09-09）：以下の公開名はユーザー承認済みとなり、[タスク1の実装・検証](./observability.md)へ進んだ。以下の確認待ちはこの基準状態を取得した時点の記録である。

タスク1.1の公開名を命名規律に従って確認中。観測行 `CpsatObservation`、取得・欠測範囲 `CpsatObservationCoverage`、集計結果 `CpsatObservationSummary` と、`buildCpsatObservation`／`parseCpsatObservation`／`serializeCpsatObservation`／`summarizeCpsatObservations`／`observeCpsat` を候補として提示した。未承認のため、これらの公開シンボルの実装はまだ追加していない。

F-1（3.1）は引き続き明示承認待ち。1→2の順序、2.5の停止ゲート、クラウド配備前の対象確認は維持する。いずれのタスクもこの準備だけで完了にしない。
