// tests/per-store-provisioning.static.test.ts — 撤去・不変・漏洩不能の静的検査（タスク7.3・Smoke）。
//
// per-store-provisioning が拠って立つ「禁則」と「不変点」のうち、振る舞いテストでは捉えにくいものを
// ソーステキストの直接検査（node:fs でソースを読む）で守る。検査は実ファイルの内容に対して行い、
// git 差分ではなく「いま存在するソースが制約を満たすか」を構造として検証する。検査する不変点は次の (a)〜(f):
//
//   (a) Timer 契約の不変 — src/engine・src/domain の Timer 契約が変わっていないこと。TimerFact が既知の
//       5 事実フィールド（id / slotIds / noodleType / firmness / startTime / endTime）を宣言し続け、
//       StoreConfig 型と検証関数（toUnitCount / toArms / toToleranceRatio / toNoodlePresets）が存置される
//       こと（要件9.1 / 9.2）。
//   (b) ワイヤに Roster を出さない — src/domain/messages.ts の ServerMessage が snapshot / config / error の
//       3 種のみで、Roster を表現するフィールド（roster）を一切持たないこと（要件5.3）。
//   (c) 具現空間に階層が漏れない — StoreProjection（src/registry/projection.ts）が config / roster / active /
//       version の 4 フィールドのみを持ち、StoreTimerDO（src/shell/store-timer-do.ts）の永続・ワイヤに
//       chain / policy / priority の概念が現れないこと（要件6.5）。
//   (d) シードの撤去 — DEFAULT_STORE_ID・STORE_* シード（STORE_UNIT_COUNT / STORE_ARMS /
//       STORE_TOLERANCE_RATIO / STORE_NOODLE_PRESETS）がコードとして src/ に存在しないこと（要件9.3）。
//       コメント内の言及（要件対応の説明）は実コードではないため除外する。
//   (e) KV API のみ — src/ 全体で ctx.storage.sql を使わないこと（tooling・SQLite バックエンド＋非同期 KV）。
//   (f) レジストリ純粋層の純粋性 — src/registry/ の全ファイルが cloudflare:workers・storage を import しない
//       純粋モジュールであること（計算と作用の分離）。
//
// 検査は実コードに対して行う。コメント（日本語可・要件対応の説明で禁則トークンを含みうる）と文字列
// リテラルは誤検出の元なので、トークンの有無を見る検査では走査前に両方を除去する。型のフィールド名や
// 種別リテラルを見る検査ではコメントのみ除去して文字列を残す。

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// ── 不変点の対象ファイル ─────────────────────────────────────────────────────

/** Timer という事実の芯（両者共有・変更なし）。 */
const TIMER_FILE = "src/domain/timer.ts";
/** 店舗設定の型と検証関数（再利用・変更なし）。 */
const STORE_FILE = "src/domain/store.ts";
/** ワイヤ形式の正本。ServerMessage に Roster を足さない（要件5.3）。 */
const MESSAGES_FILE = "src/domain/messages.ts";
/** 投影の型。config + roster + active + version のみ（要件6.5）。 */
const PROJECTION_FILE = "src/registry/projection.ts";
/** 店舗 DO シェル。階層（chain / policy / priority）を一切保持しない（要件6.5）。 */
const STORE_TIMER_DO_FILE = "src/shell/store-timer-do.ts";

/** env シード撤去（要件9.3）で src/ から消えているべきトークン。 */
const FORBIDDEN_SEED_TOKENS = [
  "DEFAULT_STORE_ID",
  "STORE_UNIT_COUNT",
  "STORE_ARMS",
  "STORE_TOLERANCE_RATIO",
  "STORE_NOODLE_PRESETS",
] as const;

// ── ソースの正規化（コメント／文字列の分離） ─────────────────────────────────

type Mode = "code" | "line" | "block" | "single" | "double" | "template";

/**
 * TypeScript ソースからコメントと文字列リテラルの両方を除去し、実コードだけを残す。
 *
 * 単純な正規表現では「文字列中の // 」「コメント中の引用符」を取り違えるため、状態を持つ 1 文字走査で
 * 行う。トークンの有無を見る検査に用いる（コメント・文字列に同名トークンが現れても誤検出しない）。
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
 * 型のフィールド名・種別リテラルを見る検査（ServerMessage の種別・StoreProjection のフィールド）に用いる。
 * コメント（日本語可）を除くことで、要件対応の説明に含まれる語を誤検出しない。
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

/** src/ 全体の .ts / .tsx ソース。撤去・KV API 検査の走査対象。 */
const ALL_SRC_FILES = collectSourceFiles("src");

/** src/registry/ の全ファイル。純粋性検査の対象。 */
const REGISTRY_FILES = collectSourceFiles("src/registry");

// ── (a) Timer 契約の不変（要件9.1 / 9.2） ─────────────────────────────────────

describe("(a) src/engine・src/domain の Timer 契約が不変（要件9.1 / 9.2）", () => {
  it("TimerFact が既知の 5 事実フィールドを宣言し続ける", () => {
    const code = readBareCode(TIMER_FILE);
    // 芯の宣言（interface TimerFact）が存置され、事実フィールドが漏れなく宣言されていること。
    expect(code, `${TIMER_FILE} に TimerFact の宣言が無い`).toMatch(/\binterface\s+TimerFact\b/);
    for (const field of ["id", "slotIds", "noodleType", "firmness", "startTime", "endTime"]) {
      expect(code, `${TIMER_FILE} で TimerFact のフィールド ${field} が宣言されていない`).toMatch(
        new RegExp(`\\breadonly\\s+${field}\\b`),
      );
    }
  });

  it("StoreConfig 型と検証関数（to*）が存置される（再利用・要件9.2）", () => {
    const code = readBareCode(STORE_FILE);
    expect(code, `${STORE_FILE} に StoreConfig の宣言が無い`).toMatch(
      /\binterface\s+StoreConfig\b/,
    );
    for (const validator of ["toUnitCount", "toArms", "toToleranceRatio", "toNoodlePresets"]) {
      expect(code, `${STORE_FILE} で検証関数 ${validator} が存置されていない`).toMatch(
        new RegExp(`\\bexport\\s+function\\s+${validator}\\b`),
      );
    }
  });

  it("StoreConfig が既知の 4 フィールドを宣言し続ける", () => {
    const code = readBareCode(STORE_FILE);
    for (const field of ["unitCount", "arms", "toleranceRatio", "noodlePresets"]) {
      expect(code, `${STORE_FILE} で StoreConfig のフィールド ${field} が宣言されていない`).toMatch(
        new RegExp(`\\breadonly\\s+${field}\\b`),
      );
    }
  });
});

// ── (b) ServerMessage に Roster を表現するフィールドが無い（要件5.3） ───────────

describe("(b) ServerMessage に Roster を表現するフィールドが無い（要件5.3）", () => {
  it("ServerMessage の種別リテラルが snapshot / config / error の 3 種のみ", () => {
    const code = readCodeWithStrings(MESSAGES_FILE);
    const found = new Set<string>();
    for (const match of code.matchAll(/\btype:\s*"([^"]+)"/g)) {
      const messageType = match[1];
      if (messageType !== undefined) found.add(messageType);
    }
    // ClientMessage（start / startOrderItem / cancel / complete / adjust）と ServerMessage
    // （snapshot / config / error）の全種別。Roster を運ぶ新種別が混入していないことを確認する。
    expect(found).toEqual(
      new Set([
        "start",
        "startOrderItem",
        "cancel",
        "complete",
        "adjust",
        "snapshot",
        "config",
        "error",
      ]),
    );
  });

  it("messages.ts に roster を表現するフィールド・語が現れない", () => {
    const code = readCodeWithStrings(MESSAGES_FILE);
    expect(code, `${MESSAGES_FILE} に roster が現れる（ワイヤへの Roster 漏洩）`).not.toMatch(
      /\broster\b/i,
    );
  });
});

// ── (c) 具現空間（投影・店舗 DO）に階層が漏れない（要件6.5） ────────────────────

describe("(c) StoreProjection・StoreTimerDO の永続・ワイヤに chain / policy / priority が無い（要件6.5）", () => {
  it("StoreProjection は config / roster / active / version の 4 フィールドのみを持つ", () => {
    const code = readCodeWithStrings(PROJECTION_FILE);
    const start = code.indexOf("interface StoreProjection");
    expect(start, `${PROJECTION_FILE} に StoreProjection の宣言が無い`).toBeGreaterThanOrEqual(0);
    const open = code.indexOf("{", start);
    const close = code.indexOf("}", open);
    expect(close, `${PROJECTION_FILE} の StoreProjection 本体が閉じていない`).toBeGreaterThan(open);
    const body = code.slice(open + 1, close);
    const fields = [...body.matchAll(/\breadonly\s+(\w+)\b/g)].map((m) => m[1]);
    expect(new Set(fields)).toEqual(new Set(["config", "roster", "active", "version"]));
  });

  it("StoreProjection は chain / policy / priority の概念を持たない", () => {
    const code = readBareCode(PROJECTION_FILE);
    expect(code, `${PROJECTION_FILE} に階層概念（chain/policy/priority）が漏れている`).not.toMatch(
      /\b(?:chain|policy|priority)\b/i,
    );
  });

  it("StoreTimerDO の実コードに chain / policy / priority が現れない", () => {
    const code = readBareCode(STORE_TIMER_DO_FILE);
    expect(
      code,
      `${STORE_TIMER_DO_FILE} に階層概念（chain/policy/priority）が漏れている`,
    ).not.toMatch(/\b(?:chain|policy|priority)\b/i);
  });
});

// ── (d) DEFAULT_STORE_ID・STORE_* シードがコードに不在（要件9.3） ────────────────

describe("(d) DEFAULT_STORE_ID・STORE_* シードがコードに不在（要件9.3）", () => {
  it("src/ の実コードに撤去済みシードトークンが現れない（コメントの言及は除外）", () => {
    for (const file of ALL_SRC_FILES) {
      const code = readBareCode(file);
      for (const token of FORBIDDEN_SEED_TOKENS) {
        expect(
          code,
          `${file} に撤去済みシードトークン ${token} が実コードとして現れる`,
        ).not.toContain(token);
      }
    }
  });
});

// ── (e) ctx.storage.sql 不使用（tooling） ─────────────────────────────────────

describe("(e) src/ 全体で ctx.storage.sql を使わない（tooling・KV API のみ）", () => {
  it("src/ の実コードに storage.sql が現れない", () => {
    for (const file of ALL_SRC_FILES) {
      const code = readBareCode(file);
      expect(code, `${file} で storage.sql を使っている`).not.toMatch(/storage\s*\.\s*sql\b/);
    }
  });
});

// ── (f) src/registry/ が cloudflare:workers・storage を import しない純粋性 ──────

describe("(f) src/registry/ が cloudflare:workers・storage を import しない（純粋性）", () => {
  it("registry ファイルの探索が健全（空でない）", () => {
    expect(REGISTRY_FILES.length).toBeGreaterThan(0);
  });

  it("src/registry/ の全ファイルが cloudflare:workers を import しない", () => {
    for (const file of REGISTRY_FILES) {
      const code = readBareCode(file);
      expect(code, `${file} が cloudflare:workers に依存している`).not.toMatch(
        /cloudflare:workers/,
      );
    }
  });

  it("src/registry/ の全ファイルが storage / DurableObject に触れない（作用の端は shell）", () => {
    for (const file of REGISTRY_FILES) {
      const code = readBareCode(file);
      expect(code, `${file} が storage を参照している`).not.toMatch(/\bstorage\s*\./);
      expect(code, `${file} が DurableObject を参照している`).not.toMatch(/\bDurableObject\b/);
    }
  });
});
