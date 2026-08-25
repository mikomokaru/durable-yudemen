// tests/sync-set-batch-complete.static.test.ts — 一括消し込みの不変点のソース静的検査（タスク5.1・Smoke）。
//
// sync-set-batch-complete は「クライアントに純粋関数を一つ足し、既存 complete の意味を広げるだけ」で
// 成立する。その骨格が守られているかは振る舞いテストでは捉えにくい——ファンアウトは engine へ契約を
// 足しても、UI へ一括専用ボタンを足しても、外から見た結果は同じになりうる。ゆえに「足していないこと」を
// ソーステキストの構造として検査する。
//
// git diff は使わない。ブランチやコミットの状態で結果が変わる検査は CI で意味を失うため、既存
// tests/*.static.test.ts の規約に倣い「いま存在するソースが制約を満たすか」だけを見る（node:fs で
// 実ファイルを読み、期待するシンボルの存在と禁則トークンの不在を確かめる）。検査する不変点は次の (a)〜(d):
//
//   (a) engine / domain / shell に本機能由来の差分が無いこと — TimerFact の 6 フィールド・ClientMessage /
//       ServerMessage の種別集合・engine 公開関数の集合・Effect 種別の集合が増えていないこと、同期計算
//       （synchronize の membership 規律）と発火判定（実効 endTime ≤ now + ε）が不変であること、そして
//       クライアント専用の導出 boiledGroup がサーバ側の三層へ漏れていないこと
//       （要件9.1 / 9.2 / 9.3 / 10.1 / 10.3）。
//   (b) クライアント契約に新種別・新状態が無いこと — ClientEvent の kind 集合が増えず、一括完了が既存
//       LocalComplete の複数回畳み込みで実現され、Boiled_Group が ClientView のフィールドへ昇格していない
//       こと（要件9.4 / 10.3）。
//   (c) UI に差分が無いこと — SlotCard / SlotBoard / slotDisplay が群の存在を知らず、一括のための操作要素・
//       確認ダイアログ・視覚フィードバックを持たず、Complete の操作口が担当スロットの boiled に対してのみ
//       描画され、残滓の提示窓が既存の一点で決まること（要件4.3 / 7.1 / 7.3 / 8.3）。
//   (d) boiledGroup が純粋であること — 取り込み点が connection.ts からの型限定 import ただ一つで、時計・
//       乱数・WS・DOM・localStorage を import も参照もせず、時刻を引数（correctedNow）でのみ受けること
//       （要件9.4 / 10.3）。純粋性は振る舞いテストでは捉えにくい——Date.now を混ぜても、たまたま同じ
//       correctedNow が渡っていればテストは通ってしまう。ゆえに「触れていないこと」を構造として見る。
//
// トークンの有無を見る検査は実コード（コメント・文字列を除去）に対して行う——要件対応を説明する日本語
// コメントには禁則トークンが正当に現れるため、コメントを読めば誤検出する。型のフィールド名・種別リテラル・
// aria-label を見る検査はコメントのみ除去して文字列を残す。
//
// stripCommentsAndStrings / stripComments はここに実装する。同名の関数は既存 5 ファイルに非 export で
// 重複しており import できない（共有 helper への抽出と既存テストの移行は本 spec のスコープ外）。

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// ── 検査対象ファイル ─────────────────────────────────────────────────────────

/** Timer という事実の芯。6 フィールドを変えない（要件10.1）。 */
const TIMER_FILE = "src/domain/timer.ts";
/** ワイヤ形式の正本。complete のファンアウトのみで実現し種別を増やさない（要件10.3）。 */
const MESSAGES_FILE = "src/domain/messages.ts";
/** 作用の記述。Effect 種別を増やさない（要件10.3）。 */
const EFFECT_FILE = "src/engine/effect.ts";
/** 同期計算。アルゴリズムと Sync_Set membership 規律を変えない（要件9.1 / 9.2）。 */
const SYNC_FILE = "src/engine/sync.ts";
/** 一括ドレイン発火。発火判定の基準を変えない（要件9.3）。 */
const FIRE_FILE = "src/engine/fire.ts";
/** クライアント契約と唯一の窓口。complete の意味だけが広がる（要件10.3）。 */
const CONNECTION_FILE = "src/client/connection.ts";
/** 群の再構成（本機能が足す唯一の公開シンボル）。 */
const BOILED_GROUP_FILE = "src/client/boiledGroup.ts";
/** 担当スロット 1 つの表示と操作。Complete の操作口の在処（要件7.1 / 7.3）。 */
const SLOT_CARD_FILE = "src/client/components/SlotCard.tsx";
/** 担当ボード。担当スロットの導出結果からのみ SlotCard を描画する（要件4.3）。 */
const SLOT_BOARD_FILE = "src/client/components/SlotBoard.tsx";
/** 表示状態の導出。群を知らず単一 Timer で消し込み対象を示す（要件7.3 / 8.3）。 */
const SLOT_DISPLAY_FILE = "src/client/components/slotDisplay.ts";

/** UI 3 ファイル。本機能は差分を生じさせない（要件4.3 / 7.1 / 7.3 / 8.3）。 */
const UI_FILES = [SLOT_CARD_FILE, SLOT_BOARD_FILE, SLOT_DISPLAY_FILE] as const;

/**
 * TimerFact の事実フィールド（要件10.1）。id / slotIds / noodleType / firmness / startTime / endTime の 6 つ。
 * 群の識別は実効 endTime の等値のみで行うため、群 id・membership を運ぶフィールドを足さない。
 */
const TIMER_FACT_FIELDS = new Set([
  "id",
  "slotIds",
  "noodleType",
  "firmness",
  "startTime",
  "endTime",
]);

/**
 * ワイヤの全メッセージ種別（ClientMessage 4 種 + ServerMessage 3 種）。
 * complete が在り、一括専用の新種別（completeGroup 等）が無いことをこの集合で固定する（要件10.3）。
 */
const WIRE_MESSAGE_TYPES = new Set([
  "start",
  "cancel",
  "complete",
  "adjust",
  "snapshot",
  "config",
  "error",
]);

/** Effect の全種別。一括のための新しい作用（群の一括除去等）を足さない（要件10.3）。 */
const EFFECT_TYPES = new Set(["Persist", "SetAlarm", "ClearAlarm", "Broadcast", "RequestPlan"]);

/** ClientEvent の全 kind。一括は既存 LocalComplete の複数回畳み込みで実現する（要件10.3）。 */
const CLIENT_EVENT_KINDS = new Set([
  "Server",
  "Reconcile",
  "LocalStart",
  "LocalCancel",
  "LocalComplete",
  "Connectivity",
  "Classify",
  "LocalDone",
  "Tick",
]);

/**
 * engine の公開関数の確定集合（要件10.3）。本機能はここへ 1 つも足さない——一括完了はクライアント側の
 * ファンアウトで完結し、サーバは既存の completeTimer を 1 件ずつ受けるだけである。
 *
 * 他 spec が engine へ正当に公開関数を足したときはこの集合を追随させる（既存
 * tests/offline-degradation.static.test.ts の EXPECTED_CORE_FILES と同じ判断）。追随しても本検査の主張は
 * 弱まらない——群・一括の語彙が engine へ現れないことは下の禁則トークン検査が独立に守る。
 */
const ENGINE_PUBLIC_FUNCTIONS = new Set([
  "adjustTimer",
  "adjustedEndTime",
  "admit",
  "advanceRelease",
  "arriveOrder",
  "arriveRecords",
  "baselineSchedule",
  "cancelOrder",
  "cancelTimer",
  "committedSchedule",
  "completeTimer",
  "consumeOrder",
  "createTimer",
  "decide",
  "digestInput",
  "earliestEndTime",
  "fireDueTimers",
  "fromSnapshot",
  "initialRelease",
  "isNewerSequence",
  "isSamePending",
  "isStale",
  "migrate",
  "nextAlarmEffect",
  "planTargets",
  "receivePlan",
  "recommend",
  "reconcile",
  "refersTo",
  "removeOrder",
  "scoreSchedule",
  "settle",
  "slotDistance",
  "startTimer",
  "synchronize",
  "toCookSchedule",
  "toSnapshot",
  "toWireSnapshot",
  "toWireTimer",
  "upsertOrder",
  "validateStart",
]);

/**
 * 一括完了の語彙。サーバ側の三層（engine / domain / shell）と UI に現れてはならない。
 *
 * boiledGroup はクライアント専用の導出であり、他の候補名はいずれも「群をサーバ契約や UI の概念として
 * 立てた」痕跡である。既存語（boiledAt / SyncSet）を巻き込まないよう完全一致で検査する。
 */
const BATCH_TOKENS = [
  "boiledGroup",
  "BoiledGroup",
  "batchComplete",
  "completeBatch",
  "completeGroup",
  "completeMany",
  "bulkComplete",
] as const;

// ── ソースの正規化（コメント／文字列の分離） ─────────────────────────────────

type Mode = "code" | "line" | "block" | "single" | "double" | "template";

/**
 * TypeScript ソースからコメントと文字列リテラルの両方を除去し、実コードだけを残す。
 *
 * 単純な正規表現では「文字列中の // 」「コメント中の引用符」を取り違えるため、状態を持つ 1 文字走査で
 * 行う。トークンの有無を見る検査に用いる（要件対応を説明するコメントに禁則トークンが現れても誤検出しない）。
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
 * 種別リテラル（type: "complete" / kind: "LocalComplete"）と JSX 属性（aria-label="Complete"）を見る検査に
 * 用いる。コメントを除くことで、要件対応の説明に含まれる語を誤検出しない。
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

/** 正規表現の全マッチ数を数える。 */
function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

/**
 * 2 つのアンカーの間を切り出す（終端アンカーは含まない）。
 *
 * 宣言 1 つ・関数 1 つの範囲に検査を限定するために用いる。アンカーが見つからなければ検査自体が壊れた
 * ことを意味するため、その場で失敗させる（黙って空文字を返せばトートロジーになる）。
 */
function sliceBetween(text: string, from: string, to: string, label: string): string {
  const start = text.indexOf(from);
  expect(start, `${label}: 開始アンカー（${from}）が見つからない`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(to, start + from.length);
  expect(end, `${label}: 終了アンカー（${to}）が見つからない`).toBeGreaterThan(start);
  return text.slice(start, end);
}

/**
 * 宣言ブロック 1 つを切り出す（開始アンカーから、その宣言を閉じる行頭の `}` まで）。
 *
 * sliceBetween は「次の宣言」を終端アンカーに採るが、ファイル末尾の宣言にはその足場が無い。開始位置から
 * 末尾まで slice すれば、後ろに `readonly` フィールドを持つ宣言が増えたとき無関係なフィールドまで数えて
 * 偽陽性で落ちる——検査範囲を宣言ブロックに閉じる。フィールドはインデントされるため、行頭の `}` は宣言の
 * 終端しか指さない。アンカーが欠ければ検査自体が壊れたことを意味するため、その場で失敗させる
 * （sliceBetween と同じ規律。黙って空文字や末尾 1 文字を返せばトートロジーになる）。
 */
function sliceDeclaration(text: string, from: string, label: string): string {
  const start = text.indexOf(from);
  expect(start, `${label}: 宣言（${from}）が見つからない`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n}", start + from.length);
  expect(end, `${label}: 宣言（${from}）を閉じる行頭の } が見つからない`).toBeGreaterThan(start);
  return text.slice(start, end);
}

/** `type: "X"` / `kind: "X"` 形式の種別リテラルを集める。 */
function collectTagLiterals(text: string, tag: "type" | "kind"): ReadonlySet<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(new RegExp(`\\b${tag}:\\s*"([^"]+)"`, "g"))) {
    const literal = match[1];
    if (literal !== undefined) found.add(literal);
  }
  return found;
}

/** サーバ側の三層。本機能の差分がここに一切無いことを検査する。 */
const SERVER_SIDE_FILES = [
  ...collectSourceFiles("src/engine"),
  ...collectSourceFiles("src/domain"),
  ...collectSourceFiles("src/shell"),
];

// ── (a) engine / domain / shell に本機能由来の差分が無い（要件9 / 10.1 / 10.3） ──

describe("(a) engine / domain / shell に一括完了由来の差分が無い（要件9.1 / 9.2 / 9.3 / 10.1 / 10.3）", () => {
  it("走査対象（engine / domain / shell）の探索が健全（空でない）", () => {
    // 以下の禁則検査はファイル集合を回す。集合が空なら全検査が空振りして常に真になるため、ここで足場を確かめる。
    expect(SERVER_SIDE_FILES.length).toBeGreaterThan(0);
  });

  it("TimerFact が 6 事実フィールドのみを宣言する（群 id・membership を足していない・要件10.1）", () => {
    // 群の識別は実効 endTime の等値だけで行う。ゆえに Timer という事実の芯は 1 フィールドも増えない。
    // 数える範囲は TimerFact の宣言ブロックだけに閉じる（TimerFact はファイル末尾の宣言ゆえ
    // sliceBetween の終端アンカーが無く、sliceDeclaration で閉じ波括弧を終端に採る）。
    const declaration = sliceDeclaration(
      readBareCode(TIMER_FILE),
      "export interface TimerFact",
      TIMER_FILE,
    );
    const fields = [...declaration.matchAll(/\breadonly\s+(\w+)\s*:/g)].map((match) => match[1]);
    expect(new Set(fields)).toEqual(TIMER_FACT_FIELDS);
    expect(fields.length, "TimerFact のフィールド数が 6 でない").toBe(TIMER_FACT_FIELDS.size);
  });

  it("ClientMessage / ServerMessage の種別集合が既存 7 種と一致する（complete が在り一括用の新種別が無い・要件10.3）", () => {
    // 一括完了は既存 complete のファンアウトのみで実現する。ワイヤに群を表す種別を持ち込まない。
    const types = collectTagLiterals(readCodeWithStrings(MESSAGES_FILE), "type");
    expect(types).toEqual(WIRE_MESSAGE_TYPES);
    expect(types.has("complete"), "ワイヤから complete が失われている（ファンアウトの足場）").toBe(true);
  });

  it("Effect の種別集合が既存 5 種と一致する（一括のための新しい作用を足していない・要件10.3）", () => {
    const effects = collectTagLiterals(
      sliceBetween(
        readCodeWithStrings(EFFECT_FILE),
        "export type Effect =",
        "export type Outcome",
        EFFECT_FILE,
      ),
      "type",
    );
    expect(effects).toEqual(EFFECT_TYPES);
  });

  it("engine の公開関数集合が確定集合と一致する（engine 公開関数を足していない・要件10.3）", () => {
    const found = new Set<string>();
    for (const file of collectSourceFiles("src/engine")) {
      for (const match of readBareCode(file).matchAll(/\bexport\s+(?:async\s+)?function\s+(\w+)/g)) {
        const name = match[1];
        if (name !== undefined) found.add(name);
      }
    }
    expect(found).toEqual(ENGINE_PUBLIC_FUNCTIONS);
  });

  it("synchronize が存置され、Sync_Set membership 規律（オリジナル endTime 昇順・arms チャンク）が不変（要件9.1 / 9.2）", () => {
    // 群の識別は同期の結果（実効 endTime の一致）を読むだけで、同期の作り方には触れない。
    // membership を決める 2 行——クラスタ内の整列と arms 本ずつのチャンク化——を構造として固定する。
    const code = readBareCode(SYNC_FILE);
    expect(code, `${SYNC_FILE} が synchronize を公開していない`).toMatch(
      /export\s+function\s+synchronize\b/,
    );
    expect(code, "Sync_Set の整列規律（center 昇順・同着 seq 昇順）が変わっている").toMatch(
      /\[\.\.\.cluster\]\s*\.sort\(\s*\(a,\s*b\)\s*=>\s*a\.center\s*-\s*b\.center\s*\|\|\s*a\.seq\s*-\s*b\.seq\s*\)/,
    );
    expect(code, "Sync_Set の arms チャンク化が変わっている").toMatch(
      /for\s*\(\s*let\s+i\s*=\s*0;\s*i\s*<\s*ordered\.length;\s*i\s*\+=\s*armsLimit\s*\)/,
    );
  });

  it("発火判定が実効 endTime ≤ now + ε のまま（要件9.3）", () => {
    // 一括完了は boiled になった後の話であり、boiled になる基準には触れない。閾値の作り方と述語を固定する。
    const code = readBareCode(FIRE_FILE);
    expect(code, "発火の許容窓（now + EPSILON_MS）が変わっている").toMatch(
      /const\s+dueThreshold\s*=\s*\(\s*now\s+as\s+number\s*\)\s*\+\s*EPSILON_MS/,
    );
    expect(code, "発火判定が実効 endTime（adjustedEndTime）≤ dueThreshold でない").toMatch(
      /adjustedEndTime\(t\)\s+as\s+number\)\s*<=\s*dueThreshold/,
    );
  });

  it("engine / domain / shell の実コードに一括完了の語彙が現れない（群はクライアント専用の導出・要件9.4 / 10.3）", () => {
    for (const file of SERVER_SIDE_FILES) {
      const code = readBareCode(file);
      for (const token of BATCH_TOKENS) {
        expect(code, `${file} に一括完了の語彙 ${token} が実コードとして現れる`).not.toContain(token);
      }
    }
  });

  it("engine / domain / shell は src/client を import しない（クライアント専用の導出が漏れていない・要件9.4）", () => {
    // boiledGroup は src/client にしか無い。三層がここを import しない限り、群の概念はサーバへ渡らない。
    // import 元のパスは文字列リテラルゆえ、文字列を残したテキストで検査する（実コードだけに畳むと
    // パスが消えて検査が空振りする）。
    for (const file of SERVER_SIDE_FILES) {
      expect(readCodeWithStrings(file), `${file} が client を import している`).not.toMatch(
        /from\s+["'][^"']*\/client\//,
      );
    }
  });
});

// ── (b) クライアント契約に新種別・新状態が無い（要件9.4 / 10.3） ────────────────

describe("(b) ClientEvent の種別が増えず、群を状態に昇格させない（要件9.4 / 10.3）", () => {
  /** ClientEvent の宣言範囲（次の宣言 EMPTY_VIEW の手前まで）。種別リテラルを見るため文字列を残す。 */
  function clientEventDeclaration(): string {
    return sliceBetween(
      readCodeWithStrings(CONNECTION_FILE),
      "export type ClientEvent =",
      "export const EMPTY_VIEW",
      CONNECTION_FILE,
    );
  }

  it("ClientEvent の kind 集合が既存 9 種と一致する（LocalCompleteGroup 等を足していない・要件10.3）", () => {
    const kinds = collectTagLiterals(clientEventDeclaration(), "kind");
    expect(kinds).toEqual(CLIENT_EVENT_KINDS);
    expect(kinds.has("LocalComplete"), "LocalComplete が失われている（複数回畳み込みの足場）").toBe(true);
  });

  it("complete の端が既存 LocalComplete の複数回畳み込みで一括を実現する（要件10.3）", () => {
    // 群のメンバーを 1 件ずつ既存経路へ流す形であること——新しいイベント種別も、群を運ぶ引数も持たない。
    // update がループ外の 1 回であることも併せて固定する（中間ビューを見せない・要件2.1 の帰結）。
    const complete = sliceBetween(
      readCodeWithStrings(CONNECTION_FILE),
      "complete: (timerId) => {",
      "adjust: (timerId, firmness) => {",
      CONNECTION_FILE,
    );
    expect(complete, "complete が群を再構成していない").toMatch(
      /boiledGroup\(\s*view\s*,\s*timerId\s*,\s*at\s*\+\s*view\.offset\s*\)/,
    );
    expect(complete, "complete がメンバーごとのループを持たない").toMatch(
      /for\s*\(\s*const\s+member\s+of\s+group\s*\)/,
    );
    expect(complete, "複数回畳み込みが既存 LocalComplete でない").toMatch(
      /decideView\(\s*next\s*,\s*\{\s*kind:\s*"LocalComplete"/,
    );
    expect(
      countMatches(complete, /\bdecideView\(/g),
      "complete の畳み込み口が 1 箇所でない（新しい遷移を足した疑い）",
    ).toBe(1);
    expect(complete, "live の送信が既存 complete メッセージでない").toMatch(
      /\{\s*type:\s*"complete"\s*,\s*timerId:\s*member\.id\s*\}/,
    );
    expect(countMatches(complete, /\bupdate\(/g), "update がループ外の 1 回でない").toBe(1);
  });

  it("ClientView が群を状態として持たない（押下ごとの導出値のまま・要件9.4）", () => {
    // Boiled_Group を ClientView のフィールドにすれば、view.timers と群という二つの真実の源が生まれる。
    const declaration = sliceBetween(
      readCodeWithStrings(CONNECTION_FILE),
      "export interface ClientView",
      "export type ClientEvent",
      CONNECTION_FILE,
    );
    expect(declaration, "ClientView に群のフィールドが在る（導出値を状態へ昇格させている）").not.toMatch(
      /\breadonly\s+\w*group\w*\s*:/i,
    );
  });

  it("boiledGroup は関数として押下のたびに呼ばれる（状態ではない・要件9.4）", () => {
    // 呼び先が関数 export であることを両側から確かめる（宣言側と呼び出し側）。
    expect(readBareCode(BOILED_GROUP_FILE), "boiledGroup が関数として export されていない").toMatch(
      /export\s+function\s+boiledGroup\s*\(/,
    );
    expect(readBareCode(CONNECTION_FILE), "connection が boiledGroup を値として import していない").toMatch(
      /import\s*\{\s*boiledGroup\s*\}\s*from/,
    );
  });
});

// ── (c) UI に差分が無い（要件4.3 / 7.1 / 7.3 / 8.3） ───────────────────────────

describe("(c) UI が群を知らず一括専用の操作要素を持たない（要件4.3 / 7.1 / 7.3 / 8.3）", () => {
  it("UI 3 ファイルが群（boiledGroup）を import も参照もしない（要件7.3 / 9.4）", () => {
    // UI は群の存在を知らない。呼び先は connection.complete のままで、その意味だけが広がる。
    for (const file of UI_FILES) {
      const code = readBareCode(file);
      for (const token of BATCH_TOKENS) {
        expect(code, `${file} に一括完了の語彙 ${token} が現れる（UI が群を知っている）`).not.toContain(
          token,
        );
      }
      // import 元のパスは文字列リテラルゆえ、文字列を残したテキストで見る。
      expect(readCodeWithStrings(file), `${file} が boiledGroup を import している`).not.toMatch(
        /from\s+["'][^"']*boiledGroup["']/,
      );
    }
  });

  it("SlotCard の Complete の操作口はちょうど 1 つで、単一 Timer を渡す（要件7.1 / 7.3）", () => {
    const code = readCodeWithStrings(SLOT_CARD_FILE);
    expect(
      countMatches(code, /aria-label="Complete"/g),
      "Complete の操作口が 1 つでない（一括専用の別ボタンを足した疑い）",
    ).toBe(1);
    expect(countMatches(code, /\bonComplete\(/g), "onComplete の呼び出し点が 1 つでない").toBe(1);
    expect(code, "onComplete が単一 Timer を受ける形でない（群を渡している疑い）").toMatch(
      /readonly\s+onComplete:\s*\(slot:\s*number,\s*timer:\s*TimerFact\)\s*=>\s*void/,
    );
    expect(code, "onComplete の呼び出しが単一 Timer でない").toMatch(
      /onComplete\(\s*slot\s*,\s*display\.timer\s*\)/,
    );
  });

  it("SlotCard の Complete は boiled 分岐にのみ描画される（要件7.1）", () => {
    // running に Complete を出さないこと（要件3.3）と同じ構造。呼び出しが isBoiled の真側に居ることを見る。
    const code = readCodeWithStrings(SLOT_CARD_FILE);
    const call = code.indexOf("onComplete(slot,");
    expect(call, "onComplete の呼び出しが見つからない").toBeGreaterThan(0);
    // 開き波括弧まで含めてアンカーする（`{!isBoiled ? (` を `isBoiled ? (` として拾わないため）。
    const branch = code.lastIndexOf("{isBoiled ? (", call);
    expect(branch, "onComplete が isBoiled の三項分岐の中に無い").toBeGreaterThanOrEqual(0);
    expect(
      code.slice(branch, call),
      "onComplete が isBoiled の偽側（boiled でない分岐）に居る",
    ).not.toContain(") : (");
  });

  it("SlotCard に確認ダイアログ・一括であることを示す操作要素が無い（要件7.3）", () => {
    // 一括は既存の単一 Complete が暗黙に担う。新しい操作要素・確認・特別な視覚フィードバックを足さない。
    const code = readCodeWithStrings(SLOT_CARD_FILE);
    for (const forbidden of [
      /\bconfirm\b/i,
      /\bdialog\b/i,
      /\bmodal\b/i,
      /\bbatch\b/i,
      /\bbulk\b/i,
      /\bgroup\b/i,
      /Complete\s+All/i,
      /All\s+at\s+once/i,
    ]) {
      expect(code, `${SLOT_CARD_FILE} に一括用の要素（${String(forbidden)}）が現れる`).not.toMatch(
        forbidden,
      );
    }
  });

  it("SlotBoard は担当スロットの導出結果からのみ SlotCard を描画する（要件4.3）", () => {
    // 操作口の起点は担当ユニット内の boiled スロットに限る。群が担当外へ及ぶことと、操作口が担当内に
    // 限られることは別の関心事であり、後者は「描画元が担当射影の結果だけである」構造で守られる。
    const code = readCodeWithStrings(SLOT_BOARD_FILE);
    expect(code, "SlotBoard が担当射影（assignedSlotDisplays）を経ていない").toMatch(
      /assignedSlotDisplays\(\s*view\s*,\s*units\s*,\s*now\s*\)/,
    );
    expect(countMatches(code, /<SlotCard\b/g), "SlotCard の描画点が 1 つでない").toBe(1);
    expect(
      readBareCode(SLOT_BOARD_FILE),
      "SlotBoard が view.timers を直接読んでいる（担当射影の迂回）",
    ).not.toMatch(/\bview\.timers\b/);
  });

  it("SlotBoard の Complete ハンドラは単一 timerId で窓口を呼ぶだけ（要件7.3）", () => {
    const code = readBareCode(SLOT_BOARD_FILE);
    expect(countMatches(code, /connection\.complete\(/g), "complete の呼び出し点が 1 つでない").toBe(1);
    expect(code, "complete の呼び先が単一 timerId でない").toMatch(
      /connection\.complete\(\s*timer\.id\s*\)/,
    );
  });

  it("残滓の提示窓は既存の一点で決まる（一括用の別窓を持たない・要件8.3）", () => {
    // 一括で除去されたメンバーの残滓も、単一消し込みと同じ窓・同じ条件（idle スロットのみ）で提示する。
    const code = readBareCode(SLOT_BOARD_FILE);
    // 窓の定義は 1 つだけ。別名の第二の窓（一括専用の TTL）を足せばここで落ちる。
    expect(
      countMatches(code, /\bconst\s+\w*TTL\w*\s*=/g),
      "残滓の提示窓の定義点が 1 つでない（一括専用の別窓を足した疑い）",
    ).toBe(1);
    expect(code, "残滓の提示窓が LAST_RESULT_TTL_MS でない").toMatch(
      /\bconst\s+LAST_RESULT_TTL_MS\s*=/,
    );
    expect(code, "残滓の提示条件が既存の窓と一致しない").toMatch(
      /now\s*-\s*recorded\.at\s*<\s*LAST_RESULT_TTL_MS/,
    );
    expect(readCodeWithStrings(SLOT_BOARD_FILE), "残滓の提示が idle スロット限定でない").toMatch(
      /display\.kind\s*===\s*"idle"/,
    );
  });

  it("SlotDisplay は 4 種のままで、boiled は単一 Timer を保持する（要件7.3 / 8.3）", () => {
    const code = readCodeWithStrings(SLOT_DISPLAY_FILE);
    const declaration = sliceBetween(
      code,
      "export type SlotDisplay =",
      "export function assignedSlotDisplays",
      SLOT_DISPLAY_FILE,
    );
    expect(collectTagLiterals(declaration, "kind")).toEqual(
      new Set(["running", "boiled", "idle", "unreceived"]),
    );
    const boiled = sliceBetween(declaration, 'kind: "boiled"', "}", SLOT_DISPLAY_FILE);
    expect(boiled, "boiled が単一 Timer を保持していない").toMatch(/readonly\s+timer:\s*TimerFact/);
    expect(boiled, "boiled が群（複数 Timer）を保持している").not.toMatch(/\breadonly\s+timers\b/);
  });
});

// ── (d) boiledGroup が純粋（要件9.4 / 10.3） ──────────────────────────────────

describe("(d) boiledGroup が暗黙の作用に触れない（要件9.4 / 10.3）", () => {
  /**
   * 純粋性の検査は tests/offline-degradation.static.test.ts の (e)（クライアント純粋遷移層）と同じ規律に
   * 従う——禁則トークンの不在を実コード（コメント・文字列を除去）に対して見る。ただし切り出しは要らない。
   * boiledGroup.ts はファイル全体が純粋層であり、作用の端を同居させない（それが分離の意味である）。
   */
  const bareCode = (): string => readBareCode(BOILED_GROUP_FILE);

  /**
   * 副作用を持つクライアント隣接モジュール。実時刻・接続監視・永続・通知はいずれも端の関心事であり、
   * 群の再構成が触れてよい相手ではない。
   */
  const EFFECTFUL_CLIENT_MODULES = [
    "clock",
    "connectivity",
    "persistence",
    "notification",
    "audio",
    "wakeLock",
  ] as const;

  it("取り込み点がちょうど 1 つで、connection.ts からの型限定 import である（要件9.4）", () => {
    // これが本 describe で最も強い検査である。import が「connection.ts の型 2 つ」ただ一つに固定されれば、
    // 副作用を持つモジュールの取り込みは構造的に不可能になる（下の禁則トークン検査が残りの、グローバル
    // 経由の作用を塞ぐ）。
    //
    // 型限定（import type）であることを構造として固める理由は実行時の循環である。connection.ts は
    // boiledGroup を値として import するため、こちらが値 import を持てば循環が実行時に生じうる。
    // import type は型消去で消えるゆえ循環しない——その保証は「type と書いてある」ことにしか宿らない。
    //
    // import 元のパスは文字列リテラルゆえ、文字列を残したテキストで検査する（実コードだけに畳むとパスが
    // 消えて検査が空振りする）。
    const code = readCodeWithStrings(BOILED_GROUP_FILE);
    const imports = (code.match(/^\s*import\b[^;]*;/gm) ?? []).map((statement) => statement.trim());
    expect(
      imports.length,
      `${BOILED_GROUP_FILE} の import 文が 1 つでない: ${JSON.stringify(imports)}`,
    ).toBe(1);
    expect(imports[0], "唯一の import が connection.ts からの型限定 import でない").toMatch(
      /^import\s+type\s*\{\s*ClientTimer\s*,\s*ClientView\s*\}\s*from\s*"\.\/connection";$/,
    );
    // 再 export（export … from）も第二のモジュールパスを持ち込む。参照するパスは 1 本だけであること。
    expect(
      countMatches(code, /\bfrom\s*["']/g),
      "参照するモジュールパスが 1 本でない（再 export で作用を引き込む余地がある）",
    ).toBe(1);
  });

  it("動的取り込み（import() / require）を持たない（要件9.4）", () => {
    // 静的 import を 1 本に絞っても、実行時に読み込めば同じ穴が開く。純粋関数に遅延読み込みは要らない。
    const code = bareCode();
    expect(code, "動的 import を持っている").not.toMatch(/\bimport\s*\(/);
    expect(code, "require を持っている").not.toMatch(/\brequire\s*\(/);
  });

  it("副作用を持つ隣接モジュール（clock / connectivity / persistence / notification）を import しない（要件9.4）", () => {
    // 上の「import は 1 本」検査から導かれるが、塞いでいる相手を名前で残す。どのモジュールを避けているのか
    // が読めなければ、将来 import を足す人はこの規律の理由に気づけない。
    const code = readCodeWithStrings(BOILED_GROUP_FILE);
    for (const module of EFFECTFUL_CLIENT_MODULES) {
      expect(code, `${BOILED_GROUP_FILE} が ${module} を import している`).not.toMatch(
        new RegExp(`from\\s+["'][^"']*${module}["']`),
      );
    }
  });

  it("時計（Date / performance）に触れない（要件9.4）", () => {
    // 現在時刻は端が now() + view.offset で採り、correctedNow として渡す。ここで実時刻を読めば、同じ
    // 引数に同じ出力という保証が崩れ、群の再構成が押下時刻と別の瞬間を基準にしうる。
    const code = bareCode();
    expect(code, "Date を参照している").not.toMatch(/\bDate\b/);
    expect(code, "performance を参照している").not.toMatch(/\bperformance\b/);
  });

  it("乱数（crypto / Math.random）に触れない（要件9.4）", () => {
    const code = bareCode();
    expect(code, "crypto を参照している").not.toMatch(/\bcrypto\b/);
    expect(code, "Math.random を参照している").not.toMatch(/Math\s*\.\s*random\b/);
  });

  it("WS / DOM / 常駐ループ（WebSocket / document / window / setInterval / setTimeout）に触れない（要件9.4）", () => {
    const code = bareCode();
    expect(code, "WebSocket を参照している").not.toMatch(/\bWebSocket\b/);
    expect(code, "document を参照している").not.toMatch(/\bdocument\b/);
    expect(code, "window を参照している").not.toMatch(/\bwindow\b/);
    expect(code, "setInterval を参照している").not.toMatch(/\bsetInterval\b/);
    expect(code, "setTimeout を参照している").not.toMatch(/\bsetTimeout\b/);
  });

  it("localStorage に触れない（要件9.4）", () => {
    expect(bareCode(), "localStorage を参照している").not.toMatch(/\blocalStorage\b/);
  });

  it("時刻を引数（correctedNow）でのみ受け、判定にそれを用いる（要件9.4）", () => {
    // 「時計に触れない」ことの裏返し。時刻の入口がシグネチャにあり、boiled の関門がその引数で決まる形を
    // 固定する。禁則トークンの不在だけでは、時刻を別経路（引数で受けた view の中の値など）から得る形を
    // 排除できない。
    const code = bareCode();
    expect(code, "boiledGroup のシグネチャが（view, timerId, correctedNow）でない").toMatch(
      /export\s+function\s+boiledGroup\(\s*view:\s*ClientView,\s*timerId:\s*string,\s*correctedNow:\s*number,?\s*\):\s*readonly\s+ClientTimer\[\]/,
    );
    expect(code, "boiled の関門が引数 correctedNow で決まっていない").toMatch(
      /\bendTime\s*>\s*correctedNow\b/,
    );
  });

  it("モジュールスコープに可変状態を持たない（同じ入力に同じ出力・要件9.4）", () => {
    // 群を memo するモジュール変数を置けば、押下ごとに導き直すという規律（要件9.4）が静かに壊れる。
    // 関数内の let は禁じない——壊れるのはモジュールに跨って生き残る状態だけである。
    expect(bareCode(), "モジュールスコープに let / var の宣言が在る").not.toMatch(
      /^(?:let|var)\s/m,
    );
  });
});
