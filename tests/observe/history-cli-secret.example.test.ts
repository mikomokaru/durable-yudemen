// CLI が秘密値を出力へ載せないことの検査（operation-history-log 要件 6.6）。
//
// token は引数にも manifest にも出さず、Authorization ヘッダーだけに渡す。ここは実行時の挙動ではなく
// **ソースの形**で見る——出力の経路は数が少なく、増えたときに気づけるほうが確実である。

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = readFileSync(resolve(repoRoot, "tools/observe/history-cli.ts"), "utf8");
/** help の散文は出力されるが秘密値ではない。検査は help より後ろの実装だけを見る。 */
const implementation = cli.slice(cli.indexOf("const RATE_NAMES"));

/** 出力を書く行。ここに token が混ざっていないかを見る。 */
const writeLines = implementation
  .split("\n")
  .filter((line) => /process\.(stdout|stderr)\.write|console\.(log|warn|error)/.test(line));

describe("秘密値の扱い", () => {
  it("出力を書く経路がある（検査対象が消えていない）", () => {
    expect(writeLines.length).toBeGreaterThan(0);
  });

  it("出力に token を載せない", () => {
    for (const line of writeLines) {
      expect(line, line.trim()).not.toMatch(/\btoken\b/i);
    }
  });

  it("token は環境変数から読み、Authorization だけに渡す", () => {
    expect(cli).toMatch(/WRANGLER_R2_SQL_AUTH_TOKEN/);
    const usages = implementation.split("\n").filter((line) => /\btoken\b/.test(line));
    for (const line of usages) {
      const allowed =
        /process\.env/.test(line) ||
        /Authorization/.test(line) ||
        /token:\s*string/.test(line) ||
        /token\s*===\s*undefined/.test(line) ||
        /runQuery\(/.test(line) ||
        /const token/.test(line) ||
        /^\s*(\/\/|\/\*|\*)/.test(line) ||
        /^\s*token,?\s*$/.test(line);
      expect(allowed, line.trim()).toBe(true);
    }
  });

  it("manifest に token を含めない", () => {
    // manifest 関数の本体だけを見る。後ろに別の関数が増えても範囲が広がらないよう、
    // 最初の閉じ括弧行で切る。
    const from = cli.indexOf("function manifest(");
    const lines = cli.slice(from).split("\n");
    const end = lines.findIndex((line, index) => index > 0 && line === "}");
    const manifest = lines.slice(0, end + 1).join("\n");

    expect(manifest).toContain("completeness");
    expect(manifest).not.toMatch(/token/i);
  });
});
