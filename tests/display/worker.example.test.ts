// tests/display/worker.example.test.ts — 札の Worker の 2 経路（配信と生成の起動）。
//
// _Validates: item-display-abbreviation Requirements 3.1, 3.2, 7.1_
//
// 実 KV も実 AI も使わない。`src/display/worker.ts` は `cloudflare:workers` を import しないので、
// node 環境で `fetch` を直接呼べる（workerd を起こす必要がない）。
//
// 見るのは 1 つ——**生成の起動が応答を待たせないこと**。辞書を配る経路は持たない（札は品目に載って
// WS で届くので、client が HTTP で取りに来ることがない）。

import { describe, expect, it, vi } from "vitest";
import shortNamesWorker, { type ShortNamesWorkerEnv } from "../../src/display/worker";
import type { ShortNameStore } from "../../src/display/dictionary";

const MODEL = "@cf/zai-org/glm-5.3-flash";

function fakeStore(options: { readonly failReads?: boolean } = {}) {
  const values = new Map<string, string>();
  const metadata = new Map<string, unknown>();
  const store: ShortNameStore = {
    list: () => {
      if (options.failReads === true) return Promise.reject(new Error("kv down"));
      return Promise.resolve({
        keys: [...values.keys()].map((name) => ({ name, metadata: metadata.get(name) })),
        list_complete: true,
      });
    },
    getWithMetadata: (key) =>
      Promise.resolve({ value: values.get(key) ?? null, metadata: metadata.get(key) ?? null }),
    put: (key, value, opts) => {
      values.set(key, value);
      metadata.set(key, opts?.metadata);
      return Promise.resolve();
    },
  };
  return store;
}

/** `waitUntil` を集めるだけの ExecutionContext。走らせたい試験だけが待つ。 */
function fakeCtx(): ExecutionContext & { readonly pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
    passThroughOnException: () => undefined,
    props: {},
  } as ExecutionContext & { readonly pending: Promise<unknown>[] };
}

/** 押し込み先を記録するだけの DO 名前空間。札の Worker が誰へ押したかを観測する。 */
function envOf(
  store: ShortNameStore,
  ai = { run: vi.fn() },
): ShortNamesWorkerEnv & { readonly pushes: { storeId: string; labels: unknown }[] } {
  const pushes: { storeId: string; labels: unknown }[] = [];
  const namespace = {
    getByName: (storeId: string) => ({
      applyShortNames: (labels: unknown) => {
        pushes.push({ storeId, labels });
        return Promise.resolve();
      },
    }),
  };
  return {
    pushes,
    SHORT_NAMES: store,
    AI: ai,
    SHORT_NAME_MODEL: MODEL,
    STORE_TIMER_DO: namespace,
  } as unknown as ShortNamesWorkerEnv & { readonly pushes: { storeId: string; labels: unknown }[] };
}

const get = (path: string): Request => new Request(`https://short-names.invalid${path}`);

describe("生成の起動", () => {
  it("202 を即返し、検出は waitUntil の中で走らせる", async () => {
    const store = fakeStore();
    const ctx = fakeCtx();
    const request = new Request("https://short-names.invalid/display/observed", {
      method: "POST",
      body: JSON.stringify({ storeId: "yamaokaya-1108", names: ["特味噌ネギラーメン"] }),
    });
    const response = await shortNamesWorker.fetch(request, envOf(store), ctx);
    expect(response.status).toBe(202);
    expect(ctx.pending).toHaveLength(1);
  });

  it("読めないボディは 400（検出を起動しない）", async () => {
    const ctx = fakeCtx();
    const request = new Request("https://short-names.invalid/display/observed", {
      method: "POST",
      body: "{",
    });
    const response = await shortNamesWorker.fetch(request, envOf(fakeStore()), ctx);
    expect(response.status).toBe(400);
    expect(ctx.pending).toHaveLength(0);
  });

  it("names が配列でなければ 400", async () => {
    const ctx = fakeCtx();
    const request = new Request("https://short-names.invalid/display/observed", {
      method: "POST",
      body: JSON.stringify({ storeId: "yamaokaya-1108", names: "特味噌ネギラーメン" }),
    });
    expect((await shortNamesWorker.fetch(request, envOf(fakeStore()), ctx)).status).toBe(400);
    expect(ctx.pending).toHaveLength(0);
  });

  it("知らない経路は 404", async () => {
    const response = await shortNamesWorker.fetch(
      get("/display/anything"),
      envOf(fakeStore()),
      fakeCtx(),
    );
    expect(response.status).toBe(404);
  });
});
