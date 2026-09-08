// tests/core/order-lifecycle.example.test.ts — 品目の生涯（未調理 → 調理中 → 調理済み）を engine の遷移で名指しで固定する。
//
// **Validates: order-lifecycle Requirements 1.1, 1.3, 1.4, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 6.2, 6.3, 7.2, 7.3, 7.6, 7.7, 7.9, 7.9′**
//
// 品目は開始で消費されず、完了（complete）と中断（cancel）は品目に記録される。ここで固定するのは 4 つ——
//   1. complete / cancel の記録（参照先に completedAt / interruptedAt・参照先なしは書かない・arrivalTime 不変）
//   2. 一括完了は client が Timer ごとに complete を送る形で、各品目に記録される
//   3. 読む側の入口——snapshot は「期限内 ∨ 参照先」、要求と推奨と指紋は「未調理」
//   4. 移行例外——v12 由来で参照先の無い Timer は動き続け、操作時にも参照先が無ければ何も書かず、後着で補われれば書く

import { describe, expect, it } from "vitest";
import { decide } from "../../src/engine/decide";
import { digestInput } from "../../src/engine/digest";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import { toWireSnapshot } from "../../src/engine/settle";
import { createTimer } from "../../src/engine/timer";
import type { Effect } from "../../src/engine/effect";
import type { Event } from "../../src/engine/event";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { DEFAULT_NOODLE_PRESETS } from "../../src/domain/store";
import {
  itemStatusOf,
  ORDER_LIFETIME_MS,
  orderItemsToBroadcast,
  pendingOrders,
  type OrderItem,
} from "../../src/domain/order";
import { settleParams } from "../settleParams";
import { nonEmpty } from "../nonEmpty";
import { orderQueueEntries } from "../../src/client/components/queueDisplay";
import { itemKeyOf } from "../../src/domain/order";
import {
  every,
  kitchenOf,
  order as sceneOrder,
  startItem,
  step as sceneStep,
  T0,
  timerIdOf,
  viewOf,
  type Snapshot,
} from "./operationScenes";

const NOW = 1_700_000_000_000 as EpochMillis;
const MINUTE = 60_000;
const PARAMS = settleParams({ arms: 2, toleranceRatio: 10 });
const NOODLE = DEFAULT_NOODLE_PRESETS[0].noodleType;
const BOIL_MS = DEFAULT_NOODLE_PRESETS[0].boilSeconds.normal * 1000;

function item(
  externalOrderId: string,
  itemIndex = 0,
  arrivalTime: number = NOW - MINUTE,
): OrderItem {
  return {
    externalOrderId,
    itemIndex,
    noodleType: NOODLE,
    firmness: "normal",
    tableId: "t-1",
    arrivalTime,
    slotSpan: 1,
    itemName: "かけ",
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
  };
}

const A = item("o-a");
const B = item("o-b");

function at(minutes: number): EpochMillis {
  return (NOW + minutes * MINUTE) as EpochMillis;
}

/** 遷移を踏み、拒否なら throw（場面の前提違反を隠さない）。 */
function step(state: TimerState, event: Event): { state: TimerState; effects: readonly Effect[] } {
  const outcome = decide(state, event, PARAMS);
  if (!outcome.ok) throw new Error(`rejected ${event.type}: ${outcome.rejection.code}`);
  return outcome;
}

function startOf(
  target: OrderItem,
  slot: string,
  now: EpochMillis,
  id = `t-${target.externalOrderId}`,
): Event {
  return {
    type: "StartOrderItem",
    slotIds: [slot],
    externalOrderId: target.externalOrderId,
    itemIndex: target.itemIndex,
    newTimerId: id as TimerId,
    now,
  };
}

function itemOf(state: TimerState, target: OrderItem): OrderItem {
  const found = state.orderItems.find(
    (each) =>
      each.externalOrderId === target.externalOrderId && each.itemIndex === target.itemIndex,
  );
  if (found === undefined) throw new Error(`品目が無い: ${target.externalOrderId}`);
  return found;
}

function snapshotOf(effects: readonly Effect[]) {
  const broadcast = effects.find((effect) => effect.type === "Broadcast");
  if (broadcast?.type !== "Broadcast" || broadcast.message.type !== "snapshot") {
    throw new Error("snapshot が無い");
  }
  return broadcast.message;
}

function requestOf(effects: readonly Effect[]) {
  const request = effects.find((effect) => effect.type === "RequestPlan");
  return request?.type === "RequestPlan" ? request : null;
}

describe("complete — 参照先に completedAt を記録する（AC 1.3・性質 7.4）", () => {
  const started = step({ ...EMPTY_STATE, orderItems: [A, B] }, startOf(A, "0", NOW));

  it("Timer を除き、参照していた品目に completedAt = now を書く。他の品目と arrivalTime は不変", () => {
    // 走行中でも受ける（早め上げ・boiled を検査しない）——茹で時間の途中で完了する。
    const early = (NOW + 10_000) as EpochMillis;
    expect(early < NOW + BOIL_MS).toBe(true);
    const done = step(started.state, { type: "Complete", timerId: "t-o-a" as TimerId, now: early });
    expect(done.state.timers).toEqual([]);
    expect(itemOf(done.state, A)).toEqual({ ...A, completedAt: early });
    expect(itemOf(done.state, B)).toBe(B);
    expect(itemStatusOf(itemOf(done.state, A), done.state.timers)).toBe("done");
  });

  it("done の品目は計画・左レール（pendingOrders）から消え、期限内なら snapshot には載る（AC 3.4・4.2）", () => {
    const done = step(started.state, { type: "Complete", timerId: "t-o-a" as TimerId, now: at(9) });
    expect(pendingOrders(done.state.orderItems, done.state.timers, at(9))).toEqual([B]);
    const snapshot = snapshotOf(done.effects);
    expect(snapshot.orderItems).toEqual([{ ...A, completedAt: at(9) }, B]);
    expect(snapshot.recommendations.map((each) => each.externalOrderId)).toEqual(["o-b"]);
  });

  it("参照先の無い Timer（アドホック開始）の complete は品目に何も書かない（判断 13）", () => {
    const adHoc = step(
      { ...EMPTY_STATE, orderItems: [A] },
      {
        type: "Start",
        slotIds: ["1"],
        noodleType: NOODLE,
        boilSeconds: 60,
        newTimerId: "t-adhoc" as TimerId,
        now: NOW,
      },
    );
    const done = step(adHoc.state, { type: "Complete", timerId: "t-adhoc" as TimerId, now: at(1) });
    expect(done.state.orderItems).toBe(adHoc.state.orderItems);
    expect(itemOf(done.state, A).completedAt).toBeNull();
  });
});

describe("cancel — 参照先に interruptedAt を記録し、品目は未調理へ戻る（AC 1.4・性質 7.3）", () => {
  const started = step({ ...EMPTY_STATE, orderItems: [A, B] }, startOf(A, "0", NOW));

  it("Timer を除き、参照していた品目に interruptedAt = now を書く。completedAt と arrivalTime は書かない", () => {
    const cancelled = step(started.state, {
      type: "Cancel",
      timerId: "t-o-a" as TimerId,
      now: at(2),
    });
    expect(cancelled.state.timers).toEqual([]);
    expect(itemOf(cancelled.state, A)).toEqual({ ...A, interruptedAt: at(2) });
    expect(itemStatusOf(itemOf(cancelled.state, A), cancelled.state.timers)).toBe("unstarted");
    // 期限内なので左レールと計画に再び現れる（性質 7.3）。
    expect(pendingOrders(cancelled.state.orderItems, cancelled.state.timers, at(2))).toEqual([
      { ...A, interruptedAt: at(2) },
      B,
    ]);
    expect(
      snapshotOf(cancelled.effects).recommendations.map((each) => each.externalOrderId),
    ).toEqual(["o-a", "o-b"]);
  });

  it("期限は戻さない（判断 6）——期限外の品目は unstarted に戻っても左レールと計画に現れない", () => {
    const old = item("o-old", 0, NOW - ORDER_LIFETIME_MS + 5 * MINUTE);
    const begun = step({ ...EMPTY_STATE, orderItems: [old] }, startOf(old, "0", NOW));
    const cancelled = step(begun.state, {
      type: "Cancel",
      timerId: "t-o-old" as TimerId,
      now: at(6),
    });
    expect(itemOf(cancelled.state, old).arrivalTime).toBe(old.arrivalTime);
    expect(itemStatusOf(itemOf(cancelled.state, old), cancelled.state.timers)).toBe("unstarted");
    expect(pendingOrders(cancelled.state.orderItems, cancelled.state.timers, at(6))).toEqual([]);
    expect(snapshotOf(cancelled.effects).orderItems).toEqual([]);
  });

  it("参照先の無い Timer（アドホック開始）の cancel は品目に何も書かない", () => {
    const adHoc = step(
      { ...EMPTY_STATE, orderItems: [A] },
      {
        type: "Start",
        slotIds: ["1"],
        noodleType: NOODLE,
        boilSeconds: 60,
        newTimerId: "t-adhoc" as TimerId,
        now: NOW,
      },
    );
    const cancelled = step(adHoc.state, {
      type: "Cancel",
      timerId: "t-adhoc" as TimerId,
      now: at(1),
    });
    expect(cancelled.state.orderItems).toBe(adHoc.state.orderItems);
  });
});

describe("系列：開始 → Cancel → 再開始 → 完了で cooking → unstarted → cooking → done（性質 7.3′・7.6）", () => {
  it("状態が順に動き、interruptedAt は再開始・完了でも保たれ、次の Cancel でだけ上書きされる", () => {
    const s1 = step({ ...EMPTY_STATE, orderItems: [A] }, startOf(A, "0", NOW));
    expect(itemStatusOf(itemOf(s1.state, A), s1.state.timers)).toBe("cooking");

    const s2 = step(s1.state, { type: "Cancel", timerId: "t-o-a" as TimerId, now: at(1) });
    expect(itemStatusOf(itemOf(s2.state, A), s2.state.timers)).toBe("unstarted");
    expect(itemOf(s2.state, A).interruptedAt).toBe(at(1));

    const s3 = step(s2.state, startOf(A, "2", at(2), "t-o-a-2"));
    expect(itemStatusOf(itemOf(s3.state, A), s3.state.timers)).toBe("cooking");
    expect(itemOf(s3.state, A).interruptedAt).toBe(at(1));
    // 左レールと計画は同じ集合を見る——調理中の A は要求にも推奨にも無い。
    expect(requestOf(s3.effects)).toBeNull();
    expect(snapshotOf(s3.effects).recommendations).toEqual([]);

    const s4 = step(s3.state, { type: "Cancel", timerId: "t-o-a-2" as TimerId, now: at(3) });
    expect(itemOf(s4.state, A).interruptedAt).toBe(at(3));

    const s5 = step(s4.state, startOf(A, "2", at(4), "t-o-a-3"));
    const s6 = step(s5.state, { type: "Complete", timerId: "t-o-a-3" as TimerId, now: at(5) });
    expect(itemOf(s6.state, A)).toEqual({ ...A, interruptedAt: at(3), completedAt: at(5) });
    expect(itemStatusOf(itemOf(s6.state, A), s6.state.timers)).toBe("done");
    // done への開始は拒否される（未調理に無い）。
    const again = decide(s6.state, startOf(A, "0", at(6), "t-o-a-4"), PARAMS);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.rejection.code).toBe("OrderItemNotFound");
  });
});

describe("一括完了は client が Timer ごとに complete を送る——各品目に completedAt が記録される", () => {
  it("2 本の Timer を順に complete すると、参照していた 2 品目がそれぞれの now で done になる", () => {
    const s1 = step({ ...EMPTY_STATE, orderItems: [A, B] }, startOf(A, "0", NOW));
    const s2 = step(s1.state, startOf(B, "1", NOW));
    const s3 = step(s2.state, { type: "AlarmFired", now: (NOW + BOIL_MS) as EpochMillis });
    expect(s3.state.timers.every((timer) => timer.boiledAt !== null)).toBe(true);
    // boiled の間も cooking（時間が来ただけでは done にならない）。
    expect(itemStatusOf(itemOf(s3.state, A), s3.state.timers)).toBe("cooking");
    const s4 = step(s3.state, { type: "Complete", timerId: "t-o-a" as TimerId, now: at(11) });
    const s5 = step(s4.state, { type: "Complete", timerId: "t-o-b" as TimerId, now: at(11) });
    expect(s5.state.timers).toEqual([]);
    expect(s5.state.orderItems.map((each) => each.completedAt)).toEqual([at(11), at(11)]);
  });
});

describe("読む側の入口——snapshot は期限内 ∨ 参照先、要求・推奨・指紋は未調理（AC 4.1 / 4.2 / 4.3・性質 7.7）", () => {
  it("注文から 1 時間 59 分で開始し 2 時間 1 分に snapshot を送っても、Timer が残る間は品目が載る", () => {
    const arrived = NOW;
    const late = item("o-late", 0, arrived);
    const startedAt = (arrived + 119 * MINUTE) as EpochMillis;
    const snapshotAt = (arrived + 121 * MINUTE) as EpochMillis;
    const started = step({ ...EMPTY_STATE, orderItems: [late] }, startOf(late, "0", startedAt));
    const hydrated = toWireSnapshot(started.state, PARAMS, snapshotAt);
    if (hydrated.type !== "snapshot") throw new Error("snapshot でない");
    expect(hydrated.orderItems).toEqual([late]);
    expect(hydrated.orderItems).toEqual(
      orderItemsToBroadcast(started.state.orderItems, started.state.timers, snapshotAt),
    );
    expect(hydrated.recommendations).toEqual([]);
    // Complete で Timer が消えれば（done・期限切れ）載らない。
    const done = step(started.state, {
      type: "Complete",
      timerId: "t-o-late" as TimerId,
      now: snapshotAt,
    });
    expect(snapshotOf(done.effects).orderItems).toEqual([]);
  });

  it("RequestPlan.pending と推奨は未調理の品目だけを運び、調理中の品目は指紋にも現れない", () => {
    const arrival = step(
      { ...EMPTY_STATE },
      { type: "OrderArrived", arrival: nonEmpty([A, B]), now: NOW },
    );
    expect(requestOf(arrival.effects)?.pending).toEqual([A, B]);
    const started = step(arrival.state, startOf(A, "0", at(1)));
    const request = requestOf(started.effects);
    expect(request?.pending).toEqual([B]);
    expect(request?.running.map((timer) => timer.orderItem?.externalOrderId)).toEqual(["o-a"]);
    expect(snapshotOf(started.effects).recommendations.map((each) => each.externalOrderId)).toEqual(
      ["o-b"],
    );
    // 指紋：調理中の A を含む正本と、A の無い正本は同じ指紋（計画対象が同じ）。
    expect(digestInput(started.state.orderItems, started.state.timers, PARAMS, at(1))).toBe(
      digestInput([B], started.state.timers, PARAMS, at(1)),
    );
  });
});

describe("移行例外——v12 由来で参照先の無い Timer（Requirement 6.2・性質 7.9 / 7.9′）", () => {
  /** v12 の永続から来た走行中 Timer。旧実装が開始時に品目を消費したので、参照先は正本に無い。 */
  const orphan = createTimer({
    id: "t-v12" as TimerId,
    slotIds: nonEmpty(["0" as SlotId]),
    noodleType: NOODLE as NoodleType,
    firmness: "normal",
    startTime: (NOW - 2 * MINUTE) as EpochMillis,
    endTime: (NOW + 8 * MINUTE) as EpochMillis,
    seq: 0,
    orderItem: { externalOrderId: "o-v12", itemIndex: 0, tableId: "t-1" },
  });
  const migrated: TimerState = { ...EMPTY_STATE, timers: [orphan], nextSeq: 1, orderItems: [B] };

  it("参照先の無い Timer はそのまま動く（発火・完了）。完了しても存在しない品目に completedAt は書かれない", () => {
    const fired = step(migrated, { type: "AlarmFired", now: at(8) });
    expect(fired.state.timers[0]!.boiledAt).toBe(at(8));
    const done = step(fired.state, { type: "Complete", timerId: "t-v12" as TimerId, now: at(9) });
    expect(done.state.timers).toEqual([]);
    expect(done.state.orderItems).toBe(migrated.orderItems);
  });

  it("参照先の無い Timer を Cancel しても注文品目は戻らない（限界の明示）", () => {
    const cancelled = step(migrated, { type: "Cancel", timerId: "t-v12" as TimerId, now: at(1) });
    expect(cancelled.state.timers).toEqual([]);
    expect(cancelled.state.orderItems).toBe(migrated.orderItems);
    expect(pendingOrders(cancelled.state.orderItems, [], at(1))).toEqual([B]);
  });

  it("POS が再送して参照先が補われれば cooking として加わり、以後の Complete / Cancel は通常どおり記録する", () => {
    const resent = item("o-v12", 0, at(1));
    const supplied = step(migrated, {
      type: "OrderArrived",
      arrival: nonEmpty([resent]),
      now: at(1),
    });
    expect(itemStatusOf(itemOf(supplied.state, resent), supplied.state.timers)).toBe("cooking");
    // 推測による復元ではない——実際の入力が正本に品目を置き、Timer の参照がそれを指す。
    expect(snapshotOf(supplied.effects).orderItems).toEqual([B, resent]);
    expect(requestOf(supplied.effects)?.pending).toEqual([B]);

    const done = step(supplied.state, {
      type: "Complete",
      timerId: "t-v12" as TimerId,
      now: at(9),
    });
    expect(itemOf(done.state, resent).completedAt).toBe(at(9));

    const cancelled = step(supplied.state, {
      type: "Cancel",
      timerId: "t-v12" as TimerId,
      now: at(2),
    });
    expect(itemOf(cancelled.state, resent).interruptedAt).toBe(at(2));
    expect(itemStatusOf(itemOf(cancelled.state, resent), cancelled.state.timers)).toBe("unstarted");
  });
});

// 横断（design Testing Strategy・性質 7.6）：engine の遷移と client の左レールを同じ場面で踏む。開始 → Cancel → 再開始 →
// 完了の系列で状態が cooking → unstarted → cooking → done と動き、各遷移の snapshot から client が並べる左レール（ラジアルの
// 帯も同じ入口 orderQueueEntries を読む）と、engine の計画対象（pendingOrders・RequestPlan.pending）が同じ集合を見る。
describe("横断：開始 → Cancel → 再開始 → 完了で左レールと計画が同じ未調理の集合を見る（性質 7.6）", () => {
  const kitchen = kitchenOf({
    unitCount: 1,
    arms: 2,
    toleranceRatio: 10,
    presets: nonEmpty([{ noodleType: "Thin", boilSeconds: every(60) }]),
  });
  const X = sceneOrder("o-x", { noodleType: "Thin", tableId: "t-1" });
  const Y = sceneOrder("o-y", { noodleType: "Thin", tableId: "t-2", arrivalTime: T0 + 1 });
  const initial: TimerState = { ...EMPTY_STATE, orderItems: [X, Y] };

  function sceneAt(seconds: number): EpochMillis {
    return (T0 + seconds * 1000) as EpochMillis;
  }

  /** client の左レール（担当ユニット 0・受信時刻＝serverTime ゆえ補正なし）が並べる品目の鍵。 */
  function railOf(snapshot: Snapshot): readonly string[] {
    return orderQueueEntries(viewOf(kitchen, snapshot), [0], snapshot.serverTime).map((entry) =>
      itemKeyOf(entry.order),
    );
  }

  /** engine の計画対象（未調理）の鍵。 */
  function plannedOf(state: TimerState, now: EpochMillis): readonly string[] {
    return pendingOrders(state.orderItems, state.timers, now).map(itemKeyOf);
  }

  it("cooking → unstarted → cooking → done の各段で、左レール＝pendingOrders＝要求の pending（要求が出た段）", () => {
    const statusOf = (state: TimerState) => itemStatusOf(itemOf(state, X), state.timers);
    const s1 = sceneStep(kitchen, initial, startItem(X, ["0"], sceneAt(10)));
    expect(statusOf(s1.state)).toBe("cooking");
    expect(railOf(s1.snapshot)).toEqual([itemKeyOf(Y)]);
    expect(plannedOf(s1.state, s1.now)).toEqual(railOf(s1.snapshot));
    // 開始の snapshot は調理中の X も運ぶ（釜のカードが参照で引く・AC 4.2）。レールには出ない。
    expect(s1.snapshot.orderItems.map(itemKeyOf)).toEqual([X, Y].map(itemKeyOf));
    expect(s1.snapshot.timers[0]?.orderItem).toEqual({ externalOrderId: "o-x", itemIndex: 0 });

    const cancel: Event = { type: "Cancel", timerId: timerIdOf(X), now: sceneAt(20) };
    const outcome2 = decide(s1.state, cancel, kitchen.params);
    expect(outcome2.ok).toBe(true);
    if (!outcome2.ok) return;
    const s2 = sceneStep(kitchen, s1.state, cancel);
    expect(statusOf(s2.state)).toBe("unstarted");
    expect(itemOf(s2.state, X).interruptedAt).toBe(sceneAt(20));
    // 戻った X は到着順で Y の前に並び、計画対象にも戻る。要求（RequestPlan）の pending も同じ集合。
    expect(railOf(s2.snapshot)).toEqual([X, Y].map(itemKeyOf));
    expect(plannedOf(s2.state, s2.now)).toEqual(railOf(s2.snapshot));
    const request = requestOf(outcome2.effects);
    expect(request).not.toBeNull();
    expect(request?.pending.map(itemKeyOf)).toEqual(railOf(s2.snapshot));

    const s3 = sceneStep(kitchen, s2.state, {
      type: "StartOrderItem",
      slotIds: ["1"],
      externalOrderId: X.externalOrderId,
      itemIndex: X.itemIndex,
      newTimerId: "timer-o-x-again" as TimerId,
      now: sceneAt(30),
    });
    expect(statusOf(s3.state)).toBe("cooking");
    expect(itemOf(s3.state, X).interruptedAt).toBe(sceneAt(20));
    expect(railOf(s3.snapshot)).toEqual([itemKeyOf(Y)]);
    expect(plannedOf(s3.state, s3.now)).toEqual(railOf(s3.snapshot));

    const s4 = sceneStep(kitchen, s3.state, {
      type: "Complete",
      timerId: "timer-o-x-again" as TimerId,
      now: sceneAt(50),
    });
    expect(statusOf(s4.state)).toBe("done");
    expect(itemOf(s4.state, X).completedAt).toBe(sceneAt(50));
    // done の X は期限内ゆえ snapshot には載るが、レールにも計画にも無い。
    expect(s4.snapshot.orderItems.map(itemKeyOf)).toEqual([X, Y].map(itemKeyOf));
    expect(railOf(s4.snapshot)).toEqual([itemKeyOf(Y)]);
    expect(plannedOf(s4.state, s4.now)).toEqual(railOf(s4.snapshot));
  });
});
