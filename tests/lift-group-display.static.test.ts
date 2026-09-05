// tests/lift-group-display.static.test.ts — 距離の正本が domain にあることのソース静的検査（タスク2.3）。
//
// _Validates: lift-group-display Requirement 6.7（Property 7・距離の一致）_
//
// Requirement 6.7 は「client が用いる slotDistance は engine の目的関数が用いるものと同一の関数である」と
// 言う。これは振る舞いテストでは捉えにくい——engine と client が別々に定義した距離でも、算術が偶然一致して
// いる間は同じ値を返す。同一性は「定義がただ一箇所にある」という構造の事実であり、ソースの形でしか固定
// できない。ゆえに次の 3 点を TypeScript AST で見る。
//
//   (a) src/domain/store.ts が slotDistance を export する（正本の実在）
//   (b) src/engine/objective.ts のトップレベルに slotDistance / position の宣言が無い（再定義の不在）
//   (c) src/engine/objective.ts と schedule.ts は slotDistance を ../domain/store から import し、
//       objective.ts は slotDistance / position を export しない（正本への入口が一つ——design Component 8）
//
// (c) の再 export の禁止は、残せば「距離の正本は domain」が objective 経由の第二の入口で濁るためである。
// 宣言と export は「形」を問わず集める。`function slotDistance` だけを見ると `const slotDistance = …` の
// 再定義が、`export { … } from` だけを見ると import した名を `export { slotDistance }` と並べ直す形や
// `export const slotDistanceAlias = …` の別名が、検査の外に残る——最も自然な逃げ道が緑のまま通る検査は
// 構造の事実を固定していない。ゆえに関数宣言・変数宣言・export 節（`export { a as b }` は両名）・
// `export *`・`export default` を一つのヘルパに合算し、名で照合する。
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

/** 移設した関数の名。objective.ts の宣言にも export にも現れてはならない。 */
const MOVED_FUNCTIONS = ["slotDistance", "position"] as const;

/**
 * `export * from "…"` / `export * as ns from "…"` を表す印。名を列挙できない export は、
 * 正本の名を含みうる以上「入口が一つ」を破るものとして扱う。
 */
const WILDCARD_EXPORT = "*";

function parse(relativePath: string): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    readFileSync(resolve(repoRoot, relativePath), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function hasExportModifier(node: ts.HasModifiers): boolean {
  return (ts.getModifiers(node) ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

/** 束縛名。`const a = …` の a に加え、`const { a, b: c } = …` / `const [d] = …` の葉も拾う。 */
function bindingNames(name: ts.BindingName): readonly string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? bindingNames(element.name) : [],
  );
}

/** 一つの文が宣言する名。関数宣言はその名、変数宣言は束縛名すべて、それ以外は無し。 */
function declaredNamesOf(statement: ts.Statement): readonly string[] {
  if (ts.isFunctionDeclaration(statement)) {
    return statement.name === undefined ? [] : [statement.name.text];
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) =>
      bindingNames(declaration.name),
    );
  }
  return [];
}

/** トップレベルの関数宣言と変数宣言の名（export の有無を問わない）。 */
function topLevelDeclaredNames(file: ts.SourceFile): readonly string[] {
  return file.statements.flatMap(declaredNamesOf);
}

/**
 * ファイルが外へ出す名。export 修飾子つきの関数・変数、`export { a as b }`（local の a と外向きの b の
 * 両方——どちらの名でも正本へ届く）、`export default a` の a、そして `export *` は WILDCARD_EXPORT。
 */
function exportedNames(file: ts.SourceFile): readonly string[] {
  return file.statements.flatMap((statement) => {
    if (ts.isFunctionDeclaration(statement) || ts.isVariableStatement(statement)) {
      return hasExportModifier(statement) ? declaredNamesOf(statement) : [];
    }
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause === undefined || ts.isNamespaceExport(clause)) return [WILDCARD_EXPORT];
      return clause.elements.flatMap((element) =>
        element.propertyName === undefined
          ? [element.name.text]
          : [element.propertyName.text, element.name.text],
      );
    }
    if (ts.isExportAssignment(statement)) {
      return ts.isIdentifier(statement.expression) ? [statement.expression.text] : [];
    }
    return [];
  });
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

describe("lift-group-display — 距離の正本は domain（Requirement 6.7）", () => {
  it("(a) src/domain/store.ts が slotDistance を export する", () => {
    // 正本が実在しなければ (b) の「無い」は空虚に成り立つ。先に在ることを確かめる。
    expect(exportedNames(parse(DOMAIN_STORE))).toContain("slotDistance");
  });

  it("(b) src/engine/objective.ts のトップレベルに slotDistance / position の宣言が無い", () => {
    const declared = topLevelDeclaredNames(parse("src/engine/objective.ts"));
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
    // 形は問わない——`export { slotDistance }` も `export const … = slotDistance` も `export *` も同じ入口。
    const exported = exportedNames(parse("src/engine/objective.ts"));
    expect(exported, "objective.ts の export * は正本の名を含みうる").not.toContain(
      WILDCARD_EXPORT,
    );
    for (const name of MOVED_FUNCTIONS) {
      expect(exported, `objective.ts が ${name} を export している`).not.toContain(name);
    }
  });
});
