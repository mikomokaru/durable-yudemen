import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ARMS_MAX,
  ARMS_MIN,
  DEFAULT_ARMS,
  DEFAULT_TOLERANCE_RATIO,
  TOLERANCE_RATIO_MAX,
  TOLERANCE_RATIO_MIN,
  toArms,
  toToleranceRatio,
} from "../../src/domain/store";

const NUM_RUNS = 250;

/** 未指定・非数・非整数・域外の生値を、対象の妥当域に合わせて生成する。 */
function invalidRaw(min: number, max: number): fc.Arbitrary<unknown> {
  const unspecified = fc.constant(undefined);
  const nonNumeric = fc.oneof(
    fc.constant(null),
    fc.boolean(),
    fc.string().map((value) => `not-a-number:${value}`),
    fc.constant(Number.NaN),
    fc.constant(Number.POSITIVE_INFINITY),
    fc.constant(Number.NEGATIVE_INFINITY),
    fc.constant({}),
    fc.constant([]),
  );
  const nonInteger = fc
    .double({ noNaN: true, noDefaultInfinity: true })
    .filter((value) => !Number.isInteger(value));
  const outOfRange = fc.oneof(
    fc.integer({ min: Number.MIN_SAFE_INTEGER, max: min - 1 }),
    fc.integer({ min: max + 1, max: Number.MAX_SAFE_INTEGER }),
  );

  return fc.oneof(unspecified, nonNumeric, nonInteger, outOfRange);
}

const validArms = fc.integer({ min: ARMS_MIN, max: ARMS_MAX });
const validToleranceRatio = fc.integer({ min: TOLERANCE_RATIO_MIN, max: TOLERANCE_RATIO_MAX });
const invalidArms = invalidRaw(ARMS_MIN, ARMS_MAX);
const invalidToleranceRatio = invalidRaw(TOLERANCE_RATIO_MIN, TOLERANCE_RATIO_MAX);

describe("domain/store — 同期調整パラメータの検証", () => {
  // Feature: synchronized-boil-adjustment, Property 13: 調整パラメータは妥当域へ独立に畳み込まれる
  // **Validates: Requirements 6.3, 6.4**
  it("Property 13: 妥当域の整数はそのまま保持される", () => {
    fc.assert(
      fc.property(validArms, validToleranceRatio, (arms, toleranceRatio) => {
        expect(toArms(arms)).toBe(arms);
        expect(toToleranceRatio(toleranceRatio)).toBe(toleranceRatio);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Property 13: arms の不正値だけを既定値へ畳み、妥当な toleranceRatio を保持する", () => {
    fc.assert(
      fc.property(invalidArms, validToleranceRatio, (arms, toleranceRatio) => {
        const normalized = {
          arms: toArms(arms),
          toleranceRatio: toToleranceRatio(toleranceRatio),
        };

        expect(normalized.arms).toBe(DEFAULT_ARMS);
        expect(normalized.toleranceRatio).toBe(toleranceRatio);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("Property 13: toleranceRatio の不正値だけを既定値へ畳み、妥当な arms を保持する", () => {
    fc.assert(
      fc.property(validArms, invalidToleranceRatio, (arms, toleranceRatio) => {
        const normalized = {
          arms: toArms(arms),
          toleranceRatio: toToleranceRatio(toleranceRatio),
        };

        expect(normalized.arms).toBe(arms);
        expect(normalized.toleranceRatio).toBe(DEFAULT_TOLERANCE_RATIO);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
