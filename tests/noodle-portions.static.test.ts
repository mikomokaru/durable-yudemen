// tests/noodle-portions.static.test.ts — 釜数（slotSpan）を保持しないことの静的検査（noodle-portions 性質 6）。
//
// _Validates: noodle-portions Requirements 2.6, 9.6_
//
// 釜数は玉数（portions）から `slotSpanOf` で導く導出値であり、設定・状態・ワイヤ・翻訳のどの型にも
// フィールドとして持たない。ここで固定するのは 3 点。
//   (a) `src/domain` と `src/ingress` の型宣言に `slotSpan:` のフィールドが無い（`OrderItem` / `WireOrderItem` /
//       `NoodleSize` / `NoodleSpec`）。
//   (b) `src` で PORTIONS_PER_SLOT を割る式は `slotSpanOf` の定義ただ一つ（導出を各所で再実装しない）。
//   (c) Provisioning_API の検証（`src/registry/validate.ts`）の許可フィールドに `slotSpan` が無い（以前の名を
//       読み替える入口を作らない）。
// 実 fs でソースを読むため static プロジェクトで動かす。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function read(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

/** ディレクトリ配下の .ts / .tsx を再帰的に列挙する（生成物と d.ts は除く）。 */
function sourceFiles(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(resolve(repoRoot, dir))) {
    const path = join(dir, entry);
    if (statSync(resolve(repoRoot, path)).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) {
      found.push(path);
    }
  }
  return found;
}

/** コメント（行コメントとブロックコメント）を除いたコード本文。 */
function withoutComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("noodle-portions — 釜数は保持せず導く（性質 6）", () => {
  it("(a) domain / ingress の型宣言に slotSpan のフィールドが無い", () => {
    for (const file of [...sourceFiles("src/domain"), ...sourceFiles("src/ingress")]) {
      const code = withoutComments(read(file));
      expect(/\breadonly\s+slotSpan\??\s*:/.test(code), `${file} が slotSpan を型に持つ`).toBe(
        false,
      );
    }
  });

  it("(b) PORTIONS_PER_SLOT を割る式は slotSpanOf の定義だけ", () => {
    const dividers: string[] = [];
    for (const file of sourceFiles("src")) {
      const code = withoutComments(read(file));
      if (/\/\s*\(?\s*PORTIONS_PER_SLOT/.test(code)) dividers.push(relative(repoRoot, file));
    }
    expect(dividers).toEqual(["src/domain/store.ts"]);
    // その 1 箇所は slotSpanOf の本体である。
    const store = withoutComments(read("src/domain/store.ts"));
    const body = /export function slotSpanOf\(portions: number\): number \{[\s\S]*?\n\}/.exec(
      store,
    );
    expect(body).not.toBeNull();
    expect(store.split("PORTIONS_PER_SLOT * 2").length - 1).toBe(1);
  });

  it("(c) Provisioning_API の許可フィールドに slotSpan が無く、portions が在る", () => {
    const validate = withoutComments(read("src/registry/validate.ts"));
    expect(validate).toContain('["code", "portions"]');
    expect(/slotSpan/.test(validate)).toBe(false);
  });

  it("ワイヤの復号（toOrderItemFromWire）は slotSpan を読まない", () => {
    const wire = withoutComments(read("src/domain/wire.ts"));
    const decoder = /function toOrderItemFromWire\([\s\S]*?\n\}/.exec(wire);
    expect(decoder).not.toBeNull();
    expect(/slotSpan/.test(decoder![0])).toBe(false);
  });
});
