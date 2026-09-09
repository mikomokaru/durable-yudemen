// tests/core/order-item-forgotten.example.test.ts — 忘れられた品目の帰結（Requirement 3）と、
// 性質 5.11 の前提（外部計画の採用と全棄却が同時に起きる非対称）。
//
// Feature: order-item-truncation, Requirement 3 / Property 5.11
// **Validates: Requirements 3.1, 3.2, 3.4, 3.5, 4.6, 5.11**
//
// **新しいコードは無い。** 上限で品目が落ちたとき、engine が通るのは既に在る経路である——参照先の無い Timer
// （アドホック開始・v12 由来の Timer が既に通っている道・order-lifecycle 判断 13）と、集合に無い品目への開始
// （`OrderItemNotFound`）。ここはそれを回帰として固定する。
//
// **場面の作り方は節によって違う。**
//   - Requirement 3 の 4 節（参照先の消失・開始の拒否・後着・配信）は**実際に truncation を通して**作る。
//     状態を手で組んで「参照先が無い」形を置くのではなく、満杯の集合へ新しい注文が届いて最も古い品目が
//     落ちる、という本物の経路を通す——手で組めば「上限がその状態を生む」ことが検査されない。
//   - 最後の節（性質 5.11 の前提・外部計画の非対称）は**手で組んだ場面**である。ここで要るのは「上限が
//     その状態を生む」ことではなく「品目が在る／無いで採否が分かれる」ことであり、しかも採用が起きる
//     場面は自前解に総費用で勝つ計画でなければ成立しない。ゆえに `adoptedPlanScene.ts` の共有場面
//     （通ることが確かめられた一組）を使い、忘却は品目集合から外すことで表す。

import { describe, expect, it } from "vitest";
import { decide } from "../../src/engine/decide";
import { completeTimer } from "../../src/engine/complete";
import { cancelTimer } from "../../src/engine/cancel";
import { ORDER_ITEM_LIMIT, upsertOrder } from "../../src/engine/pending";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { Effect } from "../../src/engine/effect";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { itemKeyOf, orderItemOf, type OrderItem } from "../../src/domain/order";
import { DEFAULT_NOODLE_PRESETS } from "../../src/domain/store";
import { receivePlan } from "../../src/engine/plan";
import { adjustedEndTime } from "../../src/engine/project";
import { synchronize } from "../../src/engine/sync";
import {
  ADOPTED_PLAN_PARAMS,
  IMPROVING_PLAN,
  PLAN_LONG_ITEM,
  PLAN_NOW,
  PLAN_SHORT_ITEM,
  planSceneState,
  UNSYNCED_PLAN_TIMERS,
} from "./adoptedPlanScene";
import { settleParams } from "../settleParams";
import { nonEmpty } from "../nonEmpty";

const PARAMS = settleParams({ arms: 2, toleranceRatio: 0.1 });
const NOW = 1_700_000_000_000 as EpochMillis;
const NOODLE = DEFAULT_NOODLE_PRESETS[0]!.noodleType;

function item(externalOrderId: string, itemIndex: number, arrivalTime: number): OrderItem {
  return {
    externalOrderId,
    itemIndex,
    noodleType: NOODLE,
    firmness: "normal",
    tableId: "t-1",
    arrivalTime,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
  };
}

/** 満杯 −1 件の「新しい側」の集合（最も古い 1 件は呼び出し側が前に足す）。 */
function newerFill(count: number): readonly OrderItem[] {
  return Array.from({ length: count }, (_unused, index) =>
    item(`fill-${String(index).padStart(6, "0")}`, 0, 10_000 + index),
  );
}

function timerFor(target: OrderItem): Timer {
  return createTimer({
    id: "t-cooking" as TimerId,
    slotIds: nonEmpty(["0" as SlotId]),
    noodleType: NOODLE as NoodleType,
    firmness: "normal",
    startTime: NOW,
    endTime: (NOW + 120_000) as EpochMillis,
    seq: 0,
    orderItem: {
      externalOrderId: target.externalOrderId,
      itemIndex: target.itemIndex,
      tableId: target.tableId,
    },
  });
}

/**
 * 「最も古い 1 件が調理中のまま忘れられた」状態を、本物の経路（`upsertOrder` の出口の上限）で作る。
 *
 * 何も守らない（判断 3）ので、生きた Timer の参照先でも落ちる。
 */
function forgetCookingItem(): { state: TimerState; forgotten: OrderItem; timer: Timer } {
  const forgotten = item("o-forgotten", 0, 1_000);
  const before = [forgotten, ...newerFill(ORDER_ITEM_LIMIT - 1)];
  const timer = timerFor(forgotten);
  const arriving = item("o-new", 0, 99_000_000);

  const after = upsertOrder(before, [timer], nonEmpty([arriving]));

  // 前提の確認——満杯だった集合に 1 件届き、最も古い（＝調理中の参照先）が落ちた。
  expect(before.length).toBe(ORDER_ITEM_LIMIT);
  expect(after.length).toBe(ORDER_ITEM_LIMIT);
  expect(after.some((each) => itemKeyOf(each) === itemKeyOf(forgotten))).toBe(false);

  return {
    state: { ...EMPTY_STATE, orderItems: after, timers: [timer], nextSeq: 1 },
    forgotten,
    timer,
  };
}

describe("忘れられた参照先を持つ Timer は既存の経路を通る（AC 3.1）", () => {
  it("orderItemOf は null を返す——参照先の無い Timer を扱う経路は一つ", () => {
    const { state, timer } = forgetCookingItem();

    expect(orderItemOf(timer, state.orderItems)).toBeNull();
  });

  it("Complete は Timer を閉じ、品目には何も書かない（completedAt の書き先が無い）", () => {
    const { state, timer } = forgetCookingItem();

    const outcome = completeTimer(state, timer.id, NOW, PARAMS);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.timers).toHaveLength(0);
    // 集合は同一インスタンスのまま（書き先が無いので写しも作らない）。
    expect(outcome.state.orderItems).toBe(state.orderItems);
    expect(outcome.state.orderItems.some((each) => each.completedAt !== null)).toBe(false);
  });

  it("Cancel は Timer を閉じ、品目には何も書かない（interruptedAt の書き先が無い）", () => {
    const { state, timer } = forgetCookingItem();

    const outcome = cancelTimer(state, timer.id, NOW, PARAMS);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.timers).toHaveLength(0);
    expect(outcome.state.orderItems).toBe(state.orderItems);
    expect(outcome.state.orderItems.some((each) => each.interruptedAt !== null)).toBe(false);
  });
});

describe("忘れられた未調理の品目への開始は既存の拒否事由（AC 3.2）", () => {
  it("StartOrderItem は OrderItemNotFound——新しい拒否事由は足さない", () => {
    // 未調理のまま落ちる場面（Timer は持たせない）。
    const forgotten = item("o-forgotten", 0, 1_000);
    const before = [forgotten, ...newerFill(ORDER_ITEM_LIMIT - 1)];
    const after = upsertOrder(before, [], nonEmpty([item("o-new", 0, 99_000_000)]));
    expect(after.some((each) => itemKeyOf(each) === itemKeyOf(forgotten))).toBe(false);
    const state: TimerState = { ...EMPTY_STATE, orderItems: after };

    const outcome = decide(
      state,
      {
        type: "StartOrderItem",
        slotIds: ["0"],
        externalOrderId: forgotten.externalOrderId,
        itemIndex: forgotten.itemIndex,
        newTimerId: "t-new" as TimerId,
        now: NOW,
      },
      PARAMS,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejection.code).toBe("OrderItemNotFound");
  });
});

describe("忘れられた注文の後着は新しい arrivalTime で入り直す（AC 3.4）", () => {
  it("引き継ぐ起点が無いので生き返る——本 spec は「生き返らない」を保証しない", () => {
    const forgotten = item("o-forgotten", 0, 1_000);
    const before = [forgotten, ...newerFill(ORDER_ITEM_LIMIT - 1)];
    const after = upsertOrder(before, [], nonEmpty([item("o-new", 0, 99_000_000)]));
    expect(after.some((each) => each.externalOrderId === "o-forgotten")).toBe(false);

    // 同じ注文の後着。`earliestArrival` の起点（同じ externalOrderId の品目）はもう集合に無い。
    const late = item("o-forgotten", 0, 99_500_000);
    const revived = upsertOrder(after, [], nonEmpty([late]));

    const found = revived.find((each) => each.externalOrderId === "o-forgotten");
    expect(found).toBeDefined();
    // **元の 1_000 ではなく、到着の値がそのまま入る。** 引き継ぎは「集合に残っている間」だけ効く
    // （pending-order-expiry AC 2.8 と同じ立場）。4096 件先の後着は現実の運用に無いので保証しない。
    expect(found!.arrivalTime).toBe(99_500_000);
  });
});

describe("忘れられた品目は Broadcast にも wire にも現れない（AC 3.5 / 4.6）", () => {
  const snapshotOf = (effects: readonly Effect[]) => {
    const broadcast = effects.find(
      (effect) => effect.type === "Broadcast" && effect.message.type === "snapshot",
    );
    if (broadcast?.type !== "Broadcast" || broadcast.message.type !== "snapshot") {
      throw new Error("snapshot の Broadcast が無い");
    }
    return broadcast.message;
  };

  it("正本に無いものは orderItems に載らない。その品目を指す Timer は TimerFact として載り続ける", () => {
    const { state, forgotten, timer } = forgetCookingItem();

    // 確定変化を 1 つ起こして snapshot を出させる（内容の違う後着）。
    const outcome = decide(
      state,
      { type: "OrderArrived", arrival: nonEmpty([item("o-trigger", 0, 99_900_000)]), now: NOW },
      PARAMS,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const snapshot = snapshotOf(outcome.effects);

    // 忘れられた品目は載らない——`orderItemsToBroadcast` は正本を絞るので、正本に無いものは載らない。
    expect(snapshot.orderItems.some((each) => itemKeyOf(each) === itemKeyOf(forgotten))).toBe(
      false,
    );
    // Timer は載り続ける（参照は解けないが Timer は開始時に写した値だけで成立する）。
    const fact = snapshot.timers.find((each) => each.id === timer.id);
    expect(fact).toBeDefined();
    expect(fact!.orderItem).toEqual({
      externalOrderId: forgotten.externalOrderId,
      itemIndex: forgotten.itemIndex,
    });
    // client 側の解決も null（釜のカードは麺種だけで出す）。
    expect(orderItemOf(fact!, snapshot.orderItems)).toBeNull();
  });
});

/**
 * 外部計画の**非対称経路**（性質 5.11 の前提を実際に踏ませる）。
 *
 * `order-item-forgotten.property` は「忘却に依らず走行中 Timer は等しい」を主張するが、そこで生成する
 * `PlanArrived` は実測で一度も採用されなかった（945 scene で採用 0 件・非対称 0 件・レビュー指摘）。
 * 両側とも不採用の no-op なら、主張は「何も起きないもの同士が等しい」に痩せる。ゆえに**採用が確実に
 * 起きる場面**をここで別に組み、非対称そのものを直接主張する。
 *
 * フィクスチャは `order-expiry-independence.example` の採用実績のある形に倣う——茹で 600 秒と 60 秒の
 * 2 種だけを持つ店で、短い方（`SHORT`）を先に入れる計画は自前解（`LONG` → `SHORT`・総和 1260 秒）より
 * 総費用が小さく、採用される。その `SHORT` を忘れた側では、卓 `t-b` の計画対象が空になって一片が
 * `isStale` で落ち、全棄却＝状態不変になる。
 */
describe("外部計画の非対称経路——full 側は採用され、forgotten 側は stale（性質 5.11 の前提）", () => {
  /**
   * `order-item-forgotten.property` は「忘却に依らず走行中 Timer は等しい」を主張するが、そこで生成する
   * `PlanArrived` は実測で一度も採用されなかった（945 scene で採用 0 件・レビュー指摘）。両側とも不採用の
   * no-op なら、主張は「何も起きないもの同士が等しい」に痩せる。ゆえに**採用が確実に起きる場面**をここで
   * 別に組み、非対称そのものを直接主張する。
   *
   * 場面は `adoptedPlanScene.ts` を共有する（`order-expiry-independence.example` と同じ一組）——短い方
   * （`PLAN_SHORT_ITEM`）を先に入れる計画は自前解より総費用が小さく採用される。その品目を忘れた側では
   * 卓 `t-b` の計画対象が空になり、一片が `isStale` で落ちて全棄却になる。
   */
  const RUNNING = synchronize(UNSYNCED_PLAN_TIMERS, ADOPTED_PLAN_PARAMS);

  it("full は採用して acceptedSlices が変わり、forgotten は全棄却で状態不変。それでも走行中 Timer は等しい", () => {
    const full = planSceneState(RUNNING, [PLAN_LONG_ITEM, PLAN_SHORT_ITEM]);
    // 短い方を忘れた側。卓 t-b の計画対象が空になるので、改善計画の一片は isStale で落ちる。
    const forgotten = planSceneState(RUNNING, [PLAN_LONG_ITEM]);
    const event = { type: "PlanArrived", plan: IMPROVING_PLAN, now: PLAN_NOW } as const;

    const fromFull = receivePlan(full, event, ADOPTED_PLAN_PARAMS);
    const fromForgotten = receivePlan(forgotten, event, ADOPTED_PLAN_PARAMS);

    expect(fromFull.ok).toBe(true);
    expect(fromForgotten.ok).toBe(true);
    if (!fromFull.ok || !fromForgotten.ok) return;

    // (1) full 側は**採用される**——acceptedSlices が空から計画の一片へ変わり、Effect が立つ。
    expect(full.acceptedSlices).toEqual([]);
    expect(fromFull.state.acceptedSlices).toEqual(IMPROVING_PLAN.slices);
    expect(fromFull.effects.length).toBeGreaterThan(0);

    // (2) forgotten 側は**採用されない**——一片が stale で全棄却され、状態も Effect も動かない。
    expect(fromForgotten.state.acceptedSlices).toEqual([]);
    expect(fromForgotten.state).toBe(forgotten);
    expect(fromForgotten.effects).toEqual([]);

    // (3) それでも同期済みの走行中 Timer は両側で等しい（採用側の再同期が恒等になる）。
    expect(fromFull.state.timers).toEqual(fromForgotten.state.timers);
    expect(fromFull.state.timers.map(adjustedEndTime)).toEqual(
      fromForgotten.state.timers.map(adjustedEndTime),
    );
  });
});
