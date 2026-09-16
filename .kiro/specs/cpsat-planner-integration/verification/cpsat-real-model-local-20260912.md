# 実モデルの CP-SAT 経路 — ローカルで初めて通した

証拠 `cpsat-real-model-local-20260912.json`、harness `check-cpsat-local.mjs`、
試験 `tests/cpsat-real-model.example.test.ts`。

## ここまで検証されていなかったこと

2.2〜2.5 の試験はすべて**固定問題**（同梱 fixture の protobuf）を解いていた。輸送の性質を
測るにはそれで足りたが、`src/cpsat/plan.ts` の実モデル生成——`formulate` → protobuf →
CP-SAT → 検証 → `CookSchedule`——は **2026-09-12 まで一度も走らせていなかった**。
`planCpsat` を呼ぶテストは 1 件も無かった。

## 結果

| 計画対象 | 状態 | 変数 | 配置 | 所要 |
|---|---|---|---|---|
| 1 件 | OPTIMAL | 98 | 1 | — |
| 2 件 | OPTIMAL | 214 | 2 | 46 ms |
| 3 件 | OPTIMAL | 349 | 3 | 46 ms |
| 6 件 | FEASIBLE | 868 | 6 | 228 ms |

WASM の線形メモリは全件 33,554,432 B（32 MiB）で、固定問題と同じである。

**配置の中身も噛み合っている。** 6 件の先頭は
`startAt 1700000180000 → serveAt 1700000240000` で差が **60 秒**——既定プリセット `Thin` の
`normal` の茹で時間ぴったりである。`slotIds: ["0"]` は `slotSpan: 1` と一致する。件数だけ
見ていると形の壊れた計画に気づけないので、試験でもこの差を固定した。

## 途中で踏んだこと

`params` を手で組んだら `slotOffsets` が抜けており、`position()` がモデル生成の手前で落ちた
（`TypeError: Cannot read properties of undefined`）。レイアウトは `unitOrigins` と
`slotOffsets` の 2 つで、11 値の一部である。**正本（`schedulingDefaults`）から組む形に
直した**——手で書き写すと同じ穴が開く。

麺種も手で「細麺」と書いて 0 件に落ちた。既定プリセットは `Thin`／`Medium`／`Thick` で、
表と食い違うと `cpsatTargets` が「茹で時間が引けない品目」として落とす。

## 言っていないこと

- **cloud の証拠ではない**（`cloudEvidence: false`）。ローカル workerd での成功である。
- **計画対象は最大 6 件**である。`cpsatTargets` が `slice(0, 6)` で絞っており、
  `PLAN_TARGET_LIMIT` = 64 とは別の、モデル側の上限である。64 件の局面は測っていない。
- **提案の良し悪しは測っていない。** 解が出て形が整っていることだけである。厨房での
  評価は task 7 に残る。
- **釜が走っている局面（`running` 非空）を測っていない。** 解放表の噛み合いはここでは
  検証されていない。
