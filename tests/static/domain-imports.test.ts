// tests/static/domain-imports.test.ts — 要件 3.5: domain の import 境界。
//
// **Validates: Requirements 3.5**
//
// `src/domain` は両端が共有する契約の正本であり、何にも依存しない。この不変は二つの要件を支えている——
// Brand（`src/engine/types.ts`）が `StoreConfig` に現れ得ないこと（要件 3.3 と 3.4 の両立の根拠）と、
// domain がそのまま他基盤へ運べること（構造の主権）である。どちらも「観測したらそうだった」ではなく
// 依存方向で保証されるべきものなので、機械で固定する。
//
// 既存の `tests/static/boil-sync-purity.test.ts:146-160` は逆向きの検査である（対象ファイルが engine か
// domain だけを import することを見る）。domain の側から外へ出る辺を禁じてはいない。

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const domainDir = "src/domain";

function domainFiles(): readonly string[] {
  return readdirSync(resolve(repoRoot, domainDir))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `${domainDir}/${name}`)
    .sort();
}

/** ファイルが持つ全 module specifier（型のみの import も含む——依存方向の話であり実行時に限らない）。 */
function moduleSpecifiers(relativePath: string): readonly string[] {
  const file = ts.createSourceFile(
    relativePath,
    readFileSync(resolve(repoRoot, relativePath), "utf8"),
    ts.ScriptTarget.ESNext,
    true,
  );
  const specifiers: string[] = [];
  file.forEachChild((statement) => {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  });
  return specifiers;
}

describe("Feature: verified-wire-contract — domain は何にも依存しない（要件 3.5）", () => {
  it("走査対象の domain ファイルが実在する（基準が空でないことの確認）", () => {
    expect(domainFiles().length).toBeGreaterThan(0);
  });

  it("domain の import 先は domain 内の相対パスだけである", () => {
    for (const path of domainFiles()) {
      for (const specifier of moduleSpecifiers(path)) {
        // 外部パッケージ（`.` で始まらない）を禁じる。
        expect(specifier, `${path} が外部 module ${specifier} を import している`).toMatch(/^\./);
        // 同じディレクトリの外（`../` を含む）を禁じる——engine も client も shell も対象である。
        expect(specifier, `${path} が domain の外 ${specifier} を import している`).not.toMatch(
          /^\.\./,
        );
      }
    }
  });
});
