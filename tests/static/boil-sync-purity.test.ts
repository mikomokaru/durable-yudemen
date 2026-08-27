// tests/static/boil-sync-purity.test.ts — 同期計算と射影の platform 純粋性 smoke test。
//
// Feature: synchronized-boil-adjustment, Smoke: sync and projection remain platform-pure
// Validates: Requirements 4.6, 8.2, 8.3
//
// TypeScript AST を検査する。コメントや文字列に禁則語が現れても実行コードとは扱わない。
// 公開関数や本文の形は固定せず、import 境界と実行作用を持つ構文だけを確認する。

import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const targetPaths = ["src/engine/sync.ts", "src/engine/project.ts"] as const;

function parse(relativePath: string): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    readFileSync(resolve(repoRoot, relativePath), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function walk(node: ts.Node, visit: (child: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function moduleSpecifiers(sourceFile: ts.SourceFile): readonly string[] {
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      specifiers.push(statement.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(statement)
      && statement.moduleSpecifier !== undefined
      && ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(statement)
      && ts.isExternalModuleReference(statement.moduleReference)
      && statement.moduleReference.expression !== undefined
      && ts.isStringLiteralLike(statement.moduleReference.expression)
    ) {
      specifiers.push(statement.moduleReference.expression.text);
    }
  }
  return specifiers;
}

function importedPath(importer: string, specifier: string): string {
  return relative(repoRoot, resolve(repoRoot, dirname(importer), specifier)).split(sep).join("/");
}

function propertySegments(expression: ts.Expression): readonly string[] {
  if (ts.isIdentifier(expression)) return [expression.text];
  if (ts.isPropertyAccessExpression(expression)) {
    return [...propertySegments(expression.expression), expression.name.text];
  }
  if (
    ts.isElementAccessExpression(expression)
    && expression.argumentExpression !== undefined
    && ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return [...propertySegments(expression.expression), expression.argumentExpression.text];
  }
  return [];
}

const forbiddenCalls = new Set([
  "broadcast",
  "deleteAlarm",
  "fetch",
  "queueMicrotask",
  "setAlarm",
  "setInterval",
  "setTimeout",
  "waitUntil",
]);
const storageMethods = new Set([
  "delete",
  "deleteAll",
  "get",
  "list",
  "put",
  "sql",
  "transaction",
  "transactionSync",
]);
const forbiddenCapabilities = new Set([
  "DurableObjectStorage",
  "Promise",
  "WebSocket",
  "WebSocketPair",
  "storage",
]);

function actionViolations(sourceFile: ts.SourceFile): readonly string[] {
  const violations = new Set<string>();
  walk(sourceFile, (node) => {
    if (ts.isAwaitExpression(node)) violations.add("await expression");

    if (
      ts.canHaveModifiers(node)
      && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    ) {
      violations.add("async declaration");
    }

    if (ts.isIdentifier(node) && forbiddenCapabilities.has(node.text)) {
      violations.add(`capability identifier ${node.text}`);
    }

    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) violations.add("dynamic import()");

      const called = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : undefined;
      if (called === "require") violations.add("require()");
      if (called !== undefined && forbiddenCalls.has(called)) violations.add(`effect call ${called}()`);

      if (ts.isPropertyAccessExpression(node.expression)) {
        const receiver = propertySegments(node.expression.expression);
        if (receiver.some((segment) => segment.toLowerCase() === "storage") && storageMethods.has(node.expression.name.text)) {
          violations.add(`storage call ${node.expression.name.text}()`);
        }
      }
    }
  });
  return [...violations].sort();
}

describe("Feature: synchronized-boil-adjustment, Smoke: sync and projection remain platform-pure", () => {
  it("import を engine/domain の純粋境界内に限定する", () => {
    for (const targetPath of targetPaths) {
      for (const specifier of moduleSpecifiers(parse(targetPath))) {
        expect(specifier, `${targetPath} が外部 module ${specifier} を import している`).toMatch(/^\./);
        const resolved = importedPath(targetPath, specifier);
        expect(
          resolved.startsWith("src/engine/") || resolved.startsWith("src/domain/"),
          `${targetPath} が純粋境界外 ${resolved} を import している`,
        ).toBe(true);
      }
    }
  });

  it("storage・常駐 timer・platform I/O・非同期継続を実行しない", () => {
    for (const targetPath of targetPaths) {
      expect(actionViolations(parse(targetPath)), `${targetPath} が実行作用を持っている`).toEqual([]);
    }
  });
});
