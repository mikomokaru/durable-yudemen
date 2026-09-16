# Task 2.3：非公開初期配備とログ取得での停止

## 結果

2026-09-10。8項目と対象外namespace件数差への[承認](./cloud-approval-20260910.md)を受けて、投入順序の2・3まで実行した。**アプリは再配備していない。合成レコードは未作成、WASM求解は未実施。**

| Worker | 配備version / deployment | 状態 |
| --- | --- | --- |
| `yude-men-cpsat-planner-dev` | `499dd017-fc6d-47ae-bbc5-e3204768640c` / `d79665ff-a1d1-45dc-9e6f-5cc6f8fb964a` | 求解無効の初期版。固定manifest `enabled=false`、CPU 10,000ms、callback bindingは既存StoreTimerDO |
| `yude-men-cpsat-transport-shim-dev` | `915a98ed-2e2e-4b99-a634-cdfcdcf81710` / `dd26053f-bb4a-46fb-aca5-42493818128f` | TS bindingのみ。CP bindingなし。アプリから未接続 |

両Workerはroutes無し、workers.dev／preview無効。実設定は[solver配備後GET](./cloud-targets-bootstrap-planner-20260910.json)、[shim配備後GET](./cloud-targets-bootstrap-shim-20260910.json)に保存した。対象DO namespaceは増えていない。

アプリ `be146588-b3f0-4f54-9134-f5baf744d8fd`、TS solver `e134e93b-1208-452f-847f-cbf344777119`、`SOLVER → yude-men-solver`、ACCESS_REQUIRED=1、取得範囲の設定・公開範囲・DO ID・合成IDの空きは維持されている。各配備後に、その段の新規Worker3経路だけを差分対象として除いて構造比較し、それ以外と管理API結果が一致した。

## 実行した境界検査（求解試験ではない）

1. 初期solverへWrangler `getPlatformProxy` のremote service bindingで **GET /plan 1回**。無効manifestの503応答を受信した。[生レポート](./transport-bootstrap-cloud-20260910.json)。Node側の呼出〜返却552msは通信を含む値であり、CPUや求解時間ではない。
2. 初期shimへ同じremote binding方式で **POST /plan `{"storeId":""}` 1回**。shimは空文字をroutingで通し、TS solverは空storeIdを求解前に拒否する。400と固定文字列 `Malformed request` を照合した。[生レポート](./transport-bootstrap-shim-cloud-20260910.json)。通常の有効なPlanRequest・アプリ由来要求・callbackの検証ではない。どの店舗も宛先にしていない。

自身のHTTP listener、公開URL迂回、認証弱体化は追加していない。proxyは各実行のfinallyでdisposeした。named entrypoint 2件のremote到達性、202と求解の分離、WASM初期化・CPU・メモリ・waitUntil余裕・DO復帰は未検証のまま。

## 停止理由：ログ取得権限

`POST /accounts/305d89a643ac689b4204454c5493cbde/workers/observability/telemetry/query` を両新規Workerに限定し、`dry:true` の読み取りクエリとして実行した。両方 **403 / error code 10000**。既存OAuth更新後も同じ結果。[クエリ・秘匿値を除いた結果](./transport-bootstrap-logs-20260910.json)。eventsは0件ではなく **null（未取得）** と記録する。

Wrangler 4.105.0の既存OAuthにはworkers_tail:readがあるが、利用可能なOAuth scope一覧にWorkers Observability専用scopeはない。指定済みのmain worktreeの.dev.varsにはCloudflare資格情報のキーがなく、環境のCLOUDFLARE_API_TOKENも無かった。[当該APIの公式権限要件](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/)は **Workers Observability Write**。403の内部原因全体を断定するものではないが、当該APIを使える資格情報を用意して再検査する必要がある。Global API keyやaccount全体の管理権限は求めない。

Wrangler tailの権限やGraphQL集約値を、必要な保存済みinvocationログ・要求単位のCPU／wallの代替証拠としない。新Tail Worker・Logpush・外部ログ基盤の追加、権限の追加、資格情報の新規作成は行わなかった。

**新規投入を停止し、手順4（shimのCP binding追加）以降へ進めない。** 初期版の2Workerは上表の状態で保持している。試験用の有効期間はまだ開始しておらず、solverは求解不可、shimにアプリからの接続は無い。停止版への切替・削除は今回行っていない。アプリは変更前の版のためrollbackも不要だった。権限が整ったら現版を再照合し、ログ取得を確認してから再開する。

## 上限・費用の引継ぎ

bootstrapも固定solverへの全送出128に含める。共通の耐久ジャーナル `.wrangler/cpsat-bootstrap/dispatch.journal` に予約をflushしてから送った。solverのGETはdispatch予約1、TS拒否検査は保守的にoperation予約1・CP allowance0。WS接続0、未清算0、停止なし。H2は無効solverへ直接届く検査のため発生せず、台帳のobservedDispatches=0を外部呼出0とは読まない。

**後続の有効試行に128・512を満額与え直してはならない。現在の残枠は送出127・操作511・累積接続32。** 再実行すれば同じジャーナルの消費が増える。active manifestは別の期限を持つので、別台帳を使うならbootstrapの最新消費を先に差し引き、合算を検査する配線が必要。その配線前に有効化しない。今回のジャーナルを消去して枠を戻さない。

solver初期配備は試験版最大2回のうち1回目。残る試験版配備は1回で、停止版は別枠。次回inventoryでは両Workerは既存になっているため、404を期待する過去の新規作成手順を繰り返さない。

公開単価は実行前に[Workers](https://developers.cloudflare.com/workers/platform/pricing/)、[DO](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)を再確認し、計画§5の単価と一致した。今回は2件の拒否検査だけで、料金を実測・確定していない。有効試行の保守的見積りと累積消費の再照合は実求解開始前に必要。追加予算US$20を拡張しない。

## 再現コード・成果物

```sh
# 初期版のローカル検査。再配備はせず、まず現在のversionを照合する。
pnpm exec wrangler deploy --dry-run --config experiments/cpsat-workers/transport/wrangler.bootstrap-planner.jsonc
pnpm exec wrangler deploy --dry-run --config experiments/cpsat-workers/transport/wrangler.bootstrap-shim.jsonc
# 以下はcloudへ接続する。後続の再開条件を確認してから、新しいレポート名を渡す。
node experiments/cpsat-workers/transport/check-bootstrap-cloud.mjs NEW_PLANNER_REPORT.json
node experiments/cpsat-workers/transport/check-bootstrap-cloud.mjs NEW_SHIM_REPORT.json shim
node experiments/cpsat-workers/transport/check-bootstrap-logs.mjs NEW_LOG_REPORT.json
```

実配備は上記bootstrap設定を指定した `pnpm exec wrangler deploy` で行った。root設定やWIP planner設定は使っていない。WASMの再ビルド・fixtures再生成も行っていない。

| 成果物 | SHA-256 |
| --- | --- |
| wrangler.bootstrap-planner.jsonc | `c7cc3028276e44eabc49110e473cdbc3280ae5c4b8e88e4c5bfc5932bf774eae` |
| wrangler.bootstrap-shim.jsonc | `8d80b3af64a41ca033f9b45607c49b27e29219f502783005c822ff22cd53b782` |
| 固定WASM | `c8b89a734a15ad067e18edd08fc58d179aff63bf9922080e75fbeeecfb0223a1` |
| 生成JS | `9aa103e134a4dcc5810a589dc008dc5b1c3f4d46114df05e08f4799f2b97eda8` |
| fixtures.json | `2a57e18be75b668f8fd5100210311f411d1f70f6d3c5f769d7b5ff9547574045` |

Wrangler dry-runはplanner 7,571.37 KiB（gzip 2,450.16 KiB）、shim 18.33 KiB（gzip 5.29 KiB）。各設定から型を`.wrangler/cpsat-bootstrap/`へ生成した。root Envは変更せず、bootstrap shimにはCPSAT_SOLVERが無いことを設定と型で確認。これは無効manifestの初期版に限る型面であり、有効版は別途両bindingを持つ型と接続を検査する。

追加のローカル検査は `tests/observe/cpsat-bootstrap.example.test.ts` 3件（非公開設定、既存DO参照、TSのみのshim、無効manifest、WASM等のハッシュ）。全件実行274ファイル／2,079件成功、typecheck成功、lint exit0・追加分警告0。アプリ／shell／engine／root wranglerはHEADから無変更。これはcloudの求解ゲート合格を意味しない。
