// tests/core/schedulingScenes.ts — 調理順スケジューリングを載せた状態と、そこへ流すイベントの生成器。
//
// scheduleScenes.ts が「計画の入力空間とハード制約」を持つのに対し、こちらは**decide の入力空間**を持つ。
// 状態は Timer 集合に加えて待ち行列と採用済み計画を持ち、イベントは Event の 9 種すべてを振る。
// Property 12（Effect 列の不変条件）と Property 14（Boil_Sync の不変）が同じ場面を要するため一箇所に置く
// ——素材（Timer・待ち行列・採用済み計画・パラメータ）が同じで、主張だけが違う。
//
// 場面は 2 つの世界を対で持つ。`state` はスケジューリング状態を持つ世界、`bare` は同じ Timer 集合で
// 待ち行列と採用済み計画だけを空にした世界である。Property 14 はこの対に同じイベントを流して、Timer 側の
// 確定結果がスケジューリング状態に依存しないことを見る。

import * as fc from "fast-check";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import type { Event } from "../../src/engine/event";
import type { SettleParams } from "../../src/engine/settle";
import { baselineSchedule, initialRelease, type CookSchedule } from "../../src/engine/schedule";
import type { Timer } from "../../src/engine/timer";
import type { EpochMillis, TimerId } from "../../src/engine/types";
import type { PendingOrder } from "../../src/domain/order";
import type { NonEmptyArray } from "../../src/domain/timer";
import type { Firmness } from "../../src/domain/firmness";
import {
  DEFAULT_NOODLE_PRESETS,
  SLOTS_PER_UNIT,
  UNIT_COUNT_MAX,
  UNIT_COUNT_MIN,
} from "../../src/domain/store";
import { nonEmpty } from "../nonEmpty";
import {
  KNOWN_NOODLE_TYPES,
  NOW,
  genOrderSpec,
  genParams,
  genRunning,
  timerOn,
  toPending,
  type OrderSpec,
} from "./scheduleScenes";

/** 全 Firmness（茹で加減の安定 id）。 */
const FIRMNESS: readonly Firmness[] = ["extraHard", "hard", "normal", "soft"];

/** 同じイベントを流す 2 つの世界と、そのイベント・パラメータ・時刻。 */
export interface ScheduledScene {
  /** 待ち行列と採用済み計画を持つ状態。 */
  readonly state: TimerState;
  /** 同じ Timer 集合で、待ち行列と採用済み計画だけを空にした状態。 */
  readonly bare: TimerState;
  readonly event: Event;
  readonly params: SettleParams;
  readonly now: EpochMillis;
}

/**
 * 到着 1 件を組む。externalOrderId を外から与えるのは、既存の注文への再送・変更（upsert の置換）と
 * 初回到着の双方を場面に含めるためである。
 */
function toArrival(spec: OrderSpec, externalOrderId: string): NonEmptyArray<PendingOrder> {
  return nonEmpty(
    spec.items.map((item, itemIndex) => ({
      externalOrderId,
      itemIndex,
      noodleType: item.noodleType,
      firmness: item.firmness,
      tableId: item.tableId,
      arrivalTime: spec.arrivalTime,
      // 本 spec は割り当ての算術を変えず 1 品目 1 スロットで計画する。ゆえに場面も占有幅 1 で組む。
      slotSpan: 1,
      itemName: null,
      sizeName: null,
    })),
  );
}

/**
 * 状態へ流すイベント。Event の 9 種すべてを振る。
 *
 * Timer を指すイベント（Cancel / Complete / Adjust）は既存 id と不在 id の双方を採る（拒否経路も踏む）。
 * OrderArrived の到着先は既存の注文 id と新規 id の双方。OrderCancelled も同様。
 * PlanArrived は自前解をそのまま計画として渡す——同値ゆえ Acceptance_Gate が全棄却して状態は変わらないが、
 * 受領の遷移（receivePlan）を通る経路はここで踏む。
 */
function genEventFor(
  timers: readonly Timer[],
  plan: CookSchedule,
  now: EpochMillis,
): fc.Arbitrary<Event> {
  const orderIds = fc.constantFrom("o-0", "o-1", "o-new");
  const timerId: fc.Arbitrary<string> =
    timers.length > 0
      ? fc.oneof(
          fc.constantFrom(...timers.map((timer) => timer.id as string)),
          fc.constant("absent"),
        )
      : fc.constant("absent");

  return fc.oneof(
    fc
      .record({
        boilSeconds: fc.integer({ min: 30, max: 600 }),
        newTimerId: fc.string({ minLength: 1, maxLength: 6 }),
        // 由来する注文品目。省略（アドホック麺茹で）と、待ち行列に在る品目からの開始の双方を踏む。
        orderItem: fc.oneof(
          fc.constant(null),
          fc.record({ externalOrderId: orderIds, itemIndex: fc.integer({ min: 0, max: 3 }) }),
        ),
      })
      .map(
        (start) =>
          ({
            type: "Start",
            slotIds: ["0"],
            noodleType: KNOWN_NOODLE_TYPES[0]!,
            boilSeconds: start.boilSeconds,
            newTimerId: `nid-${start.newTimerId}` as TimerId,
            now,
          }) satisfies Event,
      ),
    timerId.map((id) => ({ type: "Cancel", timerId: id, now }) satisfies Event),
    timerId.map((id) => ({ type: "Complete", timerId: id, now }) satisfies Event),
    fc.record({ timerId, firmness: fc.constantFrom<Firmness>(...FIRMNESS) }).map(
      (adjust) =>
        ({
          type: "Adjust",
          timerId: adjust.timerId,
          firmness: adjust.firmness,
          boilSeconds: 180,
          now,
        }) satisfies Event,
    ),
    fc.constant({ type: "AlarmFired", now } satisfies Event),
    fc.constant({ type: "Reconcile", now } satisfies Event),
    fc.record({ spec: genOrderSpec(KNOWN_NOODLE_TYPES), externalOrderId: orderIds }).map(
      (arrival) =>
        ({
          type: "OrderArrived",
          arrival: toArrival(arrival.spec, arrival.externalOrderId),
          now,
        }) satisfies Event,
    ),
    orderIds.map(
      (externalOrderId) => ({ type: "OrderCancelled", externalOrderId, now }) satisfies Event,
    ),
    fc.constant({ type: "PlanArrived", plan, now } satisfies Event),
  );
}

/** 待ち行列・採用済み計画・開始済み Timer を持つ場面と、そこへ流すイベント。 */
export const genScheduledScene: fc.Arbitrary<ScheduledScene> = fc
  .integer({ min: UNIT_COUNT_MIN, max: UNIT_COUNT_MAX })
  .chain((unitCount) => {
    const slotCount = unitCount * SLOTS_PER_UNIT;
    return fc.record({
      slotCount: fc.constant(slotCount),
      arms: fc.integer({ min: 1, max: 4 }),
      toleranceRatio: fc.integer({ min: 1, max: 30 }),
      schedule: genParams(unitCount),
      // 空・単独・複数を踏む（Timer が 1 本も無い場面では Alarm が ClearAlarm へ落ちる）。
      running: fc.array(genRunning(slotCount), { maxLength: 5 }),
      // 待ち行列も空を含む（採用済み計画が空になる場面と、非空の場面の双方）。
      orders: fc.array(genOrderSpec(KNOWN_NOODLE_TYPES), { maxLength: 4 }),
      elapsed: fc.integer({ min: -5_000, max: 60_000 }),
    });
  })
  .chain((seed) => {
    const timers = seed.running.map(timerOn);
    const now = (NOW + seed.elapsed) as EpochMillis;
    const pending = toPending(seed.orders);
    const params: SettleParams = {
      arms: seed.arms,
      toleranceRatio: seed.toleranceRatio,
      noodlePresets: DEFAULT_NOODLE_PRESETS,
      ...seed.schedule,
    };
    // 自前解を「外部から採用された計画」に見立てる。採用の経路（admit）はまだ無いため、採用済み計画を
    // 持つ状態はこうして組むしかない——形は同じ（AcceptedSlice extends PlanSlice）であり、settle と
    // committedSchedule から見た入力としては本物の採用済み計画と区別できない。
    const plan = baselineSchedule(
      pending,
      initialRelease(timers, NOW, seed.slotCount),
      DEFAULT_NOODLE_PRESETS,
      seed.schedule,
    );
    const state: TimerState = {
      ...EMPTY_STATE,
      timers,
      nextSeq: timers.length,
      pendingOrders: pending,
      acceptedSlices: plan.slices,
    };
    return genEventFor(timers, plan, now).map((event) => ({
      state,
      bare: { ...state, pendingOrders: [], acceptedSlices: [] },
      event,
      params,
      now,
    }));
  });
