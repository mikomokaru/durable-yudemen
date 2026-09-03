// tests/static/wire-no-cast.test.ts — Property 1: cast 不在（verified-wire-contract）
//
// **Validates: Requirements 2.1, 4.5**
//
// ワイヤ境界の関門が型について嘘をつかないことを、構文の不在で固定する。`as` は「検証していないものを
// 検証済みと言う」構文であり、境界に置けば型が状態について嘘をつく。この spec の出発点は
// `connectivity.ts` の `return parsed as ServerMessage`（2 項目だけ検証して全体を主張していた）だった。
//
// 走査は wire.ts 1 本に限る。既存の `WIRE_MESSAGE_TYPES` の検査が `messages.ts` だけを見ていたために
// 撤去済み種別の case が受け口に残り続けた——検査の価値は走査範囲で上限が決まる。ここでは範囲を
// 「嘘を作れる場所」に合わせる。
//
// 正規表現ではなく AST で見る。`\bas\s+` はコメントや文字列中の英語（"… as a …"）に当たり、`!` の検出は
// `!==` や `!x` と衝突する。先例は boil-sync-purity.test.ts（ts.SourceFile で走査する）。

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const targetPath = "src/domain/wire.ts";

function parse(relativePath: string): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    readFileSync(resolve(repoRoot, relativePath), "utf8"),
    ts.ScriptTarget.ESNext,
    true,
  );
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/**
 * 型の嘘を作れる構文を数える。
 *
 * `as const` は除く——型を弱めず、リテラルの型を保つ方向にしか働かない。`satisfies` も対象外で、
 * 宣言型への適合を要求するだけで型を差し替えない。
 */
function typeLies(file: ts.SourceFile): readonly string[] {
  const found: string[] = [];
  walk(file, (node) => {
    if (ts.isAsExpression(node)) {
      const isAsConst =
        ts.isTypeReferenceNode(node.type) &&
        ts.isIdentifier(node.type.typeName) &&
        node.type.typeName.text === "const";
      if (!isAsConst) found.push(`as ${node.type.getText(file)}`);
    }
    if (ts.isNonNullExpression(node)) found.push(`non-null assertion: ${node.getText(file)}`);
    if (ts.isTypeAssertionExpression(node)) found.push(`<T> assertion: ${node.getText(file)}`);
  });
  return found;
}

describe("Feature: verified-wire-contract, Property 1: cast 不在", () => {
  it("wire.ts に型アサーション・non-null assertion・<T> 形式のアサーションが無い", () => {
    expect(typeLies(parse(targetPath))).toEqual([]);
  });

  it("検査が実際に検出できる（偽陰性でないことの確認）", () => {
    const probe = ts.createSourceFile(
      "probe.ts",
      [
        "const a = x as string;",
        "const b = y!;",
        "const c = <string>z;",
        'const d = ["k"] as const;',
        "const e = w satisfies string;",
      ].join("\n"),
      ts.ScriptTarget.ESNext,
      true,
    );
    // as const と satisfies は数えない。残る 3 種だけを拾う。
    expect(typeLies(probe)).toHaveLength(3);
  });
});
