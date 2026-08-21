// tests/service-worker-config.static.test.ts — Service_Worker が認証経路を横取りしないことを設定で固定する静的検査。
//
// _Validates: signin-required-misreported-as-offline 要件 5.1, 5.2, 5.3, 5.4_
//
// **なぜ振る舞いテストではなく設定検査なのか。**
// Service_Worker の実体（`sw.js`）はビルド時に Workbox が生成する。ナビゲーションがネットワークへ出るか
// キャッシュ済み App_Shell に飲まれるかを決めるのは、我々が書いたコードではなく `vite.config.ts` の
// VitePWA/Workbox 設定である。ゆえに真実のある場所——`vite.config.ts`——を見る。
// `tests/entry-routing.static.test.ts`（wrangler.jsonc を見る）と同型である。
//
// 主張は 2 つ。
//   1. フォールバック除外が**意図のある経路のみ**を列挙する（`/cdn-cgi/`・`/entry/`・`/pos/`・`/admin/`）。
//      「のみ」の両側を押さえる——意図のある経路が除外されること、そして App_Shell のナビゲーションが
//      除外されないこと（要件 6.1・決定 A のキャッシュ優先を壊さない）。加えて `ws` の項を持たないこと
//      （WebSocket の upgrade はナビゲーション要求ではなく、そもそも除外対象にならない・AC 5.3）。
//   2. `/entry/` に一致する `runtimeCaching` 規則が存在しない（AC 5.4）。分類 fetch が Workbox の戦略を
//      素通りする根拠は、現状「規則が 1 つも無い」ことだけである。誰かが API 向けに `NetworkFirst` を
//      足せば、Opaque_Redirect（`status === 0`）を失敗と見なしてキャッシュ済みの古い 200 を返し、本 spec が
//      直した経路が再発する。

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** PWA / Service_Worker 設定の単一の正本。 */
const PWA_CONFIG = "vite.config.ts";

function parseConfig(): ts.SourceFile {
  return ts.createSourceFile(
    PWA_CONFIG,
    readFileSync(resolve(repoRoot, PWA_CONFIG), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function walk(node: ts.Node, visit: (child: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** `VitePWA({ ... })` の引数オブジェクト。設定がプラグイン呼び出しの中に在ることを主張の一部にする。 */
function vitePwaOptions(): ts.ObjectLiteralExpression {
  let options: ts.ObjectLiteralExpression | undefined;
  walk(parseConfig(), (node) => {
    if (!ts.isCallExpression(node)) return;
    if (!ts.isIdentifier(node.expression) || node.expression.text !== "VitePWA") return;
    const [first] = node.arguments;
    if (first !== undefined && ts.isObjectLiteralExpression(first)) options = first;
  });
  if (options === undefined) throw new Error(`${PWA_CONFIG} に VitePWA({ ... }) が無い`);
  return options;
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const member of object.properties) {
    if (!ts.isPropertyAssignment(member)) continue;
    const key = ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name) ? member.name.text : undefined;
    if (key === name) return member.initializer;
  }
  return undefined;
}

function workboxOptions(): ts.ObjectLiteralExpression {
  const workbox = property(vitePwaOptions(), "workbox");
  if (workbox === undefined || !ts.isObjectLiteralExpression(workbox)) {
    throw new Error(`${PWA_CONFIG} の VitePWA に workbox 設定が無い`);
  }
  return workbox;
}

/** 設定に書かれた 1 つのパターン。`source` は設定テキストそのままで、失敗時の指し先になる。 */
interface ConfiguredPattern {
  readonly source: string;
  readonly matches: (pathname: string) => boolean;
}

/**
 * 正規表現リテラル・文字列リテラルを、パス名に対する判定へ写す。
 * **読めないパターンは値にしない**（undefined を返す）——読めないものを「一致しない」と扱えば、
 * 実際には `/entry/` を捉える規則を見落とす。呼び出し側が読めなかったこと自体を失敗にする。
 */
function toPattern(node: ts.Expression): ConfiguredPattern | undefined {
  if (ts.isRegularExpressionLiteral(node)) {
    const text = node.text;
    const lastSlash = text.lastIndexOf("/");
    const expression = new RegExp(text.slice(1, lastSlash), text.slice(lastSlash + 1));
    return { source: text, matches: (pathname) => expression.test(pathname) };
  }
  if (ts.isStringLiteralLike(node)) {
    const literal = node.text;
    return { source: JSON.stringify(literal), matches: (pathname) => pathname === literal };
  }
  return undefined;
}

function patternsOf(array: ts.Expression, label: string): readonly ConfiguredPattern[] {
  if (!ts.isArrayLiteralExpression(array)) throw new Error(`${PWA_CONFIG} の ${label} が配列リテラルでない`);
  return array.elements.map((element) => {
    const pattern = toPattern(element);
    if (pattern === undefined) {
      throw new Error(`${PWA_CONFIG} の ${label} に静的に読めない項がある: ${element.getText()}`);
    }
    return pattern;
  });
}

function navigateFallbackDenylist(): readonly ConfiguredPattern[] {
  const denylist = property(workboxOptions(), "navigateFallbackDenylist");
  if (denylist === undefined) throw new Error(`${PWA_CONFIG} の workbox に navigateFallbackDenylist が無い`);
  return patternsOf(denylist, "navigateFallbackDenylist");
}

/** `runtimeCaching` の各規則の `urlPattern`。規則そのものが無ければ空。 */
function runtimeCachingUrlPatterns(): readonly ConfiguredPattern[] {
  const runtimeCaching = property(workboxOptions(), "runtimeCaching");
  if (runtimeCaching === undefined) return [];
  if (!ts.isArrayLiteralExpression(runtimeCaching)) {
    throw new Error(`${PWA_CONFIG} の runtimeCaching が配列リテラルでない`);
  }
  return runtimeCaching.elements.map((rule) => {
    if (!ts.isObjectLiteralExpression(rule)) {
      throw new Error(`${PWA_CONFIG} の runtimeCaching に静的に読めない規則がある: ${rule.getText()}`);
    }
    const urlPattern = property(rule, "urlPattern");
    const pattern = urlPattern === undefined ? undefined : toPattern(urlPattern);
    if (pattern === undefined) {
      // 関数 urlPattern は静的に判定できない。読めないまま通せば `/entry/` を捉える規則を見落とす。
      throw new Error(`${PWA_CONFIG} の runtimeCaching に静的に読めない urlPattern がある: ${rule.getText()}`);
    }
    return pattern;
  });
}

/** 除外されるべきナビゲーション経路（AC 5.1・5.2）。 */
const EXCLUDED_NAVIGATIONS = [
  // Access の認証エンドポイント（AC 5.1）。
  "/cdn-cgi/access/login/timer-dev.yamaokaya.org",
  // 機械が叩く API 経路（AC 5.2）。`/entry/signin/` はサインインへの通し口でもある。
  "/entry/stores",
  "/entry/signin/yamaokaya-1263",
  "/pos/records",
  "/admin/chains/yamaokaya",
] as const;

/** 除外されてはならないナビゲーション経路。App_Shell のキャッシュ優先が縮退運用の土台である（要件 6.1）。 */
const APP_SHELL_NAVIGATIONS = ["/", "/index.html", "/s/yamaokaya-1263/", "/s/yamaokaya-1263/settings"] as const;

/** Validates: 要件 5.1, 5.2, 5.3 */
describe("Service_Worker のフォールバック除外 — 意図のある経路のみ", () => {
  it("Access の認証エンドポイントと API 経路を除外する", () => {
    const denylist = navigateFallbackDenylist();
    for (const pathname of EXCLUDED_NAVIGATIONS) {
      expect(
        denylist.some((pattern) => pattern.matches(pathname)),
        `${pathname} が navigateFallbackDenylist に捉えられない。ナビゲーションが App_Shell に飲まれ、`
          + `Access の 302 がブラウザへ渡らない（要件 5.1・5.2）。現行の項: ${denylist.map((p) => p.source).join(", ")}`,
      ).toBe(true);
    }
  });

  it("App_Shell のナビゲーションは除外しない", () => {
    const denylist = navigateFallbackDenylist();
    for (const pathname of APP_SHELL_NAVIGATIONS) {
      const matched = denylist.filter((pattern) => pattern.matches(pathname)).map((pattern) => pattern.source);
      expect(
        matched,
        `${pathname} が除外されている。オフライン起動（要件 6.1・決定 A のキャッシュ優先）が壊れる`,
      ).toEqual([]);
    }
  });

  it("WebSocket の項を持たない", () => {
    const denylist = navigateFallbackDenylist();
    // WebSocket の upgrade はナビゲーション要求ではないため、そもそもフォールバック除外の対象にならない。
    // 正規表現を実在パス `/s/{storeId}/ws` へ直すのではなく**項ごと削る**（AC 5.3）。直せば「除外が必要
    // である」という誤解を温存する。ゆえに主張は「実在パスに一致すること」ではなく「項が無いこと」。
    for (const pattern of denylist) {
      expect(pattern.source, `${pattern.source} は WebSocket の項。項ごと削る（要件 5.3）`).not.toMatch(/ws/i);
    }
    for (const pathname of ["/ws", "/s/yamaokaya-1263/ws"]) {
      expect(
        denylist.filter((pattern) => pattern.matches(pathname)).map((pattern) => pattern.source),
        `${pathname} を除外する項がある。WebSocket はナビゲーションではない（要件 5.3）`,
      ).toEqual([]);
    }
  });
});

/** Validates: 要件 5.4 */
describe("Service_Worker の runtimeCaching — 分類 fetch を素通りさせる", () => {
  it("`/entry/` に一致する規則が存在しない", () => {
    const rules = runtimeCachingUrlPatterns();
    for (const pathname of ["/entry/stores", "/entry/signin/yamaokaya-1263"]) {
      expect(
        rules.filter((pattern) => pattern.matches(pathname)).map((pattern) => pattern.source),
        `${pathname} に runtimeCaching 規則が一致する。Workbox の戦略が Opaque_Redirect（status === 0）を`
          + `失敗と見なし、キャッシュ済みの古い 200 を返せば分類が noAccess / offline へ誤る（要件 5.4）`,
      ).toEqual([]);
    }
  });
});
