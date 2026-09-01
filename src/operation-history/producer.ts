import { printCanonicalOperationLine } from "./codec";
import { recordsFromCommittedDiff } from "./derive";
import type { OperationObservation } from "./derive";

/** 確定差分を一件一行の同期 console 出力として best-effort に試行する。 */
export function tryWriteOperationLines(enabled: boolean, observation: OperationObservation): void {
  if (!enabled) return;

  try {
    const records = recordsFromCommittedDiff(observation);
    for (const record of records) {
      try {
        const canonicalLine = printCanonicalOperationLine(record);
        console.log(canonicalLine);
      } catch {
        // 一件の観測失敗を Timer 本体にも後続 record にも伝播させない。
      }
    }
  } catch {
    return;
  }
}
