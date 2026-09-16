# 採用しない WIP の保存

J-3 対応（2026-09-09）。`cpsat-plan.ts.txt` は、旧 `src/engine/cpsat-plan.ts` の内容をそのまま保存した資料。SHA-256 は `1c1d88dc7b20d581afef64570e50ab1c40a61b8439316ae0453e16353d456a68`。

`.ts.txt` は実行・型検査・bundle の入力ではない。相対 import も元の所在のまま残してあるため、ここから import したり単純に戻したりしない。

この WIP は tableId の一致で錨を導き、tableKey で一片を分けるため、CP-SAT integration の承認済み design・R2.6／R3.7 に合わない。`plan.ts`／`settle.ts` の呼出分岐と `SettleParams.planner` を除去して、正規 engine から切り離した。テストのファイル集合・純粋層許可リストは変更していない。

新しい要求経路は task 3.5、採用処理は task 6.1以降で design に沿って実装する。task 2.5 合格と F-1 の明示承認より前にこの旧経路を再接続しない。既存 WASM、実験モデル、固定 solver・観測の成果物は別物であり、今回変更していない。
