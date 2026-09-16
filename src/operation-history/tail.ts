// 操作記録を tail event から取り出す（operation-history-log 要件 4.2）。
//
// 封筒の条件は `src/data-platform/console-lines.ts` が持つ。ここが決めるのは**名乗りと検査**だけである。

import { consoleEntriesOf, type ConsoleBearingEvent } from "../data-platform/console-lines";
import { issueSummary, operationRecordSchema } from "../data-platform/record-schema";
// **`record-schema.ts` を Producer 側から import しない。** この file は Tail の実行だけが通る。
// Producer（店舗 DO の bundle）は `codec.ts` へ直接向かう。
import { parseOperationLines, printCanonicalOperationLine } from "./codec";
import type { OperationLineFailure } from "./codec";
import type { OperationRecord } from "./record";

// 想定 Producer script 名。tail event の scriptName はデプロイ済み Worker の実名であり、
// root wrangler.jsonc の "name" ただ一つ（= "yude-men-timer"）が現存する Producer である。
// 環境別 script（-dev / -stage / -prod）は未導入で、実在しない名前を挙げると本番の tail が
// 全て filter で落ちる。環境を実際に分けた日に、その環境の実 script 名をここへ足す。
export const PRODUCER_SCRIPTS: ReadonlySet<string> = new Set(["yude-men-timer"]);

/**
 * 操作記録を名乗る印。**これを持たない件は、壊れた記録ではなく別のアプリログである。**
 *
 * Producer と同じ Worker が構造化ログを出す（cpsat 計画ログ等）。「1 引数の改行なし文字列」だけを
 * 条件にすると、それらが全て失敗として数えられる。2026-09-16 に本番の tail で毎分約 200 件の警告と
 * して現れた。数が問題なのではなく、**本物の失敗と区別できなくなる**のが問題だった。
 *
 * `operationKind` を印に選ぶのは、要件 3.1 が全ての Operation_Record に必須と定める属性であり、
 * かつ観測以外の用途で使っていないからである。
 *
 * オブジェクトで届いた件は**場の有無と型で**名乗りを見る。文字列で届いた件は部分一致で見るしかない
 * ——名乗りを確かめるために全ての行を解析すれば、名乗らない行の解析結果を捨てるだけになる。
 */
const OPERATION_CLAIM = '"operationKind"';

function claimsOperation(value: Record<string, unknown>): boolean {
  return typeof value.operationKind === "string";
}

/** 検査を通った 1 件。canonical 一行と、その元になった記録を両方持つ。 */
export interface OperationCandidate {
  readonly line: string;
  readonly record: OperationRecord;
}

export interface OperationObservedLines {
  readonly candidates: readonly OperationCandidate[];
  readonly failures: readonly {
    readonly lineNumber: number;
    readonly failure: OperationLineFailure;
    /** 検査が落ちた場（オブジェクト経路のみ）。 */
    readonly issues?: readonly string[];
  }[];
}

/**
 * 名乗った件だけを検査し、通ったものを canonical 一行として返す。
 *
 * **オブジェクト経路には byte 比較が無い。** 文字列時代は受け取った行を記録へ戻し、canonical を
 * 出し直して byte 比較していた。これは途中で切れた行を弾くための検査だったが、2026-09-16 の実測で
 * **値は途中で切れない**ことが分かった（切り詰めは行を丸ごと落とし、event の `truncated` が立つ）。
 * 実際には起きない壊れ方への備えだったので、オブジェクト経路では持たない。
 *
 * **文字列経路では byte 比較を残す。** そちらは Producer が組んだ byte 列がそのまま届く形なので、
 * 検査の費用がほぼ無く、canonical でない行を候補にしない性質をただで保てる。
 */
export function operationLinesFromTailEvents(
  events: readonly ConsoleBearingEvent[],
  // 受け入れる script。既定は現存 Producer だけ。合成プローブのように別 script から同じ形の行を
  // 観測する経路が、ここへ集合を渡して filter を共有する（重複実装を作らない）。
  acceptedScripts: ReadonlySet<string> = PRODUCER_SCRIPTS,
): OperationObservedLines {
  const candidates: OperationCandidate[] = [];
  const failures: {
    lineNumber: number;
    failure: OperationLineFailure;
    issues?: readonly string[];
  }[] = [];

  for (const event of events) {
    for (const entry of consoleEntriesOf(event, acceptedScripts)) {
      if (entry.kind === "object") {
        // 名乗らない件は観測の対象外。失敗としても数えない。
        if (!claimsOperation(entry.value)) continue;
        const checked = operationRecordSchema.safeParse(entry.value);
        if (!checked.success) {
          failures.push({
            lineNumber: entry.lineNumber,
            failure: "schema-invalid",
            issues: issueSummary(checked.error),
          });
          continue;
        }
        candidates.push({
          line: printCanonicalOperationLine(checked.data),
          record: checked.data,
        });
        continue;
      }

      const line = entry.line;
      if (!line.includes(OPERATION_CLAIM)) continue;
      const [parsed] = parseOperationLines(line);
      if (parsed?.ok === false) {
        failures.push({ lineNumber: entry.lineNumber, failure: parsed.failure });
        continue;
      }
      if (parsed?.ok !== true || printCanonicalOperationLine(parsed.record) !== line) continue;
      candidates.push({ line, record: parsed.record });
    }
  }
  return { candidates, failures };
}
