# DO を呼出元にした cloud 試験 — 判定

実施 2026-09-12。証拠 `cloud-do-occupancy-20260912.json`、
ドライバ `run-cloud-do-occupancy.mjs`。

## 配備（この試験のための 3 件）

窓が 2026-09-10T14:40:52Z に閉じており、3 Worker とも自分に埋め込んだ manifest
で判定するため、全件の再配備が要った（「shim 1 件だけ」は成り立たなかった）。

| Worker | 復帰先（試験前） | 試験版 |
|---|---|---|
| `yude-men-timer` | `f1d82402-6a94-405a-8fe5-a261a3678a89` | `ea3665b7-c09d-457d-b6d6-2b6be02c1c95` |
| `yude-men-cpsat-planner-dev` | `99aa3f53-8b28-4d4a-a03c-7b87c325948a` | `f3cf6457-8dcb-43ad-9632-d6d2d73300ab` |
| `yude-men-cpsat-transport-shim-dev` | `e77b17a7-4a8b-42e2-803a-187041345dd6` | `937ff014-46f0-4de6-968b-525b3dac88d2` |

窓 2026-09-12T04:57:31Z–05:42:31Z。配備後に app の binding・var・secret を
GET で照合し、`ACCESS_REQUIRED=1`・実 `TEAM_DOMAIN`・実 `POLICY_AUD`（64 文字）・
`ADMIN_TOKEN`・`ORDER_INGRESS_TOKEN` の維持を確認した。

### 配備で判明した落とし穴（記録）

1. **配備設定は root の `wrangler.jsonc` ではなく、vite が生成する
   `dist/yude_men_timer/wrangler.json`** である（`.wrangler/deploy/config.json`
   が指す）。root を編集しても再ビルドしなければ配備には効かない。
2. **`--keep-vars` は設定に載っている var を保護しない。** 「消さない」だけで、
   設定値は書き込まれる。プレースホルダを設定に残したままでは Access が落ちる。
3. `wrangler versions view --json` は切り詰めのない実値を返す。表形式は切り詰める。

## 手順

対象は shim 系列の合成店舗（`cpsat-transport-20260909-04`）。ここへ注文を入れる
と、**店舗 DO 自身の Persist Effect** が `SOLVER` を呼び、shim が固定の難問へ
差し替えて solver へ渡す。`store-timer-do.ts:1213` は「計算完了は待たない」と
述べており、その前提を実環境で確かめる。

平常時の基準には**計画要求を生まない操作**が要る。温まった DO への WS 接続
（購読専用 `/ops/watch`）を使った。冷えた DO では constructor の Reconcile が
要求を生み得るため、先に温めてから基準を取った。

各ラウンド：基準の接続を 2 回 → 注文を await せずに投入 → 250ms 後に同じ DO へ
別接続 → 注文の完了を待つ。8 秒あけて 3 ラウンド。

## 結果

| ラウンド | 平常時の接続 | 求解中の接続 | 注文全体 | solver CPU | 重なり |
|---|---|---|---|---|---|
| 0 | 122, 133ms | 1,189ms | 1,443ms | 1,132ms | **未確認**（求解開始が +709ms で、接続は +252ms） |
| 1 | 192, 141ms | **533ms** | 787ms | 654ms | **確認**（求解 +127〜790ms、接続 +252〜785ms） |
| 2 | 120, 189ms | **491ms** | 740ms | 633ms | **確認**（求解 +102〜745ms、接続 +252〜743ms） |

求解は 3 件とも実行されている（`solve-started` →
`solve-finished: UNKNOWN` → `callback-returned: delivered`）。

重なりが確認できたラウンド 1・2 で、**別接続は求解の終了時刻とほぼ同時に完了
した**（745 対 743、790 対 785）。所要は平常時の 120〜192ms に対し 491〜533ms
で、差は求解の残り時間にほぼ等しい。ラウンド 0 は接続が求解開始前だったので
重なり未確認として判定から除く。

## 判定

**求解終了まで別通信も待つ。現方式は design 第 9 節の応答性条件を満たさない。**

> 求解より前に受理が観測できることと、求解中の Timer 操作・通知が処理できる
> ことを cloud 上で検証する。

店舗 DO が要求元になる実際の配置で、その店舗の別通信は求解が終わるまで進まない。
`store-timer-do.ts:1213` の「計算完了は待たない」は、実環境では成立していない。
`RequestPlan` が待つのは 202 の受理のはずだが、子の応答後の仕事が同期であるため
受理時点では戻らない（機構は `accept-boundary-20260910.md`）。

したがって**実行契機の設計へ戻る**。CP-SAT や WASM を捨てる話ではなく、
求解を呼出元のスレッドから外す契機が要るという話である。

## 付随して観測したこと

- solver の invocation が 3 件とも `outcome: canceled` で終わっている。直接
  probe 系列では `ok` だった。callback は 3 件とも `delivered` の行があるので
  仕事自体は完了しているが、呼出元が解けた後に invocation が打ち切られている。
  未調査。
- 非公開の app 版が 2 件、プレースホルダの Access 値を持ったまま残っている
  （`b20cd5b1-6f1c-4878-a8d5-119780bdedfd`、`8a8efeaa-1dac-456e-ba7f-f94b10a52a13`）。
  **トラフィックは向いていないが、これを昇格させると Access が無効になる。**
  `--keep-vars` の効果を確かめる過程で私が作ったもので、消さずに記録する。

## この試験で言っていないこと

- 2.5 全体の合格・不合格ではない。判定したのは応答性条件だけである。
- 平常時 120〜192ms は remote binding proxy 越しの値で、実利用者の遅延ではない。
- ラウンド 0 は成功にも失敗にも数えていない。
