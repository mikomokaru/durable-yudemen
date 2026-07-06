// check-access-enablement.ts — Cloudflare Access 本番有効化のデプロイ前検査 CLI（要件5.3 / 5.5）。
//
// 「プレースホルダのまま ACCESS_REQUIRED を "1" にする」事故と「Env 型再生成の失敗を見落としたまま ON にする」
// 事故を、デプロイの前段で止める。判定そのものは純粋述語 enablementReadiness（src/access-enablement.ts）に委ね、
// ここは「値の取得（wrangler.jsonc vars ＋ デプロイ時オーバーライド）・型再生成の実行・エラー提示・非ゼロ終了」
// という作用だけを担う端（tools/）である。純粋述語は src/、それを呼ぶ CLI は tools/ という分離を保つ（構造の主権）。
//
// 安全側の既定: 有効化の意図（ACCESS_REQUIRED === "1"）が無い、または判定不能・前提未充足のときは常に OFF に留め、
// ON を伴うデプロイを中止する。runtime の Worker に恒久ガードは足さない（要件が課すのは切替手続きの前提条件）。

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { argv, env, exit, stderr, stdout } from "node:process";

import { enablementReadiness, type InvalidVariable } from "../src/access-enablement";
import { isNonEmpty, type NonEmptyArray } from "../src/domain/timer";

/** 有効化の意図を表す ACCESS_REQUIRED の ON 値。これ以外はすべて OFF（安全側）に落とす。 */
const ENABLE = "1";

/**
 * TypegenOutcome — `pnpm cf-typegen`（Env 型再生成）の結果（要件5.5）。
 *
 * ran:false は「有効化の意図が無く型再生成を走らせていない」状態。作用（サブプロセス起動）を端に寄せ、
 * 純粋判定 accessEnablementPreflight にはこの結果データだけを渡す（計算と作用の分離）。
 */
export type TypegenOutcome =
  | { readonly ran: false }
  | { readonly ran: true; readonly ok: true }
  | { readonly ran: true; readonly ok: false; readonly detail: string };

/** PreflightInput — デプロイ前検査の入力（解決済みの vars 値と型再生成の結果）。 */
export type PreflightInput = {
  readonly accessRequired: string;
  readonly teamDomain: string;
  readonly policyAud: string;
  readonly typegen: TypegenOutcome;
};

/**
 * PreflightVerdict — デプロイ前検査の判定（判別可能型）。
 *
 * proceed:false は必ず 1 件以上の英語エラーを伴う（NonEmptyArray で型が強制する）。「中止なのに理由なし」を
 * 構築不能にし、どの変数が・なぜ不正か（または型再生成が失敗したか）を過不足なく運用者へ提示する（要件5.3）。
 */
export type PreflightVerdict =
  | { readonly proceed: true; readonly notes: readonly string[] }
  | { readonly proceed: false; readonly errors: NonEmptyArray<string> };

/**
 * accessEnablementPreflight — ACCESS_REQUIRED の意図・純粋述語の判定・型再生成の結果を合成する純粋関数。
 *
 * 有効化の意図が無ければ（ACCESS_REQUIRED !== "1"）検査を課さず OFF に留める（安全側の既定）。ON の意図があるときのみ、
 * 型再生成失敗（要件5.5）とプレースホルダ残存・形式不適合（要件5.3・enablementReadiness）を集約し、いずれかが
 * 成立すれば ON を伴うデプロイの中止を英語エラー付きで返す。純粋・決定的（作用は呼び出す main 側）。
 */
export function accessEnablementPreflight(input: PreflightInput): PreflightVerdict {
  // 有効化の意図が無い: 検査せず OFF を維持する（要件5.3 の安全側の既定）。
  if (input.accessRequired !== ENABLE) {
    return {
      proceed: true,
      notes: [
        `ACCESS_REQUIRED is "${input.accessRequired}" (not "1"); Access stays OFF. No enablement preconditions are enforced (safe default).`,
      ],
    };
  }

  const errors: string[] = [];

  // 型再生成の失敗は ON への切替を止める（要件5.5）。設定の正本 wrangler.jsonc と Env 型が同期していない証左。
  if (input.typegen.ran && !input.typegen.ok) {
    errors.push(
      `Env type regeneration (pnpm cf-typegen) failed, so the Env type is out of sync with wrangler.jsonc. ${input.typegen.detail}`,
    );
  }

  // プレースホルダ残存・空・形式不適合を純粋述語で判定し、不正変数を英語で説明する（要件5.3）。
  const readiness = enablementReadiness(input.teamDomain, input.policyAud);
  if (!readiness.ready) {
    for (const invalid of readiness.invalid) errors.push(describeInvalid(invalid));
  }

  if (isNonEmpty(errors)) return { proceed: false, errors };
  return {
    proceed: true,
    notes: ['All deploy-time preconditions are satisfied; enabling Access (ACCESS_REQUIRED="1") may proceed.'],
  };
}

/** 不正変数を、どの変数が・なぜ不正で・どう直すかまで示す英語 1 行に写す（ユーザー向け出力は英語・要件5.3）。 */
function describeInvalid(invalid: InvalidVariable): string {
  if (invalid.variable === "TEAM_DOMAIN") {
    if (invalid.reason === "empty") {
      return 'TEAM_DOMAIN is empty or unset. Set it to your real Cloudflare Access team URL, e.g. "https://acme.cloudflareaccess.com".';
    }
    if (invalid.reason === "placeholder") {
      return 'TEAM_DOMAIN still holds the repository placeholder "https://<team>.cloudflareaccess.com". Replace it with your real team URL before enabling Access.';
    }
    return 'TEAM_DOMAIN is malformed. It must be "https://<team>.cloudflareaccess.com" where <team> is a 1-63 character DNS label ([a-z0-9-], no leading or trailing hyphen).';
  }
  if (invalid.reason === "empty") {
    return "POLICY_AUD is empty or unset. Set it to your Access application audience (AUD) tag.";
  }
  return 'POLICY_AUD still holds the repository placeholder "<access-app-aud>". Replace it with your real Access application audience (AUD) tag before enabling Access.';
}

// ── ここから下は作用（端）: 値の取得・型再生成の実行・提示・終了コード ───────────────────────

/** wrangler.jsonc の vars から取り出す 3 値（いずれも文字列想定・欠落や非文字列は undefined）。 */
type WranglerVars = {
  readonly ACCESS_REQUIRED?: string | undefined;
  readonly TEAM_DOMAIN?: string | undefined;
  readonly POLICY_AUD?: string | undefined;
};

/**
 * JSONC を素の JSON へ均して JSON.parse する（wrangler.jsonc は設定の正本ゆえ堅牢に読む）。
 *
 * 文字列リテラルの中身は一切触らない（`"https://…"` の二重スラッシュをコメントと誤認しない）。文字列外でのみ
 * 行コメント・ブロックコメント・`}`/`]` 直前の末尾カンマを取り除く。
 */
function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    // 文字列リテラル: 閉じ引用符まで（エスケープを尊重して）そのまま取り込む。
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n) {
        const c = text[i]!;
        out += c;
        i++;
        if (c === "\\") {
          if (i < n) {
            out += text[i]!;
            i++;
          }
          continue;
        }
        if (c === '"') break;
      }
      continue;
    }
    // 行コメント: 改行まで読み飛ばす（改行は次の反復で通常文字として保つ）。
    if (ch === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    // ブロックコメント: 閉じ `*/` まで読み飛ばす。
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // 末尾カンマ: 後続の非空白が `}` か `]` なら捨てる（JSON.parse は末尾カンマを拒むため）。
    if (ch === ",") {
      let j = i + 1;
      while (j < n && isWhitespace(text[j]!)) j++;
      if (j < n && (text[j] === "}" || text[j] === "]")) {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return JSON.parse(out) as unknown;
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/** wrangler.jsonc を読み、vars の 3 値（string のみ・非文字列や欠落は undefined = fallback へ委ねる）を取り出す。 */
function readWranglerVars(wranglerPath: string): WranglerVars {
  const parsed = parseJsonc(readFileSync(wranglerPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null) return {};
  const vars = (parsed as { vars?: unknown }).vars;
  if (typeof vars !== "object" || vars === null) return {};
  const record = vars as Record<string, unknown>;
  return {
    ACCESS_REQUIRED: asString(record.ACCESS_REQUIRED),
    TEAM_DOMAIN: asString(record.TEAM_DOMAIN),
    POLICY_AUD: asString(record.POLICY_AUD),
  };
}

/** 値が文字列のときだけそれを、そうでなければ undefined を返す。 */
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * 変数値を解決する。デプロイ時オーバーライド（環境変数）を最優先し、無ければ wrangler.jsonc vars を用いる（要件5.6）。
 * オーバーライドが空文字なら空として扱い、述語が「未投入」として弾く（未設定を黙って通さない）。
 */
function resolveValue(envKey: keyof WranglerVars, fallback: string | undefined): string {
  const override = env[envKey];
  if (override !== undefined) return override;
  return fallback ?? "";
}

/** `pnpm cf-typegen`（= `wrangler types`）を実行し、Env 型再生成の成否を返す（要件5.4 / 5.5）。 */
function runTypegen(): TypegenOutcome {
  const result = spawnSync("pnpm", ["cf-typegen"], { encoding: "utf8", stdio: "pipe" });
  if (result.error) {
    return { ran: true, ok: false, detail: `Could not launch pnpm cf-typegen: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim();
    const tail = detail.length > 0 ? ` Details: ${detail}` : "";
    return { ran: true, ok: false, detail: `pnpm cf-typegen exited with code ${result.status ?? "unknown"}.${tail}` };
  }
  return { ran: true, ok: true };
}

/** CLI 本体: 値を解決し、必要なら型再生成を走らせ、判定に従って提示・終了コードを設定する。 */
function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const wranglerPath = resolve(here, "..", "wrangler.jsonc");

  let vars: WranglerVars;
  try {
    vars = readWranglerVars(wranglerPath);
  } catch (err) {
    // 設定の正本が読めない/壊れているときも安全側（ON にしない）で中止する。
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`Could not read Access config from ${wranglerPath}: ${message}\n`);
    exit(1);
  }

  const accessRequired = resolveValue("ACCESS_REQUIRED", vars.ACCESS_REQUIRED ?? "0");
  const teamDomain = resolveValue("TEAM_DOMAIN", vars.TEAM_DOMAIN);
  const policyAud = resolveValue("POLICY_AUD", vars.POLICY_AUD);

  // 型再生成は「ON の意図があるとき」だけ走らせる（OFF のデプロイに無用な副作用を課さない）。
  const typegen: TypegenOutcome = accessRequired === ENABLE ? runTypegen() : { ran: false };

  const verdict = accessEnablementPreflight({ accessRequired, teamDomain, policyAud, typegen });

  if (verdict.proceed) {
    for (const note of verdict.notes) stdout.write(`${note}\n`);
    exit(0);
  }

  stderr.write('Refusing to enable Cloudflare Access (ACCESS_REQUIRED="1"): deploy-time preconditions are not met.\n');
  for (const error of verdict.errors) stderr.write(`  - ${error}\n`);
  stderr.write('ACCESS_REQUIRED stays "0" (OFF) until the issues above are resolved.\n');
  exit(1);
}

// 直接実行時のみ作用を起こす。テスト（tools の import）では main を呼ばない（純粋関数だけを検証させる）。
//
// 実行系によって argv[1] の中身が異なる: 素の node ではエントリのファイルパスだが、vite-node では
// ランナー本体（vite-node/dist/cli.mjs）のパスが入り、対象モジュールのパスは後続の argv に現れる。
// ゆえに argv[1] 一点比較では vite-node 実行時に main が呼ばれない。argv のいずれかがこのモジュール
// 自身に解決されるか（＝このファイルがエントリとして渡されたか）で判定し、両実行系で正しく起動させる。
const selfPath = fileURLToPath(import.meta.url);
const invokedAsEntry = argv.some((arg) => {
  try {
    return resolve(arg) === selfPath;
  } catch {
    return false;
  }
});
if (invokedAsEntry) {
  main();
}
