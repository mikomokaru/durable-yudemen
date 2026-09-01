// tests/registry/ideal.property.test.ts — Property 5（イデアのシリアライズ往復）。
//
// DO の SQLite バックエンド KV は structured clone セマンティクスで値を格納・復元するため、
// イデア（Chain / Policy / Store）が put → get の往復で構造的に不変であることは
// 「structuredClone 往復で元の値と deep-equal になる」ことと同値である。ここでは実 KV の作用ではなく
// structured clone 適合（＝格納可能な純データであること）を既定 pool で検証する（design.md Property 5）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FIRMNESS_ORDER, type Firmness } from "../../src/domain/firmness";
import type { NonEmptyArray } from "../../src/domain/timer";
import type { FirmnessCode, MenuItem, NoodlePreset, NoodleSize } from "../../src/domain/store";
import type {
  Chain,
  Identity,
  ModedValue,
  Policy,
  PolicyFields,
  PolicyMode,
  Roster,
  Store,
  StoreOverride,
} from "../../src/registry/ideal";

// ── イデアの妥当な値を生成する fast-check ジェネレータ群 ──
// いずれも純データ（関数・クラスインスタンスを含まない）で、structured clone で格納可能な形に閉じる。

/** 硬さ別茹で秒（全 4 硬さの正の整数秒）。NoodlePreset.boilSeconds の妥当形。 */
const genFirmnessSeconds: fc.Arbitrary<Readonly<Record<Firmness, number>>> = fc
  .record(
    Object.fromEntries(
      FIRMNESS_ORDER.map((firmness) => [firmness, fc.integer({ min: 1, max: 1800 })]),
    ) as Record<Firmness, fc.Arbitrary<number>>,
  )
  .map((seconds) => seconds as Readonly<Record<Firmness, number>>);

/** NoodlePreset — 非空の麺種名＋硬さ別茹で秒。 */
const genNoodlePreset: fc.Arbitrary<NoodlePreset> = fc.record({
  noodleType: fc.string({ minLength: 1, maxLength: 16 }),
  boilSeconds: genFirmnessSeconds,
});

/** 非空の麺種プリセット列（NonEmptyArray）。配列は丸ごと置換の単位ゆえ要素まで往復保存されるべき。 */
const genNoodlePresets: fc.Arbitrary<NonEmptyArray<NoodlePreset>> = fc
  .array(genNoodlePreset, { minLength: 1, maxLength: 5 })
  .map((presets) => presets as unknown as NonEmptyArray<NoodlePreset>);

/** FirmnessCode — 硬さの商品コード（正の整数）と既知の Firmness の対応 1 件。 */
const genFirmnessCode: fc.Arbitrary<FirmnessCode> = fc.record({
  code: fc.integer({ min: 1, max: 999_999 }),
  firmness: fc.constantFrom(...FIRMNESS_ORDER),
});

/** 硬さ対応表。既定が空ゆえ空配列も妥当な値である（noodlePresets と異なり非空を要求しない）。 */
const genFirmnessCodes: fc.Arbitrary<readonly FirmnessCode[]> = fc.array(genFirmnessCode, {
  maxLength: 5,
});

/** NoodleSize — 麺量の商品コードと妥当域内の slotSpan（1〜6）。 */
const genNoodleSize: fc.Arbitrary<NoodleSize> = fc.record({
  code: fc.integer({ min: 1, max: 999_999 }),
  slotSpan: fc.integer({ min: 1, max: 6 }),
});

/** MenuItem — 親品目の商品コード・麺種・非空の麺量群（入れ子ゆえ往復で要素まで保存されるべき）。 */
const genMenuItem: fc.Arbitrary<MenuItem> = fc.record({
  productCode: fc.integer({ min: 1, max: 999_999 }),
  noodleType: fc.string({ minLength: 1, maxLength: 16 }),
  sizes: fc
    .array(genNoodleSize, { minLength: 1, maxLength: 3 })
    .map((sizes) => sizes as unknown as NonEmptyArray<NoodleSize>),
});

/** メニュー対応表。既定が空ゆえ空配列も妥当な値である。 */
const genMenuItems: fc.Arbitrary<readonly MenuItem[]> = fc.array(genMenuItem, { maxLength: 4 });

/** identity — 不透明な文字列。非 ASCII・空に近い・重複を含みうる（Roster の要素）。 */
const genIdentity: fc.Arbitrary<Identity> = fc.string({ maxLength: 32 });

/** Roster — identity の集合（順序・重複は往復では保存対象。集合意味論の同一視は effectiveRoster の責務）。 */
const genRoster: fc.Arbitrary<Roster> = fc.array(genIdentity, { maxLength: 6 });

/** Policy の mode。 */
const genPolicyMode: fc.Arbitrary<PolicyMode> = fc.constantFrom<PolicyMode[]>(
  "enforced",
  "default",
);

/** mode 付きの値。 */
function genModedValue<T>(valueArb: fc.Arbitrary<T>): fc.Arbitrary<ModedValue<T>> {
  return fc.record({ mode: genPolicyMode, value: valueArb });
}

/** PolicyFields — StoreConfig 相当フィールドの部分集合（各フィールドは任意）。 */
const genPolicyFields: fc.Arbitrary<PolicyFields> = fc.record(
  {
    unitCount: genModedValue(fc.integer({ min: 1, max: 4 })),
    arms: genModedValue(fc.integer({ min: 1, max: 10 })),
    toleranceRatio: genModedValue(fc.integer({ min: 1, max: 50 })),
    noodlePresets: genModedValue(genNoodlePresets),
    firmnessCodes: genModedValue(genFirmnessCodes),
    menuItems: genModedValue(genMenuItems),
  },
  { requiredKeys: [] },
);

/** Policy — priority・フィールドごとの mode/値を持つ。 */
const genPolicy: fc.Arbitrary<Policy> = fc.record({
  policyId: fc.string({ minLength: 1, maxLength: 24 }),
  chainId: fc.string({ minLength: 1, maxLength: 24 }),
  name: fc.string({ maxLength: 32 }),
  priority: fc.integer({ min: -1000, max: 1000 }),
  fields: genPolicyFields,
});

/** Store_Override — 店舗の個別値（部分設定）。 */
const genStoreOverride: fc.Arbitrary<StoreOverride> = fc.record(
  {
    unitCount: fc.integer({ min: 1, max: 4 }),
    arms: fc.integer({ min: 1, max: 10 }),
    toleranceRatio: fc.integer({ min: 1, max: 50 }),
    noodlePresets: genNoodlePresets,
    firmnessCodes: genFirmnessCodes,
    menuItems: genMenuItems,
  },
  { requiredKeys: [] },
);

/** Chain — チェーン Roster を含む組織単位。 */
const genChain: fc.Arbitrary<Chain> = fc.record({
  chainId: fc.string({ minLength: 1, maxLength: 24 }),
  name: fc.string({ maxLength: 32 }),
  chainRoster: genRoster,
});

/** Store — 所属・Policy 割当・Override・店舗 Roster・活性状態・時刻を持つ店舗のイデア。 */
const genStore: fc.Arbitrary<Store> = fc.record(
  {
    storeId: fc.string({ minLength: 1, maxLength: 64 }),
    chainId: fc.string({ minLength: 1, maxLength: 24 }),
    name: fc.string({ maxLength: 32 }),
    policyIds: fc.array(fc.string({ minLength: 1, maxLength: 24 }), { maxLength: 6 }),
    override: genStoreOverride,
    storeRoster: genRoster,
    active: fc.boolean(),
    storeCode: fc.string({ maxLength: 24 }),
    createdAt: fc.integer({ min: 0, max: 4_102_444_800_000 }),
    updatedAt: fc.integer({ min: 0, max: 4_102_444_800_000 }),
  },
  // storeCode は任意（外部マスタ由来）。それ以外は必須。
  {
    requiredKeys: [
      "storeId",
      "chainId",
      "name",
      "policyIds",
      "override",
      "storeRoster",
      "active",
      "createdAt",
      "updatedAt",
    ],
  },
);

/** 妥当な任意のイデア（Chain / Policy / Store のいずれか）。 */
const genIdeal: fc.Arbitrary<Chain | Policy | Store> = fc.oneof(genChain, genPolicy, genStore);

describe("registry/ideal", () => {
  // Feature: per-store-provisioning, Property 5: イデアのシリアライズ往復
  // 妥当な Chain / Policy / Store（Roster・priority・mode 込み）を structured clone で往復させた値は
  // 元の値と構造的に等しい（KV の put → get 往復と同値の性質）。
  it("Property 5: structuredClone 往復はイデアを構造的に保存する", () => {
    fc.assert(
      fc.property(genIdeal, (ideal) => {
        // structured clone（DO の SQLite バックエンド KV の格納セマンティクス）で往復させる。
        expect(structuredClone(ideal)).toEqual(ideal);
      }),
      { numRuns: 200 },
    );
  });
});
