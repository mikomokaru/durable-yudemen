// tail event から「記録の候補になり得る console の出力」を取り出す（operation-history-log 要件 4.2）。
//
// **封筒の条件はここ一箇所にある。** どの dataset かは、取り出した後にそれぞれの名乗りと検査が決める。
// 封筒の条件を dataset ごとに書けば、片方だけ緩んだときに気づけない。
//
// 受け取る姿は 2 つある。**オブジェクト**（これから Producer が出す形）と**文字列**（従来の形）。
// 両方を受けるのは配備順のためである。payload の形を変えるときは Tail を先に出す——2026-09-16 に
// 逆順で踏み、約 20 分、遅延の行が全て弾かれた。Tail が両方を受けられれば、Producer をどちらの
// 向きへ動かしても行が落ちない。**文字列の側は当面残す。**

/** tail event のうち、この抽出が読む部分。TraceItem はこの形を満たす。 */
export interface ConsoleBearingEvent {
  readonly scriptName: string | null;
  readonly logs: readonly { readonly level: string; readonly message: readonly unknown[] }[];
}

/**
 * 取り出した 1 件と、その event 内での位置（先頭を 1 とする）。
 *
 * 番号は封筒を通った件の通し番号であって、Producer が出した console の呼び出し番号ではない。
 * 診断で「event 内の何件目か」を指すためだけに使う。
 */
export type ObservedConsoleEntry =
  | {
      readonly lineNumber: number;
      readonly kind: "object";
      readonly value: Record<string, unknown>;
    }
  | { readonly lineNumber: number; readonly kind: "string"; readonly line: string };

/** 取り出した 1 行（文字列の側だけを見る呼び出し向け）。 */
export interface ObservedConsoleLine {
  readonly lineNumber: number;
  readonly line: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 封筒を通った件を入力順に返す。
 *
 * 条件は 4 つ。許可した script の実行であること、`console.log` であること、引数がちょうど 1 つで
 * あること、そしてその引数がオブジェクトか**改行を含まない**文字列であること。
 * **これは「記録かどうか」を判定しない**——判定は名乗りを見る側の仕事である。
 */
export function consoleEntriesOf(
  event: ConsoleBearingEvent,
  acceptedScripts: ReadonlySet<string>,
): readonly ObservedConsoleEntry[] {
  if (!acceptedScripts.has(event.scriptName ?? "")) return [];

  const entries: ObservedConsoleEntry[] = [];
  let lineNumber = 0;
  for (const log of event.logs) {
    if (log.level !== "log" || log.message.length !== 1) continue;
    const [value] = log.message;
    if (isPlainObject(value)) {
      lineNumber += 1;
      entries.push({ lineNumber, kind: "object", value });
      continue;
    }
    if (typeof value !== "string" || value.includes("\n") || value.includes("\r")) continue;
    lineNumber += 1;
    entries.push({ lineNumber, kind: "string", line: value });
  }
  return entries;
}

/** 封筒を通った件のうち文字列の側だけ。従来の呼び出しがこの形を使う。 */
export function consoleLinesOf(
  event: ConsoleBearingEvent,
  acceptedScripts: ReadonlySet<string>,
): readonly ObservedConsoleLine[] {
  return consoleEntriesOf(event, acceptedScripts).flatMap((entry) =>
    entry.kind === "string" ? [{ lineNumber: entry.lineNumber, line: entry.line }] : [],
  );
}
