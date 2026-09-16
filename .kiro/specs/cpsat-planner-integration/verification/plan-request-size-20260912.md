# 往路のボディは Queue の 1 通に載るか — 実測

試験 `tests/cpsat-plan-request-size.example.test.ts`。クラウド変更なし。

Cloudflare Queues の 1 メッセージ上限は **128 KB**
（[限度](https://developers.cloudflare.com/queues/platform/limits/)）。実行契機を
Queue へ移す案は `PlanRequest` がその 1 通に収まることを前提にしているので、
前提を測った。

## 測り方

手で組んだ近似ではなく、**engine に `RequestPlan` を出させた**。`decide` へ到着を
流して計画対象の枠を埋め、続けて釜を全部塞ぎ、shell の `requestPlan` と同じ形
（`storeId` を添える）へ組んで UTF-8 バイト数を採る。

途中で気づいた点：指紋は計画対象（先頭 `PLAN_TARGET_LIMIT` 件）だけを畳むので、
枠が埋まったあとの到着では指紋が変わらず `RequestPlan` が出ない。最終遷移の
effects を見ると一番大きい要求を取り逃がす。**最後に出た**要求を採っている。

## 結果

| 条件 | 釜 | 品名の長さ | バイト数 | 128 KB に対して |
|---|---|---|---|---|
| 実データ寄り | 3 ユニット / 18 スロット | 「特味噌ネギラーメン」27 B | **44,081** | **33.6%** |
| 構造上の最悪 | 4 ユニット / 24 スロット | 312 B | **77,696** | **59.3%** |

どちらも `pending` 64（＝`PLAN_TARGET_LIMIT`）、`shownPlan` 64、`running` は
スロット数いっぱいで、**engine の上界に 3 つとも張り付いた状態**である。

## 上界が効いている理由

- `pending` は待ち行列全体（`ORDER_ITEM_LIMIT` = 4096 件）ではなく、
  **計画対象の先頭 `PLAN_TARGET_LIMIT` = 64 件**だけが載る。ここが効いている。
  4096 件が載る形だったら 128 KB では収まらない。
- `running` は `unitCount × SLOTS_PER_UNIT`。`UNIT_COUNT_MAX` = 4、
  `SLOTS_PER_UNIT` = 6 なので最大 24。
- `shownPlan` も `PLAN_TARGET_LIMIT` 件。

## 残る変数

**文字列長には domain の上限が無い。** `externalOrderId`・`tableId`・`itemName`・
`sizeName` は非空の文字列というだけで、長さを縛っていない
（`toDeclaredName`／`isNonEmptyString`）。上の最悪ケースは品名 312 バイト
（日本語 104 文字）で測っており、伝票に載る現実からはかなり外れた長さである。
それでも 59.3% なので、実運用で 128 KB に届く見込みは薄い。

ただし「届かない」を**型で保証してはいない**。POS が極端に長い商品名を送れば
理屈の上では超えうる。Queue を採るなら、送出前にサイズを検査して超過を
観測可能な失敗にする関門が要る（黙って落とさない）。

## 判定

**収まる。** 実データ寄りで上限の 1/3、構造上の最悪でも 6 割。参照渡し
（DO 側に置いて鍵だけ送る）は要らない。

`execution-trigger-options-20260912.md` の確認事項 1 は解消。残るのは 2（配送
遅延）・3（consumer が連鎖の外か）・4（順序）である。
