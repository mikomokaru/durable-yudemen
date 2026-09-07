// tests/core/self-solution-gate.probe.test.ts — 自前解（`baselineSchedule`・実占有の 2 段）の出力を、確定計画の合成
// （`livePrefix`）とゲート（`admit`）が採用済み・外部の一片に当てるのと**同じハード制約の述語**で検査する。
//
// Feature: startable-placement（2 段の計画）/ plan-stability
// **Validates: Requirements startable-placement 4.5, lift-group-planning 9.10**
//
// `raiseToFloor`（schedule.ts）の注記は「合流分が動くとき外部ソルバの計画は keepsAnchor (d) を満たさず採用されないが、
// 自前解にゲートは無い」と述べる。共通のハード制約（錨の主張・窓だけによる延期・上げ窓の上限・解放表）を自前解が破る
// ことは受け入れられないので、ここで実測する。実測（3000 場面・未知の麺種なし）：`release` / `liftCap` の違反は 0、
// `keepsAnchor` の違反が 1 場面（下の場面 E・fast-check で縮約）。`cannotStart` は空き釜不足で boiled の釜に「今」置いて
// 待つ配置（startable-placement AC 1.4・意図した待ち）、`isStale` は置けない品目（茹で時間が引けない麺種・上限を超える
// span）を含む卓で立つ（一片 ≠ 卓の計画対象）——どちらも自前解の構造上の帰結で、ここでは違反に数えない。
//
// 場面 E の機構：卓 t-1 の走行中が 0 秒と 52.001 秒に上がり、1 段目は t-1 の Thin（45 秒）を錨 52.001 に合流させるが窓
// （L 49・arms 1）が埋まって 150.001 秒提供に遅らせる。2 段目は「今」の卓なし大盛を占有された釜 1 から釜 2+3 へ配り直し、
// t-1 の Thin は釜 1 へ動く——そこで `raiseToFloor` が 1 段目の下限（150.001）を当て、窓の上限で 199 秒まで押す。合流分の
// 延期の理由が窓だけではない（下限）ので keepsAnchor (d) が偽になり、1 段目（150.001）より 47 秒悪い計画になる。前回の
// 文脈があれば次回は 101 秒提供を見つける（性質 5.6 の反例にもなる）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isStale, placeableTargets } from "../../src/engine/schedule";
import type { ScheduleParams } from "../../src/engine/objective";
import type { Firmness } from "../../src/domain/firmness";
import {
  DEFAULT_NOODLE_PRESETS,
  DEFAULT_SLOT_OFFSETS,
  SLOTS_PER_UNIT,
  UNIT_COUNT_MAX,
  UNIT_COUNT_MIN,
  defaultUnitOrigins,
} from "../../src/domain/store";
import {
  KNOWN_NOODLE_TYPES,
  NOW,
  UNKNOWN_NOODLE_TYPE,
  genOrderSpec,
  genParams,
  genRunning,
  type ItemSpec,
  type OrderSpec,
  type RunningSpec,
} from "./scheduleScenes";
import { contextOf, planOf, sceneOf, violationsOf, type RawScene } from "./restoreScenes";

const genRaw: fc.Arbitrary<RawScene> = fc
  .integer({ min: UNIT_COUNT_MIN, max: UNIT_COUNT_MAX })
  .chain((unitCount) =>
    fc.record({
      unitCount: fc.constant(unitCount),
      params: genParams(unitCount),
      running: fc.array(genRunning(unitCount * SLOTS_PER_UNIT), { maxLength: 5 }),
      orders: fc.array(genOrderSpec([...KNOWN_NOODLE_TYPES, UNKNOWN_NOODLE_TYPE]), {
        maxLength: 5,
      }),
    }),
  );

function paramsOf(unitCount: number, arms: number, liftIntervalSeconds: number): ScheduleParams {
  return {
    orderSyncWeight: 0,
    tableSyncWeight: 0,
    affinityWeight: 0,
    arms,
    toleranceRatio: 1,
    orderSyncToleranceSeconds: 0,
    tableSyncToleranceSeconds: 0,
    affinityToleranceDistance: 0,
    liftIntervalSeconds,
    unitOrigins: defaultUnitOrigins(unitCount),
    slotOffsets: DEFAULT_SLOT_OFFSETS,
  };
}

function running(slot: number, endOffset: number, tableId: string | null): RunningSpec {
  return { slot, endOffset, boiled: false, tableId };
}

function order(arrivalOffset: number, items: readonly ItemSpec[]): OrderSpec {
  return { arrivalTime: NOW + arrivalOffset, items };
}

function item(
  noodleType: "Thin" | "Medium" | "Thick",
  firmness: Firmness,
  tableId: string | null,
  slotSpan = 1,
): ItemSpec {
  return { noodleType, firmness, tableId, slotSpan };
}

/** 場面 E：24 釜・arms 1・L 49。走行中は卓 t-1 の 2 本（52.001 秒に上がる釜 0・いま上がる釜 1）。 */
const SCENE_E: RawScene = {
  unitCount: 4,
  params: paramsOf(4, 1, 49),
  running: [running(0, 52_001, "t-1"), running(1, 0, "t-1")],
  orders: [
    order(-599_999, [item("Thin", "extraHard", "t-1"), item("Thick", "extraHard", "t-2", 2)]),
    order(-600_000, [item("Thin", "hard", null, 2)]),
    order(-600_000, [item("Thick", "extraHard", "t-2"), item("Thin", "extraHard", "t-2")]),
  ],
};

describe("自前解と共通のハード制約（合成・ゲートと同じ述語）", () => {
  // 望む振る舞い：自前解のどの一片も keepsAnchor を守る。現状は赤（場面 E）。
  it.fails("場面 E: 実占有の 2 段目の出力は keepsAnchor（錨の主張・窓だけによる延期・押し出し無し）を守る", () => {
    const scene = sceneOf(SCENE_E);
    const anchors = violationsOf(scene, planOf(scene, null)).filter((v) => v.reason === "anchor");
    expect(anchors).toEqual([]);
  });

  // 【修正前の観測・上が緑になれば消す】場面 E の機構——1 段目は守り、2 段目は t-1 の一片で破る。2 段目は 1 段目より 47 秒悪い。
  it("場面 E: 観測——1 段目（占有なし）は守り、2 段目は卓 t-1 の一片で keepsAnchor を破り、1 段目より業務費用が 47 秒悪い", () => {
    const scene = sceneOf(SCENE_E);
    const stage1 = planOf({ ...scene, occupied: new Set() }, null);
    expect(violationsOf(scene, stage1).filter((v) => v.reason === "anchor")).toEqual([]);
    const stage2 = planOf(scene, null);
    expect(violationsOf(scene, stage2).filter((v) => v.reason === "anchor")).toEqual([
      { tableKey: "t-1", reason: "anchor" },
    ]);
    const serveAtOf = (plan: ReturnType<typeof planOf>) =>
      plan.slices
        .find((slice) => slice.tableKey === "t-1")!
        .placements.map((placement) => (placement.serveAt - NOW) / 1000);
    expect(serveAtOf(stage1)).toEqual([150.001]);
    expect(serveAtOf(stage2)).toEqual([199]);
    // 前回の文脈を持つ次回は窓の許す 101 秒を見つける（下限は前回の 2 段目の内側にしか無い）。
    const next = planOf(scene, contextOf(scene, stage2));
    expect(serveAtOf(next)).toEqual([101]);
  });

  // 実占有の 2 段目（前回の有無とも）は、解放表（重複なし・解放時刻より前に始めない・茹で時間の一致・slotSpan）と
  // 上げ窓の上限（withinLiftCap）を守る。isStale は「置ける品目」に限った計画対象に対して偽。keepsAnchor は場面 E の
  // とおり稀に破れるので（3000 場面に 1 回）ここでは主張しない。cannotStart は空き釜不足の待ち（AC 1.4）ゆえ主張しない。
  it("Property: 実占有の自前解は解放表・上げ窓の上限を守り、置ける品目に限れば一片は卓の計画対象と一致する", () => {
    fc.assert(
      fc.property(genRaw, (raw) => {
        const scene = sceneOf(raw);
        const placeable = placeableTargets(
          scene.pending,
          NOW,
          DEFAULT_NOODLE_PRESETS,
          scene.params,
        );
        const first = planOf(scene, null);
        const second = planOf(scene, contextOf(scene, first));
        for (const plan of [first, second]) {
          const violations = violationsOf(scene, plan).filter(
            (v) => v.reason === "release" || v.reason === "liftCap",
          );
          expect(violations).toEqual([]);
          for (const slice of plan.slices) expect(isStale(slice, placeable)).toBe(false);
        }
      }),
      { numRuns: 300 },
    );
  });
});
