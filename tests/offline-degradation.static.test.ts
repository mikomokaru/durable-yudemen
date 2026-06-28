// tests/offline-degradation.static.test.ts — オフライン劣化の構造制約を守るソース静的検査（タスク13.1）。
//
// 本機能（offline-degradation）が拠って立つ不変点のうち、振る舞いテストでは捉えにくい「禁則」を
// ソーステキストの直接検査で守る。検査は実ファイルの内容を読み込んで行う（git 差分には依存せず、
// 「いま存在するソースが制約を満たすか」を構造として検証する）。検査する不変点は次の (a)〜(f):
//
//   (a) core 無変更・shell 一点 — src/engine/ にオフライン劣化由来の差分（auto-response / heartbeat /
//       client 結合）が無く、変更が src/client/ と src/shell/store-timer-do.ts の
//       setWebSocketAutoResponse 一点のみであること（要件12.1）。
//   (b) ワイヤ形式不変 — src/domain/messages.ts の既存メッセージ種別のみを用い、新種別・新フィールド
//       （ping/pong 等）を導入しないこと。client はワイヤ型を再定義しないこと（要件12.2）。
//   (c) UI は窓口経由 — UI（App / components）が Socket / WebSocket / Connectivity_Watch を直接持たず、
//       TimerConnection（Sync_Mediator＝唯一の窓口）のみを介すること（要件4.4）。
//   (d) 永続は Persistence_Port 経由 — localStorage は ViewStore（persistence.ts）の一点に閉じ込め、
//       IndexedDB / Background Sync に依存しないこと（要件4.7 / 11.4）。
//   (e) decideView は純粋 — クライアント純粋遷移層（mode / decideView / 各畳み込み / dueLocalTimers /
//       reconcileServerConfirmed）が WS / DOM / 時計 / 乱数 / localStorage を一切参照しないこと（要件4.3）。
//   (f) 英語 UI・日本語コメント — ユーザー向け画面コンテンツ（文字列・JSX）が英語で、コードコメントが
//       日本語で記述されること（要件13.6）。
//
// 検査は実コードに対して行う。コメント（日本語可）と文字列リテラルは検査ごとに使い分ける——
// トークンの有無を見る検査はコメント・文字列の両方を除いた実コードに対して行い、文字列内容を見る検査
// （英語 UI・ワイヤ種別リテラル）はコメントのみ除いて文字列を残す。コメント内容を見る検査（日本語
// コメント）はコメントのみを抽出する。

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

/** DO シェル。オフライン劣化が許す唯一の追加点（setWebSocketAutoResponse）を持つ。 */
const SHELL_FILE = "src/shell/store-timer-do.ts";

/** ワイヤ形式の正本。client と core が共有する（要件12.2）。 */
const MESSAGES_FILE = "src/domain/messages.ts";

/** 心拍フレームの確定値（素の文字列。ワイヤ型ではない）。 */
const HEARTBEAT_FILE = "src/transport/heartbeat.ts";

/** クライアント純粋遷移層を含むファイル。decideView ほか純粋関数の在処。 */
const CONNECTION_FILE = "src/client/connection.ts";

/** Persistence_Port（ViewStore）の在処。localStorage に触れてよい唯一の client ファイル。 */
const PERSISTENCE_FILE = "src/client/persistence.ts";

/** core が持つべき純粋変換ファイルの確定集合（ここに増減があれば core が触られた証跡）。 */
const EXPECTED_CORE_FILES = [
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

/** 既存ワイヤ形式（messages.ts）が定める全メッセージ種別。これ以外を導入しない（要件12.2）。 */
const WIRE_MESSAGE_TYPES = new Set(["start", "cancel", "snapshot", "started", "cancelled", "done", "error"]);

/** 日本語（ひらがな・カタカナ・漢字・CJK 記号・半角カナ）の検出。 */
const JAPANESE = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]/;

// ── ソースの正規化（コメント／文字列の分離） ─────────────────────────────────

type Mode = "code" | "line" | "block" | "single" | "double" | "template";

/**
 * TypeScript ソースからコメントと文字列リテラルの両方を除去し、実コードだけを残す。
 *
 * 単純な正規表現では「文字列中の // 」「コメント中の引用符」を取り違えるため、状態を持つ 1 文字走査で
 * 行う。トークンの有無を数える検査に用いる（文字列・コメントに同名トークンが現れても誤検出しない）。
 * 行構造（改行）は保つ。
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
 * 文字列の中身を見る検査（ワイヤ種別リテラル・英語 UI 判定）に用いる。コメント（日本語可）を除くことで、
 * 日本語コメントを誤って「日本語混入」と判定しない。
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

/**
 * TypeScript ソースからコメント部分だけを抽出する（実コード・文字列は捨てる）。
 *
 * 「コードコメントが日本語で記述される」（要件13.6）を検査するために、コメント本文のみを取り出す。
 */
function extractComments(source: string): string {
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
        }
        break;
      case "line":
        if (ch === "\n") mode = "code";
        else out += ch;
        break;
      case "block":
        if (ch === "*" && next === "/") {
          mode = "code";
          i += 1;
        } else {
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

/** ファイルを読み、コメントのみ除去（文字列は保持）したテキストを返す。 */
function readCodeWithStrings(relativePath: string): string {
  return stripComments(readFileSync(resolve(repoRoot, relativePath), "utf8"));
}

/** ファイルを読み、コメント本文のみを返す。 */
function readCommentsOnly(relativePath: string): string {
  return extractComments(readFileSync(resolve(repoRoot, relativePath), "utf8"));
}

/** 正規表現の全マッチ数を数える。 */
function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

/** 全 client ソース（src/client 配下の .ts / .tsx）。 */
const CLIENT_FILES = collectSourceFiles("src/client");

/** UI 層のファイル（React の画面コンポーネントとルート）。窓口経由・英語 UI の検査対象。 */
const UI_FILES = CLIENT_FILES.filter(
  (file) => file.endsWith(".tsx") || file.startsWith("src/client/components/"),
);

// ── (a) core 無変更・shell は setWebSocketAutoResponse 一点のみ（要件12.1） ──────

describe("(a) core 無変更・shell は auto-response 一点のみ（要件12.1）", () => {
  it("src/core のファイル集合が確定集合と一致する（オフライン劣化で core にファイルを足していない）", () => {
    expect(collectSourceFiles("src/engine")).toEqual([...EXPECTED_CORE_FILES]);
  });

  it("src/core にオフライン劣化由来のトークン（auto-response / heartbeat / 純粋遷移）が無い", () => {
    const forbidden = [
      "setWebSocketAutoResponse",
      "WebSocketRequestResponsePair",
      "PING_REQUEST",
      "PONG_RESPONSE",
      "watchConnectivity",
      "decideView",
      "openTimerConnection",
    ];
    for (const file of EXPECTED_CORE_FILES) {
      const code = readBareCode(file);
      for (const token of forbidden) {
        expect(code, `${file} にオフライン劣化トークン ${token} が存在する`).not.toContain(token);
      }
    }
  });

  it("src/core は client / shell / heartbeat を一切 import しない（core の純粋性・結合不在）", () => {
    for (const file of EXPECTED_CORE_FILES) {
      const code = readBareCode(file);
      expect(code, `${file} が client を import している`).not.toMatch(
        /from\s+["'][^"']*\/client[/"']/,
      );
      expect(code, `${file} が shell を import している`).not.toMatch(/from\s+["'][^"']*\/shell[/"']/);
      expect(code, `${file} が heartbeat を import している`).not.toMatch(
        /from\s+["'][^"']*\/heartbeat["']/,
      );
    }
  });

  it("src/shell は store-timer-do.ts ただ一つ（shell へ別ファイルを足していない）", () => {
    expect(collectSourceFiles("src/shell")).toEqual([SHELL_FILE]);
  });

  it("store-timer-do.ts の setWebSocketAutoResponse 呼び出しはちょうど 1 点で、心拍ペアを登録する", () => {
    const code = readBareCode(SHELL_FILE);
    expect(
      countMatches(code, /\bsetWebSocketAutoResponse\s*\(/g),
      "setWebSocketAutoResponse の呼び出し点が 1 でない",
    ).toBe(1);
    // 登録するのは PING_REQUEST → PONG_RESPONSE の心拍ペアただ一つ（client と同一の確定値を共有）。
    expect(code, "auto-response が PING_REQUEST/PONG_RESPONSE のペアを登録していない").toMatch(
      /setWebSocketAutoResponse\s*\(\s*new\s+WebSocketRequestResponsePair\s*\(\s*PING_REQUEST\s*,\s*PONG_RESPONSE\s*\)\s*\)/,
    );
  });

  it("store-timer-do.ts は心拍値を src/transport/heartbeat から取り込み、client を import しない", () => {
    const withStrings = readCodeWithStrings(SHELL_FILE);
    expect(withStrings, "shell が heartbeat の心拍値を import していない").toMatch(
      /import\s*\{[^}]*\bPING_REQUEST\b[^}]*\bPONG_RESPONSE\b[^}]*\}\s*from\s+["'][^"']*\/transport\/heartbeat["']/,
    );
    const bare = readBareCode(SHELL_FILE);
    expect(bare, "shell が client を import している（結合の混入）").not.toMatch(
      /from\s+["'][^"']*\/client[/"']/,
    );
  });
});

// ── (b) ワイヤ形式不変（要件12.2） ────────────────────────────────────────────

describe("(b) src/domain/messages の既存ワイヤ形式のみを用いる（要件12.2）", () => {
  it("messages.ts のメッセージ種別リテラルが既存集合と完全一致する（新種別を導入しない）", () => {
    const code = readCodeWithStrings(MESSAGES_FILE);
    const found = new Set<string>();
    for (const match of code.matchAll(/\btype:\s*"([^"]+)"/g)) {
      const messageType = match[1];
      if (messageType !== undefined) found.add(messageType);
    }
    expect(found).toEqual(WIRE_MESSAGE_TYPES);
  });

  it("messages.ts に心拍（ping/pong）をワイヤ形式として持ち込んでいない", () => {
    const code = readCodeWithStrings(MESSAGES_FILE);
    expect(code, "messages.ts に ping/pong が混入している（ワイヤ形式への新フィールド）").not.toMatch(
      /\b(?:ping|pong)\b/i,
    );
  });

  it("心拍は素の文字列定数であり、messages.ts のワイヤ型に手を加えていない", () => {
    // PING_REQUEST / PONG_RESPONSE は heartbeat.ts の string 定数。messages.ts ではなく独立ファイルに置く。
    const heartbeat = readBareCode(HEARTBEAT_FILE);
    expect(heartbeat, "heartbeat.ts が PING_REQUEST を定義していない").toMatch(
      /export\s+const\s+PING_REQUEST\b/,
    );
    expect(heartbeat, "heartbeat.ts が PONG_RESPONSE を定義していない").toMatch(
      /export\s+const\s+PONG_RESPONSE\b/,
    );
  });

  it("client はワイヤ型（ClientMessage / ServerMessage / TimerFact）を再定義しない", () => {
    for (const file of CLIENT_FILES) {
      const code = readBareCode(file);
      expect(code, `${file} がワイヤ型を再定義している`).not.toMatch(
        /\b(?:type|interface)\s+(?:ClientMessage|ServerMessage|TimerFact)\b/,
      );
    }
  });
});

// ── (c) UI は Sync_Mediator（窓口）のみ経由（要件4.4） ─────────────────────────

describe("(c) UI が Socket を直接持たず TimerConnection（窓口）のみ経由（要件4.4）", () => {
  it("UI ファイルの探索が健全（空でない）", () => {
    expect(UI_FILES.length).toBeGreaterThan(0);
  });

  it("UI は WebSocket / Socket / Connectivity_Watch を直接参照しない", () => {
    for (const file of UI_FILES) {
      const code = readBareCode(file);
      expect(code, `${file} が WebSocket を直接参照している`).not.toMatch(/\bWebSocket\b/);
      expect(code, `${file} が Socket を直接参照している`).not.toMatch(/\bSocket\b/);
      expect(code, `${file} が SocketOpener を直接参照している`).not.toMatch(/\bSocketOpener\b/);
      expect(code, `${file} が watchConnectivity を直接参照している`).not.toMatch(
        /\bwatchConnectivity\b/,
      );
      expect(code, `${file} が connectivity 層を直接 import している`).not.toMatch(
        /from\s+["'][^"']*\/connectivity["']/,
      );
    }
  });

  it("UI のサーバ対話は TimerConnection のメソッド（getView / subscribe / start / cancel）に限る", () => {
    // 窓口（TimerConnection）を介すること。App は openTimerConnection で窓口を開き、子は型のみ受け取る。
    const appCode = readBareCode("src/client/App.tsx");
    expect(appCode, "App が窓口 openTimerConnection を開いていない").toMatch(/\bopenTimerConnection\s*\(/);
  });
});

// ── (d) 永続は Persistence_Port 経由・IndexedDB / Background Sync 不使用（要件4.7 / 11.4） ──

describe("(d) 永続は Persistence_Port 経由で IndexedDB / Background Sync を使わない（要件4.7 / 11.4）", () => {
  it("client は IndexedDB を一切参照しない", () => {
    for (const file of CLIENT_FILES) {
      const code = readBareCode(file);
      expect(code, `${file} が indexedDB を参照している`).not.toMatch(/\bindexedDB\b/);
      expect(code, `${file} が IDB* API を参照している`).not.toMatch(/\bIDB[A-Za-z]*\b/);
    }
  });

  it("client は Background Sync（SyncManager / periodicSync / *.sync.register）を参照しない", () => {
    for (const file of CLIENT_FILES) {
      const code = readBareCode(file);
      expect(code, `${file} が SyncManager を参照している`).not.toMatch(/\bSyncManager\b/);
      expect(code, `${file} が periodicSync を参照している`).not.toMatch(/\bperiodicSync\b/);
      expect(code, `${file} が Background Sync の register を参照している`).not.toMatch(
        /\.\s*sync\s*\.\s*register\s*\(/,
      );
    }
  });

  it("localStorage は Persistence_Port（persistence.ts）の一点に閉じ込められている", () => {
    for (const file of CLIENT_FILES) {
      const code = readBareCode(file);
      if (/\blocalStorage\b/.test(code)) {
        expect(file, `${file} が persistence.ts 以外で localStorage に触れている`).toBe(
          PERSISTENCE_FILE,
        );
      }
    }
    // 念のため Persistence_Port 実装側には localStorage が実在すること（検査の健全性）。
    expect(readBareCode(PERSISTENCE_FILE), "persistence.ts に localStorage 実装が無い").toMatch(
      /\blocalStorage\b/,
    );
  });
});

// ── (e) decideView（純粋遷移層）は WS / DOM / 時計 / 乱数 / localStorage に触れない（要件4.3） ──

describe("(e) クライアント純粋遷移層が暗黙の作用に触れない（要件4.3）", () => {
  /**
   * 純粋遷移層のソース範囲を切り出す。
   *
   * connection.ts は前半が純粋遷移層（mode / decideView / 各畳み込み / dueLocalTimers /
   * reconcileServerConfirmed）、後半が作用の端（Socket 抽象・openTimerConnection）に分かれる。端は
   * Date.now / crypto / WebSocket / setInterval を正当に使うため、純粋層だけを安定アンカーで切り出す。
   *   開始: `export function mode(`（純粋層の先頭）
   *   終了: `export interface Socket`（端の WS 抽象の先頭。ここから下は作用の端）
   */
  function pureTransitionSlice(): string {
    const code = readBareCode(CONNECTION_FILE);
    const start = code.indexOf("export function mode(");
    const end = code.indexOf("export interface Socket");
    expect(start, "純粋層の開始アンカー（export function mode）が見つからない").toBeGreaterThanOrEqual(0);
    expect(end, "純粋層の終了アンカー（export interface Socket）が見つからない").toBeGreaterThan(start);
    return code.slice(start, end);
  }

  it("純粋遷移層は時計（Date.now）に触れない", () => {
    expect(pureTransitionSlice(), "純粋層が Date を参照している").not.toMatch(/\bDate\b/);
  });

  it("純粋遷移層は乱数（crypto / Math.random）に触れない", () => {
    const slice = pureTransitionSlice();
    expect(slice, "純粋層が crypto を参照している").not.toMatch(/\bcrypto\b/);
    expect(slice, "純粋層が Math.random を参照している").not.toMatch(/Math\s*\.\s*random\b/);
  });

  it("純粋遷移層は WS / DOM / 常駐ループ（WebSocket / document / window / setInterval / setTimeout）に触れない", () => {
    const slice = pureTransitionSlice();
    expect(slice, "純粋層が WebSocket を参照している").not.toMatch(/\bWebSocket\b/);
    expect(slice, "純粋層が document を参照している").not.toMatch(/\bdocument\b/);
    expect(slice, "純粋層が window を参照している").not.toMatch(/\bwindow\b/);
    expect(slice, "純粋層が setInterval を参照している").not.toMatch(/\bsetInterval\b/);
    expect(slice, "純粋層が setTimeout を参照している").not.toMatch(/\bsetTimeout\b/);
  });

  it("純粋遷移層は localStorage に触れない", () => {
    expect(pureTransitionSlice(), "純粋層が localStorage を参照している").not.toMatch(/\blocalStorage\b/);
  });
});

// ── (f) 英語 UI・日本語コメント（要件13.6） ───────────────────────────────────

describe("(f) ユーザー向け画面コンテンツは英語・コードコメントは日本語（要件13.6）", () => {
  it("client のユーザー向け文字列・JSX に日本語が現れない（英語 UI）", () => {
    for (const file of CLIENT_FILES) {
      // コメント（日本語可）を除き、文字列リテラル・JSX テキストを残したテキストを検査する。
      const code = readCodeWithStrings(file);
      const match = JAPANESE.exec(code);
      expect(match, `${file} のユーザー向けコンテンツに日本語 "${match?.[0] ?? ""}" が含まれる`).toBeNull();
    }
  });

  it("オフライン劣化の主要 client ファイルのコメントは日本語で記述される", () => {
    const documented = [
      CONNECTION_FILE,
      "src/client/connectivity.ts",
      PERSISTENCE_FILE,
      "src/client/components/slotDisplay.ts",
    ];
    for (const file of documented) {
      const comments = readCommentsOnly(file);
      expect(JAPANESE.test(comments), `${file} のコメントに日本語が無い（コメントは日本語・要件13.6）`).toBe(
        true,
      );
    }
  });
});
