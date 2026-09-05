// tests/client/viewStore.example.test.ts
// Feature: offline-degradation, タスク5.2 の残余 — ViewStore（端）の失敗経路と不正入力
//
// 検証対象は persistence.ts の端 localStorageViewStore(storeId) のうち、**成功路ではない側**——
//   - 不正ブロブ（壊れた JSON・未知 version・型不一致・非オブジェクト・空文字）の再水和、
//   - localStorage.setItem が拒否する状況での save の劣化（例外を投げず・握り潰さず・状態を持たず再試行）、
//   - localStorage.getItem が拒否する状況での load の劣化（EMPTY_VIEW 起点へ畳む）。
//
// 既存テストとの棲み分け:
//   - persistence-scope.property.test.ts は storeId スコープの**往復とフェイルセーフ**（保存 → 読み出しの
//     一致・別店舗 / 未スコープキーの不参照・不在 → EMPTY_VIEW）を担う。ここでは往復を再実装しない。
//   - persistenceCodec.property.test.ts は純粋コーデック（serializeView / parsePersistedView）単体を担う。
//     ここは同じ不正ブロブが **IO を通しても** EMPTY_VIEW に畳まれることだけを見る。
//   - complete.example.test.ts は再水和起点のビュー（degraded 起点）を担う。
//   - IndexedDB / Background Sync 非依存（要件11.4）は offline-degradation.static.test.ts が静的に担う。
//
// property にしないのは、ここで扱うのが localStorage という端の IO であり、振る舞いが入力の値域では
// なく「外部依存が拒否するか否か」で分岐するためである（入力を広げても新しい分岐を踏まない）。
// ただし不正ブロブの類型は generators.ts の genInvalidPersistedBlob が正本であり、自前で作り直さない。
//
// Validates: Requirements 11.2, 11.4

import * as fc from "fast-check";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { localStorageViewStore, scopedStorageKey } from "../../src/client/persistence";
import { EMPTY_VIEW, type ClientView } from "../../src/client/connection";
import { genInvalidPersistedBlob } from "./generators";

// ── 手製インメモリ localStorage（端の差し込み・失敗注入つき） ──────────────────────────────────────

/**
 * persistence.ts が用いる localStorage 面（setItem / getItem）を満たす最小の同期インメモリ実装。
 * 流儀は persistence-scope.property.test.ts と同一。差分は失敗注入の二つのフィールドだけである——
 * 実ブラウザの拒否（容量逼迫・プライベートモード・SecurityError）は端の外側で起きる事実であり、
 * それを再現する経路が無ければ save / load の catch を一度も踏めない。
 */
class MemoryStorage {
  private readonly store = new Map<string, string>();
  /** setItem を拒否させる原因。null なら書き込みは成功する。 */
  writeFailure: Error | null = null;
  /** getItem を拒否させる原因。null なら読み出しは成功する。 */
  readFailure: Error | null = null;
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    if (this.readFailure !== null) throw this.readFailure;
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    if (this.writeFailure !== null) throw this.writeFailure;
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
}

let memory: MemoryStorage;

beforeAll(() => {
  memory = new MemoryStorage();
  // workerd / node いずれの実行 pool でも localStorage は既定で存在しないため、globalThis へ差し込む。
  (globalThis as { localStorage: Storage }).localStorage = memory as unknown as Storage;
});

let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // it 間の相互汚染を断つ（前の it が残したブロブ・失敗注入が次の主張を狂わせる）。
  memory.clear();
  memory.writeFailure = null;
  memory.readFailure = null;
  // 実装は失敗を console.error で観測可能に残す。実出力を汚さずに呼び出しを数えるため差し替える。
  errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── 足場 ────────────────────────────────────────────────────────────────────────────────────

const STORE_ID = "kobe-3";
const KEY = scopedStorageKey(STORE_ID);

/** 永続対象フィールド（timers / offset / processedIds）がすべて非空のビュー。空だと「書けた」ことが空虚になる。 */
const SAVED_VIEW: ClientView = {
  ...EMPTY_VIEW,
  timers: [
    {
      id: "t-1",
      slotIds: ["1"],
      noodleType: "chuka",
      firmness: "normal",
      startTime: 1_000,
      endTime: 61_000,
      origin: "server",
    },
  ],
  offset: 250,
  processedIds: new Set(["t-0"]),
};

/** 容量逼迫による書き込み拒否。実ブラウザの失敗形に名前を合わせる（Safari プライベートモード等）。 */
function quotaExceeded(): Error {
  const rejection = new Error("localStorage quota exceeded");
  rejection.name = "QuotaExceededError";
  return rejection;
}

/** 読み出しそのものの拒否。 */
function readDenied(): Error {
  const rejection = new Error("localStorage access denied");
  rejection.name = "SecurityError";
  return rejection;
}

/** 保存された永続フィールドを主張用に取り出す。 */
function persistedShape(view: ClientView): {
  timers: readonly ClientView["timers"][number][];
  offset: number;
  processedIds: string[];
} {
  return { timers: view.timers, offset: view.offset, processedIds: [...view.processedIds].sort() };
}

/**
 * 不正ブロブの代表。類型の正本は genInvalidPersistedBlob（generators.ts）であり、ここでは
 * 固定 seed で標本を採る——example テストゆえ全域は回さないが、seed 固定で再現性は保つ。
 */
const INVALID_BLOBS: readonly string[] = fc.sample(genInvalidPersistedBlob, {
  numRuns: 32,
  seed: 1102,
});

describe("Feature: offline-degradation, ViewStore（端）の失敗経路と不正入力", () => {
  it("不正ブロブ: 壊れた JSON・未知 version・型不一致・非オブジェクト・空文字はすべて EMPTY_VIEW へ畳む", () => {
    // 標本が一類型へ退化していないこと（複数の類型を実際に踏んでいることの担保）。
    expect(new Set(INVALID_BLOBS).size).toBeGreaterThanOrEqual(8);

    for (const invalid of INVALID_BLOBS) {
      memory.clear();
      // 番人（save）を迂回し、load が読むまさにそのキーへ不正な内容を直接書き込む。
      localStorage.setItem(KEY, invalid);
      // 主張が空振り（キー違いで何も読まれていない）でないことを先に確かめる。
      expect(localStorage.getItem(KEY)).toBe(invalid);

      const loaded = localStorageViewStore(STORE_ID).load();

      expect(loaded).toEqual(EMPTY_VIEW);
      // 再水和後の起点: 接続未確立ゆえ degraded 起点、到達不能理由は分類前の既定（要件15.7）。
      expect(loaded.connectivity).toBe("down");
      expect(loaded.unreachableReason).toBe("offline");
    }
  });

  it("書き込み失敗: setItem が拒否しても save は例外を投げず、ブロブも残さない", () => {
    memory.writeFailure = quotaExceeded();
    const store = localStorageViewStore(STORE_ID);

    // 例外が抜ければ呼び出し側のビュー更新ループ（秒読み・ローカル発火）まで巻き添えに死ぬ。
    expect(() => store.save(SAVED_VIEW)).not.toThrow();

    memory.writeFailure = null;
    expect(localStorage.getItem(KEY)).toBeNull();
    // 対の主張: 拒否がなければ実際に書き込まれる（「何もしない save」でも緑になる空虚を防ぐ）。
    store.save(SAVED_VIEW);
    expect(localStorage.getItem(KEY)).not.toBeNull();
  });

  it("書き込み失敗を握り潰さない: 失敗は console.error で観測可能に残る", () => {
    const store = localStorageViewStore(STORE_ID);

    // 成功時は何も出さない（失敗の観測が失敗に限ることの担保）。
    store.save(SAVED_VIEW);
    expect(errorLog).not.toHaveBeenCalled();

    memory.writeFailure = quotaExceeded();
    store.save(SAVED_VIEW);
    expect(errorLog).toHaveBeenCalledTimes(1);
  });

  it("書き込み失敗を記憶しない: 次のビュー変化で再試行し、成功すれば実際に読み戻せる", () => {
    const store = localStorageViewStore(STORE_ID);

    memory.writeFailure = quotaExceeded();
    store.save(SAVED_VIEW);
    memory.writeFailure = null;

    // 一過性の失敗（容量逼迫の解消等）から回復する。「一度失敗したら以後諦める」実装との差はここに出る。
    store.save(SAVED_VIEW);
    expect(persistedShape(store.load())).toEqual(persistedShape(SAVED_VIEW));
  });

  it("読み出し失敗: getItem が拒否すると妥当なブロブがあっても EMPTY_VIEW 起点へ劣化し、失敗を残す", () => {
    const store = localStorageViewStore(STORE_ID);
    store.save(SAVED_VIEW);
    // 読める状態では再水和できることを先に固める（EMPTY_VIEW が「空のストア」由来でないことの担保）。
    expect(persistedShape(store.load())).toEqual(persistedShape(SAVED_VIEW));

    memory.readFailure = readDenied();
    expect(() => store.load()).not.toThrow();
    expect(store.load()).toEqual(EMPTY_VIEW);
    expect(errorLog).toHaveBeenCalled();

    // 拒否が解ければ再水和は戻る（読み出し不能を記憶しない）。
    memory.readFailure = null;
    expect(persistedShape(store.load())).toEqual(persistedShape(SAVED_VIEW));
  });
});
