// tests/lift-group-display.static.test.ts — 距離の正本が domain にあることのソース静的検査（タスク2.3）。
//
// _Validates: lift-group-display Requirement 6.7（Property 7・距離の一致）_
//
// Requirement 6.7 は「client が用いる slotDistance は engine の目的関数が用いるものと同一の関数である」と
// 言う。これは振る舞いテストでは捉えにくい——engine と client が別々に定義した距離でも、算術が偶然一致して
// いる間は同じ値を返す。同一性は「定義がただ一箇所にある」という構造の事実であり、ソースの形でしか固定
// できない。ゆえに次の 3 点を TypeScript AST で見る。
//
//   (a) src/domain/store.ts が slotDistance を export 宣言している（正本の実在）
//   (b) src/engine/objective.ts に `function slotDistance` / `function position` の宣言が無い（再定義の不在）
//   (c) src/engine/objective.ts と schedule.ts は slotDistance を ../domain/store から import し、
//       objective.ts は再 export しない（正本への入口が一つ——design Component 8）
//
// (c) の再 export の禁止は、残せば「距離の正本は domain」が objective 経由の第二の入口で濁るためである。
// git diff は使わない。ブランチやコミットの状態で結果が変わる検査は CI で意味を失うため、既存
// tests/*.static.test.ts の規約に倣い「いま存在するソースが制約を満たすか」だけを見る。
// コメント中の `function slotDistance` は AST では宣言にならないため、コメント除去の前処理は要らない。

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 距離の正本。engine と client の両方がここから import する。 */
const DOMAIN_STORE = "src/domain/store.ts";

/** 距離を要る engine のファイルと、そこから見た正本の module specifier。 */
const ENGINE_IMPORTERS = ["src/engine/objective.ts", "src/engine/schedule.ts"] as const;
const DOMAIN_STORE_SPECIFIER = "../domain/store";

/** 移設した関数の名。objective.ts に宣言として現れてはならない。 */
const MOVED_FUNCTIONS = ["slotDistance", "position"] as const;

function parse(relativePath: string): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    readFileSync(resolve(repoRoot, relativePath), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

/** トップレベルの関数宣言の名（export の有無を問わない）。 */
function declaredFunctionNames(file: ts.SourceFile): readonly string[] {
  return file.statements
    .filter(ts.isFunctionDeclaration)
    .map((declaration) => declaration.name?.text)
    .filter((name): name is string => name !== undefined);
}

/** export 修飾子つきのトップレベル関数宣言の名。 */
function exportedFunctionNames(file: ts.SourceFile): readonly string[] {
  return file.statements
    .filter(ts.isFunctionDeclaration)
    .filter((declaration) =>
      (ts.getModifiers(declaration) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ),
    )
    .map((declaration) => declaration.name?.text)
    .filter((name): name is string => name !== undefined);
}

/** 指定 module から import している名（`import { a, type B }` の a と B）。 */
function importedNamesFrom(file: ts.SourceFile, specifier: string): readonly string[] {
  const names: string[] = [];
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== specifier) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) names.push(element.name.text);
  }
  return names;
}

/** `export { … } from "…"` / `export * from "…"` の module specifier。 */
function reExportSpecifiers(file: ts.SourceFile): readonly string[] {
  return file.statements
    .filter(ts.isExportDeclaration)
    .map((declaration) => declaration.moduleSpecifier)
    .filter((specifier): specifier is ts.StringLiteral => specifier !== undefined)
    .map((specifier) => specifier.text);
}

describe("lift-group-display — 距離の正本は domain（Requirement 6.7）", () => {
  it("(a) src/domain/store.ts が slotDistance を export する", () => {
    // 正本が実在しなければ (b) の「無い」は空虚に成り立つ。先に在ることを確かめる。
    expect(exportedFunctionNames(parse(DOMAIN_STORE))).toContain("slotDistance");
  });

  it("(b) src/engine/objective.ts に function slotDistance / position の宣言が無い", () => {
    const declared = declaredFunctionNames(parse("src/engine/objective.ts"));
    for (const name of MOVED_FUNCTIONS) {
      expect(
        declared,
        `objective.ts が ${name} を再定義している。尺度の正本は domain/store.ts ただ一つ`,
      ).not.toContain(name);
    }
  });

  it("(c) engine は slotDistance を ../domain/store から import し、objective.ts は再 export しない", () => {
    for (const path of ENGINE_IMPORTERS) {
      expect(
        importedNamesFrom(parse(path), DOMAIN_STORE_SPECIFIER),
        `${path} が slotDistance を ${DOMAIN_STORE_SPECIFIER} から import していない`,
      ).toContain("slotDistance");
    }
    // 再 export が残れば、client が engine/objective から距離を引く第二の入口が生まれる。
    expect(reExportSpecifiers(parse("src/engine/objective.ts"))).toEqual([]);
    expect(exportedFunctionNames(parse("src/engine/objective.ts"))).not.toContain("slotDistance");
  });
});
