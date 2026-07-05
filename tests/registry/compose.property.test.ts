// tests/registry/compose.property.test.ts — Effective_Config 合成（src/registry/compose.ts）の property test。
//
// このファイルは composeEffectiveConfig の property を 1 property = 1 describe ブロックで束ねる。
//   - Property 10 : 合成は純粋・完全・値域内                                    ← 本タスク（10.2）
//   - Property 11 : enforced 支配（最小 priority が勝ち default は最後の層が勝つ） ← タスク 10.3 で追記
//   - Property 12 : 配列フィールドは丸ごと置換される                            ← タスク 10.4 で追記
//   - Property 13 : 統制解除で Store_Override が復活する                         ← タスク 10.5 で追記
// 後続タスク（10.3 / 10.4 / 10.5）は末尾へ describe を追記するだけで済むよう property ごとに独立させ、
// 生成器（genPolicies / genStoreOverride ほか）はモジュールスコープに置いて追記ブロックから再利用できるようにしてある。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { composeEffectiveConfig } from "../../src/registry/compose";
import type { Policy, PolicyFields, PolicyMode, StoreOverride } from "../../src/registry/ideal";
import type { NonEmptyArray } from "../../src/domain/timer";
import {
  type NoodlePreset,
  UNIT_COUNT_MIN,
  UNIT_COUNT_MAX,
  ARMS_MIN,
  ARMS_MAX,
  TOLERANCE_RATIO_MIN,
  TOLERANCE_RATIO_MAX,
  toUnitCount,
  toArms,
  toToleranceRatio,
  toNoodlePresets,
  DEFAULT_NOODLE_PRESETS,
} from "../../src/domain/store";

// ────────────────────────────────────────────────────────────────────────────
// 再利用可能な生成器（モジュールスコープ）
//
// 合成の入力空間を賢く制約する：
//   ・policyId は有限プールから重複なく採る（priority 同着でも (priority, policyId) が全順序を成し、
//     入力順に依らず決定的に畳めることを担保する。曖昧割当は入口検証で排除済み＝要件3.4）。
//   ・数値フィールドは値域内・値域外の双方を振る（compose は出口で検証関数へ通しクランプするため、
//     値域外入力でも出力が値域内へ収まることまで含めて検査できる）。
//   ・noodlePresets は構造的に妥当な非空配列を生成する（丸ごと置換の単位・要件4.4）。
// 追記される Property 11/12/13 もこれらを再利用する。
// ────────────────────────────────────────────────────────────────────────────

/** Policy 割当に使う policyId の有限プール（重複なく採り、決定的な同着解決を担保する）。 */
export const POLICY_ID_POOL = ["policy-1", "policy-2", "policy-3", "policy-4", "policy-5"] as const;

/** 生成する Policy が属するチェーン（合成は単一チェーンの Policy 群を前提とする・要件4.1）。 */
export const COMPOSE_CHAIN_ID = "chain-compose";

/** Policy の mode（enforced | default）を振る生成器。 */
const genPolicyMode: fc.Arbitrary<PolicyMode> = fc.constantFrom<PolicyMode>("enforced", "default");

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

/** 非空の麺種プリセット列を生成する（NonEmptyArray を型で担保）。再利用可能。 */
export const genNoodlePresets: fc.Arbitrary<NonEmptyArray<NoodlePreset>> = fc
  .tuple(genNoodlePreset, fc.array(genNoodlePreset, { maxLength: 2 }))
  .map(([head, tail]) => [head, ...tail] as NonEmptyArray<NoodlePreset>);

// 値域内外の双方を跨ぐ数値生成器（compose の出口クランプの健全性まで検査するため境界外へ振る）。
const genUnitCountValue = fc.integer({ min: UNIT_COUNT_MIN - 5, max: UNIT_COUNT_MAX + 8 });
const genArmsValue = fc.integer({ min: ARMS_MIN - 5, max: ARMS_MAX + 5 });
const genToleranceValue = fc.integer({ min: TOLERANCE_RATIO_MIN - 10, max: TOLERANCE_RATIO_MAX + 30 });

/** mode 付きの数値フィールド主張を生成するヘルパ。 */
function genModedNumber(valueArb: fc.Arbitrary<number>): fc.Arbitrary<{ mode: PolicyMode; value: number }> {
  return fc.record({ mode: genPolicyMode, value: valueArb });
}

/**
 * PolicyFields — Policy が主張するフィールドの部分集合（各フィールドは任意）。
 * requiredKeys: [] により「何も主張しない Policy」から「全フィールド主張」まで振る。再利用可能。
 */
export const genPolicyFields: fc.Arbitrary<PolicyFields> = fc.record(
  {
    unitCount: genModedNumber(genUnitCountValue),
    arms: genModedNumber(genArmsValue),
    toleranceRatio: genModedNumber(genToleranceValue),
    noodlePresets: fc.record({ mode: genPolicyMode, value: genNoodlePresets }),
  },
  { requiredKeys: [] },
);

/**
 * genPolicies — priority を有限プールから振り、policyId を重複なく採った Policy 群を生成する。
 *
 * priority は同着（重なり）が起きるよう狭い範囲から採り、(priority, policyId) の全順序による
 * 決定的な畳み込みを検査対象に含める。追記される Property 11/12/13 でも再利用する。
 */
export const genPolicies: fc.Arbitrary<readonly Policy[]> = fc
  .uniqueArray(fc.constantFrom(...POLICY_ID_POOL), { maxLength: POLICY_ID_POOL.length })
  .chain((ids) =>
    fc.tuple(
      ...ids.map((policyId) =>
        fc.record({
          policyId: fc.constant(policyId),
          chainId: fc.constant(COMPOSE_CHAIN_ID),
          name: fc.constant(`Policy ${policyId}`),
          priority: fc.integer({ min: 0, max: 3 }), // 狭い範囲で同着を誘発する
          fields: genPolicyFields,
        }),
      ),
    ),
  );

/**
 * genStoreOverride — Store_Override を生成する。各フィールドは任意（requiredKeys: []）で、
 * 数値は値域内外の双方を振る（合成の最終層。ロック外フィールドへの適用と出口クランプを検査する）。再利用可能。
 */
export const genStoreOverride: fc.Arbitrary<StoreOverride> = fc.record(
  {
    unitCount: genUnitCountValue,
    arms: genArmsValue,
    toleranceRatio: genToleranceValue,
    noodlePresets: genNoodlePresets,
  },
  { requiredKeys: [] },
);

// ── 合成入力（Policy 群 + Override）と、その Policy 群の置換（順序非依存の検査用） ──
// shuffledSubarray に元配列と min=max=length を与えると全要素の置換（permutation）が得られる。
const genComposeInput = genPolicies.chain((policies) =>
  fc.record({
    policies: fc.constant(policies),
    shuffled: fc.shuffledSubarray([...policies], { minLength: policies.length, maxLength: policies.length }),
    override: genStoreOverride,
  }),
);

/** 生成された値が構造的に妥当な NoodlePreset 配列（非空・各要素が健全）であることを検証する。 */
function isValidNoodlePresets(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((preset) => {
    if (typeof preset !== "object" || preset === null) return false;
    const p = preset as Record<string, unknown>;
    if (typeof p.noodleType !== "string" || p.noodleType.length === 0) return false;
    const boil = p.boilSeconds;
    if (typeof boil !== "object" || boil === null) return false;
    const b = boil as Record<string, unknown>;
    return (["extraHard", "hard", "normal", "soft"] as const).every((firmness) => {
      const sec = b[firmness];
      return typeof sec === "number" && Number.isInteger(sec) && sec > 0;
    });
  });
}

describe("registry/compose — composeEffectiveConfig", () => {
  // Feature: per-store-provisioning, Property 10: 合成は純粋・完全・値域内
  // **Validates: Requirements 4.1, 4.5**
  //
  // composeEffectiveConfig は同入力に同出力（決定的・順序非依存）で、出力は StoreConfig の全フィールドを
  // 持ち各値が対応検証関数の値域に収まる。次の 4 つを同時に検査する：
  //   1. 決定性     — 同一入力での二度呼びが構造的に等しい（toEqual）。
  //   2. 順序非依存 — Policy 群を置換しても出力が変わらない（(priority, policyId) の全順序で畳むため）。
  //   3. 完全性     — 出力は unitCount / arms / toleranceRatio / noodlePresets の全フィールドを持つ。
  //   4. 値域内     — 各数値は検証関数の値域に収まり、noodlePresets は構造的に妥当な非空配列。
  it("Property 10: 合成は決定的・順序非依存で、完全な StoreConfig を値域内で返す", () => {
    fc.assert(
      fc.property(genComposeInput, ({ policies, shuffled, override }) => {
        const result = composeEffectiveConfig(policies, override);

        // 1. 決定性：同一入力の二度呼びは構造的に等しい。
        const again = composeEffectiveConfig(policies, override);
        expect(again).toEqual(result);

        // 2. 順序非依存：Policy 群を置換しても出力は不変（畳み込みが (priority, policyId) の全順序に依るため）。
        const reordered = composeEffectiveConfig(shuffled, override);
        expect(reordered).toEqual(result);

        // 3. 完全性：全 4 フィールドが定義済み。
        expect(result.unitCount).toBeDefined();
        expect(result.arms).toBeDefined();
        expect(result.toleranceRatio).toBeDefined();
        expect(result.noodlePresets).toBeDefined();

        // 4. 値域内：各数値は対応検証関数の値域（min..max）に収まる。
        expect(Number.isInteger(result.unitCount)).toBe(true);
        expect(result.unitCount).toBeGreaterThanOrEqual(UNIT_COUNT_MIN);
        expect(result.unitCount).toBeLessThanOrEqual(UNIT_COUNT_MAX);

        expect(Number.isInteger(result.arms)).toBe(true);
        expect(result.arms).toBeGreaterThanOrEqual(ARMS_MIN);
        expect(result.arms).toBeLessThanOrEqual(ARMS_MAX);

        expect(Number.isInteger(result.toleranceRatio)).toBe(true);
        expect(result.toleranceRatio).toBeGreaterThanOrEqual(TOLERANCE_RATIO_MIN);
        expect(result.toleranceRatio).toBeLessThanOrEqual(TOLERANCE_RATIO_MAX);

        // 4. 値域内：noodlePresets は構造的に妥当な非空配列。
        expect(isValidNoodlePresets(result.noodlePresets)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Property 11 — enforced 支配の参照オラクル（単一フィールドの勝者「生値」）
//
// compose の畳み順（priority 昇順・同着は policyId 昇順で畳み、enforced はその場で確定してロックし
// 後続を無視する）から、あるフィールドの「勝つ生値」を独立に導く参照実装。compose と同じ検証関数を
// 最後に一度だけ通して比較するため、生成値が値域外でも（出口クランプ後の）一致を厳密に判定できる。
//
//   ・enforced 主張層があれば → 最小 (priority, policyId) の enforced 層の値（＝畳み順で最初にロックする層）。
//     後続の default 主張・Store_Override は無視される（要件4.2 / 4.3）。
//   ・enforced 主張が無ければ → Store_Override が主張すればその値（ロック外の最終層・要件4.7）、
//     無ければ最大 (priority, policyId) の主張層の値（default は後の層が上書きするため）、
//     いずれも無ければ undefined（検証関数が DEFAULT_* へ畳む＝出力完全性・要件4.5）。
// ────────────────────────────────────────────────────────────────────────────

/** enforced 支配を厳密比較する数値フィールド（noodlePresets は配列で Property 12＝タスク 10.4 が担う）。 */
const NUMERIC_FIELDS = ["unitCount", "arms", "toleranceRatio"] as const;
type NumericField = (typeof NUMERIC_FIELDS)[number];

/** 単一フィールドについて compose が採るはずの「勝つ生値」を独立に導く参照オラクル。 */
function oracleWinningRaw(
  policies: readonly Policy[],
  override: StoreOverride,
  field: NumericField,
): unknown {
  // enforced を主張する層があれば、畳み順の先頭＝最小 (priority, policyId) がロックして勝つ（後続は無視）。
  const enforced = policies.filter((p) => p.fields[field]?.mode === "enforced");
  if (enforced.length > 0) {
    const winner = enforced.reduce((best, p) =>
      p.priority < best.priority || (p.priority === best.priority && p.policyId < best.policyId) ? p : best,
    );
    return winner.fields[field]?.value;
  }
  // enforced 無し：Store_Override はロック外の最終層として default 主張より後に適用される（統制解除で復活・要件4.7）。
  if (override[field] !== undefined) return override[field];
  // Override も無ければ、default を主張する層のうち畳み順の最後＝最大 (priority, policyId) が勝つ。
  const asserting = policies.filter((p) => p.fields[field] !== undefined);
  if (asserting.length === 0) return undefined; // どの層も主張しない → 検証関数が DEFAULT_* へ畳む
  const winner = asserting.reduce((best, p) =>
    p.priority > best.priority || (p.priority === best.priority && p.policyId > best.policyId) ? p : best,
  );
  return winner.fields[field]?.value;
}

/** フィールドごとの出口検証関数（compose と同一）。オラクルの生値をクランプして厳密比較する（値域外も一致判定可能）。 */
const FIELD_VALIDATOR: Readonly<Record<NumericField, (raw: unknown) => number>> = {
  unitCount: toUnitCount,
  arms: toArms,
  toleranceRatio: toToleranceRatio,
};

describe("registry/compose — enforced 支配（Property 11）", () => {
  // Feature: per-store-provisioning, Property 11: enforced 支配（最小 priority が勝ち default は最後の層が勝つ）
  // **Validates: Requirements 4.2, 4.3**
  //
  // あるフィールドを enforced 主張する層があるとき出力はその最小 priority の enforced 層の値に等しく後続を無視する。
  // enforced 主張が無いフィールドは、Store_Override（あれば）→ 最大 priority の主張層 → DEFAULT_* の順で決まる。
  // 各数値フィールド（unitCount / arms / toleranceRatio）について、独立に導いたオラクル値との厳密一致を検査する。
  it("Property 11: 各フィールドは enforced 最小 priority 層／Override／default 最大 priority 層／DEFAULT の順で決まる", () => {
    fc.assert(
      fc.property(genPolicies, genStoreOverride, (policies, override) => {
        const result = composeEffectiveConfig(policies, override);
        for (const field of NUMERIC_FIELDS) {
          const expected = FIELD_VALIDATOR[field](oracleWinningRaw(policies, override, field));
          expect(result[field]).toBe(expected);
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Property 12 — 配列フィールド（noodlePresets）は丸ごと置換される
//
// noodlePresets は「不可分の単位」であり、層をまたぐ要素マージを行わない（要件4.4）。複数層が noodlePresets を
// 主張しても、出力は勝った単一層の配列と要素まで完全一致する。勝者規則は数値フィールドと同一（Property 11）：
//   ・enforced 主張層があれば → 最小 (priority, policyId) の enforced 層の配列（後続・Override を無視）。
//   ・無ければ → Store_Override が主張すればその配列（ロック外の最終層）、無ければ最大 (priority, policyId) の
//     default 主張層の配列、いずれも無ければ DEFAULT_NOODLE_PRESETS。
//
// マージ不在を検出可能にするため、各層のプリセットには層固有の noodleType（policyId / "override" タグ）を与える。
// もし実装が層をまたいで要素を連結／マージすれば、勝者単一層の配列とは要素・長さが食い違い toEqual が破れる。
// ────────────────────────────────────────────────────────────────────────────

/** 層固有タグ付きの非空プリセット列を生成する（各要素の noodleType に tag を刻み、層をまたぐマージを検出可能にする）。 */
function genTaggedNoodlePresets(tag: string): fc.Arbitrary<NonEmptyArray<NoodlePreset>> {
  return fc
    .array(genBoilSeconds, { minLength: 1, maxLength: 3 })
    .map((secondsList) => {
      const [head, ...tail] = secondsList.map((boilSeconds, i) => ({
        noodleType: `${tag}-${i}`,
        boilSeconds,
      }));
      return [head, ...tail] as NonEmptyArray<NoodlePreset>;
    });
}

/**
 * genPresetLayers — noodlePresets を必ず主張する Policy 群を生成する（複数層が主張する状況を確実に作る）。
 * priority は狭い範囲から採り同着を誘発し、policyId を層固有タグとして各配列に刻む（層ごとに内容が異なる）。
 */
const genPresetLayers: fc.Arbitrary<readonly Policy[]> = fc
  .uniqueArray(fc.constantFrom(...POLICY_ID_POOL), {
    minLength: 1,
    maxLength: POLICY_ID_POOL.length,
  })
  .chain((ids) =>
    fc.tuple(
      ...ids.map((policyId) =>
        fc.record({
          policyId: fc.constant(policyId),
          chainId: fc.constant(COMPOSE_CHAIN_ID),
          name: fc.constant(`Policy ${policyId}`),
          priority: fc.integer({ min: 0, max: 3 }), // 同着を誘発する
          fields: fc.record({
            noodlePresets: fc.record({
              mode: genPolicyMode,
              value: genTaggedNoodlePresets(policyId),
            }),
          }),
        }),
      ),
    ),
  );

/** noodlePresets を主張しうる Store_Override（主張する場合は "override" タグの配列）。 */
const genPresetOverride: fc.Arbitrary<StoreOverride> = fc.oneof(
  fc.constant({} as StoreOverride),
  genTaggedNoodlePresets("override").map((noodlePresets) => ({ noodlePresets })),
);

// layers を一度生成し、その置換（permutation）と Override を束ねる（順序非依存の検査用）。
const genPresetScenario = genPresetLayers.chain((layers) =>
  fc.record({
    layers: fc.constant(layers),
    shuffled: fc.shuffledSubarray([...layers], { minLength: layers.length, maxLength: layers.length }),
    override: genPresetOverride,
  }),
);

/**
 * oracleWinningPresets — compose が noodlePresets に採るはずの「勝った単一層の配列」を独立に導く参照オラクル。
 * 勝者の生配列を compose と同一の toNoodlePresets へ通し、出口正規化後の値で厳密比較する（数値オラクルと同形）。
 */
function oracleWinningPresets(
  policies: readonly Policy[],
  override: StoreOverride,
): NonEmptyArray<NoodlePreset> {
  const enforced = policies.filter((p) => p.fields.noodlePresets?.mode === "enforced");
  if (enforced.length > 0) {
    const winner = enforced.reduce((best, p) =>
      p.priority < best.priority || (p.priority === best.priority && p.policyId < best.policyId) ? p : best,
    );
    return toNoodlePresets(winner.fields.noodlePresets?.value);
  }
  if (override.noodlePresets !== undefined) return toNoodlePresets(override.noodlePresets);
  const asserting = policies.filter((p) => p.fields.noodlePresets !== undefined);
  if (asserting.length === 0) return DEFAULT_NOODLE_PRESETS;
  const winner = asserting.reduce((best, p) =>
    p.priority > best.priority || (p.priority === best.priority && p.policyId > best.policyId) ? p : best,
  );
  return toNoodlePresets(winner.fields.noodlePresets?.value);
}

describe("registry/compose — 配列丸ごと置換（Property 12）", () => {
  // Feature: per-store-provisioning, Property 12: 配列フィールドは丸ごと置換される
  // **Validates: Requirements 4.4**
  //
  // 複数層が noodlePresets を主張するとき、出力 noodlePresets は勝った単一層の配列と要素まで完全一致する
  // （層をまたぐ要素マージが起きない）。各層に層固有 noodleType を刻んであるため、もし連結／マージが起きれば
  // 勝者単一層の配列と食い違い toEqual が破れる。順序非依存（Property 群を置換しても勝者は不変）も併せて検査する。
  it("Property 12: noodlePresets は勝った単一層の配列と要素まで完全一致する（要素マージなし）", () => {
    fc.assert(
      fc.property(genPresetScenario, ({ layers, shuffled, override }) => {
        const result = composeEffectiveConfig(layers, override);
        const expected = oracleWinningPresets(layers, override);

        // 勝った単一層の配列と要素まで完全一致（層をまたぐ要素マージが起きない）。
        expect(result.noodlePresets).toEqual(expected);

        // 順序非依存：Policy 群を置換しても勝者配列は変わらない（(priority, policyId) の全順序で畳むため）。
        const reordered = composeEffectiveConfig(shuffled, override);
        expect(reordered.noodlePresets).toEqual(expected);
      }),
      { numRuns: 200 },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Property 13 — 統制解除で Store_Override が復活する
//
// enforced はその層でフィールドをロックし、以後の層・Store_Override を無視する（要件4.2）。ゆえに
// あるフィールド `f` を enforced 主張する層があるとき、合成は保持されている override.f を無視する。
// その enforced 主張を「同一イデアから取り除く」（統制解除）と、`f` を主張する層が Override だけになり、
// Override はロック外の最終層として復活し、出力 `f` は override.f を（出口検証関数でクランプして）反映する（要件4.7）。
//
// 検査を「観測可能」にするため、対象フィールド `f` の enforcedValue と override.f を「値域内で相異なる」
// 2 値として生成する（クランプ後も相異なる＝復活が出力の変化として現れる）。さらに `f` は enforced 層と
// Override 以外のどの層も主張しないよう、基底 Policy 群から `f` を剥がして生成する（勝者を一意に固定する）。
//
// 二つの合成は「同一イデアから enforced 主張だけを差し引いた」対で構成する：
//   ・統制あり  : 基底Policy群(f剥がし) + 「f を enforced 主張する層」  → 出力 f === validator(enforcedValue)（override 無視）
//   ・統制解除  : 基底Policy群(f剥がし) + 「その層から f 主張を取り除いた層」 → 出力 f === validator(overrideValue)（Override 復活）
// ────────────────────────────────────────────────────────────────────────────

/** 対象数値フィールドごとの「値域内」生成器（相異なる 2 値を採り、クランプ後も相異なることを担保する）。 */
const IN_RANGE_VALUE: Readonly<Record<NumericField, fc.Arbitrary<number>>> = {
  unitCount: fc.integer({ min: UNIT_COUNT_MIN, max: UNIT_COUNT_MAX }),
  arms: fc.integer({ min: ARMS_MIN, max: ARMS_MAX }),
  toleranceRatio: fc.integer({ min: TOLERANCE_RATIO_MIN, max: TOLERANCE_RATIO_MAX }),
};

/** Policy から単一フィールド `field` の主張だけを取り除いた Policy を返す（他フィールド・メタは不変）。 */
function withoutField(policy: Policy, field: NumericField): Policy {
  const { [field]: _removed, ...rest } = policy.fields;
  return { ...policy, fields: rest };
}

/**
 * genRevivalScenario — 統制解除で Override が復活する状況を賢く構成する生成器。
 *
 *   ・field         : 対象数値フィールド（unitCount / arms / toleranceRatio）。
 *   ・enforcedValue / overrideValue : 値域内で相異なる 2 値（クランプ後も相異なる＝復活が観測可能）。
 *   ・basePolicies  : 基底 Policy 群。対象 field を剥がし、勝者が enforced 層 or Override に一意に固定されるようにする。
 *   ・enforcedLayer : 対象 field を enforcedValue で enforced 主張する層（統制あり合成にのみ加える）。
 *   ・override      : 対象 field を overrideValue で主張する Store_Override（両合成で共通・同一イデア）。
 */
const genRevivalScenario = fc
  .record({
    field: fc.constantFrom<NumericField>(...NUMERIC_FIELDS),
    basePolicies: genPolicies,
    baseOverride: genStoreOverride,
    enforcedPriority: fc.integer({ min: 0, max: 3 }),
  })
  .chain(({ field, basePolicies, baseOverride, enforcedPriority }) =>
    fc
      .tuple(IN_RANGE_VALUE[field], IN_RANGE_VALUE[field])
      .filter(([enforcedValue, overrideValue]) => enforcedValue !== overrideValue)
      .map(([enforcedValue, overrideValue]) => {
        // 基底 Policy 群から対象 field を剥がし、field を主張するのは enforced 層と Override だけにする（勝者を一意化）。
        const strippedBase = basePolicies.map((p) => withoutField(p, field));
        // field を enforcedValue で enforced 主張する層（POLICY_ID_POOL 外の一意 id で同着解決に影響させない）。
        const enforcedLayer: Policy = {
          policyId: "policy-enforced-target",
          chainId: COMPOSE_CHAIN_ID,
          name: "Policy enforcing target field",
          priority: enforcedPriority,
          fields: { [field]: { mode: "enforced", value: enforcedValue } },
        };
        // Override は両合成で共通（同一イデア）。対象 field を overrideValue で主張する。
        const override: StoreOverride = { ...baseOverride, [field]: overrideValue };
        return {
          field,
          enforcedValue,
          overrideValue,
          // 統制あり：基底(f剥がし) + enforced 層。
          enforcedPolicies: [...strippedBase, enforcedLayer] as readonly Policy[],
          // 統制解除：同一イデアから enforced 層の f 主張だけを取り除く（＝f を主張する層が Override のみになる）。
          deEnforcedPolicies: [...strippedBase, withoutField(enforcedLayer, field)] as readonly Policy[],
          override,
        };
      }),
  );

describe("registry/compose — 統制解除で Override 復活（Property 13）", () => {
  // Feature: per-store-provisioning, Property 13: 統制解除で Store_Override が復活する
  // **Validates: Requirements 4.7**
  //
  // フィールド `f` を enforced 主張する層があるときの合成は override を無視し、その enforced 主張を取り除いた
  // 同一イデアの合成は保持されていた override.f を反映する。enforcedValue と override.f を値域内の相異なる
  // 2 値にして復活を観測可能にする（統制ありでは enforced 値・統制解除では override 値が出力 f に現れる）。
  it("Property 13: enforced 主張の除去で、無視されていた override.f が出力に復活する", () => {
    fc.assert(
      fc.property(
        genRevivalScenario,
        ({ field, enforcedValue, overrideValue, enforcedPolicies, deEnforcedPolicies, override }) => {
          const validate = FIELD_VALIDATOR[field];

          // 統制あり：enforced 層が f をロックし、override.f は無視される（出力 f は enforced 値）。
          const enforced = composeEffectiveConfig(enforcedPolicies, override);
          expect(enforced[field]).toBe(validate(enforcedValue));
          // 相異なる 2 値ゆえ、override.f は反映されていない（無視の確認）。
          expect(enforced[field]).not.toBe(validate(overrideValue));

          // 統制解除：同一イデアから enforced 主張を取り除くと、Override がロック外の最終層として復活する。
          const deEnforced = composeEffectiveConfig(deEnforcedPolicies, override);
          expect(deEnforced[field]).toBe(validate(overrideValue));
        },
      ),
      { numRuns: 200 },
    );
  });
});
