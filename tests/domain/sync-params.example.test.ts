import { describe, expect, it } from "vitest";
import {
  DEFAULT_ARMS,
  DEFAULT_TOLERANCE_RATIO,
  toArms,
  toToleranceRatio,
} from "../../src/domain/store";

describe("domain/store — 同期調整パラメータの固定境界", () => {
  // **Validates: Requirements 6.2, 6.3, 6.4**
  it("既定値は arms=2、toleranceRatio=10 である", () => {
    expect(DEFAULT_ARMS).toBe(2);
    expect(DEFAULT_TOLERANCE_RATIO).toBe(10);
  });

  it.each([
    [1, 1],
    [10, 10],
  ])("arms の包含境界 %s はそのまま保持される", (raw, expected) => {
    expect(toArms(raw)).toBe(expected);
  });

  it.each([
    [0, 2],
    [11, 2],
    [-1, 2],
    [1.5, 2],
    [Number.NaN, 2],
    [Number.POSITIVE_INFINITY, 2],
    [Number.NEGATIVE_INFINITY, 2],
    [undefined, 2],
    [null, 2],
  ])("不正な arms %s は既定値へ畳まれる", (raw, expected) => {
    expect(toArms(raw)).toBe(expected);
  });

  it.each([
    [1, 1],
    [50, 50],
  ])("toleranceRatio の包含境界 %s はそのまま保持される", (raw, expected) => {
    expect(toToleranceRatio(raw)).toBe(expected);
  });

  it.each([
    [0, 10],
    [51, 10],
    [-1, 10],
    [1.5, 10],
    [Number.NaN, 10],
    [Number.POSITIVE_INFINITY, 10],
    [Number.NEGATIVE_INFINITY, 10],
    [undefined, 10],
    [null, 10],
  ])("不正な toleranceRatio %s は既定値へ畳まれる", (raw, expected) => {
    expect(toToleranceRatio(raw)).toBe(expected);
  });

  it("arms の不正値だけを既定へ畳み、妥当な toleranceRatio は保持する", () => {
    expect({
      arms: toArms(0),
      toleranceRatio: toToleranceRatio(37),
    }).toEqual({
      arms: 2,
      toleranceRatio: 37,
    });
  });

  it("toleranceRatio の不正値だけを既定へ畳み、妥当な arms は保持する", () => {
    expect({
      arms: toArms(7),
      toleranceRatio: toToleranceRatio(51),
    }).toEqual({
      arms: 7,
      toleranceRatio: 10,
    });
  });
});
