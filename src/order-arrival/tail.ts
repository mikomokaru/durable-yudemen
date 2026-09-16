// 注文到着の行を tail event から取り出す（order-arrival-log）。
//
// 封筒の条件は `src/data-platform/console-lines.ts` が持つ。ここが決めるのは**名乗りと検査**だけである。
// 名乗らない件は失敗として数えない——同じ Worker が出す他機能のログを「壊れた到着記録」として数えれば、
// 失敗件数がアプリのログ量そのものになる（2026-09-16 に本番で実証済み）。

import { consoleEntriesOf, type ConsoleBearingEvent } from "../data-platform/console-lines";
import { issueSummary, orderArrivalRecordSchema } from "../data-platform/record-schema";
import { ORDER_ARRIVAL_CLAIM, printCanonicalOrderArrivalLine } from "./codec";
import { ORDER_ARRIVAL_RECORD_TYPE, type OrderArrivalRecord } from "./record";

/** 検査に通らなかった理由。オブジェクト経路は Zod、文字列経路は解析の失敗である。 */
export type OrderArrivalLineFailure = "schema-invalid" | "invalid-json";

export interface OrderArrivalCandidate {
  readonly line: string;
  readonly record: OrderArrivalRecord;
}

export interface OrderArrivalObservedLines {
  readonly candidates: readonly OrderArrivalCandidate[];
  readonly failures: readonly {
    readonly lineNumber: number;
    readonly failure: OrderArrivalLineFailure;
    readonly issues?: readonly string[];
  }[];
}

/**
 * 名乗った件だけを検査する。
 *
 * 文字列でも受けるのは配備の入れ替えのためである。**payload の形を変えるときは Tail を先に出す**という
 * 規律に対して、Tail が両方を受けられれば Producer をどちらの向きへ動かしても行が落ちない。
 */
export function orderArrivalLinesFromTailEvents(
  events: readonly ConsoleBearingEvent[],
  acceptedScripts: ReadonlySet<string>,
): OrderArrivalObservedLines {
  const candidates: OrderArrivalCandidate[] = [];
  const failures: {
    lineNumber: number;
    failure: OrderArrivalLineFailure;
    issues?: readonly string[];
  }[] = [];

  for (const event of events) {
    for (const entry of consoleEntriesOf(event, acceptedScripts)) {
      let value: unknown;
      if (entry.kind === "object") {
        // 名乗らない件は観測の対象外。
        if (entry.value.recordType !== ORDER_ARRIVAL_RECORD_TYPE) continue;
        value = entry.value;
      } else {
        if (!entry.line.includes(ORDER_ARRIVAL_CLAIM)) continue;
        try {
          value = JSON.parse(entry.line);
        } catch {
          failures.push({ lineNumber: entry.lineNumber, failure: "invalid-json" });
          continue;
        }
      }

      const checked = orderArrivalRecordSchema.safeParse(value);
      if (!checked.success) {
        failures.push({
          lineNumber: entry.lineNumber,
          failure: "schema-invalid",
          issues: issueSummary(checked.error),
        });
        continue;
      }
      candidates.push({
        line: printCanonicalOrderArrivalLine(checked.data),
        record: checked.data,
      });
    }
  }

  return { candidates, failures };
}
