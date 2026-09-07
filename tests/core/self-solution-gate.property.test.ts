// tests/core/self-solution-gate.property.test.ts — 自前解（`baselineSchedule` の 2 候補・完成した生成候補 F と保持候補 R）の出力を、
// 確定計画の合成（`livePrefix`）とゲート（`admit`）が採用済み・外部の一片に当てるのと**同じハード制約の述語**で、計画順に
// 一片を置く前の表で検査する。
//
// Feature: startable-placement（性質 4.8）/ plan-stability（性質 5.10・AC 6.3）
// **Validates: Requirements startable-placement 4.5, 4.8; plan-stability 5.10, 6.3; lift-group-planning 9.10**
//
// 検査するのは物理的なハード制約——置ける品目に限る `isStale`（一片 ＝ 卓の計画対象）・解放表（`feasibleRelease`：重複なし・
// 解放時刻より前に始めない・茹で時間の一致・slotSpan）・`keepsAnchor`（錨の主張・窓だけによる延期・押し出し無し）・上げ窓の
// 上限（`withinLiftCap`）。`cannotStart` は保持の条件であって成立の条件ではない（判断 13）——空き釜不足で boiled の釜に「今」
// 置いて待つ配置（AC 1.4）は合法ゆえ数えない。自前解だから免れる述語は無い（AC 6.3）。1 段目への実行時のフォールバックは
// 置かない——場面 E（task 3 の 2 段目が `raiseToFloor` の下限で `keepsAnchor` (d) を破った縮約例）は、loop（復元 → 検証 →
// 不正だけ再生成）で 1 段目の 150.001 秒提供のまま守る。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ScheduleParams } from "../../src/engine/objective";
import type { Firmness } from "../../src/domain/firmness";
import { DEFAULT_SLOT_OFFSETS, defaultUnitOrigins } from "../../src/domain/store";
import { NOW, type ItemSpec, type OrderSpec, type RunningSpec } from "./scheduleScenes";
import {
  candidatesOf,
  contextOf,
  genRawScene,
  physicalViolationsOf,
  planOf,
  sceneOf,
  type RawScene,
} from "./restoreScenes";

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
  it("場面 E: 完成した候補は keepsAnchor を守り、卓 t-1 の合流分は 1 段目と同じ 150.001 秒提供のまま（下限で 199 秒へ押さない）", () => {
    const scene = sceneOf(SCENE_E);
    const plan = planOf(scene, null);
    expect(physicalViolationsOf(scene, plan)).toEqual([]);
    const serveAtOf = plan.slices
      .find((slice) => slice.tableKey === "t-1")!
      .placements.map((placement) => (placement.serveAt - NOW) / 1000);
    expect(serveAtOf).toEqual([150.001]);
    // 「今」の卓なし大盛は Timer の残る釜 1 ではなく、開始できる釜に置かれる。
    const long = plan.slices
      .flatMap((slice) => slice.placements)
      .find((placement) => placement.externalOrderId === "o-1")!;
    expect(long.startAt).toBe(NOW);
    expect(long.slotIds.map(Number).some((slot) => scene.occupied.has(slot))).toBe(false);
  });

  // Feature: plan-stability, Property 5.10 / startable-placement, Property 4.8 — 自前解の合法性
  it("Property 5.10 / 4.8: 完成した F と R（前回なし・前回あり）は、計画順に isStale・解放表・keepsAnchor・withinLiftCap を守る", () => {
    fc.assert(
      fc.property(genRawScene, (raw) => {
        const scene = sceneOf(raw);
        const first = planOf(scene, null);
        expect(physicalViolationsOf(scene, first)).toEqual([]);
        const { fresh, retained } = candidatesOf(scene, contextOf(scene, first));
        expect(physicalViolationsOf(scene, fresh)).toEqual([]);
        if (retained !== null) expect(physicalViolationsOf(scene, retained)).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});
