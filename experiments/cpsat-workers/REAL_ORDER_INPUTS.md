# 実注文による試験: 入力確認（2026-09-08）

**入力監査・設定取得の記録。店舗対応とローカル商品表の利用はユーザー確認済み。**
続く100局面・Workerd 1,000回の結果は [REAL_ORDER_RESULTS.md](REAL_ORDER_RESULTS.md)。
既存 engine・DO・UI・永続形式は変更せず、注文の送信、設定の更新、追加デプロイも行っていない。

## 取得できたもの

- `docs/data_samples/kenbaiki_orders/`: 10店舗、各30注文、計300注文・943品目。
- 全ファイルは申告日時の昇順。対象日は2026-09-06、各窓は約26〜54分。
- キー（store_id / terminal_id / bill_no / datetime）の重複0、取消0、qty≠1の親品目0。
- 同じGitリポジトリの元ディレクトリにある `.dev.vars` の `ADMIN_TOKEN` で admin GET 成功。
  認証値は表示・コピー・保存していない。店舗一覧は196件。
- 下記10候補の個別GETはすべて200。釜数は9店舗が2ユニット、1店舗が3ユニット。
  茹で時間は店舗差があるため、共通のサンプル秒数へ置き換えない。

| 注文の store_id | admin候補の storeCode | unitCount | REG normal（秒） |
| --- | --- | --- | --- |
| 239 | 1239 | 2 | 390 |
| 247 | 1247 | 2 | 360 |
| 254 | 1254 | 2 | 390 |
| 275 | 1275 | 2 | 360 |
| 284 | 1284 | 2 | 390 |
| 336 | 1336 | 2 | 390 |
| 342 | 1342 | 2 | 390 |
| 355 | 1355 | 2 | 390 |
| 362 | 1362 | 2 | 390 |
| 364 | 1364 | 3 | 360 |

**上の +1000 対応は、候補提示後にユーザーが確認・承認した。** admin 一覧の名称で候補を選び、
個別GETの storeCode を確認した。取得時の原本メタデータは「候補」のまま保存し、この文書に後続の承認を記録する。

全店舗が `pos-menu` Policy を参照しており、override 自体は商品対応表を含まない。
`GET /admin/policies/pos-menu` は404。ローカル実装にもPolicyのGET経路はない。
したがって、取得したoverrideだけで「実効設定取得済み」とはしない。

元リポジトリの `config/provisioning-sample/pos-menu-policy.json`（未追跡ファイル）に、
58親商品・3硬さの対応表があった。SHA-256:
`9d30ff63679392440a54d51e634c5715fa46bae896be558a02edd54a38eae2b6`。
**試験への利用はユーザー承認済み。現在デプロイされているPolicyと同じかは未確認。**

## ローカル商品表との照合結果

既存の純粋関数 `toNoodleSpec` と `toUniqueKey` をそのまま呼び、POS解釈を試験側で再実装していない。

- 調理対象として解釈できた品目: **359**。
- 子項目を持つ品目: 359。うち解釈できなかった品目: **0**。
- 子項目なし: 584（現行取り込み規則では調理対象外）。商品名から麺と推測して追加していない。
- 対応表に載っている親なのに麺量を解釈できない品目: 0。

これは入力のカバレッジであり、359品目の計画が妥当、CP-SATが解ける、Workersで安定する、という結果ではない。

## 再現とローカル原本

`fixtures/local/` と注文JSONLはGit対象外。削除・原本変更はしていない。

- `fixtures/local/admin-settings.json`: 2026-09-08T12:20:45.532Z取得の候補10店舗。
  Roster・認証値を除外。店舗対応未確認・Policy GET失敗も記録。
- `fixtures/local/pos-menu-policy.json`: 上記ローカル商品表の内容固定コピー。
- `fixtures/local/order-input-audit.json`: 注文原本ごとのSHA-256・件数・解釈結果。

リポジトリrootで入力監査を再現（通信なし、stdoutのみ）:

```sh
pnpm exec vite-node --config tools/preflight.vite.config.ts \
  experiments/cpsat-workers/scripts/inspect-real-orders.ts \
  docs/data_samples/kenbaiki_orders \
  experiments/cpsat-workers/fixtures/local/pos-menu-policy.json
```

現在のadmin設定を再取得（GETのみ、stdoutのみ。AUTH_FILEは `.dev.vars` のパスに置換）:

```sh
pnpm exec vite-node --config tools/preflight.vite.config.ts \
  experiments/cpsat-workers/scripts/read-admin-settings.ts \
  AUTH_FILE 1239 1247 1254 1275 1284 1336 1342 1355 1362 1364
```

接続先は既存の `yude-men-timer.yamaokaya.workers.dev` に固定し、リダイレクトを拒否する。
再取得値はその時点の設定であり、上の取得結果や2026-09-06当時の設定と同一とは限らない。
認証付きの一覧から名称で候補を探し、個別GETのstoreCodeが完全一致することを確認する。
再取得コマンドはPOS番号との対応を推測しない。

## 計画試験の前提

1. 注文番号とadmin店舗番号の +1000 対応はユーザー確認済み。この10店舗に限定する。
2. 上記ローカル商品表を試験入力として採用することはユーザー承認済み。本番との同一性は別の確認事項。
3. `payload.datetime` は全件timezoneなしで、上流の `arrival_timestamp_ms` / `sequence_number` も全件欠落。
   JSTの申告日時を到着時刻の代用とし、原文・行位置を保持する方針。元の配送時刻や配送順の再現とは区別する。
4. 注文窓の開始前の受注・釜占有・スタッフ操作・表示済み計画はない。
   空釜から現行engineを使って進めた**実注文ベースのシミュレーション**として局面を切り出す。
   過去StoreDOの完全再生とは呼ばない。短い切り取り窓の開始直後には空釜バイアスがある。
   全300注文の `table_no` は1。実データの値を保持し、複数卓を捏造していない。
5. 性能は合否にせず、対象品目の欠落・重複、占有の衝突、茹で時間、上げの制約、反復時の有効解を検査する。
   solverの成功statusだけでは合格にしない。seed・基準時刻・入力hash・予算・結果を固定して記録する。

監査用CLIの型検査・lintと、再利用するPOS解釈/識別子の既存26テストが成功。
