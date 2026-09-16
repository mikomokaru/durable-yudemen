// tests/core/lift.property.test.ts — 上げ窓（src/engine/lift.ts）の property test。
//
// 対象は lift-group-planning の Requirement 7.8（上げ窓の上限）と AC 9.3・9.4・9.6・9.12。窓の数え方も置き場所も
// 純粋関数ゆえ既定 pool で走る。負荷の差分検査はミリ秒で振る。最小性の総当たりは整数秒で振る——上がりも候補も窓の長さも整数秒なら、firstFit が飛ぶ先
// （e + L）も整数秒に閉じるので、総当たりの参照実装が整数秒だけを走査して最小性を裁定できる。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  advanceLifts,
  firstFit,
  liftCap,
  liftOverflow,
  loadWith,
  type Lift,
  type LiftParams,
  type LiftTable,
} from "../../src/engine/lift";
import type { EpochMillis } from "../../src/engine/types";
import {
  ARMS_MAX,
  ARMS_MIN,
  HELPER_ARMS,
  LIFT_INTERVAL_SECONDS_MAX,
  LIFT_INTERVAL_SECONDS_MIN,
  SLOT_SPAN_MAX,
  SLOT_SPAN_MIN,
} from "../../src/domain/store";

const MILLIS_PER_SECOND = 1_000;

/** 秒 → EpochMillis。 */
function sec(seconds: number): EpochMillis {
  return (seconds * MILLIS_PER_SECOND) as EpochMillis;
}

/** 上がり時刻の範囲（秒）。窓の長さの最大（120 秒）を数回跨ぐ幅にして、重なりも空きも生まれるようにする。 */
const AT_SECONDS_MAX = 400;

/** 腕と窓の長さ。妥当域の全体を振る。 */
const genParams: fc.Arbitrary<LiftParams> = fc.record({
  arms: fc.integer({ min: ARMS_MIN, max: ARMS_MAX }),
  liftIntervalSeconds: fc.integer({
    min: LIFT_INTERVAL_SECONDS_MIN,
    max: LIFT_INTERVAL_SECONDS_MAX,
  }),
});

/** 上がり 1 件（整数秒・span は slotSpan の妥当域）。 */
const genLift: fc.Arbitrary<Lift> = fc.record({
  at: fc.integer({ min: 0, max: AT_SECONDS_MAX }).map(sec),
  span: fc.integer({ min: SLOT_SPAN_MIN, max: SLOT_SPAN_MAX }),
});

/** 上げ表（at 昇順は advanceLifts が保つ）。 */
const genTable: fc.Arbitrary<LiftTable> = fc
  .array(genLift, { maxLength: 12 })
  .map((lifts) => advanceLifts([], lifts));

/** 候補時刻（整数秒）。表の範囲の外側も踏む。 */
const genCandidate: fc.Arbitrary<EpochMillis> = fc
  .integer({ min: -LIFT_INTERVAL_SECONDS_MAX, max: AT_SECONDS_MAX + LIFT_INTERVAL_SECONDS_MAX })
  .map(sec);

/** 参照実装：t から整数秒ずつ進め、独立に数えた負荷が上限以下になる最初の時刻。表の最後の上がり + L で必ず止まる。 */
function bruteForceFirstFit(
  lifts: LiftTable,
  t: EpochMillis,
  span: number,
  params: LiftParams,
): EpochMillis {
  const cap = liftCap(params);
  const last = lifts.length === 0 ? t : Math.max(t, lifts[lifts.length - 1]?.at ?? t);
  const bound = last + params.liftIntervalSeconds * MILLIS_PER_SECOND;
  for (let u = t; u <= bound; u = (u + MILLIS_PER_SECOND) as EpochMillis) {
    if (referenceLoad(lifts, u, span, params) <= cap) return u;
  }
  throw new Error("参照実装が止まらない（表の最後の上がり + L では窓に既存の上がりが無いはず）");
}

/** 各窓を独立に数える参照。firstFit の検査に本体の loadWith を使って同じ誤りを共有しない。 */
function referenceLoad(lifts: LiftTable, t: EpochMillis, span: number, params: LiftParams): number {
  const length = params.liftIntervalSeconds * MILLIS_PER_SECOND;
  const origins = [
    t,
    ...lifts.filter((lift) => lift.at <= t && t < lift.at + length).map((lift) => lift.at),
  ];
  return Math.max(
    ...origins.map(
      (origin) =>
        span +
        lifts
          .filter((lift) => origin <= lift.at && lift.at < origin + length)
          .reduce((sum, lift) => sum + lift.span, 0),
    ),
  );
}

it("ミリ秒の時刻・重複する上がりでも、独立に列挙した窓の最大負荷と一致する", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          at: fc.integer({ min: -120_000, max: 120_000 }),
          span: fc.integer({ min: 1, max: 4 }),
        }),
        { maxLength: 80 },
      ),
      fc.integer({ min: -120_000, max: 120_000 }),
      genParams,
      fc.integer({ min: 0, max: 5 }),
      (entries, at, params, span) => {
        const epoch = 1_700_000_000_123;
        const lifts = advanceLifts(
          [],
          entries.map((lift) => ({ ...lift, at: (epoch + lift.at) as EpochMillis })),
        );
        const candidate = (epoch + at) as EpochMillis;
        expect(loadWith(lifts, candidate, span, params)).toBe(
          referenceLoad(lifts, candidate, span, params),
        );
      },
    ),
    { seed: 20260915, numRuns: 1000 },
  );
});

it("密な上げ窓の検査で、候補窓ごとの全件再走査をしない", () => {
  let reads = 0;
  const count = 128;
  const lifts: LiftTable = Array.from({ length: count }, (_, at) => ({
    get at() {
      reads += 1;
      return at as EpochMillis;
    },
    span: 1,
  }));
  expect(loadWith(lifts, 64 as EpochMillis, 1, { arms: 2, liftIntervalSeconds: 45 })).toBe(129);
  expect(reads).toBeLessThanOrEqual(16 * count);
});

/**
 * 参照実装：Lift_Overflow の定義（AC 9.6）を、貪欲の割当をそのまま再帰で書いた形。
 * 「未割当の最早の時刻を起点に窓を取り、内側を割当済みにして残りへ進む」を式のまま写す。
 */
function referenceOverflow(lifts: LiftTable, params: LiftParams): number {
  const head = lifts[0];
  if (head === undefined) return 0;
  const upper = head.at + params.liftIntervalSeconds * MILLIS_PER_SECOND;
  const inside = lifts.filter((lift) => lift.at < upper);
  const rest = lifts.filter((lift) => lift.at >= upper);
  const load = inside.reduce((sum, lift) => sum + lift.span, 0);
  return (
    Math.max(0, load - params.arms) * params.liftIntervalSeconds + referenceOverflow(rest, params)
  );
}

describe("engine/lift — 上げ窓", () => {
  // Feature: lift-group-planning, Property 7.8 — 上げ窓の上限（firstFit は候補以上で条件を満たす最小の時刻）
  // **Validates: Requirements 9.4, 9.12**
  //
  // span が上限（arms + HELPER_ARMS）以下なら firstFit は非 null で、(1) 候補以上、(2) その時刻を含むすべての窓の
  // 負荷が上限以下、(3) 候補からそこまでの整数秒はすべて上限を超える（＝整数秒の総当たりと一致する）。
  // span が上限を超えれば null（いつまで待っても入らない）。
  it("Property 7.8: firstFit は候補以上で上限を満たす最小の時刻、span > 上限なら null", () => {
    fc.assert(
      fc.property(
        genTable,
        genCandidate,
        genParams,
        fc.integer({ min: 1, max: ARMS_MAX + HELPER_ARMS + 1 }),
        (lifts, t, params, span) => {
          const cap = liftCap(params);
          const fit = firstFit(lifts, t, span, params);
          if (span > cap) {
            expect(fit).toBeNull();
            return;
          }
          expect(fit).not.toBeNull();
          if (fit === null) return;
          expect(fit).toBeGreaterThanOrEqual(t);
          expect(loadWith(lifts, fit, span, params)).toBeLessThanOrEqual(cap);
          expect(fit).toBe(bruteForceFirstFit(lifts, t, span, params));
        },
      ),
      { numRuns: 400 },
    );
  });

  // Feature: lift-group-planning, Property 7.8 — 境界：ちょうど L 離れた上がりは同じ窓に入らない
  // **Validates: Requirements 9.3**
  //
  // a 秒に s1 本、候補 a + L 秒に s2 本（s1 + s2 が上限を超える組）。半開区間ゆえ a + L は [a, a + L) に入らず、
  // firstFit は候補のまま動かない。1 ミリ秒手前の候補 a + L − 1 は [a, a + L) に入るので a + L まで動く。
  it("Property 7.8（境界）: ちょうど L 離れた上がりは同じ窓に入らない", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: AT_SECONDS_MAX }).map(sec),
        genParams,
        fc.integer({ min: 1, max: ARMS_MAX + HELPER_ARMS }),
        fc.integer({ min: 1, max: ARMS_MAX + HELPER_ARMS }),
        (a, params, s1, s2) => {
          const cap = liftCap(params);
          fc.pre(s1 <= cap && s2 <= cap && s1 + s2 > cap);
          const lifts = advanceLifts([], [{ at: a, span: s1 }]);
          const atL = (a + params.liftIntervalSeconds * MILLIS_PER_SECOND) as EpochMillis;
          expect(firstFit(lifts, atL, s2, params)).toBe(atL);
          expect(loadWith(lifts, atL, s2, params)).toBe(s2);
          const justBefore = (atL - 1) as EpochMillis;
          expect(loadWith(lifts, justBefore, s2, params)).toBe(s1 + s2);
          expect(firstFit(lifts, justBefore, s2, params)).toBe(atL);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: lift-group-planning, Property 7.8 — 走行中だけの過負荷は、それを含まない候補を動かさない
  // **Validates: Requirements 9.4**
  //
  // 表の上がりがどれだけ上限を超えて重なっていても、候補 t を含む窓（起点 (t − L, t]）に既存の上がりが無ければ
  // firstFit は t のまま。「表全体が上限を満たすか」ではなく「当該配置を含む窓」だけを見る契約の直接の帰結。
  it("Property 7.8（含まない窓）: 既存の上がりが t の窓に無ければ firstFit は t のまま", () => {
    fc.assert(
      fc.property(
        genTable,
        genParams,
        fc.integer({ min: 1, max: ARMS_MAX + HELPER_ARMS }),
        fc.integer({ min: 0, max: AT_SECONDS_MAX }),
        (lifts, params, span, offsetSeconds) => {
          fc.pre(span <= liftCap(params) && lifts.length > 0);
          const length = params.liftIntervalSeconds * MILLIS_PER_SECOND;
          const first = lifts[0]?.at ?? sec(0);
          const last = lifts[lifts.length - 1]?.at ?? sec(0);
          // 最後の上がりから L 以上後ろ、または最初の上がりから L 以上手前（窓 [t, t + L) が最初の上がりに届かない）。
          const after = (last + length + offsetSeconds * MILLIS_PER_SECOND) as EpochMillis;
          const before = (first - length - offsetSeconds * MILLIS_PER_SECOND) as EpochMillis;
          expect(firstFit(lifts, after, span, params)).toBe(after);
          expect(firstFit(lifts, before, span, params)).toBe(before);
          expect(loadWith(lifts, after, span, params)).toBe(span);
          expect(loadWith(lifts, before, span, params)).toBe(span);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: lift-group-planning, Property 7.8 — Lift_Overflow は重ならない割当で一意に定まり、外部再現できる
  // **Validates: Requirements 9.6**
  //
  // (1) 定義を式のまま写した参照実装と一致する（外部ソルバが同じ式で再現できる）、(2) 表の作り方（advanceLifts
  // へ渡す順）に依らない、(3) 非負の整数で liftIntervalSeconds の倍数、(4) 本数の合計が arms 以下なら 0。
  it("Property（Lift_Overflow）: 参照実装と一致し、並びに依らず、L の倍数の非負整数", () => {
    fc.assert(
      fc.property(fc.array(genLift, { maxLength: 12 }), genParams, (raw, params) => {
        const lifts = advanceLifts([], raw);
        const overflow = liftOverflow(lifts, params);
        expect(overflow).toBe(referenceOverflow(lifts, params));
        // 逆順・分割して進めた表でも同じ値（表の不変条件 at 昇順は advanceLifts が保つ）。
        const reversed = advanceLifts([], [...raw].reverse());
        expect(reversed).toEqual(lifts);
        const half = Math.floor(raw.length / 2);
        expect(advanceLifts(advanceLifts([], raw.slice(half)), raw.slice(0, half))).toEqual(lifts);
        expect(Number.isInteger(overflow)).toBe(true);
        expect(overflow).toBeGreaterThanOrEqual(0);
        expect(overflow % params.liftIntervalSeconds).toBe(0);
        const total = raw.reduce((sum, lift) => sum + lift.span, 0);
        if (total <= params.arms) expect(overflow).toBe(0);
      }),
      { numRuns: 300 },
    );
  });
});
