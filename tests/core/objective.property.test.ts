// tests/core/objective.property.test.ts — 目的関数（src/engine/objective.ts）の property test。
//
// 対象は online-cook-scheduling の Property 3・16・17・18・19。採点も距離も純粋関数ゆえ既定 pool で走る。
// 「整数で閉じる」「Plan_Unit ごとに分解される」「距離の順序」の 3 つは、Acceptance_Gate の改善判定が
// 丸め誤差にも部分比較の不成立にも晒されないための土台であり、ここが崩れると段 1・段 2 の判定が意味を失う。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { scoreSchedule, type ScheduleParams } from "../../src/engine/objective";
import type { PlanSlice } from "../../src/engine/schedule";
import { tableMembers } from "../../src/engine/project";
import type { EpochMillis, SlotId } from "../../src/engine/types";
import type { PendingOrder } from "../../src/domain/order";
import {
  ARMS_MAX,
  ARMS_MIN,
  AFFINITY_TOLERANCE_DISTANCE_MIN,
  DEFAULT_AFFINITY_TOLERANCE_DISTANCE,
  DEFAULT_SLOT_OFFSETS,
  GRID_COORDINATE_MIN,
  SLOTS_PER_UNIT,
  SYNC_TOLERANCE_SECONDS_MAX,
  SYNC_TOLERANCE_SECONDS_MIN,
  UNIT_COUNT_MAX,
  UNIT_COUNT_MIN,
  WEIGHT_MAX,
  WEIGHT_MIN,
  defaultUnitOrigins,
  slotDistance,
  type GridPoint,
  type SlotOffsets,
} from "../../src/domain/store";
import { nonEmpty } from "../nonEmpty";

/** 採点は絶対時刻の差だけを見るため基準時刻は任意。現実的なエポック値を 1 つ固定する。 */
const BASE_TIME = 1_700_000_000_000;

// ────────────────────────────────────────────────────────────────────────────
// 生成器 — 計画は「Table_Group → オーダー → 品目」の入れ子として組む。
//
// 平坦な品目列から後で束ねる形は採らない。それでは同一オーダーが二つの卓に跨るような、現実に存在しない
// 計画が生成でき、加法分解の主張が「起こり得ない形でも成り立つか」の検査に化けてしまう。
// ────────────────────────────────────────────────────────────────────────────

/** 品目 1 件の素材。slot・提供時刻・待ち時間・Pending_Order 集合に居るか。 */
interface ItemSeed {
  readonly slots: readonly number[];
  readonly serveOffsetMillis: number;
  readonly waitMillis: number;
  readonly inPending: boolean;
}

/** 生成した計画。scoreSchedule の 3 引数がそのまま揃う。 */
interface PlanSeed {
  readonly slices: readonly PlanSlice[];
  readonly pending: readonly PendingOrder[];
  readonly params: ScheduleParams;
}

/** 生成する格子座標の上限。座標に上限は無い（台の増設を設定側で縛らない）が、生成は現実的な範囲に収める。 */
const GRID_COORDINATE_GEN_MAX = 40;

/**
 * 生成する許容 slot 距離の上限。設定側に上限は無いため生成側で決める。
 *
 * 合成座標は原点＋オフセットゆえ最大 2 × GRID_COORDINATE_GEN_MAX = 80、オクタイル距離は
 * 10 × max(dx, dy) + 4 × min(dx, dy) ゆえ生じ得る最大距離は 10×80 + 4×80 = 1120。そこを少し超える
 * 1200 まで振れば、「一部の対だけが超過する」領域と「全ペアが許容内へ潰れる」領域の双方を引ける。
 */
const AFFINITY_TOLERANCE_DISTANCE_GEN_MAX = 1200;

/** 妥当な格子座標。座標に上限は無いが、生成は現実的な範囲に収める。 */
const genGridPoint: fc.Arbitrary<GridPoint> = fc.record({
  x: fc.integer({ min: GRID_COORDINATE_MIN, max: GRID_COORDINATE_GEN_MAX }),
  y: fc.integer({ min: GRID_COORDINATE_MIN, max: GRID_COORDINATE_GEN_MAX }),
});

/** 6 点の配列をオフセット組（タプル）へ昇格する。fast-check はタプル型を直に生成できないための橋渡し。 */
function asSlotOffsets(points: readonly GridPoint[]): SlotOffsets {
  const [a, b, c, d, e, f] = points;
  if (
    a === undefined ||
    b === undefined ||
    c === undefined ||
    d === undefined ||
    e === undefined ||
    f === undefined
  ) {
    throw new Error("test generator invariant violated: expected 6 slot offsets");
  }
  return [a, b, c, d, e, f];
}

/** 採点パラメータ。レイアウトは既定と任意配置の双方を振る（既定に依存した主張をここでは置かない）。 */
function genParams(unitCount: number): fc.Arbitrary<ScheduleParams> {
  return fc.record({
    orderSyncWeight: fc.integer({ min: WEIGHT_MIN, max: WEIGHT_MAX }),
    tableSyncWeight: fc.integer({ min: WEIGHT_MIN, max: WEIGHT_MAX }),
    affinityWeight: fc.integer({ min: WEIGHT_MIN, max: WEIGHT_MAX }),
    arms: fc.integer({ min: ARMS_MIN, max: ARMS_MAX }),
    orderSyncToleranceSeconds: fc.integer({
      min: SYNC_TOLERANCE_SECONDS_MIN,
      max: SYNC_TOLERANCE_SECONDS_MAX,
    }),
    tableSyncToleranceSeconds: fc.integer({
      min: SYNC_TOLERANCE_SECONDS_MIN,
      max: SYNC_TOLERANCE_SECONDS_MAX,
    }),
    affinityToleranceDistance: fc.integer({
      min: AFFINITY_TOLERANCE_DISTANCE_MIN,
      max: AFFINITY_TOLERANCE_DISTANCE_GEN_MAX,
    }),
    unitOrigins: fc.oneof(
      fc.constant(defaultUnitOrigins(unitCount)),
      fc.array(genGridPoint, { minLength: unitCount, maxLength: unitCount }),
    ),
    slotOffsets: fc.oneof(
      fc.constant(DEFAULT_SLOT_OFFSETS),
      fc
        .array(genGridPoint, { minLength: SLOTS_PER_UNIT, maxLength: SLOTS_PER_UNIT })
        .map(asSlotOffsets),
    ),
  });
}

/** 品目の素材。slot は解放表の内側（存在する釜）に収める。 */
function genItemSeed(slotCount: number): fc.Arbitrary<ItemSeed> {
  return fc.record({
    slots: fc.uniqueArray(fc.integer({ min: 0, max: slotCount - 1 }), {
      minLength: 1,
      maxLength: 2,
    }),
    serveOffsetMillis: fc.integer({ min: 0, max: 600_000 }),
    waitMillis: fc.integer({ min: 0, max: 1_200_000 }),
    inPending: fc.boolean(),
  });
}

/** Table_Group（オーダーの入れ子）の素材。 */
function genGroupSeed(slotCount: number): fc.Arbitrary<readonly (readonly ItemSeed[])[]> {
  return fc.array(fc.array(genItemSeed(slotCount), { minLength: 1, maxLength: 3 }), {
    minLength: 1,
    maxLength: 3,
  });
}

/** 計画一式。品目の一部だけを Pending_Order 集合に入れ、起点を持たない配置（アドホック由来）も混ぜる。 */
const genPlan: fc.Arbitrary<PlanSeed> = fc
  .integer({ min: UNIT_COUNT_MIN, max: UNIT_COUNT_MAX })
  .chain((unitCount) =>
    fc.record({
      params: genParams(unitCount),
      groups: fc.array(genGroupSeed(unitCount * SLOTS_PER_UNIT), { minLength: 0, maxLength: 3 }),
    }),
  )
  .map(({ params, groups }) => {
    const slices: PlanSlice[] = [];
    const pending: PendingOrder[] = [];
    groups.forEach((orders, groupIndex) => {
      const tableKey = `t-${groupIndex}`;
      const placements = orders.flatMap((items, orderIndex) => {
        const externalOrderId = `o-${groupIndex}-${orderIndex}`;
        return items.map((item, itemIndex) => {
          const serveAt = BASE_TIME + item.serveOffsetMillis;
          if (item.inPending) {
            pending.push({
              externalOrderId,
              itemIndex,
              noodleType: "Thin",
              firmness: "normal",
              tableId: tableKey,
              arrivalTime: serveAt - item.waitMillis,
              slotSpan: 1,
              itemName: null,
              sizeName: null,
            });
          }
          return {
            externalOrderId,
            itemIndex,
            slotIds: nonEmpty(item.slots.map((slot) => String(slot) as SlotId)),
            // startAt は採点に寄与しない（目的関数は提供時刻だけを見る）。整合する値を置く。
            startAt: (serveAt - 60_000) as EpochMillis,
            serveAt: serveAt as EpochMillis,
          };
        });
      });
      slices.push({ tableKey, placements });
    });
    return { slices, pending, params };
  });

describe("engine/objective — 目的関数", () => {
  // Feature: online-cook-scheduling, Property: 3 — 目的関数は Plan_Unit ごとに厳密に加法分解される
  // **Validates: Requirements 6.2**
  //
  // 主張は 2 段ある。
  //   1. 部分和の総和が全体値に等しい。
  //   2. **各 PlanSlice を単独で採点した値が、計画全体の中でのその部分和に等しい。**
  // 2 が本体である。1 だけなら「全体値を部分和の和として定義した」ことの確認に留まり、
  // Plan_Unit を跨ぐ項が忍び込んでも気づけない。2 は「一片の値が他の一片に依存しない」ことを言い、
  // Acceptance_Gate の段 1 が部分和どうしを比べられる条件そのものである（AC 6.2(d)）。
  it("Property 3: 部分和の総和が全体値に等しく、各部分和は単独採点と一致する", () => {
    fc.assert(
      fc.property(genPlan, ({ slices, pending, params }) => {
        const score = scoreSchedule(slices, pending, new Map(), params);

        expect(score.bySlice).toHaveLength(slices.length);
        expect(score.bySlice.reduce((sum, value) => sum + value, 0)).toBe(score.total);

        slices.forEach((slice, index) => {
          expect(scoreSchedule([slice], pending, new Map(), params).total).toBe(
            score.bySlice[index],
          );
        });
      }),
      { numRuns: 300 },
    );
  });

  // Feature: online-cook-scheduling, Property: 16 — 目的関数値は整数で閉じる
  // **Validates: Requirements 6.2**
  //
  // 全体値と各部分和が整数であること。平方根を用いないオクタイル距離を採る根拠そのものであり、
  // 改善判定（真に良いか同値か）が丸め誤差に左右されないことを支える。ミリ秒を秒へ落とす除算が
  // 入るため、整数性は「距離が整数」だけでは出ない——切り捨てがそれを閉じていることを併せて見る。
  it("Property 16: 全体値と各部分和が整数である", () => {
    fc.assert(
      fc.property(genPlan, ({ slices, pending, params }) => {
        const score = scoreSchedule(slices, pending, new Map(), params);

        expect(Number.isInteger(score.total)).toBe(true);
        for (const partial of score.bySlice) {
          expect(Number.isInteger(partial)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 距離尺度 — レイアウトを直に組んで座標を制御する。
//
// slotDistance は slot 番号しか受けないため、狙った座標対を作るにはオフセットを組み上げる。
// unitCount = 1・原点 (0,0) とし、slotOffsets の 6 点で座標を指定する。
// ────────────────────────────────────────────────────────────────────────────

/** 原点 (0,0) の単一ユニットで、指定した 6 点を slot 0..5 の座標として持つレイアウト。 */
function singleUnitLayout(points: readonly GridPoint[]): {
  origins: readonly GridPoint[];
  offsets: SlotOffsets;
} {
  return { origins: [{ x: 0, y: 0 }], offsets: asSlotOffsets(points) };
}

describe("engine/objective — 距離尺度", () => {
  // Feature: online-cook-scheduling, Property: 17 — 距離尺度は要求された順序を満たす
  // **Validates: Requirements 3.4**
  //
  // 任意の基点について「縦横隣接 < 斜め隣接 < 2 マス直線」（10 < 14 < 20）が成り立ち、
  // かつ対称（d(a,b) = d(b,a)）・自己 0 であること。この順序の要求ひとつでマンハッタン
  // （斜め隣接と 2 マス直線が同値）とチェビシェフ（縦横隣接と斜め隣接が同値）が落ちる。
  it("Property 17: 縦横隣接 < 斜め隣接 < 2 マス直線・対称・自己 0", () => {
    fc.assert(
      fc.property(
        genGridPoint,
        fc.boolean(),
        fc.array(genGridPoint, { minLength: SLOTS_PER_UNIT, maxLength: SLOTS_PER_UNIT }),
        fc.integer({ min: 0, max: SLOTS_PER_UNIT - 1 }),
        fc.integer({ min: 0, max: SLOTS_PER_UNIT - 1 }),
        (base, vertical, freePoints, slot, other) => {
          // 順序 — 基点から縦横隣接・斜め隣接・2 マス直線へ伸ばした 3 点を slot 1..3 に置く。
          // 縦横と 2 マス直線は横方向・縦方向の双方を振る（尺度が軸に依らないことも同時に見る）。
          const step = vertical ? { x: 0, y: 1 } : { x: 1, y: 0 };
          const twoStep = vertical ? { x: 0, y: 2 } : { x: 2, y: 0 };
          const ordered = singleUnitLayout([
            base,
            { x: base.x + step.x, y: base.y + step.y },
            { x: base.x + 1, y: base.y + 1 },
            { x: base.x + twoStep.x, y: base.y + twoStep.y },
            base,
            base,
          ]);
          const orthogonal = slotDistance(0, 1, ordered.origins, ordered.offsets);
          const diagonal = slotDistance(0, 2, ordered.origins, ordered.offsets);
          const twoStraight = slotDistance(0, 3, ordered.origins, ordered.offsets);
          expect(orthogonal).toBeLessThan(diagonal);
          expect(diagonal).toBeLessThan(twoStraight);

          // 対称・自己 0 — 任意配置の任意の slot 対で成り立つ（順序の検査とは独立のレイアウトで見る）。
          const free = singleUnitLayout(freePoints);
          expect(slotDistance(slot, other, free.origins, free.offsets)).toBe(
            slotDistance(other, slot, free.origins, free.offsets),
          );
          expect(slotDistance(slot, slot, free.origins, free.offsets)).toBe(0);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: online-cook-scheduling, Property: 18 — 既定レイアウトはユニット境界の離隔を反映する
  // **Validates: Requirements 3.4**
  //
  // 既定レイアウト（3 行 × 2 列・原点間隔 4）では「同一ユニット内の任意の対は、異なるユニットの任意の対より
  // 近い」。生の距離では真の不等号（ユニット内の最遠 24 < 異なるユニットの最近 30）が立つが、目的関数へ
  // 計上するのは許容距離 14 からの超過分であり、許容内の対はすべて 0 へ潰れる。ゆえにペナルティでは
  // 「同一ユニット内 ≤ 異なるユニット、かつ後者は真に正」という緩んだ形で主張する。
  // 「別の台へ手を伸ばすより、自分の台の端まで動くほうが近い」という現場の事実の表明である。
  it("Property 18: 同一ユニット内の対は異なるユニットの対より近い（ペナルティは前者 ≤ 後者・後者は正）", () => {
    const penalty = (distance: number) =>
      Math.max(0, distance - DEFAULT_AFFINITY_TOLERANCE_DISTANCE);

    fc.assert(
      fc.property(
        // 異なるユニットの対を作るには 2 ユニット以上を要する。
        fc.integer({ min: 2, max: UNIT_COUNT_MAX }),
        fc.integer({ min: 0, max: SLOTS_PER_UNIT - 1 }),
        fc.integer({ min: 0, max: SLOTS_PER_UNIT - 1 }),
        fc.integer({ min: 0, max: SLOTS_PER_UNIT - 1 }),
        fc.integer({ min: 0, max: SLOTS_PER_UNIT - 1 }),
        (unitCount, sameUnit, offsetA, offsetB, offsetC) => {
          const origins = defaultUnitOrigins(unitCount);
          const unit = sameUnit % unitCount;
          const otherUnit = (unit + 1) % unitCount;
          const distance = (slot: number, other: number) =>
            slotDistance(slot, other, origins, DEFAULT_SLOT_OFFSETS);

          // 同一ユニット内の任意の対（同一 slot も含む——距離 0 で主張を破らない）。
          const within = distance(unit * SLOTS_PER_UNIT + offsetA, unit * SLOTS_PER_UNIT + offsetB);
          // 異なるユニットに属する任意の対。
          const across = distance(
            unit * SLOTS_PER_UNIT + offsetA,
            otherUnit * SLOTS_PER_UNIT + offsetC,
          );

          // 生の距離では真の不等号が立つ（既定の離隔 2 がこれを満たすために選ばれている）。
          expect(within).toBeLessThan(across);
          // 目的関数へ計上するペナルティでは、許容内が 0 へ潰れるため等号を許す。
          expect(penalty(within)).toBeLessThanOrEqual(penalty(across));
          expect(penalty(across)).toBeGreaterThan(0);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: online-cook-scheduling, Property: 19 — 許容距離内の配置はペナルティ 0
  // **Validates: Requirements 3.4**
  //
  // 関連品目の対の距離が affinityToleranceDistance 以下ならば、affinity 項は目的関数へ 1 も足さない。
  // 「足さない」は他の項を 0 に潰して測らない——w_affinity を 0 に落とした採点との差で測れば、
  // Wait_Time や同期項が生きたままでも affinity 項の寄与だけを取り出せる。
  // 到達可能な下限 0 を持つこと（生の距離では距離 0 が同一 slot のときだけで到達不能だった）を検証する。
  it("Property 19: 距離が許容以下の対は affinity 項へ寄与しない", () => {
    fc.assert(
      fc.property(
        genPlan,
        // 余裕。0 でも前件（全ペアが許容内）は満たすため、境界ちょうどと十分に余る場合の双方を引くだけの幅で足る。
        fc.integer({ min: 0, max: 100 }),
        ({ slices, pending, params }, slack) => {
          // 全ペアが許容内に収まる許容距離を採る（レイアウトが与える最大距離＋余裕）。
          // 許容距離に上限が無いため、どんなレイアウトでもこの値をそのまま設定できる。
          const tolerance = maxPairDistance(params) + slack;
          const within = { ...params, affinityToleranceDistance: tolerance };
          const withoutAffinity = { ...within, affinityWeight: 0 };

          expect(scoreSchedule(slices, pending, new Map(), within)).toEqual(
            scoreSchedule(slices, pending, new Map(), withoutAffinity),
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it("既定の許容距離 14 では縦横隣接と斜め隣接がともにペナルティ 0", () => {
    const origins = defaultUnitOrigins(1);
    const penalty = (slot: number, other: number) =>
      Math.max(
        0,
        slotDistance(slot, other, origins, DEFAULT_SLOT_OFFSETS) -
          DEFAULT_AFFINITY_TOLERANCE_DISTANCE,
      );

    expect(penalty(0, 1)).toBe(0); // 縦横隣接（10）
    expect(penalty(0, 2)).toBe(0); // 縦横隣接（10）
    expect(penalty(0, 3)).toBe(0); // 斜め隣接（14）
    expect(penalty(0, 4)).toBeGreaterThan(0); // 2 マス直線（20）は超過する
  });
});

/** 与えられたレイアウトで生じ得る最大の slot 間距離。全 slot の総当たりで求める。 */
function maxPairDistance(params: ScheduleParams): number {
  const slotCount = params.unitOrigins.length * SLOTS_PER_UNIT;
  let max = 0;
  for (let slot = 0; slot < slotCount; slot++) {
    for (let other = slot + 1; other < slotCount; other++) {
      const distance = slotDistance(slot, other, params.unitOrigins, params.slotOffsets);
      if (distance > max) max = distance;
    }
  }
  return max;
}

// ── lift-group-planning — 卓の群を採点の帰結として得るための性質 ────────────────────────────────

/** 一片の全配置を最遅の提供時刻へ揃える（自前解が置く形）。 */
function aligned(slice: PlanSlice): PlanSlice {
  const latest = Math.max(...slice.placements.map((placement) => placement.serveAt));
  return {
    tableKey: slice.tableKey,
    placements: slice.placements.map((placement) => ({
      ...placement,
      startAt: (latest - (placement.serveAt - placement.startAt)) as EpochMillis,
      serveAt: latest as EpochMillis,
    })),
  };
}

/** 揃った一片の 1 本だけを Δ ms 早める（散らした計画）。 */
function scattered(slice: PlanSlice, index: number, deltaMillis: number): PlanSlice {
  return {
    tableKey: slice.tableKey,
    placements: slice.placements.map((placement, position) =>
      position === index
        ? {
            ...placement,
            startAt: (placement.startAt - deltaMillis) as EpochMillis,
            serveAt: (placement.serveAt - deltaMillis) as EpochMillis,
          }
        : placement,
    ),
  };
}

/** 揃った一片を 1 つ含む計画。品目数 ≥ 2 の一片だけを対象にする（1 本では散らしようがない）。 */
const genAlignedPlan = genPlan
  .filter(({ slices }) => slices.some((slice) => slice.placements.length >= 2))
  .chain(({ slices, pending, params }) => {
    const candidates = slices
      .map((slice, index) => ({ slice, index }))
      .filter(({ slice }) => slice.placements.length >= 2);
    return fc.constantFrom(...candidates).map(({ slice, index }) => ({
      slices: slices.map((each, position) => (position === index ? aligned(each) : each)),
      sliceIndex: index,
      pending,
      params,
      placementCount: slice.placements.length,
    }));
  });

/** 揃えることが点で勝つ w_table の域（要件 2 の前提・w_table ≥ 2）。 */
const genTableWeight = fc.integer({ min: 2, max: WEIGHT_MAX });

/** 1 ms 〜 999 ms と 1 秒以上の双方。秒未満の側が切り上げでしか閉じない境界である。 */
const genDelta = fc.oneof(
  fc.integer({ min: 1, max: 999 }),
  fc.integer({ min: 1_000, max: 600_000 }),
);

describe("engine/objective — 卓の群（lift-group-planning）", () => {
  // Feature: lift-group-planning, Property 2 — 採点の単調性（ずれが 1 ミリ秒でも成り立つ）
  // **Validates: Requirements 2.1, 2.8, 7.2**
  //
  // 揃えた一片の 1 本だけを Δ 早めた計画は、揃えた計画より必ず値が大きい。Δ < 1 秒の側が本質で、
  // Table_Lag を切り捨てに戻した実装はここで落ちる（wait の切り捨てが 1 減り lag が増えない）。
  it("Property 2: 揃えた配置から 1 本を Δ 早めた計画は、Δ が 1 ms でも真に良くならない（超過が無ければ真に悪い）", () => {
    fc.assert(
      fc.property(
        genAlignedPlan,
        genTableWeight,
        genDelta,
        fc.nat({ max: 3 }),
        ({ slices, sliceIndex, pending, params, placementCount }, tableSyncWeight, delta, pick) => {
          const weighted = { ...params, tableSyncWeight };
          const members = new Map();
          const target = slices[sliceIndex]!;
          const chosen = target.placements[pick % placementCount]!;
          // 提供が到着より前になる配置は計画として成立しない（Wait_Time が負になる嘘）。そこへは踏み込まない。
          const arrival = pending.find(
            (order) =>
              order.externalOrderId === chosen.externalOrderId &&
              order.itemIndex === chosen.itemIndex,
          )?.arrivalTime;
          fc.pre(arrival === undefined || chosen.serveAt - delta >= arrival);
          const worse = slices.map((slice, position) =>
            position === sliceIndex ? scattered(slice, pick % placementCount, delta) : slice,
          );
          const alignedScore = scoreSchedule(slices, pending, members, weighted);
          const scatteredScore = scoreSchedule(worse, pending, members, weighted);

          // arms 超過が立っている一片では、1 本を外すと超過が (w_table − 1) 減り、lag の増分（w_table × ceil(Δ)）と
          // wait の節約（≤ ceil(Δ)）を差し引くと最悪で同値になる。同値はゲートが棄却するので採用には至らない。
          // 超過が無い（arms ≥ 本数）なら常に真に大きい。
          const overflowFree = weighted.arms >= placementCount;
          if (overflowFree) {
            expect(scatteredScore.bySlice[sliceIndex]!).toBeGreaterThan(
              alignedScore.bySlice[sliceIndex]!,
            );
            expect(scatteredScore.total).toBeGreaterThan(alignedScore.total);
          } else {
            expect(scatteredScore.bySlice[sliceIndex]!).toBeGreaterThanOrEqual(
              alignedScore.bySlice[sliceIndex]!,
            );
            expect(scatteredScore.total).toBeGreaterThanOrEqual(alignedScore.total);
          }
          // 触っていない一片の部分和は動かない（部分和の独立・Property 13 の前提）。
          slices.forEach((_slice, position) => {
            if (position !== sliceIndex) {
              expect(scatteredScore.bySlice[position]).toBe(alignedScore.bySlice[position]);
            }
          });
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: lift-group-planning, Property 9 / 10 — 到達可能な下限 0
  // **Validates: Requirements 7.9, 7.10**
  //
  // 走行中の仲間が無く揃った一片では卓同期項が 0 で、同時刻の本数が arms 以下なら arms 超過も 0。
  // どちらも「w_table を変えても値が動かない」ことで観測する（両項の重みは w_table から出る）。
  it("Property 9 / 10: 揃った一片は卓同期項が 0、同時刻の本数が arms 以下なら arms 超過も 0", () => {
    fc.assert(
      fc.property(genAlignedPlan, genTableWeight, ({ slices, sliceIndex, pending, params }, w) => {
        const target = slices[sliceIndex]!;
        // 同時刻の本数（＝一片の本数）以上の arms なら超過は 0。
        const roomy = { ...params, arms: target.placements.length };
        const withWeight = scoreSchedule([target], pending, new Map(), {
          ...roomy,
          tableSyncWeight: w,
        });
        const withoutWeight = scoreSchedule([target], pending, new Map(), {
          ...roomy,
          tableSyncWeight: 0,
        });
        expect(withWeight.total).toBe(withoutWeight.total);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: lift-group-planning, Property 13 — 再採点の決定性
  // **Validates: Requirements 2.9, 7.7**
  it("Property 13: 同じ入力から同じ値を返し、bySlice の総和は total に一致する", () => {
    fc.assert(
      fc.property(genPlan, ({ slices, pending, params }) => {
        const first = scoreSchedule(slices, pending, new Map(), params);
        const second = scoreSchedule(slices, pending, new Map(), params);
        expect(second).toEqual(first);
        expect(first.bySlice.reduce((sum, value) => sum + value, 0)).toBe(first.total);
        expect(Number.isInteger(first.total)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  // 走行中の仲間は錨として lag に寄与し、Wait_Time には寄与しない（AC 2.3 / 2.5）。
  it("走行中の仲間を成員に加えても、Wait_Time は動かず卓の遅れだけが動く", () => {
    fc.assert(
      fc.property(
        genAlignedPlan,
        fc.integer({ min: 1, max: 600 }),
        ({ slices, sliceIndex, pending, params }, laterSeconds) => {
          const target = slices[sliceIndex]!;
          const latest = Math.max(...target.placements.map((placement) => placement.serveAt));
          const memberEnd = (latest + laterSeconds * 1000) as EpochMillis;
          const members = new Map([[target.tableKey, nonEmpty([memberEnd])]]);
          const roomy = { ...params, arms: 100 };
          const alone = scoreSchedule([target], pending, new Map(), roomy);
          const withMember = scoreSchedule([target], pending, members, roomy);
          // 配置全員が laterSeconds だけ遅れる（切り上げ・整数秒ゆえ厳密）。
          expect(withMember.total - alone.total).toBe(
            roomy.tableSyncWeight * laterSeconds * target.placements.length,
          );
          void tableMembers;
        },
      ),
      { numRuns: 200 },
    );
  });
});
