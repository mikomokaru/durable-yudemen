# タスク2.2途中：private app → 固定WASM → 実StoreDO

測定：2026-09-10 11:35 JST。[生レポート](./transport-app-local-20260910.json)。**ローカル実測のみ。2.2は未完了、2.5のcloud輸送ゲート・F-1（3.1）は未通過。cloud変更・実店舗アクセスなし。**

## 今回接続した境界

`check-app-local.mjs` のローカルrelay → service binding `CPSAT_TRANSPORT_PROBE` → `CpsatTransportProbe.fetch` → `CPSAT_SOLVER` → 既存の単一スレッドC++ WASM → **変更していない実StoreTimerDO.deliverPlan**。

試験用 [app.ts](../../../../experiments/cpsat-workers/transport/app.ts) は、既存public handler・Registry・StoreDOをそのまま再exportする。`src/worker.ts`・`src/shell/store-timer-do.ts`・engine・UI・永続形式・root配備設定は今回変更していない。新しい公開HTTPルートは無く、独立した試験bundleのnamed entrypointだけをローカルbindingで呼ぶ。未検証WIPのCP計画器をbundleへ引き込まないことも入力一覧で検査する。

既存Provisioning APIをローカルappのdefault handler経由で呼び、合成チェーン1・4店舗を作成した。storeCodeなし、合成identityのみ。`ACCESS_REQUIRED=1`・Operation History無効。ADMIN／ingress／run tokenはその試験中だけランダム生成し、既存 `.dev.vars`・Cloudflare資格情報は読まない。レポートと取得ログにこれらの値がないことをassertする。

## 実測・検証

| 検査 | 結果 |
| --- | --- |
| 入口への37要求 | 拒否30、実WASM用202が4、送出失敗等の注入3 |
| 拒否30件 | public handlerの未定義ルート、無効／過去／未来／長すぎる期限、認証設定欠落、誤token・誤／欠落Origin、method/path/query、16 KiB超過・不正UTF-8・不正JSON、店舗・モデル・予算・版・親行・engine由来の偽装等。実送出0・求解0・追加配信0 |
| 実求解4件 | 4店舗それぞれへ1回。小問題2件OPTIMAL、難問2件UNKNOWN（探索量で打ち切り、実行可能解を得たとはしない） |
| 実callback4件 | 全件 `await deliverPlan` から戻り `delivered`。新しいTS要求・CP由来の配信なし |
| WASM線形メモリ | 4件とも33,554,432 bytes＝32 MiB。isolate全体の計測値ではない |
| 注入3件 | 下流503・429・binding例外。各1送出だけ、求解0。再試行・公開URLへの迂回・TS fallbackなし |
| 3計数口 | **engine生成0・実送出7・実求解開始4**。観測78行を既存集計器へ渡し、因果の欠落なし・`usableForRates=true`。注入分も同じ観測期間の総数から除外しない |
| 通常経路の正例 | 既存Order_Ingressの無認証401、有効な別tokenによる到着200、WS snapshot通知、従来TS bindingへの送出1を確認 |
| callbackの非採用 | 接続中のWSへ追加配信なし。再接続後の注文・Timer事実が同じで、TS推奨には既存の「即時提案を現在時刻へ進める」補正だけがあることを具体値で検査 |

固定WASM／生成JSのSHA-256は流用ガイドと一致し、再ビルドしていない。WASM=`c8b89a734a15ad067e18edd08fc58d179aff63bf9922080e75fbeeecfb0223a1`、JS=`9aa103e134a4dcc5810a589dc008dc5b1c3f4d46114df05e08f4799f2b97eda8`。固定2問題のprotobufハッシュを再確認し、app用の小さい許可リストが `fixtures.json` の問題・ハッシュ・予算と全件一致することを検査する。app bundleはprotobuf本体やWASMを含まない。

smallの最適値5・解 `[2,1,0]`、hardの探索量消費・返却候補の実行可能性は既存 `solver.ts` の独立検査を毎回通る。前回のnative比較は[別記録](./transport-local-20260909.md)であり、今回nativeを再実行したとは扱わない。

Node v26.7.0は刺激・集計だけ。求解はWrangler 4.105.0同梱のMiniflare 4.20260625.0／workerd（compatibility date 2026-06-26）、esbuild 0.28.1。solverのNode互換は無効。各成果物・主要接続ソースのハッシュを生レポートに保存した。

## 検査で区別したこと

- 最初のOrigin負例はMiniflareのHTTP入口が403で拒否し、appへ届かなかった。テスト専用relayの中で対象Originを設定するようにし、appの401を実際に踏むよう修正した。**これは本物のloopbackドライバのCSRF試験ではない。**
- 再接続のsnapshotを全バイト比較すると、既存TSの時刻補正で失敗した。注文／Timerの同一性と、1杯の推奨の `startAt=serverTime`・群の時刻=`serverTime+60,000` を前後それぞれ検査する。推奨全体を検査対象から外していない。
- callbackによるstorage.put／Alarmが0回であることのspyは本CLIには入れない。[実StoreDOの既存棄却テスト](../../../../tests/shell/cpsat-transport-rejection.integration.test.ts)で、正例のput／配信が見えることを先に確認してから独立に検査する。

## 再現

```sh
pnpm exec tsc --noEmit --project experiments/cpsat-workers/transport/tsconfig.json
node experiments/cpsat-workers/transport/check-app-local.mjs /tmp/NEW-app-report.json
pnpm test --project tools tests/cpsat-transport-app.example.test.ts
pnpm test --project workers tests/shell/cpsat-transport-rejection.integration.test.ts
```

出力先が既存なら、ローカル試験開始前に拒否し、書き込みも `wx` で上書きを防ぐ。`pnpm test` にもCLI検証を加えた。CLIは既存Wranglerのローカルランタイムを起動するが、デプロイ・remote binding・既存サンプル／秘密の読出しは行わない。

追加後の検査（同日11:35 JST）：`pnpm typecheck` 成功、transport用tsconfigの型検査成功、`pnpm test` は **1回の実行で267ファイル／2,005件すべて成功**（25.82秒）。これは安定してgreenであることの証拠ではない（下記K-1）。`pnpm lint` はexit 0（既存79警告・エラー0）、追加コードとCLI・テストの個別lintは警告0。`git diff --check` 成功。既存のengine／worker／StoreDOに差分なし。tasksは40小タスク・40本のRequirements行・80 AC被覆を維持した。

### K-1：既知のflakyな全件ゲート（2026-09-10追記、修正済み：固定待ちの機構を除去）

ユーザーのローカル追試では、全件実行5回中1回が失敗（初回：1失敗／2,004成功、続く4回：2,005成功）。失敗は `tests/shell/wire-decode-failure.integration.test.ts` の「記録に Wire_Text の中身（POS 由来の識別子）が入らない」。同ファイル単独の追試は5/5成功との報告。これはユーザー環境での観測頻度1/5であり、失敗確率の推定やこちら側での5回再現結果ではない。

修正前の既存テストはWS送信後に固定50 ms待って `console.error` の捕捉を解除するため、負荷時にdecode-failureの処理・記録がその後へずれると取りこぼす。CP-SAT実装の欠陥とは区別する。tools projectでの実workerd起動が負荷を増やし得るが、それを直接原因と確定した測定はない。全件ゲートの失敗を成功扱い・無視しない。

ユーザーの別途承認を受け、同ファイル内の既存の待機作法へ揃えた。変更は固定待ち1行を `await waitForRecords(lines, 1)` に置換しただけで、`toHaveLength(1)` と `not.toContain("secret-order")` はそのまま残す。helper本体・上限5秒・捕捉の解除・隣のテストは変更せず、新しいsleepも追加しない。全件ゲートのための独立したテスト修正であり、CP-SATコードの都合を導入したものではない。

言えるのは、**実時間50 msを待機予算にする失敗の機構を外し、既存の上限5秒の条件待ちへ置き換えたこと**。記録が50 msより遅くても、それだけで捕捉を解除しない。5秒上限の待機失敗や、件数・PIIのassert失敗まで無くしたわけではなく、全件のgreenを「flakeが消えた」の根拠にしない。helperが `>= 1` で戻った後に件数を `=== 1` と検査する残差は、隣の `waitForRecords(lines, 3)` と同じ強さであり、後続の追加記録が永久に無いことを証明しない。

独立コミット：`37754652a9d165cd6de35e41da0bf80b98313f94`（`test(shell): 同ファイル内の既存の待機作法に揃える`）。含むのは `tests/shell/wire-decode-failure.integration.test.ts` だけ、1行削除・1行追加。CP-SATの作業・この記録更新はコミットへ含めていない。テストの変更後SHA-256は `118a21a63f3ffc49003aaf2fc98875744ca1e58fd8f108c2389f85bfb331e7e5`。[基準状態にも記録](./implementation-baseline.md)。

変更後のローカル検査（2026-09-10）：`pnpm test --project workers tests/shell/wire-decode-failure.integration.test.ts` は5回とも2件成功（12:08:55、12:09:42／43／45／46 JST）。`pnpm test` は1回の実行で267ファイル・2,006件成功（12:09:16 JST、25.16秒）。`pnpm typecheck` 成功、`pnpm lint` は既存79警告／エラー0。対象ファイル単独のlintは変更していないhelperの `no-await-in-loop` 警告1件／エラー0。対象の `oxfmt --check`・`git diff --check` 成功。これらはCP-SATの未コミット作業を含むローカルツリーに対する検査であり、独立コミットだけを別checkoutで検証したとはしない。今回の1行置換以外はbyte単位で一致し、両assertの保持も機械検査した。

### K-2：root設定の先行接続を撤去（2026-09-10 11:55 JST追記）

- root `wrangler.jsonc` の `CPSAT_SOLVER`／`PLANNER_BACKEND` と、Vitest側のCP用503代役を削除した。root設定はHEAD（`a46f277562a5d994844e9d2c07688344b64d17b0`）と同一で、通常のTS binding・代役は保持した。
- 型生成だけの [wrangler.types.jsonc](../../../../experiments/cpsat-workers/transport/wrangler.types.jsonc) にprobeのbindingを分離した。配備の `name`・`main`・assetsを持たず、接続先は既存ハーネス内の `solver`。機械生成の `CpsatTransportProbeEnv` を試験appの型引数に使う。rootの `Env` にCP bindingを宣言マージしたり、castで不足を隠したりしない。[再生成手順](../../../../experiments/cpsat-workers/transport/README.md#再現)を更新した。
- [既存CLIテストファイル](../../../../tests/cpsat-transport-app.example.test.ts)へ設定分離の検査を1件追加した。root設定と生成Envに上記2項目がなく、TS bindingが残り、型生成専用設定に配備名／入口がなく、CP代役がVitest設定に残っていないことを確認する。今後cloud接続を承認して追加する段階では、その配備差分とともにこの検査も更新する。
- ランタイムの送出・認可・求解・callbackは変更していない。WASM／JSは同じ固定ハッシュのまま。engine・public worker・StoreDO・既存PIIテストは無変更。

| K-2変更後の実行 | 結果 |
| --- | --- |
| `pnpm cf-typegen` とREADMEの2つの追加型生成コマンド | 成功。root／既存solver／試験probeを各設定から生成し、生成物はignore対象のまま |
| `pnpm typecheck`、transport用tsconfigの型検査 | 両方成功。rootの生成EnvにCP binding／選択設定がないことも型検査 |
| `pnpm test --project tools tests/cpsat-transport-app.example.test.ts --project workers tests/shell/cpsat-transport-rejection.integration.test.ts` | 2ファイル・3件成功（11:54:46 JST）。実WASM・実DOの経路と棄却試験を含む |
| `pnpm test` | **1回の実行で267ファイル・2,006件成功**（11:54:54 JST、25.29秒）。設定分離の検査が1件増えた。この実行時点ではK-1は未修正であり、安定greenの主張ではない |
| `pnpm lint`、変更TSファイルの個別lint | 全体exit 0・既存79警告／エラー0、個別警告0 |
| 変更した試験コード／型設定の `oxfmt --check`、`git diff --check` | 成功。全体整形なし |
| tasksの構造検査 | 40小タスク・40本のRequirements行・80/80 AC被覆、欠落・不正参照なし |

設定削除後、CLIを次のコマンドで独立に再実行した。11:55:28 JST、37要求・観測78行、生成0／実送出7／求解開始4、因果の欠落なし、`usableForRates=true`。小問題2件OPTIMAL・難問2件UNKNOWN、実callback4件の既存境界は維持された。これはローカルprobeの再確認であり、cloud輸送の証拠ではない。元の11:35の生レポートは上書きしていない。

```sh
node experiments/cpsat-workers/transport/check-app-local.mjs \
  .kiro/specs/cpsat-planner-integration/verification/transport-app-local-k2-20260910.json
```

追試時は末尾を新しいファイル名に変える。[K-2後の生レポート](./transport-app-local-k2-20260910.json)のSHA-256は `cd6f449b59f877f2c853e5795c018e9ceca5e93649d279bf63da09e7e5d09f9d`。主要なソースハッシュは同レポート内にあり、設定境界の追加ハッシュは以下。

| ファイル | SHA-256 |
| --- | --- |
| root `wrangler.jsonc`（HEADと同一） | `38e224708d55047b55fb894072df7095607d636926d5107a6e127f3f3917dfe6` |
| `vitest.config.ts` | `3811671d0f6c2dbee507e6343af773e343795e7747194a26a933c44518121b11` |
| `tests/cpsat-transport-app.example.test.ts` | `cf5a32412fa8703e025395eb7bffd233322254071d15aed8dd816e6b27e6bec3` |
| transport `wrangler.types.jsonc` | `db20b15b1a4777c706b5281b72afe6205cbce9d24516cf75f3cb22f5cce62647` |
| transport `tsconfig.json` | `019c357cd6a535a027ec508de01161e9e1a190563bd6f2f499f817b8526dba78` |
| K-2実測時点の既存PIIテスト（K-1修正前） | `60092d2289e69c7083faa208682bdc67080ff54f34a0ae04b3c322e1c9ada9e8` |

## 残りとゲート

既存の状態変更・Persist先頭のEffectから固定問題へ送出する配線、privateな合成操作／WS入口、loopback側の認可・全送出128／並列4／操作512等の制限・再起動横断台帳、停止条件、配備差分・復帰準備が残る。manifestは無効のままで、現状の入口だけをcloudへ投入しない。

当初提示した `readCpsatTransportProbe`／`dispatchCpsatTransportProbe` は採用しない。2026-09-10のユーザー提案・承認により `toCpsatTransportRequest`／`dispatchCpsatTransportRequest` を採用し、直接probeを共有処理へ接続した。期限述語は独立させ、送出直前の再検査を残す。実Effectへの配線はまだ未実装であり、共有処理のfixture検証と区別する。クラウド投入の承認やF-1の承認とは別である。[共有処理の契約](../../../../experiments/cpsat-workers/transport/README.md#共有要求の呼出契約)。

CPU実測、isolate全体メモリ、30秒waitUntilの消費・余裕、求解中の同じDOの操作進行、hibernation、cloudの受理／求解分離は未測定。`202`・非公開binding・ローカル成功だけで成立を主張しない。2.2の準備完了後に初めて2.1の4項目を投入直前に確認し、2.5合格まで3.2以降へ進まない。

API確認には [Workersのnamed entrypoint](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/) と [DO State](https://developers.cloudflare.com/durable-objects/api/state/) を参照。Workers／DOスキルに従い、binding境界とローカル実ランタイムを検証した。一般的なNode互換推奨やSQL移行は、この固定WASM・既存保存方式の契約を優先し採用していない。
