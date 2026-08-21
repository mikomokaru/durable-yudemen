# POS_Ingress 投入サンプル JSON

上流（Record_Forwarder）が券売機由来の Record をまとめて届ける経路（`POST /pos/records`・
`Authorization: Bearer <ORDER_INGRESS_TOKEN>`）のリクエストボディのサンプル。

鍵は既存の Order_Ingress と同じ `ORDER_INGRESS_TOKEN` で、`ADMIN_TOKEN`（Provisioning_API）とは**別の
secret** である。本番は `wrangler secret put ORDER_INGRESS_TOKEN`、ローカル dev は `.dev.vars`。

## ファイル → 意図の対応

| ファイル | 送り先 | 用途 |
| --- | --- | --- |
| `records.sample.json` | `POST /pos/records` | Arrival_Batch。複数店舗混在の 3 Record（Order_Path 2 件・Status_Path 1 件） |
| `noodle-tables.sample.json` | `PUT /admin/stores/{storeId}` | 麺の対応表 2 枚（`firmnessCodes` / `menuItems`）の投入。詳細は下記「対応表の投入」 |

> これらは**サンプル**。実運用ではコピーして実値に書き換えて使う。商品コードは判明分（親品目 `11421`＝
> 特味噌ネギラーメン・`116051`＝新プレ塩、麺量 `19401`＝普通・`19603`＝大盛、硬さ `10010`＝かため・
> `10011`＝ふつう）に基づく。

## 既存の Order_Ingress との違い（宛先の所在）

両経路は用途が重ならないため併存する。違いは**宛先をどこに載せるか**の一点である。

| | `POST /s/{storeId}/orders`（既存） | `POST /pos/records`（本経路） |
| --- | --- | --- |
| 宛先 | **URL**（`storeId` をパスに載せる） | **ボディ**（`payload.store_id` = Store_Code から逆引き） |
| 1 リクエストの宛先数 | 1 店舗 | 複数店舗が混在してよい |
| ボディ | `{ "items": [...] }`（翻訳済みの品目） | `{ "records": [...] }`（POS の生ペイロード） |
| 麺の指定 | `noodleType` / `firmness` を直接送る | 商品コードを送り、店舗設定の対応表で翻訳する |
| 送り主 | 運用・試験（宛先が既知の単一店舗） | 上流 Record_Forwarder（設定値の 1 URL へ投げる） |
| 未知の宛先 | 400（`storeId` が不正） | 保留し、店舗登録の確定で待ち行列へ届ける |
| 冪等の鍵 | `externalOrderId`（upsert） | 端末ごとの `sequence_number` の単調性 |

上流は宛先ごとに URL を切り替えられないため、既存経路では受けられない。逆に本経路は Store_Code の登録を
前提とするため、単発の投入試験には既存経路の方が短い。

## Record の形

1 Record は上流が付与するメタデータ 3 項目とベンダー由来の `payload` から成る。

| フィールド | 値 | 備考 |
| --- | --- | --- |
| `path` | `/lio/order` または `/lio/status` | 既知 2 種以外は未知 `path` として数えて破棄。空文字は Poison_Record |
| `arrival_timestamp_ms` | 非負整数（epoch ミリ秒） | Order_Arrival_Time の起点。受理時刻の 2 時間前から受理時刻までが値域窓 |
| `sequence_number` | 非空文字列（KDS の 56 桁） | 冪等の判定材料。端末ごとに単調性で重複を弾く |
| `payload` | オブジェクト | ベンダー由来の申告値。**中身は検証しない** |

`/lio/status`（端末のエラー状態）は届いても破棄し、件数だけを `statusDiscarded` に数える。端末の沈黙判定・
通知は本経路の範囲外である。

**`payload` の中身は素通しする**（Pass_Through）。未知フィールドの追加・想定外の値・想定と異なる型は
いずれも拒否事由にしない。ベンダーがフィールドを 1 つ足しただけで受信が止まる形を作らないためである。
拒否するのは「retry しても直らず、かつ処理を続けられない」場合だけで、実質は Unique_Key の 4 要素
（`store_id` / `terminal_id` / `bill_no` / `datetime`）を導出できない Record に限る。

実データでは `store_id` / `terminal_id` / `bill_no` が数値で届き `datetime` が文字列で届く。どちらの表現でも
同じ関門を通し、文字列化して Unique_Key を組む（ペイロード自体は書き換えない）。

## 応答

| 状況 | 応答 |
| --- | --- |
| 受理（全宛先が確定・保留も確定） | 200 `{"accepted":true}` |
| 認可失敗 | 401（`unauthorized` に数え、診断ログを 1 行出す） |
| POST 以外 | 405 |
| ボディが `records` 配列を成さない | 400 |
| Record が 1000 件を超える | 503（上流の bisect による分割に委ねる） |
| 宛先が未プロビジョニング・`put` 失敗 | 503（Arrival_Batch 全体。再送時の重複は冪等が吸収する） |

判定の順は認可 → メソッド → ボディ → 件数上限である。認可が先ゆえ、鍵を持たない `GET` は 405 ではなく 401 に
なる。個々の Record の異常（Poison・未知 `path`・契約違反）はバッチを落とさず、飛ばして数える。

## 投入例

```sh
BASE=https://yude-men-timer.yamaokaya.workers.dev
TOKEN="$(grep -E '^ORDER_INGRESS_TOKEN=' .dev.vars | cut -d= -f2-)"

curl -X POST "$BASE/pos/records" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data @config/pos-records-sample/records.sample.json
# 応答: {"accepted":true}
```

観測は 1 リクエストにつき 1 行の構造化ログ（`{"posIngress":"counts",...}`）で、捨てた Record ごとに
`{"posIngress":"diagnostic",...}` が先に並ぶ。`wrangler tail` で読める。

## 対応表の投入（`firmnessCodes` / `menuItems`）

商品コードから麺の 3 つの事実（麺種・茹で加減・スロット幅）への翻訳は、店舗設定の対応表 2 枚が担う。
**値はコードに埋め込まない。** 投入は Provisioning_API（`ADMIN_TOKEN`）で行う。

| 表 | 形 | 意味 |
| --- | --- | --- |
| `firmnessCodes` | `{ code, firmness }` の配列 | 硬さの商品コード → `extraHard` / `hard` / `normal` / `soft` |
| `menuItems` | `{ productCode, noodleType, sizes }` の配列 | 親商品コード → 麺種と麺量群。`sizes` は `{ code, slotSpan }` の非空配列（`slotSpan` は 1〜6） |

`menuItems[].noodleType` は店舗の `noodlePresets` に在る麺種を指す。投入時にこの整合は検査しない（3 層の
合成後でしか判定できない）。合成後に引けない麺種の品目は取り込みの段で弾き、`unknownNoodleType` に数える。

```sh
BASE=https://yude-men-timer.yamaokaya.workers.dev
ADMIN="$(grep -E '^ADMIN_TOKEN=' .dev.vars | cut -d= -f2-)"

# 1) 現在値を読む（override は丸ごと置換ゆえ、既存の項目も同じボディに含める）
curl -H "Authorization: Bearer $ADMIN" "$BASE/admin/stores/{storeId}"

# 2) 2 枚を足した override を送る
curl -X PUT "$BASE/admin/stores/{storeId}" \
  -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  --data @config/pos-records-sample/noodle-tables.sample.json
```

**`override` は部分マージではなく丸ごと置換である。** 2 枚だけを送れば `unitCount` / `arms` /
`toleranceRatio` / `noodlePresets` は既定へ戻る。`noodle-tables.sample.json` が 6 項目すべてを載せて
いるのはこのためで、コピーして使うときも同じ形を保つ。

チェーン共通の表なら Policy で配る方が短い（層ごとの丸ごと置換は同じ規則である）。

```jsonc
// PUT /admin/policies/{policyId}
{
  "fields": {
    "firmnessCodes": { "mode": "default", "value": [{ "code": 10010, "firmness": "hard" }] },
    "menuItems": { "mode": "default", "value": [/* ... */] }
  }
}
```

範囲外・型不一致・未知フィールドは 400 で拒否され、イデアは不変である（拒否理由は全件列挙される）。

### 表が空のままでも経路は成立する

対応表の値が未提示なら、空の表（既定）で投入せずに始めてよい。麺量の商品コードを引けない品目は
「茹でない」に落ちるため、**茹で対象が 0 件になるだけで取り込みは成立する**——受理は 200 で返り、
判定材料（`sequence_number`）も進み、再送は冪等に吸収される。表を投入した時点から待ち行列へ写り始める。

この挙動は次の 2 箇所で固定されている。

- `tests/ingress/noodle-spec.example.test.ts` — 空の表なら常に `null`（純粋層）
- `tests/shell/pos-records.integration.test.ts` — 空の表で受領が確定し待ち行列が 0 件（DO 越し）

## 保留 1 キーのサイズ（本番投入前に実データで再確認する）

宛先が未登録の Record は `unrouted:{storeCode}` の 1 キーに保留され、1 Store_Code あたり最大 **2000 Record**
を持つ。SQLite バックエンドの上限は「キーと値の合計で 2 MB」（[Durable Objects の Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)）で、
現時点の見積もりは次のとおりである。

| 項目 | 値 |
| --- | --- |
| 1 キーの上限 | キーと値の合計で 2 MB = **2,097,152 バイト** |
| 1 件の実測（見積もり） | 約 711 バイト（参考：`records.sample.json` の 1 件目＝2 品目は JSON 換算 530 バイト） |
| 2000 件 | 約 1,422,000 バイト（余裕は約 3 割） |
| 上限を破る 1 件のサイズ | **1,048 バイト**（= 2,097,152 ÷ 2000） |

**品目数の多い注文が続けば余裕は消える。** 1 件 1,048 バイトを超えると 2000 件で上限を破り、`put` 失敗 →
`persist-failed` → 503 となって**その店舗の保留が書けなくなる**。欠落ではない（上流が再送する）が、
登録が済むまで詰まる。件数上限は現状維持の判断ゆえ変えない。**本番投入の前に実データでサイズを測る。**

```sh
# 実データの Record 1 件を record.json に保存してから測る。
# 保留の値は HeldRecord（kind / heldAt / 検証済み record）の配列ゆえ、その包みを含めて測る。
node --input-type=commonjs -e '
  const { readFileSync } = require("node:fs");
  const r = JSON.parse(readFileSync("record.json", "utf8"));
  const held = {
    kind: "unrouted",
    heldAt: Date.now(),
    record: {
      path: r.path,
      payload: r.payload,
      arrivalTimestampMs: r.arrival_timestamp_ms,
      sequenceNumber: r.sequence_number,
    },
  };
  const bytes = Buffer.byteLength(JSON.stringify(held));
  // limit は 2 MB = 2,097,152 バイト。保留は HeldRecord の配列ゆえ 2000 件分の合計で見る。
  console.log({ bytes, at2000: bytes * 2000, limit: 2 * 1024 * 1024 });
'
```

`at2000` が `limit` を下回れば現状の上限で足りる。上回るなら、件数上限の引き下げか保留キーの分割を
design の変更として検討する（どちらも確定事項ゆえ、実装だけで変えない）。数値は JSON 換算の目安である
（永続の直列化は structured clone ゆえ厳密には一致しない）。品目数の多い注文（麺 5 品目以上）を含む
実データで測ること——平均ではなく上側で効く制約である。
