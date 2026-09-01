// tests/ping-blackhole.static.test.ts — ping blackhole が dev/test 限定に閉じていることを「ゲートの形」で
// 固定する静的検査（offline-degradation タスク12.3・要件14.4）。
//
// **なぜ振る舞いテストではなく AST 検査なのか。**
// 要件14.4 が求めるのは「本番バンドルに含まれない」ことと「本番のユーザー向け UI に切替手段が出ない」ことで
// ある。前者を成立させているのは我々のコードではなく Vite の定数畳み込み（`import.meta.env.DEV` → `false`）と
// tree-shaking であり、テスト環境では DEV が true ゆえ**振る舞いからは観測できない**。ゆえに真実のある場所
// ——ソースに書かれたゲートの形——を見る。`tests/service-worker-config.static.test.ts` と同型である。
//
// **dist を読む検査にしない。** `dist/` は `.gitignore` に在り、CI（`.github/workflows/ci-cd.yml`）は
// `pnpm test` を build より前に走らせる。dist を読む検査は CI で必ず失敗か skip になる（＝空虚な緑）。
//
// 主張は 5 箇所のゲートである。いずれも **`import.meta.env.DEV` が先頭ガード / 左オペランドであること**を
// 見る——後ろに置かれた DEV 判定は、本番ビルドで分岐ごと dead-code 除去される保証にならない。
//   1. `pingBlackholeDebugEnabled` の先頭文が `if (!import.meta.env.DEV) return false;`
//   2. 同関数がデバッグフラグ `VITE_PING_BLACKHOLE_DEBUG` を `"1"` と比較する（OBSERVE_DEBUG と同じ規律）
//   3. `withPingBlackhole` の先頭文が `if (!import.meta.env.DEV) return inner;`（本番では恒等関数）
//   4. `connection.ts` の blackhole 配線が `import.meta.env.DEV && pingBlackholeDebugEnabled()` の下にのみ在る
//   5. `App.tsx` のトグル JSX が `degradationTestable`（初期化子が `import.meta.env.DEV && …`）の下にのみ現れる
//
// 行番号では主張しない（リファクタで壊れ、かつ壊れても嘘に気づけない）。**読めなかったものを「無い」と
// 扱わない**——対象の関数・変数・JSX が見つからなければ例外を投げて落とす（service-worker-config.static.test.ts の
// `toPattern()` と同じ規律）。見つからないことを緑にすれば、ゲートごと消えた変更を検査が祝福してしまう。

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** blackhole 実装の在処（デコレータとデバッグフラグ）。 */
const CONNECTIVITY = "src/client/connectivity.ts";
/** 唯一の窓口。既定オープナへ blackhole を被せる配線が在る。 */
const CONNECTION = "src/client/connection.ts";
/** UI。dev トグルの露出経路が在る。 */
const APP = "src/client/App.tsx";

/** トグルの英語ラベル（ユーザー向け画面コンテンツ）。この文字列を含む要素がトグル本体を指す。 */
const TOGGLE_LABEL = "Simulate offline (dev)";

/** UI 側のゲート変数。トグル JSX はこの条件下にのみ現れてよい。 */
const UI_GATE = "degradationTestable";

function parseSource(relative: string): ts.SourceFile {
  return ts.createSourceFile(
    relative,
    readFileSync(resolve(repoRoot, relative), "utf8"),
    ts.ScriptTarget.Latest,
    // 親リンクを張る。ゲートは「どの条件の下に在るか」ゆえ、祖先を辿れることが主張の前提である。
    true,
    relative.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function walk(node: ts.Node, visit: (child: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function collect(source: ts.SourceFile, matches: (node: ts.Node) => boolean): readonly ts.Node[] {
  const found: ts.Node[] = [];
  walk(source, (node) => {
    if (matches(node)) found.push(node);
  });
  return found;
}

/** `import.meta.env` か。 */
function isImportMetaEnv(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "env" &&
    ts.isMetaProperty(node.expression) &&
    node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

/** `import.meta.env.{key}` か。 */
function isEnvFlag(node: ts.Node, key: string): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === key &&
    isImportMetaEnv(node.expression)
  );
}

/** 式の内側に `name(...)` の呼び出しが在るか。 */
function callsFunction(node: ts.Node, name: string): boolean {
  let found = false;
  walk(node, (child) => {
    if (
      ts.isCallExpression(child) &&
      ts.isIdentifier(child.expression) &&
      child.expression.text === name
    ) {
      found = true;
    }
  });
  return found;
}

/** 関数宣言を名前で引く。無ければ落とす（ゲートを載せる関数ごと消えたことを緑にしない）。 */
function functionDeclaration(relative: string, name: string): ts.FunctionDeclaration {
  const [declaration] = collect(
    parseSource(relative),
    (node): boolean => ts.isFunctionDeclaration(node) && node.name?.text === name,
  ) as readonly ts.FunctionDeclaration[];
  if (declaration === undefined) throw new Error(`${relative} に function ${name} が無い`);
  return declaration;
}

/**
 * 関数の**先頭文**が `if (!import.meta.env.DEV) return X;` の形なら X のテキストを返す。違えば undefined。
 *
 * 先頭であることを条件に含めるのは、DEV 判定が後ろに回った実装（本番で分岐が残る形）を通さないためである。
 */
function devGuardReturn(fn: ts.FunctionDeclaration): string | undefined {
  const first = fn.body?.statements[0];
  if (first === undefined || !ts.isIfStatement(first) || first.elseStatement !== undefined)
    return undefined;
  const condition = first.expression;
  if (
    !ts.isPrefixUnaryExpression(condition) ||
    condition.operator !== ts.SyntaxKind.ExclamationToken ||
    !isEnvFlag(condition.operand, "DEV")
  ) {
    return undefined;
  }
  const body = first.thenStatement;
  const returned = ts.isBlock(body)
    ? body.statements.length === 1 && ts.isReturnStatement(body.statements[0]!)
      ? (body.statements[0] as ts.ReturnStatement).expression
      : undefined
    : ts.isReturnStatement(body)
      ? body.expression
      : undefined;
  return returned?.getText();
}

/** 関数内でデバッグフラグ（`import.meta.env.VITE_*`）を文字列と厳密比較している箇所。 */
interface DebugFlagCheck {
  readonly envKey: string;
  readonly expected: string;
}

function debugFlagCheck(fn: ts.FunctionDeclaration): DebugFlagCheck | undefined {
  let check: DebugFlagCheck | undefined;
  walk(fn, (node) => {
    if (!ts.isBinaryExpression(node)) return;
    if (node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return;
    if (!ts.isPropertyAccessExpression(node.left) || !isImportMetaEnv(node.left.expression)) return;
    if (!ts.isStringLiteralLike(node.right)) return;
    check = { envKey: node.left.name.text, expected: node.right.text };
  });
  return check;
}

/** `import.meta.env.DEV && …{gatedCall}(…)` の形か。**DEV が左オペランドであること**を要求する。 */
function isDevGatedConjunction(expression: ts.Expression, gatedCall: string): boolean {
  return (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
    isEnvFlag(expression.left, "DEV") &&
    callsFunction(expression.right, gatedCall)
  );
}

/** node を包む最も内側の if 文の条件式。if の外に在れば undefined。 */
function enclosingIfCondition(node: ts.Node): ts.Expression | undefined {
  for (
    let current: ts.Node | undefined = node.parent;
    current !== undefined;
    current = current.parent
  ) {
    if (ts.isIfStatement(current)) return current.expression;
  }
  return undefined;
}

/** node の祖先に `{gate && …}` の JSX 式が在るか（トグルがゲートの下にのみ在ることの判定）。 */
function hasJsxGateAncestor(node: ts.Node, gate: string): boolean {
  for (
    let current: ts.Node | undefined = node.parent;
    current !== undefined;
    current = current.parent
  ) {
    if (!ts.isJsxExpression(current)) continue;
    const expression = current.expression;
    if (
      expression !== undefined &&
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      ts.isIdentifier(expression.left) &&
      expression.left.text === gate
    ) {
      return true;
    }
  }
  return false;
}

/** 変数宣言を名前で引く。無ければ落とす。 */
function variableDeclaration(relative: string, name: string): ts.VariableDeclaration {
  const [declaration] = collect(
    parseSource(relative),
    (node): boolean =>
      ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name,
  ) as readonly ts.VariableDeclaration[];
  if (declaration === undefined) throw new Error(`${relative} に ${name} の宣言が無い`);
  return declaration;
}

/** Validates: 要件 14.4 */
describe("ping blackhole — 実装のゲート（connectivity.ts）", () => {
  it("pingBlackholeDebugEnabled の先頭文が DEV の early return である", () => {
    const fn = functionDeclaration(CONNECTIVITY, "pingBlackholeDebugEnabled");
    expect(
      devGuardReturn(fn),
      `${CONNECTIVITY} の pingBlackholeDebugEnabled の先頭文が ` +
        `\`if (!import.meta.env.DEV) return false;\` でない。DEV 判定が先頭に無ければ本番ビルドで` +
        `フラグ評価が dead-code 除去されず、切替手段がバンドルに残る（要件14.4）`,
    ).toBe("false");
  });

  it('デバッグフラグは VITE_PING_BLACKHOLE_DEBUG === "1" で判定する（OBSERVE_DEBUG と同じ規律）', () => {
    const fn = functionDeclaration(CONNECTIVITY, "pingBlackholeDebugEnabled");
    expect(
      debugFlagCheck(fn),
      `${CONNECTIVITY} の pingBlackholeDebugEnabled が import.meta.env のフラグを文字列比較していない。` +
        `既定無効（未設定なら false）の規律が失われる（要件14.4）`,
    ).toEqual({ envKey: "VITE_PING_BLACKHOLE_DEBUG", expected: "1" });
  });

  it("withPingBlackhole の先頭文が DEV の early return（本番では恒等関数）である", () => {
    const fn = functionDeclaration(CONNECTIVITY, "withPingBlackhole");
    expect(
      devGuardReturn(fn),
      `${CONNECTIVITY} の withPingBlackhole の先頭文が \`if (!import.meta.env.DEV) return inner;\` でない。` +
        `本番で inner を素通しする恒等関数にならなければ、フォルトインジェクションの配線がバンドルに残る（要件14.4）`,
    ).toBe("inner");
  });
});

/** Validates: 要件 14.4 */
describe("ping blackhole — 配線のゲート（connection.ts）", () => {
  it("withPingBlackhole を被せる配線は DEV を左オペランドに置いた条件下にのみ在る", () => {
    const source = parseSource(CONNECTION);
    const wirings = collect(
      source,
      (node): boolean =>
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "withPingBlackhole",
    );
    // 読めなかったものを「無い」と扱わない。配線が消えていれば主張の対象ごと失われているので落とす。
    if (wirings.length === 0)
      throw new Error(`${CONNECTION} に withPingBlackhole の呼び出しが無い`);

    for (const wiring of wirings) {
      const condition = enclosingIfCondition(wiring);
      if (condition === undefined) {
        throw new Error(
          `${CONNECTION} の withPingBlackhole 呼び出しが if の外に在る（無条件に配線されている・要件14.4）`,
        );
      }
      expect(
        isDevGatedConjunction(condition, "pingBlackholeDebugEnabled"),
        `${CONNECTION} の blackhole 配線の条件が \`import.meta.env.DEV && pingBlackholeDebugEnabled()\` でない` +
          `（現行: ${condition.getText()}）。DEV が左オペランドでなければ本番ビルドで分岐ごと除去されない（要件14.4）`,
      ).toBe(true);
    }
  });
});

/** Validates: 要件 14.4 */
describe("ping blackhole — UI 非露出のゲート（App.tsx）", () => {
  it("degradationTestable の初期化子が DEV を左オペランドに置いた論理積である", () => {
    const declaration = variableDeclaration(APP, UI_GATE);
    const initializer = declaration.initializer;
    if (initializer === undefined) throw new Error(`${APP} の ${UI_GATE} に初期化子が無い`);
    expect(
      isDevGatedConjunction(initializer, "pingBlackholeDebugEnabled"),
      `${APP} の ${UI_GATE} の初期化子が \`import.meta.env.DEV && pingBlackholeDebugEnabled()\` でない` +
        `（現行: ${initializer.getText()}）。DEV が左オペランドでなければトグル配線が本番バンドルから除外されない（要件14.4）`,
    ).toBe(true);
  });

  it("トグルは degradationTestable の条件下にのみ現れる（本番 UI へ露出しない）", () => {
    const source = parseSource(APP);
    const labels = collect(
      source,
      (node): boolean =>
        (ts.isStringLiteralLike(node) || ts.isJsxText(node)) && node.text.includes(TOGGLE_LABEL),
    );
    // ラベルが見つからないことを緑にしない。文言を変えたのならこの定数も併せて更新すべきである。
    if (labels.length === 0)
      throw new Error(`${APP} に ${JSON.stringify(TOGGLE_LABEL)} を含む要素が無い`);

    for (const label of labels) {
      expect(
        hasJsxGateAncestor(label, UI_GATE),
        `${APP} の ${JSON.stringify(TOGGLE_LABEL)} が \`{${UI_GATE} && …}\` の下に無い。` +
          `フォルトインジェクションの切替手段が本番のユーザー向け UI に露出する（要件14.4）`,
      ).toBe(true);
    }
  });
});
