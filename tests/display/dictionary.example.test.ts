// tests/display/dictionary.example.test.ts — 辞書（KV）の 3 操作の契約。
//
// KV の実体は使わない（`ShortNameStore` は 3 操作だけの構造型で、実 binding はこれを満たす——下の型検査で
// 固定する）。ここで確かめるのは永続と配信用読み取りの契約であり、実 binding を通す検査は Worker 配線の
// 統合テストが担う。

import { describe, expect, it } from "vitest";
import {
  readShortName,
  readShortNames,
  writeShortName,
  type ShortNameRecord,
  type ShortNameStore,
} from "../../src/display/dictionary";
import type { ShortNameEntry } from "../../src/display/short-name";

// 実 binding（`KVNamespace`）が `ShortNameStore` を満たすことを型で固定する。満たさなくなれば
// `pnpm typecheck` が落ち、Worker 配線の段で初めて気づく事態を避ける。
const conformsToKvNamespace: (kv: KVNamespace) => ShortNameStore = (kv) => kv;
void conformsToKvNamespace;

/** 記憶だけの KV。`list` のページ境界を再現できるよう 1 ページの件数を受ける。 */
function fakeStore(pageSize = 1000): ShortNameStore & { readonly puts: string[] } {
  const values = new Map<string, string>();
  const metadata = new Map<string, unknown>();
  const puts: string[] = [];
  return {
    puts,
    list(options) {
      const names = [...values.keys()].sort();
      const from = options?.cursor === undefined ? 0 : names.indexOf(options.cursor);
      const page = names.slice(from, from + pageSize);
      const next = names[from + pageSize];
      return Promise.resolve({
        keys: page.map((name) => ({ name, metadata: metadata.get(name) })),
        list_complete: next === undefined,
        cursor: next,
      });
    },
    getWithMetadata(key) {
      return Promise.resolve({
        value: values.get(key) ?? null,
        metadata: metadata.get(key) ?? null,
      });
    },
    put(key, value, options) {
      puts.push(key);
      values.set(key, value);
      metadata.set(key, options?.metadata);
      return Promise.resolve();
    },
  };
}

const record = (declaredName: string): ShortNameRecord => ({
  declaredName,
  decidedAt: 1_789_000_000_000,
  model: "@cf/zai-org/glm-5.3-flash",
  attempts: [],
});

const short = (label: string): ShortNameEntry => ({ kind: "short", label });
const plain: ShortNameEntry = { kind: "plain" };

describe("辞書の書き込みと読み取り", () => {
  it("short を書いて読み戻す", async () => {
    const store = fakeStore();
    await writeShortName(
      store,
      "特味噌ネギラーメン",
      short("特味噌ネギ"),
      record("特味噌ネギラーメン"),
    );
    expect(await readShortName(store, "特味噌ネギラーメン")).toEqual(short("特味噌ネギ"));
  });

  it("plain を書いて読み戻す。未登録と区別される", async () => {
    const store = fakeStore();
    await writeShortName(store, "醤油ラーメン", plain, record("醤油ラーメン"));
    expect(await readShortName(store, "醤油ラーメン")).toEqual(plain);
    expect(await readShortName(store, "味噌ラーメン")).toBeNull();
  });

  it("記録は値に置き、札は metadata に置く（全件読みが値を要しない）", async () => {
    const store = fakeStore();
    const audit = {
      ...record("旨辛ｽﾀﾐﾅﾗｰﾒﾝ"),
      attempts: [{ candidate: "旨辛スタミナラーメン", rejected: "too-long" }],
    };
    await writeShortName(store, "旨辛スタミナラーメン", short("旨辛スタミナ"), audit);
    // 正規化前の申告名は値にしか残らない（鍵は正規化後）。
    const raw = await store.getWithMetadata("旨辛スタミナラーメン");
    expect(raw.value === null ? null : JSON.parse(raw.value)).toEqual(audit);
    expect(raw.metadata).toEqual({ k: "s", l: "旨辛スタミナ" });
  });

  it("同じ鍵への上書きを許す（short → plain も plain → short も）", async () => {
    const store = fakeStore();
    await writeShortName(
      store,
      "特味噌ネギラーメン",
      short("特味噌ネギ"),
      record("特味噌ネギラーメン"),
    );
    await writeShortName(store, "特味噌ネギラーメン", plain, record("特味噌ネギラーメン"));
    expect(await readShortName(store, "特味噌ネギラーメン")).toEqual(plain);
    await writeShortName(
      store,
      "特味噌ネギラーメン",
      short("特味噌ネ"),
      record("特味噌ネギラーメン"),
    );
    expect(await readShortName(store, "特味噌ネギラーメン")).toEqual(short("特味噌ネ"));
  });
});

describe("全件読み取り", () => {
  it("short と plain の双方を返し、値を読まない", async () => {
    const store = fakeStore();
    await writeShortName(
      store,
      "特味噌ネギラーメン",
      short("特味噌ネギ"),
      record("特味噌ネギラーメン"),
    );
    await writeShortName(store, "醤油ラーメン", plain, record("醤油ラーメン"));
    const all = await readShortNames(store);
    expect(all.get("特味噌ネギラーメン")).toEqual(short("特味噌ネギ"));
    expect(all.get("醤油ラーメン")).toEqual(plain);
    expect(all.size).toBe(2);
  });

  it("cursor で続きを読む（1 ページに収まらない辞書）", async () => {
    const store = fakeStore(2);
    await Promise.all(
      ["あ", "い", "う", "え", "お"].map((name) =>
        writeShortName(store, name, short(name), record(name)),
      ),
    );
    expect((await readShortNames(store)).size).toBe(5);
  });

  it("metadata が読めない鍵はその 1 件だけ落ちる（辞書全体を失わない）", async () => {
    const store = fakeStore();
    await writeShortName(
      store,
      "特味噌ネギラーメン",
      short("特味噌ネギ"),
      record("特味噌ネギラーメン"),
    );
    await store.put("壊れた鍵", "{}", { metadata: { k: "x" } });
    await store.put("札が空の鍵", "{}", { metadata: { k: "s", l: "" } });
    const all = await readShortNames(store);
    expect(all.size).toBe(1);
    expect(all.get("特味噌ネギラーメン")).toEqual(short("特味噌ネギ"));
    // 落ちた鍵は未登録と同じに見える＝次の到着で改めて生成される。
    expect(await readShortName(store, "壊れた鍵")).toBeNull();
  });

  it("空の辞書は空の Map を返す", async () => {
    expect((await readShortNames(fakeStore())).size).toBe(0);
  });
});
