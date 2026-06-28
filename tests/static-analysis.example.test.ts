// tests/static-analysis.example.test.ts — 不変点を守るソース静的検査（タスク22.1）。
//
// 設計哲学・steering の不変点のうち、振る舞いテストでは捉えにくい「禁則」をソーステキストの
// 直接検査で守る。対象は core（純粋変換）と StoreTimerDO（DO シェル）のみ。client は対象外で、
// ブラウザ側の秒読みティック（useNow / connection の setInterval）は正当なため検査しない。
//
// 検査する不変点:
//   1. 「待つなら寝かせる、抱えると漏れる」 — core / StoreTimerDO に秒読み目的の setInterval や
//      終端のない setTimeout ループを持たない。時間管理は Alarm（storage.setAlarm）のみ。
//      （要件8.2 / 設計哲学）
//   2. WebSocket は Hibernation 互換の ctx.acceptWebSocket で収容し、server.accept() は使わない。
//      （要件9.2）
//   3. ストレージは非同期 KV API（put/get）のみ。ctx.storage.sql・SQL クエリは使わない。
//      （要件8.2 / 9.5）
//
// 検査は実コードに対して行う。コメント・文字列リテラルは誤検出の元（例: store-timer-do.ts の
// コメントに「server.accept() は使わない」という文字列が含まれる）なので、走査前に除去する。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

/** core の純粋変換群（cloudflare:workers・storage 非依存）。 */
const CORE_FILES = [
  "src/engine/alarm.ts",
  "src/engine/cancel.ts",
  "src/engine/decide.ts",
  "src/engine/effect.ts",
  "src/engine/event.ts",
  "src/engine/fire.ts",
  "src/engine/migrate.ts",
  "src/engine/rejection.ts",
  "src/engine/snapshot.ts",
  "src/engine/start.ts",
  "src/engine/state.ts",
  "src/engine/timer.ts",
  "src/engine/types.ts",
] as const;

/** DO シェル。プラットフォーム作用の端。 */
const SHELL_FILE = "src/shell/store-timer-do.ts";

/** 検査対象全体（core + StoreTimerDO）。 */
const SCANNED_FILES = [...CORE_FILES, SHELL_FILE] as const;

/**
 * TypeScript ソースからコメントと文字列リテラルを除去し、実コードだけを残す。
 *
 * 単純な正規表現では「文字列中の // 」「コメント中の引用符」を取り違えるため、状態を持つ
 * 1 文字走査で行う。行コメント・ブロックコメント・シングル/ダブル/テンプレート文字列を
 * 空白へ畳み、トークンの語境界（行構造）は保ったまま実コードのみを返す。
 * テンプレート内の ${} 式も文字列として畳むが、対象ファイルの禁則トークンは式内に現れない。
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
        // 改行はコード構造として残す。
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
          // ブロックコメント内の改行も残し、行番号構造を保つ。
          out += ch;
        }
        break;
      case "single":
        if (ch === "\\") {
          i += 1; // エスケープ次文字を読み飛ばす
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

/** 検査対象ファイルを読み、実コードのみへ畳んだテキストを返す。 */
function readCode(relativePath: string): string {
  const raw = readFileSync(resolve(repoRoot, relativePath), "utf8");
  return stripCommentsAndStrings(raw);
}

describe("静的検査 — core / StoreTimerDO の不変点（タスク22.1）", () => {
  it("秒読み目的の setInterval を core / StoreTimerDO に持たない（要件8.2）", () => {
    for (const file of SCANNED_FILES) {
      const code = readCode(file);
      expect(code, `${file} に setInterval が存在する`).not.toMatch(/\bsetInterval\b/);
    }
  });

  it("終端のない setTimeout ループを core / StoreTimerDO に持たない（要件8.2）", () => {
    // 時間管理は Alarm（storage.setAlarm）のみ。秒読み・ポーリング目的の setTimeout を一切持たない。
    for (const file of SCANNED_FILES) {
      const code = readCode(file);
      expect(code, `${file} に setTimeout が存在する`).not.toMatch(/\bsetTimeout\b/);
    }
  });

  it("StoreTimerDO は ctx.acceptWebSocket で WS を収容する（要件9.2）", () => {
    const code = readCode(SHELL_FILE);
    expect(code, `${SHELL_FILE} で acceptWebSocket を使っていない`).toMatch(/\bacceptWebSocket\s*\(/);
  });

  it("StoreTimerDO は server.accept() を使わない（Hibernation 非互換の受理を禁止・要件9.2）", () => {
    const code = readCode(SHELL_FILE);
    // acceptWebSocket は許容、素の .accept( だけを禁止する（acceptWebSocket を巻き込まない否定先読み）。
    expect(code, `${SHELL_FILE} で server.accept() を使っている`).not.toMatch(/(?<!Web[Ss]ocket)\.accept\s*\(/);
  });

  it("core / StoreTimerDO は ctx.storage.sql を使わない（KV API のみ・要件8.2 / 9.5）", () => {
    for (const file of SCANNED_FILES) {
      const code = readCode(file);
      expect(code, `${file} で storage.sql を使っている`).not.toMatch(/storage\s*\.\s*sql\b/);
      expect(code, `${file} で .sql アクセスがある`).not.toMatch(/\.\s*sql\b/);
      expect(code, `${file} で exec SQL を使っている`).not.toMatch(/\.\s*exec\s*\(/);
    }
  });

  it("StoreTimerDO の永続化は KV API（put / get）のみを使う（要件8.2 / 9.5）", () => {
    const code = readCode(SHELL_FILE);
    // 状態の読み書きは storage.put / storage.get に限る（単一キー丸ごと）。
    expect(code, `${SHELL_FILE} で storage.put を使っていない`).toMatch(/storage\s*\.\s*put\s*\(/);
    expect(code, `${SHELL_FILE} で storage.get を使っていない`).toMatch(/storage\s*\.\s*get\s*\(/);
  });
});
