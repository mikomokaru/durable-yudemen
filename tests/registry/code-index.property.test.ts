// tests/registry/code-index.property.test.ts — Store_Code 逆引き（src/registry/code-index.ts）の property test。
//
// Property 5: Code_Index は正本から再構築できる。
//   buildCodeIndex は純粋・決定的に同一の索引を返し、索引を捨てて再導出しても結果が変わらない。
//   非活性店舗も含まれる（Store_Code は全店で一意ゆえ逆引きは活性状態に依らない）。
// Property 6: Store_Code は全店で一意である。
//   衝突する集合は detectDuplicateStoreCodes が必ず検出し、衝突が無ければ空を返す（iff）。
//
// 店舗数 1..N（個人店＝1 店チェーンを含む）で振り、店舗数依存の分岐がないこと（同型性）を担保する。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildCodeIndex,
  detectDuplicateStoreCodes,
  storeForCode,
} from "../../src/registry/code-index";
import type { Store, StoreId } from "../../src/registry/ideal";

// ── 生成の母集団 ──
// Store_Code は有限プールにし、衝突（同一コードを複数店舗が主張する状態）を頻発させる。
// 非 ASCII・記号を含めるのは、外部マスタのコードを不透明な文字列として扱えることを突くため。
const STORE_CODES = ["1001", "1002", "0", "店-甲", "code:with:colon"] as const;

// プールに現れない Store_Code（索引に載らないため storeForCode は必ず undefined を返す）。
const ABSENT_CODES = ["9999", "未登録コード", ""] as const;

/** 影響のある事実（storeCode の有無・active・createdAt）だけを持つ最小の店舗仕様。 */
interface StoreSpec {
  readonly storeCode: string | undefined;
  readonly active: boolean;
  readonly createdAt: number;
}

/**
 * 店舗仕様と添字から完全な Store を組む。
 * ・storeId は添字採番（`store-${index}`）で全店一意（イデアの storeId 一意性）。
 * ・createdAt は狭い範囲で振って同着を頻発させ、同着時の storeId 昇順タイブレークを突く。
 */
function buildStore(spec: StoreSpec, index: number): Store {
  return {
    storeId: `store-${index}`,
    chainId: "chain-a",
    name: `Store ${index}`,
    policyIds: [],
    override: {},
    storeRoster: [],
    active: spec.active,
    ...(spec.storeCode === undefined ? {} : { storeCode: spec.storeCode }),
    createdAt: spec.createdAt,
    updatedAt: spec.createdAt,
  };
}

/** 1..N 店舗の店舗群を生成する（minLength: 1 で「1 店だけ」の同型ケースを必ず含む）。 */
const genStores: fc.Arbitrary<readonly Store[]> = fc
  .array(
    fc.record({
      // undefined を混ぜ、Store_Code を持たない店舗（要件3.8）が索引に載らないことを突く。
      storeCode: fc.constantFrom<string | undefined>(...STORE_CODES, undefined),
      active: fc.boolean(),
      createdAt: fc.integer({ min: 0, max: 3 }),
    }),
    { minLength: 1, maxLength: 8 },
  )
  .map((specs) => specs.map(buildStore));

/** 衝突を持たない店舗群（各店舗の Store_Code を添字から採番して一意にする）。 */
const genUniqueCodeStores: fc.Arbitrary<readonly Store[]> = fc
  .array(
    fc.record({
      hasCode: fc.boolean(),
      active: fc.boolean(),
      createdAt: fc.integer({ min: 0, max: 3 }),
    }),
    { minLength: 1, maxLength: 8 },
  )
  .map((specs) =>
    specs.map((spec, index) =>
      buildStore(
        {
          storeCode: spec.hasCode ? `code-${index}` : undefined,
          active: spec.active,
          createdAt: spec.createdAt,
        },
        index,
      ),
    ),
  );

/**
 * 同一の店舗集合と、その並びだけを入れ替えた列の組。
 * 正本（永続キー `store:*` の列挙）は走査順を保証しないため、索引が入力順に依れば
 * 「索引を捨てて再導出しても結果が変わらない」が破れる。
 */
const genStoresAndShuffled: fc.Arbitrary<readonly [readonly Store[], readonly Store[]]> =
  genStores.chain((stores) =>
    fc
      .shuffledSubarray([...stores], { minLength: stores.length, maxLength: stores.length })
      .map((shuffled) => [stores, shuffled] as const),
  );

describe("registry/code-index — buildCodeIndex / storeForCode", () => {
  // Feature: pos-order-ingress, Property 5: Code_Index は正本から再構築できる
  // **Validates: Requirements 2.1, 2.2, 2.7**
  it("Property 5: 索引は Store_Code を持つ全店（非活性を含む）を載せ、未知コードは undefined を返す", () => {
    fc.assert(
      fc.property(genStores, (stores) => {
        const index = buildCodeIndex(stores);

        // 索引のキー集合は「Store_Code を持つ店舗のコード集合」にちょうど等しい
        // （非活性で絞らない・要件2.7／コード無しは載せない・要件3.8）。
        const claimedCodes = new Set(
          stores
            .map((store) => store.storeCode)
            .filter((code): code is string => code !== undefined),
        );
        expect(new Set(index.keys())).toEqual(claimedCodes);

        // 索引の各値は実在する storeId であり、当該コードを主張した店舗のいずれかである。
        for (const code of claimedCodes) {
          const resolved = storeForCode(index, code);
          const claimants: readonly StoreId[] = stores
            .filter((store) => store.storeCode === code)
            .map((store) => store.storeId);
          expect(resolved).not.toBeUndefined();
          expect(claimants).toContain(resolved);
        }

        // プールに無い Store_Code は必ず undefined（未知はフォールバックしない・要件2.6）。
        for (const code of ABSENT_CODES) {
          if (!claimedCodes.has(code)) {
            expect(storeForCode(index, code)).toBeUndefined();
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  // Feature: pos-order-ingress, Property 5: Code_Index は正本から再構築できる
  // **Validates: Requirements 2.1, 2.2**
  it("Property 5: 同一イデアからの再構築は常に同一索引を返す（決定的）", () => {
    fc.assert(
      fc.property(genStores, (stores) => {
        const first = buildCodeIndex(stores);
        const second = buildCodeIndex([...stores]);

        expect(new Set(second.keys())).toEqual(new Set(first.keys()));
        for (const code of first.keys()) {
          expect(storeForCode(second, code)).toBe(storeForCode(first, code));
        }
      }),
      { numRuns: 200 },
    );
  });

  // Feature: pos-order-ingress, Property 5: Code_Index は正本から再構築できる
  // **Validates: Requirements 2.1, 2.2**
  it("Property 5: 索引は正本の走査順に依らず、正本の列を書き換えない", () => {
    fc.assert(
      fc.property(genStoresAndShuffled, ([stores, shuffled]) => {
        // 並べ替えの検出には浅い複製で足りる（本関数が変えうるのは列の順序だけで、店舗の中身は触らない）。
        const original = [...stores];
        const index = buildCodeIndex(stores);
        const rebuilt = buildCodeIndex(shuffled);

        expect(new Set(rebuilt.keys())).toEqual(new Set(index.keys()));
        for (const code of index.keys()) {
          // 衝突が在っても同じ店舗へ解決する（createdAt 昇順・storeId 昇順の安定化が入力順を吸収する）。
          expect(storeForCode(rebuilt, code)).toBe(storeForCode(index, code));
        }

        // 純粋である＝正本の列を書き換えない（引数の配列上で並べ替えれば呼び出し元の列が壊れる）。
        expect(stores).toEqual(original);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: pos-order-ingress, Property 5: Code_Index は正本から再構築できる
  // **Validates: Requirements 2.7**
  it("Property 5: 非活性店舗の Store_Code も逆引きできる", () => {
    fc.assert(
      fc.property(genUniqueCodeStores, (stores) => {
        // Store_Code が一意ゆえ、各店舗のコードは必ず自身の storeId へ解決する（活性状態に依らない）。
        const index = buildCodeIndex(stores.map((store) => ({ ...store, active: false })));
        for (const store of stores) {
          if (store.storeCode !== undefined) {
            expect(storeForCode(index, store.storeCode)).toBe(store.storeId);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("registry/code-index — detectDuplicateStoreCodes", () => {
  // Feature: pos-order-ingress, Property 6: Store_Code は全店で一意である
  // **Validates: Requirements 3.1, 3.2, 3.5, 3.6**
  it("Property 6: 衝突を必ず検出し、衝突がなければ空を返す", () => {
    fc.assert(
      fc.property(genStores, (stores) => {
        const duplicates = detectDuplicateStoreCodes(stores);

        // 参照 oracle：同一 Store_Code を 2 店以上が主張するコードの集合（活性状態に依らない・要件3.1）。
        const claimantsByCode = new Map<string, StoreId[]>();
        for (const store of stores) {
          if (store.storeCode === undefined) continue;
          const claimants = claimantsByCode.get(store.storeCode) ?? [];
          claimants.push(store.storeId);
          claimantsByCode.set(store.storeCode, claimants);
        }
        const expectedCodes = [...claimantsByCode.entries()]
          .filter(([, claimants]) => claimants.length >= 2)
          .map(([code]) => code)
          .sort();

        expect(duplicates.map((d) => d.storeCode)).toEqual(expectedCodes);

        // 各衝突は関与する storeId を storeId 昇順で余さず列挙する。
        for (const duplicate of duplicates) {
          const claimants = [...(claimantsByCode.get(duplicate.storeCode) ?? [])].sort();
          expect(duplicate.storeIds).toEqual(claimants);
          expect(duplicate.storeIds.length).toBeGreaterThanOrEqual(2);
        }

        // 空を返すことと「全店で一意」であることが同値（iff）。
        expect(duplicates.length === 0).toBe(claimedCodeCount(stores) === claimantsByCode.size);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: pos-order-ingress, Property 6: Store_Code は全店で一意である
  // **Validates: Requirements 3.1, 3.6**
  it("Property 6: 一意な店舗群は衝突を返さず、索引は全コードを載せる", () => {
    fc.assert(
      fc.property(genUniqueCodeStores, (stores) => {
        expect(detectDuplicateStoreCodes(stores)).toEqual([]);
        expect(buildCodeIndex(stores).size).toBe(claimedCodeCount(stores));
      }),
      { numRuns: 200 },
    );
  });
});

/** Store_Code を主張した店舗の件数（衝突があればコード数を上回る）。 */
function claimedCodeCount(stores: readonly Store[]): number {
  return stores.filter((store) => store.storeCode !== undefined).length;
}
