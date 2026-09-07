// tests/core/order-expiry-independence.property.test.ts — 性質 5.9（注文期限からの独立）。
//
// Feature: pending-order-expiry, Property 5.9: 注文期限からの独立
// **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 5.9**
//
// 走行中 Timer は開始時に写した値（noodleType / firmness / startTime / endTime / slotIds / orderItem）だけで成立し、
// 発火・完了・調整・キャンセル・Boil_Sync・Alarm・卓の成員表のいずれも待ち行列を読まない（観測事実 8）。本 spec は
// 構造を足さず、これを性質として固定する（design Component 6）。
//
// 主張の形。Timer・設定・`now`・操作を固定し、**待ち行列の `arrivalTime` だけを寿命以上過去へ動かした**二つの状態
// ——片方は全件が生きており、もう片方は全件が期限切れ——に、両状態で同じに成立する操作を与えると、走行中 Timer の
// 集合・実効 endTime・Alarm 効果・`tableMembers`・hydration の Timer は等しい。守るのは「時間経過への不変」ではなく
// 「注文期限からの独立」である——`now` は両状態で同じ値で、茹で上がりと Alarm 解除は両方で普通に起こる。
//
// 操作は Event の全種から `StartOrderItem` を除いたもの（レビュー指摘：期限内では Timer が増え、期限切れでは
// `OrderItemNotFound` で拒否されるので「結果が等しい」という主張は AC 2.5 と衝突する。期限切れ品目の開始拒否は
// `start-order-item.example` が別に見る）。`OrderArrived` / `OrderCancelled` は待ち行列だけを動かす遷移で Timer を
// 読まないが、両状態で成立する操作として含める。`RecordsReceived` の後着は既存の注文の最早の `arrivalTime` を引き継ぐ
// （期限切れの状態では期限切れのまま・AC 2.8）——それでも Timer 側は動かない。hydration は `toWireSnapshot` で見る。
//
// 等しさは決定の結果（`decide`）で見る。Alarm は Effect 列に現れる SetAlarm / ClearAlarm を突き合わせる——no-op
// （Effect 空）になるかは確定結果の比較で決まり、期限切れの状態では推奨が空になって採用や要求の経路が変わりうるため、
// 一方だけが列を出す場面が在る。そのときも、出た Alarm は走行中の実効最早（`nextAlarmEffect`）だけの関数であり、
// 両状態の Timer 集合が等しい以上、出るなら同じ値である。それを「両方が出せば等しい」「出たものは相手の Timer から
// 導いた Alarm に等しい」の二つで固定する。
//
// **前提：Timer は現在の設定で同期済み（`synchronize` を通した集合）。** 外部計画の受領は、生きている状態では採用されて
// `settle` が Timer を再同期し、期限切れの状態では全一片が `isStale` で棄却されて状態を返す（再同期しない）。設定変更の
// 直後など未同期の Timer を与えると、採用側だけが再同期して Timer が食い違う（レビュー実走：実効終了 30 秒 / 33 秒 →
// 採用側は 31.5 秒 / 31.5 秒、棄却側は 30 秒 / 33 秒のまま）。これは「全棄却なら状態不変」の正しい帰結であり、独立性の
// 反例ではない。同期済みの入力では再同期が恒等になるので厳密一致が成り立つ。反例は `order-expiry-independence.example`
// に残す。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide } from "../../src/engine/decide";
import type { Effect } from "../../src/engine/effect";
import type { Event, ReceivedOrder } from "../../src/engine/event";
import { nextAlarmEffect } from "../../src/engine/alarm";
import { adjustedEndTime, tableMembers } from "../../src/engine/project";
import { recommend } from "../../src/engine/recommend";
import { baselineSchedule, initialRelease, type CookSchedule } from "../../src/engine/schedule";
import { initialLifts } from "../../src/engine/lift";
import { settle, toWireSnapshot } from "../../src/engine/settle";
import type { SettleParams } from "../../src/engine/settle";
import { shownPlanOf } from "../../src/engine/stability";
import { synchronize } from "../../src/engine/sync";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import type { Timer } from "../../src/engine/timer";
import type { EpochMillis, TimerId } from "../../src/engine/types";
import type { Firmness } from "../../src/domain/firmness";
import { liveOrders, ORDER_LIFETIME_MS, type OrderItem } from "../../src/domain/order";
import {
  DEFAULT_NOODLE_PRESETS,
  SLOTS_PER_UNIT,
  occupiedSlotsOf,
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
} from "./scheduleScenes";

const NUM_RUNS = 250;

/** 全 Firmness（茹で加減の安定 id）。 */
const FIRMNESS: readonly Firmness[] = ["extraHard", "hard", "normal", "soft"];

/** 受領の順序の印（上流が付与する不透明な文字列・受領テストと同じ形）。 */
const toSequenceNumber = (n: number): string => String(n).padStart(56, "0");

/** 両状態と、そこへ流す操作・パラメータ・時刻。 */
interface IndependenceScene {
  /** 全件が生きている待ち行列を持つ状態。 */
  readonly alive: TimerState;
  /** 同じ Timer・同じ設定で、待ち行列の arrivalTime だけを寿命以上過去へ動かした状態（全件が期限切れ）。 */
  readonly expired: TimerState;
  readonly event: Event;
  readonly params: SettleParams;
  readonly now: EpochMillis;
}

/**
 * 到着 1 件（OrderArrived / RecordsReceived の品目）。arrivalTime は操作の一部で、両状態に同じ値を与える——
 * 既存の注文への後着なら `upsertOrder` が最早の arrivalTime を引き継ぐので、期限切れの状態では期限切れのまま。
 */
function itemsOf(
  externalOrderId: string,
  count: number,
  arrivalTime: number,
  tableId: string | null,
): readonly OrderItem[] {
  return Array.from({ length: count }, (_unused, itemIndex) => ({
    externalOrderId,
    itemIndex,
    noodleType: KNOWN_NOODLE_TYPES[itemIndex % KNOWN_NOODLE_TYPES.length]!,
    firmness: "normal" as const,
    tableId,
    arrivalTime,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
  }));
}

/**
 * 両状態で同じに成立する操作。Event の全種から `StartOrderItem` だけを除く。
 *
 * Timer を指す操作（Cancel / Complete / Adjust）は既存 id と不在 id の双方を採る（拒否経路も踏む）。アドホック開始
 * `Start` は待ち行列を読まない。`RecordsReceived` は既存の注文への後着・新規・0 件（除去）を踏む。`PlanArrived` は
 * 生きている待ち行列の自前解を計画として渡す——生きている状態では Acceptance_Gate を通り（採用なら settle）、
 * 期限切れの状態では全一片が `isStale` で落ちて無変化になる。どちらでも Timer 側は動かない。
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
  const genArrival = fc.integer({ min: NOW - 600_000, max: NOW });
  const genTable = fc.oneof(fc.constantFrom<string>("t-1", "t-2"), fc.constant(null));
  const genReceived: fc.Arbitrary<ReceivedOrder> = fc
    .record({
      externalOrderId: orderIds,
      terminalId: fc.constantFrom("term-a", "term-b"),
      sequence: fc.integer({ min: 0, max: 12 }),
      itemCount: fc.integer({ min: 0, max: 3 }),
      arrivalTime: genArrival,
      tableId: genTable,
    })
    .map(({ externalOrderId, terminalId, sequence, itemCount, arrivalTime, tableId }) => ({
      externalOrderId,
      terminalId,
      sequenceNumber: toSequenceNumber(sequence),
      items: itemsOf(externalOrderId, itemCount, arrivalTime, tableId),
    }));

  return fc.oneof(
    fc
      .record({
        slot: fc.integer({ min: 0, max: SLOTS_PER_UNIT - 1 }),
        boilSeconds: fc.integer({ min: 30, max: 600 }),
        newTimerId: fc.string({ minLength: 1, maxLength: 6 }),
      })
      .map(
        (start) =>
          ({
            type: "Start",
            slotIds: [String(start.slot)],
            noodleType: KNOWN_NOODLE_TYPES[0]!,
            boilSeconds: start.boilSeconds,
            newTimerId: `nid-${start.newTimerId}` as TimerId,
            now,
          }) satisfies Event,
      ),
    timerId.map((id) => ({ type: "Cancel", timerId: id, now }) satisfies Event),
    timerId.map((id) => ({ type: "Complete", timerId: id, now }) satisfies Event),
    fc
      .record({
        timerId,
        firmness: fc.constantFrom<Firmness>(...FIRMNESS),
        boilSeconds: fc.integer({ min: 30, max: 600 }),
      })
      .map(
        (adjust) =>
          ({
            type: "Adjust",
            timerId: adjust.timerId,
            firmness: adjust.firmness,
            boilSeconds: adjust.boilSeconds,
            now,
          }) satisfies Event,
      ),
    fc.constant({ type: "AlarmFired", now } satisfies Event),
    fc.constant({ type: "Reconcile", now } satisfies Event),
    fc
      .record({
        externalOrderId: orderIds,
        itemCount: fc.integer({ min: 1, max: 3 }),
        arrivalTime: genArrival,
        tableId: genTable,
      })
      .map(
        (arrival) =>
          ({
            type: "OrderArrived",
            arrival: nonEmpty(
              itemsOf(
                arrival.externalOrderId,
                arrival.itemCount,
                arrival.arrivalTime,
                arrival.tableId,
              ),
            ),
            now,
          }) satisfies Event,
      ),
    orderIds.map(
      (externalOrderId) => ({ type: "OrderCancelled", externalOrderId, now }) satisfies Event,
    ),
    fc
      .array(genReceived, { maxLength: 4 })
      .map((received) => ({ type: "RecordsReceived", received, now }) satisfies Event),
    fc.constant({ type: "PlanArrived", plan, now } satisfies Event),
  );
}

/**
 * 場面。Timer は卓あり・卓なし・走行中・茹で上がり済みを振り（`genRunning`）、待ち行列は空を含む 0〜4 注文。
 * 生きている状態には自前解を採用済み一片と Shown_Plan として載せ、採用・変更費用の経路を通す（期限切れの状態は
 * 待ち行列以外を同じ値で持つ——採用済み一片も Shown_Plan も同じ。読む側が絞るので、期限切れの一片は合成で捨てられる）。
 */
const genScene: fc.Arbitrary<IndependenceScene> = fc
  .integer({ min: UNIT_COUNT_MIN, max: UNIT_COUNT_MAX })
  .chain((unitCount) => {
    const slotCount = unitCount * SLOTS_PER_UNIT;
    return fc.record({
      slotCount: fc.constant(slotCount),
      arms: fc.integer({ min: 1, max: 4 }),
      toleranceRatio: fc.integer({ min: 1, max: 30 }),
      schedule: genParams(unitCount),
      running: fc.array(genRunning(slotCount), { maxLength: 5 }),
      orders: fc.array(genOrderSpec(KNOWN_NOODLE_TYPES), { maxLength: 4 }),
      elapsed: fc.integer({ min: -5_000, max: 60_000 }),
      // 寿命に加えて動かす幅。到着（NOW − 600 秒〜NOW）と now（NOW − 5 秒〜NOW + 60 秒）の差を覆い、全件を切る。
      extra: fc.integer({ min: 700_000, max: 4 * 60 * 60 * 1000 }),
    });
  })
  .chain((seed) => {
    const params: SettleParams = {
      noodlePresets: DEFAULT_NOODLE_PRESETS,
      ...seed.schedule,
      toleranceRatio: seed.toleranceRatio,
      arms: seed.arms,
    };
    // 前提：現在の設定で同期済みの Timer（ヘッダの注記。未同期なら採用側だけが再同期して食い違う）。
    const timers = synchronize(seed.running.map(timerOn), params);
    const now = (NOW + seed.elapsed) as EpochMillis;
    const pending = toPending(seed.orders);
    const plan = baselineSchedule(
      pending,
      initialRelease(timers, NOW, seed.slotCount),
      tableMembers(timers),
      initialLifts(timers),
      DEFAULT_NOODLE_PRESETS,
      seed.schedule,
      NOW,
      occupiedSlotsOf(timers),
      null,
    );
    const alive: TimerState = {
      ...EMPTY_STATE,
      timers,
      nextSeq: timers.length,
      orderItems: pending,
      acceptedSlices: plan.slices,
      shownPlan: shownPlanOf(plan, recommend(plan)),
    };
    const shift = ORDER_LIFETIME_MS + seed.extra;
    const expired: TimerState = {
      ...alive,
      orderItems: pending.map((order) => ({ ...order, arrivalTime: order.arrivalTime - shift })),
    };
    return genEventFor(timers, plan, now).map((event) => ({
      alive,
      expired,
      event,
      params,
      now,
    }));
  });

/** Effect 列の Alarm（SetAlarm / ClearAlarm）。DO は同時に 1 Alarm ゆえ高々 1 件。 */
function alarmsOf(effects: readonly Effect[]): readonly Effect[] {
  const alarms = effects.filter(
    (effect) => effect.type === "SetAlarm" || effect.type === "ClearAlarm",
  );
  expect(alarms.length).toBeLessThanOrEqual(1);
  return alarms;
}

/** hydration の Timer（wire）。 */
function hydratedTimers(state: TimerState, params: SettleParams, now: EpochMillis) {
  const message = toWireSnapshot(state, params, now);
  if (message.type !== "snapshot") throw new Error("snapshot でない");
  return message;
}

describe("Feature: pending-order-expiry, Property 5.9: 注文期限からの独立", () => {
  it("待ち行列の arrivalTime だけを寿命以上過去へ動かしても、両状態で成立する操作から同じ Timer・実効 endTime・Alarm・tableMembers が出る", () => {
    fc.assert(
      // Feature: pending-order-expiry, Property 5.9: 注文期限からの独立
      // Validates: Requirements 4.1, 4.2, 4.3, 5.9
      fc.property(genScene, ({ alive, expired, event, params, now }) => {
        // 前提：片方は全件が生きており、もう片方は全件が期限切れ。Timer・設定・now・操作は同じ。
        expect(liveOrders(alive.orderItems, now)).toBe(alive.orderItems);
        expect(liveOrders(expired.orderItems, now)).toEqual([]);
        expect(expired.timers).toBe(alive.timers);
        expect(event.type).not.toBe("StartOrderItem");

        const fromAlive = decide(alive, event, params);
        const fromExpired = decide(expired, event, params);

        // 可否は Timer 側だけで決まる（StartOrderItem を除いた操作に待ち行列を理由とする拒否は無い）。
        expect(fromAlive.ok).toBe(fromExpired.ok);
        if (!fromAlive.ok || !fromExpired.ok) {
          if (!fromAlive.ok && !fromExpired.ok) {
            expect(fromAlive.rejection).toEqual(fromExpired.rejection);
          }
          return;
        }

        // 走行中 Timer の集合（id・釜・麺・茹で加減・startTime・endTime・seq・boiledAt・adjustment・orderItem）。
        expect(fromAlive.state.timers).toEqual(fromExpired.state.timers);
        // 実効 endTime（endTime + adjustment）。
        expect(fromAlive.state.timers.map(adjustedEndTime)).toEqual(
          fromExpired.state.timers.map(adjustedEndTime),
        );
        // 卓の錨（tableMembers）。
        expect(tableMembers(fromAlive.state.timers)).toEqual(
          tableMembers(fromExpired.state.timers),
        );

        // Alarm 効果。両方が列を出せば等しく、出た Alarm は相手の Timer から導いた Alarm に等しい（Alarm は走行中の
        // 実効最早だけの関数であり、待ち行列にも推奨にも依らない）。
        const aliveAlarms = alarmsOf(fromAlive.effects);
        const expiredAlarms = alarmsOf(fromExpired.effects);
        if (aliveAlarms.length > 0 && expiredAlarms.length > 0) {
          expect(aliveAlarms).toEqual(expiredAlarms);
        }
        for (const alarm of aliveAlarms)
          expect(alarm).toEqual(nextAlarmEffect(fromExpired.state.timers));
        for (const alarm of expiredAlarms)
          expect(alarm).toEqual(nextAlarmEffect(fromAlive.state.timers));

        // 期限切れの状態の待ち行列は、操作が動かした分を除いて期限切れのまま（操作が生き返らせない・AC 2.8 の帰結）。
        // 走行中 Timer の集合は待ち行列の中身に一切依らないことを、Persist の snapshot の Timer でも見る。
        const alivePersist = fromAlive.effects.find((effect) => effect.type === "Persist");
        const expiredPersist = fromExpired.effects.find((effect) => effect.type === "Persist");
        if (alivePersist?.type === "Persist" && expiredPersist?.type === "Persist") {
          expect(alivePersist.snapshot.timers).toEqual(expiredPersist.snapshot.timers);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("hydration（toWireSnapshot）と確定の settle は、待ち行列の期限に依らず同じ Timer を配る", () => {
    fc.assert(
      // Feature: pending-order-expiry, Property 5.9: 注文期限からの独立（hydration・TimerFact は待ち行列を参照しない）
      // Validates: Requirements 4.1, 4.4, 5.9
      fc.property(genScene, ({ alive, expired, params, now }) => {
        const fromAlive = hydratedTimers(alive, params, now);
        const fromExpired = hydratedTimers(expired, params, now);
        // wire の TimerFact は待ち行列を参照しない（AC 4.4）——Timer は同じ、待ち行列だけが片方で空。
        expect(fromAlive.timers).toEqual(fromExpired.timers);
        expect(fromAlive.serverTime).toBe(fromExpired.serverTime);
        expect(fromExpired.pendingOrders).toEqual([]);
        expect(fromAlive.pendingOrders).toEqual(alive.orderItems);

        // 確定の settle（同じ状態から・確定変化として）も Timer と Alarm は同じ——Boil_Sync の結果は待ち行列に依らない。
        const settledAlive = settle(alive, { ...alive }, params, now, true);
        const settledExpired = settle(expired, { ...expired }, params, now, true);
        expect(settledAlive.ok).toBe(true);
        expect(settledExpired.ok).toBe(true);
        if (!settledAlive.ok || !settledExpired.ok) return;
        expect(settledAlive.state.timers).toEqual(settledExpired.state.timers);
        expect(settledAlive.state.timers.map(adjustedEndTime)).toEqual(
          settledExpired.state.timers.map(adjustedEndTime),
        );
        expect(tableMembers(settledAlive.state.timers)).toEqual(
          tableMembers(settledExpired.state.timers),
        );
        const aliveAlarms = alarmsOf(settledAlive.effects);
        const expiredAlarms = alarmsOf(settledExpired.effects);
        if (aliveAlarms.length > 0 && expiredAlarms.length > 0) {
          expect(aliveAlarms).toEqual(expiredAlarms);
        }
        for (const alarm of aliveAlarms)
          expect(alarm).toEqual(nextAlarmEffect(settledExpired.state.timers));
        for (const alarm of expiredAlarms)
          expect(alarm).toEqual(nextAlarmEffect(settledAlive.state.timers));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
