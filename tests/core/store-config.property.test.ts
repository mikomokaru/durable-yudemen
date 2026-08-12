// tests/core/store-config.property.test.ts — StoreConfig 検証関数（src/domain/store.ts）の property test。
//
// 対象は online-cook-scheduling で足した 8 パラメータの to*（重み 3・許容幅 3・unitOrigins・slotOffsets）。
// 検証は workerd に依らない純粋関数ゆえ既定 pool で走る。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AFFINITY_TOLERANCE_DISTANCE_MAX,
  AFFINITY_TOLERANCE_DISTANCE_MIN,
  DEFAULT_AFFINITY_TOLERANCE_DISTANCE,
  DEFAULT_AFFINITY_WEIGHT,
  DEFAULT_ORDER_SYNC_TOLERANCE_SECONDS,
  DEFAULT_ORDER_SYNC_WEIGHT,
  DEFAULT_SLOT_OFFSETS,
  DEFAULT_TABLE_SYNC_TOLERANCE_SECONDS,
  DEFAULT_TABLE_SYNC_WEIGHT,
  GRID_COORDINATE_MIN,
  SLOTS_PER_UNIT,
  SYNC_TOLERANCE_SECONDS_MAX,
  SYNC_TOLERANCE_SECONDS_MIN,
  UNIT_COUNT_MAX,
  UNIT_COUNT_MIN,
  WEIGHT_MAX,
  WEIGHT_MIN,
  defaultUnitOrigins,
  toAffinityToleranceDistance,
  toAffinityWeight,
  toOrderSyncToleranceSeconds,
  toOrderSyncWeight,
  toSlotOffsets,
  toTableSyncToleranceSeconds,
  toTableSyncWeight,
  toUnitOrigins,
  type GridPoint,
} from "../../src/domain/store";

// ────────────────────────────────────────────────────────────────────────────
// パラメータ表 — 各パラメータの妥当域・既定・検証関数を一箇所に束ねる。
//
// property は「あるパラメータへ不正値を差し込んでも他は巻き込まれない」を主張するため、パラメータの集合を
// データとして持ち、キーを振って回す形にする（8 個の it を並べるとパラメータ独立の主張が書けない）。
// ────────────────────────────────────────────────────────────────────────────

/** 数値スカラーのパラメータ表（重み 3・許容幅 3）。妥当域と既定は domain の定数を正本とする。 */
const SCALAR_PARAMS = {
  orderSyncWeight: { validate: toOrderSyncWeight, min: WEIGHT_MIN, max: WEIGHT_MAX, fallback: DEFAULT_ORDER_SYNC_WEIGHT },
  tableSyncWeight: { validate: toTableSyncWeight, min: WEIGHT_MIN, max: WEIGHT_MAX, fallback: DEFAULT_TABLE_SYNC_WEIGHT },
  affinityWeight: { validate: toAffinityWeight, min: WEIGHT_MIN, max: WEIGHT_MAX, fallback: DEFAULT_AFFINITY_WEIGHT },
  orderSyncToleranceSeconds: {
    validate: toOrderSyncToleranceSeconds,
    min: SYNC_TOLERANCE_SECONDS_MIN,
    max: SYNC_TOLERANCE_SECONDS_MAX,
    fallback: DEFAULT_ORDER_SYNC_TOLERANCE_SECONDS,
  },
  tableSyncToleranceSeconds: {
    validate: toTableSyncToleranceSeconds,
    min: SYNC_TOLERANCE_SECONDS_MIN,
    max: SYNC_TOLERANCE_SECONDS_MAX,
    fallback: DEFAULT_TABLE_SYNC_TOLERANCE_SECONDS,
  },
  affinityToleranceDistance: {
    validate: toAffinityToleranceDistance,
    min: AFFINITY_TOLERANCE_DISTANCE_MIN,
    max: AFFINITY_TOLERANCE_DISTANCE_MAX,
    fallback: DEFAULT_AFFINITY_TOLERANCE_DISTANCE,
  },
} as const;

type ScalarKey = keyof typeof SCALAR_PARAMS;
const SCALAR_KEYS = Object.keys(SCALAR_PARAMS) as readonly ScalarKey[];

/** レイアウトのパラメータ（要素ごとに畳む 2 個）。 */
const LAYOUT_KEYS = ["unitOrigins", "slotOffsets"] as const;
type LayoutKey = (typeof LAYOUT_KEYS)[number];

type ParamKey = ScalarKey | LayoutKey;
const PARAM_KEYS: readonly ParamKey[] = [...SCALAR_KEYS, ...LAYOUT_KEYS];

/** 生の設定（各キーが検証前の任意値）。shell の設定ロードが受け取る形を模す。 */
type RawConfig = Readonly<Record<ParamKey, unknown>>;

/** 検証後の設定（8 パラメータ分）。 */
interface ValidatedConfig {
  readonly orderSyncWeight: number;
  readonly tableSyncWeight: number;
  readonly affinityWeight: number;
  readonly orderSyncToleranceSeconds: number;
  readonly tableSyncToleranceSeconds: number;
  readonly affinityToleranceDistance: number;
  readonly unitOrigins: readonly GridPoint[];
  readonly slotOffsets: readonly GridPoint[];
}

/** 生の設定を各 to* へ通す。パラメータごとに独立した検証であることを、この形自体が表している。 */
function validateAll(raw: RawConfig, unitCount: number): ValidatedConfig {
  return {
    orderSyncWeight: toOrderSyncWeight(raw.orderSyncWeight),
    tableSyncWeight: toTableSyncWeight(raw.tableSyncWeight),
    affinityWeight: toAffinityWeight(raw.affinityWeight),
    orderSyncToleranceSeconds: toOrderSyncToleranceSeconds(raw.orderSyncToleranceSeconds),
    tableSyncToleranceSeconds: toTableSyncToleranceSeconds(raw.tableSyncToleranceSeconds),
    affinityToleranceDistance: toAffinityToleranceDistance(raw.affinityToleranceDistance),
    unitOrigins: toUnitOrigins(raw.unitOrigins, unitCount),
    slotOffsets: toSlotOffsets(raw.slotOffsets),
  };
}

// ── 生成器 ──

/** 妥当な格子座標（GRID_COORDINATE_MIN 以上の整数）。上限は設定側に無いが、生成は現実的な範囲に収める。 */
const genGridPoint: fc.Arbitrary<GridPoint> = fc.record({
  x: fc.integer({ min: GRID_COORDINATE_MIN, max: 40 }),
  y: fc.integer({ min: GRID_COORDINATE_MIN, max: 40 }),
});

/** 妥当な生の設定（全パラメータが妥当域内）。unitOrigins は unitCount 個ちょうど、slotOffsets は 6 個。 */
function genValidRaw(unitCount: number): fc.Arbitrary<RawConfig> {
  return fc.record({
    orderSyncWeight: fc.integer({ min: WEIGHT_MIN, max: WEIGHT_MAX }),
    tableSyncWeight: fc.integer({ min: WEIGHT_MIN, max: WEIGHT_MAX }),
    affinityWeight: fc.integer({ min: WEIGHT_MIN, max: WEIGHT_MAX }),
    orderSyncToleranceSeconds: fc.integer({ min: SYNC_TOLERANCE_SECONDS_MIN, max: SYNC_TOLERANCE_SECONDS_MAX }),
    tableSyncToleranceSeconds: fc.integer({ min: SYNC_TOLERANCE_SECONDS_MIN, max: SYNC_TOLERANCE_SECONDS_MAX }),
    affinityToleranceDistance: fc.integer({
      min: AFFINITY_TOLERANCE_DISTANCE_MIN,
      max: AFFINITY_TOLERANCE_DISTANCE_MAX,
    }),
    unitOrigins: fc.array(genGridPoint, { minLength: unitCount, maxLength: unitCount }),
    slotOffsets: fc.array(genGridPoint, { minLength: SLOTS_PER_UNIT, maxLength: SLOTS_PER_UNIT }),
  });
}

/**
 * 使いようのない生値。どのパラメータへ差し込んでも「まるごと既定へ畳まれる」ことを期待できる母集団。
 *
 * スカラーには型不一致・非整数・非有限として、レイアウトには「配列でない」値として効く（どちらも既定へ落ちる）。
 * 空配列もここに含める——レイアウトでは全要素が欠落して全既定になり、スカラーでは型不一致で既定になる。
 * 数値へ解釈できる文字列（"0" や ""）は入れない（それは不正値ではなく妥当な生値である）。
 */
const genUnusable: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(undefined),
  fc.constant(null),
  fc.boolean(),
  fc.constant("not-a-number"),
  fc.constant({}),
  fc.constant([]),
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY),
  fc.double({ min: 0.1, max: 0.9, noNaN: true }),
);

/** 不正な座標（負値・非整数・そもそも点でない値）。要素ごとの畳み込みを検査する母集団。 */
const genInvalidPoint: fc.Arbitrary<unknown> = fc.oneof(
  genUnusable,
  fc.record({ x: fc.integer({ min: -50, max: GRID_COORDINATE_MIN - 1 }), y: fc.integer({ min: 0, max: 10 }) }),
  fc.record({ x: fc.integer({ min: 0, max: 10 }), y: fc.integer({ min: -50, max: GRID_COORDINATE_MIN - 1 }) }),
  fc.record({ x: fc.double({ min: 0.1, max: 0.9, noNaN: true }), y: fc.integer({ min: 0, max: 10 }) }),
  fc.record({ x: fc.integer({ min: 0, max: 10 }) }), // y 欠落
);

/** 妥当な座標と不正な座標が混ざった配列（長さも足りない/多い側へ振る）。 */
const genMixedPoints: fc.Arbitrary<readonly unknown[]> = fc.array(fc.oneof(genGridPoint, genInvalidPoint), {
  minLength: 0,
  maxLength: SLOTS_PER_UNIT + UNIT_COUNT_MAX + 2,
});

/** あるパラメータへ差し込む不正値と、それが「まるごと既定へ畳まれる」ことを期待できるかの札。 */
interface Intrusion {
  readonly value: unknown;
  readonly foldsToDefault: boolean;
}

/** 差し込む不正値の生成器。まるごと既定へ落ちる値と、要素ごと／クランプで妥当域へ収まる値の双方を振る。 */
function genIntrusion(key: ParamKey): fc.Arbitrary<Intrusion> {
  const unusable = genUnusable.map((value) => ({ value, foldsToDefault: true }));
  if (key === "unitOrigins" || key === "slotOffsets") {
    // レイアウトは要素ごとに畳むため、混在配列は「まるごと既定」とは限らない（妥当な座標は保持される）。
    return fc.oneof(
      unusable,
      genMixedPoints.map((value) => ({ value, foldsToDefault: false })),
    );
  }
  // スカラーの範囲外は既定ではなく境界へクランプされる（畳み方の違いを札で区別する）。
  const { min, max } = SCALAR_PARAMS[key];
  const outOfRange = fc
    .oneof(fc.integer({ min: min - 5000, max: min - 1 }), fc.integer({ min: max + 1, max: max + 5000 }))
    .map((value) => ({ value, foldsToDefault: false }));
  return fc.oneof(unusable, outOfRange);
}

// ── 妥当域の判定 ──

/** 検証後の値が当該パラメータの妥当域に収まっているか。 */
function isWithinDomain(key: ParamKey, config: ValidatedConfig, unitCount: number): boolean {
  if (key === "unitOrigins") {
    return config.unitOrigins.length === unitCount && config.unitOrigins.every(isValidPoint);
  }
  if (key === "slotOffsets") {
    return config.slotOffsets.length === SLOTS_PER_UNIT && config.slotOffsets.every(isValidPoint);
  }
  const { min, max } = SCALAR_PARAMS[key];
  const value = config[key];
  return Number.isInteger(value) && value >= min && value <= max;
}

/** 格子座標として妥当か（GRID_COORDINATE_MIN 以上の整数）。 */
function isValidPoint(point: GridPoint): boolean {
  return (
    Number.isInteger(point.x) &&
    Number.isInteger(point.y) &&
    point.x >= GRID_COORDINATE_MIN &&
    point.y >= GRID_COORDINATE_MIN
  );
}

/** 当該パラメータの既定値（レイアウトは unitCount に依存する）。 */
function defaultOf(key: ParamKey, unitCount: number): unknown {
  if (key === "unitOrigins") return defaultUnitOrigins(unitCount);
  if (key === "slotOffsets") return DEFAULT_SLOT_OFFSETS;
  return SCALAR_PARAMS[key].fallback;
}

// ── シナリオ：妥当な設定 1 つと、その 1 パラメータへの不正値の差し込み ──
const genScenario = fc
  .integer({ min: UNIT_COUNT_MIN, max: UNIT_COUNT_MAX })
  .chain((unitCount) =>
    fc.record({
      unitCount: fc.constant(unitCount),
      raw: genValidRaw(unitCount),
      key: fc.constantFrom(...PARAM_KEYS),
    }),
  )
  .chain(({ unitCount, raw, key }) =>
    genIntrusion(key).map((intrusion) => ({ unitCount, raw, key, intrusion })),
  );

describe("domain/store — 新パラメータの検証", () => {
  // Feature: online-cook-scheduling, Property: 各パラメータの検証はパラメータ独立に妥当域へ畳む
  // **Validates: Requirements 3.4**
  //
  // あるパラメータへ任意の不正値（型不一致・非整数・非有限・範囲外・不正座標）を与えても、
  //   1. 他のパラメータの妥当な値はそのまま保たれる（当該パラメータのみが畳まれる）、
  //   2. 結果は常に当該パラメータの妥当域内に収まる、
  //   3. 使いようのない生値（型不一致・非整数・非有限）はまるごと既定へ畳まれる。
  // toArms / toToleranceRatio と同じ規律であることを、同一の主張で 8 パラメータに対して検査する。
  it("Property: 不正値は当該パラメータのみを妥当域へ畳み、他の妥当な値を巻き込まない", () => {
    fc.assert(
      fc.property(genScenario, ({ unitCount, raw, key, intrusion }) => {
        const baseline = validateAll(raw, unitCount);
        // 前提：妥当な生値は素通りする（この上で「巻き込まれない」が観測可能になる）。
        for (const other of PARAM_KEYS) {
          expect(baseline[other]).toEqual(raw[other]);
        }

        const mutated = validateAll({ ...raw, [key]: intrusion.value }, unitCount);

        // 1. 他のパラメータは巻き込まれない。
        for (const other of PARAM_KEYS) {
          if (other === key) continue;
          expect(mutated[other]).toEqual(baseline[other]);
        }

        // 2. 当該パラメータは常に妥当域内へ収まる。
        expect(isWithinDomain(key, mutated, unitCount)).toBe(true);

        // 3. 使いようのない生値はまるごと既定へ畳まれる。
        if (intrusion.foldsToDefault) {
          expect(mutated[key]).toEqual(defaultOf(key, unitCount));
        }
      }),
      { numRuns: 300 },
    );
  });
});
