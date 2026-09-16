// tests/display/detect.example.test.ts — バッチ 1 本の検出ループ。
//
// 見るのは 4 つ——重複除去（鍵で畳み、生の表記は先頭が残る）、既知集合が KV を節約すること、締切と件数の
// 制限、そして**保存に失敗した鍵を既知にしないこと**。時計は注入し、実時間を待たない。

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SHORT_NAME_MAX_PER_REQUEST,
  SHORT_NAME_MIN_BUDGET_MS,
  SHORT_NAME_REQUEST_DEADLINE_MS,
  detectFirstAppearance,
  type ShortNameCache,
  type ShortNamePush,
} from "../../src/display/detect";
import type { ShortNameDeps, ShortNameModel } from "../../src/display/generate";
import { readShortName, type ShortNameStore } from "../../src/display/dictionary";

const MODEL = "@cf/zai-org/glm-5.3-flash";

/** 記憶だけの辞書。読み書きの回数を数え、書き込みを失敗させられる。 */
function fakeStore(options: { readonly failWrites?: boolean } = {}) {
  const values = new Map<string, string>();
  const metadata = new Map<string, unknown>();
  const counts = { list: 0, get: 0, put: 0 };
  const store: ShortNameStore = {
    list: () => {
      counts.list += 1;
      return Promise.resolve({
        keys: [...values.keys()].map((name) => ({ name, metadata: metadata.get(name) })),
        list_complete: true,
      });
    },
    getWithMetadata: (key) => {
      counts.get += 1;
      return Promise.resolve({
        value: values.get(key) ?? null,
        metadata: metadata.get(key) ?? null,
      });
    },
    put: (key, value, opts) => {
      counts.put += 1;
      if (options.failWrites === true) return Promise.reject(new Error("kv down"));
      values.set(key, value);
      metadata.set(key, opts?.metadata);
      return Promise.resolve();
    },
  };
  return { store, counts };
}

const reply = (short: string): unknown => ({
  choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ short }) } }],
});

function clock(start = 1_789_000_000_000) {
  let current = start;
  return { now: () => current, advance: (ms: number) => (current += ms) };
}

function deps(ai: ShortNameModel, store: ShortNameStore, now: () => number): ShortNameDeps {
  return { ai, store, model: MODEL, now };
}

/** 押し込み先の店舗（解決済みの StoreId・POS の Store_Code ではない）。 */
const STORE = "yamaokaya-1108";

/** 押し込みを記録するだけの受け手。何が誰へ積まれたかを観測する。 */
let pushed: { storeId: string; labels: Record<string, string> }[] = [];
const push: ShortNamePush = (storeId, labels) => {
  pushed.push({ storeId, labels: { ...labels } });
  return Promise.resolve();
};

beforeEach(() => {
  pushed = [];
});

/** 未読の既知集合（isolate の初回と同じ状態）。 */
const emptyCache = (): ShortNameCache => ({ entries: null });

/** 何を渡しても元名の先頭 5 文字を返すモデル（部分列なので必ず検査を通る）。 */
const headModel = (): ShortNameModel => ({
  run: vi.fn().mockImplementation((_model, inputs) => {
    const asked = inputs.messages[1].content.split("\n\n")[1] ?? "";
    return Promise.resolve(reply([...asked].slice(0, 5).join("")));
  }),
});

describe("重複除去と正規化", () => {
  it("同じ鍵になる表記はまとめて 1 回だけ生成する", async () => {
    const { store, counts } = fakeStore();
    const ai = headModel();
    await detectFirstAppearance(
      deps(ai, store, clock().now),
      emptyCache(),
      STORE,
      ["旨辛ｽﾀﾐﾅﾗｰﾒﾝ", "旨辛スタミナラーメン", "旨辛ｽﾀﾐﾅﾗｰﾒﾝ"],
      push,
    );
    expect(counts.put).toBe(1);
    expect(await readShortName(store, "旨辛スタミナラーメン")).toEqual({
      kind: "short",
      label: "旨辛スタミ",
    });
  });

  it("生の申告名はバッチ内の先頭の表記が記録へ残る", async () => {
    const { store } = fakeStore();
    await detectFirstAppearance(
      deps(headModel(), store, clock().now),
      emptyCache(),
      STORE,
      [
        "旨辛ｽﾀﾐﾅﾗｰﾒﾝ", // 先頭（半角カナ）
        "旨辛スタミナラーメン",
      ],
      push,
    );
    const raw = await store.getWithMetadata("旨辛スタミナラーメン");
    const record = raw.value === null ? null : JSON.parse(raw.value);
    expect(record?.declaredName).toBe("旨辛ｽﾀﾐﾅﾗｰﾒﾝ");
  });

  it("空の名前は無視し、名前が無いバッチでは辞書を読まない", async () => {
    const { store, counts } = fakeStore();
    await detectFirstAppearance(
      deps(headModel(), store, clock().now),
      emptyCache(),
      STORE,
      ["", ""],
      push,
    );
    expect(counts.list).toBe(0);
    expect(counts.put).toBe(0);
  });
});

describe("既知集合", () => {
  it("isolate の初回だけ全件を読み、以後は読まない", async () => {
    const { store, counts } = fakeStore();
    const cache = emptyCache();
    const time = clock();
    await detectFirstAppearance(
      deps(headModel(), store, time.now),
      cache,
      STORE,
      ["醤油ラーメン"],
      push,
    );
    expect(counts.list).toBe(1);
    await detectFirstAppearance(
      deps(headModel(), store, time.now),
      cache,
      STORE,
      ["醤油ラーメン"],
      push,
    );
    expect(counts.list).toBe(1);
  });

  it("既知の名前だけが届く間は 1 件も読まない", async () => {
    const { store, counts } = fakeStore();
    const cache = emptyCache();
    await detectFirstAppearance(
      deps(headModel(), store, clock().now),
      cache,
      STORE,
      ["醤油ラーメン"],
      push,
    );
    const getsAfterFirst = counts.get;
    await detectFirstAppearance(
      deps(headModel(), store, clock().now),
      cache,
      STORE,
      ["醤油ラーメン"],
      push,
    );
    expect(counts.get).toBe(getsAfterFirst);
  });

  it("他の isolate が既に書いていれば、生成せず既知にする", async () => {
    const { store, counts } = fakeStore();
    // 先に別経路で書いておく。
    await detectFirstAppearance(
      deps(headModel(), store, clock().now),
      emptyCache(),
      STORE,
      ["特味噌ネギラーメン"],
      push,
    );
    const putsBefore = counts.put;
    // 既知集合を持たない別の isolate から、辞書を読み直さずに同じ名前が届く……のではなく、
    // 全件読みの後に他所が書いた場合を再現するため、キャッシュを「読み込み済みだが空」にする。
    const staleCache: ShortNameCache = { entries: new Map() };
    const ai = headModel();
    await detectFirstAppearance(
      deps(ai, store, clock().now),
      staleCache,
      STORE,
      ["特味噌ネギラーメン"],
      push,
    );
    expect(counts.put).toBe(putsBefore); // 生成していない
    expect(ai.run).not.toHaveBeenCalled();
    expect(staleCache.entries?.has("特味噌ネギラーメン")).toBe(true);
  });
});

describe("締切と件数の制限", () => {
  it("上限を超える初出は次の到着へ送る", async () => {
    const { store, counts } = fakeStore();
    const names = [
      "特味噌ネギラーメン",
      "辛味噌ネギラーメン",
      "特味噌チャーシュー",
      "辛味噌チャーシュー",
      "お子様ラーメン醤油",
    ];
    expect(names.length).toBeGreaterThan(SHORT_NAME_MAX_PER_REQUEST);
    await detectFirstAppearance(
      deps(headModel(), store, clock().now),
      emptyCache(),
      STORE,
      names,
      push,
    );
    expect(counts.put).toBe(SHORT_NAME_MAX_PER_REQUEST);
  });

  it("残り時間が下限を切ったら着手しない", async () => {
    const { store, counts } = fakeStore();
    const time = clock();
    // 1 件目の生成で締切をほぼ使い切らせる。
    const ai: ShortNameModel = {
      run: vi.fn().mockImplementation((_model, inputs) => {
        time.advance(SHORT_NAME_REQUEST_DEADLINE_MS - SHORT_NAME_MIN_BUDGET_MS / 2);
        const asked = inputs.messages[1].content.split("\n\n")[1] ?? "";
        return Promise.resolve(reply([...asked].slice(0, 5).join("")));
      }),
    };
    await detectFirstAppearance(
      deps(ai, store, time.now),
      emptyCache(),
      STORE,
      ["特味噌ネギラーメン", "辛味噌ネギラーメン"],
      push,
    );
    expect(counts.put).toBe(1);
    expect(await readShortName(store, "辛味噌ネギラーメン")).toBeNull();
  });

  it("辞書の読み取りで時間が過ぎたら、その分を差し引いて着手可否を決める", async () => {
    const { store } = fakeStore();
    const time = clock();
    // `readShortName` が締切を食い潰す。残り時間をループ先頭で 1 回しか引かない実装ならここで
    // 生成が始まってしまう。
    const slow: ShortNameStore = {
      ...store,
      getWithMetadata: (key) => {
        time.advance(SHORT_NAME_REQUEST_DEADLINE_MS);
        return store.getWithMetadata(key);
      },
    };
    const ai = headModel();
    await detectFirstAppearance(
      deps(ai, slow, time.now),
      emptyCache(),
      STORE,
      ["特味噌ネギラーメン"],
      push,
    );
    expect(ai.run).not.toHaveBeenCalled();
    expect(await readShortName(store, "特味噌ネギラーメン")).toBeNull();
  });

  it("初回の全件読みも締切の内側で測る", async () => {
    const { store } = fakeStore();
    const time = clock();
    const slow: ShortNameStore = {
      ...store,
      list: () => {
        time.advance(SHORT_NAME_REQUEST_DEADLINE_MS);
        return store.list();
      },
    };
    const ai = headModel();
    await detectFirstAppearance(
      deps(ai, slow, time.now),
      emptyCache(),
      STORE,
      ["特味噌ネギラーメン"],
      push,
    );
    expect(ai.run).not.toHaveBeenCalled();
  });
});

describe("押し込み", () => {
  it("既知の札も積む（別店舗が初めて観測した商品に札が届く）", async () => {
    const { store } = fakeStore();
    // 店舗 A が生成済み。別 isolate の既知集合は空だが、KV には在る。
    await detectFirstAppearance(
      deps(headModel(), store, clock().now),
      emptyCache(),
      STORE,
      ["特味噌ネギラーメン"],
      push,
    );
    pushed = [];

    // 店舗 B が同じ商品を初めて観測する。**生成は起きないが押し込みは起きる。**
    const ai = headModel();
    await detectFirstAppearance(
      deps(ai, store, clock().now),
      emptyCache(),
      "yamaokaya-1360",
      ["特味噌ネギラーメン"],
      push,
    );
    expect(ai.run).not.toHaveBeenCalled();
    expect(pushed).toEqual([
      { storeId: "yamaokaya-1360", labels: { 特味噌ネギラーメン: "特味噌ネギ" } },
    ]);
  });

  it("**KV の読み取りが失敗しても、収集済みの札は押される**", async () => {
    const { store } = fakeStore();
    await detectFirstAppearance(
      deps(headModel(), store, clock().now),
      emptyCache(),
      STORE,
      ["特味噌ネギラーメン"],
      push,
    );
    pushed = [];

    // 1 巡目で既知の札を集めたうえで、2 巡目の読み取りが落ちる状況。
    const cache: ShortNameCache = {
      entries: new Map([["特味噌ネギラーメン", { kind: "short", label: "特味噌ネギ" }]]),
    };
    const failing: ShortNameStore = {
      ...store,
      getWithMetadata: () => Promise.reject(new Error("kv down")),
    };
    await detectFirstAppearance(
      deps(headModel(), failing, clock().now),
      cache,
      STORE,
      ["特味噌ネギラーメン", "辛味噌ネギラーメン"],
      push,
    );
    // 読み取りの失敗を外へ出すと関数ごと終わり、集めた札まで巻き添えになる。
    expect(pushed).toEqual([{ storeId: STORE, labels: { 特味噌ネギラーメン: "特味噌ネギ" } }]);
  });

  it("件数の上限に達しても、収集済みの札は押される（2 巡の分離）", async () => {
    const { store } = fakeStore();
    const cache: ShortNameCache = {
      entries: new Map([["特味噌ネギラーメン", { kind: "short", label: "特味噌ネギ" }]]),
    };
    // 未知を上限より多く並べ、末尾に既知を置く。1 巡にまとめて break する実装ならここで落ちる。
    const names = [
      "辛味噌ネギラーメン",
      "特味噌チャーシュー",
      "辛味噌チャーシュー",
      "お子様ラーメン醤油",
      "塩ネギチャーシュー",
      "特味噌ネギラーメン",
    ];
    await detectFirstAppearance(deps(headModel(), store, clock().now), cache, STORE, names, push);
    expect(pushed[0]?.labels["特味噌ネギラーメン"]).toBe("特味噌ネギ");
  });

  it("押し込む札が 1 つも無ければ押さない", async () => {
    const { store } = fakeStore();
    // 8 字以内はすべて plain（札を持たない）。
    await detectFirstAppearance(
      deps(headModel(), store, clock().now),
      emptyCache(),
      STORE,
      ["醤油ラーメン"],
      push,
    );
    expect(pushed).toEqual([]);
  });

  it("押し込みの失敗は取り込みの失敗にしない", async () => {
    const { store } = fakeStore();
    const failingPush = () => Promise.reject(new Error("do unreachable"));
    await expect(
      detectFirstAppearance(
        deps(headModel(), store, clock().now),
        emptyCache(),
        STORE,
        ["特味噌ネギラーメン"],
        failingPush,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("保存の失敗", () => {
  it("保存に失敗した鍵を既知集合へ入れない（次の到着で再検出される）", async () => {
    const { store } = fakeStore({ failWrites: true });
    const cache = emptyCache();
    await detectFirstAppearance(
      deps(headModel(), store, clock().now),
      cache,
      STORE,
      ["特味噌ネギラーメン"],
      push,
    );
    expect(cache.entries?.has("特味噌ネギラーメン")).toBe(false);
  });

  it("保存の失敗を取り込みの失敗として投げ返さない", async () => {
    const { store } = fakeStore({ failWrites: true });
    await expect(
      detectFirstAppearance(
        deps(headModel(), store, clock().now),
        emptyCache(),
        STORE,
        ["特味噌ネギラーメン"],
        push,
      ),
    ).resolves.toBeUndefined();
  });

  it("件数の上限は着手した件数で数える（失敗で上限が抜けない）", async () => {
    const { store, counts } = fakeStore({ failWrites: true });
    const ai = headModel();
    const names = [
      "特味噌ネギラーメン",
      "辛味噌ネギラーメン",
      "特味噌チャーシュー",
      "辛味噌チャーシュー",
      "お子様ラーメン醤油",
      "塩ネギチャーシュー",
    ];
    await detectFirstAppearance(deps(ai, store, clock().now), emptyCache(), STORE, names, push);
    // 全件が保存に失敗しても、着手は上限で止まる。
    expect(counts.put).toBe(SHORT_NAME_MAX_PER_REQUEST);
  });

  it("失敗した名前は同じバッチ内では再試行されない（次の到着へ送る）", async () => {
    const { store, counts } = fakeStore({ failWrites: true });
    await detectFirstAppearance(
      deps(headModel(), store, clock().now),
      emptyCache(),
      STORE,
      ["特味噌ネギラーメン", "特味噌ネギラーメン"],
      push,
    );
    expect(counts.put).toBe(1);
  });
});
