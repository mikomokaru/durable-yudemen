# タスク2.2途中：実loopback HTTP入口と観測の完全性境界

2026-09-10。ローカルの実TCP経由で認可・拒否とprivate bindingへの転送を検証した。**2.2は未完了。永続送出台帳・privateな合成操作／WS入口は未実装。cloud変更・配備・実店舗操作なし。** 2.5・F-1のゲートは変えない。

## 実HTTPで確認した範囲

[ローカルドライバ](../../../../experiments/cpsat-workers/transport/check-app-local.mjs)にNode標準HTTPサーバを置き、`127.0.0.1` のOS割当ポートだけで待ち受ける。認証値は実行ごとにランダム生成し、レポートには残さない。Nodeは入口・刺激・集計だけであり、求解は従来どおりworkerd上のC++ WASMで行う。APIは[Node HTTPの公式仕様](https://nodejs.org/api/http.html#httpcreateserveroptions-requestlistener)を参照した。

- HostとOriginは実際のloopback originとの完全一致。Host／Origin／Authorizationの重複もコードで拒否する（重複ヘッダの実HTTP負例は今回の17件には含まない）。
- POST `/plan` だけを許し、query・他のpathを転送しない。Bearerは固定長の形式検査と定時間比較、Content-Typeは `application/json` との一致を要する。
- 本文は受信中に16 KiBで制限し、受付期間は読出し前後に検査する。CORS許可ヘッダは返さない。
- 転送先はローカルのprivate bindingに固定し、許可ヘッダだけを組み直す。任意URL・callbackを受け付けない。

Nodeの実HTTPクライアントから17ケースを送った。ステータスに加え、拒否時の転送0回・正例の転送1回を検査した。この回数は逐次試験の前後差分で、並列要求の台帳ではない。

| ケース | 件数 | 結果 |
| --- | ---: | --- |
| 異なるHost・localhost別名、異なる／null／欠落Origin、偽造中継ヘッダ | 6 | 403・転送0 |
| 欠落／不正Bearer | 2 | 401・転送0 |
| form／plainのContent-Type | 2 | 415・転送0 |
| OPTIONS・GET・query付きpath・無関係な管理path | 4 | 404・転送0 |
| 本文16,385 bytes | 1 | 413・転送0 |
| 小問題・難問題の直接probe | 2 | 202・各転送1、実WASM・実DO callbackまで確認 |

異なるOriginの負例にも有効なBearerを付け、トークン拒否だけで通過した試験にしない。拒否15件を終えた時点でCP観測・shim receiptはともに0件。正例2件を同じ入口へ通し、入口が常に拒否するだけではないことも確認した。

### 前回のCSRF限定との関係

前回の「実loopback HTTP入口を試していない」という限定は、この実TCP試験で解消した。ただし**ブラウザからのCSRF／CORS／PNA・ローカルネットワーク権限のend-to-end試験ではない**。Origin等はNodeクライアントで構成したヘッダであり、ブラウザがどう送信・遮断するかは未検証。OPTIONSの404を、ブラウザのpreflight全体の証拠とはしない。

Miniflare ingressによるOrigin拒否とappの認可を混同しないため、既存のテストrelayは残す。今回のHTTP経路では、Node入口で検査済みのliteral Originだけを `X-Local-Test-Origin` としてrelayへ渡し、workerd内でOriginに戻す。外から同名ヘッダを渡しても昇格させず、実Originが不正なら転送前に拒否する。従来のapp単独負例は従来relayで別に実行し、今回の実HTTP負例と混ぜない。

## 台帳の完全性境界

**観測の起点は、shimの入力・店舗・期限検査後のreceiptであってDOではない。** 実shellはSOLVERのHTTP状態を読まず、binding例外もcatchする。DO→shimの欠落、shimがreceiptを出す前の拒否は、この観測列だけでは検出できない。

receipt→request-dispatched→dispatch-resultの対応から先を照合する。receiptだけが残ったときも、物理的な未送出とログ欠測を区別できないので「未照合」とし、成功に数えない。業務操作件数から期待する送出件数を導く場合は**推定**であり、H1の実測・実送出数・予約枠の消費と同一視しない。H1を実shellへ接続するのは3.5以降。

この境界をtasks 2.2・cloud計画第4節と、レポートの `transportCoverage` に記録した。テストも `doToShimMeasured=false`、`preReceiptRefusalsMeasured=false`、`durableLedgerImplemented=false` を固定する。これは境界の明示であり、永続台帳そのものの実装・完全性試験ではない。

## 証拠と再現

[生レポート](./transport-loopback-local-20260910.json)：14:07:20.719 JST開始、SHA-256 `1dd090760dc9e44c4dcd0bd84a12efd848bc8698dc823e4510b57e7a92eb3947`。ソース・manifest・固定問題・WASM／生成JSのハッシュを保存した。バイナリは再ビルドしていない。[前回のshim記録](./transport-shim-local-20260910.md)は以前のソースに対する証拠として保持し、上書きしない。

`loopbackCases` は17件。正例2件は `requests` の47件にも含むため、合計して別の送出に数えない。由来検査12件、実Effect系列2件、shim receipt2件を別欄に記録した。CP観測78行、実送出7・求解開始4、callback完了4。直接2店舗／shim2店舗のscopeを維持し、集計 `issues=[]`・`usableForRates=true`。probe生成0を実engine生成0と読まず、後者は未計測nullのまま。

小問題2件はOPTIMAL、難問題2件はUNKNOWN（解なし打ち切り）。クライアントwall timeはローカルのHTTP開始〜応答読了であり、cloud性能・受理と求解の分離・waitUntil余裕の証拠に使わない。1分窓は分離の確認だけで、稼働頻度の閾値はまだ未設定。

| 検査 | 結果 |
| --- | --- |
| `pnpm typecheck` | 成功 |
| 変更コード2ファイルのlint／format | 警告・エラーなし／成功 |
| `pnpm test` | 270ファイル・2,047件成功（14:07:19 JST開始、24.11秒）。全環境での安定性の主張ではない |
| engine／shell／public Worker／root wrangler | HEADから差分なし |

```sh
node experiments/cpsat-workers/transport/check-app-local.mjs /tmp/NEW-loopback-report.json
pnpm test --project tools tests/cpsat-transport-app.example.test.ts
pnpm typecheck
pnpm test
```

出力先は新規ファイルを指定する。生成型などの前提は[transport README](../../../../experiments/cpsat-workers/transport/README.md)を参照。`.dev.vars`・Cloudflare認証・実環境は使わず、終了時にHTTP listenerとworkerdを閉じる。

## 残件

再起動横断の送出／操作予約台帳と上限・停止条件、privateな合成操作／WS入口、配備差分と復帰準備が残る。今回のローカルHTTPサーバには永続台帳や全体並列枠をまだ接続しておらず、cloud用ドライバとして使えない。cloud CPU・waitUntil枠・復帰・同じDOの求解中操作は未測定。ローカル準備後に2.1の5項目を明示確認し、2.3以降へ進む。
