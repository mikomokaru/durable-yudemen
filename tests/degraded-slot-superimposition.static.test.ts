// tests/degraded-slot-superimposition.static.test.ts — 変更が src/client に閉じていることのソース静的検査（タスク5.2）。
//
// 本修正（degraded の 1 スロット重ね合わせ）は 2 つの非公開ヘルパ（占有ゲートの述語 occupiesAny と
// 統一規則の実体 resolveSlotOccupancy）を src/client/connection.ts に足すだけで成立する。engine 契約
// （src/engine / src/domain）は不変であり、変更は src/client 内に閉じる（bugfix.md 要件3.6）。
//
// この不変点は振る舞いテストでは捉えにくい。釜の排他性を engine 側で検査する形にしても、client 側の
// 遷移で拒む形にしても、外から見た「重ね合わせが生まれない」という結果は同じになりうる。ゆえに
// 「サーバ側へ持ち出していないこと」をソーステキストの構造として見る。
//
// git diff は使わない。ブランチやコミットの状態で結果が変わる検査は CI で意味を失うため、既存
// tests/*.static.test.ts の規約に倣い「いま存在するソースが制約を満たすか」だけを見る（node:fs で
// 実ファイルを読み、禁則トークンの不在と、検査の足場になるシンボルの存在を確かめる）。
//
// トークンの有無を見る検査は実コード（コメント・文字列を除去）に対して行う——本修正を説明する日本語
// コメントには両識別子が正当に現れるため、コメントを読めば誤検出する。
//
// stripCommentsAndStrings はここに実装する。同名の関数は既存の静的検査ファイルに非 export で重複して
// おり import できない（共有 helper への抽出と既存テストの移行は本 spec のスコープ外）。

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

/** クライアント純粋遷移層。2 つの非公開ヘルパの唯一の在処。 */
const CONNECTION_FILE = "src/client/connection.ts";

/**
 * 占有ゲートと統一規則の識別子。engine 契約（src/engine / src/domain）に現れてはならない。
 *
 * どちらも「釜の排他性を client の遷移で守る」という判断そのものの名であり、サーバ側に現れたなら
 * 変更が src/client から漏れた証跡である（限界 4・申し送り 2 のとおり、サーバ側の占有検査は別 spec）。
 */
const RESOLUTION_TOKENS = ["occupiesAny", "resolveSlotOccupancy"] as const;

// ── ソースの正規化（コメント／文字列の除去） ───────────────────────────────────

type Mode = "code" | "line" | "block" | "single" | "double" | "template";

/**
 * TypeScript ソースからコメントと文字列リテラルの両方を除去し、実コードだけを残す。
 *
 * 単純な正規表現では「文字列中の // 」「コメント中の引用符」を取り違えるため、状態を持つ 1 文字走査で
 * 行う。行構造（改行）は保つ。
 */
function stripCommentsAndStrings(source: string): string {
  let mode: Mode = "code";
  let out = "";
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    switch (mode) {
      case "code":
        if (ch === "/" && next === "/") {
          mode = "line";
          i += 1;
        } else if (ch === "/" && next === "*") {
          mode = "block";
          i += 1;
        } else if (ch === "'") {
          mode = "single";
        } else if (ch === '"') {
          mode = "double";
        } else if (ch === "`") {
          mode = "template";
        } else {
          out += ch;
        }
        break;
      case "line":
        if (ch === "\n") {
          mode = "code";
          out += ch;
        }
        break;
      case "block":
        if (ch === "*" && next === "/") {
          mode = "code";
          i += 1;
        } else if (ch === "\n") {
          out += ch;
        }
        break;
      case "single":
        if (ch === "\\") {
          i += 1;
        } else if (ch === "'") {
          mode = "code";
        }
        break;
      case "double":
        if (ch === "\\") {
          i += 1;
        } else if (ch === '"') {
          mode = "code";
        }
        break;
      case "template":
        if (ch === "\\") {
          i += 1;
        } else if (ch === "`") {
          mode = "code";
        } else if (ch === "\n") {
          out += ch;
        }
        break;
    }
  }
  return out;
}

// ── ファイル探索・読み込みヘルパー ────────────────────────────────────────────

/** repoRoot からの相対パス（posix 区切り）で `.ts` / `.tsx` ファイルを再帰収集する。 */
function collectSourceFiles(relativeDir: string): readonly string[] {
  const absolute = resolve(repoRoot, relativeDir);
  const found: string[] = [];
  for (const dirent of readdirSync(absolute, { withFileTypes: true })) {
    const childAbsolute = resolve(absolute, dirent.name);
    const childRelative = relative(repoRoot, childAbsolute).split(sep).join("/");
    if (dirent.isDirectory()) {
      found.push(...collectSourceFiles(childRelative));
    } else if (dirent.isFile() && (dirent.name.endsWith(".ts") || dirent.name.endsWith(".tsx"))) {
      found.push(childRelative);
    }
  }
  return found.sort();
}

/** ファイルを読み、実コードのみ（コメント・文字列除去）へ畳んだテキストを返す。 */
function readBareCode(relativePath: string): string {
  return stripCommentsAndStrings(readFileSync(resolve(repoRoot, relativePath), "utf8"));
}

/** engine 契約の全ソース（src/engine + src/domain）。本修正の差分がここに一切無いことを検査する。 */
const ENGINE_CONTRACT_FILES = [
  ...collectSourceFiles("src/engine"),
  ...collectSourceFiles("src/domain"),
];

describe("変更は src/client に閉じている（degraded-slot-superimposition 要件3.6）", () => {
  it("走査対象（src/engine / src/domain）の探索が健全（空でない）", () => {
    // 下の禁則検査はファイル集合を回す。集合が空なら検査が空振りして常に真になるため、足場を確かめる。
    expect(ENGINE_CONTRACT_FILES.length).toBeGreaterThan(0);
  });

  it("src/engine / src/domain の実コードに占有ゲート・解決規則の識別子が現れない", () => {
    for (const file of ENGINE_CONTRACT_FILES) {
      const code = readBareCode(file);
      for (const token of RESOLUTION_TOKENS) {
        expect(code, `${file} に ${token} が実コードとして現れる（変更が src/client から漏れている）`).not.toContain(
          token,
        );
      }
    }
  });

  it("両識別子は src/client/connection.ts に実在する（検査の健全性）", () => {
    // 名が変われば上の禁則検査は空振りする。識別子の在処を同じ検査で固定し、トートロジー化を防ぐ。
    // 非公開（export しない）ことも併せて見る——公開すれば概念境界の表明になり、命名確認を要する。
    const code = readBareCode(CONNECTION_FILE);
    for (const token of RESOLUTION_TOKENS) {
      expect(code, `${CONNECTION_FILE} に ${token} の宣言が無い`).toMatch(
        new RegExp(`^function\\s+${token}\\b`, "m"),
      );
      expect(code, `${token} が export されている（非公開ヘルパのはず）`).not.toMatch(
        new RegExp(`\\bexport\\s+function\\s+${token}\\b`),
      );
    }
  });
});
