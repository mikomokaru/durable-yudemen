// tests/entry-routing.static.test.ts — Entry（`/`）が Worker に届くことを設定で固定する静的検査。
//
// _Validates: per-store-provisioning 要件 7.2, 7.3, 7.4, 7.5_
//
// **なぜ振る舞いテストではなく設定検査なのか。**
// Entry の行き先解決は 2 つの層に跨る。純粋な宛先選定（`resolveEntryDestination`）と、その関数が
// 呼ばれる位置（`src/worker.ts` の `/` 分岐）である。前者は tests/worker/entry.{example,property}.test.ts
// が押さえている。**しかし「その分岐に制御が届くか」は Cloudflare のアセット routing が決めるため、
// Worker のコードをいくら検証しても分からない。**
//
// 既定の routing（`run_worker_first` なし）は「要求パスがアセットに一致すればアセットを返し、Worker を
// 起動しない」（https://developers.cloudflare.com/workers/static-assets/routing/worker-script/）。`/` は
// index.html に一致するので、`run_worker_first` に `/` が無ければ Entry 分岐は**本番で一度も実行されない**。
//
// **そして `run_worker_first` の配列形は allowlist であり、既定への追加ではない。** 配列を渡した時点で
// `Sec-Fetch-Mode: navigate` の暗黙判定が無効化され、Worker が扱う要求とアセットとして返す要求の切り分けは
// この配列だけで決まる
// （https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/#advanced-routing-control）。
// 列挙しなかったパスはアセット扱いになり、アセットに一致しなければ not_found_handling の SPA フォールバックが
// index.html（200）を返す——**Worker には届かない**。`["/"]` だけを挙げていた間、ローカル dev の実測で
// `/s/{id}/ws`・`/admin/*`・`/pos/records`・`/entry/*` の全てが 200 の index.html を返し、WS 接続も
// Provisioning も POS 取り込みも Worker に到達していなかった。
//
// この欠落は Worker を直接叩くテストでは踏めない（アセット層が居ないため必ず分岐に届く）。ゆえに真実の
// ある場所——wrangler.jsonc——を見る。既存の tests/operation-history/*.static.test.ts と同じ形である。

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jsoncToJson } from "./operation-history/support/jsonc";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Producer 設定（Workers 設定の単一の正本・steering/tooling.md）。 */
const PRODUCER_CONFIG = "wrangler.jsonc";

interface AssetsConfig {
  readonly binding?: string;
  readonly not_found_handling?: string;
  readonly run_worker_first?: boolean | readonly string[];
}

function producerAssets(): AssetsConfig {
  const raw = readFileSync(resolve(repoRoot, PRODUCER_CONFIG), "utf8");
  const config = JSON.parse(jsoncToJson(raw)) as { readonly assets?: AssetsConfig };
  const assets = config.assets;
  if (assets === undefined) throw new Error(`${PRODUCER_CONFIG} に assets が無い`);
  return assets;
}

/**
 * `run_worker_first` のパターン照合。`*` は任意文字列（`/` を跨ぐ）、先頭 `!` は除外を表し、
 * 除外に当たったパスは Worker 先行から外れる（Cloudflare の advanced routing control の形）。
 */
function matchesRunWorkerFirst(path: string, patterns: readonly string[]): boolean {
  const toRegExp = (pattern: string): RegExp =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  const negated = patterns.filter((p) => p.startsWith("!")).map((p) => toRegExp(p.slice(1)));
  if (negated.some((re) => re.test(path))) return false;
  return patterns.filter((p) => !p.startsWith("!")).some((p) => toRegExp(p).test(path));
}

/** Validates: per-store-provisioning 要件 7.2〜7.5 */
describe("Entry routing — `/` が Worker に届く", () => {
  it("run_worker_first が `/` を含む", () => {
    const { run_worker_first: runWorkerFirst } = producerAssets();
    // 配列（選択的先行）で `/` を挙げる。true（全要求で先行）でも届くが、それは別の主張ゆえ下で分ける。
    expect(
      Array.isArray(runWorkerFirst) ? runWorkerFirst.includes("/") : runWorkerFirst === true,
      "run_worker_first に `/` が無い。既定のアセット先行により Entry の行き先解決（要件7.2）が実行されない",
    ).toBe(true);
  });

  it("run_worker_first は `true` ではなく必要な経路だけを挙げる", () => {
    const { run_worker_first: runWorkerFirst } = producerAssets();
    // `true` はアセット 1 本ごとに Worker を起動して要求数を食う。Entry 以外に先行の理由がない。
    expect(runWorkerFirst, "run_worker_first: true は全アセットで Worker を起動する").not.toBe(
      true,
    );
    expect(Array.isArray(runWorkerFirst)).toBe(true);
  });

  it("SPA フォールバックとアセットバインディングを保つ", () => {
    const assets = producerAssets();
    // `/` 以外の未一致パス（`/s/{storeId}/` 配下の SPA ルート）は index.html に落ちる必要がある。
    expect(assets.not_found_handling).toBe("single-page-application");
    // worker.ts が env.ASSETS.fetch で明示的にアセットへ委ねるため binding 名は必須。
    expect(assets.binding).toBe("ASSETS");
  });

  it("worker.ts が担う全経路が allowlist に覆われる", () => {
    const { run_worker_first: runWorkerFirst } = producerAssets();
    const patterns = Array.isArray(runWorkerFirst) ? runWorkerFirst : [];
    // 配列形は allowlist ゆえ、ここに載らない経路は Worker に届かず index.html に吸われる。
    // src/worker.ts の各分岐の代表パスを挙げ、いずれも覆われていることを確かめる。
    for (const path of [
      "/", // Entry（要件7.2〜7.5）
      "/s/yamaokaya-1263/", // 店舗画面（storeId 検証 → ASSETS 委譲）
      "/s/yamaokaya-1263/ws", // WS 接続（これが落ちると画面は永久にオフライン表示）
      "/s/yamaokaya-1263/orders", // Order_Ingress
      "/entry/stores", // 店舗切替リスト
      "/entry/signin/yamaokaya-1263", // 認証を経て店舗画面へ戻る通し口
      "/admin/stores", // Provisioning_API
      "/pos/records", // POS_Ingress
    ]) {
      expect(
        matchesRunWorkerFirst(path, patterns),
        `${path} が run_worker_first に覆われていない。allowlist 外は SPA フォールバックに吸われ Worker に届かない`,
      ).toBe(true);
    }
  });

  it("アセットは Worker を経ずに配信される", () => {
    const { run_worker_first: runWorkerFirst } = producerAssets();
    const patterns = Array.isArray(runWorkerFirst) ? runWorkerFirst : [];
    // JS/CSS/アイコンごとに Worker を起動させない（`true` を避ける理由と同じ・要求数を食う）。
    for (const path of [
      "/index.html",
      "/favicon.svg",
      "/pwa-512x512.png",
      "/assets/index-abc123.js",
    ]) {
      expect(
        matchesRunWorkerFirst(path, patterns),
        `${path} で Worker を先行させる理由がない`,
      ).toBe(false);
    }
  });
});
