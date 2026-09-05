// tests/client/persistence-scope.property.test.ts
// Feature: per-store-provisioning, Property 3: オフライン永続の storeId スコープ（往復とフェイルセーフ）
//
// 検証対象は persistence.ts の store-scoped 永続——localStorageViewStore(storeId) と
// scopedStorageKey(storeId)。保存時 storeId `a` と読み出し時 storeId `b` について、
//   - a = b のときに限り保存ビューの永続フィールド（timers / offset / processedIds）が再水和され、
//   - a ≠ b（および未スコープの旧キー）のときは常に空ビュー（EMPTY_VIEW）が返る、
// という「往復とフェイルセーフ」を主張する（要件1.5 / 1.6）。
//
// localStorage の用意: 既存 client テストはいずれも純粋層のみを扱い localStorage に触れないため、
// 踏襲すべき既成パターンが無い。ここではトランスポート非依存の手製インメモリ Storage を globalThis へ
// 差し込む（jsdom は使わない）。fast-check の各試行の冒頭で clear し、試行間の相互汚染を断つ。
//
// Validates: Requirements 1.5, 1.6

import * as fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import {
  localStorageViewStore,
  scopedStorageKey,
  serializeView,
} from "../../src/client/persistence";
import { EMPTY_VIEW, type ClientTimer, type ClientView } from "../../src/client/connection";
import type { NonEmptyArray } from "../../src/domain/timer";
import type { Firmness } from "../../src/domain/firmness";

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

// ── 生成器（非空の永続フィールドを持つ実 ClientView） ────────────────────────────────────────────

/** storeId プール。小さく取ることで a = b（往復）と a ≠ b（フェイルセーフ）の双方を高頻度で踏む。 */
const STORE_ID_POOL = ["a", "1234", "kobe-3", "z9", "store-x"] as const;
const genStoreId: fc.Arbitrary<string> = fc.constantFrom(...STORE_ID_POOL);

const FIRMNESS_POOL: readonly Firmness[] = ["extraHard", "hard", "normal", "soft"];

/** 時刻は整数のみ（JSON 往復で NaN / Infinity が null 化しないよう有限整数に限る）。 */
const genTime: fc.Arbitrary<number> = fc.integer({ min: -1_000_000, max: 1_000_000 });

/** slotIds — 非空文字列の非空配列（parsePersistedView の受理条件に一致）。 */
const genSlotIds: fc.Arbitrary<NonEmptyArray<string>> = fc
  .tuple(
    fc.string({ minLength: 1, maxLength: 4 }),
    fc.array(fc.string({ minLength: 1, maxLength: 4 }), { maxLength: 2 }),
  )
  .map(([head, tail]) => [head, ...tail] as NonEmptyArray<string>);

/** 永続往復で完全保存される形の ClientTimer（余剰フィールドを持たない）。 */
const genClientTimer: fc.Arbitrary<ClientTimer> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 8 }),
  slotIds: genSlotIds,
  noodleType: fc.string({ minLength: 1, maxLength: 6 }),
  firmness: fc.constantFrom(...FIRMNESS_POOL),
  startTime: genTime,
  endTime: genTime,
  origin: fc.constantFrom("server" as const, "local" as const),
});

/**
 * 非空の永続フィールド（timers / offset / processedIds）を持つ実 ClientView を生成する。
 * 導出・一過性フィールド（connectivity / sync / error / lastResults / unitCount / noodlePresets）は
 * EMPTY_VIEW のベース値に据える——それらは永続されず、往復で復元されないため主張の対象外。
 */
const genView: fc.Arbitrary<ClientView> = fc
  .record({
    timers: fc.array(genClientTimer, { minLength: 1, maxLength: 5 }),
    offset: fc.integer({ min: -500_000, max: 500_000 }),
    processedIds: fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 6 }),
  })
  .map(({ timers, offset, processedIds }) => ({
    ...EMPTY_VIEW,
    timers,
    offset,
    processedIds: new Set(processedIds),
  }));

/** 永続フィールドだけを比較用に取り出す（往復の主張はこの三つに閉じる）。 */
function persistedShape(view: ClientView): {
  timers: readonly ClientTimer[];
  offset: number;
  processedIds: string[];
} {
  return {
    timers: view.timers,
    offset: view.offset,
    processedIds: [...view.processedIds].sort(),
  };
}

const NUM_RUNS = 200;

describe("Feature: per-store-provisioning, Property 3: オフライン永続の storeId スコープ（往復とフェイルセーフ）", () => {
  it("a = b のときに限り保存ビュー（timers / offset / processedIds）が再水和され、a ≠ b は EMPTY_VIEW", () => {
    fc.assert(
      fc.property(genStoreId, genStoreId, genView, (a, b, view) => {
        // 試行間の相互汚染を断つ（前試行の scoped キーが残ると往復判定が狂う）。
        memory.clear();

        // 保存時 storeId a のストアで保存する。
        localStorageViewStore(a).save(view);
        // 読み出し時 storeId b のストアで読み戻す。
        const loaded = localStorageViewStore(b).load();

        if (a === b) {
          // 往復: 保存ビューの永続フィールドがそのまま再水和される。
          expect(persistedShape(loaded)).toEqual(persistedShape(view));
        } else {
          // フェイルセーフ: 別店舗のキーは参照されず、前店舗ビューを再水和せず空ビューへ畳む。
          expect(loaded).toEqual(EMPTY_VIEW);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("未スコープの旧キー（接頭辞のみ）に保存されたビューはどの storeId でも再水和されず EMPTY_VIEW", () => {
    // scopedStorageKey は必ず `${prefix}:${storeId}` を作る。接頭辞のみ（未スコープ）の旧キーはその接頭辞。
    const legacyUnscopedKey = scopedStorageKey("").slice(0, -1); // 末尾の ":" を落とした接頭辞そのもの
    fc.assert(
      fc.property(genStoreId, genView, (storeId, view) => {
        memory.clear();
        // 未スコープの旧キーへ妥当な永続ブロブを直接書き込む（過去バージョンの残存を模す）。
        localStorage.setItem(legacyUnscopedKey, serializeView(view));

        // 現在の storeId でスコープした load は未スコープキーを決して参照しない → 空ビュー（要件1.6）。
        const loaded = localStorageViewStore(storeId).load();
        expect(loaded).toEqual(EMPTY_VIEW);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
