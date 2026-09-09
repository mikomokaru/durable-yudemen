// tests/core/order-item-forgotten.property.test.ts — 走行中の自立（性質 5.11）。
//
// Feature: order-item-truncation, Property 5.11
// **Validates: Requirements 3.1, 5.11**
//
// 走行中 Timer は開始時に写した値（`noodleType` / `firmness` / `startTime` / `endTime` / `slotIds` / `orderItem`）
// だけで成立し、発火・完了・調整・キャンセル・Boil_Sync・Alarm・卓の成員表のいずれも品目集合を読まない。
// `pending-order-expiry` の性質 5.9 が「注文**期限**からの独立」を守るのに対し、ここは「品目が**忘れられる**
// ことからの独立」を守る——上限は期限と違って `cooking` の参照先も落とす（判断 3）ので、参照が解けない状態が
// 期限のときより広く起こる。
//
// 主張の形。Timer・設定・`now`・操作を固定し、**品目集合から最も古い k 件を落とした**二つの状態に、両状態で
// 同じに成立する操作を与えると、走行中 Timer の集合・実効 endTime・Alarm 効果・`tableMembers` は等しい。
// 落とす k 件には**走行中 Timer の参照先を必ず含める**——含めなければ「参照が解けない」場面を踏まない。
//
// 節は 2 つ。(1) `decide` の結果を比べる。(2) **hydration（`toWireSnapshot`）と確定の `settle`**（Boil_Sync を
// 通す経路）を比べる——`pending-order-expiry` 性質 5.9 が持つ 2 節目と同じ形で、wire の `TimerFact` が品目集合を
// 参照しないこと・同期の結果が品目集合に依らないことを別に固定する。
//
// 操作から `StartOrderItem` を除くのは性質 5.9 と同じ理由である（片方に在って片方に無い品目への開始は、
// 一方だけが成功して「結果が等しい」という主張と衝突する。忘れられた品目への開始は
// `order-item-forgotten.example` が `OrderItemNotFound` として別に見る）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide } from "../../src/engine/decide";
import { nextAlarmEffect } from "../../src/engine/alarm";
import { adjustedEndTime, tableMembers } from "../../src/engine/project";
import { synchronize } from "../../src/engine/sync";
import { settle, toWireSnapshot } from "../../src/engine/settle";
import { createTimer, type Timer } from "../../src/engine/timer";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import type { Effect } from "../../src/engine/effect";
import type { Event } from "../../src/engine/event";
import type { SettleParams } from "../../src/engine/settle";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { compareArrival, itemKeyOf, type OrderItem } from "../../src/domain/order";
import { DEFAULT_NOODLE_PRESETS } from "../../src/domain/store";
import { settleParams } from "../settleParams";
import { nonEmpty } from "../nonEmpty";

const PARAMS: SettleParams = settleParams({ arms: 2, toleranceRatio: 0.1 });
const T0 = 1_700_000_000_000;
const NOODLE = DEFAULT_NOODLE_PRESETS[0]!.noodleType;

function item(index: number, tableId: string | null): OrderItem {
  return {
    externalOrderId: `o-${String(index).padStart(4, "0")}`,
    itemIndex: 0,
    noodleType: NOODLE,
    firmness: "normal",
    tableId,
    arrivalTime: T0 + index * 1000,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
  };
}

/** 当該品目から始まった走行中 Timer。 */
function timerFor(target: OrderItem, seq: number): Timer {
  return createTimer({
    id: `t-${seq}` as TimerId,
    slotIds: nonEmpty([String(seq) as SlotId]),
    noodleType: NOODLE as NoodleType,
    firmness: "normal",
    startTime: T0 as EpochMillis,
    endTime: (T0 + 60_000 + seq * 3_000) as EpochMillis,
    seq,
    orderItem: {
      externalOrderId: target.externalOrderId,
      itemIndex: target.itemIndex,
      tableId: target.tableId,
    },
  });
}

/** hydration の wire snapshot。 */
function hydrated(state: TimerState, now: EpochMillis) {
  const message = toWireSnapshot(state, PARAMS, now);
  if (message.type !== "snapshot") throw new Error("snapshot でない");
  return message;
}

/** Effect 列の Alarm（DO は同時に 1 Alarm ゆえ高々 1 件）。 */
function alarmsOf(effects: readonly Effect[]): readonly Effect[] {
  const alarms = effects.filter(
    (effect) => effect.type === "SetAlarm" || effect.type === "ClearAlarm",
  );
  expect(alarms.length).toBeLessThanOrEqual(1);
  return alarms;
}

const genScene = fc
  .record({
    itemCount: fc.integer({ min: 4, max: 10 }),
    runningCount: fc.integer({ min: 1, max: 3 }),
    /** 落とす件数。最も古い側から採るので、走行中の参照先（先頭側）が必ず含まれる。 */
    forget: fc.integer({ min: 1, max: 3 }),
    tables: fc.array(fc.constantFrom("t-a", "t-b", null), { minLength: 4, maxLength: 10 }),
    elapsed: fc.integer({ min: 0, max: 180_000 }),
  })
  .map((seed) => {
    const items = Array.from({ length: seed.itemCount }, (_unused, index) =>
      item(index, seed.tables[index % seed.tables.length] ?? null),
    );
    // 走行中は**先頭側の品目**（最も古い側）から始まったものにする——落ちるのも先頭側なので、
    // 「参照先が落ちる」場面を必ず踏む。
    const running = synchronize(
      Array.from({ length: Math.min(seed.runningCount, items.length) }, (_unused, seq) =>
        timerFor(items[seq]!, seq),
      ),
      PARAMS,
    );
    const forget = Math.min(seed.forget, items.length - 1);
    const oldest = [...items].sort(compareArrival).slice(0, forget);
    const gone = new Set(oldest.map((each) => itemKeyOf(each)));

    const full: TimerState = {
      ...EMPTY_STATE,
      timers: running,
      nextSeq: running.length,
      orderItems: items,
    };
    const forgotten: TimerState = {
      ...full,
      orderItems: items.filter((each) => !gone.has(itemKeyOf(each))),
    };
    return {
      full,
      forgotten,
      gone,
      // 落ちた品目の 1 つ（外部計画がこれを指す。走行中の参照先ゆえ両側で `isStale` になる）。
      dropped: oldest[0]!,
      now: (T0 + seed.elapsed) as EpochMillis,
    };
  });

/**
 * 両状態で同じに成立する操作。**除くのは `StartOrderItem` だけ**（ヘッダの理由）。
 *
 * `PlanArrived` は落ちた品目を指すが、**両側とも `isStale` で落ちて no-op になる**（実測）。落ちた品目は
 * この生成器では必ず走行中 Timer の参照先であり、`pendingOrders` は `cooking` を除くので、**`full` 側でも
 * その品目は計画対象に入らない**——`forgotten` 側だけが stale なのではなく、`full` 側も同じ理由で stale で
 * ある。ゆえに `PlanArrived` がここで踏んでいるのは「受領という遷移が走行中 Timer を動かさない」までで、
 * 採否の非対称は一切踏んでいない。
 * **採用と全棄却が同時に起きる非対称は `order-item-forgotten.example` が別に固定する**
 * （`adoptedPlanScene.ts` の採用実績のある場面で、`acceptedSlices` の変化と状態不変を直接主張する）。
 */
function genEventFor(
  state: TimerState,
  now: EpochMillis,
  forgotten: OrderItem,
): fc.Arbitrary<Event> {
  const timerIds = state.timers.map((timer) => timer.id);
  const forTimer = (make: (timerId: string) => Event) =>
    timerIds.length === 0 ? [] : [fc.constantFrom(...timerIds).map(make)];
  return fc.oneof(
    fc.constant({ type: "AlarmFired", now } satisfies Event),
    fc.constant({ type: "Reconcile", now } satisfies Event),
    ...forTimer((timerId) => ({ type: "Complete", timerId, now }) satisfies Event),
    ...forTimer((timerId) => ({ type: "Cancel", timerId, now }) satisfies Event),
    // 調整（ヘッダが挙げている操作。Timer だけを動かし、品目集合を読まない）。
    ...forTimer(
      (timerId) =>
        ({ type: "Adjust", timerId, firmness: "hard", boilSeconds: 52, now }) satisfies Event,
    ),
    // アドホック開始（注文を持たない開始。`StartOrderItem` と違い品目集合を照合しない）。
    fc.constant({
      type: "Start",
      slotIds: ["5"],
      noodleType: NOODLE,
      boilSeconds: 90,
      newTimerId: "t-adhoc" as TimerId,
      now,
    } satisfies Event),
    fc.constant({
      type: "OrderArrived",
      arrival: nonEmpty([item(9_999, "t-a")]),
      now,
    } satisfies Event),
    fc.constant({
      type: "OrderCancelled",
      externalOrderId: "o-0003",
      now,
    } satisfies Event),
    // 受領（新規・後着・0 件の除去を踏む）。判定材料も同じに進む。
    fc.constant({
      type: "RecordsReceived",
      received: [
        {
          externalOrderId: "o-9998",
          terminalId: "1",
          sequenceNumber: "9".repeat(56),
          items: [item(9_998, "t-b")],
        },
      ],
      now,
    } satisfies Event),
    fc.constant({
      type: "RecordsReceived",
      received: [
        { externalOrderId: "o-0002", terminalId: "2", sequenceNumber: "8".repeat(56), items: [] },
      ],
      now,
    } satisfies Event),
    // 外部計画の受領。落ちた品目を指すが、その品目は走行中 Timer の参照先ゆえ `pendingOrders` が
    // `cooking` として除くので、**両側とも `isStale` で落ちる**（採否の非対称は踏まない・ヘッダの理由）。
    fc.constant({
      type: "PlanArrived",
      plan: {
        slices: [
          {
            tableKey: forgotten.tableId ?? forgotten.externalOrderId,
            placements: [
              {
                externalOrderId: forgotten.externalOrderId,
                itemIndex: forgotten.itemIndex,
                slotIds: nonEmpty(["4" as SlotId]),
                startAt: now,
                serveAt: (now + 60_000) as EpochMillis,
                anchor: null,
              },
            ],
          },
        ],
      },
      now,
    } satisfies Event),
  );
}

describe("Feature: order-item-truncation, Property 5.11: 走行中は忘却から独立", () => {
  it("最も古い品目（走行中の参照先を含む）を落としても、両状態で成立する操作から同じ Timer・実効 endTime・Alarm・tableMembers が出る", () => {
    fc.assert(
      fc.property(
        genScene.chain((scene) =>
          genEventFor(scene.full, scene.now, scene.dropped).map((event) => ({
            full: scene.full,
            forgotten: scene.forgotten,
            gone: scene.gone,
            event,
          })),
        ),
        ({ full, forgotten, gone, event }) => {
          // 前提——Timer は同じ、品目だけが減っており、**走行中の参照先が落ちている**。
          expect(forgotten.timers).toBe(full.timers);
          expect(forgotten.orderItems.length).toBeLessThan(full.orderItems.length);
          expect(
            full.timers.some(
              (timer) => timer.orderItem !== null && gone.has(itemKeyOf(timer.orderItem)),
            ),
          ).toBe(true);
          expect(event.type).not.toBe("StartOrderItem");

          const fromFull = decide(full, event, PARAMS);
          const fromForgotten = decide(forgotten, event, PARAMS);

          // 可否は Timer 側だけで決まる（除いた操作以外に品目集合を理由とする拒否は無い）。
          expect(fromFull.ok).toBe(fromForgotten.ok);
          if (!fromFull.ok || !fromForgotten.ok) {
            if (!fromFull.ok && !fromForgotten.ok) {
              expect(fromFull.rejection).toEqual(fromForgotten.rejection);
            }
            return;
          }

          // 走行中 Timer の集合・実効 endTime・卓の錨。
          expect(fromFull.state.timers).toEqual(fromForgotten.state.timers);
          expect(fromFull.state.timers.map(adjustedEndTime)).toEqual(
            fromForgotten.state.timers.map(adjustedEndTime),
          );
          expect(tableMembers(fromFull.state.timers)).toEqual(
            tableMembers(fromForgotten.state.timers),
          );

          // Alarm は走行中の実効最早だけの関数であり、品目集合にも推奨にも依らない。
          const fullAlarms = alarmsOf(fromFull.effects);
          const forgottenAlarms = alarmsOf(fromForgotten.effects);
          if (fullAlarms.length > 0 && forgottenAlarms.length > 0) {
            expect(fullAlarms).toEqual(forgottenAlarms);
          }
          for (const alarm of fullAlarms)
            expect(alarm).toEqual(nextAlarmEffect(fromForgotten.state.timers));
          for (const alarm of forgottenAlarms)
            expect(alarm).toEqual(nextAlarmEffect(fromFull.state.timers));

          // Persist に載る Timer も等しい（永続の側から見ても品目集合に依らない）。
          const fullPersist = fromFull.effects.find((effect) => effect.type === "Persist");
          const forgottenPersist = fromForgotten.effects.find(
            (effect) => effect.type === "Persist",
          );
          if (fullPersist?.type === "Persist" && forgottenPersist?.type === "Persist") {
            expect(fullPersist.snapshot.timers).toEqual(forgottenPersist.snapshot.timers);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("hydration（toWireSnapshot）と確定の settle も、忘却に依らず同じ Timer・実効 endTime・tableMembers・Alarm を配る", () => {
    fc.assert(
      fc.property(genScene, ({ full, forgotten, gone, now }) => {
        // wire の TimerFact は品目集合を参照しない——Timer は同じ、品目だけが片方で減っている。
        const fromFull = hydrated(full, now);
        const fromForgotten = hydrated(forgotten, now);
        expect(fromFull.timers).toEqual(fromForgotten.timers);
        expect(fromFull.serverTime).toBe(fromForgotten.serverTime);
        // 落ちた品目は配信にも現れない（片側だけが持つ）。
        for (const key of gone) {
          expect(fromForgotten.orderItems.some((each: OrderItem) => itemKeyOf(each) === key)).toBe(
            false,
          );
        }
        expect(fromForgotten.orderItems.length).toBeLessThan(fromFull.orderItems.length);

        // 確定の settle（Boil_Sync を通す経路）も Timer と Alarm は同じ——同期の結果は品目集合に依らない。
        const settledFull = settle(full, { ...full }, PARAMS, now, true);
        const settledForgotten = settle(forgotten, { ...forgotten }, PARAMS, now, true);
        expect(settledFull.ok).toBe(true);
        expect(settledForgotten.ok).toBe(true);
        if (!settledFull.ok || !settledForgotten.ok) return;
        expect(settledFull.state.timers).toEqual(settledForgotten.state.timers);
        expect(settledFull.state.timers.map(adjustedEndTime)).toEqual(
          settledForgotten.state.timers.map(adjustedEndTime),
        );
        expect(tableMembers(settledFull.state.timers)).toEqual(
          tableMembers(settledForgotten.state.timers),
        );
        const fullAlarms = alarmsOf(settledFull.effects);
        const forgottenAlarms = alarmsOf(settledForgotten.effects);
        if (fullAlarms.length > 0 && forgottenAlarms.length > 0) {
          expect(fullAlarms).toEqual(forgottenAlarms);
        }
        for (const alarm of fullAlarms)
          expect(alarm).toEqual(nextAlarmEffect(settledForgotten.state.timers));
        for (const alarm of forgottenAlarms)
          expect(alarm).toEqual(nextAlarmEffect(settledFull.state.timers));
      }),
      { numRuns: 300 },
    );
  });
});
