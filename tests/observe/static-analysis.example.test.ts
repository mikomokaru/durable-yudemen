// tests/observe/static-analysis.example.test.ts — 観測ハーネスの不変点を守るソース静的検査（タスク9.1）。
//
// 観測ハーネスは「挙動検証のための道具」であり、製品の core/shell 分離・hibernation 規律・
// 既存ワイヤ形式・英語出力という不変点（要件4.5 / 4.7 / 4.9 / 9.4 / 9.5 / 9.6）を、計装によって
// 崩してはならない。これらは振る舞いテストでは捉えにくい「禁則」なので、ソーステキストを直接
// 検査して構造で守る（example/smoke 検査。純粋判定ロジックではないため fast-check は用いない）。
//
// 検査する不変点:
//   (a) core 無変更 — 計装は src/shell・src/observe・tools/observe のみに存在し、src/core に
//       計装由来の差分（emitSeam / buildSeamEntry / OBSERVE_DEBUG / 観測 import / console 出力）を
//       一切持ち込まない（要件4.5 / 9.5）。
//   (b) 4 継ぎ目限定 — shell の emitSeam 呼び出しはちょうど 4 点（construct / rehydrate / alarm /
//       broadcast）であり、それ以外の箇所から出力しない（要件4.9）。
//   (c) hibernation 規律 — shell に秒読み目的の setInterval／終端のない setTimeout を持たず、
//       ctx.acceptWebSocket による hibernate 可能構成を維持する（要件4.7）。
//   (d) 既存ワイヤ形式のみ — Probe_Client は src/domain/messages.ts の既存型を用い、新しい
//       メッセージ種別やフィールドを定義しない（要件9.6）。
//   (e) 英語のみ — CLI（tools/observe）のユーザー向け文字列に日本語を含めない（要件9.4）。
//
// 検査は実コードに対して行う。コメント（日本語可）と文字列リテラルは検査ごとに使い分ける——
// トークン計数（emitSeam / setInterval 等）はコメント・文字列の両方を除いた実コードに対して行い、
// 文字列内容を見る検査（seam 種別・日本語混入・type 種別）はコメントのみ除いて文字列を残す。

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

/** DO シェル。計装の唯一の作用点（emitSeam の 4 継ぎ目）。 */
const SHELL_FILE = "src/shell/store-timer-do.ts";

/** Probe_Client 本体（観測クライアントの端）。既存ワイヤ形式のみを用いる対象。 */
const PROBE_FILE = "tools/observe/probe.ts";

/** 計装の在処を許す唯一のディレクトリ群（要件4.5 / 9.5）。 */
const INSTRUMENTATION_DIRS = ["src/shell", "src/observe", "tools/observe"] as const;

/**
 * 計装の在処を表すマーカー。これらが現れるファイルは INSTRUMENTATION_DIRS 配下に限られる。
 *  - emitSeam        : shell の唯一の作用点。
 *  - buildSeamEntry  : 計装 entry の純粋組み立て（src/observe）と shell の呼び出し。
 *  - OBSERVE_DEBUG   : debug flag の env キー（shell）。
 *  - InstrumentationLogEntry : 計装ログ型（src/observe の codec と shell）。
 */
const INSTRUMENTATION_MARKERS = [
  "emitSeam",
  "buildSeamEntry",
  "OBSERVE_DEBUG",
  "InstrumentationLogEntry",
] as const;

/** 既存ワイヤ形式（src/domain/messages.ts）が定める全メッセージ種別。これ以外を導入しない（要件9.6）。
 *  server→client は snapshot 単一表現へ畳んだため snapshot / config / error の 3 種のみ（snapshot-broadcast）。
 *  意味論種別（started / cancelled / boiled / completed / adjusted）は撤去済み。 */
const WIRE_MESSAGE_TYPES = new Set([
  // client → server（ClientMessage）
  "start",
  "cancel",
  "complete",
  "adjust",
  // server → client（ServerMessage・snapshot 単一表現）
  "snapshot",
  "config",
  "error",
]);

/** 日本語（ひらがな・カタカナ・漢字・CJK 記号・半角カナ）の検出。CLI のユーザー向け文字列に現れてはならない。 */
const JAPANESE = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]/;

// ── ソースの正規化（コメント／文字列の除去） ──────────────────────────────────

type Mode = "code" | "line" | "block" | "single" | "double" | "template";

/**
 * TypeScript ソースからコメントと文字列リテラルの両方を除去し、実コードだけを残す。
 *
 * 単純な正規表現では「文字列中の // 」「コメント中の引用符」を取り違えるため、状態を持つ
 * 1 文字走査で行う。トークン計数（emitSeam / setInterval / setTimeout）に用いる——文字列や
 * コメントに同名トークンが現れても誤検出しないため。行構造（改行）は保つ。
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

/**
 * TypeScript ソースからコメントのみ除去し、文字列リテラルは内容ごと残す。
 *
 * 文字列の中身を見る検査（seam 種別リテラル・type 種別リテラル・日本語混入）に用いる。
 * コメント（日本語可）を除くことで、日本語コメントを誤って「日本語混入」と判定しない。
 */
function stripComments(source: string): string {
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
        } else {
          out += ch;
          if (ch === "'") mode = "single";
          else if (ch === '"') mode = "double";
          else if (ch === "`") mode = "template";
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
        out += ch;
        if (ch === "\\") {
          out += next ?? "";
          i += 1;
        } else if (ch === "'") {
          mode = "code";
        }
        break;
      case "double":
        out += ch;
        if (ch === "\\") {
          out += next ?? "";
          i += 1;
        } else if (ch === '"') {
          mode = "code";
        }
        break;
      case "template":
        out += ch;
        if (ch === "\\") {
          out += next ?? "";
          i += 1;
        } else if (ch === "`") {
          mode = "code";
        }
        break;
    }
  }
  return out;
}

// ── ファイル探索・読み込みヘルパー ────────────────────────────────────────────

/** repoRoot からの相対パス（posix 区切り）で `.ts` ファイルを再帰収集する。 */
function collectTsFiles(relativeDir: string): readonly string[] {
  const absolute = resolve(repoRoot, relativeDir);
  const found: string[] = [];
  for (const dirent of readdirSync(absolute, { withFileTypes: true })) {
    const childAbsolute = resolve(absolute, dirent.name);
    const childRelative = relative(repoRoot, childAbsolute).split(sep).join("/");
    if (dirent.isDirectory()) {
      found.push(...collectTsFiles(childRelative));
    } else if (dirent.isFile() && dirent.name.endsWith(".ts")) {
      found.push(childRelative);
    }
  }
  return found;
}

/** ファイルを読み、実コードのみ（コメント・文字列除去）へ畳んだテキストを返す。 */
function readBareCode(relativePath: string): string {
  return stripCommentsAndStrings(readFileSync(resolve(repoRoot, relativePath), "utf8"));
}

/** ファイルを読み、コメントのみ除去（文字列は保持）したテキストを返す。 */
function readCodeWithStrings(relativePath: string): string {
  return stripComments(readFileSync(resolve(repoRoot, relativePath), "utf8"));
}

/** 正規表現の全マッチ数を数える。 */
function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

/** 相対パスが許可ディレクトリ群のいずれか配下にあるか。 */
function isWithinInstrumentationDirs(relativePath: string): boolean {
  return INSTRUMENTATION_DIRS.some((dir) => relativePath.startsWith(`${dir}/`));
}

// ── (a) core 無変更・計装は許可ディレクトリのみ（要件4.5 / 9.5） ───────────────

describe("(a) core 無変更・計装は src/shell・src/observe・tools/observe に限定（要件4.5 / 9.5）", () => {
  const coreFiles = collectTsFiles("src/engine");

  it("src/core に計装由来のトークン（emitSeam / buildSeamEntry / OBSERVE_DEBUG / InstrumentationLogEntry）が無い", () => {
    expect(coreFiles.length).toBeGreaterThan(0); // core が空でないこと（探索の健全性）
    for (const file of coreFiles) {
      const code = readBareCode(file);
      for (const marker of INSTRUMENTATION_MARKERS) {
        expect(code, `${file} に計装トークン ${marker} が存在する`).not.toContain(marker);
      }
    }
  });

  it("src/core は観測層（src/observe）を import せず console 出力も持たない", () => {
    for (const file of coreFiles) {
      const code = readBareCode(file);
      expect(code, `${file} が観測層を import している`).not.toMatch(/from\s+["'][^"']*observe[^"']*["']/);
      expect(code, `${file} に console 出力がある`).not.toMatch(/\bconsole\s*\./);
    }
  });

  it("計装トークンを含むファイルは src/shell・src/observe・tools/observe 配下に限られる", () => {
    const scanned = [...collectTsFiles("src"), ...collectTsFiles("tools")];
    for (const file of scanned) {
      const code = readBareCode(file);
      const containsMarker = INSTRUMENTATION_MARKERS.some((marker) => code.includes(marker));
      if (containsMarker) {
        expect(
          isWithinInstrumentationDirs(file),
          `${file} が許可外で計装トークンを含む`,
        ).toBe(true);
      }
    }
  });
});

// ── (b) emitSeam は 4 継ぎ目限定（要件4.9） ───────────────────────────────────

describe("(b) emitSeam の呼び出しは 4 継ぎ目に限定（要件4.9）", () => {
  it("shell の emitSeam 呼び出し（this.emitSeam(...)）はちょうど 4 点", () => {
    const code = readBareCode(SHELL_FILE);
    expect(countMatches(code, /\bthis\.emitSeam\s*\(/g), "emitSeam の呼び出し点が 4 でない").toBe(4);
  });

  it("4 継ぎ目（construct / rehydrate / alarm / broadcast）がそれぞれ 1 回ずつ計装される", () => {
    const code = readCodeWithStrings(SHELL_FILE);
    for (const seam of ["construct", "rehydrate", "alarm", "broadcast"] as const) {
      expect(
        countMatches(code, new RegExp(`seam:\\s*"${seam}"`, "g")),
        `継ぎ目 ${seam} の計装が 1 回でない`,
      ).toBe(1);
    }
  });
});

// ── (c) hibernation 規律を計装で崩さない（要件4.7） ───────────────────────────

describe("(c) shell の hibernation 規律（要件4.7）", () => {
  it("shell に秒読み目的の setInterval を持たない", () => {
    const code = readBareCode(SHELL_FILE);
    expect(code, `${SHELL_FILE} に setInterval が存在する`).not.toMatch(/\bsetInterval\b/);
  });

  it("shell に終端のない setTimeout を持たない（時間管理は Alarm のみ）", () => {
    const code = readBareCode(SHELL_FILE);
    expect(code, `${SHELL_FILE} に setTimeout が存在する`).not.toMatch(/\bsetTimeout\b/);
  });

  it("shell は ctx.acceptWebSocket で WS を収容する（hibernate 可能構成）", () => {
    const code = readBareCode(SHELL_FILE);
    expect(code, `${SHELL_FILE} で acceptWebSocket を使っていない`).toMatch(/\bacceptWebSocket\s*\(/);
  });
});

// ── (d) Probe_Client は既存ワイヤ形式のみ（要件9.6） ──────────────────────────

describe("(d) Probe_Client は src/domain/messages の既存型のみを用いる（要件9.6）", () => {
  it("Probe_Client は src/domain/messages から ClientMessage を import する", () => {
    const code = readCodeWithStrings(PROBE_FILE);
    expect(code, `${PROBE_FILE} が共有メッセージ型を import していない`).toMatch(
      /import[^;]*\bClientMessage\b[^;]*from\s+["'][^"']*domain\/messages["']/,
    );
  });

  it("ハーネス（tools/observe・src/observe）はワイヤ型（ClientMessage / ServerMessage / TimerFact）を再定義しない", () => {
    const harnessFiles = [...collectTsFiles("tools/observe"), ...collectTsFiles("src/observe")];
    for (const file of harnessFiles) {
      const code = readBareCode(file);
      expect(
        code,
        `${file} がワイヤ型を再定義している`,
      ).not.toMatch(/\b(?:type|interface)\s+(?:ClientMessage|ServerMessage|TimerFact)\b/);
    }
  });

  it("tools/observe が構築する message の type は既存ワイヤ種別に限られる（新種別を導入しない）", () => {
    const cliFiles = collectTsFiles("tools/observe");
    const literalPattern = /\btype:\s*"([^"]*)"/g;
    for (const file of cliFiles) {
      const code = readCodeWithStrings(file);
      for (const match of code.matchAll(literalPattern)) {
        const messageType = match[1] as string;
        expect(
          WIRE_MESSAGE_TYPES.has(messageType),
          `${file} が未知のメッセージ種別 "${messageType}" を構築している`,
        ).toBe(true);
      }
    }
  });
});

// ── (e) CLI のユーザー向け文字列は英語のみ（要件9.4） ─────────────────────────

describe("(e) CLI（tools/observe）のユーザー向け文字列に日本語を含めない（要件9.4）", () => {
  it("tools/observe の文字列リテラルに日本語（ひらがな・カタカナ・漢字）が現れない", () => {
    const cliFiles = collectTsFiles("tools/observe");
    expect(cliFiles.length).toBeGreaterThan(0); // CLI が空でないこと（探索の健全性）
    for (const file of cliFiles) {
      // コメント（日本語可）を除き、文字列リテラルを残したテキストを検査する。
      const code = readCodeWithStrings(file);
      const match = JAPANESE.exec(code);
      expect(match, `${file} のユーザー向け文字列に日本語 "${match?.[0] ?? ""}" が含まれる`).toBeNull();
    }
  });
});
