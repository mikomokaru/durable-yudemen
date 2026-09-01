// tests/registry/converge.property.test.ts — 収束の純粋核（src/registry/converge.ts）の property test。
//
// このファイルは収束核の property を 1 property = 1 describe ブロックで束ねる。
//   - Property 9  : affectedStores（変更の影響店舗を過不足なく逆引きする）  ← 本タスク（2.3）
//   - Property 14 : recomposeProjection（投影の再合成は決定的）             ← タスク 2.4 で追記
//   - Property 15 : nextResidual（残作業の更新規則）                        ← タスク 2.5 で追記
// 後続タスクは末尾へ describe を追記するだけで済むよう、property ごとに独立させている。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { affectedStores, nextResidual, recomposeProjection } from "../../src/registry/converge";
import type { IdealChange, RosterTarget } from "../../src/registry/converge";
import type {
  Chain,
  Policy,
  PolicyFields,
  Store,
  StoreId,
  StoreOverride,
} from "../../src/registry/ideal";
import type { NonEmptyArray } from "../../src/domain/timer";
import type { NoodlePreset } from "../../src/domain/store";

// ── 生成の母集団（有限の chainId / policyId プール）──
// 複数チェーン・多様な Policy 割当を跨いで店舗を振ることで、影響店舗の逆引きが
// 「チェーン一致」「Policy 割当保持」「当該店のみ」の各経路で過不足ないことを検査する。
const CHAIN_IDS = ["chain-a", "chain-b", "chain-c"] as const;
const POLICY_IDS = ["policy-1", "policy-2", "policy-3", "policy-4"] as const;

/** 影響店舗の逆引きに効く事実（chainId・Policy 割当・active）だけを持つ最小の店舗仕様。 */
interface StoreSpec {
  readonly chainId: string;
  readonly policyIds: readonly string[];
  readonly active: boolean;
}

/** 店舗仕様と添字から完全な Store を組む。storeId は添字採番で全店一意を保証する（イデアの storeId 一意性）。 */
function buildStore(spec: StoreSpec, index: number): Store {
  return {
    storeId: `store-${index}`,
    chainId: spec.chainId,
    name: `Store ${index}`,
    policyIds: spec.policyIds,
    override: {}, // affectedStores は override を参照しない（合成は別関数の責務）
    storeRoster: [],
    active: spec.active,
    createdAt: index,
    updatedAt: index,
  };
}

/** 0..N 店舗のイデアを生成する。storeId は添字採番ゆえ重複しない。 */
const genStores: fc.Arbitrary<readonly Store[]> = fc
  .array(
    fc.record({
      chainId: fc.constantFrom(...CHAIN_IDS),
      policyIds: fc.uniqueArray(fc.constantFrom(...POLICY_IDS), { maxLength: POLICY_IDS.length }),
      active: fc.boolean(),
    }),
    { maxLength: 8 },
  )
  .map((specs) => specs.map(buildStore));

/**
 * 店舗集合に対する変更種別を生成する。
 * チェーン／Policy 変更は「存在する id」と「存在しない id」の双方を振り、影響ゼロ（空集合）も検査する。
 * 店舗／店舗名簿変更は既存店舗を対象にする（実在店舗の変更が収束の起点であるため）ので、店舗が 0 のときは出さない。
 */
function genChange(stores: readonly Store[]): fc.Arbitrary<IdealChange> {
  const chainIdArb = fc.constantFrom(...CHAIN_IDS, "chain-absent");
  const policyIdArb = fc.constantFrom(...POLICY_IDS, "policy-absent");

  const branches: fc.Arbitrary<IdealChange>[] = [
    chainIdArb.map((chainId): IdealChange => ({ kind: "chain", chainId })),
    policyIdArb.map((policyId): IdealChange => ({ kind: "policy", policyId })),
    chainIdArb.map((chainId): IdealChange => {
      const target: RosterTarget = { scope: "chain", chainId };
      return { kind: "roster", target };
    }),
  ];

  if (stores.length > 0) {
    const storeIdArb = fc.constantFrom(...stores.map((s) => s.storeId));
    branches.push(storeIdArb.map((storeId): IdealChange => ({ kind: "store", storeId })));
    branches.push(
      storeIdArb.map((storeId): IdealChange => {
        const target: RosterTarget = { scope: "store", storeId };
        return { kind: "roster", target };
      }),
    );
  }

  return fc.oneof(...branches);
}

/** イデア（店舗集合）と、その集合に整合した変更種別の組。 */
const genIdealAndChange = genStores.chain((stores) =>
  fc.record({ stores: fc.constant(stores), change: genChange(stores) }),
);

/**
 * 独立した参照実装（「過不足なく」の oracle）。
 * 「その変更に設定・名簿が依存する全店舗」を、変更種別ごとの依存関係の定義から直接計算する。
 * affectedStores の内部構造には依存しない（依存関係の定義そのものを写す）。
 */
function expectedAffected(change: IdealChange, stores: readonly Store[]): Set<StoreId> {
  switch (change.kind) {
    case "chain":
      // チェーン変更 → そのチェーンに属する全店（設定がチェーン経由の Policy に依存）
      return new Set(stores.filter((s) => s.chainId === change.chainId).map((s) => s.storeId));
    case "policy":
      // Policy 変更 → その Policy を割り当てている全店
      return new Set(
        stores.filter((s) => s.policyIds.includes(change.policyId)).map((s) => s.storeId),
      );
    case "store":
      // 店舗変更 → 当該店のみ（依存するのはその店の設定・名簿）
      return new Set(stores.filter((s) => s.storeId === change.storeId).map((s) => s.storeId));
    case "roster": {
      // 名簿変更 → チェーン名簿なら全店、店舗名簿なら当該店。
      // target を局所 const に束ねてから判別する（filter クロージャ内でも union の narrowing を保つ）。
      const { target } = change;
      return target.scope === "chain"
        ? new Set(stores.filter((s) => s.chainId === target.chainId).map((s) => s.storeId))
        : new Set(stores.filter((s) => s.storeId === target.storeId).map((s) => s.storeId));
    }
  }
}

describe("registry/converge — affectedStores", () => {
  // Feature: per-store-provisioning, Property 9: 変更の影響店舗を過不足なく逆引きする
  // **Validates: Requirements 3.7**
  //
  // 任意のイデアと変更種別（Chain / Policy / Store / Roster）について、affectedStores が返す
  // storeId 集合は「その変更に設定・名簿が依存する全店舗」にちょうど一致する（過剰も欠落もない）。
  // 集合として参照実装と一致し、かつ重複を含まないことを検査する。
  it("Property 9: affectedStores は変更の影響店舗を過不足なく（重複なく）逆引きする", () => {
    fc.assert(
      fc.property(genIdealAndChange, ({ stores, change }) => {
        const result = affectedStores(change, stores);

        // 欠落なし・過剰なし：集合として参照実装に一致する。
        const expected = expectedAffected(change, stores);
        expect(new Set(result)).toEqual(expected);

        // 重複なし：各 Store の storeId は一意ゆえ、返る集合も重複を持たない。
        expect(result.length).toBe(new Set(result).size);
        // サイズ一致（集合等価の裏付け。欠落と過剰の双方を件数で押さえる）。
        expect(result.length).toBe(expected.size);
      }),
      { numRuns: 200 },
    );
  });
});

// ── Property 14 の生成母集団（決定性の検査） ──
// recomposeProjection は最新イデア（chains / stores / policies）と storeId・revision から投影を再合成する。
// 決定性を問うには「妥当なイデアと、そこに実在する storeId」を振り、同一入力での二度の合成が一致することを見る。
// composeEffectiveConfig は override を検証関数でクランプするため、override は値域内外の双方を振ってよい
// （値域外でも決定的にクランプされることまで含めて「同入力→同出力」を検査する）。

/** 全 4 硬さの正の整数秒（FirmnessSeconds 相当）を生成する。 */
const genBoilSeconds = fc.record({
  extraHard: fc.integer({ min: 1, max: 300 }),
  hard: fc.integer({ min: 1, max: 300 }),
  normal: fc.integer({ min: 1, max: 300 }),
  soft: fc.integer({ min: 1, max: 300 }),
});

/** NoodlePreset（麺種＋硬さ別秒）を生成する。 */
const genNoodlePreset: fc.Arbitrary<NoodlePreset> = fc.record({
  noodleType: fc.string({ minLength: 1, maxLength: 8 }),
  boilSeconds: genBoilSeconds,
});

/** 非空の麺種プリセット列を生成する（NonEmptyArray を型で担保）。 */
const genNoodlePresets: fc.Arbitrary<NonEmptyArray<NoodlePreset>> = fc
  .tuple(genNoodlePreset, fc.array(genNoodlePreset, { maxLength: 2 }))
  .map(([head, tail]) => [head, ...tail] as NonEmptyArray<NoodlePreset>);

/**
 * Store_Override を生成する。各フィールドは任意（requiredKeys: []）で、値域内外の双方を振る
 * （合成側のクランプが決定的であることまで込みで決定性を検査するため）。
 */
const genOverride: fc.Arbitrary<StoreOverride> = fc.record(
  {
    unitCount: fc.integer({ min: -5, max: 12 }),
    arms: fc.integer({ min: -5, max: 15 }),
    toleranceRatio: fc.integer({ min: -10, max: 80 }),
    noodlePresets: genNoodlePresets,
  },
  { requiredKeys: [] },
);

/** Policy のフィールド主張（各フィールドは任意）。mode/値を振る（Phase 1 の合成では畳まれないが妥当なイデアとして生成する）。 */
const genPolicyFields: fc.Arbitrary<PolicyFields> = fc.record(
  {
    unitCount: fc.record({
      mode: fc.constantFrom("enforced", "default") as fc.Arbitrary<"enforced" | "default">,
      value: fc.integer({ min: 1, max: 4 }),
    }),
    arms: fc.record({
      mode: fc.constantFrom("enforced", "default") as fc.Arbitrary<"enforced" | "default">,
      value: fc.integer({ min: 1, max: 10 }),
    }),
    toleranceRatio: fc.record({
      mode: fc.constantFrom("enforced", "default") as fc.Arbitrary<"enforced" | "default">,
      value: fc.integer({ min: 1, max: 50 }),
    }),
    noodlePresets: fc.record({
      mode: fc.constantFrom("enforced", "default") as fc.Arbitrary<"enforced" | "default">,
      value: genNoodlePresets,
    }),
  },
  { requiredKeys: [] },
);

/** POLICY_IDS プールから Policy 群を生成する（policyId 一意・chainId は CHAIN_IDS から）。 */
const genPolicies: fc.Arbitrary<readonly Policy[]> = fc
  .uniqueArray(fc.constantFrom(...POLICY_IDS), { maxLength: POLICY_IDS.length })
  .chain((ids) =>
    fc.tuple(
      ...ids.map((policyId) =>
        fc.record({
          policyId: fc.constant(policyId),
          chainId: fc.constantFrom(...CHAIN_IDS),
          name: fc.constant(`Policy ${policyId}`),
          priority: fc.integer({ min: 0, max: 100 }),
          fields: genPolicyFields,
        }),
      ),
    ),
  );

/** CHAIN_IDS からチェーン群を生成する（chainRoster は空。Phase 1 の合成では未使用だが妥当なイデアとして与える）。 */
const genChains: fc.Arbitrary<readonly Chain[]> = fc.constant(
  CHAIN_IDS.map((chainId): Chain => ({ chainId, name: `Chain ${chainId}`, chainRoster: [] })),
);

/** 影響店舗の逆引きに効く事実に override を足した店舗仕様。 */
interface ProjStoreSpec {
  readonly chainId: string;
  readonly policyIds: readonly string[];
  readonly override: StoreOverride;
  readonly active: boolean;
}

/** 店舗仕様と添字から完全な Store を組む（storeId は添字採番で全店一意）。 */
function buildProjStore(spec: ProjStoreSpec, index: number): Store {
  return {
    storeId: `store-${index}`,
    chainId: spec.chainId,
    name: `Store ${index}`,
    policyIds: spec.policyIds,
    override: spec.override,
    storeRoster: [],
    active: spec.active,
    createdAt: index,
    updatedAt: index,
  };
}

/** 1 店以上の店舗イデアを生成する（recomposeProjection は実在 storeId を前提とするため非空）。 */
const genStoresNonEmpty: fc.Arbitrary<readonly Store[]> = fc
  .array(
    fc.record({
      chainId: fc.constantFrom(...CHAIN_IDS),
      policyIds: fc.uniqueArray(fc.constantFrom(...POLICY_IDS), { maxLength: POLICY_IDS.length }),
      override: genOverride,
      active: fc.boolean(),
    }),
    { minLength: 1, maxLength: 6 },
  )
  .map((specs) => specs.map(buildProjStore));

/** 妥当なイデア（chains / stores / policies / revision）と、そこに実在する storeId の組。 */
const genIdealAndStoreId = genStoresNonEmpty.chain((stores) =>
  fc.record({
    chains: genChains,
    stores: fc.constant(stores),
    policies: genPolicies,
    revision: fc.integer({ min: 0, max: 1_000_000 }),
    storeId: fc.constantFrom(...stores.map((s) => s.storeId)),
  }),
);

describe("registry/converge — recomposeProjection", () => {
  // Feature: per-store-provisioning, Property 14: 投影の再合成は決定的（last-write-wins の基盤）
  // **Validates: Requirements 5.4**
  //
  // 同一イデア（chains / stores / policies / revision）と storeId から recomposeProjection は
  // 常に同一の StoreProjection（config・roster・active・version）を返す。二度呼びが構造的に等しいこと
  // （toEqual）で決定性を検査する。決定性が last-write-wins（最新イデアからの再導出で自然収束）の基盤になる。
  it("Property 14: 同一入力からの再合成は常に同一の投影を返す（決定的）", () => {
    fc.assert(
      fc.property(genIdealAndStoreId, ({ chains, stores, policies, revision, storeId }) => {
        const first = recomposeProjection(storeId, chains, stores, policies, revision);
        const second = recomposeProjection(storeId, chains, stores, policies, revision);
        expect(second).toEqual(first);
      }),
      { numRuns: 200 },
    );
  });
});

// ── Property 15 の生成母集団（残作業の更新規則） ──
// nextResidual は (residual, storeId, ok) から次の残作業リストを純粋に導く。
// 単一ステップ（ok=true で除去・ok=false で保持／未収載なら重複なく追加）と、
// その反復適用（成功を漏れなく除去し失敗を保持）の双方を検査する。
// storeId は有限プールから振り、同一 storeId への成功／失敗が交錯する列で「最後の結果が効く」ことを見る。

const RESIDUAL_STORE_IDS = ["store-0", "store-1", "store-2", "store-3", "store-4"] as const;

/** 残作業プールから重複のない storeId 集合を初期残作業として生成する（残作業リストは集合的で重複を持たない）。 */
const genInitialResidual: fc.Arbitrary<readonly StoreId[]> = fc.uniqueArray(
  fc.constantFrom(...RESIDUAL_STORE_IDS),
  { maxLength: RESIDUAL_STORE_IDS.length },
);

/** 押し込み操作（対象 storeId と成否）。プール内の storeId に対して成功／失敗を振る。 */
const genOp: fc.Arbitrary<{ readonly storeId: StoreId; readonly ok: boolean }> = fc.record({
  storeId: fc.constantFrom(...RESIDUAL_STORE_IDS),
  ok: fc.boolean(),
});

/** 押し込み操作の列（0..N 件）。空列（初期残作業がそのまま残る）も含める。 */
const genOps = fc.array(genOp, { maxLength: 20 });

/**
 * 独立した参照実装（反復適用の oracle）。
 * 「その storeId に対する最後の操作が失敗なら残す・成功なら除く。一度も操作されなければ初期残作業のまま」を、
 * nextResidual の内部構造に依らず直接計算する（＝成功を漏れなく除去し失敗を保持する反復規則の定義そのもの）。
 */
function expectedResidual(
  initial: readonly StoreId[],
  ops: readonly { readonly storeId: StoreId; readonly ok: boolean }[],
): Set<StoreId> {
  const inResidual = new Set<StoreId>(initial);
  for (const op of ops) {
    if (op.ok) {
      inResidual.delete(op.storeId);
    } else {
      inResidual.add(op.storeId);
    }
  }
  return inResidual;
}

describe("registry/converge — nextResidual", () => {
  // Feature: per-store-provisioning, Property 15: 残作業の更新規則
  // **Validates: Requirements 5.8**
  //
  // 単一ステップの規則：ok=true は当該 storeId を除去し、ok=false は保持する
  // （未収載なら重複なく追加、既収載なら変えない）。
  it("Property 15: 単一ステップは成功で除去・失敗で保持（重複なく追加）", () => {
    fc.assert(
      fc.property(genInitialResidual, genOp, (residual, op) => {
        const next = nextResidual(residual, op.storeId, op.ok);

        // 残作業は常に集合的（重複を持たない）。
        expect(next.length).toBe(new Set(next).size);

        if (op.ok) {
          // 成功：当該 storeId は必ず除去される。他の要素は保持される。
          expect(next).not.toContain(op.storeId);
          expect(new Set(next)).toEqual(new Set(residual.filter((id) => id !== op.storeId)));
        } else {
          // 失敗：当該 storeId は必ず保持される（未収載なら追加され、既収載なら維持される）。
          expect(next).toContain(op.storeId);
          expect(new Set(next)).toEqual(new Set([...residual, op.storeId]));
        }
      }),
      { numRuns: 200 },
    );
  });

  // Feature: per-store-provisioning, Property 15: 残作業の更新規則
  // **Validates: Requirements 5.8**
  //
  // 反復適用：操作列を畳み込んだ最終残作業は「最後の操作が失敗だった（＝成功で消えていない）storeId 集合」に
  // ちょうど一致する。成功を漏れなく除去し失敗を保持する at-least-once 収束の基盤であることを検査する。
  it("Property 15: 反復適用は成功を漏れなく除去し失敗を保持する", () => {
    fc.assert(
      fc.property(genInitialResidual, genOps, (initial, ops) => {
        const final = ops.reduce<readonly StoreId[]>(
          (residual, op) => nextResidual(residual, op.storeId, op.ok),
          initial,
        );

        // 参照実装（最後の操作が効く規則）と集合として一致する（欠落も過剰もない）。
        expect(new Set(final)).toEqual(expectedResidual(initial, ops));

        // 反復後も残作業は集合的（重複を持たない）。
        expect(final.length).toBe(new Set(final).size);

        // 成功した storeId のうち以後失敗していないものは、必ず除去されている。
        for (const id of RESIDUAL_STORE_IDS) {
          const lastOp = [...ops].reverse().find((op) => op.storeId === id);
          if (lastOp?.ok === true) {
            expect(final).not.toContain(id);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
