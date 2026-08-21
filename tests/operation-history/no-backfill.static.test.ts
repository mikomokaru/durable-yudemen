// タスク 12.2 の検査。「縮退経路に backfill／再出力／DO 再起動がない」ことを、設定 graph と
// 運用手順（root 設定の有効化・切戻し手順）から機械的に確かめる。
//
// 前提（タスク 12.1 の確定・design.md「環境別搬送の確定結果」）: Logpush 縮退の構成対象環境は0件で、
// 全環境が第一経路（Tail Worker）を使う。ゆえにこの検査の主張は二つに収束する。
//   1. 縮退経路そのものが構成されていない（Logpush job / logs destination / 縮退用の設定キーが0件）。
//   2. 未観測期間を後から埋める機構が、設定・実装・運用手順のいずれにも存在しない
//      （backfill job、Producer 再出力要求、outbox、DO 再起動、観測目的の rehydrate／Reconcile／Persist）。
//
// 既存検査との分担（重複を作らない）:
//   - no-wake.static.test.ts … O1〜O7。Producer の capability と起動原因の「形」を AST で見る。
//   - config-graph.static.test.ts … 三つの Wrangler 設定の capability edge 集合と資源名の写し。
//   - ここ … 上の二つが見ていない範囲、すなわち **リポジトリ全体**（全 Wrangler 設定・src 全体・CI・
//     config/）に補完機構が一つも無いこと、および Producer 側に搬送経路の可用性分岐が無いこと。
//
// _Requirements: 1.8, 1.9, 2.15, 4.8, 4.13, 4.14_

import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { jsoncToJson } from "./support/jsonc";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const producerConfigPath = "wrangler.jsonc";
const shellPath = "src/shell/store-timer-do.ts";

function source(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

/** 有効な設定本文（コメントを落とした JSON）。手順を説明するコメントは能力ではない。 */
function activeConfig(relativePath: string): string {
  return jsoncToJson(source(relativePath));
}

function parse(relativePath: string): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    source(relativePath),
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function walk(node: ts.Node, visit: (child: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function filesUnder(relativeDirectory: string): readonly string[] {
  const ignored = new Set([".git", ".kiro", ".wrangler", "dist", "node_modules", "public"]);
  return readdirSync(resolve(repoRoot, relativeDirectory), { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry): readonly string[] => {
      const path = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) return ignored.has(entry.name) ? [] : filesUnder(path);
      return entry.isFile() ? [path] : [];
    });
}

const wranglerConfigPaths = filesUnder("").filter((path) => /^wrangler[^/]*\.jsonc$/.test(path));
const sourceFilePaths = filesUnder("src").filter((path) => /\.(?:ts|tsx)$/.test(path));
const workflowPaths = filesUnder(".github").filter((path) => /\.ya?ml$/.test(path));
const configSamplePaths = filesUnder("config").filter((path) => /\.jsonc?$/.test(path));

/**
 * 未観測期間を後から埋める機構の語彙。観測は best-effort であり、欠落は欠落のまま残す
 * （要件4.8）。ゆえにこれらの語が識別子・文字列・設定キーとして現れてはならない。
 *
 * Queue の再配送（`message.retry()`）は下流に閉じた正当な再試行（要件4.11）なので対象にしない。
 * 除いてある語: `revive`（永続移行の解釈・engine/migrate.ts）、`cursor`（codec の走査位置と CSS）。
 */
const backfillVocabulary = /back[-_]?fill|replay|re[-_]?emit|reemit|re[-_]?publish|republish|re[-_]?send|resend|retransmit|outbox|catch[-_]?up/i;

/**
 * 語が一致しても概念が違うもの — pos-order-ingress の「保留の再生」（Unrouted_Record の再生・同 spec
 * 要件11.6〜11.10・12.12）。
 *
 * ここが禁じているのは**観測の未観測期間を後から埋める**機構である（要件4.8——観測は best-effort であり、
 * 欠落は欠落のまま残す）。保留の再生が届け直すのは観測ではなく**未着手オーダーそのもの**で、宛先の店舗が
 * 未登録だったために保留していた取り込み Record を、登録が確定した時点で待ち行列の正本へ届ける。観測を
 * 一切読まず、Tail・Queue・R2・Snowpipe のいずれも通らない。語の一致だけで禁じれば、別概念に対する誤った
 * 禁止になる（`revive` / `cursor` を除いてあるのと同じ判断である）。
 *
 * **名を列挙して除く（ファイル単位で外さない）。** ファイルごと外せば、同じファイルに本物の補完機構を
 * 書いても検査が通る。新しい語を足すには、それがどちらの概念に属するかをここで宣言しなければならない。
 */
const unroutedReplayNames: ReadonlySet<string> = new Set([
  "isHeldReplayable", // src/registry/held-record.ts — 保持している 1 件を再生してよいか（純粋判定）
  "REPLAY_RESIDUAL_KEY",
  "replay:residual",
  "REPLAY_ALARM_DELAY_MS",
  "ReplayProgress",
  "replaying",
  "replayUnrouted",
  "replayForStoreCodes",
  "runReplay",
  "replayInAlarm", // 収束と多重化した Alarm ハンドラ内の再生（自身の失敗で throw しない・同 spec 要件11.11）
  "replayRemains", // 同ハンドラの局所変数——再生の残作業が残っているか（Alarm を張り直すかの判定）
  "deferReplay",
  "loadReplayResidual",
  "replay-deferred", // 保持は確定したが再生を持ち越した、という HoldOutcome の種別
  "replayWindowExpired", // 再生時に値域窓の外へ出た Record の破棄件数（pos-order-ingress 要件12.12）
]);

/** 未観測期間を記録して後から埋めるための進捗状態。観測側にも持たない（要件1.3 / 4.8）。 */
const resumeStateVocabulary = /watermark|checkpoint|resume[-_]?token|last[-_]?delivered|unobserved[-_]?window|missing[-_]?window/i;

/** Logpush 縮退の構成。タスク 12.1 の確定により対象環境0件ゆえ一つも存在しない。 */
const logpushConfigKey = /"(?:logpush|logpush_config|logpull|log_destination|workers_trace_events)"\s*:/i;

/** Validates: Requirements 4.8, 4.13 */
describe("Operation History 縮退経路 — Logpush 構成が0件である", () => {
  it("どの Wrangler 設定にも Logpush 有効化キーと logs destination がない", () => {
    // タスク 12.1 の確定（構成対象環境0件）を設定側で固定する。将来 Logpush を足すときは、
    // タスク 1.3 の確認をやり直した上で Data Platform 所有の account 設定へ置く（design.md）。
    expect(wranglerConfigPaths).toContain(producerConfigPath);
    for (const path of wranglerConfigPaths) {
      expect(activeConfig(path), `${path} が Logpush 構成キーを持つ`).not.toMatch(logpushConfigKey);
    }
  });

  it("Logpush job／logs destination を定義するファイルがリポジトリにない", () => {
    expect(filesUnder("").filter((path) => /logpush|logpull/i.test(path))).toEqual([]);
    for (const path of [...wranglerConfigPaths, ...configSamplePaths, ...workflowPaths]) {
      expect(source(path).replace(/^\s*(?:\/\/|#).*$/gm, ""), `${path} が Logpush 構成を持つ`).not.toMatch(
        /logpush|logpull/i,
      );
    }
  });
});

/** Validates: Requirements 1.8, 1.9, 2.15, 4.8, 4.14 */
describe("Operation History 縮退経路 — 未観測期間の補完機構がない", () => {
  it("src 全体の識別子・文字列に backfill／再出力／outbox の語彙が現れない", () => {
    expect(sourceFilePaths.length).toBeGreaterThan(0);
    for (const path of sourceFilePaths) {
      const file = parse(path);
      walk(file, (node) => {
        if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
          if (unroutedReplayNames.has(node.text)) return;
          expect(node.text, `${path} が補完機構 ${node.text} を持つ`).not.toMatch(backfillVocabulary);
        }
      });
    }
  });

  it("観測 module に未観測期間を埋めるための進捗状態がない", () => {
    const observationPaths = sourceFilePaths.filter(
      (path) => path.startsWith("src/operation-history/") || path.startsWith("src/data-platform/"),
    );
    expect(observationPaths.length).toBeGreaterThan(0);
    for (const path of observationPaths) {
      const file = parse(path);
      walk(file, (node) => {
        if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
          expect(node.text, `${path} が補完用の進捗状態 ${node.text} を持つ`).not.toMatch(resumeStateVocabulary);
        }
      });
    }
  });

  it("設定と CI に backfill job／再出力 step がない", () => {
    for (const path of wranglerConfigPaths) {
      expect(activeConfig(path), `${path} が補完機構を持つ`).not.toMatch(backfillVocabulary);
    }
    for (const path of [...configSamplePaths, ...workflowPaths]) {
      // CI／sample のコメントは手順の説明ゆえ落とし、実行される行だけを見る。
      expect(source(path).replace(/^\s*(?:\/\/|#).*$/gm, ""), `${path} が補完機構を持つ`).not.toMatch(
        backfillVocabulary,
      );
    }
  });

  it("未観測期間を埋めるために DO を起こせる scheduled 起動がない", () => {
    // cron も scheduled handler も、観測のために StoreTimerDO を起こす唯一の残り道である
    // （要件1.8 / 2.15）。設定と実装の両側で0件を保つ。
    for (const path of wranglerConfigPaths) {
      expect(activeConfig(path), `${path} が cron trigger を持つ`).not.toMatch(/"(?:triggers|crons)"\s*:/);
    }
    for (const path of sourceFilePaths) {
      const file = parse(path);
      walk(file, (node) => {
        if (!ts.isMethodDeclaration(node) && !ts.isMethodSignature(node) && !ts.isPropertyAssignment(node)) return;
        const name = node.name;
        const text = name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : "";
        expect(text, `${path} が scheduled handler を定義する`).not.toBe("scheduled");
      });
    }
  });
});

/** Validates: Requirements 1.8, 1.9, 2.15, 4.8 */
describe("Operation History 縮退経路 — 搬送経路の分岐と補完手順がない", () => {
  it("観測の判定は同期 ON/OFF flag 一つだけで、搬送経路の可用性を読まない", () => {
    // 縮退経路が存在しないことは「経路を選ぶ分岐が無い」という形で実装に現れる。Producer 側が
    // Tail の可用性や Logpush の有無を読んだ瞬間、観測が搬送状態へ依存し、未観測期間の補完へ
    // 手が伸びる余地が生まれる（要件1.8 / 4.8）。
    const shell = parse(shellPath);
    const envKeys = new Set<string>();
    walk(shell, (node) => {
      if (
        ts.isPropertyAccessExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "env"
      ) {
        envKeys.add(node.name.text);
      }
    });
    expect([...envKeys].filter((key) => /OPERATION|HISTORY|TELEMETRY/i.test(key))).toEqual([
      "OPERATION_HISTORY_ENABLED",
    ]);
    for (const key of envKeys) {
      expect(key, `shell が搬送経路 ${key} を読む`).not.toMatch(
        /TAIL|LOGPUSH|QUEUE|R2|SNOWPIPE|SNOWFLAKE|BACKFILL|DEGRADED|FALLBACK/i,
      );
    }
  });

  it("root 設定の切戻し手順が backfill・Producer 再出力・DO 再起動をいずれも要求しない", () => {
    // 運用手順の正本のうち、Producer 側の有効化・切戻しは root wrangler.jsonc のコメントに置く
    // （設定と手順を離すと片方だけが古くなる）。手順が補完を要求しないことをここで固定する。
    const procedure = source(producerConfigPath)
      .split("\n")
      .filter((line) => /^\s*\/\//.test(line))
      .join("\n");
    for (const term of ["state migration", "backfill", "Producer 再出力", "DO 再起動"]) {
      expect(procedure, `切戻し手順が「${term}」の不要を明記していない`).toContain(term);
    }
    expect(procedure).toMatch(/(?:backfill|再出力|再起動)[^\n]*必要としない/);
    // 手順が補完・再出力・DO 再起動を「行う」側で書かれていないこと。
    expect(procedure).not.toMatch(/(?:backfill|再出力|再起動)[^\n]*(?:を(?:実行|投入|要求)する|してから)/);
  });
});
