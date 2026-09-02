# POS Records Ingest API 契約

## 1. 目的

この文書は、Ingest がPOS由来のRecordをゆで麺タイマーへ送るためのHTTP契約を定める。

送信先は環境ごとに払い出されたベースURLを使う。店舗ごとにURLを切り替えない。1リクエストに複数店舗のRecordを含めてよい。

## 2. エンドポイント

```http
POST {BASE_URL}/pos/records
Authorization: Bearer {ORDER_INGRESS_TOKEN}
Content-Type: application/json
User-Agent: {送信元識別子}
```

| 項目 | 値 |
| --- | --- |
| Method | `POST` |
| Path | `/pos/records` |
| Authentication | Bearer token |
| Token | 環境ごとに共有された `ORDER_INGRESS_TOKEN` |
| Request content type | `application/json` |
| Success content type | `application/json` |
| User-Agent | 送信元を名乗る固有の値（HTTPクライアントの既定値を使わない） |

`ADMIN_TOKEN` は使用しない。URLの `{BASE_URL}` とトークンは環境ごとに確認する。

`User-Agent` は必ず送信元固有の値を明示する。HTTPクライアントライブラリの既定値（`Python-urllib/3.13` など）はCloudflareのBrowser Integrity Checkに遮断され、Workerに到達しない（§7.2）。

## 3. リクエストボディ

トップレベルは `records` 配列だけを必要とする。

```json
{
  "records": [
    {
      "path": "/lio/order",
      "arrival_timestamp_ms": 1787911200000,
      "sequence_number": "49590338271490256608326543212345678901234567890123456789",
      "payload": {
        "store_id": 1263,
        "terminal_id": 1,
        "bill_no": 1084,
        "datetime": "2026-08-28T19:00:00",
        "order_id": "1263-1-1084",
        "table_no": 12,
        "order_items": [
          {
            "plu_no": 11421,
            "item_type": 1,
            "qty": 1,
            "child_items": [
              { "plu_no": 19401, "s_class_code": 65 },
              { "plu_no": 10010, "s_class_code": 66 }
            ]
          }
        ]
      }
    }
  ]
}
```

この例の時刻は説明用である。実際の送信では、Recordを観測した時点のepochミリ秒を `arrival_timestamp_ms` に設定する。

### 3.1 バッチ

| フィールド | 必須 | 型 | 条件 |
| --- | --- | --- | --- |
| `records` | 必須 | array | 0〜1000件。空配列は有効 |

トップレベルの余剰フィールドは無視される。1001件以上を送ると、バッチ全体が `503` になる。

`records` は観測順に並べる。同一店舗のRecordは配列順のまま処理されるため、同一端末の `sequence_number` が増加する順序を崩さない。

### 3.2 Record共通フィールド

| フィールド | 必須 | 型 | 条件・意味 |
| --- | --- | --- | --- |
| `path` | 必須 | string | 非空。現在の既知値は `/lio/order` と `/lio/status` |
| `arrival_timestamp_ms` | 必須 | integer | 0以上のepochミリ秒。受信時刻の2時間前から受信時刻まで |
| `sequence_number` | 必須 | string | 非空。端末ごとに厳密に増加する値 |
| `payload` | 必須 | object | `null` と配列は不可。POS由来の内容を保持する |

Record直下の余剰フィールドは処理に使われない。`payload` の余剰フィールドは許容される。

### 3.3 `sequence_number` の規則

`sequence_number` は端末ごとの冪等性と順序判定に使う。

- 同じ `terminal_id` では、後から観測したRecordほど大きい値にする。
- 固定桁の10進数文字列を推奨する。現行KDSは56桁を想定している。
- 比較は、桁数が異なる場合は長い方を新しい値とし、同じ桁数なら文字列の辞書順を使う。
- 直前以下の値は重複または古いRecordとして読み飛ばされる。
- 内容を訂正して再送するときも、同じ `sequence_number` は使わない。訂正版には新しい値を付ける。

ネットワーク失敗や `5xx` に対する同一リクエストの再送では、元の `sequence_number` を変えない。受信側が重複を吸収する。

## 4. オーダーRecord

`path` が `/lio/order` のRecordをオーダーとして扱う。

### 4.1 識別と配送に必要な`payload`フィールド

| フィールド | 必須 | 型 | 意味 |
| --- | --- | --- | --- |
| `store_id` | 必須 | non-empty string または finite number | 店舗コード。配送先店舗の解決に使う |
| `terminal_id` | 必須 | non-empty string または finite number | 端末識別子。`sequence_number` の判定単位に使う |
| `bill_no` | 必須 | non-empty string または finite number | 伝票番号 |
| `datetime` | 必須 | non-empty string または finite number | POSが申告する伝票日時 |

受信側は上記4値を文字列化し、`store_id + terminal_id + bill_no + datetime` からオーダーの一意キーを作る。`order_id` は一意キーに使用しない。

値が欠落、`null`、空文字、または上記以外の型の場合、そのRecordはオーダーとして取り込まれない。

### 4.2 オーダー内容

`payload` はベンダー由来の形を保って送る。Ingestで麺種や硬さへ変換しない。

| フィールド | 必須 | 型 | 意味 |
| --- | --- | --- | --- |
| `table_no` | 任意 | non-empty string または finite number | 卓番号。欠落または `0` は卓指定なし |
| `order_items` | 任意 | array | 注文品目。欠落または配列以外なら茹で対象0件 |
| `order_items[].plu_no` | 品目による | positive integer | 親商品の商品コード |
| `order_items[].child_items` | 任意 | array | 麺量・硬さなどの子商品 |
| `order_items[].child_items[].plu_no` | 子商品による | positive integer | 子商品の商品コード |

商品コードは数値文字列ではなくJSON numberで送る。`item_type`、`qty`、`s_class_code` は現在の麺種・硬さ判定には使われないが、Ingestでは削らずPOS由来の `payload` を保持する。

商品コードから麺種、硬さ、使用スロット数への変換は受信側の店舗設定で行う。対応表にない商品は茹で対象にならないが、それだけを理由にHTTPリクエストは失敗しない。

同じ一意キーの新しいRecordは、未着手品目を後着の内容で置き換える。`order_items` が茹で対象0件になった新しいRecordは、そのオーダーの未着手品目を取り除く。

## 5. ステータスRecord

`path` が `/lio/status` のRecordは受信できる。ただし、現時点では件数を記録した後に破棄する。

ステータスRecordから端末状態の更新や通知は行わない。`/lio/status` でも、Record共通フィールドの条件は同じである。

## 6. Record単位の処理

バッチ内のRecordは個別に分類される。1件の不正Recordを理由に、同じバッチの正常Recordを拒否しない。

| Recordの状態 | 処理 |
| --- | --- |
| 正常な `/lio/order` | 店舗へ配送し、未着手オーダーへ反映 |
| `/lio/status` | 件数を記録して破棄 |
| 未知の `path` | 件数を記録して破棄 |
| `path`、`payload`、`sequence_number`、一意キーの構造不正 | 診断を記録して破棄 |
| `arrival_timestamp_ms` の型不正、未来時刻、2時間より古い時刻 | `store_id` を読めれば契約違反として隔離し、オーダーには反映しない。読めなければ診断を記録して破棄 |
| 未登録の `store_id` | Recordを最長2時間保留し、期間内に店舗が登録されたら再生 |
| 無効化済み店舗 | 件数を記録して破棄 |

したがって、`200 {"accepted":true}` は「すべてのRecordがオーダーになった」という意味ではない。バッチを処理し、配送または必要な保留を確定したことを表す。

## 7. レスポンス

| 条件 | Status | Body | Ingestの動作 |
| --- | ---: | --- | --- |
| バッチの処理が確定 | `200` | `{"accepted":true}` | 完了。再送しない |
| Bearer tokenの欠落・不一致 | `401` | `Unauthorized` | 設定を修正する。同じ条件で再送しない |
| `POST` 以外 | `405` | `Expected POST` | リクエストを修正する |
| JSON不正、または`records`が配列でない | `400` | `Invalid body` | ボディを修正する |
| 1001件以上 | `503` | `Too many records` | 1000件以下へ分割して再送する |
| 一時的な配送・永続化失敗 | `503` | `Retry` | 同じバッチを再送する |
| ネットワーク失敗、その他の`5xx` | 状況による | 状況による | 同じバッチを再送する |

エラーBodyはプレーンテキストである。

### 7.1 再送

`503`、その他の`5xx`、タイムアウト、接続切断では、同じバッチを再送する。

1バッチに複数店舗がある場合、`503` の前に一部店舗だけ確定している可能性がある。バッチ全体をそのまま再送してよい。確定済みRecordは `sequence_number` により重複排除される。

再送には指数バックオフとジッターを使う。`400`、`401`、`405` は同じ内容を再送しても成功しないため、自動再送しない。

### 7.2 Worker到達前の遮断（`403` / error code 1010）

`403` は上の表に無い。この契約のレスポンスではなく、Cloudflareのエッジが**Workerを実行する前**に返す遮断である。本文に `error code: 1010` を含むHTMLが返る。

原因はBrowser Integrity Check（BIC）である。BICはゾーンで既定有効であり、ボットやクローラが典型的に使う非標準の `User-Agent` を遮断する。HTTPクライアントライブラリの既定値（`Python-urllib/3.13` など）がこれに該当する。

Ingestの動作は**再送ではなく `User-Agent` の明示**である。同じ `User-Agent` で再送しても結果は変わらない。

| 観測 | 遮断した主体 | 対処 |
| --- | --- | --- |
| `403`・本文に `error code: 1010` | エッジのBIC（Worker未到達） | 送信元固有の `User-Agent` を設定する（§2） |
| `401`・本文 `Unauthorized` | Worker | Bearer tokenを修正する（§7） |

この遮断はWorkerが動く前に成立するため、Workers Logsには現れない。`403` を見たらまずリクエストの `User-Agent` を確認する。Cloudflareダッシュボードの Security Events で Service が `bic` であることを確認できる。

送信元のクライアントを制御できず `User-Agent` を変えられない場合に限り、ゾーン側でBICを緩める。そのときもゾーン全体では無効化せず、Configuration Ruleで `/pos/records` のパスにスコープする。

## 8. cURL例

```sh
BASE_URL="https://example.workers.dev"
ORDER_INGRESS_TOKEN="replace-with-shared-secret"

curl -X POST "$BASE_URL/pos/records" \
  -H "Authorization: Bearer $ORDER_INGRESS_TOKEN" \
  -H "Content-Type: application/json" \
  -A "pos-record-forwarder/1.0" \
  --data-binary @records.json
```

成功例:

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"accepted":true}
```

リポジトリ内の複数店舗・ステータス混在例は `config/pos-records-sample/records.sample.json` にある。サンプルの `arrival_timestamp_ms` は固定値なので、実際に送信するときは現在の2時間窓内の観測時刻へ置き換える。

## 9. Ingest実装チェックリスト

- [ ] `POST /pos/records` へ送っている。
- [ ] `Authorization: Bearer ...` に環境別の `ORDER_INGRESS_TOKEN` を設定している。
- [ ] `Content-Type: application/json` を設定している。
- [ ] `User-Agent` に送信元固有の値を設定し、HTTPクライアントの既定値を使っていない。
- [ ] 1バッチを1000件以下にしている。
- [ ] `arrival_timestamp_ms` はRecord観測時のepochミリ秒である。
- [ ] 送信待ちにより2時間を超えたRecordを監視できる。
- [ ] `sequence_number` は同一端末内で厳密に増加する。
- [ ] 通信再送では元の `sequence_number` を保持する。
- [ ] `payload` を独自のオーダー形式へ変換せず、POS由来のフィールドを保持する。
- [ ] `503`、その他の`5xx`、通信失敗をバッチ単位で再送する。
- [ ] `400`、`401`、`405` を自動再送せず、設定またはデータ不備として通知する。
- [ ] `403`（error code 1010）を再送せず、`User-Agent` の設定不備として扱う。
- [ ] `200` をRecordごとの妥当性保証として扱わない。

## 10. 使用しない経路

`POST /s/{storeId}/orders` は、宛先店舗と翻訳済み品目を直接指定する運用・試験用の別契約である。POS Record Forwarderからは使用しない。

## 11. 契約の正本

この文書は現行実装の外部契約を要約している。実装上の正本は次のファイルにある。

- HTTP入口・レスポンス: `src/worker.ts`
- バッチとRecordの構造: `src/ingress/batch.ts`
- Record分類: `src/ingress/outcome.ts`
- 一意キー: `src/ingress/unique-key.ts`
- 冪等性と順序比較: `src/engine/state.ts`
- POSサンプル: `config/pos-records-sample/records.sample.json`

§7.2 の `403` / error code 1010 はこの一覧に含まれない。リポジトリのコードではなくCloudflareゾーンの設定（Browser Integrity Check）が正本である。
