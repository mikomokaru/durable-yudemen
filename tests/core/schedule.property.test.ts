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
  advanceRelease,
  baselineSchedule,
  initialRelease,
  joinWindowMillis,
  keepsAnchor,
  planTargets,
  type CookSchedule,
  type PlanSlice,
  refersTo,
  type Placement,
  type SlotRelease,
} from "../../src/engine/schedule";
import { scoreSchedule, type ScheduleParams } from "../../src/engine/objective";
import {
  advanceLifts,
  initialLifts,
  liftCap,
  liftsOf,
  loadWith,
  withinLiftCap,
  type LiftTable,
} from "../../src/engine/lift";
import { tableMembers, type TableMembers } from "../../src/engine/project";
import { recommend } from "../../src/engine/recommend";
import { changeCost, shownPlanOf, type ChangeContext } from "../../src/engine/stability";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { ORDER_LIFETIME_MS, type PendingOrder } from "../../src/domain/order";
import type { Firmness } from "../../src/domain/firmness";
import {
  DEFAULT_NOODLE_PRESETS,
  SLOTS_PER_UNIT,
  occupiedSlotsOf,
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
import { nonEmpty } from "../nonEmpty";

/** 生成した場面。baselineSchedule の引数と、検査に要る slot 数が揃う。 */
interface Scene {
  readonly pending: readonly PendingOrder[];
  readonly release: SlotRelease;
  readonly members: TableMembers;
  readonly lifts: LiftTable;
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
      lifts: initialLifts(timers),
      running: timers,
      slotCount,
      params,
    };
  });

/** 一片ごとの配置を釜を除いた形（品目・開始・提供・錨）に写す。釜の対応づけを主張しない比較に使う。 */
function timingsOf(slices: readonly PlanSlice[]) {
  return slices.map((slice) => ({
    tableKey: slice.tableKey,
    placements: slice.placements.map(
      ({ externalOrderId, itemIndex, startAt, serveAt, anchor }) => ({
        externalOrderId,
        itemIndex,
        startAt,
        serveAt,
        anchor,
      }),
    ),
  }));
}

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
      fc.property(genScene, ({ pending, release, members, lifts, running, slotCount, params }) => {
        const schedule = baselineSchedule(
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
            scene.lifts,
            DEFAULT_NOODLE_PRESETS,
            scene.params,
            NOW,
            occupiedSlotsOf(scene.running),
            null,
          );
          const permuted = baselineSchedule(
            shuffled,
            scene.release,
            scene.members,
            scene.lifts,
            DEFAULT_NOODLE_PRESETS,
            scene.params,
            NOW,
            occupiedSlotsOf(scene.running),
            null,
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
      fc.property(genLargeScene, ({ pending, release, members, lifts, running, params }) => {
        const schedule = baselineSchedule(
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
    lifts: initialLifts([]),
    running: [],
    slotCount,
    params,
  }));

describe("engine/schedule — 同時に上げる群（lift-group-planning）", () => {
  // Feature: lift-group-planning, Property 1 — 錨への一致
  // **Validates: Requirements 1.4, 3.3, 3.4, 7.1, 9.4, 9.9**
  //
  // 釜容量に収まる一片では、群の候補時刻（錨）はひとつで、上げ窓はそこから後ろへしか動かさない（AC 9.4）。
  // 走行中の仲間が居なければ未着手の配置はすべて自分の earliest 以上かつ群の最遅の earliest 以上（全員が同じ錨から
  // 出発する）で、合流の所属は無い（AC 9.9）。走行中の仲間が居れば（Property 16・判断 16・ADR-0007）合流分は錨を
  // 仲間の中に持ち、錨より h_i を超えて手前には置かれず（AC 9.10 (b)）、残りは走行中の最遅以上に置かれる。
  // 錨との一致そのもの（serveAt = anchor）は上げ窓が破りうるので主張しない——窓で動いても所属は変わらない
  // （判断 20）。容量を超える一片は batch に割れるので対象外（Property 14）。
  it("Property 1 / 16: 容量に収まる一片は、群の錨から後ろへしか動かず、合流分は仲間の錨を所属に持つ", () => {
    fc.assert(
      fc.property(genScene, ({ pending, release, members, lifts, running, slotCount, params }) => {
        const schedule = baselineSchedule(
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
          // 各配置は自分の釜の解放時刻 + 茹で時間 以上（下限のクランプ無しで構成から従う）。
          const earliestOf = (placement: Placement) =>
            Math.max(...placement.slotIds.map((slotId) => release[Number(slotId)]!)) +
            (placement.serveAt - placement.startAt);
          for (const placement of slice.placements) {
            expect(placement.serveAt).toBeGreaterThanOrEqual(earliestOf(placement));
          }
          const siblings = members.get(slice.tableKey);
          if (siblings === undefined) {
            // 走行中の仲間が居なければ合流の所属は無く（AC 9.9）、全員が群の錨（最遅の earliest）以上に上がる。
            const anchor = Math.max(...slice.placements.map(earliestOf));
            for (const placement of slice.placements) {
              expect(placement.anchor).toBeNull();
              expect(placement.serveAt).toBeGreaterThanOrEqual(anchor);
            }
          } else {
            const earliestSibling = siblings[0];
            const latestSibling = siblings[siblings.length - 1]!;
            for (const placement of slice.placements) {
              const window = joinWindowMillis(placement.serveAt - placement.startAt, params);
              // 走行中の最早より h_i を超えて手前に散らさない。
              expect(placement.serveAt).toBeGreaterThanOrEqual(earliestSibling - window);
              if (placement.anchor !== null) {
                // 合流の所属は配置が持つ（AC 9.9）：錨は走行中の仲間の実効 endTime のいずれかで、錨より h_i を
                // 超えて手前には置かれない（AC 9.10 (b)）。錨より後ろへは上げ窓がいくらでも動かしうる。
                expect(siblings).toContain(placement.anchor);
                expect(placement.serveAt).toBeGreaterThanOrEqual(placement.anchor - window);
              } else {
                // 合流していない残りは走行中の最遅を下限に置かれる（Group_Anchor・AC 3.3）。
                expect(placement.serveAt).toBeGreaterThanOrEqual(latestSibling);
              }
            }
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: lift-group-planning, Property 7.8 — 上げ窓の上限
  // **Validates: Requirements 7.8, 9.3, 9.4, 9.11, 9.12**
  //
  // 自前解のどの配置についても、それを含むすべての窓（半開・長さ L）の負荷——走行中の上がりと計画済みの
  // すべての配置の slotSpan の合計——は arms + HELPER_ARMS を超えない。窓は店舗全体で数えるので一片を跨いで
  // 見る。1 品で上限を超える品目は配置されない（AC 9.12）。
  it("Property 7.8: 自前解の各配置を含む窓の負荷は arms + HELPER_ARMS を超えず、1 品で超える品目は置かれない", () => {
    fc.assert(
      fc.property(genScene, ({ pending, release, members, lifts, running, params }) => {
        const schedule = baselineSchedule(
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
        const placements = allPlacements(schedule.slices);
        const cap = liftCap(params);
        for (const placement of placements) {
          const others = advanceLifts(
            lifts,
            liftsOf(placements.filter((other) => other !== placement)),
          );
          expect(placement.slotIds.length).toBeLessThanOrEqual(cap);
          expect(
            loadWith(others, placement.serveAt, placement.slotIds.length, params),
          ).toBeLessThanOrEqual(cap);
        }
        for (const order of planTargets(pending, NOW)) {
          if (order.slotSpan <= cap) continue;
          expect(placements.some((placement) => refersTo(placement, order))).toBe(false);
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: lift-group-planning, Property 17 — 自前解は始めたまとまりを崩さない（ハード制約 (e)）
  // **Validates: Requirements 1.9, 1.11, 5.3, 9.9, 9.10**
  //
  // 計画順に解放表と上げ表を進めながら、一片ごとに keepsAnchor（Acceptance_Gate・合成と同じ述語）が真であること
  // ——`anchor` の主張が現在の仲間に在り（AC 9.10 (a)・仲間が無い卓では null）、合流分の pack が手前に散らさず・
  // 集合として合流でき・延期の理由が窓だけで（(b)〜(d)）、合流できた品目を押し出さない。自前解がゲートの (e) を
  // 構成から満たすことの検査で、joinTarget が錨を仲間から選ぶこと・joinable の増分の対応づけと述語の整合・
  // placeWithLifts が pack 全体の span で firstFit することを固定する（design Component 10）。
  // 併せて (f)——一片を手前の表に載せたとき、各配置を含む窓が上限以下（withinLiftCap・ゲートと合成が同じ位置で読む）
  // ——も真であること（AC 9.5・9.14。firstFit の最小性から従う）。
  it("Property 17: 自前解の一片は keepsAnchor と withinLiftCap を守る（錨は仲間に在り・pack は窓の分だけ延期し・押し出さず・上限内）", () => {
    fc.assert(
      fc.property(genScene, ({ pending, release, members, lifts, running, params }) => {
        const schedule = baselineSchedule(
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
        const targets = planTargets(pending, NOW);
        let free = release;
        let ends = lifts;
        for (const slice of schedule.slices) {
          const siblings = members.get(slice.tableKey) ?? null;
          expect(
            keepsAnchor(
              slice.placements,
              free,
              ends,
              siblings,
              targets,
              DEFAULT_NOODLE_PRESETS,
              params,
            ),
          ).toBe(true);
          expect(withinLiftCap(ends, liftsOf(slice.placements), params)).toBe(true);
          free = advanceRelease(free, slice.placements);
          ends = advanceLifts(ends, liftsOf(slice.placements));
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: lift-group-planning, Property 3 / 14 — slotSpan と batch
  // **Validates: Requirements 4.1, 4.4, 4.5, 7.3**
  it("Property 3 / 14: 各配置は slotSpan 個の相異なる釜を持ち、同時刻の占有は釜数を超えない", () => {
    fc.assert(
      fc.property(genScene, ({ pending, release, members, lifts, running, slotCount, params }) => {
        const schedule = baselineSchedule(
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

  // Feature: plan-stability, Property 5.6 — 自前解の保持
  // **Validates: Requirements 3.1, 3.2, 5.6**
  //
  // 同じ入力で続けて計画する——二度目は一度目の計画を Shown_Plan（`shownPlanOf`）として渡す——と、釜・まとまり・順・
  // 時刻のすべてが保たれ、Change_Cost は 0。前回の釜は空いているのでそのまま採れ、前回のまとまりを保つ候補は
  // 一度目と同じ配置を作り、局所比較は変更費用 0 の側を採る（design Component 5）。比較の時点は計画の now（NOW）、
  // Timer 集合は同じ集合。計画の同一性は配置の値の一致で見る（`toEqual`）。
  // Feature: plan-stability, Property 5.6 — 自前解の保持
  // **Validates: Requirements 3.1, 3.2, 5.6**
  //
  // 前回の無い計画を Shown_Plan にして同じ入力で計画し直すと、**同じ計画（Change_Cost 0）か、総費用（業務費用 ＋
  // 変更費用）が真に下がる計画**になる。後者が在るのは、前回を残す候補（前回の配置の再現・まとまり・先頭）が前回の無い
  // 計画には無かった配置を見つけるためで（実測：arms 1・L 9・w_table 0 で、錨に揃えていた 2 品を別の窓に分けて業務費用
  // 23 秒改善・変更費用 6 秒）、これは性質 5.7 の「利益が上回れば変わる」そのもの。変わるのは総費用が真に下がるとき
  // だけで、前回そのものは変更費用 0 ゆえ、業務入力（now を含む）を固定すれば業務費用そのものが厳密に下がる。続けて
  // 計画し直すと有限回で同じ計画に落ち着く——3 回目は 2 回目と同じか、更に下がる（業務費用でも見る）。
  //
  // **1 段目（占有なし）で見る（startable-placement task 3）。** この性質は plan-stability の機構（前回の釜の第一候補・並びの
  // 同値・まとまりと先頭の候補・忠実な計画）が自前解を自分自身の不動点にすることを言う。2 段目（1 段目の「今」の品目を
  // Timer の無い釜へ配って組み直す）の計画は、一片の順に表を進めて組み直す 1 段目がそのまま再現できる形とは限らない
  // ——1 段目の startAt を下限に残した時刻（AC 1.8）は自然な firstFit の時刻より後ろで、次回はその分だけ早い時刻を見つけ
  // （実測：209.821 秒が 209 秒に・0.8 秒の業務改善に遠さで割った変更費用 4 秒）、後の群の固定配置に取り置いた釜は
  // 一片の順では手前の群が先に取る（実測：卓 t-2 が釜 0 を 45 秒から使い、後の単独品が「今」を失って総費用 116 秒悪化）。
  // 占有なしなら配分は 1 段目の釜をそのまま採り 2 段目は組まれないので、主張は従来どおり厳密に成り立つ。占有ありの
  // 再計画の単調性は startable-placement の未決として報告する（下限を「今にならない範囲」へ緩める案・前回の「今」の釜を
  // 1 段目でも手前の群に対して取り置く案）。
  it("Property 5.6: 同じ入力で続けて計画すると、同じ計画（Change_Cost 0）か総費用が真に下がる計画になる", () => {
    fc.assert(
      fc.property(genScene, ({ pending, release, members, lifts, running, params }) => {
        const plan = (changeContext: ChangeContext | null) =>
          baselineSchedule(
            pending,
            release,
            members,
            lifts,
            DEFAULT_NOODLE_PRESETS,
            params,
            NOW,
            new Set(),
            changeContext,
          );
        const contextOf = (previous: CookSchedule): ChangeContext => ({
          shown: shownPlanOf(previous, recommend(previous)),
          running,
          now: NOW,
          pending,
          presets: DEFAULT_NOODLE_PRESETS,
        });
        const totalOf = (schedule: CookSchedule, changeContext: ChangeContext) =>
          scoreSchedule(schedule.slices, pending, { members, lifts, change: changeContext }, params)
            .total;
        const first = plan(null);
        const firstContext = contextOf(first);
        const second = plan(firstContext);
        const secondContext = contextOf(second);
        const third = plan(secondContext);

        const sameAsFirst =
          changeCost(
            { schedule: second, recommendations: recommend(second) },
            firstContext,
            params,
          ) === 0;
        const businessOf = (schedule: CookSchedule) =>
          scoreSchedule(schedule.slices, pending, { members, lifts, change: null }, params).total;
        if (sameAsFirst) expect(second).toEqual(first);
        else {
          expect(totalOf(second, firstContext)).toBeLessThan(totalOf(first, firstContext));
          expect(businessOf(second)).toBeLessThan(businessOf(first));
        }

        const sameAsSecond =
          changeCost(
            { schedule: third, recommendations: recommend(third) },
            secondContext,
            params,
          ) === 0;
        if (sameAsSecond) expect(third).toEqual(second);
        else {
          expect(totalOf(third, secondContext)).toBeLessThan(totalOf(second, secondContext));
          expect(businessOf(third)).toBeLessThan(businessOf(second));
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: plan-stability, Property 5.7 — 利益が上回れば変わる（候補の範囲・ハード制約が先）
  // **Validates: Requirements 3.1, 3.3, 5.7**
  //
  // 前回の釜の第一候補は「候補の時刻までに空く実在の釜」にだけ効く。2 つの場面で見る。
  //   (i) 前回の釜が表の外（存在しない釜）——第一候補は一つも採れず、釜の選択は既存の規則へ落ちる。並びの同値と
  //       まとまりの候補は前回の計画（前回の無い計画そのもの）を保つので、**時刻・提供時刻・錨は前回の無い計画に
  //       一致する**。釜の対応づけまでは主張しない——茹で時間が同値の品目の並びを前回の startAt で断つ（AC 3.2）ため、
  //       既存の規則が釜を配る順が正準順序と変わり、同じ時刻のまま釜の番号だけが入れ替わる（実測：同じ卓の 4 品・
  //       arms 1 で、前回 +30 秒に置いた品目が正準順序で後ろの品目より先に釜を取る）。
  //   (ii) 前回の釜を遠い未来まで塞ぐ——ハード制約（重複なし・同時本数・解放時刻）を守る。塞がれた釜が空く時刻まで
  //       列が待たされる場面では前回の釜が候補に間に合う（採ってよい）ので、一致は主張しない。
  //
  // (i) は **1 段目（占有なし）で見る**（startable-placement task 3）。前回の釜の第一候補は 1 段目の `assignSlots` の規則で、
  // (i) はその規則が効かないときの一致を言う。2 段目（1 段目の「今」の品目を Timer の無い釜へ配って組み直す）は 1 段目の
  // startAt を下限に残す（AC 1.8）ので、釜の組が変わって解放が早まった品目の時刻が自然な firstFit の時刻より後ろに残り、
  // 前回の時刻を手がかりに組み直す計画（前回の配置を再現する分割は塊を前回の提供時刻で切るが、時刻は今の表の firstFit で
  // 決める）がそれより早い時刻を見つける（実測：卓 t-1 の 2 釜の Thin が固定配置の釜を避けて 75 秒から 80 秒の窓へ動き、
  // 卓 t-2 の 2 品は下限で 80 秒に残るが、前回を持つ計画は空いた 75 秒の窓に置く）。占有なしなら配分は 1 段目の釜をそのまま
  // 採り 2 段目は組まれないので、(i) の主張は従来どおり厳密に成り立つ。(ii) は占有ありのまま（ハード制約は 2 段目にも及ぶ）。
  it("Property 5.7: 前回の釜が存在しなければ時刻は前回の無い計画に一致し、塞がれていればハード制約を守る", () => {
    fc.assert(
      fc.property(genScene, ({ pending, release, members, lifts, running, slotCount, params }) => {
        const previous = baselineSchedule(
          pending,
          release,
          members,
          lifts,
          DEFAULT_NOODLE_PRESETS,
          params,
          NOW,
          new Set(),
          null,
        );
        const shown = shownPlanOf(previous, recommend(previous));

        // (i) 前回の釜を表の外の番号へ写す（釜の数だけずらす）。
        const elsewhere = shown.map((item) => ({
          ...item,
          slotIds: nonEmpty(
            item.slotIds.map((slotId) => String(Number(slotId) + slotCount) as SlotId),
          ),
        }));
        const withElsewhere = baselineSchedule(
          pending,
          release,
          members,
          lifts,
          DEFAULT_NOODLE_PRESETS,
          params,
          NOW,
          new Set(),
          { shown: elsewhere, running, now: NOW, pending, presets: DEFAULT_NOODLE_PRESETS },
        );
        expect(timingsOf(withElsewhere.slices)).toEqual(timingsOf(previous.slices));
        expect(hasOverlapOnSameSlot(allPlacements(withElsewhere.slices))).toBe(false);

        // (ii) 前回の釜を遠い未来まで塞ぐ（卓を持たないので錨にも成員にもならない）。
        const blockers = [...new Set(shown.flatMap((item) => item.slotIds))].map((slotId, index) =>
          createTimer({
            id: `blocker-${index}` as TimerId,
            slotIds: nonEmpty([slotId as SlotId]),
            noodleType: "Thin" as NoodleType,
            firmness: "normal",
            startTime: NOW,
            endTime: (NOW + 86_400_000) as EpochMillis,
            seq: 1_000 + index,
          }),
        );
        const later = [...running, ...blockers];
        const blockedRelease = initialRelease(later, NOW, slotCount);
        const withBlocked = baselineSchedule(
          pending,
          blockedRelease,
          tableMembers(later),
          initialLifts(later),
          DEFAULT_NOODLE_PRESETS,
          params,
          NOW,
          occupiedSlotsOf(later),
          { shown, running: later, now: NOW, pending, presets: DEFAULT_NOODLE_PRESETS },
        );
        const placements = allPlacements(withBlocked.slices);
        expect(hasOverlapOnSameSlot(placements)).toBe(false);
        expect(exceedsSlotCount(placements, slotCount)).toBe(false);
        expect(startsBeforeRelease(placements, blockedRelease)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});

describe("Feature: pending-order-expiry — 計画対象は生きている待ち行列から（性質 5.4）", () => {
  // Feature: pending-order-expiry, Property 5.4: 枠——期限切れの品目が到着順の先頭にどれだけ在っても、計画対象は
  // 生きている品目の正準順序の先頭 PLAN_TARGET_LIMIT 件（死んだ注文が枠を食わない）
  it("Property 5.4: 期限切れが先頭に 64 件以上在っても、計画対象は生きている品目の正準順序の先頭 64 件", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: PLAN_TARGET_LIMIT, max: PLAN_TARGET_LIMIT + 16 }),
        fc.array(genOrderSpec(KNOWN_NOODLE_TYPES), { maxLength: 30 }),
        // 期限切れの到着は寿命ちょうどから 3 時間前まで（ちょうどは切れる側）。
        fc.integer({ min: 0, max: 60 * 60 * 1000 }),
        (expiredCount, orders, age) => {
          const alive = toPending(orders);
          const dead: readonly PendingOrder[] = Array.from({ length: expiredCount }, (_u, i) => ({
            externalOrderId: `dead-${i}`,
            itemIndex: 0,
            noodleType: KNOWN_NOODLE_TYPES[0]!,
            firmness: "normal",
            tableId: null,
            arrivalTime: NOW - ORDER_LIFETIME_MS - age,
            slotSpan: 1,
            itemName: null,
            sizeName: null,
          }));

          const targets = planTargets([...dead, ...alive], NOW);

          expect(targets.map((order) => keyOf(order.externalOrderId, order.itemIndex))).toEqual(
            planTargetKeys(alive),
          );
          expect(targets.some((order) => order.externalOrderId.startsWith("dead-"))).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});
