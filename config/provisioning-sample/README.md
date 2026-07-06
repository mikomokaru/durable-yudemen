# Provisioning 初期投入サンプル JSON

Provisioning_API（`/admin/*`・`Authorization: Bearer <ADMIN_TOKEN>`）へ投入する初期データのサンプル。
各ファイルは 1 つの admin エンドポイントのリクエストボディに 1:1 対応する。Worker は認可だけして
シングルトンの StoreRegistryDO へ素通し委譲し、ルート解釈・JSON パース・検証は DO 側で行う。

> これらは**サンプル**。実運用ではコピーして実値に書き換えて使う。`ADMIN_TOKEN` はコミットしない。

## ファイル → エンドポイント対応

| ファイル | メソッド / エンドポイント | 用途 |
| --- | --- | --- |
| `chain.sample.json` | `PUT /admin/chains/{chainId}` | チェーンの登録・更新（**全置換**。`name` 必須・`chainRoster` は全店有効の identity 集合） |
| `store-create.sample.json`（配列） | `PUT /admin/stores`（一括）または `POST /admin/stores`（単発） | **配列**なら `PUT /admin/stores` へ丸ごと送れる（一括冪等 upsert・all-or-nothing・下記参照）。単発作成は `POST /admin/stores`（`storeId` 省略で自動採番・`storeCode` は作成時のみ・`storeRoster` 同梱可） |
| `store-roster.sample.json` | `PUT /admin/stores/{storeId}` | 店舗の部分更新（`storeRoster` を送るとその配列で置換。当該店のみ有効の identity 集合）。作成後に名簿だけ改定する用途 |
| `store-deactivate.sample.json` | `PUT /admin/stores/{storeId}` | 店舗の退役（`active:false`。物理削除 API は無い＝非活性化で退役） |
| `policy.sample.json` | `PUT /admin/policies/{policyId}` | Policy の登録・更新（`fields` は `{ mode, value }`・mode は `enforced`／`default`） |

読み出し: `GET /admin/chains`・`GET /admin/stores`（`?chainId=` で絞込）・`GET /admin/stores/{storeId}`。
（注: `GET /admin/chains` はサマリのみで `chainRoster` を返さない。店舗は `GET /admin/stores/{id}` で `storeRoster` を確認できる。）

## identity の正準形（重要）

`chainRoster` / `storeRoster` に載せる identity は、Access が JWT の `email` クレームに載せる値と
`normalize`（前後空白除去・小文字化）後の正準形で**完全一致**する必要がある（要件6.3）。

- whereami（店舗 iPad）: 合成 email `staff-{storeCode}@yamaokaya.com`（例 `staff-1263@yamaokaya.com`）→ その店の `storeRoster`
- EntraID（人間・本部/SV）: 実 email（例 `tanaka@yamaokaya.com`）→ 権限範囲に応じ `chainRoster`（全店）または `storeRoster`（当該店のみ）
- 実効 Roster = 店舗 Roster ∪ 所属チェーンの chainRoster

登録前に trim + 小文字化した値を入れること。

## 値の検証範囲（`override` / Policy `fields` 共通の StoreConfig 相当フィールド）

| フィールド | 範囲 | 備考 |
| --- | --- | --- |
| `unitCount` | 1〜4 の整数 | 1 ユニット = 6 スロット |
| `arms` | 1〜10 の整数 | 同時に上げられる本数の上限 |
| `toleranceRatio` | 1〜50 の整数（％） | engine では `/100` で割合として使用 |
| `noodlePresets` | 非空配列 | 各要素 `{ noodleType: 非空文字列, boilSeconds: { extraHard, hard, normal, soft } }`・秒は正の整数 |

範囲外・型不一致・未知フィールドは 400 で拒否されイデアは不変（安全側）。

## 投入例（workers.dev・ADMIN_TOKEN は .dev.vars から読む例）

```sh
BASE=https://yude-men-timer.yamaokaya.workers.dev
TOKEN="$(grep -E '^ADMIN_TOKEN=' .dev.vars | cut -d= -f2-)"

# 1) チェーン（全置換・name 必須）
curl -X PUT "$BASE/admin/chains/yamaokaya" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data @config/provisioning-sample/chain.sample.json

# 2) 店舗作成（storeId 省略で自動採番。応答の storeId を控える）
curl -X POST "$BASE/admin/stores" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data @config/provisioning-sample/store-create.sample.json

# 3) 店舗 Roster 登録（{storeId} は 2) の応答値）
curl -X PUT "$BASE/admin/stores/{storeId}" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data @config/provisioning-sample/store-roster.sample.json

# 確認
curl -H "Authorization: Bearer $TOKEN" "$BASE/admin/stores/{storeId}"
```

## 一括冪等 upsert（配列を `PUT /admin/stores` へ）

複数店をまとめて登録／更新するなら、**店舗オブジェクトの配列**を `PUT /admin/stores` へ送る（`store-create.sample.json` は既にこの配列形）。

- 各要素は **`storeId` 必須**（冪等の鍵。一括では自動採番しない）。不在なら作成・存在すれば更新。
- **all-or-nothing**: 1 要素でも不正なら **400・失敗要素を全列挙・イデア一切不変**（妥当分も書かれない）。まず全件直してから送る。
- **冪等**: 同じ配列の再送は同じ状態へ収束（再実行安全）。
- **delete-missing なし**: 配列に載せなかった既存店舗は消えない（全置換ではない）。
- 各要素に `storeRoster` を同梱すれば「店＋名簿」を一括投入できる。

```sh
curl -X PUT "$BASE/admin/stores" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data @config/provisioning-sample/store-create.sample.json
# 応答: {"accepted":true,"count":N}  失敗時: 400 {"accepted":false,"failures":[{index,storeId?,failure}...]}
```

## 店舗の定義と名簿を 1 リクエストで（storeRoster 同梱）

`POST /admin/stores` は `storeRoster` を作成ボディに**同梱できる**（省略時は空名簿）。店舗の定義（config/override）と「その店に入れる identity」を 1 ドキュメント・1 呼び出しで自己完結させられる。以後の名簿改定は `PUT /admin/stores/{storeId}` が受ける。

```jsonc
{
  "storeId": "xxxx",
  "chainId": "yamaokaya",
  "storeCode": "1263",
  "name": "1263 つくば中央店",
  "override": { /* ... */ },
  "storeRoster": ["staff-1263@yamaokaya.com"]   // ← その店に入れる identity（省略時は空名簿）
}
```

- 名簿の値検証は `PUT /admin/stores/{storeId}` と同一（空文字列要素・非配列などは 400・イデア不変）。
- 本部・SV は各店に書かず **chainRoster に 1 回**（`chain.sample.json`）。実効 Roster = 店舗 Roster ∪ chainRoster。

## 補足

- `storeId` を省略すると自動スラッグ採番（合鍵 URL の推測困難性に有利）。明示するなら `[a-z0-9-]` 1〜64 文字で `store-create.sample.json` に `"storeId": "..."` を足す。使用済み ID・不正 ID は 400 で別 ID の代替受理はしない。
- `PUT /admin/chains` は**全置換**ゆえ、既存 `chainRoster` を保ちたいときは既存分 + 追加分の全量を送る（`GET /admin/chains` では中身が読めないため、運用側で登録値を正本として保持する）。
- `PUT /admin/stores/{id}` は部分更新。`storeRoster` を省略すれば既存の Roster は保持される。送った場合はその配列で置換。
