// tests/client/audioWakeLock.example.test.ts — Wake_Lock マウントの依存確認（タスク6.1・要件5.8）。
//
// なぜソーステキストの静的検査か:
//   音声信頼性の主戦略は「アプリを前面・画面点灯のまま維持する（Wake_Lock）」ことであり、
//   Pre_Alert / Done_Cue が鳴る前提条件そのものである（要件5.8 / design 骨格7）。本テストは
//   その前提——App が useWakeLock() をマウントしていること——を自動で固定する。
//
//   本リポジトリには React レンダラ（@testing-library/react・jsdom 等）が無く（assignment-ui の
//   example テスト参照）、App の実マウントは WS 接続・useSyncExternalStore 等を要して非現実的である。
//   そこで static-analysis.example.test.ts と同じく、実ソースをコメント/文字列を畳んだうえで検査し、
//   「App が ./components/useWakeLock から useWakeLock を取り込み、本体で呼んでいる」ことを確認する。
//   useWakeLock 自体は本 spec で再実装せず、依存先が当該シンボルを公開していることのみ併せて確かめる。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const APP_FILE = "src/client/App.tsx";
const WAKE_LOCK_FILE = "src/client/components/useWakeLock.ts";

function readRaw(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

/**
 * TypeScript ソースからコメントと文字列リテラルを空白へ畳み、実コードだけを残す。
 *
 * App.tsx は import コメントや本文コメントで "useWakeLock" の語に言及するため、コメント/文字列を
 * 残したまま走査すると誤検出する。状態を持つ 1 文字走査で行コメント・ブロックコメント・各種文字列を
 * 除去し、実コード上の呼び出しだけを判定する（static-analysis.example.test.ts と同じ手法）。
 */
function stripCommentsAndStrings(source: string): string {
  type Mode = "code" | "line" | "block" | "single" | "double" | "template";
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
        if (ch === "\\") i += 1;
        else if (ch === "'") mode = "code";
        break;
      case "double":
        if (ch === "\\") i += 1;
        else if (ch === '"') mode = "code";
        break;
      case "template":
        if (ch === "\\") i += 1;
        else if (ch === "`") mode = "code";
        else if (ch === "\n") out += ch;
        break;
    }
  }
  return out;
}

describe("Wake_Lock マウントの依存確認（タスク6.1・要件5.8）", () => {
  it("App は ./components/useWakeLock から useWakeLock を取り込む（音声信頼性の前提）", () => {
    const raw = readRaw(APP_FILE);
    // import 文はパス文字列を含むため raw を見る。シングル/ダブルクォート両対応。
    expect(raw, "App.tsx が useWakeLock を import していない").toMatch(
      /import\s*\{[^}]*\buseWakeLock\b[^}]*\}\s*from\s*["']\.\/components\/useWakeLock["']/,
    );
  });

  it("App は本体で useWakeLock() を呼んでマウントしている（前面維持の主戦略）", () => {
    const code = stripCommentsAndStrings(readRaw(APP_FILE));
    // コメント/文字列を除いた実コード上に useWakeLock() の呼び出しがある。
    expect(code, "App.tsx の実コードに useWakeLock() の呼び出しがない").toMatch(/\buseWakeLock\s*\(\s*\)/);
  });

  it("依存先 useWakeLock は当該シンボルを公開している（本 spec では再実装しない）", () => {
    const code = stripCommentsAndStrings(readRaw(WAKE_LOCK_FILE));
    expect(code, "useWakeLock.ts が useWakeLock を export していない").toMatch(
      /export\s+function\s+useWakeLock\b/,
    );
  });
});
