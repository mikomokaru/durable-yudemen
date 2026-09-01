import { parseOperationLines, printCanonicalOperationLine } from "./codec";
import type { OperationLineFailure } from "./codec";

// 想定 Producer script 名。tail event の scriptName はデプロイ済み Worker の実名であり、
// root wrangler.jsonc の "name" ただ一つ（= "yude-men-timer"）が現存する Producer である。
// 環境別 script（-dev / -stage / -prod）は未導入で、実在しない名前を挙げると本番の tail が
// 全て filter で落ちる。環境を実際に分けた日に、その環境の実 script 名をここへ足す。
const PRODUCER_SCRIPTS: ReadonlySet<string> = new Set(["yude-men-timer"]);

/** 想定 Producer の canonical Operation Record と codec 失敗を観測側で分離する。 */
export function operationLinesFromTailEvents(
  events: readonly {
    readonly scriptName: string | null;
    readonly logs: readonly {
      readonly level: string;
      readonly message: readonly unknown[];
    }[];
  }[],
): {
  readonly candidates: readonly string[];
  readonly failures: readonly {
    readonly lineNumber: number;
    readonly failure: OperationLineFailure;
  }[];
} {
  const candidates: string[] = [];
  const failures: { lineNumber: number; failure: OperationLineFailure }[] = [];
  let lineNumber = 0;

  for (const event of events) {
    if (!PRODUCER_SCRIPTS.has(event.scriptName ?? "")) continue;
    for (const log of event.logs) {
      if (log.level !== "log" || log.message.length !== 1) continue;
      const [line] = log.message;
      if (typeof line !== "string" || line.includes("\n") || line.includes("\r")) continue;

      lineNumber += 1;
      const [parsed] = parseOperationLines(line);
      if (parsed?.ok === false) {
        failures.push({ lineNumber, failure: parsed.failure });
        continue;
      }
      if (parsed?.ok !== true || printCanonicalOperationLine(parsed.record) !== line) continue;
      candidates.push(line);
    }
  }
  return { candidates, failures };
}
