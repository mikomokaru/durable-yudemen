# タスク2.2途中：輸送要求の共有処理

2026-09-10。ユーザー提案・承認の `toCpsatTransportRequest`／`dispatchCpsatTransportRequest` を実装した。`Probe` は入口名に残し、共有する要求の名前には使わない。**2.2は未完了、cloud変更なし、2.5・F-1未通過。**

## 実装した範囲

- [request.ts](../../../../experiments/cpsat-workers/transport/request.ts)：生の文字列と信頼する呼出元の認可結果・由来情報を受け、固定店舗／問題／予算／版・観測スキーマと照合。不一致はnull。16 KiBを超える文字列も拒否する。
- [app.ts](../../../../experiments/cpsat-workers/transport/app.ts)：直接probeを上記2関数へ接続。HTTPのBearer／Origin検査・401応答、path/method拒否、strict UTF-8の上限付きstream読出しは入口に残す。本文から `authorization` を作らず、入口の認可結果と `origin.kind=probe` を渡す。
- 期限窓は `#enabled` として独立。入口で検査した後、認可／本文読出しをawaitし、送出側で `() => this.#enabled()` を再評価する。`to*` に現在の受付期間の判定を畳まない（観測行自身の時刻の範囲検査は入力検証として残る）。送出直前の再検査から観測・binding呼出しまでにawaitはない。
- `dispatchCpsatTransportRequest` は非公開bindingへの1回の送出と結果だけを観測する。再試行・代替URL・TS fallbackなし。観測書込み失敗では送出せず503。既に送った要求は、その後に期限を過ぎても結果を記録する。
- 直接probeは送出時のIDを新しく生成し、engine生成の事実を作らない。Effect由来では、呼出元のDO instance／invocation、decision／Effect位置、Persist親IDと店舗を引き継ぐ。共有関数は参照の一致を検査するが、実際のstorage.put成功を自身で証明する機構ではない。成功後にだけ呼ぶ責務は今後のEffect配線側にある。

既存engine、public Worker、StoreTimerDO、UI、永続形式、root配備設定、観測スキーマ、固定solver本体、WASM／生成JSは変更していない。アプリ／試験bindingの型生成設定も無変更。新しい公開関数は承認された2名だけで、公開型やメッセージ種別を追加していない。

## 検査で見つけて修正したこと

当初はEffect由来の要求も `mode=probe` としていた。因果集計を追加すると、既存スキーマがprobeでの生成記録を禁止しているため `invalid-rows`／`missing-generation`／`broken-causal-link` を検出した。12:23:09 JSTの全件実行はこの新規検査1件が失敗し、2,017件が成功した。

スキーマを緩めず、共有処理とfixtureを修正した。直接probeは `origin.kind=probe`・`mode=probe`、実Effect由来は `origin.kind=engine`・`mode=live` とする。試験かどうかは固定問題・manifest・code版でも区別し、ここでの `live` をCP計画の通常利用・採用と同一視しない。修正後の集計ではfixtureの生成1／送出1／求解開始0を因果欠落なしで確認した。**これは合成した親記録とbinding代役を用いた検査であり、実engine生成・実Persist・実WASMの同一系列の実測ではない。**

## 結果

| 検査 | 結果・限界 |
| --- | --- |
| 共有関数のWorkers poolテスト | 12件成功。認可false、不正入力・版・店舗、probeのEffect由来偽装、Effectの別店舗／親／instance／decision／位置、期限またぎ、観測書込み失敗、202／429／503／想定外200、binding例外、送出後の期限切れ、因果集計を検査 |
| 期限またぎの負例 | 入口時に有効である正例を先に確認し、非同期境界で試験時計を期限まで進める。共有送出側で503、binding呼出0・観測0。実時間sleepは追加せず、実solverの時間・waitUntil余裕の測定とはしない |
| `pnpm typecheck` | 成功 |
| transport用tsconfigの型検査 | 成功 |
| `pnpm test`（修正後） | **1回の実行で268ファイル・2,018件成功**。12:24:47 JST、25.51秒。テストの削除・skipなし。全実行環境での安定性の証明ではない |
| `pnpm lint` | exit 0、既存79警告／エラー0。変更コードと追加テストの個別lintは警告0 |
| 対象の `oxfmt --check`、`git diff --check` | 成功。全体整形なし |

### 直接probeの実WASM再確認

[最終生レポート](./transport-request-local-20260910b.json)は12:25:57 JSTのローカル実測。37要求・観測78行、生成0／実送出7／求解開始4、`issues=[]`・`usableForRates=true`。小問題2件OPTIMAL・難問2件UNKNOWN、実StoreDO callback4件。30拒否例と3件の送出失敗等の注入、通常TS経路、callback非採用の検査は切り出し前と同じ。型やbinding代役だけでなく実WASMの経路を再確認した。

`check-app-local.mjs` のソースハッシュ記録へ共有 `request.ts` を追加した。WASMとJSのハッシュは従来の固定値のままで再ビルドなし。[途中の直接probeレポート](./transport-request-local-20260910.json)はmodeの取り違え修正前のコードによる記録として残すが、最終ソースの検証証拠にはしない。

| 成果物 | SHA-256 |
| --- | --- |
| 最終生レポート（末尾b） | `30fecea7b58ff2edad8267213cd1a82c5f907b823a481138f7bd2bdb1e5754e3` |
| transport `request.ts` | `eccb0c1977be61ca90a8d71248b0cbaef07f4c8de4cd39ed0e4ad6483cc30f4c` |
| transport `app.ts` | `04c48c1014827e5b69b11521b933e59799a87ebf2668a0a635f3afcb5b5fcebc` |
| `check-app-local.mjs` | `b9ef03074cef6acc642b780e1d07e38bb27993e3eeb97dd9553c655332a7ee67` |
| 追加テスト | `e97cabfaef56b5eb835361d83c46b18db9c0e60e9eb45c0c5d0eef12ffaeb239` |

## 再現と残り

型が未生成なら [READMEの再生成手順](../../../../experiments/cpsat-workers/transport/README.md#再現)から始める。

```sh
pnpm typecheck
pnpm exec tsc --noEmit --project experiments/cpsat-workers/transport/tsconfig.json
pnpm test --project workers tests/cpsat-transport-request.example.test.ts
pnpm test --project tools tests/cpsat-transport-app.example.test.ts
node experiments/cpsat-workers/transport/check-app-local.mjs /tmp/NEW-transport-request-report.json
pnpm test
pnpm lint
```

既存Effectからの実配線・生成とPersistの実観測・合成操作／WS入口・loopback認可と全送出台帳／上限・停止条件・配備差分が残る。固定solverは現時点で `mode=probe` の要求だけを受理するため、Effectの `mode=live` 受理と対応する実経路の検証も次の接続作業に含める。今回の共有関数のfixtureでその部分を合格にしない。

後続更新：[由来の両端検証](./transport-provenance-local-20260910.md)で共通parserの不変条件とsolverのlive入力検証を接続した。上の「mode=probeのみ」は本記録の実行時点の状態。実Effect配線は引き続き未実装であり、この記録の生レポート・ソースハッシュは変更しない。

cloud変更4項目の承認と2.5の輸送ゲート、F-1の承認は引き続き別。今回の実測にCPU、isolate全体のメモリ、waitUntil余裕、cloud復帰の証拠はない。
