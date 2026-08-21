// 静的検査が共有する JSONC → JSON の落とし込み。設定の「有効な本文」（コメントを除いた部分）を
// 見る検査が二つ以上あるため、写しを作らずここ一箇所に置く。
//
// 利用者:
//   - tests/operation-history/config-graph.static.test.ts（タスク 11.4・設定 graph）
//   - tests/operation-history/no-backfill.static.test.ts（タスク 12.2・縮退経路の不在）

/**
 * JSONC を JSON へ落とす。文字列内を跨がないよう一度の走査で行コメント・ブロックコメント・
 * 末尾コンマだけを落とす（正規表現では文字列中の `//` や `,}` を誤って消し得る）。
 */
export function jsoncToJson(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];
    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 1;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLine = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlock = true;
      index += 1;
      continue;
    }
    if (char === ",") {
      const rest = text.slice(index + 1);
      const following = rest.replace(/^[\s]*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*/, "").charAt(0);
      if (following === "}" || following === "]") continue;
    }
    out += char;
  }
  return out;
}
