// tests/item-display-abbreviation.static.test.ts — 札の能力境界と公開範囲を設定・ソースで固定する静的検査。
//
// _Validates: item-display-abbreviation Requirements 7.3, 8.1, 8.5_
//
// **なぜ振る舞いテストではなく静的検査なのか。** ここで守るのは「ある能力が**無い**こと」と「ある要求が
// Worker に**届く**こと」で、どちらも Worker を直接叩くテストでは踏めない。
//
//   - 能力の不在：`StoreTimerDO` は root の生成 Env をそのまま受ける（`class StoreTimerDO extends
//     DurableObject<Env>`）。root の `wrangler.jsonc` に `ai` / `kv_namespaces` を書けば DO の env にも
//     現れる。Workers に per-DO の binding スコープは無いので、能力を分けるには Worker を分けるしかない。
//     「DO が AI・KV を使っていない」ことをコードで見ても、binding が在れば明日使える。
//   - 到達：`assets.run_worker_first` は allowlist であり、列挙しなかったパスは SPA フォールバックに
//     吸われて index.html（200）が返る——Worker には届かない。テストは必ず分岐に届いてしまうので踏めない。
//
// **保証の範囲を正確に言う。** 閉じているのは「`StoreTimerDO` が **AI・KV の直接 binding** を持たない」
// ことである。root の `SHORT_NAMES_WORKER`（service binding）は DO の env にも現れるので、型では閉じない。
// そちらは `store-timer-do.ts` が当該 binding を参照しないというソースの検査で見る（`SOLVER` と同じ範囲）。

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jsoncToJson } from "./operation-history/support/jsonc";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ROOT_CONFIG = "wrangler.jsonc";
const SHORT_NAMES_CONFIG = "wrangler.short-names.jsonc";
const STORE_TIMER_DO_SOURCE = "src/shell/store-timer-do.ts";

function config(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(jsoncToJson(readFileSync(resolve(repoRoot, path), "utf8")));
  if (typeof parsed !== "object" || parsed === null) throw new Error(`${path} is malformed`);
  return parsed as Record<string, unknown>;
}

/** コメントを落としたソース。説明文の中の語を能力と数えない。 */
function activeSource(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("札の能力境界", () => {
  it("root は AI binding も KV binding も持たない（DO の env に現れない）", () => {
    const root = config(ROOT_CONFIG);
    expect(root.ai, "root が ai binding を持つ").toBeUndefined();
    expect(root.kv_namespaces, "root が kv_namespaces を持つ").toBeUndefined();
  });

  it("AI binding と KV binding を持つのは札の Worker だけである", () => {
    const shortNames = config(SHORT_NAMES_CONFIG);
    expect(shortNames.ai).toEqual({ binding: "AI" });
    expect(Array.isArray(shortNames.kv_namespaces)).toBe(true);
    const namespaces = shortNames.kv_namespaces as readonly Record<string, unknown>[];
    expect(namespaces).toHaveLength(1);
    expect(namespaces[0]?.binding).toBe("SHORT_NAMES");
    // id / preview_id は実体を指す（プレースホルダのままでは deploy が失敗する）。値そのものは
    // 環境の事実ゆえ固定しないが、**未設定のまま通らない**ことは固定する。
    for (const key of ["id", "preview_id"] as const) {
      const value = namespaces[0]?.[key];
      expect(typeof value, `${key} が文字列でない`).toBe("string");
      expect(String(value), `${key} がプレースホルダのまま`).not.toMatch(/PLACEHOLDER/i);
      expect(String(value)).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("root は札の Worker へ service binding 1 本だけで到達する", () => {
    const services = config(ROOT_CONFIG).services as readonly Record<string, unknown>[];
    const toShortNames = services.filter((s) => s.service === "yude-men-short-names");
    expect(toShortNames).toEqual([
      { binding: "SHORT_NAMES_WORKER", service: "yude-men-short-names" },
    ]);
  });

  it("**`StoreTimerDO` は辞書を引かない**（AI・KV・札の Worker のいずれも参照しない）", () => {
    // 札は押し込みで届く（`applyShortNames`）。閉じているのは「pull しない・直接 binding を持たない」で
    // あって、DO が札に一切関わらないことではない。binding の不在は root の設定が閉じ、参照の不在は
    // ここがソースで見る（`SOLVER` と同じ扱い）。
    const source = activeSource(STORE_TIMER_DO_SOURCE);
    for (const capability of ["SHORT_NAMES_WORKER", "env.SHORT_NAMES", "env.AI"] as const) {
      expect(source.includes(capability), `store-timer-do.ts が ${capability} を参照する`).toBe(
        false,
      );
    }
  });

  it("札の Worker は押し込みのために店舗 DO の binding を持つ（migrations は持たない）", () => {
    const shortNames = config(SHORT_NAMES_CONFIG);
    const bindings = (
      shortNames.durable_objects as { bindings?: readonly Record<string, unknown>[] }
    )?.bindings;
    expect(bindings).toEqual([
      { name: "STORE_TIMER_DO", class_name: "StoreTimerDO", script_name: "yude-men-timer" },
    ]);
    // クラスの所有者は root ゆえ、こちらに migrations は置かない（持ち主を二箇所にしない）。
    expect(shortNames.migrations, "札の Worker が migrations を持つ").toBeUndefined();
  });
});

describe("札の Worker の公開範囲", () => {
  it("公開入口を持たない（到達経路は root の binding ただ一つ）", () => {
    const shortNames = config(SHORT_NAMES_CONFIG);
    expect(shortNames.workers_dev, "workers.dev が開いている").toBe(false);
    expect(shortNames.preview_urls, "preview URL が開いている").toBe(false);
    expect(shortNames.routes, "routes を持つ").toBeUndefined();
    expect(shortNames.route, "route を持つ").toBeUndefined();
    // 公開されていない以上、経路ごとのトークンは置かない（binding を引けることが認可である）。
    expect(JSON.stringify(shortNames.vars ?? {})).not.toMatch(/TOKEN|SECRET/i);
  });

  it("札の Worker は root と別の入口を持つ（同じ script を二重に配らない）", () => {
    expect(config(SHORT_NAMES_CONFIG).main).toBe("src/display/worker.ts");
    expect(config(SHORT_NAMES_CONFIG).name).toBe("yude-men-short-names");
  });
});

describe("札の公開経路が無い", () => {
  it("`/display/*` は run_worker_first に無い（root は中継しない）", () => {
    const assets = config(ROOT_CONFIG).assets as { readonly run_worker_first?: unknown };
    const first = assets.run_worker_first;
    // 配列形は allowlist である。`true`（全要求で Worker 先行）ではないことも併せて固定する。
    expect(Array.isArray(first), "run_worker_first が配列でない").toBe(true);
    // 札は WS の品目に載って届くので、client が HTTP で取りに来る経路はもう無い。
    expect(first as readonly string[]).not.toContain("/display/*");
  });

  it("root のソースに札の配信パスが現れない", () => {
    expect(activeSource("src/worker.ts")).not.toContain("/display/short-names");
  });
});
