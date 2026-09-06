// tests/core/startable-placement.property.test.ts — 2 段の計画（baselineSchedule → pinNow → 2 段目）の性質。
//
// Feature: startable-placement
// **Validates: Requirements 1.1, 1.4〜1.8, 2.1, 4.1, 4.6, 4.7**
//
// 1 段目は `occupied` を空にして呼ぶと得られる——今割り当てられる釜が母集団の全部になり、配分は 1 段目の釜をそのまま採る
// （(i)(b)）ので 2 段目は組まれない。2 段目は場面の Timer から引いた占有（`occupiedSlotsOf`）で呼ぶ。生成器は
// `schedule.property` と同じ形（走行中・boiled・卓・大盛・未知の麺種を振る）に、前回の提案の有無を足す。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  baselineSchedule,
  initialRelease,
  type CookSchedule,
  type Placement,
  type SlotRelease,
} from "../../src/engine/schedule";
import type { ScheduleParams } from "../../src/engine/objective";
import { initialLifts, type LiftTable } from "../../src/engine/lift";
import { tableMembers, type TableMembers } from "../../src/engine/project";
import { recommend } from "../../src/engine/recommend";
import { shownPlanOf, type ChangeContext } from "../../src/engine/stability";
import { boilMillisOf } from "../../src/engine/boil";
import type { Timer } from "../../src/engine/timer";
import { headsOf, liftGroupsOf, visibleGroupsOf, type LiftItem } from "../../src/domain/lift-group";
import { compareArrival, itemKeyOf, type ItemKey, type PendingOrder } from "../../src/domain/order";
import {
  DEFAULT_NOODLE_PRESETS,
  SLOTS_PER_UNIT,
  UNIT_COUNT_MAX,
  UNIT_COUNT_MIN,
  occupiedSlotsOf,
  slotOf,
} from "../../src/domain/store";
import {
  KNOWN_NOODLE_TYPES,
  NOW,
  UNKNOWN_NOODLE_TYPE,
  allPlacements,
  genOrderSpec,
  genParams,
  genRunning,
  timerOn,
  toPending,
} from "./scheduleScenes";

interface Scene {
  readonly pending: readonly PendingOrder[];
  readonly release: SlotRelease;
  readonly members: TableMembers;
  readonly lifts: LiftTable;
  readonly running: readonly Timer[];
  readonly slotCount: number;
  readonly params: ScheduleParams;
  /** 前回の提案を渡すか（前回の釜の第一候補と (i)(a) の経路を踏む）。 */
  readonly withShown: boolean;
}

const genScene: fc.Arbitrary<Scene> = fc
  .integer({ min: UNIT_COUNT_MIN, max: UNIT_COUNT_MAX })
  .chain((unitCount) => {
    const slotCount = unitCount * SLOTS_PER_UNIT;
    return fc.record({
      slotCount: fc.constant(slotCount),
      params: genParams(unitCount),
      running: fc.array(genRunning(slotCount), { maxLength: 6 }),
      orders: fc.array(genOrderSpec([...KNOWN_NOODLE_TYPES, UNKNOWN_NOODLE_TYPE]), {
        maxLength: 5,
      }),
      withShown: fc.boolean(),
    });
  })
  .map(({ slotCount, params, running, orders, withShown }) => {
    const timers = running.map(timerOn);
    return {
      pending: toPending(orders),
      release: initialRelease(timers, NOW, slotCount),
      members: tableMembers(timers),
      lifts: initialLifts(timers),
      running: timers,
      slotCount,
      params,
      withShown,
    };
  });

/**
 * 場面の計画を `occupied` で組む。変更費用の文脈は場面ごとに一つ——前回の提案は「場面の占有で組んだ計画」を Shown_Plan に
 * したもので、1 段目と 2 段目の比較は同じ文脈で行う（文脈が違えば 1 段目そのものが違う計画になる）。
 */
function planOf(scene: Scene, occupied: ReadonlySet<number>): CookSchedule {
  return baselineSchedule(
    scene.pending,
    scene.release,
    scene.members,
    scene.lifts,
    DEFAULT_NOODLE_PRESETS,
    scene.params,
    NOW,
    occupied,
    contextOf(scene),
  );
}

function contextOf(scene: Scene): ChangeContext | null {
  if (!scene.withShown) return null;
  const { pending, release, members, lifts, params, running } = scene;
  const previous = baselineSchedule(
    pending,
    release,
    members,
    lifts,
    DEFAULT_NOODLE_PRESETS,
    params,
    NOW,
    occupiedSlotsOf(running),
    null,
  );
  return {
    shown: shownPlanOf(previous, recommend(previous)),
    running,
    now: NOW,
    pending,
    presets: DEFAULT_NOODLE_PRESETS,
  };
}

/** 1 段目（占有なし——今割り当てられる釜が母集団の全部で、配分は 1 段目の釜をそのまま採る）。 */
function stage1Of(scene: Scene): CookSchedule {
  return planOf(scene, new Set());
}

/** 2 段目（場面の Timer の占有）。 */
function stage2Of(scene: Scene): CookSchedule {
  return planOf(scene, occupiedSlotsOf(scene.running));
}

/** 「今」の配置（`startAt ≤ now`）を表示の順（startAt 昇順・同値は到着順）に。 */
function nowItemsOf(
  schedule: CookSchedule,
  pending: readonly PendingOrder[],
): readonly Placement[] {
  const orderByKey = new Map(pending.map((order) => [itemKeyOf(order), order]));
  return allPlacements(schedule.slices)
    .filter((placement) => placement.startAt <= NOW)
    .sort(
      (a, b) =>
        a.startAt - b.startAt ||
        compareArrival(orderByKey.get(itemKeyOf(a))!, orderByKey.get(itemKeyOf(b))!),
    );
}

function byKey(schedule: CookSchedule): ReadonlyMap<ItemKey, Placement> {
  return new Map(
    allPlacements(schedule.slices).map((placement) => [itemKeyOf(placement), placement]),
  );
}

/** 推奨を表示の入力（LiftItem）へ（client の liftGroups と同じ組み立て）。 */
function liftItemsOf(
  schedule: CookSchedule,
  pending: readonly PendingOrder[],
): readonly LiftItem[] {
  const orderByKey = new Map(pending.map((order) => [itemKeyOf(order), order]));
  return recommend(schedule).map((recommendation) => {
    const order = orderByKey.get(itemKeyOf(recommendation))!;
    return {
      recommendation,
      order,
      boilSeconds: boilMillisOf(order, DEFAULT_NOODLE_PRESETS)! / 1000,
    };
  });
}

describe("Feature: startable-placement — 2 段の計画の性質", () => {
  // Feature: startable-placement, Property 4.1 — 開始できる先頭
  // **Validates: Requirements 1.1, 1.5, 2.1, 3.1, 4.1**
  //
  // 1 段目で「今」に選ばれた品目のうち表示の順で最初の品目について、今割り当てられる釜（解放 ≤ now かつ Timer なし）が
  // その slotSpan に足りるなら、2 段目はその品目を Timer の無い釜に `startAt ≤ now` で置き、表示（群 → 連鎖 → 全釜 idle →
  // 先頭 arms 本）にその品目が先頭として現れる。1 段目が「今」を一つも選ばない計画では何も主張しない。
  it("Property 4.1: 1 段目の「今」の表示先頭は、今割り当てられる釜が足りれば Timer の無い釜に今置かれ、表示の先頭に現れる", () => {
    fc.assert(
      fc.property(genScene, (scene) => {
        const stage1 = stage1Of(scene);
        const head = nowItemsOf(stage1, scene.pending)[0];
        if (head === undefined) return;
        const occupied = occupiedSlotsOf(scene.running);
        const assignable = scene.release.filter((at, slot) => at <= NOW && !occupied.has(slot));
        if (assignable.length < head.slotIds.length) return;

        const stage2 = stage2Of(scene);
        const placed = byKey(stage2).get(itemKeyOf(head))!;
        expect(placed.startAt).toBeLessThanOrEqual(NOW);
        expect(placed.slotIds.every((slotId) => !occupied.has(slotOf(slotId)))).toBe(true);
        // 表示の先頭（arms ≥ 1 ゆえ最初の群の先頭は必ず Head に入る）。
        const groups = liftGroupsOf(liftItemsOf(stage2, scene.pending), NOW);
        const heads = headsOf(visibleGroupsOf(groups), occupied, NOW, scene.params.arms);
        expect(heads).toContain(itemKeyOf(head));
      }),
      { numRuns: 300 },
    );
  });

  // Feature: startable-placement, Property 4.6 — 将来配置は現在の占有を直接の条件にしない
  // **Validates: Requirements 1.2, 4.6**
  //
  // 1 段目が「今」を一つも選ばない計画（全員が待つ）では、占有は配分に読まれる相手を持たず、計画は `occupied` に依らない
  // ——場面の Timer の占有でも、任意の釜の部分集合でも、占有なしの計画と一致する。
  it("Property 4.6: 1 段目に「今」の品目が無ければ、計画は占有（どの釜に Timer が在るか）に依らない", () => {
    fc.assert(
      fc.property(
        genScene.chain((scene) =>
          fc
            .subarray(Array.from({ length: scene.slotCount }, (_unused, slot) => slot))
            .map((subset) => ({ scene, subset })),
        ),
        ({ scene, subset }) => {
          const stage1 = stage1Of(scene);
          if (nowItemsOf(stage1, scene.pending).length > 0) return;
          expect(stage2Of(scene)).toEqual(stage1);
          expect(planOf(scene, new Set(subset))).toEqual(stage1);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: startable-placement, Property 4.7 — 「今」の集合の不変
  // **Validates: Requirements 1.8, 4.7**
  //
  // 2 段目の `startAt ≤ now` の品目の集合は 1 段目と等しく、各品目の `startAt` は 1 段目以上（前倒ししない）。配置される
  // 品目の集合も同じ。固定した配置（2 段目の「今」の品目）どうしの釜は相異なる（`pool` の上の排他的な割当）。
  it("Property 4.7: 「今」の集合は 1 段目と等しく、各 startAt は 1 段目以上、固定配置どうしの釜は重ならない", () => {
    fc.assert(
      fc.property(genScene, (scene) => {
        const stage1 = byKey(stage1Of(scene));
        const stage2 = byKey(stage2Of(scene));
        expect([...stage2.keys()].sort()).toEqual([...stage1.keys()].sort());
        const nowOf = (placements: ReadonlyMap<ItemKey, Placement>) =>
          [...placements.entries()]
            .filter(([, placement]) => placement.startAt <= NOW)
            .map(([key]) => key)
            .sort();
        expect(nowOf(stage2)).toEqual(nowOf(stage1));
        for (const [key, placement] of stage2) {
          expect(placement.startAt, key).toBeGreaterThanOrEqual(stage1.get(key)!.startAt);
          // 取り置いた釜（解放が無限大）を取ることは無い——時刻は有限（上げ表の走査が止まる前提）。
          expect(Number.isFinite(placement.serveAt), key).toBe(true);
        }
        const claimed = new Set<number>();
        for (const key of nowOf(stage2)) {
          for (const slotId of stage2.get(key)!.slotIds) {
            expect(claimed.has(slotOf(slotId)), key).toBe(false);
            claimed.add(slotOf(slotId));
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
