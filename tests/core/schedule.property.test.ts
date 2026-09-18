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
  scheduleCandidates,
  type CookSchedule,
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
import { ORDER_LIFETIME_MS, type OrderItem } from "../../src/domain/order";
import { slotSpanOf } from "../../src/domain/store";
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
  readonly pending: readonly OrderItem[];
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
function planTargetKeys(pending: readonly OrderItem[]): readonly string[] {
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
              portions: fc.constant(1),
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
  //
  // **固定した「今」の品目を除いて主張する（startable-placement 判断 15・性質 4.9・2026-09-07）。** 「今」の配分の loop は、
  // 配分で釜が動いて不正になった一片を、配分した「今」の配置を残したまま残りを再生成する。残りの batch の錨は残りの
  // earliest（と走行中の錨）から取り直すので、固定した「今」の品目と同じ時刻には揃わない（design の反例：同卓の Long を
  // 「今」に固定し、Short を再生成すると Short は「今」になる）。それは意図した帰結（再生成で「今」になった品目・AC 1.8 改訂）
  // で、固定した品目を除いた集合には従来どおり錨の一致が成り立つ。完成した計画の `startAt ≤ now` の配置はすべて最後の反復で
  // 固定されたもの（fresh が空で止まる）ゆえ、除く集合は「一片の `startAt ≤ now` の配置」——一片ごとではなく配置ごとに除く
  // （「今」を含む一片を丸ごと外す形は必要より広い）。群の錨はその残りの最遅の earliest。各配置が自分の earliest 以上であること
  // と、合流の所属の規則は「今」の品目にも成り立つ。
  // 前提は一片が一つの batch に収まること：再生成の幅は後の一片の固定した「今」の釜を取り置いた残り（釜数 − 後の一片の
  // 「今」の Σ span）なので、一片の Σ span がそれを超えるものは見ない（容量を超える一片は batch に割れる・Property 14）。
  it("Property 1 / 16: 容量に収まる一片は、群の錨から後ろへしか動かず、合流分は仲間の錨を所属に持つ（固定した「今」を除く）", () => {
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
            slotSpanOf(order.portions),
          ]),
        );
        for (const [index, slice] of schedule.slices.entries()) {
          const totalSpan = slice.placements.reduce(
            (sum, placement) =>
              sum + (spanOf.get(`${placement.externalOrderId}\u0000${placement.itemIndex}`) ?? 1),
            0,
          );
          // 後の一片の固定した「今」の釜は再生成に対して取り置かれる（幅から外れる）。
          const reserved = schedule.slices
            .slice(index + 1)
            .flatMap((later) => later.placements)
            .filter((placement) => placement.startAt <= NOW)
            .reduce((sum, placement) => sum + placement.slotIds.length, 0);
          if (totalSpan > slotCount - reserved) continue;
          // 各配置は自分の釜の解放時刻 + 茹で時間 以上（下限のクランプ無しで構成から従う）。
          const earliestOf = (placement: Placement) =>
            Math.max(...placement.slotIds.map((slotId) => release[Number(slotId)]!)) +
            (placement.serveAt - placement.startAt);
          for (const placement of slice.placements) {
            expect(placement.serveAt).toBeGreaterThanOrEqual(earliestOf(placement));
          }
          const siblings = members.get(slice.tableKey);
          // 固定した「今」（`startAt ≤ now`）を除いた集合。
          const rest = slice.placements.filter((placement) => placement.startAt > NOW);
          if (siblings === undefined) {
            // 走行中の仲間が居なければ合流の所属は無く（AC 9.9）、固定した「今」を除いた全員が群の錨（その集合の最遅の
            // earliest）以上に上がる。
            const anchor = Math.max(...rest.map(earliestOf));
            for (const placement of slice.placements) {
              expect(placement.anchor).toBeNull();
            }
            for (const placement of rest) {
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
          if (slotSpanOf(order.portions) <= cap) continue;
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
            slotSpanOf(order.portions),
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

  // Feature: plan-stability, Property 5.6 — 自前解の保持（2026-09-07 改訂・実占有）
  // **Validates: Requirements 3.1, 3.2, 5.6, 6.1, 6.2**
  //
  // 前回の無い計画を Shown_Plan にして同じ入力で計画し直すと、**同じ計画（配置の値と一片の並びが一致）で Change_Cost 0**
  // か、総費用（業務費用 ＋ 変更費用）が真に下がる計画になる。配置の一致と変更費用 0 は別々に検査する（変更費用 0 は
  // 窓の内側の移動や遠い将来の移動を数えないので、一致から 0 は従うが 0 から一致は従わない）。後者が在るのは、前回を残す
  // 候補（前回の配置の再現・まとまり・先頭）が前回の無い計画には無かった配置を見つけるためで（実測：arms 1・L 9・
  // w_table 0 で、錨に揃えていた 2 品を別の窓に分けて業務費用 23 秒改善・変更費用 6 秒）、これは性質 5.7 の「利益が
  // 上回れば変わる」そのもの。変わるのは総費用が真に下がるときだけで、前回そのものは保持候補 R（`retain`・変更費用 0）
  // として常に候補に在るので、業務入力（now を含む）を固定すれば業務費用そのものが厳密に下がる。続けて計画し直すと
  // 有限回で同じ計画に落ち着く——3 回目は 2 回目と同じか、更に下がる（業務費用でも見る）。
  //
  // **実占有（`occupiedSlotsOf(running)`）で見る（startable-placement task 3′.5）。** task 3 は 2 段目の下限と取り置きが
  // 前回に忠実な候補の再生成で再現できず占有なしに退避していたが、R は前回を再計算せず復元するので、「今」の配分の loop を
  // 通った計画もそのまま候補になる。
  it("Property 5.6: 同じ入力で続けて計画すると、同じ計画（Change_Cost 0）か総費用が真に下がる計画になる（実占有）", () => {
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
            occupiedSlotsOf(running),
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

        const changeOf = (schedule: CookSchedule, changeContext: ChangeContext) =>
          changeCost({ schedule, recommendations: recommend(schedule) }, changeContext, params);
        const businessOf = (schedule: CookSchedule) =>
          scoreSchedule(schedule.slices, pending, { members, lifts, change: null }, params).total;
        const same = (a: CookSchedule, b: CookSchedule) => JSON.stringify(a) === JSON.stringify(b);
        // 配置が一致すれば変更費用は 0（別に検査）。一致しなければ総費用も業務費用も真に下がる。
        if (same(second, first)) expect(changeOf(second, firstContext)).toBe(0);
        else {
          expect(totalOf(second, firstContext)).toBeLessThan(totalOf(first, firstContext));
          expect(businessOf(second)).toBeLessThan(businessOf(first));
        }
        if (same(third, second)) expect(changeOf(third, secondContext)).toBe(0);
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
  // **(i) の「時刻は前回の無い計画に一致する」は、前回に忠実な候補（`Continuity.faithful`・総費用で 2 本を比べる）が
  // 担っていた主張で、その撤去（plan-stability 判断 12）で構造の保証を失った（startable-placement task 3′.5・実測）。** 前回の
  // 釜が表の外なら保持候補 R は何も復元できず（一片ごとに解放表で落ちてその位置で再生成され）生成候補 F と同じ計画に
  // なるので、列ごとの局所比較で勝つ候補が全体で劣る場面（design Component 5 が faithful を足した理由そのもの）を戻す候補が
  // 無い。実測（24 釜・arms 1・L 24・走行中 2 本が釜 0 で 66 / 102 秒に上がる表・卓 t-1 の Medium 大盛と Thin 2 品）：前回の無い
  // 計画は Thin 1 本を 75 秒・残りを 126.001 秒に置き、前回の釜が表の外の文脈では Medium と Thin を 90 / 114 秒に置く候補が
  // 列で勝つ——業務費用は 24 秒良く、変更費用（時刻の移動・順）が 48 秒悪く、総費用で 24 秒劣る（300 場面に 1 回程度）。前回の
  // 釜が実在すれば R が前回そのものを候補にするので総費用は前回以下（性質 5.6）。ゆえに (i) は**前回の釜の第一候補が実在する
  // 釜にだけ効く**ことそのものを主張する形に改める。
  //   (i-a) 生成器（占有なし）：前回の釜を表の外へ写した文脈は、**どの表の外の番号へ写しても同じ計画**を出す（第一候補は
  //         実在しない釜を一切読まない・決定性）。その計画は表の外の釜を使わず、対応する全品目について釜の変更費用 L を払う
  //         （AC 3.1・3.3「採れなければ既存の規則へ落ち L を払う」）。ハード制約（重複なし）を守る。
  //   (i-b) loop（実占有）：前回の釜が表の外なら保持候補 R は生成候補 F と同じ計画に落ちる（前回の釜が無ければ何も残せない・
  //         復元側の「実在する釜にだけ効く」）。
  // (ii) は実占有のまま（ハード制約は完成形に及ぶ）。
  it("Property 5.7: 前回の釜が存在しなければ第一候補は効かず（どの表の外の番号でも同じ計画・釜の変更費用 L を払う・復元は生成候補に落ちる）、塞がれていればハード制約を守る", () => {
    fc.assert(
      fc.property(genScene, ({ pending, release, members, lifts, running, slotCount, params }) => {
        const plan = (occupied: ReadonlySet<number>, changeContext: ChangeContext | null) =>
          baselineSchedule(
            pending,
            release,
            members,
            lifts,
            DEFAULT_NOODLE_PRESETS,
            params,
            NOW,
            occupied,
            changeContext,
          );
        // 前回の釜を表の外の番号へ写す（釜の数の shift 倍だけずらす）。
        const elsewhereOf = (previous: CookSchedule, shift: number): ChangeContext => ({
          shown: shownPlanOf(previous, recommend(previous)).map((item) => ({
            ...item,
            slotIds: nonEmpty(
              item.slotIds.map((slotId) => String(Number(slotId) + shift * slotCount) as SlotId),
            ),
          })),
          running,
          now: NOW,
          pending,
          presets: DEFAULT_NOODLE_PRESETS,
        });

        // (i-a) 生成器（占有なし）：表の外の番号は読まれない——どの番号へ写しても同じ計画で、表の外の釜を使わず、対応する
        // 全品目について釜の変更費用 L を払う。
        const stage1 = plan(new Set(), null);
        const context1 = elsewhereOf(stage1, 1);
        const withElsewhere = plan(new Set(), context1);
        expect(plan(new Set(), elsewhereOf(stage1, 2))).toEqual(withElsewhere);
        const placed = allPlacements(withElsewhere.slices);
        expect(placed.every((p) => p.slotIds.every((slotId) => Number(slotId) < slotCount))).toBe(
          true,
        );
        expect(
          changeCost(
            { schedule: withElsewhere, recommendations: recommend(withElsewhere) },
            context1,
            params,
          ),
        ).toBeGreaterThanOrEqual(params.liftIntervalSeconds * placed.length);
        expect(hasOverlapOnSameSlot(placed)).toBe(false);

        // (i-b) loop：実占有の前回に対して、前回の釜が表の外なら保持候補 R は生成候補 F と同じ計画に落ち、選ばれた計画は
        // ハード制約を守る。
        const previous = plan(occupiedSlotsOf(running), null);
        const { fresh, retained } = scheduleCandidates(
          pending,
          release,
          members,
          lifts,
          DEFAULT_NOODLE_PRESETS,
          params,
          NOW,
          occupiedSlotsOf(running),
          elsewhereOf(previous, 1),
        );
        if (retained !== null) expect(retained).toEqual(fresh);
        expect(hasOverlapOnSameSlot(allPlacements(fresh.slices))).toBe(false);
        const shown = shownPlanOf(previous, recommend(previous));

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
          const dead: readonly OrderItem[] = Array.from({ length: expiredCount }, (_u, i) => ({
            externalOrderId: `dead-${i}`,
            itemIndex: 0,
            noodleType: KNOWN_NOODLE_TYPES[0]!,
            firmness: "normal",
            tableId: null,
            arrivalTime: NOW - ORDER_LIFETIME_MS - age,
            portions: 1,
            itemName: null,
            sizeName: null,
            completedAt: null,
            interruptedAt: null,
            tableAssignedAt: null,
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
