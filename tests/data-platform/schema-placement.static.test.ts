// 検証ライブラリの置き場の静的検査（2026-09-16）。
//
// Zod を入れたのは Tail 側の検査のためであり、**Producer 側へ漏れてはならない**。Producer は
// 店舗 DO（`StoreTimerDO`）と同じ bundle に載る。そこへ検証ライブラリが入ると、厨房操作の経路の
// bundle が観測の都合で太る。
//
// 「入っていないこと」は振る舞いテストでは押さえられない——動かして確かめられるのは「いま落ちない
// こと」であって、「将来ここへ import を書けないこと」ではない。ゆえに import graph を辿って構造で
// 固定する。`tests/pos-order-ingress.static.test.ts` の (e) が禁そのもの（許可 file の一覧）を守り、
// ここが**許可した file の到達範囲**を守る。

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 検証ライブラリを持ってよい唯一の file。 */
const SCHEMA_FILE = "src/data-platform/record-schema.ts";

/** Producer の入口。ここから辿れる範囲が店舗 DO の bundle に載る。 */
const PRODUCER_ROOTS = ["src/operation-history/producer.ts", "src/lift-delay/producer.ts"] as const;

/** Tail の入口。検査はここから辿れなければ意味を成さない。 */
const TAIL_ROOT = "src/data-platform/history-tail.ts";

function pathFromRoot(absolute: string): string {
  return relative(repoRoot, absolute).split(sep).join("/");
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(resolve(repoRoot, path), "utf8"),
    ts.ScriptTarget.ESNext,
    true,
  );
}

function moduleSpecifiers(file: ts.SourceFile): readonly string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function resolveRelative(importer: string, specifier: string): string {
  const base = resolve(repoRoot, dirname(importer), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")];
  const resolved = candidates.find(existsSync);
  if (resolved === undefined) throw new Error(`${importer}: ${specifier} を解決できない`);
  return pathFromRoot(resolved);
}

/** 入口から辿れる repo 内の file と、外部 package の specifier。 */
function importGraph(roots: readonly string[]): {
  readonly files: ReadonlySet<string>;
  readonly externals: ReadonlySet<string>;
} {
  const pending = [...roots];
  const files = new Set<string>();
  const externals = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || files.has(current)) continue;
    files.add(current);
    for (const specifier of moduleSpecifiers(parse(current))) {
      if (specifier.startsWith(".")) pending.push(resolveRelative(current, specifier));
      else externals.add(specifier);
    }
  }
  return { files, externals };
}

const SCHEMA_LIBRARIES =
  /^(?:zod|valibot|ajv|yup|joi|superstruct|io-ts|@sinclair\/typebox)(?:\/|$)/;

describe("検証ライブラリは Tail 側だけに載る", () => {
  it("Producer の import graph が検証 file へ到達しない", () => {
    const { files } = importGraph(PRODUCER_ROOTS);
    expect([...files], `${SCHEMA_FILE} が Producer から辿れる`).not.toContain(SCHEMA_FILE);
  });

  it("Producer の import graph が検証ライブラリを持たない", () => {
    const { externals } = importGraph(PRODUCER_ROOTS);
    for (const specifier of externals) {
      expect(
        SCHEMA_LIBRARIES.test(specifier),
        `Producer が ${specifier} を取り込んでいる（店舗 DO の bundle に載る）`,
      ).toBe(false);
    }
  });

  it("Tail の import graph は検証 file へ到達する", () => {
    // 「無いこと」だけを検査すると、検査ごと消えたときに気づけない。
    const { files } = importGraph([TAIL_ROOT]);
    expect([...files]).toContain(SCHEMA_FILE);
  });

  it("検証 file は Producer の codec を読むが、Producer は検証 file を読まない（向きが一方向）", () => {
    const specifiers = moduleSpecifiers(parse(SCHEMA_FILE));
    const internal = specifiers
      .filter((specifier) => specifier.startsWith("."))
      .map((specifier) => resolveRelative(SCHEMA_FILE, specifier));
    // 記録の型だけを読む。読む向きが逆なら Producer 側へ検証が漏れる。
    expect(internal).toEqual([
      "src/registry/slug.ts",
      "src/operation-history/record.ts",
      "src/lift-delay/record.ts",
      "src/order-arrival/record.ts",
    ]);
  });
});
