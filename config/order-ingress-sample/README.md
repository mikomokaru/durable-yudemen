# Order_Ingress 投入サンプル JSON

POS が未着手オーダーの到着・キャンセルを届ける経路（`POST /s/{storeId}/orders`・
`Authorization: Bearer <ORDER_INGRESS_TOKEN>`）のリクエストボディのサンプル。

鍵は `ADMIN_TOKEN`（Provisioning_API）とは**別の secret** である。POS は設定を投入する主体ではないため、
運用系の書き込み口を開かない。本番は `wrangler secret put ORDER_INGRESS_TOKEN`、ローカル dev は `.dev.vars`。

## ファイル → 意図の対応

| ファイル | ボディの形 | 用途 |
| --- | --- | --- |
| `order-arrival.sample.json` | `{ "items": [...] }` | オーダーの到着。新規・再送・変更（modification）をこの 1 形で受ける（同一 `externalOrderId` は upsert・到着時刻は保持） |
| `order-cancel.sample.json` | `{ "cancelledOrderId": "..." }` | 未着手オーダーの取り消し。対応が無ければ no-op（開始済みタイマーは自動キャンセルしない） |

**1 ボディ 1 意図。** `items` と `cancelledOrderId` の両方を載せた形も、どちらも載せない形も 400 で拒否する。

## 品目の属性

| フィールド | 値 | 備考 |
| --- | --- | --- |
| `externalOrderId` | 非空文字列 | POS 側のオーダー識別子。再送の同定と冪等の鍵 |
| `itemIndex` | 0 以上の整数 | 同一オーダー内の品目連番。`externalOrderId` との組で 1 品目を指す |
| `noodleType` | 店舗設定の麺種 | 未知の種別は 400（店舗の `noodlePresets` に無い麺は受けない） |
| `firmness` | `extraHard` / `hard` / `normal` / `soft` | 茹で加減 |
| `tableId` | 文字列または `null`（省略可） | 同卓提供を揃える単位。`null`・省略は単独グループ |

`boilSeconds` と `arrivalTime` はボディに含めない。前者は店舗設定から引く導出値、後者は「受理した絶対時刻」
という受け手側の事実である（POS の主張で待ち時間の起点を動かさない）。

**1 品目でも不正なら到着全体を 400 で拒否する**（部分受理は現場が欠品に気づけない嘘になる）。受理応答は
永続が確定した後にのみ返る（`{"accepted":true}`）。永続に失敗したときは 503 で、再送に委ねる（再送は冪等）。

## 投入例

```sh
BASE=https://yude-men-timer.yamaokaya.workers.dev
TOKEN="$(grep -E '^ORDER_INGRESS_TOKEN=' .dev.vars | cut -d= -f2-)"

curl -X POST "$BASE/s/{storeId}/orders" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data @config/order-ingress-sample/order-arrival.sample.json

curl -X POST "$BASE/s/{storeId}/orders" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data @config/order-ingress-sample/order-cancel.sample.json
```
