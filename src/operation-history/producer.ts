// 操作履歴の Producer。**確定した差分だけを、同期 console 出力として 1 回試みる。**
// 失敗は外へ出さない。待たない。再試行しない。
//
// console へ渡すのは**オブジェクト**である（2026-09-16 に文字列から変えた）。検査は Tail 側が
// Zod で行い、通ったものだけ Pipelines へ流す。ここで文字列に組み直さないのは、名乗りの判定を
// 部分一致（`line.includes('"operationKind"')`）から場の検査へ移すためである。
//
// **配備の順序: Tail を先に出す。** 古い Tail は文字列しか受け取れず、オブジェクトを黙って落とす。
// 現在の Tail は両方を受けるので、この向きの入れ替えは Tail を先に出してあれば行が落ちない。

import { operationRecordPayload } from "./codec";
import { recordsFromCommittedDiff } from "./derive";
import type { OperationObservation } from "./derive";

/** 確定差分を一件一件の同期 console 出力として best-effort に試行する。 */
export function tryWriteOperationLines(enabled: boolean, observation: OperationObservation): void {
  if (!enabled) return;

  try {
    const records = recordsFromCommittedDiff(observation);
    for (const record of records) {
      try {
        // 参照ではなく作り直した素のオブジェクトを渡す（理由は codec の該当箇所）。
        console.log(operationRecordPayload(record));
      } catch {
        // 一件の観測失敗を Timer 本体にも後続 record にも伝播させない。
      }
    }
  } catch {
    return;
  }
}
