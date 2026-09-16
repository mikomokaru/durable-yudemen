# 送出を await しない形 — cloud 検証

証拠 `cloud-do-occupancy-noawait2-20260912.json`（有効窓での本番）、
`cloud-do-occupancy-noawait-20260912.json`（無効 manifest の失敗試行・下記5）。
比較対象は `cloud-do-occupancy-20260912.md`（await する現行形）。

## 何を試したか

「DO は送出を await せず、solver が解けたら自分で DO を引っ張り出して書き込む」
という案を、**本番コードを触らずに**試す。連鎖は DO → shim → solver で、DO は
shim を await する。**shim が solver を await せず即 202 を返せば**、DO の await
は一瞬で終わり、DO 側を await なしにしたのと同じ状態になる。

shim だけを差し替えた（版 `5d06def7-a1ec-4a7c-a67f-e7551652cb1c`）。
変更は 1 箇所で、対象外店舗の素通し経路（`shim.ts:77`）は無変更。

```
- return dispatchCpsatTransportRequest(input, env.CPSAT_SOLVER, withinWindow);
+ ctx.waitUntil(dispatchCpsatTransportRequest(input, env.CPSAT_SOLVER, withinWindow));
+ return Response.json({ accepted: true, requestId }, { status: 202 });
```

## 結果

| ラウンド | 平常時の接続 | 求解中の接続 | 注文全体 | shim invocation | solver | 重なり |
|---|---|---|---|---|---|---|
| 0 | 125, 114ms | 466ms | 717ms | +195、**542ms** | 541ms / CPU 536 | ✓ |
| 1 | 150, 195ms | 456ms | 704ms | +163、**584ms** | 584ms / CPU 573 | ✓ |
| 2 | 126, 116ms | 492ms | 742ms | +154、**616ms** | 616ms / CPU 608 | ✓ |

求解は 3 件とも実行された（`solve-started` → `solve-finished: UNKNOWN` →
`callback-returned: delivered` が各 3 件）。

**shim は 202 を即座に返したのに、shim の invocation は求解が終わるまで開いた
ままだった**（542〜616ms、solver の wall とほぼ同一）。そして**呼出元の DO は
その 202 で解放されなかった**——注文は 704〜742ms かかっており、await する
現行形（740〜787ms）と変わらない。

求解中の別接続も 456〜492ms（平常時 114〜195ms）で、終了時刻は求解の終わりと
一致する（+707 対 +722、+704 対 +707、+742 対 +744）。

## わかったこと

1. **`waitUntil` に同期の仕事を預けても、呼出元は解放されない。** これまで
   ローカルの対照実験でしか示せていなかった機構が、cloud で再現した。
   ローカルの `sync` 対照（子の `ctx.waitUntil` に同期 1,500ms → 親は 1,500ms
   待つ）と同じ形である。
2. **await しない位置を 1 ホップ手前へ動かしても効かない。** 途中に await する
   ホップが 1 つでも残っていれば、そこで止まる。
3. 店舗 DO の占有は、await する形と変わらない。

## 言っていないこと

- **店舗 DO 自身が await をやめた場合は、cloud では試していない。**
  それには `src/shell/store-timer-do.ts` の変更が要る。ローカルでは handler が
  0ms になる一方、求解中の別通信は残りの求解時間だけ待たされた（同期 1,500ms の
  子で 1,381ms、await する場合の 1,382ms とほぼ同値）。この局所結果を cloud が
  直接裏づけたわけではないが、上の 1 で機構は cloud でも確認された。
- solver の invocation は 3 件とも `outcome: canceled`。callback は届いている。
  await する形でも同じで、未調査。

## 5. 失敗した最初の試行（記録）

最初の走行（`...noawait-20260912.json`）は注文 99〜122ms・別接続 79〜197ms と
速かったが、**求解が 1 件も走っていなかった**。05:04 にチェックイン済み
manifest を `enabled: false` へ戻したあと、その状態で shim を配備したためで、
shim は 3 回とも 503 / wall 0ms を返していた。速さは無活動の速さであり、
成功に数えない。窓の値を復元して配備し直したのが上の本番である。
