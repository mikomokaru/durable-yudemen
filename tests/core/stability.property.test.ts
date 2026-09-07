// Feature: plan-stability, Component 2 — changeCost
// **Validates: Requirements 5.1, 5.3, 5.4, 5.5, 5.9**
//
// tests/core/stability.property.test.ts — 変更費用（src/engine/stability.ts の changeCost）の性質。
//
// 比較の相手（Shown_Plan）は現実の自前解から作る（scheduleScenes の baselinePlan → shownPlanOf）。手で組んだ
// Shown_Plan だけでは、群の連鎖・複数釜・走行中の錨といった自前解の形を踏まず、性質が場面の狭さに守られて通る。
// 手で組むのは、旧 startAt と now の距離だけが効く減衰（5.4）と時間経過の保護（5.9）の 1 品目の場面に限る。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  changeCost,
  shownPlanOf,
  type ChangeContext,
  type ShownItem,
  type ShownPlan,
} from "../../src/engine/stability";
import { recommend } from "../../src/engine/recommend";
import { headsOf, liftGroupsOf, visibleGroupsOf, type LiftItem } from "../../src/domain/lift-group";
import { boilMillisOf, type CookSchedule, type Placement } from "../../src/engine/schedule";
import type { ScheduleParams } from "../../src/engine/objective";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { itemKeyOf, type ItemKey, type OrderItem } from "../../src/domain/order";
import { DEFAULT_NOODLE_PRESETS, SLOTS_PER_UNIT, slotOf } from "../../src/domain/store";
import {
  baselinePlan,
  genOrderSpec,
  genParams,
  genRunning,
  KNOWN_NOODLE_TYPES,
  NOW,
  shortestFirstPlan,
  timerOn,
  toPending,
} from "./scheduleScenes";
import { nonEmpty } from "../nonEmpty";

const SECOND = 1000;
const PRESETS = DEFAULT_NOODLE_PRESETS;

/** 前回の計画（自前解から作った Shown_Plan）と、それを生んだ場面。 */
interface ShownScene {
  readonly pending: readonly OrderItem[];
  readonly running: readonly Timer[];
  readonly params: ScheduleParams;
  readonly slotCount: number;
  readonly schedule: CookSchedule;
  readonly shown: ShownPlan;
}

/** 1〜2 ユニット・1〜6 注文・走行中 0〜4 本。自前解を前回の計画とする。 */
function genShownScene(): fc.Arbitrary<ShownScene> {
  return fc.integer({ min: 1, max: 2 }).chain((unitCount) => {
    const slotCount = unitCount * SLOTS_PER_UNIT;
    return fc
      .record({
        orders: fc.array(genOrderSpec(KNOWN_NOODLE_TYPES), { minLength: 1, maxLength: 6 }),
        running: fc.array(genRunning(slotCount), { maxLength: 4 }),
        params: genParams(unitCount),
      })
      .map(({ orders, running, params }) => {
        const pending = toPending(orders);
        const timers = running.map((seed, index) => timerOn(seed, index));
        const schedule = baselinePlan(pending, timers, slotCount, params);
        return {
          pending,
          running: timers,
          params,
          slotCount,
          schedule,
          shown: shownPlanOf(schedule, recommend(schedule)),
        };
      });
  });
}

/** 比較の時点。前回の計画の前後（時間経過で Head に入る品目・錨の失効で隠れる群の双方を踏む）。 */
const genNow = fc
  .integer({ min: -600 * SECOND, max: 3600 * SECOND })
  .map((offset) => (NOW + offset) as EpochMillis);

/** 遷移後の Timer 集合（前回の計画を生んだ集合とは独立に振る）。seq は前回の集合と重ならない。 */
function genLaterRunning(slotCount: number): fc.Arbitrary<readonly Timer[]> {
  return fc
    .array(genRunning(slotCount), { maxLength: 4 })
    .map((seeds) => seeds.map((seed, index) => timerOn(seed, 100 + index)));
}

function nextOf(schedule: CookSchedule) {
  return { schedule, recommendations: recommend(schedule) };
}

function contextOf(
  scene: ShownScene,
  now: EpochMillis,
  running: readonly Timer[] = scene.running,
  shown: ShownPlan = scene.shown,
): ChangeContext {
  return { shown, running, now, pending: scene.pending, presets: PRESETS };
}

/** Glossary の Head——推奨と品目・茹で秒を組み、表示と同じ導出（domain/lift-group.ts）で先頭 arms 本を引く。 */
function headOf(
  schedule: CookSchedule,
  pending: readonly OrderItem[],
  running: readonly Timer[],
  now: EpochMillis,
  params: ScheduleParams,
): readonly ItemKey[] {
  const byKey = new Map(pending.map((order) => [itemKeyOf(order), order]));
  const items: LiftItem[] = [];
  for (const recommendation of recommend(schedule)) {
    const order = byKey.get(itemKeyOf(recommendation));
    if (order === undefined) continue;
    const boilMillis = boilMillisOf(order, PRESETS);
    if (boilMillis === null) continue;
    items.push({ recommendation, order, boilSeconds: boilMillis / SECOND });
  }
  const occupied = new Set(running.flatMap((timer) => timer.slotIds.map(slotOf)));
  return headsOf(visibleGroupsOf(liftGroupsOf(items, now)), occupied, now, params.arms);
}

/** 計画の 1 配置を差し替える（他はそのまま）。 */
function replacing(
  schedule: CookSchedule,
  key: ItemKey,
  patch: (placement: Placement) => Placement,
): CookSchedule {
  return {
    slices: schedule.slices.map((slice) => ({
      ...slice,
      placements: slice.placements.map((placement) =>
        itemKeyOf(placement) === key ? patch(placement) : placement,
      ),
    })),
  };
}

describe("engine/stability — changeCost の性質", () => {
  // Feature: plan-stability, Property: 5.1 — 不変
  // **Validates: Requirements 2.2(a), 5.1**
  it("Shown_Plan と同じ計画は、比較の時点の now と Timer 集合に依らず Change_Cost 0", () => {
    fc.assert(
      fc.property(
        genShownScene().chain((scene) =>
          fc.record({
            scene: fc.constant(scene),
            now: genNow,
            later: genLaterRunning(scene.slotCount),
          }),
        ),
        ({ scene, now, later }) => {
          expect(
            changeCost(nextOf(scene.schedule), contextOf(scene, now, later), scene.params),
          ).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: plan-stability, Property: 5.3 — 先頭の保護
  // **Validates: Requirements 2.2(a), 5.3**
  it("旧 Head の品目を Head から外す計画は、外さない計画より Change_Cost が 2L 大きい", () => {
    fc.assert(
      fc.property(
        genShownScene().chain((scene) =>
          fc.record({ scene: fc.constant(scene), now: genNow, pick: fc.nat() }),
        ),
        ({ scene, now, pick }) => {
          const head = headOf(scene.schedule, scene.pending, scene.running, now, scene.params);
          fc.pre(head.length > 0);
          const occupied = [
            ...new Set(scene.running.flatMap((timer) => timer.slotIds.map(slotOf))),
          ];
          fc.pre(occupied.length > 0);
          const key = head[pick % head.length]!;
          const target = scene.schedule.slices
            .flatMap((slice) => slice.placements)
            .find((placement) => itemKeyOf(placement) === key)!;
          const own = new Set(target.slotIds.map(slotOf));
          const idle = Array.from({ length: scene.slotCount }, (_, slot) => slot).filter(
            (slot) => !own.has(slot) && !occupied.includes(slot),
          );
          fc.pre(idle.length > 0);

          // 同じ品目を、占有された釜へ動かす（表示できず Head から外れる）／空いた釜へ動かす（Head のまま）。
          // 釜の変更 L は双方に付き、差は先頭の変更 2L だけになる。
          const moveTo = (slot: number) =>
            replacing(scene.schedule, key, (placement) => ({
              ...placement,
              slotIds: nonEmpty([String(slot) as SlotId, ...placement.slotIds.slice(1)]),
            }));
          const out = changeCost(nextOf(moveTo(occupied[0]!)), contextOf(scene, now), scene.params);
          const kept = changeCost(nextOf(moveTo(idle[0]!)), contextOf(scene, now), scene.params);
          expect(out - kept).toBe(2 * scene.params.liftIntervalSeconds);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: plan-stability, Property: 5.4 — 減衰
  // **Validates: Requirements 2.2(d), 5.4**
  it("同じ幅の時刻の移動は、旧 startAt が今から遠い品目ほど Change_Cost が大きくならない（単調非増加）", () => {
    const ITEM: OrderItem = {
      externalOrderId: "o-far",
      itemIndex: 0,
      noodleType: KNOWN_NOODLE_TYPES[0]!,
      firmness: "normal",
      tableId: null,
      arrivalTime: NOW,
      slotSpan: 1,
      itemName: null,
      sizeName: null,
      completedAt: null,
      interruptedAt: null,
    };
    const shownAt = (startAt: number): ShownPlan => [
      {
        externalOrderId: ITEM.externalOrderId,
        itemIndex: 0,
        slotIds: nonEmpty(["0" as SlotId]),
        startAt: startAt as EpochMillis,
        serveAt: (startAt + boilMillisOf(ITEM, PRESETS)!) as EpochMillis,
        anchor: null,
        mates: [],
      },
    ];
    const planAt = (startAt: number): CookSchedule => ({
      slices: [
        {
          tableKey: "solo",
          placements: [
            {
              externalOrderId: ITEM.externalOrderId,
              itemIndex: 0,
              slotIds: nonEmpty(["0" as SlotId]),
              startAt: startAt as EpochMillis,
              serveAt: (startAt + boilMillisOf(ITEM, PRESETS)!) as EpochMillis,
              anchor: null,
            },
          ],
        },
      ],
    });
    const costOf = (far: number, delta: number, params: ScheduleParams) =>
      changeCost(
        nextOf(planAt(NOW + far + delta)),
        { shown: shownAt(NOW + far), running: [], now: NOW, pending: [ITEM], presets: PRESETS },
        params,
      );
    fc.assert(
      fc.property(
        genParams(1),
        fc.integer({ min: 0, max: 3600 * SECOND }),
        fc.integer({ min: 0, max: 3600 * SECOND }),
        fc.integer({ min: -900 * SECOND, max: 900 * SECOND }),
        (params, farA, farB, delta) => {
          const [near, far] = farA <= farB ? [farA, farB] : [farB, farA];
          expect(costOf(far, delta, params)).toBeLessThanOrEqual(costOf(near, delta, params));
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: plan-stability, Property: 5.5 — 対応の規律
  // **Validates: Requirements 2.3, 5.5**
  it("開始済み・キャンセル済み（pending に無い）品目と新規の品目は Change_Cost を動かさない", () => {
    fc.assert(
      fc.property(
        genShownScene().chain((scene) =>
          fc.record({
            scene: fc.constant(scene),
            now: genNow,
            ghostCount: fc.integer({ min: 1, max: 3 }),
            ghostGroupPick: fc.nat(),
            ghostSlot: fc.integer({ min: 0, max: scene.slotCount - 1 }),
            ghostStart: fc.integer({ min: -600 * SECOND, max: 3600 * SECOND }),
            newcomerCount: fc.integer({ min: 1, max: 3 }),
          }),
        ),
        ({ scene, now, ghostCount, ghostGroupPick, ghostSlot, ghostStart, newcomerCount }) => {
          // 前回と違う現実的な計画（茹で時間の短い順）を相手に取る。同じ計画では 0 が続いて何も見えない。
          const next = shortestFirstPlan(
            scene.pending,
            scene.running,
            scene.slotCount,
            scene.params,
          );
          const base = changeCost(nextOf(next), contextOf(scene, now), scene.params);

          // (1) 開始済み・キャンセル済み：Shown_Plan に在って pending に無い品目。釜も時刻も任意で、いずれかの群の
          //     まとまりに居たと申告していても（mates に実在の鍵）、費用は動かない。
          const mates =
            scene.shown.length === 0
              ? []
              : (() => {
                  const host = scene.shown[ghostGroupPick % scene.shown.length]!;
                  return [itemKeyOf(host), ...host.mates];
                })();
          const ghosts: readonly ShownItem[] = Array.from({ length: ghostCount }, (_, index) => ({
            externalOrderId: `ghost-${index}`,
            itemIndex: 0,
            slotIds: nonEmpty([String(ghostSlot) as SlotId]),
            startAt: (NOW + ghostStart) as EpochMillis,
            serveAt: (NOW + ghostStart + 60 * SECOND) as EpochMillis,
            anchor: null,
            mates,
          }));
          const withGhosts = changeCost(
            nextOf(next),
            contextOf(scene, now, scene.running, [...scene.shown, ...ghosts]),
            scene.params,
          );
          expect(withGhosts).toBe(base);

          // (2) 新規：pending と新しい計画に在って Shown_Plan に無い品目。先頭に関わらない遠い将来に置く
          //     （Head を押しのける新規の品目は、押しのけられた対応する品目の側に費用が付く——それは新規の費用ではない）。
          const newcomers: readonly OrderItem[] = Array.from(
            { length: newcomerCount },
            (_, index) => ({
              externalOrderId: `new-${index}`,
              itemIndex: 0,
              noodleType: KNOWN_NOODLE_TYPES[index % KNOWN_NOODLE_TYPES.length]!,
              firmness: "normal",
              tableId: null,
              arrivalTime: NOW,
              slotSpan: 1,
              itemName: null,
              sizeName: null,
              completedAt: null,
              interruptedAt: null,
            }),
          );
          const farFuture = (now + 24 * 3600 * SECOND) as EpochMillis;
          const extended: CookSchedule = {
            slices: [
              ...next.slices,
              ...newcomers.map((order, index) => ({
                tableKey: `new-${index}`,
                placements: [
                  {
                    externalOrderId: order.externalOrderId,
                    itemIndex: 0,
                    slotIds: nonEmpty([String(index % scene.slotCount) as SlotId]),
                    startAt: farFuture,
                    serveAt: (farFuture + boilMillisOf(order, PRESETS)!) as EpochMillis,
                    anchor: null,
                  },
                ],
              })),
            ],
          };
          const withNewcomers = changeCost(
            nextOf(extended),
            {
              ...contextOf(scene, now),
              pending: [...scene.pending, ...newcomers],
            },
            scene.params,
          );
          expect(withNewcomers).toBe(base);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: plan-stability, Property: 5.9 — 時間経過の保護
  // **Validates: Requirements 2.2(a), 5.9**
  it("「10 秒に開始」だった品目は 10 秒以降の比較で旧 Head に入り、先頭から外す計画に 2L が付く", () => {
    const ITEM: OrderItem = {
      externalOrderId: "o-ten",
      itemIndex: 0,
      noodleType: KNOWN_NOODLE_TYPES[0]!,
      firmness: "normal",
      tableId: null,
      arrivalTime: NOW,
      slotSpan: 1,
      itemName: null,
      sizeName: null,
      completedAt: null,
      interruptedAt: null,
    };
    const START = (NOW + 10 * SECOND) as EpochMillis;
    const boilMillis = boilMillisOf(ITEM, PRESETS)!;
    const shown: ShownPlan = [
      {
        externalOrderId: ITEM.externalOrderId,
        itemIndex: 0,
        slotIds: nonEmpty(["0" as SlotId]),
        startAt: START,
        serveAt: (START + boilMillis) as EpochMillis,
        anchor: null,
        mates: [],
      },
    ];
    /** 釜 1 を遠い未来まで塞ぐ走行中。 */
    const running: readonly Timer[] = [
      createTimer({
        id: "t-busy" as TimerId,
        slotIds: nonEmpty(["1" as SlotId]),
        noodleType: KNOWN_NOODLE_TYPES[0] as NoodleType,
        firmness: "normal",
        startTime: NOW,
        endTime: (NOW + 10_000 * SECOND) as EpochMillis,
        seq: 1,
      }),
    ];
    const onSlot = (slot: string): CookSchedule => ({
      slices: [
        {
          tableKey: "solo",
          placements: [
            {
              externalOrderId: ITEM.externalOrderId,
              itemIndex: 0,
              slotIds: nonEmpty([slot as SlotId]),
              startAt: START,
              serveAt: (START + boilMillis) as EpochMillis,
              anchor: null,
            },
          ],
        },
      ],
    });
    fc.assert(
      fc.property(
        genParams(1),
        fc.integer({ min: -600 * SECOND, max: 3600 * SECOND }),
        (params, offset) => {
          const now = (NOW + offset) as EpochMillis;
          const at = (schedule: CookSchedule) =>
            changeCost(
              nextOf(schedule),
              { shown, running, now, pending: [ITEM], presets: PRESETS },
              params,
            );
          // 占有釜 1 へ動かせば Head から外れる。空いた釜 2 へ動かせば Head のまま。差は 10 秒以降にだけ 2L。
          const difference = at(onSlot("1")) - at(onSlot("2"));
          expect(difference).toBe(now >= START ? 2 * params.liftIntervalSeconds : 0);
        },
      ),
      { numRuns: 300 },
    );
  });
});
