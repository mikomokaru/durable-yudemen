# タスク2.2途中：既存SOLVER bindingから固定問題へ接続する

2026-09-10。案Aを実装した。**2.2は未完了、2.5・F-1は未通過。cloud変更・配備・実店舗への操作なし。** H1の実接続やタスク3を前倒ししていない。

## 境界と固定した割当

[shim.ts](../../../../experiments/cpsat-workers/transport/shim.ts) は試験専用の標準 `fetch` 入口。src/shell・engine・public Worker・root wrangler設定はHEADと同一で、StoreTimerDOを継承・差し替え・protected化していない。privateへのcastやEffectループの複製もない。

実際の経路は、ローカル合成注文→既存公開Order_Ingressの認可→実StoreTimerDO→Persist先頭のEffect→SOLVER binding→shim→固定solver→同じStoreTimerDOのdeliverPlan。shimには生成前のH1・decisionId・effectIndexが届かないので、それらを作らず **engine生成を未計測（count=null）** と記録する。

- shimの受信記録は `transport=shim` の最小の固定フィールドだけ。storeRef、ランダムな固定要求requestId、受信時刻、pending／running件数を持つ。`CpsatObservation` ではなく、`shimReceipts` 欄に分離する。記録に注文ID・本文・指紋・係数・偽のPersist親を含めない。
- 受信するPlanRequestの外形と店舗を照合した後、問題・予算・宛先をmanifestから選び直し、`toCpsatTransportRequest` の許可リストを通す。本文のmodel／budget／callbackUrl／由来の注入は拒否。業務モデルを生成せず、注文本文を固定solverへ送らない。
- 固定要求は `mode=probe／origin=probe／親null`。既存の共有parserや因果集計を緩めない。期限を本文読出し後と送出直前に検査し、CPの失敗をTSへfallbackしない。
- 直接入口はshim専用店舗を拒否。shimはその他の店舗をCPへ送らず、既存TSへ転送する。各入口からの観測系列を、報告ラベルだけでなく異なるstoreRefで分離する。

[manifest](../../../../experiments/cpsat-workers/transport/manifest.json) は無効のまま、既存4店舗へ次を固定した。店舗やDO namespaceは増やしていない。

| 店舗末尾 | 系列 | 固定問題 | 実送出 | 求解開始 | callback完了 |
| --- | --- | --- | ---: | ---: | ---: |
| 01 | 直接probe | small | 4（うち3件は送出失敗注入） | 1 | 1 |
| 02 | 直接probe | hard | 1 | 1 | 1 |
| 03 | 既存Effect→shim刺激 | small | 1 | 1 | 1 |
| 04 | 既存Effect→shim刺激 | hard | 1 | 1 | 1 |

既存集計器のscopeはstoreRef／backend／modeなので、totalsは4行、1分窓もstoreRef別となる。新レポートでは `issues=[]`、`usableForRates=true`、観測78行・実送出7・求解開始4。probeの生成行0を実engineの生成0とは呼ばない。試験は1分未満で、頻度の閾値も未設定。1分窓の**分離**は確認したが、稼働頻度の良否を判定したわけではない。従来の全4店舗直接probeの記録は旧manifestの証拠として保持し、今回の割当へ読み替えない。

小問題は2件OPTIMAL、難問題は2件UNKNOWN。後者は解が無い打ち切りで、良い計画を返した成功とは数えない。実WASM・生成JSは再ビルドせず、以前と同じ両ハッシュを照合している。

## Persist失敗を既存実行経路で確認する

[統合テスト](../../../../tests/shell/cpsat-transport-persist.integration.test.ts) は実StoreTimerDOの `fetch` を使い、storage.putと既存SOLVER bindingをテスト内で観測する。envやprivateメソッドをcastで置換せず、DO実装を変更しない。

1. 注文aの正常受理で同じspyが送出を1回検出し、binding呼出時に読み取った永続orderItemsと要求pendingが一致する（positive control）。
2. 注文bのputを1回だけ失敗させると503、put呼出1回、binding呼出0、永続状態は直前と同一。
3. 同じ注文bを再送し、実putが成功した後のbinding呼出を1回検出、永続2件とpending2件が一致する。
4. 受理済みbの再送はput／bindingとも0。

binding内のassertはrequestPlanのcatchに捕まる可能性があるため、そこで値を収集し、assertは呼出が戻った後に行う。この試験はshellのPersist規律の証拠で、H1の実測ではない。CLIでの実WASM試験とは別の証拠として扱う。

## 結果と再現

最終ソースの[生レポート](./transport-shim-local-20260910b.json)：13:29:14.948 JST開始。SHA-256 `2ef331c7d515de827a2c3dafb3e392fb4aab15b9bc765f8e4204f3446412f13b`。probe入口47試行、solver由来検査12ケース、別欄に実Effectからの2試行・shim到達2件。実行ソース・manifest・共通fixture・両バイナリのハッシュを保存した。

同日の[先行実行](./transport-shim-local-20260910.json)も保持する。型参照についての説明コメント追加前のハッシュなので、最終ソースの一致確認にはbを使う。以前のレポートは上書きしていない。

| 検査 | 結果 |
| --- | --- |
| shim単体＋Persist統合 | 2ファイル・17件成功 |
| private app／実WASM CLI | 2件成功、実Effect系列・直接系列・拒否・TS転送・callbackまで照合 |
| `pnpm typecheck`／transport専用tsconfig | 成功 |
| `pnpm test` | 270ファイル・2,047件成功を2回確認（13:28:05 JST開始、24.26秒／13:31:08開始、24.30秒）。全環境での安定性の主張ではない |
| `pnpm lint` | exit 0、既存警告79・エラー0。変更対象6コードファイルは警告0 |

単体テスト初回は、Workersテスト環境に存在しないASSETSを代役として参照して15件失敗した。テスト用bindingを生成型に適合する明示的な代役へ直し、上記の正例・負例を実行した。未到達の失敗をshimの検証成功へ数えない。局所型はWranglerが出す非moduleのglobal宣言を参照し、root設定へのCP binding再導入や型castで代用していない。

```sh
pnpm typecheck
pnpm exec tsc --noEmit --project experiments/cpsat-workers/transport/tsconfig.json
pnpm test --project workers tests/cpsat-transport-shim.example.test.ts tests/shell/cpsat-transport-persist.integration.test.ts
pnpm test --project tools tests/cpsat-transport-app.example.test.ts
node experiments/cpsat-workers/transport/check-app-local.mjs /tmp/NEW-shim-report.json
pnpm test
pnpm lint
```

型の生成は[transport README](../../../../experiments/cpsat-workers/transport/README.md)を参照。ローカル実行は資格情報を読まず、ephemeralな認証値と一時DOを使う。ソース・報告に実店舗データを含めない。

## cloud投入の第5確認項目と残件

Workersスキルと[公式のHTTP bindingの契約](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/)に従って接続をbinding内に限定し、[入力の有界化](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)を適用した。ただし通常店舗にも新しいrouting検査が掛かる。1 MiB上限・UTF-8／JSON／storeId検査、追加hopのCPU・遅延・失敗の影響は未評価であり、TS solverを維持するだけで「無影響」としない。

[cloud投入計画](./cloud-transport-plan.md)の先頭承認表とtasks 2.1／2.3へ、**第5項（shim経由範囲、TS転送の遅延／失敗、binding差分と復帰方法）**を追加した。実際のshim配置・binding復帰の手順を準備してから確認する。追加Worker・cloud接続を暗黙に許可したことにはしない。

残りはprivateな合成操作／WS入口、実loopback認可、全送出・操作の再起動横断台帳と上限、停止条件、配備差分／復帰準備。cloud CPU・waitUntil余裕・同じDOの求解中操作進行は未測定。2.2を完了にせず、cloud投入を後ろへ置く方針と2.5ゲートを維持する。
