# タスク2.2途中：輸送要求の由来を両端で検査する

2026-09-10。レビューで挙がった mode／origin／親参照の対応を共通化した。**実Effect配線はまだ未実装、2.2は未完了、cloud変更なし。2.5・F-1は未通過。**

## 変更した境界

[parseCpsatObservation](../../../../src/cpsat/observation.ts) の `cpsat.request-dispatched` 行の不変条件として、次を検査する。app の `toCpsatTransportRequest` と固定solverのstream読出しは、いずれもこの parser を通す。

| mode | 許す origin.kind | 親参照 |
| --- | --- | --- |
| probe | probe | nullのみ |
| live | engine | 非nullのみ |
| fake | engine／probe | 従来どおり。破損した因果列を含む観測集計用fixtureの表現を維持する |

`fake` は **app・solverの実輸送ではいずれも拒否**する。親IDの非nullは、実際のPersist成功や親行の存在の証明ではない。app側では引き続き、信頼する呼出元の認可・mode・instance・decision・Effect位置・親ID・店舗と照合する。親行の存在と意味の整合は集計器も検査する。solverは自身でparseし、版・固定問題・予算・店舗・期限の検査を省略しない。

`dispatchCpsatTransportRequest` の期限切れは従来どおり、送出前に503・観測0行とする。送出していない試行を `request-dispatched` に数えない。理由の記録は呼出元／試験台帳の責務であり、今回 `request-suppressed` の語彙やログは増やしていない。既に送った要求の結果は、期限を過ぎても記録する。

## 同一fixtureを両端で踏む検証

[共通fixture](../../../../tests/observe/fixtures/cpsat-transport-provenance.json) は mode 3種 × origin 2種 × 親の有無2種の12件。全組合せを列挙し、codecの許可と実輸送の許可を別欄にする。

- appの共有関数：12件すべてでcodec／認可済み変換の成否を検査。各件で反対側の由来を持つ呼出元からは拒否されることも検査する。
- private app入口：実輸送の不正10件を同じfixtureから送り、全件400・実送出0を確認する。
- solver：**同一solverソースを、送出上限0の独立したローカルinstanceで実行**する。正しいprobe／liveの2件だけが入力検証後の上限判定まで達して429、不正10件はその前で400。全件拒否する実装をpositive controlとして通さない。求解・callback・engine生成・Persistの行はこの系列では作らない。
- 通常の上限を持つ別のsolver instanceでは、従来の直接probe4件を実WASM・実StoreDO callbackまで通す。

429の2件は **入力検証を通過した証拠だけ**である。特にliveについて、engineが要求を生成した、Persistが成功した、実WASMで求解した、という証拠へ転用しない。

## 実行結果

[生レポート](./transport-provenance-local-20260910.json)：2026-09-10 12:41:26 JST開始。app要求47件と、別欄 `provenanceCases` のsolver直接入力12件（計59件）。観測78行、生成0／実送出7／求解開始4、`issues=[]`・`usableForRates=true`。小問題2件OPTIMAL、打ち切り問題2件UNKNOWN、実StoreDO callback4件。通常TS・認可・callbackの非採用も再確認した。

生レポートのSHA-256：`a601b7df43556050e9c466f2c291fe95ce999892851be1ef8233d11282e5a48c`。実行ソース・共通fixture・WASM／生成JSのハッシュはレポート内に保存した。既存レポートは上書きしていない。WASMの再ビルドなし。

| 検査 | 結果 |
| --- | --- |
| 共有関数・app CLI・観測example／property | 4ファイル・79件成功 |
| `pnpm typecheck`／transport用tsconfig | 成功 |
| `pnpm test` | 268ファイル・2,030件成功（12:41:26 JST開始、27.76秒）。新テストのlint修正後にも全件再実行し、同数成功（12:42:26 JST開始、25.22秒）。全環境での安定性の証明ではない |
| 変更コードの個別lint | 警告0・エラー0。新テストのmap/spread警告は既存fixtureを変えない書き方へ修正 |
| 整合検査 | 対象のoxfmt／git diff検査成功。40小タスク・40 Requirements行・80 AC参照を維持し、宙ぶらりん参照なし。新記録の相対リンクも実在 |

engine・StoreTimerDO・public Worker・root配備設定・型生成設定・UI・永続形式は無変更。観測集計器の欠測／因果不正の判定も変更していない。

## 次の接続：案Aを選択（方針決定、shimは未実装）

2026-09-10の追加レビューを受け、**2.2ではsrc/shellを変更しない案A**を選ぶ。`CpsatTransportStoreDO` の提案・命名確認を取り下げ、代替名のクラスも作らない。既存の `SOLVER` bindingをseamとして輸送shimを置き、同じ `StoreTimerDO` クラス・export・namespaceを使う。protected化、castによるprivateの迂回、Effect実行ループの複製はしない。

理由は [実shell](../../../../src/shell/store-timer-do.ts) の `runEffects`／`applySideEffect`／`requestPlan` がprivateであることに加え、送出される [PlanRequest](../../../../src/solver/request.ts) にdecisionId・effectIndex・Persist観測IDが無いことである。bindingで受信した事実から、Persist前のH1や送られなかった要求を復元することはできない。以前の提案はこの制約に対して観測範囲を広く約束しすぎていた。

2.2の接続は、合成店舗への既存操作→実engineの状態変更→実shellのPersist先頭のEffect列→`SOLVER`→shim→固定問題→同じ実DOのcallback、までを検証する。put成功後の到達、put失敗時のbinding未呼出は既存実行経路のテストで確認し、生成観測を合成して証明しない。公開入口の操作・Effect実行・callbackは自前で置換しない。

| 証拠 | 2.2での扱い |
| --- | --- |
| H1・decisionId・effectIndex・Persistとの由来照合 | 実shellでは未計測。タスク1の合成fixtureを別証拠として維持し、実接続は3.5／3.6へ残す |
| 本物のPlanRequestがbindingへ到達したこと | shimの受信記録と合成操作の対応で検証。H1とは呼ばない |
| 固定要求のH2→H3→callback | 実測する。shimが起こす固定輸送要求はprobe／origin=probe／親null。これは元のPlanRequestのengine由来を名乗る行ではない |

直接probeとbinding刺激による固定probeは試験系列・requestIdの対応をレポート側で区別する。H1行を実測ログに捏造せず、`fake` も実solverへ送らない。probe集計の生成行0を「engineの要求生成が0だった」と読み替えず、報告のengine生成欄は **未計測** とする。H2／H3の計数が利用可能でも、3計数口の実shell接続や稼働頻度の全体検証を完了とはしない。

タスク3の前倒し例外は設けない。H1の実接続、shellの送出枠1・保留契機1、Replanによる再開は、2.5合格とF-1承認の後に行う。2.2ではドライバの試行上限と固定solverの受理上限を検証し、これをshellの一時輸送管理の代用にはしない。

cloud投入は引き続きkeep right。共通の `SOLVER` bindingの向き先を変える場合、同居する通常店舗もshim経由になり得る。「通常店舗はTSで求解する」と「従来のTS直結経路が無変更」は同義ではない。対象外のTS転送・遅延／失敗の影響・shimの配置とbinding差分・復帰方法を配備案で明示し、既存の4項目の投入前確認へ含める。root設定は変更せず、追加Workerやcloud接続を暗黙に承認したことにしない。

今回の変更はこの方針と文書の整合だけ。既存の実測値・生レポート・実行ソースのハッシュは変更しない。

後続（2026-09-10）：[shim接続の実装・検証](./transport-shim-local-20260910.md)へ進んだ。直接probe／shim刺激をmanifestの別店舗へ固定し、上記の通常TS経路への影響は投入前確認の**第5項**へ独立させた。本書の測定値は変更せず、新しい成果の証拠は別レポートで示す。

## 再現

型の準備は [transport README](../../../../experiments/cpsat-workers/transport/README.md#再現) に従う。

```sh
pnpm typecheck
pnpm exec tsc --noEmit --project experiments/cpsat-workers/transport/tsconfig.json
pnpm test --project workers tests/cpsat-transport-request.example.test.ts
pnpm test --project tools tests/cpsat-transport-app.example.test.ts
node experiments/cpsat-workers/transport/check-app-local.mjs /tmp/NEW-provenance-report.json
pnpm test
```

loopback認可・全送出台帳／上限・停止条件・private合成操作／WS入口・配備差分などの残りも維持する。今回のローカル検査はcloud CPU・waitUntil余裕・cloud復帰の実測ではない。
