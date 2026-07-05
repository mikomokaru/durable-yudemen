// tests/client/last-store.property.test.ts
// Feature: per-store-provisioning, Property 19: 前回使用店の記憶の往復
//
// 検証対象は persistence.ts の前回使用店の記憶——rememberLastStore(storeId) と readLastStore()。
// ACCESS OFF 期（Phase 1〜2）に start_url `/` で開いた SPA の唯一の復帰経路の土台であり、
//   - 往復: 妥当な storeId を記憶して読み戻すと同一の storeId が得られる、
//   - 記憶なし: 何も保存されていなければ「記憶なし」= null を返す、
//   - 不正な記憶: 許容形（[a-z0-9-]・長さ 1..64）を外れる保存値は壊れた記憶として null に畳む、
// という「往復と記憶なしへのフォールバック」を主張する（要件7.6）。
//
// localStorage の用意: persistence-scope.property.test.ts と同じく、トランスポート非依存の手製
// インメモリ Storage を globalThis へ差し込む（jsdom は使わない）。fast-check の各試行の冒頭で clear し、
// 試行間の相互汚染（前試行の記憶が次試行へ漏れること）を断つ。
//
// Validates: Requirements 7.6

import * as fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { rememberLastStore, readLastStore } from "../../src/client/persistence";

// ── 手製インメモリ localStorage（端の差し込み） ──────────────────────────────────────────────────

/** persistence.ts が用いる localStorage 面（setItem / getItem）を満たす最小の同期インメモリ実装。 */
class MemoryStorage {
  private readonly store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
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

// ── 前回使用店の記憶の保存キー（実装と同一・直接書き込みで壊れた記憶を模すために用いる） ──────────────
// 実装（persistence.ts）が使う LAST_STORE_KEY と同値。ここを揃えないと「不正な記憶」の直接注入が
// 読み出し先とズレて主張が空振りするため、値を一致させる。
const LAST_STORE_KEY = "yudemen.last-store.v1";

// ── 生成器 ──────────────────────────────────────────────────────────────────────────────────

/** 妥当な storeId — 許容形 [a-z0-9-]・長さ 1..64（storeIdFromPath / 要件1.2 と同一形）。 */
const genValidStoreId: fc.Arbitrary<string> = fc
  .stringMatching(/^[a-z0-9-]{1,64}$/)
  .filter((s) => s.length >= 1 && s.length <= 64);

/**
 * 不正な storeId 値 — 許容形を外れる保存値。壊れた記憶（別用途の値の混入・切り詰め・改竄）を模す。
 * 空文字・許容外文字（大文字・記号・空白・多バイト）・64 文字超過を織り交ぜ、番人が一様に弾くことを主張する。
 */
const genInvalidStoreId: fc.Arbitrary<string> = fc.oneof(
  fc.constant(""), // 空（長さ 0 は許容形の最小 1 を外れる）
  fc.constant("A"), // 大文字（[a-z0-9-] を外れる）
  fc.constant("store_1"), // アンダースコア（許容外記号）
  fc.constant("kobe 3"), // 空白
  fc.constant("店舗"), // 多バイト
  fc.constant("a".repeat(65)), // 64 文字超過
  // 少なくとも一つの許容外文字を確実に含む一般ケース。
  fc
    .string({ minLength: 1, maxLength: 80 })
    .filter((s) => !/^[a-z0-9-]{1,64}$/.test(s)),
);

const NUM_RUNS = 200;

describe("Feature: per-store-provisioning, Property 19: 前回使用店の記憶の往復", () => {
  it("往復: 妥当な storeId を記憶して読み戻すと同一の storeId が得られる", () => {
    fc.assert(
      fc.property(genValidStoreId, (storeId) => {
        // 試行間の相互汚染を断つ（前試行の記憶が残ると往復判定が狂う）。
        memory.clear();

        rememberLastStore(storeId);
        expect(readLastStore()).toBe(storeId);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("記憶なし: 何も保存されていなければ null（記憶なし）を返す", () => {
    memory.clear();
    expect(readLastStore()).toBeNull();
  });

  it("不正な記憶: 許容形を外れる保存値は壊れた記憶として null に畳む", () => {
    fc.assert(
      fc.property(genInvalidStoreId, (invalid) => {
        memory.clear();
        // 番人（rememberLastStore）を迂回し、不正値を保存キーへ直接書き込む（過去の改竄・別用途の混入を模す）。
        localStorage.setItem(LAST_STORE_KEY, invalid);

        expect(readLastStore()).toBeNull();
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
