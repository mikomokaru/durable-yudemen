// tests/pos-order-ingress.static.test.ts — Pass_Through の適用層の静的検査（タスク24）。
//
// _Validates: Requirements 14.2, 14.3, 14.4, 14.6, 14.9, 14.10, 13.3_
//
// 素通し原則（Pass_Through）が守るのは `payload`、つまりベンダー由来の申告値である。ベンダーがフィールドを
// 1 つ足しただけで受信が止まる状態を作らないために、**`payload` の構造を型として書いた箇所が存在しない**
// ことを構造として固定する。振る舞いテスト（tests/ingress/batch.property.test.ts の素通し）が押さえるのは
// 「いま拒否されないこと」であり、「将来ここに構造を書けないこと」は押さえられない——型を足した瞬間、
// property test は既存の生成器の範囲では通り続けるのに、実データのベンダー変更で落ちる。
//
// 検査する不変点は次の (a)〜(e):
//
//   (a) `payload` を運ぶ型は素通しの形のみ — src/ 全体で `payload` という名に与えられる型注釈が
//       `Record<string, unknown>` か `unknown` のいずれかであること（どちらも構造を表明しない）。
//   (b) POS の語彙が型として現れない — `store_id` / `plu_no` / `child_items` などのベンダー由来のキーが、
//       型メンバ（interface・type literal・class プロパティ）として宣言されていないこと。これらは
//       `Record<string, unknown>` からの読み出しとして現れてよく、型の形になってはならない（AC 13.3 の
//       「domain へ POS ペイロードの形を持ち込まない」もこの検査に含まれる）。
//   (c) 運搬と隔離の形 — `ArrivalBatch.records` が `readonly unknown[]`、`ArrivalRecord.payload` が
//       `Record<string, unknown>`、隔離（`contract-violation`）が運ぶ生値が `unknown` であること
//       （検証前の生値を書き換えない・AC 14.9）。
//   (d) 翻訳の局所も生値を受ける — 構造を知る唯一の局所（`toNoodleSpec`）と Unique_Key の導出
//       （`toUniqueKey`）が、いずれも `Record<string, unknown>` を引数に取ること。構造を知ることと
//       構造を型として宣言することは別である。
//   (e) スキーマ検証を持ち込まない — src/ がスキーマ検証ライブラリを import しないこと（AC 14.6。
//       検証の側が先に壊れる）。
//
// 検査は TypeScript の AST で行う。ソーステキストの正規表現では、型注釈（`payload: unknown`）と
// オブジェクトリテラルの値（`payload: entry.payload`）を取り違える。既存の
// tests/operation-history/no-wake.static.test.ts と同じ形で `ts.createSourceFile` を用いる。

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 上流ペイロードの運搬の型（Pass_Through の型による表明の地点）。 */
const BATCH_FILE = "src/ingress/batch.ts";
/** 品目 1 件の翻訳（構造を知る唯一の局所）。 */
const NOODLE_SPEC_FILE = "src/ingress/noodle-spec.ts";
/** Unique_Key の導出（4 要素を payload から読む）。 */
const UNIQUE_KEY_FILE = "src/ingress/unique-key.ts";
/** 保留と隔離の持ち物（隔離は検証前の生値を運ぶ）。 */
const HELD_RECORD_FILE = "src/registry/held-record.ts";

/**
 * `payload` に与えてよい型。**どちらも構造を表明しない形である。**
 *
 * `Record<string, unknown>` は「キーがあること」だけを言い、`unknown` は何も言わない。前者は本経路の
 * 運搬（`ArrivalRecord`）、後者は既存の Instrumentation_Log（`src/observe/log.ts`）が用いる。
 */
const PASS_THROUGH_TYPES: ReadonlySet<string> = new Set(["Record<string, unknown>", "unknown"]);

/**
 * 語が一致しても概念が違うもの — Cloudflare Access の JWT 本体（`src/worker.ts` の `canonicalIdentity`）。
 *
 * 素通し原則が守るのはベンダー由来の申告値であり、こちらは Access が署名した identity の主張である
 * （`jose` が型を定める）。層が違うため構造を型として宣言してよい。**型名を列挙して除く**——ファイルごと
 * 外せば、同じ `src/worker.ts` に上流ペイロードの構造を書いても検査が通る。
 */
const IDENTITY_PAYLOAD_TYPES: ReadonlySet<string> = new Set(["JWTPayload"]);

/**
 * ベンダー由来の申告値のキー。**型メンバとして宣言されてはならない。**
 *
 * 上流が付与するメタデータ（`path` / `arrival_timestamp_ms` / `sequence_number`）は含めない——層が違い、
 * これらに構造・型の要件を課すことは素通し原則の例外にあたらない（AC 14.10・14.11）。
 */
const VENDOR_PAYLOAD_KEYS = [
  "store_id",
  "terminal_id",
  "bill_no",
  "datetime",
  "order_id",
  "table_no",
  "order_items",
  "child_items",
  "plu_no",
  "item_type",
  "qty",
  "s_class_code",
] as const;

/** スキーマ検証ライブラリ。1 つでも入れば「検証しない」という規律が名目だけになる（AC 14.6）。 */
const SCHEMA_VALIDATION_MODULES =
  /^(?:zod|valibot|ajv|yup|joi|superstruct|io-ts|@sinclair\/typebox)(?:\/|$)/;

// ── ファイル探索・パース ────────────────────────────────────────────────────

/** repoRoot からの相対パス（posix 区切り）で `.ts` / `.tsx` を再帰収集する。 */
function collectSourceFiles(relativeDir: string): readonly string[] {
  const absolute = resolve(repoRoot, relativeDir);
  const found: string[] = [];
  for (const dirent of readdirSync(absolute, { withFileTypes: true })) {
    const childAbsolute = resolve(absolute, dirent.name);
    const childRelative = relative(repoRoot, childAbsolute).split(sep).join("/");
    if (dirent.isDirectory()) found.push(...collectSourceFiles(childRelative));
    else if (dirent.isFile() && /\.tsx?$/.test(dirent.name)) found.push(childRelative);
  }
  return found.sort();
}

function parse(relativePath: string): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    readFileSync(resolve(repoRoot, relativePath), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function walk(node: ts.Node, visit: (child: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** 宣言の名（識別子・文字列キー・数値キー）。計算プロパティ名は名として読めないため undefined。 */
function declaredName(name: ts.Node | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))
    return name.text;
  return undefined;
}

/** 型注釈のテキスト（空白を 1 個に畳んで比較可能にする）。 */
function typeText(type: ts.TypeNode, file: ts.SourceFile): string {
  return type.getText(file).replace(/\s+/g, " ").trim();
}

/** 名前と型注釈を持つ宣言（型メンバ・引数・変数・class プロパティ）を列挙する。 */
function annotatedDeclarations(
  file: ts.SourceFile,
): readonly { readonly name: string; readonly type: string }[] {
  const declarations: { readonly name: string; readonly type: string }[] = [];
  walk(file, (node) => {
    if (
      !ts.isPropertySignature(node) &&
      !ts.isPropertyDeclaration(node) &&
      !ts.isParameter(node) &&
      !ts.isVariableDeclaration(node)
    ) {
      return;
    }
    const name = declaredName(node.name);
    if (name === undefined || node.type === undefined) return;
    declarations.push({ name, type: typeText(node.type, file) });
  });
  return declarations;
}

/** 型メンバ（interface・type literal・class プロパティ）として宣言された名を列挙する。 */
function declaredMemberNames(file: ts.SourceFile): readonly string[] {
  const names: string[] = [];
  walk(file, (node) => {
    if (!ts.isPropertySignature(node) && !ts.isPropertyDeclaration(node)) return;
    const name = declaredName(node.name);
    if (name !== undefined) names.push(name);
  });
  return names;
}

/** import / re-export の module specifier を列挙する。 */
function moduleSpecifiers(file: ts.SourceFile): readonly string[] {
  const specifiers: string[] = [];
  for (const statement of file.statements) {
    const specifier = ts.isImportDeclaration(statement)
      ? statement.moduleSpecifier
      : ts.isExportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined;
    if (specifier !== undefined && ts.isStringLiteralLike(specifier))
      specifiers.push(specifier.text);
  }
  return specifiers;
}

/** 指定した名の関数宣言の引数（宣言順）。 */
function functionParameters(
  file: ts.SourceFile,
  functionName: string,
): readonly { readonly name: string | undefined; readonly type: string | undefined }[] {
  const found: { readonly name: string | undefined; readonly type: string | undefined }[] = [];
  walk(file, (node) => {
    if (!ts.isFunctionDeclaration(node) || declaredName(node.name) !== functionName) return;
    for (const parameter of node.parameters) {
      found.push({
        name: declaredName(parameter.name),
        type: parameter.type === undefined ? undefined : typeText(parameter.type, file),
      });
    }
  });
  return found;
}

/** src/ 全体の .ts / .tsx ソース（走査対象）。 */
const ALL_SRC_FILES = collectSourceFiles("src");

// ── (a) `payload` を運ぶ型は素通しの形のみ ──────────────────────────────────

describe("(a) src/ 全体で payload に構造を表明する型を与えない（要件14.2〜14.4・14.6）", () => {
  it("走査対象が空でない", () => {
    expect(ALL_SRC_FILES.length).toBeGreaterThan(0);
  });

  it("payload という名の型注釈は Record<string, unknown> か unknown のみ", () => {
    for (const path of ALL_SRC_FILES) {
      const file = parse(path);
      for (const declaration of annotatedDeclarations(file)) {
        if (declaration.name !== "payload") continue;
        if (IDENTITY_PAYLOAD_TYPES.has(declaration.type)) continue;
        expect(
          PASS_THROUGH_TYPES.has(declaration.type),
          `${path} が payload に構造を表明する型 ${declaration.type} を与えている`,
        ).toBe(true);
      }
    }
  });
});

// ── (b) POS の語彙が型として現れない ────────────────────────────────────────

describe("(b) ベンダー由来のキーが型メンバとして宣言されない（要件14.6・13.3）", () => {
  it("src/ の全ファイルで POS ペイロードのキーが型メンバに現れない", () => {
    for (const path of ALL_SRC_FILES) {
      const members = new Set(declaredMemberNames(parse(path)));
      for (const key of VENDOR_PAYLOAD_KEYS) {
        expect(
          members.has(key),
          `${path} が POS ペイロードのキー ${key} を型として宣言している`,
        ).toBe(false);
      }
    }
  });
});

// ── (c) 運搬と隔離の形 ──────────────────────────────────────────────────────

describe("(c) 運搬は生値のまま、隔離は検証前の生値のまま（要件14.9・14.10）", () => {
  it("ArrivalBatch.records が readonly unknown[]、ArrivalRecord.payload が Record<string, unknown>", () => {
    const file = parse(BATCH_FILE);
    const declarations = annotatedDeclarations(file);
    const records = declarations.filter((declaration) => declaration.name === "records");
    const payload = declarations.filter((declaration) => declaration.name === "payload");
    // 要素の形を型として書かない（検証に落ちた要素は隔離へ回るため、生値のまま保つ・AC 14.9）。
    expect(records.map((declaration) => declaration.type)).toContain("readonly unknown[]");
    expect(payload.map((declaration) => declaration.type)).toEqual(["Record<string, unknown>"]);
  });

  it("隔離が運ぶ生値（HeldRecord の contract-violation 側）が unknown である", () => {
    const declarations = annotatedDeclarations(parse(HELD_RECORD_FILE));
    const raw = declarations.filter((declaration) => declaration.name === "raw");
    // 型違反の Record は ArrivalRecord を構築できない。検証済みの形へ寄せれば、寄せられない Record が落ちる。
    expect(raw.map((declaration) => declaration.type)).toEqual(["unknown"]);
  });
});

// ── (d) 翻訳の局所も生値を受ける ────────────────────────────────────────────

describe("(d) 構造を知る局所も引数は生値である（要件14.6）", () => {
  it("toNoodleSpec の第 1 引数が Record<string, unknown>", () => {
    const parameters = functionParameters(parse(NOODLE_SPEC_FILE), "toNoodleSpec");
    expect(parameters.length).toBeGreaterThan(0);
    expect(parameters[0]?.type).toBe("Record<string, unknown>");
  });

  it("toUniqueKey の引数が Record<string, unknown>", () => {
    const parameters = functionParameters(parse(UNIQUE_KEY_FILE), "toUniqueKey");
    expect(parameters.map((parameter) => parameter.type)).toEqual(["Record<string, unknown>"]);
  });
});

// ── (e) スキーマ検証を持ち込まない ──────────────────────────────────────────

describe("(e) src/ がスキーマ検証ライブラリを import しない（要件14.6）", () => {
  it("全ファイルの import にスキーマ検証ライブラリが現れない", () => {
    for (const path of ALL_SRC_FILES) {
      for (const specifier of moduleSpecifiers(parse(path))) {
        expect(
          SCHEMA_VALIDATION_MODULES.test(specifier),
          `${path} がスキーマ検証ライブラリ ${specifier} を import している`,
        ).toBe(false);
      }
    }
  });
});
