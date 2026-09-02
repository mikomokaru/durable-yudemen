// tests/pending-order-list-left-rail.static.test.ts — 左レール化の配置と出所のソース静的検査（S1〜S15）。
//
// 本 spec が実際に変えるのは配置だけである——レール幅の固定値・スクロールの閉じ込め・色とトークンの
// 出所・インラインスタイルの限定・保持値の不在。これらは実描画では見えない。happy-dom はレイアウトを
// 計算しないため実寸を問えず、色やアニメーションの出所は DOM の見た目では区別できない。ゆえに「ソース
// テキストがその規律を満たすか」だけを見る。
//
// 逆に、実描画で立つ主張（ロール構造・可視文言・accessible name・DOM 順・押下時の引数）はここへ重複
// させない。ソースの字面を見る検査は描画の結果を保証しないのに保証したように見えるため、重複は害である
// （design「Testing Strategy (2)」）。それらは tests/client/order-rail.example.test.tsx が受ける。
//
// git diff は使わない。ブランチやコミットの状態で結果が変わる検査は CI で意味を失うため、既存
// tests/*.static.test.ts の規約に倣い「いま存在するソースが制約を満たすか」だけを見る（node:fs で実
// ファイルを読む）。
//
// 検査するテキストは 2 通りに分かれる。
//
//   - 実コード（コメント・文字列リテラルを除去）: 識別子・引数名・フィールド名を見るもの（S7・S13・S14）。
//     本設計を説明する日本語コメントに禁則の識別子が正当に現れうるため、コメントを読めば誤検出する。
//   - コメントのみ除去（文字列は保持）: ユーティリティクラスと属性値と画面文言を見るもの（S2〜S6・S8〜S12・
//     S15）。クラス名は文字列リテラルの中にしか無く、文字列まで畳むと検査が空振りして常に真になる。
//
// stripCommentsAndStrings / stripComments はここに実装する。同名の関数は既存の静的検査ファイルに非
// export で重複しており import できない（共有 helper への抽出は本 spec のスコープ外）。

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// ── 検査対象ファイル ─────────────────────────────────────────────────────────

/** 待ちオーダーの縦レール。本 spec が組み替える唯一の一覧である。 */
const ORDER_RAIL_FILE = "src/client/components/OrderRail.tsx";
/** 移動前の横帯。改名により存在しないこと自体が「一覧はレールただ 1 箇所」の証跡になる。 */
const ORDER_QUEUE_FILE = "src/client/components/OrderQueue.tsx";
/** 盤面の段組み。下段でレールと釜グリッドを横並びにする。 */
const SLOT_BOARD_FILE = "src/client/components/SlotBoard.tsx";
/** デザイントークンの唯一の出所。アニメーションの集合が変更前と同一であることを見る。 */
const STYLES_FILE = "src/client/styles.css";

/**
 * styles.css の `@keyframes` の全名。レールは新しいアニメーションを定義しない（AC 7.5）。
 * 既存の 2 つ（完了スロットのグロー点滅とバッジの明滅）だけが在る。
 */
const KEYFRAME_NAMES = new Set(["boiledPulse", "badgeBlink"]);

/** styles.css の `--animate-*` トークンの全名。レールは新しいトークンを足さない（AC 7.5）。 */
const ANIMATE_TOKENS = new Set(["--animate-boiled", "--animate-badge-blink"]);

/**
 * レールに現れてはならない保持値・常設タイマー・寸法測定の識別子（AC 6.1 / 6.7 / 6.11）。
 *
 * 表示は Pending_Order 集合・Cook_Recommendation 集合・現在時刻のみからの導出で決まる。秒読みの拍は
 * SlotBoard が既に持っており、レールがそれに相乗りする——ここに拍や参照保持が現れたなら、導出値を状態へ
 * 昇格させた痕跡である。寸法を JS で測る道具（ResizeObserver / matchMedia）も同じ理由で禁じる（幅は
 * 固定値であり、測る対象がない）。
 */
const STATEFUL_TOKENS = [
  "useState",
  "useRef",
  "useEffect",
  "setInterval",
  "setTimeout",
  "ResizeObserver",
  "matchMedia",
] as const;

// ── ソースの正規化（コメント／文字列の分離） ─────────────────────────────────

type Mode = "code" | "line" | "block" | "single" | "double" | "template";

/**
 * TypeScript / TSX ソースからコメントと文字列リテラルの両方を除去し、実コードだけを残す。
 *
 * 単純な正規表現では「文字列中の // 」「コメント中の引用符」を取り違えるため、状態を持つ 1 文字走査で
 * 行う。識別子の不在を見る検査（S7）に用いる。行構造（改行）は保つ。
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
 * TypeScript / TSX ソースからコメントのみ除去し、文字列リテラルは内容ごと残す。
 *
 * ユーティリティクラス（`w-32` / `overflow-y-auto`）と属性値を見る検査に用いる。クラス名は文字列リテラル
 * の中にしか無く、文字列まで畳めば検査が空振りする。コメントを除くことで、設計を説明する日本語の説明文に
 * 含まれる語を誤検出しない。
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

// ── 読み込みヘルパー ─────────────────────────────────────────────────────────

/** ファイルを読み、実コードのみ（コメント・文字列除去）へ畳んだテキストを返す。 */
function readBareCode(relativePath: string): string {
  return stripCommentsAndStrings(readFileSync(resolve(repoRoot, relativePath), "utf8"));
}

/** ファイルを読み、コメントのみ除去（文字列は保持）したテキストを返す。 */
function readCodeWithStrings(relativePath: string): string {
  return stripComments(readFileSync(resolve(repoRoot, relativePath), "utf8"));
}

/** CSS を読み、ブロックコメントを除去したテキストを返す（CSS のコメントはこの 1 種のみ）。 */
function readCss(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * 指定のタグより手前にある、最も近い `<div className="…">` のクラス文字列を返す。
 *
 * 「その要素を包む器」に検査を限定するために用いる。器のクラス文字列を丸ごと固定すれば整形の揺れで壊れ、
 * ファイル全体を見れば別の要素のクラスを巻き込む。アンカーが欠ければ検査自体が壊れたことを意味するため、
 * その場で失敗させる（黙って空文字を返せばトートロジーになる）。
 */
function enclosingDivClassName(code: string, childTag: string, label: string): string {
  const childAt = code.indexOf(childTag);
  expect(childAt, `${label}: ${childTag} が見つからない`).toBeGreaterThanOrEqual(0);
  const openAt = code.lastIndexOf('<div className="', childAt);
  expect(openAt, `${label}: ${childTag} を包む div のクラス指定が見つからない`).toBeGreaterThan(0);
  const from = openAt + '<div className="'.length;
  const end = code.indexOf('"', from);
  expect(end, `${label}: 包む div のクラス文字列が閉じていない`).toBeGreaterThan(from);
  return code.slice(from, end);
}

/** 指定の目印を含むクラス文字列リテラルを 1 つだけ取り出す（複数在れば検査の足場が壊れている）。 */
function classNameContaining(code: string, marker: string, label: string): string {
  const found = [...code.matchAll(/className="([^"]*)"/g)]
    .map((match) => match[1] ?? "")
    .filter((className) => className.includes(marker));
  expect(found.length, `${label}: ${marker} を含む className がちょうど 1 つでない`).toBe(1);
  return found[0] ?? "";
}

// ── S1: 一覧はレールただ 1 箇所（要件1.3） ────────────────────────────────────

describe("S1 一覧の在処がレールただ 1 箇所である（要件1.3）", () => {
  it("OrderRail.tsx が存在し、移動前の OrderQueue.tsx が存在しない", () => {
    // 横帯のファイルが残っていれば、一覧を描く経路が二つ在りうる。改名（＝不在）がその余地を消す。
    expect(existsSync(resolve(repoRoot, ORDER_RAIL_FILE)), `${ORDER_RAIL_FILE} が無い`).toBe(true);
    expect(
      existsSync(resolve(repoRoot, ORDER_QUEUE_FILE)),
      `${ORDER_QUEUE_FILE} が残っている（横帯の実装が撤去されていない）`,
    ).toBe(false);
  });

  it("OrderRail を export する", () => {
    // 下の検査群はこのファイルがレールの実装であることを前提に走る。公開シンボルの在処を同じ検査で
    // 固定し、名が変わったときに空振りさせない。
    expect(
      readBareCode(ORDER_RAIL_FILE),
      `${ORDER_RAIL_FILE} が OrderRail を公開していない`,
    ).toMatch(/export\s+function\s+OrderRail\b/);
  });

  it("SlotBoard が OrderRail だけを一覧として描く（横帯の呼び出しが残っていない）", () => {
    // 一覧を描く経路が一つであることは、レールが描かれていること（正）と横帯が描かれていないこと（負）の
    // 両方で言える。負の側は識別子境界で見る——`orderQueueEntries`（並びと待ち時間の純粋導出）は残る
    // ものであり、部分一致で拾えば正当な import を横帯の残存と誤認する。
    const code = readBareCode(SLOT_BOARD_FILE);
    expect(code, "SlotBoard が OrderRail を描いていない").toContain("<OrderRail");
    expect(code, "SlotBoard に OrderQueue の呼び出しが残っている").not.toMatch(/\bOrderQueue\b/);
  });
});

// ── S2: レール幅は単一の固定値（要件2.1 / 2.2 / 2.8） ─────────────────────────

describe("S2 レール幅が単一の固定値である（要件2.1 / 2.2 / 2.8）", () => {
  it("OrderRail.tsx に w-32 と flex-none が現れる", () => {
    // 8rem（w-32）は AC 2.2 の 80% 下限から導出した値であり、flex-none が Board_Area の幅の変化から
    // レールを切り離す（変化は flex-1 の釜グリッドが吸収する）。
    const code = readCodeWithStrings(ORDER_RAIL_FILE);
    expect(code, "固定幅 w-32 が無い").toMatch(/\bw-32\b/);
    expect(code, "flex-none が無い（幅が伸縮しうる）").toMatch(/\bflex-none\b/);
  });

  it("OrderRail.tsx に幅を Board_Area に比例させる記法が現れない", () => {
    // 分数幅・パーセント幅はいずれも Board_Area の幅を入力にする。AC 2.1 はレール幅がそれによらない
    // 単一の固定値であることを求める。
    const code = readCodeWithStrings(ORDER_RAIL_FILE);
    expect(code, "分数幅（w-1/4 等）が現れる").not.toMatch(/\bw-\d+\/\d+/);
    expect(code, "パーセント幅（w-[…%]）が現れる").not.toMatch(/\bw-\[[^\]]*%/);
  });

  it("OrderRail.tsx に min-w- / max-w- が現れない", () => {
    // 下限・上限は「幅が動く」ことを前提にした記法である。固定値に下限も上限も要らない。
    const code = readCodeWithStrings(ORDER_RAIL_FILE);
    expect(code, "min-w- が現れる").not.toMatch(/\bmin-w-/);
    expect(code, "max-w- が現れる").not.toMatch(/\bmax-w-/);
  });

  it("OrderRail.tsx にブレークポイント変種が現れない", () => {
    // 幅・向きで出し分けないことは確定した判断（requirements「確定した判断」2）である。ブレークポイント
    // 変種が現れたなら、レール幅が画面寸法の関数になっている。
    const code = readCodeWithStrings(ORDER_RAIL_FILE);
    expect(code, "任意ブレークポイント（min-[…]: / max-[…]:）が現れる").not.toMatch(
      /\b(?:min|max)-\[[^\]]*\]:/,
    );
    expect(code, "既定ブレークポイント（sm: / md: 等）が現れる").not.toMatch(
      /\b(?:sm|md|lg|xl|2xl):/,
    );
  });

  it("SlotBoard.tsx の釜グリッドに左 padding（pl-）が現れない", () => {
    // 釜グリッドに左 padding を置くと縦向きで残り時間が非表示時の 79.2% となり AC 2.2 の 80% を割る。
    // 区切りはレール側の pr と border-r が作り、釜カードの幅を 1px も削らない。
    const grid = classNameContaining(
      readCodeWithStrings(SLOT_BOARD_FILE),
      "grid-flow-col",
      SLOT_BOARD_FILE,
    );
    expect(grid, `釜グリッドに左 padding が在る: ${grid}`).not.toMatch(/\bpl-/);
  });
});

// ── S3: レールと釜グリッドの間に gap を挟まない（要件2.7） ────────────────────

describe("S3 横並びの器が gap を持たない（要件2.7）", () => {
  it("SlotBoard.tsx でレールを包む横並びの器に gap- を持つクラスが無い", () => {
    // gap は Board_Area の幅からレール幅を差し引いた残りをさらに削る。AC 2.7 は残り全量を釜グリッドへ
    // 与えることを求めるため、器に gap を置かない（区切りはレール側の pr と border-r が作る）。
    const row = enclosingDivClassName(
      readCodeWithStrings(SLOT_BOARD_FILE),
      "<OrderRail",
      SLOT_BOARD_FILE,
    );
    expect(row, `横並びの器に gap- が在る: ${row}`).not.toMatch(/\bgap-/);
  });
});

// ── S4: 溢れは自領域の縦スクロールだけで受ける（要件3.4 / 4.1 / 4.2 / 4.6） ───

describe("S4 溢れを自領域の縦スクロールに閉じる（要件3.4 / 4.1 / 4.2 / 4.6）", () => {
  it("OrderRail.tsx に overflow-y-auto / overflow-x-hidden / overscroll-contain が現れる", () => {
    // 縦スクロールで全件へ到達でき（AC 4.1）、その連鎖が Board_Area と Timer_Screen へ波及しない
    // （AC 4.2 / 4.6）。波及の遮断は overscroll-contain が担う。
    const code = readCodeWithStrings(ORDER_RAIL_FILE);
    expect(code, "縦スクロールが無い（末尾の行へ到達できない）").toMatch(/\boverflow-y-auto\b/);
    expect(code, "overflow-x-hidden が無い（横方向の溢れが漏れうる）").toMatch(
      /\boverflow-x-hidden\b/,
    );
    expect(code, "overscroll-contain が無い（スクロールが親へ波及しうる）").toMatch(
      /\boverscroll-contain\b/,
    );
  });

  it("OrderRail.tsx に overflow-x-auto が現れない", () => {
    // 横スクロールは移動前の横帯の性質そのものである。可視件数を縦へ変換した以上、横へ逃げる余地を残さない
    // （AC 3.4）。
    expect(
      readCodeWithStrings(ORDER_RAIL_FILE),
      "横スクロール（overflow-x-auto）が残っている",
    ).not.toMatch(/\boverflow-x-auto\b/);
  });
});

// ── S5: 色の出所はトークンと麺種色の resolver だけ（要件7.1） ─────────────────

describe("S5 色値リテラルを持たない（要件7.1）", () => {
  it("OrderRail.tsx に色値リテラル（# 16 進 / rgb( / hsl( / oklch(）が現れない", () => {
    // 色は @theme のトークン由来のユーティリティか、麺種色の resolver（noodleColor prop）からしか来ない。
    // リテラルが現れたなら、色の出所が増えて一箇所を触って全体を直せなくなる。
    const code = readCodeWithStrings(ORDER_RAIL_FILE);
    expect(code, "16 進の色値が現れる").not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(code, "rgb( の色値が現れる").not.toMatch(/\brgba?\(/);
    expect(code, "hsl( の色値が現れる").not.toMatch(/\bhsla?\(/);
    expect(code, "oklch( の色値が現れる").not.toMatch(/\boklch\(/);
  });
});

// ── S6: インラインスタイルは麺種色 1 つに限る（要件7.2） ──────────────────────

describe("S6 インラインスタイルが麺種色 1 つに限られる（要件7.2）", () => {
  /** `style={{ … }}` の中身（プロパティ列）をすべて取り出す。 */
  function inlineStyleObjects(code: string): readonly string[] {
    const found: string[] = [];
    for (const match of code.matchAll(/style=\{\{/g)) {
      const start = (match.index ?? -1) + match[0].length;
      expect(start, `${ORDER_RAIL_FILE}: style={{ の位置が取れない`).toBeGreaterThan(0);
      const end = code.indexOf("}}", start);
      expect(end, `${ORDER_RAIL_FILE}: style={{ を閉じる }} が無い`).toBeGreaterThan(start);
      found.push(code.slice(start, end));
    }
    return found;
  }

  it("OrderRail.tsx の style={{ … }} が 1 箇所のみで、そのプロパティが color だけである", () => {
    // 余白・寸法・文字寸法・枠線・影・レイアウト・フォントはすべてユーティリティクラスで与える。
    // インラインが増えるほど、デザインシステムの外に第二の出所が生まれる。
    const objects = inlineStyleObjects(readCodeWithStrings(ORDER_RAIL_FILE));
    expect(objects.length, "インラインスタイルが 1 箇所でない").toBe(1);
    const properties = [...(objects[0] ?? "").matchAll(/(\w+)\s*:/g)].map((match) => match[1]);
    expect(properties, `インラインスタイルのプロパティが color だけでない: ${objects[0]}`).toEqual([
      "color",
    ]);
  });
});

// ── S7: 新しい保持値・常設タイマー・寸法測定を持たない（要件6.1 / 6.7 / 6.11） ─

describe("S7 新しい保持値・常設タイマー・寸法測定を持たない（要件6.1 / 6.7 / 6.11）", () => {
  it("OrderRail.tsx に useState / useRef / useEffect / setInterval / setTimeout / ResizeObserver / matchMedia が現れない", () => {
    // 表示は Pending_Order 集合・Cook_Recommendation 集合・現在時刻のみからの導出で決まる（AC 6.1）。
    // 待ち時間の再算出は SlotBoard の既存 1 秒の拍に相乗りし、レール専用の拍を持たない（AC 6.7）。
    // スクロール位置は DOM が持つ事実であり、React state へ昇格させない（AC 6.11）。
    const code = readBareCode(ORDER_RAIL_FILE);
    for (const token of STATEFUL_TOKENS) {
      expect(code, `${ORDER_RAIL_FILE} に ${token} が実コードとして現れる`).not.toContain(token);
    }
  });
});

// ── S8: アニメーションを足さない（要件7.5） ──────────────────────────────────

describe("S8 アニメーションを足さない（要件7.5）", () => {
  it("OrderRail.tsx に transition- / animate- / @keyframes が現れない", () => {
    // 行の出現・消滅・並べ替え・スクロールに遷移効果を付けない。既存の点滅・グロー（animate-boiled /
    // animate-badge-blink）は釜カードの状態を語る記号であり、レールに用いれば意味が二重になる。
    const code = readCodeWithStrings(ORDER_RAIL_FILE);
    expect(code, "遷移効果（transition-）が現れる").not.toMatch(/\btransition-/);
    expect(code, "アニメーション（animate-）が現れる").not.toMatch(/\banimate-/);
    expect(code, "@keyframes の定義が現れる").not.toContain("@keyframes");
  });

  it("styles.css の @keyframes と --animate-* の集合が変更前と同一である", () => {
    // 新しいトークンを足していないことの検査であり、既存の値には触れない。styles.css 自体が本 spec の
    // 「触らないもの」であるため、集合の一致がそのまま差分の不在を示す。
    const css = readCss(STYLES_FILE);
    const keyframes = new Set(
      [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => match[1] ?? ""),
    );
    expect(keyframes, "@keyframes の集合が変更前と一致しない").toEqual(KEYFRAME_NAMES);
    const tokens = new Set(
      [...css.matchAll(/(--animate-[\w-]+)\s*:/g)].map((match) => match[1] ?? ""),
    );
    expect(tokens, "--animate-* トークンの集合が変更前と一致しない").toEqual(ANIMATE_TOKENS);
  });
});

// ── S9: 提案の可触寸法に下限がある（要件5.1） ─────────────────────────────────

describe("S9 提案の可触領域に下限がある（要件5.1）", () => {
  it("OrderRail.tsx に min-h-[2.75rem] が現れる", () => {
    // 濡れた手・急ぎの手で狙いを外せば、間違った釜が動く。3 行に積んだ実高は 50.5px で 44px を上回るが、
    // それは字寸と行間の積に過ぎない——下限そのものを 1 つのクラスで表明しておけば、行数や字寸を触った
    // ときに高さが 44px を割らない。幅は w-full が行の内容幅（87〜92px）を占めるため、算術で足りる。
    expect(
      readCodeWithStrings(ORDER_RAIL_FILE),
      "min-h-[2.75rem] が無い（提案の可触高さの下限が表明されていない）",
    ).toContain("min-h-[2.75rem]");
  });
});

// ── S10: 文字寸法の下限（要件3.6） ────────────────────────────────────────────

/** レールに置ける最小の文字寸法（rem）。麺種を除く 3 つの事実の下限であり、レールの語もこれに揃える。 */
const MIN_TEXT_REM = 0.6875;

describe("S10 文字寸法が下限を下回らない（要件3.6）", () => {
  /** `text-[…]` の任意値に現れる rem 値をすべて拾う（clamp の内側の値も個別に見る）。 */
  function arbitraryTextRems(code: string): readonly number[] {
    const found: number[] = [];
    for (const arbitrary of code.matchAll(/\btext-\[([^\]]*)\]/g)) {
      for (const rem of (arbitrary[1] ?? "").matchAll(/([\d.]+)rem/g)) {
        found.push(Number(rem[1]));
      }
    }
    return found;
  }

  it("OrderRail.tsx に text-sm と text-[0.6875rem] が現れる", () => {
    // 麺種は text-sm（0.875rem）で下限ちょうど、茹で加減・卓番・待ち時間は text-[0.6875rem]。
    // レール幅が 8rem に縮んだ代償を字寸で払わせないための、下限側の 2 点である。
    const code = readCodeWithStrings(ORDER_RAIL_FILE);
    expect(code, "麺種の text-sm（0.875rem = AC 3.6 の下限ちょうど）が無い").toMatch(/\btext-sm\b/);
    expect(code, `text-[${MIN_TEXT_REM}rem] が無い`).toContain(`text-[${MIN_TEXT_REM}rem]`);
  });

  it("OrderRail.tsx に 0.6875rem 未満の text-[…rem] が現れない", () => {
    // レール内の文字を 1 種でも下限より小さくすれば、狭い欄に詰め込む逃げ道ができる。逃げ道を塞ぐことで
    // 下限の検査が 1 本の規則で済む（レールの語＝Suggested・釜・時刻もこの規則の内側に置く）。
    const rems = arbitraryTextRems(readCodeWithStrings(ORDER_RAIL_FILE));
    // 任意値が 1 つも無ければ検査は空振りする（下限を語る対象が存在しない）。足場を先に確かめる。
    expect(rems.length, "text-[…rem] の任意値が 1 つも無い").toBeGreaterThan(0);
    for (const rem of rems) {
      expect(rem, `text-[${rem}rem] が下限 ${MIN_TEXT_REM}rem を下回る`).toBeGreaterThanOrEqual(
        MIN_TEXT_REM,
      );
    }
  });
});

// ── S11: ラジアルの前面性を奪わない（要件5.7） ────────────────────────────────

describe("S11 重畳の規律に手を出さない（要件5.7）", () => {
  it("OrderRail.tsx に z- を持つクラスと fixed が現れない", () => {
    // ラジアルは createPortal + fixed inset-0 z-[60] で body 直下に立つ。レールが z-index を持てば、
    // あるいは fixed でスタッキングコンテキストを作れば、重なる領域でラジアルの前面性と可触領域を
    // 奪いうる。レールが何も持たないことが、既存の重畳規律に触れていないことの証跡である。
    const code = readCodeWithStrings(ORDER_RAIL_FILE);
    expect(code, "z- を持つクラスが現れる（重ね順に手を出している）").not.toMatch(/\bz-/);
    expect(code, "fixed が現れる（スタッキングコンテキストを作りうる）").not.toMatch(/\bfixed\b/);
  });
});

// ── S12: 麺種色の出所は prop ただ 1 つ（要件3.2） ──────────────────────────────

describe("S12 麺種色を prop 経由でのみ得る（要件3.2）", () => {
  /** import 文（名前付き import）を「型のみか」「どの module から」に分解して取り出す。 */
  function namedImports(
    code: string,
  ): readonly { readonly typeOnly: boolean; readonly names: string; readonly from: string }[] {
    return [...code.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g)].map(
      (match) => ({
        typeOnly: match[1] !== undefined,
        names: match[2] ?? "",
        from: match[3] ?? "",
      }),
    );
  }

  it("OrderRail.tsx が noodleColors（resolver の製造元）を import しない", () => {
    // 色の割り当ては SlotBoard が useMemo で 1 つだけ作り、釜カードと共有する。レールが自前で
    // resolver を作れば、同一の麺種に別の色を与えうる第二の出所になる（AC 3.2 が禁じるのはこれ）。
    expect(
      readCodeWithStrings(ORDER_RAIL_FILE),
      "noodleColors が現れる（レール側に色の出所を持っている）",
    ).not.toMatch(/\bnoodleColors\b/);
  });

  it("OrderRail.tsx の noodleColor module からの import が型のみである", () => {
    // 型だけを引くなら値は 1 つも入って来ない。実行時に色を作る経路が無いことを、import の形で固定する。
    const fromNoodleColor = namedImports(readCodeWithStrings(ORDER_RAIL_FILE)).filter((entry) =>
      entry.from.endsWith("/noodleColor"),
    );
    expect(fromNoodleColor.length, "noodleColor module からの import が 1 つでない").toBe(1);
    const only = fromNoodleColor[0];
    expect(only?.typeOnly, `値として import している: ${only?.names ?? ""}`).toBe(true);
    expect(only?.names, "型 NoodleColor を引いていない").toMatch(/\bNoodleColor\b/);
  });

  it("OrderRail.tsx が noodleColor prop を受け取り、その戻り値を色に用いる", () => {
    // 上の 2 つは不在の主張である。不在だけでは「色をどこからも得ていない」形でも通ってしまうため、
    // 唯一の経路が実在することを併せて見る（prop の宣言と、インラインの color がその呼び出しであること）。
    const code = readCodeWithStrings(ORDER_RAIL_FILE);
    expect(code, "noodleColor prop の宣言が無い").toMatch(
      /readonly\s+noodleColor\s*:\s*NoodleColor\b/,
    );
    expect(code, "インラインの color が noodleColor の呼び出しでない").toMatch(
      /style=\{\{\s*color:\s*noodleColor\(/,
    );
  });
});

// ── S13: 変更が client に閉じる（要件6.5） ────────────────────────────────────

/** サーバ側の全域。レールの識別子がここに現れたなら、表示層の変更が状態・ワイヤへ漏れている。 */
const SERVER_DIRS = ["src/domain", "src/engine", "src/shell"] as const;

/** 極薄の Worker エントリ。ディレクトリではないため個別に挙げる。 */
const WORKER_ENTRY_FILE = "src/worker.ts";

/** レールの公開シンボルと非 export の行。名が漏れていないことを識別子境界で見る。 */
const RAIL_SYMBOLS = ["OrderRail", "OrderRow"] as const;

describe("S13 変更が client の表示層に閉じている（要件6.5）", () => {
  /** repoRoot からの相対パス（posix 区切り）で `.ts` / `.tsx` を再帰収集する。 */
  function collectSourceFiles(relativeDir: string): readonly string[] {
    const found: string[] = [];
    for (const dirent of readdirSync(resolve(repoRoot, relativeDir), { withFileTypes: true })) {
      const childRelative = relative(repoRoot, resolve(repoRoot, relativeDir, dirent.name))
        .split(sep)
        .join("/");
      if (dirent.isDirectory()) {
        found.push(...collectSourceFiles(childRelative));
      } else if (dirent.isFile() && (dirent.name.endsWith(".ts") || dirent.name.endsWith(".tsx"))) {
        found.push(childRelative);
      }
    }
    return found.sort();
  }

  const serverFiles = [...SERVER_DIRS.flatMap(collectSourceFiles), WORKER_ENTRY_FILE];

  it("走査対象（src/domain / src/engine / src/shell / src/worker.ts）の探索が健全である", () => {
    // 集合が空なら下の禁則検査は空振りして常に真になる。足場を先に確かめる。
    expect(serverFiles.length, "サーバ側のソースが 1 つも見つからない").toBeGreaterThan(0);
    expect(serverFiles, `${WORKER_ENTRY_FILE} が集合に無い`).toContain(WORKER_ENTRY_FILE);
  });

  it("サーバ側の実コードに OrderRail / OrderRow の識別子が現れない", () => {
    // レールは表示の器であって状態の一部ではない。サーバ側がその名を知る必要は無く、知ったなら配置の話が
    // 状態の話へ漏れている（真実の源が増える）。識別子境界で見るのは、部分一致で無関係な語を拾わないため。
    for (const file of serverFiles) {
      const code = readBareCode(file);
      for (const symbol of RAIL_SYMBOLS) {
        expect(
          code,
          `${file} に ${symbol} が実コードとして現れる（表示層の変更がサーバ側へ漏れている）`,
        ).not.toMatch(new RegExp(`\\b${symbol}\\b`));
      }
    }
  });

  it("両識別子はレールの実装に実在する（検査の健全性）", () => {
    // 名が変われば上の禁則検査は空振りする。識別子の在処を同じ検査で固定し、トートロジー化を防ぐ。
    const code = readBareCode(ORDER_RAIL_FILE);
    for (const symbol of RAIL_SYMBOLS) {
      expect(code, `${ORDER_RAIL_FILE} に ${symbol} の宣言が無い`).toMatch(
        new RegExp(`function\\s+${symbol}\\b`),
      );
    }
  });
});

// ── S14: 既存の純粋導出の形を変えない（要件6.3） ──────────────────────────────

/** 純粋導出の在処。引数の個数・順序と戻り値の構成を本 spec で変えない（要件6.3）。 */
const QUEUE_DISPLAY_FILE = "src/client/components/queueDisplay.ts";

/** `orderQueueEntries` の引数（個数・順序・名）。 */
const QUEUE_ENTRIES_PARAMETERS = ["view", "units", "now"] as const;

/** `QueueEntry` の 3 要素（Pending_Order の事実・待ち時間・担当範囲内の提案）。 */
const QUEUE_ENTRY_FIELDS = ["order", "waitingMs", "suggestion"] as const;

describe("S14 既存の純粋導出の形が変わっていない（要件6.3）", () => {
  /** 波括弧で挟まれた宣言の中身を取り出す（開き括弧の目印から最初の閉じ括弧まで）。 */
  function declarationBody(code: string, opening: string, closing: string, label: string): string {
    const at = code.indexOf(opening);
    expect(at, `${label}: ${opening} が見つからない`).toBeGreaterThanOrEqual(0);
    const from = at + opening.length;
    const end = code.indexOf(closing, from);
    expect(end, `${label}: ${opening} を閉じる ${closing} が無い`).toBeGreaterThan(from);
    return code.slice(from, end);
  }

  it("orderQueueEntries が 3 引数（view / units / now）を保つ", () => {
    // 引数が増えたなら、レールが新しい入力を要求したということである。表示の配置を変えるだけの spec で
    // 導出の口が広がったなら、境界を越えた証拠になる（既存テストもその名と形で呼んでいる）。
    const parameters = declarationBody(
      readBareCode(QUEUE_DISPLAY_FILE),
      "export function orderQueueEntries(",
      ")",
      QUEUE_DISPLAY_FILE,
    )
      .split(",")
      .map((parameter) => parameter.split(":")[0]?.trim() ?? "")
      .filter((name) => name.length > 0);
    expect(parameters, "orderQueueEntries の引数の個数・順序・名が変わっている").toEqual([
      ...QUEUE_ENTRIES_PARAMETERS,
    ]);
  });

  it("QueueEntry が 3 フィールド（order / waitingMs / suggestion）を保つ", () => {
    // 待ち時間を保持値へ昇格させたり、提案の理由を覚えたりすれば、ここにフィールドが増える。3 つのままで
    // あることが、レールが導出済みの値を写すだけに留まっていることを示す。
    const fields = [
      ...declarationBody(
        readBareCode(QUEUE_DISPLAY_FILE),
        "export interface QueueEntry {",
        "}",
        QUEUE_DISPLAY_FILE,
      ).matchAll(/readonly\s+(\w+)\s*:/g),
    ].map((match) => match[1] ?? "");
    expect(fields, "QueueEntry の要素の構成が変わっている").toEqual([...QUEUE_ENTRY_FIELDS]);
  });
});

// ── S15: レールの固定文言は英語（要件3.9） ────────────────────────────────────

/** 日本語（ひらがな・カタカナ・漢字・CJK 記号・半角カナ）の検出。 */
const JAPANESE = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]/;

describe("S15 レールの固定文言が英語である（要件3.9）", () => {
  it("OrderRail.tsx の文字列リテラルと JSX テキストに日本語が現れない", () => {
    // 本 spec が新たに書く固定文言（Waiting orders / Table / Suggested / Slot(s)）はすべて英語である。
    // 合意済みの調理母語（バリカタ／かため／ふつう／やわめ）は FIRMNESS_LABEL 経由でのみ入り、レールに
    // 直書きされない——ゆえにレールの画面文言に日本語は 1 字も現れない。
    //
    // 検査対象はコメントを除いたテキストである。コードコメントは規約どおり日本語で書く（そちらを読めば
    // 全件が違反になる）。
    const code = readCodeWithStrings(ORDER_RAIL_FILE);
    const found = JAPANESE.exec(code);
    expect(
      found,
      `${ORDER_RAIL_FILE} の画面文言に日本語 "${found?.[0] ?? ""}" が含まれる`,
    ).toBeNull();
  });

  it("OrderRail.tsx が茹で加減の表示語を FIRMNESS_LABEL から引く", () => {
    // 上は不在の主張である。不在だけでは「茹で加減を表示していない」形でも通る。既存の語彙を参照している
    // ことを併せて見て、レール専用の別ラベルを持たないこと（AC 3.10）と両立していることを示す。
    expect(
      readBareCode(ORDER_RAIL_FILE),
      "FIRMNESS_LABEL を引いていない（茹で加減の出所が別に在る疑い）",
    ).toMatch(/FIRMNESS_LABEL\[/);
  });
});
