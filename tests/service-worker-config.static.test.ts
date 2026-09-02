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

import { readFileSync, readdirSync } from "node:fs";
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
    const key =
      ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name)
        ? member.name.text
        : undefined;
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
  if (!ts.isArrayLiteralExpression(array))
    throw new Error(`${PWA_CONFIG} の ${label} が配列リテラルでない`);
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
  if (denylist === undefined)
    throw new Error(`${PWA_CONFIG} の workbox に navigateFallbackDenylist が無い`);
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
      throw new Error(
        `${PWA_CONFIG} の runtimeCaching に静的に読めない規則がある: ${rule.getText()}`,
      );
    }
    const urlPattern = property(rule, "urlPattern");
    const pattern = urlPattern === undefined ? undefined : toPattern(urlPattern);
    if (pattern === undefined) {
      // 関数 urlPattern は静的に判定できない。読めないまま通せば `/entry/` を捉える規則を見落とす。
      throw new Error(
        `${PWA_CONFIG} の runtimeCaching に静的に読めない urlPattern がある: ${rule.getText()}`,
      );
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
const APP_SHELL_NAVIGATIONS = [
  "/",
  "/index.html",
  "/s/yamaokaya-1263/",
  "/s/yamaokaya-1263/settings",
] as const;

/** Validates: 要件 5.1, 5.2, 5.3 */
describe("Service_Worker のフォールバック除外 — 意図のある経路のみ", () => {
  it("Access の認証エンドポイントと API 経路を除外する", () => {
    const denylist = navigateFallbackDenylist();
    for (const pathname of EXCLUDED_NAVIGATIONS) {
      expect(
        denylist.some((pattern) => pattern.matches(pathname)),
        `${pathname} が navigateFallbackDenylist に捉えられない。ナビゲーションが App_Shell に飲まれ、` +
          `Access の 302 がブラウザへ渡らない（要件 5.1・5.2）。現行の項: ${denylist.map((p) => p.source).join(", ")}`,
      ).toBe(true);
    }
  });

  it("App_Shell のナビゲーションは除外しない", () => {
    const denylist = navigateFallbackDenylist();
    for (const pathname of APP_SHELL_NAVIGATIONS) {
      const matched = denylist
        .filter((pattern) => pattern.matches(pathname))
        .map((pattern) => pattern.source);
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
      expect(
        pattern.source,
        `${pattern.source} は WebSocket の項。項ごと削る（要件 5.3）`,
      ).not.toMatch(/ws/i);
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
        `${pathname} に runtimeCaching 規則が一致する。Workbox の戦略が Opaque_Redirect（status === 0）を` +
          `失敗と見なし、キャッシュ済みの古い 200 を返せば分類が noAccess / offline へ誤る（要件 5.4）`,
      ).toEqual([]);
    }
  });
});
// ─────────────────────────────────────────────────────────────────────────────
// PWA 基盤の smoke 検査（offline-degradation 要件 10.1 / 10.3 / 10.4 / 10.5）
//
// **上の検査との違い。** 読む対象（`vite.config.ts`）は同じだが、守る不変点が異なる。上は
// 「Service_Worker が認証経路を横取りしないこと」（`navigateFallbackDenylist` と `/entry/` の
// `runtimeCaching` 不在）。ここは「オフライン起動とリロード抑止の土台が実在すること」——
// App_Shell が precache 対象に入り、standalone 表示で動き、プルトゥリフレッシュが CSS で
// 抑止され、それ以上の抑止層を持たないこと。
//
// **`tests/offline-degradation.static.test.ts` との違い。** IndexedDB / Background Sync 不使用
// （要件11.4）は同ファイル（`:507` / `:515`）が既に押さえているため、ここでは繰り返さない。
// 同じ主張を二箇所に置けば、二つの真実になりかけるだけで何も余分に守らない。
//
// **なぜ振る舞いテストではないのか。** standalone 表示・precache・overscroll は、いずれも
// 実行時のコードではなく設定と CSS が決める。ゆえに真実のある場所——`vite.config.ts` と
// `src/client/styles.css`——を直接読む。

/** CSS の単一の取り込み点（tooling.md）。`overscroll-behavior` はここに在るべきである。 */
const APP_STYLES = "src/client/styles.css";

/** `manifest` の設定オブジェクト。無ければ落とす——`display` が読めないことを「standalone でない」と静かに扱わない。 */
function manifestOptions(): ts.ObjectLiteralExpression {
  const manifest = property(vitePwaOptions(), "manifest");
  if (manifest === undefined || !ts.isObjectLiteralExpression(manifest)) {
    throw new Error(`${PWA_CONFIG} の VitePWA に manifest 設定が無い`);
  }
  return manifest;
}

/**
 * `workbox.globPatterns` に書かれた glob 文字列。
 * `toPattern()` は完全一致の判定しか作らず glob を展開できないため、ここではパターン文字列そのものを
 * 主張の対象にする。**読めない項は値にしない**——静的に読めない項を黙って飛ばせば、precache 対象が
 * 実際には空でも緑になる。
 */
function precacheGlobs(): readonly string[] {
  const globPatterns = property(workboxOptions(), "globPatterns");
  if (globPatterns === undefined)
    throw new Error(`${PWA_CONFIG} の workbox に globPatterns が無い`);
  if (!ts.isArrayLiteralExpression(globPatterns)) {
    throw new Error(`${PWA_CONFIG} の globPatterns が配列リテラルでない`);
  }
  return globPatterns.elements.map((element) => {
    if (!ts.isStringLiteralLike(element)) {
      throw new Error(
        `${PWA_CONFIG} の globPatterns に静的に読めない項がある: ${element.getText()}`,
      );
    }
    return element.text;
  });
}

/**
 * glob から拡張子トークンを取り出す（`**\/*.{js,css,html}` → js / css / html、`**\/*.js` → js）。
 * 拡張子を持たない glob（`**\/*` 等）は展開せず空を返す——「全部入っているはず」と推測で通すより、
 * 主張が落ちて設定を読み直させるほうが安全である。
 */
function precacheExtensions(globs: readonly string[]): ReadonlySet<string> {
  const extensions = new Set<string>();
  for (const glob of globs) {
    const grouped = /\.\{([^}]+)\}$/.exec(glob)?.[1];
    if (grouped !== undefined) {
      for (const token of grouped.split(",")) extensions.add(token.trim().toLowerCase());
      continue;
    }
    const single = /\.([A-Za-z0-9]+)$/.exec(glob)?.[1];
    if (single !== undefined) extensions.add(single.toLowerCase());
  }
  return extensions;
}

/** CSS の宣言 1 つ。`selector` は宣言が属するブロックの見出しで、失敗時の指し先になる。 */
interface StyleRule {
  readonly selector: string;
  readonly property: string;
  readonly value: string;
}

/** CSS コメントを落とす。コメント内の property 名を実在の宣言と誤認しないため。 */
function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/**
 * `overscroll-behavior`（`-x` / `-y` を含む）の宣言と、それが属するブロックのセレクタを取り出す。
 * セレクタまで見るのは、文書ルート（`html` / `body`）に当たっていなければプルトゥリフレッシュの
 * 抑止として働かないためである。宣言が 1 つも無ければ空を返し、呼び出し側が落ちる。
 */
function overscrollRules(relativePath: string): readonly StyleRule[] {
  const source = stripCssComments(readFileSync(resolve(repoRoot, relativePath), "utf8"));
  const rules: StyleRule[] = [];
  const declaration = /overscroll-behavior(?:-[xy])?\s*:\s*([^;}]+)/g;
  for (let found = declaration.exec(source); found !== null; found = declaration.exec(source)) {
    const declared = found[1];
    if (declared === undefined)
      throw new Error(`${relativePath} の overscroll-behavior に値が無い`);
    const before = source.slice(0, found.index);
    const blockStart = before.lastIndexOf("{");
    if (blockStart < 0)
      throw new Error(`${relativePath} の overscroll-behavior がブロックの外に在る`);
    const headStart = Math.max(
      before.lastIndexOf("{", blockStart - 1),
      before.lastIndexOf("}", blockStart - 1),
      before.lastIndexOf(";", blockStart - 1),
    );
    rules.push({
      selector: before.slice(headStart + 1, blockStart).trim(),
      property: found[0].slice(0, found[0].indexOf(":")).trim(),
      value: declared.trim(),
    });
  }
  return rules;
}

/** `src/client` 配下の全 TypeScript ソース（`.ts` / `.tsx`）。追加抑止層の探索範囲をここに限る。 */
function clientSources(): readonly string[] {
  const collected: string[] = [];
  const descend = (relativeDir: string): void => {
    for (const entry of readdirSync(resolve(repoRoot, relativeDir), { withFileTypes: true })) {
      const child = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) descend(child);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) collected.push(child);
    }
  };
  descend("src/client");
  return collected;
}

/**
 * 追加のリロード抑止層として現れうるイベント名。**完全一致で見る**——部分一致にすれば
 * `beforeinstallprompt`（`InstallPrompt.tsx` の正当な `preventDefault`）を誤って捉える。
 */
const RELOAD_SUPPRESSION_EVENTS = new Set(["beforeunload", "unload", "touchmove"]);

/** 同じ抑止を JSX 属性 / DOM プロパティで書いた形。 */
const RELOAD_SUPPRESSION_ATTRIBUTES = new Set(["onTouchMove", "onbeforeunload", "onunload"]);

/**
 * ファイルに現れる追加抑止の痕跡。AST を歩くのでコメントは対象外——「`beforeunload` は不可信」と
 * 書いた日本語コメント（`index.html` に実在する）を違反と誤認しない。
 */
function suppressionTracesIn(relativePath: string): readonly string[] {
  const source = ts.createSourceFile(
    relativePath,
    readFileSync(resolve(repoRoot, relativePath), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const traces: string[] = [];
  walk(source, (node) => {
    if (ts.isStringLiteralLike(node) && RELOAD_SUPPRESSION_EVENTS.has(node.text)) {
      traces.push(JSON.stringify(node.text));
      return;
    }
    if (ts.isIdentifier(node) && RELOAD_SUPPRESSION_ATTRIBUTES.has(node.text))
      traces.push(node.text);
  });
  return traces;
}

/** Validates: 要件 10.3 */
describe("PWA manifest — standalone 表示（要件10.3）", () => {
  it("`display` が `standalone` である", () => {
    const display = property(manifestOptions(), "display");
    // 不在を「standalone でない」と静かに扱わず落とす。読めなかったことは主張の失敗である。
    if (display === undefined) throw new Error(`${PWA_CONFIG} の manifest に display が無い`);
    if (!ts.isStringLiteralLike(display)) {
      throw new Error(`${PWA_CONFIG} の manifest.display が静的に読めない: ${display.getText()}`);
    }
    expect(
      display.text,
      "manifest.display が standalone でない。ブラウザクロム（リロードボタン）が現れ、" +
        "厨房スタッフが走行中ポットを不意に捨てられる（要件10.3）",
    ).toBe("standalone");
  });
});

/** Validates: 要件 10.1 */
describe("Workbox precache — App_Shell がオフライン起動できる（要件10.1）", () => {
  it("`globPatterns` が HTML / JS / CSS を precache 対象に列挙する", () => {
    const globs = precacheGlobs();
    const extensions = precacheExtensions(globs);
    for (const required of ["html", "js", "css"]) {
      expect(
        extensions.has(required),
        `precache 対象に .${required} が無い。App_Shell が揃わずオフライン起動が成立しない` +
          `（要件10.1）。現行の globPatterns: ${globs.map((glob) => JSON.stringify(glob)).join(", ")}`,
      ).toBe(true);
    }
  });

  it("`navigateFallback` が precache 済みの App_Shell を指す", () => {
    // precache だけではオフライン起動は成立しない。ナビゲーション要求が殻へ落ちる先が要る（要件10.1・10.2）。
    const navigateFallback = property(workboxOptions(), "navigateFallback");
    if (navigateFallback === undefined)
      throw new Error(`${PWA_CONFIG} の workbox に navigateFallback が無い`);
    if (!ts.isStringLiteralLike(navigateFallback)) {
      throw new Error(
        `${PWA_CONFIG} の navigateFallback が静的に読めない: ${navigateFallback.getText()}`,
      );
    }
    expect(
      navigateFallback.text,
      "navigateFallback が HTML を指していない。オフラインのナビゲーションが殻に落ちない（要件10.1）",
    ).toMatch(/\.html$/);
    const extensions = precacheExtensions(precacheGlobs());
    expect(extensions.has("html"), "navigateFallback の指す HTML が precache 対象に入らない").toBe(
      true,
    );
  });
});

/** Validates: 要件 10.4, 10.5 */
describe("リロード抑止 — standalone + overscroll に限る（要件10.4 / 10.5）", () => {
  it("`overscroll-behavior` が文書ルート（html / body）に当たっている", () => {
    const rules = overscrollRules(APP_STYLES);
    expect(
      rules.map((rule) => `${rule.selector} { ${rule.property}: ${rule.value} }`),
      `${APP_STYLES} に overscroll-behavior の宣言が無い。プルトゥリフレッシュが素通りする（要件10.4）`,
    ).not.toEqual([]);
    // セレクタまで見る。文書ルートに当たっていなければ、宣言が在ってもスクロールチェーンの端を押さえない。
    const rootRules = rules.filter(
      (rule) =>
        /(^|[\s,])html([\s,]|$)/.test(rule.selector) &&
        /(^|[\s,])body([\s,]|$)/.test(rule.selector),
    );
    expect(
      rootRules.map((rule) => rule.selector),
      `overscroll-behavior が html / body に当たっていない。現行のセレクタ: ${rules
        .map((rule) => JSON.stringify(rule.selector))
        .join(", ")}`,
    ).not.toEqual([]);
    for (const rule of rootRules) {
      // none / contain のみがスクロールチェーンを断つ。auto は既定であり抑止として働かない。
      expect(
        rule.value,
        `${rule.selector} の ${rule.property} が ${rule.value}。プルトゥリフレッシュを抑止しない（要件10.4）`,
      ).toMatch(/^(none|contain)$/);
    }
  });

  it("追加の抑止層（unload 傍受・touchmove の抑止）を持たない", () => {
    // 決定 A（要件10.5）: 抑止は standalone + overscroll の二点に限り、リロードを生き延びる担保は
    // App_Shell キャッシュ（要件10.1）と永続化・再水和（要件11）に委ねる。ゆえに主張は「無いこと」。
    // 探索は src/client の TypeScript ソースに限る——範囲を広げれば index.html の日本語コメントや
    // spec ドキュメントを拾い、偽陽性で主張が濁る。
    for (const file of clientSources()) {
      const traces = suppressionTracesIn(file);
      expect(
        traces,
        `${file} に追加のリロード抑止層がある: ${traces.join(", ")}。決定 A（要件10.5）は抑止を` +
          `standalone + overscroll に限る`,
      ).toEqual([]);
    }
  });
});
