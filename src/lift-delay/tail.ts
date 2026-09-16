// 遅延ログの行を tail event から取り出す（lift-delay-log 要件 5.1・5.3）。
//
// 封筒の条件は `src/data-platform/console-lines.ts` が持つ。ここが決めるのは**名乗りと解析**だけである。
// 名乗らない行は失敗として数えない——同じ Worker が出す操作履歴や他機能のログを「壊れた遅延記録」と
// して数えれば、失敗件数がアプリのログ量そのものになる（操作履歴側で 2026-09-16 に実証済み）。

import { consoleEntriesOf, type ConsoleBearingEvent } from "../data-platform/console-lines";
import {
  issueSummary,
  liftDelayRecordSchema,
  liftDelayStartRecordSchema,
} from "../data-platform/record-schema";
import {
  parseLiftDelayLine,
  parseLiftDelayStartLine,
  printCanonicalLiftDelayLine,
  printCanonicalLiftDelayStartLine,
  type LiftDelayLineFailure,
} from "./codec";
import {
  LIFT_DELAY_RECORD_TYPE,
  LIFT_DELAY_START_RECORD_TYPE,
  type LiftDelayRecord,
  type LiftDelayStartRecord,
} from "./record";

/**
 * 遅延ログを名乗る印。終端と開始で別の語を持つ。
 *
 * オブジェクトで届いた件は `recordType` の値そのものを見る。文字列で届いた件は部分一致で見る。
 */
const TERMINAL_CLAIM = `"recordType":"${LIFT_DELAY_RECORD_TYPE}"`;
const START_CLAIM = `"recordType":"${LIFT_DELAY_START_RECORD_TYPE}"`;

export type LiftDelayCandidate =
  | { readonly kind: "terminal"; readonly line: string; readonly record: LiftDelayRecord }
  | { readonly kind: "start"; readonly line: string; readonly record: LiftDelayStartRecord };

export interface LiftDelayObservedLines {
  readonly candidates: readonly LiftDelayCandidate[];
  readonly failures: readonly {
    readonly lineNumber: number;
    readonly failure: LiftDelayLineFailure;
    /** 検査が落ちた場（オブジェクト経路のみ）。 */
    readonly issues?: readonly string[];
  }[];
}

/**
 * 名乗った件だけを検査する。
 *
 * **オブジェクト経路には byte 比較が無い。** 文字列時代は canonical を出し直して byte 比較していたが、
 * それは途中で切れた行を弾く検査であり、2026-09-16 の実測で**値は途中で切れない**ことが分かった。
 * 切り詰めは行を丸ごと落とす形で起き、event の `truncated` に出る。文字列経路では費用が無いので残す。
 */
export function liftDelayLinesFromTailEvents(
  events: readonly ConsoleBearingEvent[],
  acceptedScripts: ReadonlySet<string>,
): LiftDelayObservedLines {
  const candidates: LiftDelayCandidate[] = [];
  const failures: {
    lineNumber: number;
    failure: LiftDelayLineFailure;
    issues?: readonly string[];
  }[] = [];

  for (const event of events) {
    for (const entry of consoleEntriesOf(event, acceptedScripts)) {
      if (entry.kind === "object") {
        const recordType = entry.value.recordType;
        if (recordType === LIFT_DELAY_START_RECORD_TYPE) {
          const checked = liftDelayStartRecordSchema.safeParse(entry.value);
          if (!checked.success) {
            failures.push({
              lineNumber: entry.lineNumber,
              failure: "schema-invalid",
              issues: issueSummary(checked.error),
            });
            continue;
          }
          candidates.push({
            kind: "start",
            line: printCanonicalLiftDelayStartLine(checked.data),
            record: checked.data,
          });
          continue;
        }
        // 名乗らない件は観測の対象外。失敗としても数えない。
        if (recordType !== LIFT_DELAY_RECORD_TYPE) continue;
        const checked = liftDelayRecordSchema.safeParse(entry.value);
        if (!checked.success) {
          failures.push({
            lineNumber: entry.lineNumber,
            failure: "schema-invalid",
            issues: issueSummary(checked.error),
          });
          continue;
        }
        candidates.push({
          kind: "terminal",
          line: printCanonicalLiftDelayLine(checked.data),
          record: checked.data,
        });
        continue;
      }

      const line = entry.line;
      const lineNumber = entry.lineNumber;
      // 開始の名乗りを先に見る。終端の名乗りは開始の名乗りの部分文字列ではないが、
      // 判定の順序を固定しておく方が読みやすい。
      if (line.includes(START_CLAIM)) {
        const parsed = parseLiftDelayStartLine(line);
        if (!parsed.ok) {
          failures.push({ lineNumber, failure: parsed.failure });
          continue;
        }
        if (printCanonicalLiftDelayStartLine(parsed.record) !== line) continue;
        candidates.push({ kind: "start", line, record: parsed.record });
        continue;
      }
      if (!line.includes(TERMINAL_CLAIM)) continue;

      const parsed = parseLiftDelayLine(line);
      if (!parsed.ok) {
        failures.push({ lineNumber, failure: parsed.failure });
        continue;
      }
      if (printCanonicalLiftDelayLine(parsed.record) !== line) continue;
      candidates.push({ kind: "terminal", line, record: parsed.record });
    }
  }

  return { candidates, failures };
}
