// tests/core/startable-placement.property.test.ts — 「今」の配分の loop（baselineSchedule → 1 段目 → placeNow：配分 → 復元 →
// 検証 → 不正だけ再生成 → 新たな「今」を含めて配り直す → 固定を外す場面では候補 K と総費用で比べる）の性質。
//
// Feature: startable-placement
// **Validates: Requirements 1.1, 1.4〜1.8（改訂）, 2.1, 4.1（改訂）, 4.6, 4.7（改訂）, 4.9**
//
// 生成候補 F と保持候補 R のそれぞれについて主張する——`baselineSchedule` が選ぶのはどちらかで、選択は総費用で決まるので、
// 候補ごとに経過（`scheduleStages`：1 段目・候補 K・再生成・完成形）を読む。4.6 だけは 1 段目を `occupied` を空にして呼ぶ形で
// 得る（今割り当てられる釜が母集団の全部になり、配分はいまの釜をそのまま採る）。完成した候補は場面の Timer から引いた占有
// （`occupiedSlotsOf`）で呼ぶ。生成器は `schedule.property` と同じ形（走行中・boiled・卓・大盛・未知の麺種を振る）に、前回の
// 提案の有無を足す。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  baselineSchedule,
  initialRelease,
  joinWindowMillis,
  scheduleCandidates,
  scheduleStages,
  type CandidateStages,
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
import { physicalViolationsOf, sceneFrom, totalOf } from "./restoreScenes";

interface Scene {
  readonly pending: readonly PendingOrder[];
  readonly release: SlotRelease;
  readonly members: TableMembers;
  readonly lifts: LiftTable;
  readonly running: readonly Timer[];
  readonly slotCount: number;
  readonly params: ScheduleParams;
  /** 前回の提案を渡すか（前回の釜の第一候補と (i)(a) の経路・保持候補 R を踏む）。 */
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

/** 場面の計画（選ばれた候補）を `occupied` で組む。変更費用の文脈は場面ごとに一つ。 */
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

/** 場面の 2 候補（F・R）を `occupied` で組む。R は前回が無ければ null。 */
function candidatesOf(scene: Scene, occupied: ReadonlySet<number>) {
  const { fresh, retained } = scheduleCandidates(
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
  return retained === null ? [fresh] : [fresh, retained];
}

/** 場面の 2 候補の経過（1 段目・候補 K・再生成・完成形）。R は前回が無ければ無い。 */
function stagesOf(scene: Scene): readonly CandidateStages[] {
  const { fresh, retained } = scheduleStages(
    scene.pending,
    scene.release,
    scene.members,
    scene.lifts,
    DEFAULT_NOODLE_PRESETS,
    scene.params,
    NOW,
    occupiedSlotsOf(scene.running),
    contextOf(scene),
  );
  return retained === null ? [fresh] : [fresh, retained];
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

/** 検証の道具（`physicalViolationsOf`）が読む場面の形へ。 */
function sceneOfScene(scene: Scene) {
  return sceneFrom(scene.pending, scene.running, scene.slotCount, scene.params, NOW);
}

describe("Feature: startable-placement — 「今」の配分の loop の性質", () => {
  // Feature: startable-placement, Property 4.1（改訂）— 開始できる先頭
  // **Validates: Requirements 1.1, 1.5, 1.8, 2.1, 3.1, 4.1**
  //
  // **最終的に「今」に選ばれた品目の集合**（1 段目の「今」と、再生成で「今」になった品目）のうち最終的な表示の順で最初の品目
  // について、今割り当てられる釜（解放 ≤ now かつ Timer なし）がその slotSpan に足りるなら、その品目は Timer の無い釜に
  // `startAt ≤ now` で置かれ、表示（群 → 連鎖 → 全釜 idle → 先頭 arms 本）に先頭として現れる。「今」が一つも無ければ何も
  // 主張しない。選ばれた候補について主張する（どちらの候補も同じ loop を通る）。
  it("Property 4.1: 最終的な「今」の表示先頭は、今割り当てられる釜が足りれば Timer の無い釜に今置かれ、表示の先頭に現れる", () => {
    fc.assert(
      fc.property(genScene, (scene) => {
        const occupied = occupiedSlotsOf(scene.running);
        const plan = planOf(scene, occupied);
        const head = nowItemsOf(plan, scene.pending)[0];
        if (head === undefined) return;
        const assignable = scene.release.filter((at, slot) => at <= NOW && !occupied.has(slot));
        if (assignable.length < head.slotIds.length) return;

        expect(head.slotIds.every((slotId) => !occupied.has(slotOf(slotId)))).toBe(true);
        // 表示の先頭（arms ≥ 1 ゆえ最初の群の先頭は必ず Head に入る）。
        const groups = liftGroupsOf(liftItemsOf(plan, scene.pending), NOW);
        const heads = headsOf(visibleGroupsOf(groups), occupied, NOW, scene.params.arms);
        expect(heads).toContain(itemKeyOf(head));
      }),
      { numRuns: 300 },
    );
  });

  // Feature: startable-placement, Property 4.6 — 将来配置は現在の占有を直接の条件にしない
  // **Validates: Requirements 1.2, 4.6**
  //
  // どちらの候補も 1 段目に「今」を一つも選ばない計画（全員が待つ）では、占有は配分に読まれる相手を持たず、計画は `occupied`
  // に依らない——場面の Timer の占有でも、任意の釜の部分集合でも、占有なしの計画と一致する。
  it("Property 4.6: 1 段目に「今」の品目が無ければ、計画は占有（どの釜に Timer が在るか）に依らない", () => {
    fc.assert(
      fc.property(
        genScene.chain((scene) =>
          fc
            .subarray(Array.from({ length: scene.slotCount }, (_unused, slot) => slot))
            .map((subset) => ({ scene, subset })),
        ),
        ({ scene, subset }) => {
          const none = new Set<number>();
          if (
            candidatesOf(scene, none).some((stage1) => nowItemsOf(stage1, scene.pending).length > 0)
          )
            return;
          const stage1 = planOf(scene, none);
          expect(planOf(scene, occupiedSlotsOf(scene.running))).toEqual(stage1);
          expect(planOf(scene, new Set(subset))).toEqual(stage1);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: startable-placement, Property 4.7′（2026-09-07 改訂・判断 14 で限定）— 「今」の集合と時刻の保持
  // **Validates: Requirements 1.8, 4.7, 4.8**
  //
  // 候補ごとに、完成形の `startAt ≤ now` の品目の集合は 1 段目の集合を**含む**（再生成で「今」になった品目が足される）——
  // ただし判断 14 の入れ替えを除く：1 段目の「今」が完成形で「今」でないなら、engine は候補 K（1 段目の配置の時刻をすべて
  // 保ち、配分した釜だけを交換した計画）を実際に組んでおり、K が物理的なハード制約（計画順・解放表 / `keepsAnchor` /
  // `withinLiftCap`）を破るか、完成形の総費用（同じ旧 Shown_Plan に対する）が K より真に低い。K が合法なら完成形も合法。
  // 完成後の他品目・釜を固定して時刻だけ戻す検査では判別できない（判断 14）ので、K そのものを見る。
  // 「今」を保った品目の時刻は動かず、すべての「今」の品目は互いに素な釜を持つ（`pool` の上の排他的な割当・釜は反復で
  // 変わり得る）。配置される品目の集合も同じ。時刻は有限（取り置いた釜を取ることは無い）。
  it("Property 4.7′: 1 段目の「今」が「今」を失うのは K が違法か K より総費用が真に低いときだけ——「今」の時刻は動かず、「今」どうしの釜は重ならない", () => {
    fc.assert(
      fc.property(genScene, (scene) => {
        const context = contextOf(scene);
        const checked = sceneOfScene(scene);
        const nowOf = (placements: ReadonlyMap<ItemKey, Placement>) =>
          [...placements.entries()]
            .filter(([, placement]) => placement.startAt <= NOW)
            .map(([key]) => key)
            .sort();
        for (const { stage1, swap, completed } of stagesOf(scene)) {
          const before = byKey(stage1);
          const after = byKey(completed);
          expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
          const nowBefore = nowOf(before);
          const nowAfter = nowOf(after);
          const lost = nowBefore.filter((key) => !nowAfter.includes(key));
          for (const key of nowBefore) {
            if (nowAfter.includes(key))
              expect(after.get(key)!.startAt, key).toBe(before.get(key)!.startAt);
          }
          if (lost.length > 0) {
            // 「今」を失った品目が在る——engine は候補 K を組んでいる。K は 1 段目の時刻・錨を保ち釜だけが違う。
            expect(swap, lost.join(",")).not.toBeNull();
            const swapped = byKey(swap!);
            expect([...swapped.keys()].sort()).toEqual([...before.keys()].sort());
            for (const [key, placement] of swapped) {
              const original = before.get(key)!;
              expect([placement.startAt, placement.serveAt, placement.anchor], key).toEqual([
                original.startAt,
                original.serveAt,
                original.anchor,
              ]);
            }
            if (physicalViolationsOf(checked, swap!).length === 0) {
              expect(totalOf(checked, completed, context)).toBeLessThan(
                totalOf(checked, swap!, context),
              );
              expect(physicalViolationsOf(checked, completed)).toEqual([]);
            }
          }
          for (const [key, placement] of after) {
            expect(Number.isFinite(placement.serveAt), key).toBe(true);
          }
          const claimed = new Set<number>();
          for (const key of nowAfter) {
            for (const slotId of after.get(key)!.slotIds) {
              expect(claimed.has(slotOf(slotId)), key).toBe(false);
              claimed.add(slotOf(slotId));
            }
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: startable-placement, Property 4.9（判断 15）— 再生成した品目どうしのまとまり
  // **Validates: Requirements 4.9; lift-group-planning 1.4, 3.3, 9.9, 9.10**
  //
  // loop は固定した「今」の品目に残りを揃えない（Short／Long の帰結）が、固定した品目を除いた集合には生成器のまとまりの規則が
  // 従来どおり成り立つ。完成形の `startAt ≤ now` の配置はすべて最後の反復で固定されたもの（fresh が空で止まる）なので、
  // 「固定した「今」を除いた集合」＝一片の `startAt > now` の配置。その集合について `schedule.property` の Property 1／16 と
  // 同じ規則——各配置は自分の earliest（入力の解放表の自分の釜 ＋ 茹で時間）以上・走行中の仲間が無ければ錨は null で全員が
  // 集合の最遅の earliest 以上・仲間が在れば合流分は仲間の錨を所属に持ち（錨より h_i を超えて手前に置かれない）、残りは
  // 走行中の最遅以上・どれも走行中の最早より h_i を超えて手前に置かれない——を主張する。前提は一片が一つの batch に収まる
  // こと：再生成の幅は後の一片の固定した「今」の釜を取り置いた残り（`slotCount − Σ span(後の一片の「今」)`）なので、一片の
  // Σ span がそれを超える一片は見ない。上げ窓の上限（pack／split の成立）は固定分を含めて 4.8 が見る。
  it("Property 4.9: 固定した「今」を除いた集合は、群の錨から後ろへしか動かず、合流分は仲間の錨を所属に持つ", () => {
    fc.assert(
      fc.property(genScene, (scene) => {
        const { release, members, params, slotCount } = scene;
        const spanOf = new Map(scene.pending.map((order) => [itemKeyOf(order), order.slotSpan]));
        const earliestOf = (placement: Placement) =>
          Math.max(...placement.slotIds.map((slotId) => release[slotOf(slotId)]!)) +
          (placement.serveAt - placement.startAt);
        for (const { completed } of stagesOf(scene)) {
          completed.slices.forEach((slice, index) => {
            const reserved = completed.slices
              .slice(index + 1)
              .flatMap((later) => later.placements)
              .filter((placement) => placement.startAt <= NOW)
              .reduce((sum, placement) => sum + placement.slotIds.length, 0);
            const total = slice.placements.reduce(
              (sum, placement) => sum + (spanOf.get(itemKeyOf(placement)) ?? 1),
              0,
            );
            if (total > slotCount - reserved) return;
            const rest = slice.placements.filter((placement) => placement.startAt > NOW);
            if (rest.length === 0) return;
            for (const placement of rest) {
              expect(placement.serveAt).toBeGreaterThanOrEqual(earliestOf(placement));
            }
            const siblings = members.get(slice.tableKey);
            if (siblings === undefined) {
              const anchor = Math.max(...rest.map(earliestOf));
              for (const placement of rest) {
                expect(placement.anchor).toBeNull();
                expect(placement.serveAt).toBeGreaterThanOrEqual(anchor);
              }
              return;
            }
            const earliestSibling = siblings[0];
            const latestSibling = siblings[siblings.length - 1]!;
            for (const placement of rest) {
              const window = joinWindowMillis(placement.serveAt - placement.startAt, params);
              expect(placement.serveAt).toBeGreaterThanOrEqual(earliestSibling - window);
              if (placement.anchor !== null) {
                expect(siblings).toContain(placement.anchor);
                expect(placement.serveAt).toBeGreaterThanOrEqual(placement.anchor - window);
              } else {
                expect(placement.serveAt).toBeGreaterThanOrEqual(latestSibling);
              }
            }
          });
        }
      }),
      { numRuns: 300 },
    );
  });
});
