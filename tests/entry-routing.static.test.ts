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
// 既定の routing は「要求パスがアセットに一致すればアセットを返し、Worker を起動しない」
// （https://developers.cloudflare.com/workers/static-assets/routing/worker-script/）。`/` は index.html に
// 一致するので、`run_worker_first` に `/` が無ければ Entry 分岐は**本番で一度も実行されない**。実測でも
// `/` は 200（SPA）を返し、アセットに一致しない `/entry/stores`・`/pos/records` だけが Worker に届いていた。
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
    expect(runWorkerFirst, "run_worker_first: true は全アセットで Worker を起動する").not.toBe(true);
    expect(Array.isArray(runWorkerFirst)).toBe(true);
  });

  it("SPA フォールバックとアセットバインディングを保つ", () => {
    const assets = producerAssets();
    // `/` 以外の未一致パス（`/s/{storeId}/` 配下の SPA ルート）は index.html に落ちる必要がある。
    expect(assets.not_found_handling).toBe("single-page-application");
    // worker.ts が env.ASSETS.fetch で明示的にアセットへ委ねるため binding 名は必須。
    expect(assets.binding).toBe("ASSETS");
  });

  it("アセットに一致しない経路は列挙しない（既定で Worker に届く）", () => {
    const { run_worker_first: runWorkerFirst } = producerAssets();
    const patterns = Array.isArray(runWorkerFirst) ? runWorkerFirst : [];
    // これらは実在アセットを持たないため既定で Worker に届く。挙げれば「先行が要る」という嘘になる。
    for (const path of ["/entry/stores", "/pos/records", "/admin/*", "/s/*"]) {
      expect(patterns, `${path} は既定で Worker に届くため run_worker_first に要らない`).not.toContain(path);
    }
  });
});
