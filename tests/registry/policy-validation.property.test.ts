// tests/registry/policy-validation.property.test.ts — 曖昧な Policy 割当検出（src/registry/policy-conflict.ts）の property test。
//
// このファイルは曖昧割当検出の property を束ねる。
//   - Property 6 : detectAmbiguousAssignment（曖昧な Policy 割当の検出）  ← 本タスク（9.3）
//
// 検出関数は純粋（作用なし）ゆえ既定 pool で走る。iff（同値）を独立した参照 oracle との比較で検査する。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { detectAmbiguousAssignment } from "../../src/registry/policy-conflict";
import type { Policy, PolicyFields, PolicyMode } from "../../src/registry/ideal";
import type { NonEmptyArray } from "../../src/domain/timer";
import type { NoodlePreset } from "../../src/domain/store";

// ── 生成の母集団 ──
// priority は小さなプールに絞る（同着 priority を高頻度で発生させ「曖昧あり」経路を厚く踏む）。
// フィールドは {unitCount, arms, toleranceRatio, noodlePresets} の部分集合を主張し、mode は enforced/default。
// policyId は添字採番で全 Policy 一意（＝互いに distinct）を保証する（イデアの policyId 一意性）。
const PRIORITY_POOL = [0, 1, 2] as const;
const FIELD_NAMES = ["unitCount", "arms", "toleranceRatio", "noodlePresets"] as const;
type FieldName = (typeof FIELD_NAMES)[number];

const genMode: fc.Arbitrary<PolicyMode> = fc.constantFrom("enforced", "default");

/** 全 4 硬さの正の整数秒（FirmnessSeconds 相当）。 */
const genBoilSeconds = fc.record({
  extraHard: fc.integer({ min: 1, max: 300 }),
  hard: fc.integer({ min: 1, max: 300 }),
  normal: fc.integer({ min: 1, max: 300 }),
  soft: fc.integer({ min: 1, max: 300 }),
});

/** NoodlePreset（麺種＋硬さ別秒）。 */
const genNoodlePreset: fc.Arbitrary<NoodlePreset> = fc.record({
  noodleType: fc.string({ minLength: 1, maxLength: 8 }),
  boilSeconds: genBoilSeconds,
});

/** 非空の麺種プリセット列（NonEmptyArray を型で担保）。 */
const genNoodlePresets: fc.Arbitrary<NonEmptyArray<NoodlePreset>> = fc
  .tuple(genNoodlePreset, fc.array(genNoodlePreset, { maxLength: 2 }))
  .map(([head, tail]) => [head, ...tail] as NonEmptyArray<NoodlePreset>);

/**
 * PolicyFields を生成する。各フィールドは任意（requiredKeys: []）で、部分集合（空集合を含む）を主張する。
 * 値は検出に無関係（検出は「主張されたフィールド名」だけを見る）だが、妥当なイデアとして値域内で振る。
 */
const genPolicyFields: fc.Arbitrary<PolicyFields> = fc.record(
  {
    unitCount: fc.record({ mode: genMode, value: fc.integer({ min: 1, max: 4 }) }),
    arms: fc.record({ mode: genMode, value: fc.integer({ min: 1, max: 10 }) }),
    toleranceRatio: fc.record({ mode: genMode, value: fc.integer({ min: 1, max: 50 }) }),
    noodlePresets: fc.record({ mode: genMode, value: genNoodlePresets }),
  },
  { requiredKeys: [] },
);

/** 0..N 件の Policy 群。policyId は添字採番ゆえ全 Policy が互いに distinct。 */
const genPolicies: fc.Arbitrary<readonly Policy[]> = fc
  .array(
    fc.record({
      priority: fc.constantFrom(...PRIORITY_POOL),
      fields: genPolicyFields,
    }),
    { maxLength: 8 },
  )
  .map((specs) =>
    specs.map(
      (spec, index): Policy => ({
        policyId: `policy-${index}`,
        chainId: "chain-a",
        name: `Policy ${index}`,
        priority: spec.priority,
        fields: spec.fields,
      }),
    ),
  );

/** Policy が実際に主張しているフィールド名の集合（値が存在するもの）。 */
function assertedFields(policy: Policy): Set<FieldName> {
  return new Set(FIELD_NAMES.filter((f) => policy.fields[f as keyof PolicyFields] !== undefined));
}

/**
 * 独立した参照 oracle（曖昧さの定義そのもの）。
 * 曖昧 ⇔ ∃ 相異なる 2 Policy が「同一 priority」かつ「少なくとも 1 つの共通フィールド」を主張する。
 * detectAmbiguousAssignment の内部構造（Map による集約）には依らず、Policy 対の総当たりで直接判定する。
 */
function oracleAmbiguous(policies: readonly Policy[]): boolean {
  for (let i = 0; i < policies.length; i++) {
    for (let j = i + 1; j < policies.length; j++) {
      const a = policies[i]!;
      const b = policies[j]!;
      if (a.priority !== b.priority) continue;
      const fieldsB = assertedFields(b);
      for (const field of assertedFields(a)) {
        if (fieldsB.has(field)) return true; // 同一 priority で共通フィールドを主張 → 曖昧
      }
    }
  }
  return false;
}

describe("registry/policy-conflict — detectAmbiguousAssignment", () => {
  // Feature: per-store-provisioning, Property 6: 曖昧な Policy 割当の検出
  // **Validates: Requirements 3.4**
  //
  // 店舗への Policy 割当集合について、同一 priority かつ同一フィールドを主張する 2 つ以上の Policy が
  // 存在するとき、かつそのときに限り（iff）入口検証が拒否する。検出関数はその判定の純粋核であり、
  // 「拒否する ⇔ detectAmbiguousAssignment(policies).length > 0」ゆえ、検出の真偽が独立 oracle と一致することを検査する。
  // 生成は priority を小プールに絞り、フィールド部分集合を振ることで「曖昧あり／なし」の両方向を高頻度で踏む。
  it("Property 6: 曖昧な割当が存在するとき、かつそのときに限り検出される（iff）", () => {
    fc.assert(
      fc.property(genPolicies, (policies) => {
        const detected = detectAmbiguousAssignment(policies).length > 0;
        const expected = oracleAmbiguous(policies);

        // iff（両方向）：曖昧あり → 検出、曖昧なし → 空。
        expect(detected).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });
});
