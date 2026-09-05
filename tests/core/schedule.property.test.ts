// tests/core/schedule.property.test.ts — 自前解 baselineSchedule（src/engine/schedule.ts）の property test。
//
// 対象は online-cook-scheduling の Property 1（常に feasible）・2（列挙順に依存しない）・15（64 件で打ち切る）。
// 純粋関数ゆえ workerd に依らず既定 pool で走る。
//
// Property 1 が最も重い主張である。ハード制約の 3 つ——(a) 同一 slot の時間帯を重複させない、
// (b) 各時点の同時走行本数が slot 数以下、(c) 開始済み Timer の割当と実効 endTime を変更しない——を
// 検査する述語は tests/core/scheduleScenes.ts に置く。合成後の feasibility（Property 20）が同じ主張を
// するため、feasible の定義を二箇所に持たない。(c) は「解放表の初期値より前に開始する配置が無い」ことで見る。
// 解放表は開始済み Timer の占有を織り込む唯一の経路（initialRelease）であり、その初期値を侵さないことが
// 「既存の茹でに触らない」ことと同義である。
//
// 生成器の方針：release は initialRelease から作る。手で置いた解放表では (c) の検査が「引数どおりか」の
// 確認に留まり、走行中・茹で上がり済みの釜が計画にどう効くかを踏まない。
// pending は (externalOrderId, itemIndex) が一意になるよう注文単位で組む——集合としての一意性は
// upsertOrder が保証する事実（Property 8）であり、重複を含む集合に対する主張は現実に対応しない。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PLAN_TARGET_LIMIT,
  baselineSchedule,
  initialRelease,
  type SlotRelease,
} from "../../src/engine/schedule";
import type { ScheduleParams } from "../../src/engine/objective";
import { tableMembers, type TableMembers } from "../../src/engine/project";
import type { Timer } from "../../src/engine/timer";
import type { PendingOrder } from "../../src/domain/order";
import type { Firmness } from "../../src/domain/firmness";
import {
  DEFAULT_NOODLE_PRESETS,
  SLOTS_PER_UNIT,
  UNIT_COUNT_MAX,
  UNIT_COUNT_MIN,
} from "../../src/domain/store";
import {
  KNOWN_NOODLE_TYPES,
  NOW,
  UNKNOWN_NOODLE_TYPE,
  allPlacements,
  exceedsSlotCount,
  genOrderSpec,
  genParams,
  genRunning,
  hasOverlapOnSameSlot,
  startsBeforeRelease,
  timerOn,
  toPending,
} from "./scheduleScenes";

/** 生成した場面。baselineSchedule の引数と、検査に要る slot 数が揃う。 */
interface Scene {
  readonly pending: readonly PendingOrder[];
  readonly release: SlotRelease;
  readonly members: TableMembers;
  readonly running: readonly Timer[];
  readonly slotCount: number;
  readonly params: ScheduleParams;
}

const genScene: fc.Arbitrary<Scene> = fc
  .integer({ min: UNIT_COUNT_MIN, max: UNIT_COUNT_MAX })
  .chain((unitCount) => {
    const slotCount = unitCount * SLOTS_PER_UNIT;
    return fc.record({
      slotCount: fc.constant(slotCount),
      params: genParams(unitCount),
      running: fc.array(genRunning(slotCount), { maxLength: 5 }),
      // 未知の麺種を低い頻度で混ぜる（既知 3 種 + 未知 1 種）。
      orders: fc.array(genOrderSpec([...KNOWN_NOODLE_TYPES, UNKNOWN_NOODLE_TYPE]), {
        maxLength: 5,
      }),
    });
  })
  .map(({ slotCount, params, running, orders }) => {
    const timers = running.map(timerOn);
    return {
      pending: toPending(orders),
      release: initialRelease(timers, NOW, slotCount),
      members: tableMembers(timers),
      running: timers,
      slotCount,
      params,
    };
  });

describe("engine/schedule — baselineSchedule", () => {
  // Feature: online-cook-scheduling, Property: 1 — Baseline_Plan は常に feasible
  // **Validates: Requirements 4.2**
  //
  // Requirement 3 のハード制約 3 つをすべて満たすこと。ソフト制約（同時提供・slot 近接）は超過分が
  // 目的関数へ計上されるだけで feasibility の否定事由にはならない（AC 3.5）ので、ここでは見ない。
  // 未知の麺種が混ざった場面も含む——茹で時間が引けない品目は配置されないが、それが同じグループの
  // 他の品目の配置を壊さないことを、同じ述語が同時に検査する。
  it("Property 1: ハード制約 (a) 重複なし (b) 同時本数 ≤ slot 数 (c) 解放時刻より前に開始しない", () => {
    fc.assert(
      fc.property(genScene, ({ pending, release, members, slotCount, params }) => {
        const schedule = baselineSchedule(
          pending,
          release,
          members,
          DEFAULT_NOODLE_PRESETS,
          params,
        );
        const placements = allPlacements(schedule.slices);

        expect(hasOverlapOnSameSlot(placements)).toBe(false);
        expect(exceedsSlotCount(placements, slotCount)).toBe(false);
        expect(startsBeforeRelease(placements, release)).toBe(false);

        // 提供時刻は開始時刻 + 茹で時間ゆえ必ず後（時間の向きが逆の配置は計画として嘘である）。
        for (const placement of placements) {
          expect(placement.serveAt).toBeGreaterThan(placement.startAt);
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: online-cook-scheduling, Property: 2 — Baseline_Plan は列挙順に依存しない
  // **Validates: Requirements 4.3**
  //
  // Pending_Order の列挙順を任意に置換しても結果は同一である（部分和と総和・slice の並びまで含めて）。
  // Running_Timer の列挙順については主張しない——この署名は Timer 集合を受けず解放表を受け、
  // 解放表の各要素は占める Timer の実効 endTime の最大値ゆえ、列挙順に依らないことが initialRelease の
  // 側で閉じている（同じ主張を二箇所で立てない）。
  it("Property 2: pending の順列に対して結果が一致する", () => {
    fc.assert(
      fc.property(
        genScene.chain((scene) =>
          fc
            .shuffledSubarray([...scene.pending], {
              minLength: scene.pending.length,
              maxLength: scene.pending.length,
            })
            .map((shuffled) => ({ scene, shuffled })),
        ),
        ({ scene, shuffled }) => {
          const canonical = baselineSchedule(
            scene.pending,
            scene.release,
            scene.members,
            DEFAULT_NOODLE_PRESETS,
            scene.params,
          );
          const permuted = baselineSchedule(
            shuffled,
            scene.release,
            scene.members,
            DEFAULT_NOODLE_PRESETS,
            scene.params,
          );

          expect(permuted).toEqual(canonical);
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: online-cook-scheduling, Property: 15 — 計画対象は 64 件で打ち切られる
  // **Validates: Requirements 11.2**
  //
  // 計画に現れる品目は、正準順序（arrivalTime 昇順, externalOrderId 昇順, itemIndex 昇順）の先頭
  // PLAN_TARGET_LIMIT 件と厳密に一致する。超過分は計画に現れず、ゆえに推奨の対象にもならない
  // （保持と表示は続くが、それは待ち行列の関心事であってここではない）。
  // 麺種は既知のみで振る——茹で時間が引けない品目の除外が混ざると「64 件で切れた」ことが観測できない。
  it("Property 15: 計画対象は正準順序の先頭 64 件と厳密に一致する", () => {
    fc.assert(
      fc.property(genLargeScene, ({ pending, release, members, params }) => {
        const schedule = baselineSchedule(
          pending,
          release,
          members,
          DEFAULT_NOODLE_PRESETS,
          params,
        );
        const placed = allPlacements(schedule.slices).map((placement) =>
          keyOf(placement.externalOrderId, placement.itemIndex),
        );

        expect(placed).toHaveLength(Math.min(pending.length, PLAN_TARGET_LIMIT));
        expect(new Set(placed)).toEqual(new Set(planTargetKeys(pending)));
      }),
      { numRuns: 200 },
    );
  });
});

/** 品目を一意に指す鍵（テスト側の照合用）。 */
const keyOf = (externalOrderId: string, itemIndex: number): string =>
  `${externalOrderId}#${itemIndex}`;

/** テスト側で独立に求めた計画対象の鍵集合（実装と同じ正準順序を、実装を呼ばずに組む）。 */
function planTargetKeys(pending: readonly PendingOrder[]): readonly string[] {
  return [...pending]
    .sort(
      (order, other) =>
        order.arrivalTime - other.arrivalTime ||
        (order.externalOrderId === other.externalOrderId
          ? 0
          : order.externalOrderId < other.externalOrderId
            ? -1
            : 1) ||
        order.itemIndex - other.itemIndex,
    )
    .slice(0, PLAN_TARGET_LIMIT)
    .map((order) => keyOf(order.externalOrderId, order.itemIndex));
}

/** 上限の境界を跨ぐ規模の場面（既知の麺種のみ・釜は空きから始まる）。 */
const genLargeScene: fc.Arbitrary<Scene> = fc
  .integer({ min: UNIT_COUNT_MIN, max: UNIT_COUNT_MAX })
  .chain((unitCount) =>
    fc.record({
      slotCount: fc.constant(unitCount * SLOTS_PER_UNIT),
      params: genParams(unitCount),
      orders: fc.array(
        fc.record({
          arrivalTime: fc.integer({ min: NOW - 600_000, max: NOW }),
          items: fc.array(
            fc.record({
              noodleType: fc.constantFrom(...KNOWN_NOODLE_TYPES),
              firmness: fc.constantFrom<Firmness>("extraHard", "hard", "normal", "soft"),
              tableId: fc.oneof(fc.constantFrom("t-1", "t-2", "t-3"), fc.constant(null)),
              slotSpan: fc.constant(1),
            }),
            { minLength: 1, maxLength: 4 },
          ),
        }),
        // 品目数が上限（64）の前後に散るよう注文数を振る。
        { minLength: 10, maxLength: 30 },
      ),
    }),
  )
  .map(({ slotCount, params, orders }) => ({
    pending: toPending(orders),
    release: initialRelease([], NOW, slotCount),
    members: tableMembers([]),
    running: [],
    slotCount,
    params,
  }));

describe("engine/schedule — 同時に上げる群（lift-group-planning）", () => {
  // Feature: lift-group-planning, Property 1 — 錨への一致
  // **Validates: Requirements 1.4, 3.3, 3.4, 7.1**
  //
  // 釜容量に収まる一片では、走行中の仲間が居なければ未着手の配置の serveAt がすべて等しく、各配置の
  // earliest 以上である。走行中の仲間が居れば（Property 16・判断 16・ADR-0007）配置は高々 2 つの serveAt に
  // 分かれる——走行中の錨に**合流した**配置はちょうど錨に一致し、残りは一つの値に揃って錨より後ろにある。
  // 容量を超える一片は batch に割れるので対象外（Property 14）。
  it("Property 1 / 16: 容量に収まる一片は、走行中が無ければ一つの serveAt に揃い、在れば合流分が錨に一致し残りが一つに揃う", () => {
    fc.assert(
      fc.property(genScene, ({ pending, release, members, slotCount, params }) => {
        const schedule = baselineSchedule(
          pending,
          release,
          members,
          DEFAULT_NOODLE_PRESETS,
          params,
        );
        const spanOf = new Map(
          pending.map((order) => [
            `${order.externalOrderId}\u0000${order.itemIndex}`,
            order.slotSpan,
          ]),
        );
        for (const slice of schedule.slices) {
          const totalSpan = slice.placements.reduce(
            (sum, placement) =>
              sum + (spanOf.get(`${placement.externalOrderId}\u0000${placement.itemIndex}`) ?? 1),
            0,
          );
          if (totalSpan > slotCount) continue;
          const serveTimes = [...new Set(slice.placements.map((placement) => placement.serveAt))];
          const siblings = members.get(slice.tableKey);
          if (siblings === undefined) {
            expect(serveTimes).toHaveLength(1);
          } else {
            const runningAnchor = Math.max(...siblings);
            // 合流分（錨に一致）と残り（錨より後ろで一つに揃う）の高々 2 値。
            expect(serveTimes.length).toBeLessThanOrEqual(2);
            for (const serveAt of serveTimes) expect(serveAt).toBeGreaterThanOrEqual(runningAnchor);
            if (serveTimes.length === 2) expect(serveTimes).toContain(runningAnchor);
          }
          // 各配置は自分の釜の解放時刻 + 茹で時間 以上（下限のクランプ無しで構成から従う）。
          for (const placement of slice.placements) {
            const boil = placement.serveAt - placement.startAt;
            const earliest =
              Math.max(...placement.slotIds.map((slotId) => release[Number(slotId)]!)) + boil;
            expect(placement.serveAt).toBeGreaterThanOrEqual(earliest);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: lift-group-planning, Property 3 / 14 — slotSpan と batch
  // **Validates: Requirements 4.1, 4.4, 4.5, 7.3**
  it("Property 3 / 14: 各配置は slotSpan 個の相異なる釜を持ち、同時刻の占有は釜数を超えない", () => {
    fc.assert(
      fc.property(genScene, ({ pending, release, members, slotCount, params }) => {
        const schedule = baselineSchedule(
          pending,
          release,
          members,
          DEFAULT_NOODLE_PRESETS,
          params,
        );
        const spanOf = new Map(
          pending.map((order) => [
            `${order.externalOrderId}\u0000${order.itemIndex}`,
            order.slotSpan,
          ]),
        );
        for (const placement of allPlacements(schedule.slices)) {
          const span = spanOf.get(`${placement.externalOrderId}\u0000${placement.itemIndex}`);
          expect(placement.slotIds.length).toBe(span);
          expect(new Set(placement.slotIds).size).toBe(placement.slotIds.length);
        }
        expect(exceedsSlotCount(allPlacements(schedule.slices), slotCount)).toBe(false);
        expect(hasOverlapOnSameSlot(allPlacements(schedule.slices))).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});
