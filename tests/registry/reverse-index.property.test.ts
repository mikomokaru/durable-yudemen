// tests/registry/reverse-index.property.test.ts — 逆引きインデックス（src/registry/reverse-index.ts）の property test。
//
// Property 8: 逆引きインデックスはイデアと整合し再構築可能。
//   buildReverseIndex の結果は「全活性店舗の effectiveRoster を走査した参照実装」と一致し、
//   任意 identity e の storesForIdentity(index, e) は「e が実効 Roster に含まれる活性店舗の
//   storeId 集合（登録順）」にちょうど等しく、非活性店舗を含まない。
//   店舗数 1..N（個人店＝1 店チェーンを含む）で振り、同型性（店舗数依存の分岐がないこと）を担保する。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildReverseIndex, storesForIdentity } from "../../src/registry/reverse-index";
import { effectiveRoster } from "../../src/registry/roster";
import type { Chain, Identity, Roster, Store, StoreId } from "../../src/registry/ideal";

// ── 生成の母集団 ──
// チェーン id を有限プールにし、複数店舗が同じチェーン（＝同じチェーン Roster）を共有する状況を作る。
// これにより「チェーン Roster が複数店舗へ和集合として波及する」経路を突く。
const CHAIN_IDS = ["chain-a", "chain-b", "chain-c"] as const;

// identity は非 ASCII・空文字・重複を含む有限プール。重複は effectiveRoster の重複排除を、
// 空文字・非 ASCII は identity を不透明な文字列として扱えることを突く（要件3.5 / 3.6）。
const IDENTITIES = ["honbu", "sv-1", "本部", "店長@例", "", "スタッフ", "dup", "dup"] as const;

// プールに現れない identity（逆引きに登録されないため storesForIdentity は必ず空を返す）。
const ABSENT_IDENTITIES = ["absent-x", "未登録", "no-such-identity"] as const;

/** Roster を生成する。重複を許す（effectiveRoster の重複排除に委ねる）。 */
const genRoster: fc.Arbitrary<Roster> = fc.array(fc.constantFrom(...IDENTITIES), { maxLength: 6 });

/** 影響のある事実（chainId・店舗 Roster・active・createdAt）だけを持つ最小の店舗仕様。 */
interface StoreSpec {
  readonly chainId: string;
  readonly storeRoster: Roster;
  readonly active: boolean;
  readonly createdAt: number;
}

/**
 * 店舗仕様と添字から完全な Store を組む。
 * ・storeId は添字採番（`store-${index}`）で全店一意（イデアの storeId 一意性）。
 * ・createdAt は小さな範囲で振って同着を頻発させ、同着時の storeId 昇順タイブレークを突く。
 */
function buildStore(spec: StoreSpec, index: number): Store {
  return {
    storeId: `store-${index}`,
    chainId: spec.chainId,
    name: `Store ${index}`,
    policyIds: [],
    override: {},
    storeRoster: spec.storeRoster,
    active: spec.active,
    createdAt: spec.createdAt,
    updatedAt: spec.createdAt,
  };
}

/** 全 chainId に対してチェーン Roster を割り当てたチェーン群を生成する（欠落しない完全なイデア）。 */
// CHAIN_IDS と 1:1 で対応する Roster を要素ごとに生成し、チェーン id を既知キーとして引き当てる。
// 可変添字（rosters[i]）は noUncheckedIndexedAccess 下で Roster | undefined に広がるため、
// 各 Roster を既知キー（chainId）で確定して欠落を型レベルに残さない。
const genChains: fc.Arbitrary<readonly Chain[]> = fc
  .tuple(genRoster, genRoster, genRoster)
  .map(([rosterA, rosterB, rosterC]): readonly Chain[] => {
    const rosterByChain = { "chain-a": rosterA, "chain-b": rosterB, "chain-c": rosterC } as const;
    return CHAIN_IDS.map(
      (chainId): Chain => ({ chainId, name: `Chain ${chainId}`, chainRoster: rosterByChain[chainId] }),
    );
  });

/**
 * 1..N 店舗の店舗群を生成する（minLength: 1 で「個人店＝1 店チェーン」の同型ケースを必ず含む）。
 * createdAt は 0..3 の狭い範囲ゆえ同着が頻発し、storeId 昇順タイブレークが走る。
 */
const genStores: fc.Arbitrary<readonly Store[]> = fc
  .array(
    fc.record({
      chainId: fc.constantFrom(...CHAIN_IDS),
      storeRoster: genRoster,
      active: fc.boolean(),
      createdAt: fc.integer({ min: 0, max: 3 }),
    }),
    { minLength: 1, maxLength: 8 },
  )
  .map((specs) => specs.map(buildStore));

/** 妥当なイデア（チェーン群・店舗群）の組。 */
const genIdeal = fc.record({ chains: genChains, stores: genStores });

// ── 独立した参照 oracle ──
// buildReverseIndex の「積み上げ」構造には依存せず、identity ごとに「活性店舗を登録順で filter」する
// 別構造の実装で期待値を導く。順序基準（createdAt 昇順・同着 storeId 昇順）は buildReverseIndex の
// 仕様（reverse-index.ts のドキュメント）に一致させる。

/** 活性店舗を登録順（createdAt 昇順・同着は storeId 昇順）に並べた列を返す（非活性は除外）。 */
function activeStoresInOrder(stores: readonly Store[]): readonly Store[] {
  return stores
    .filter((store) => store.active)
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || (a.storeId < b.storeId ? -1 : a.storeId > b.storeId ? 1 : 0));
}

/**
 * 参照 oracle：identity e に対する期待の店舗リスト。
 * 「e が実効 Roster に含まれる活性店舗の storeId を登録順に並べた列」を filter で直接導く
 * （buildReverseIndex の内部構造に依存しない）。
 */
function expectedStoresForIdentity(
  chainRosterById: Map<string, Roster>,
  orderedActive: readonly Store[],
  identity: Identity,
): readonly StoreId[] {
  return orderedActive
    .filter((store) => effectiveRoster(chainRosterById.get(store.chainId) ?? [], store.storeRoster).includes(identity))
    .map((store) => store.storeId);
}

describe("registry/reverse-index — buildReverseIndex / storesForIdentity", () => {
  // Feature: per-store-provisioning, Property 8: 逆引きインデックスはイデアと整合し再構築可能
  // **Validates: Requirements 3.6, 3.2**
  //
  // 任意のイデア（チェーン群・店舗群、店舗数 1..N）について、
  //   ・出現する各 identity の storesForIdentity は参照 oracle と（順序込みで）一致する
  //   ・プールに無い identity は空配列を返す
  //   ・逆引きに現れる storeId は非活性店舗を一切含まない
  // を検査する。店舗数 1（個人店＝1 店チェーン）から複数まで同じ機構で扱えること（同型性・要件3.2）を、
  // minLength: 1 の店舗生成が担保する。
  it("Property 8: 逆引きは活性店舗の実効 Roster と登録順で整合し、非活性を含まない", () => {
    fc.assert(
      fc.property(genIdeal, ({ chains, stores }) => {
        const index = buildReverseIndex(chains, stores);

        // 参照 oracle の材料（チェーン Roster の引き当て表・登録順の活性店舗列）を独立に用意する。
        const chainRosterById = new Map<string, Roster>(chains.map((c) => [c.chainId, c.chainRoster]));
        const orderedActive = activeStoresInOrder(stores);

        // 出現し得る全 identity（プール）について、順序込みで参照 oracle と一致する。
        for (const identity of new Set<Identity>(IDENTITIES)) {
          const expected = expectedStoresForIdentity(chainRosterById, orderedActive, identity);
          expect(storesForIdentity(index, identity)).toEqual(expected);
        }

        // プールに無い identity は必ず空配列（未登録は空・要件3.6）。
        for (const identity of ABSENT_IDENTITIES) {
          expect(storesForIdentity(index, identity)).toEqual([]);
        }

        // 逆引きに現れる storeId は非活性店舗を一切含まない（active=false は逆引きに出ない・要件3.9 / 6.6）。
        const inactiveIds = new Set<StoreId>(stores.filter((s) => !s.active).map((s) => s.storeId));
        for (const [, reachedStores] of index) {
          for (const storeId of reachedStores) {
            expect(inactiveIds.has(storeId)).toBe(false);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  // Feature: per-store-provisioning, Property 8: 逆引きインデックスはイデアと整合し再構築可能
  // **Validates: Requirements 3.6, 3.2**
  //
  // 再構築可能性（決定的・正本一致）：同一イデアからは常に同一のインデックスが再導出される。
  // 逆引きは名簿変更で必ず再導出される導出値ゆえ、全イデアからいつでも同じ結果を再構築できる（要件3.6）。
  it("Property 8: 同一イデアからの再構築は常に同一インデックスを返す（決定的）", () => {
    fc.assert(
      fc.property(genIdeal, ({ chains, stores }) => {
        const first = buildReverseIndex(chains, stores);
        const second = buildReverseIndex(chains, stores);

        // キー集合が一致する。
        expect(new Set(second.keys())).toEqual(new Set(first.keys()));
        // 各 identity の店舗リストが順序込みで一致する。
        for (const identity of first.keys()) {
          expect(storesForIdentity(second, identity)).toEqual(storesForIdentity(first, identity));
        }
      }),
      { numRuns: 200 },
    );
  });
});
