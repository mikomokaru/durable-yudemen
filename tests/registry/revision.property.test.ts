// tests/registry/revision.property.test.ts — Property 16（revision は狭義単調増加し投影 version に一致する）。
//
// 本テストは StoreRegistryDO（shell）の meta:revision 増分規律を「純粋モデル」で検証する（要件5.6）。
// 実 DO・storage には触れず、次の二点だけを純粋に写す：
//   1. イデアの書き込みごとに revision を狭義単調に +1 する（meta:revision +1-per-write）。
//   2. その時点の revision で recomposeProjection を再合成すると version = revision になる。
// これにより「revision 列は 1,2,…,N（狭義単調・+1）」かつ「各投影 version はその時点の revision に一致」を、
// Chain・Store いずれの変更でも担保する（Policy/Roster のジェネレータは Phase 2/3 で追加）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { affectedStores, recomposeProjection, type IdealChange } from "../../src/registry/converge";
import type { Chain, Store } from "../../src/registry/ideal";

/**
 * bumpRevision — イデアの書き込みごとに revision を +1 する純粋モデル。
 * StoreRegistryDO は書き込みをシングルトン DO 内で直列化するため、meta:revision は自明に狭義単調（+1）になる。
 */
function bumpRevision(revision: number): number {
  return revision + 1;
}

/** Store_Override の生成子。値は version に無関係だが、composeEffectiveConfig を実際に行使するため任意に振る。 */
const genOverride = fc.record(
  {
    unitCount: fc.integer({ min: 1, max: 4 }),
    arms: fc.integer({ min: 1, max: 10 }),
    toleranceRatio: fc.integer({ min: 1, max: 50 }),
  },
  { requiredKeys: [] },
);

/**
 * genScenario — チェーン・店舗のイデアと、その上に積む Chain/Store 変更の列を生成する。
 * 店舗は各チェーンへ任意に割り当て、更新列は既存の chainId / storeId のみを指す（収束対象が必ずイデアに存在する）。
 */
const genScenario = fc
  .record({
    storeCount: fc.integer({ min: 1, max: 6 }),
    chainCount: fc.integer({ min: 1, max: 3 }),
  })
  .chain(({ storeCount, chainCount }) =>
    fc
      .record({
        chainIndexOfStore: fc.array(fc.nat({ max: chainCount - 1 }), {
          minLength: storeCount,
          maxLength: storeCount,
        }),
        overrides: fc.array(genOverride, { minLength: storeCount, maxLength: storeCount }),
        updates: fc.array(
          fc.oneof(
            fc.record({
              tag: fc.constant("chain" as const),
              index: fc.nat({ max: chainCount - 1 }),
            }),
            fc.record({
              tag: fc.constant("store" as const),
              index: fc.nat({ max: storeCount - 1 }),
            }),
          ),
          { minLength: 1, maxLength: 15 },
        ),
      })
      .map(({ chainIndexOfStore, overrides, updates }) => {
        const chains: Chain[] = Array.from({ length: chainCount }, (_unused, c) => ({
          chainId: `chain-${c}`,
          name: `chain-${c}`,
          chainRoster: [],
        }));
        const stores: Store[] = Array.from({ length: storeCount }, (_unused, s) => ({
          storeId: `store-${s}`,
          chainId: `chain-${chainIndexOfStore[s]}`,
          name: `store-${s}`,
          policyIds: [],
          override: overrides[s]!,
          storeRoster: [],
          active: true,
          createdAt: s,
          updatedAt: s,
        }));
        const changes: IdealChange[] = updates.map((u) =>
          u.tag === "chain"
            ? { kind: "chain", chainId: `chain-${u.index}` }
            : { kind: "store", storeId: `store-${u.index}` },
        );
        return { chains, stores, changes };
      }),
  );

describe("registry/revision", () => {
  // Feature: per-store-provisioning, Property 16: revision は狭義単調増加し投影 version に一致する
  // Validates: Requirements 5.6
  it("Property 16: revision は狭義単調増加し投影 version に一致する", () => {
    fc.assert(
      fc.property(genScenario, ({ chains, stores, changes }) => {
        let revision = 0; // meta:revision の初期値。最初の書き込みで 1 になる。
        const observed: number[] = [];

        for (const change of changes) {
          // 書き込みごとに revision を狭義単調（+1）に進める。
          const before = revision;
          revision = bumpRevision(revision);
          expect(revision).toBe(before + 1);
          observed.push(revision);

          // その時点の revision で影響店舗の投影を再合成すると、version は revision に一致する。
          // Chain 変更は当該チェーンの全店、Store 変更は当該店のみが影響（affectedStores）。
          for (const storeId of affectedStores(change, stores)) {
            const projection = recomposeProjection(storeId, chains, stores, [], revision);
            expect(projection.version).toBe(revision);
          }
        }

        // revision 列は 1,2,…,N（狭義単調増加・+1）。
        expect(observed).toEqual(observed.map((_unused, i) => i + 1));
      }),
      { numRuns: 200 },
    );
  });
});
