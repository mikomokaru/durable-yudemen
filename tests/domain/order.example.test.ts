// Feature: pending-order-expiry, Component 1 / **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
// Feature: order-lifecycle, Component 1 / **Validates: Requirements 1.2, 1.7, 3.1, 3.2, 7.1, 7.3′**
//
// tests/domain/order.example.test.ts — 生きている待ち行列（Live_Orders）の境界と、品目の状態の導出を名指しで固定する。
//
// 期限は状態を書き換える出来事ではなく、`now` から導く述語である。ここで固定するのは線そのもの——半開区間の境界
// （ちょうど寿命は含まない・1 ms 手前は含む）、並びを保つこと、入力を変えないこと、全件が期限内なら同じ配列を
// 返すこと（client の参照同値による再描画の抑制を壊さない）——で、どこがこの述語を呼ぶかは engine / client の側の主張。
//
// 状態（unstarted / cooking / done）も保存せず導く（order-lifecycle 判断 1）。ここで固定するのは導出の順（生きた Timer が
// 在れば cooking・boiled も含む・無く completedAt が在れば done）、中断（interruptedAt）が状態に効かないこと（判断 3′）、
// そして読む集合が二つに分かれること——計画と左レールは「期限内 ∧ unstarted」、snapshot は「期限内 ∨ 参照先」（判断 5）。

import { describe, expect, it } from "vitest";
import {
  isLive,
  itemStatusOf,
  liveOrders,
  orderItemOf,
  orderItemsToBroadcast,
  ORDER_LIFETIME_MS,
  pendingOrders,
  refersTo,
  type OrderItem,
} from "../../src/domain/order";
import { createTimer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { nonEmpty } from "../nonEmpty";

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function order(externalOrderId: string, arrivalTime: number): OrderItem {
  return {
    externalOrderId,
    itemIndex: 0,
    noodleType: "Thin",
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

/** 品目を指す（または指さない）Timer。domain の導出は参照だけを読むので、参照を持つものを構造で組む。 */
function timerFor(item: OrderItem | null): { readonly orderItem: OrderItem | null } {
  return { orderItem: item === null ? null : { ...item } };
}

describe("ORDER_LIFETIME_MS — 注文の寿命は 2 時間の定数（AC 1.3）", () => {
  it("2 時間（ミリ秒）である", () => {
    expect(ORDER_LIFETIME_MS).toBe(2 * HOUR);
  });
});

describe("liveOrders — 半開区間の境界（AC 1.4）", () => {
  it("arrivalTime + 寿命 がちょうど now の品目は含まない", () => {
    const boundary = order("o-boundary", NOW - ORDER_LIFETIME_MS);
    expect(liveOrders([boundary], NOW)).toEqual([]);
  });

  it("arrivalTime + 寿命 が now の 1 ms 後の品目は含む", () => {
    const justInside = order("o-inside", NOW - ORDER_LIFETIME_MS + 1);
    expect(liveOrders([justInside], NOW)).toEqual([justInside]);
  });

  it("同じ品目でも now が 1 ms 進めば切れる（境界の 1 ms を二度定義しない）", () => {
    const item = order("o-1", NOW - ORDER_LIFETIME_MS + 1);
    expect(liveOrders([item], NOW)).toEqual([item]);
    expect(liveOrders([item], NOW + 1)).toEqual([]);
  });

  it("arrivalTime が now より未来（上流の時計が進んでいる）なら期限内として扱う", () => {
    const future = order("o-future", NOW + 5 * 60_000);
    expect(liveOrders([future], NOW)).toEqual([future]);
  });
});

describe("liveOrders — 並びと入力（AC 1.1）", () => {
  const expiredA = order("o-a", NOW - 3 * HOUR);
  const liveB = order("o-b", NOW - 90 * 60_000);
  const expiredC = order("o-c", NOW - ORDER_LIFETIME_MS);
  const liveD = order("o-d", NOW - 1);
  const liveE = order("o-e", NOW);

  it("期限内の品目だけを、入力の並びのまま返す（並び替えない）", () => {
    // 到着順ではない並びを渡しても、残る品目の相対順序はそのまま。
    expect(liveOrders([liveD, expiredA, liveB, expiredC, liveE], NOW)).toEqual([
      liveD,
      liveB,
      liveE,
    ]);
  });

  it("入力の配列を変えない", () => {
    const input = [expiredA, liveB, expiredC];
    const before = [...input];
    liveOrders(input, NOW);
    expect(input).toEqual(before);
  });

  it("全件が期限内なら入力と同じ配列を返す（新しい配列を作らない）", () => {
    const input = [liveB, liveD, liveE];
    expect(liveOrders(input, NOW)).toBe(input);
  });

  it("空の待ち行列は空のまま（同じ参照）", () => {
    const empty: readonly OrderItem[] = [];
    expect(liveOrders(empty, NOW)).toBe(empty);
  });

  it("全件が期限切れなら空", () => {
    expect(liveOrders([expiredA, expiredC], NOW)).toEqual([]);
  });

  it("1 件でも切れれば新しい配列で、切れた品目だけが欠ける", () => {
    const input = [liveB, expiredA];
    const result = liveOrders(input, NOW);
    expect(result).not.toBe(input);
    expect(result).toEqual([liveB]);
  });
});

describe("liveOrders — now と pending だけに依存する（AC 1.2）", () => {
  it("同じ入力からは同じ結果が出る（決定的）", () => {
    const input = [order("o-1", NOW - 3 * HOUR), order("o-2", NOW - 60_000)];
    expect(liveOrders(input, NOW)).toEqual(liveOrders(input, NOW));
  });

  it("判定は arrivalTime だけで、麺種・卓・幅・名前には依らない", () => {
    const expired: OrderItem = {
      ...order("o-x", NOW - 3 * HOUR),
      noodleType: "Thick",
      tableId: null,
      slotSpan: 2,
      itemName: "特盛",
      sizeName: "大",
      completedAt: null,
      interruptedAt: null,
    };
    const live: OrderItem = { ...expired, externalOrderId: "o-y", arrivalTime: NOW - 60_000 };
    expect(liveOrders([expired, live], NOW)).toEqual([live]);
  });
});

describe("Feature: order-lifecycle — itemStatusOf は状態の正本（AC 1.2・性質 7.1）", () => {
  const item = order("o-1", NOW - MINUTE);

  it("生きた Timer が指していれば cooking、無く completedAt が在れば done、どちらも無ければ unstarted", () => {
    expect(itemStatusOf(item, [])).toBe("unstarted");
    expect(itemStatusOf(item, [timerFor(item)])).toBe("cooking");
    expect(itemStatusOf({ ...item, completedAt: NOW }, [])).toBe("done");
  });

  it("boiled（茹で上がって Complete を待つ）Timer が指す品目も cooking——時間が来ただけでは done にならない", () => {
    const boiled = createTimer({
      id: "t-boiled" as TimerId,
      slotIds: nonEmpty(["0" as SlotId]),
      noodleType: "Thin" as NoodleType,
      firmness: "normal",
      startTime: (NOW - 10 * MINUTE) as EpochMillis,
      endTime: (NOW - MINUTE) as EpochMillis,
      seq: 0,
      boiledAt: (NOW - MINUTE) as EpochMillis,
      orderItem: {
        externalOrderId: item.externalOrderId,
        itemIndex: item.itemIndex,
        tableId: "t-1",
      },
    });
    expect(itemStatusOf(item, [boiled])).toBe("cooking");
  });

  it("導出の順は Timer が先——参照する Timer が在れば completedAt が在っても cooking（第 4 の状態は作らない）", () => {
    const done = { ...item, completedAt: NOW - 30_000 };
    expect(itemStatusOf(done, [timerFor(done)])).toBe("cooking");
  });

  it("参照は externalOrderId と itemIndex の組——片方だけ一致する Timer もアドホック Timer も状態を変えない", () => {
    const sibling = { ...item, itemIndex: 1 };
    const other = { ...item, externalOrderId: "o-2" };
    expect(itemStatusOf(item, [timerFor(sibling), timerFor(other), timerFor(null)])).toBe(
      "unstarted",
    );
    expect(refersTo(timerFor(item).orderItem!, item)).toBe(true);
    expect(refersTo(timerFor(sibling).orderItem!, item)).toBe(false);
  });

  it("interruptedAt は状態に効かない（性質 7.3′）——3 つの状態のいずれでも同じ答え", () => {
    const interrupted = { ...item, interruptedAt: NOW - 5 * MINUTE };
    expect(itemStatusOf(interrupted, [])).toBe("unstarted");
    expect(itemStatusOf(interrupted, [timerFor(item)])).toBe("cooking");
    expect(itemStatusOf({ ...interrupted, completedAt: NOW }, [])).toBe("done");
  });
});

describe("Feature: order-lifecycle — pendingOrders は期限内 ∧ unstarted（AC 3.1・性質 7.6）", () => {
  const unstarted = order("o-unstarted", NOW - MINUTE);
  const cooking = order("o-cooking", NOW - 2 * MINUTE);
  const done: OrderItem = { ...order("o-done", NOW - 3 * MINUTE), completedAt: NOW - MINUTE };
  const expired = order("o-expired", NOW - ORDER_LIFETIME_MS);
  const timers = [timerFor(cooking)];

  it("cooking / done / 期限切れを除き、入力の並びのまま返す", () => {
    expect(pendingOrders([done, unstarted, cooking, expired], timers, NOW)).toEqual([unstarted]);
  });

  it("全件が通れば入力と同じ参照を返す（liveOrders と同じ理由）", () => {
    const items = [unstarted, order("o-2", NOW - 2 * MINUTE)];
    expect(pendingOrders(items, timers, NOW)).toBe(items);
    // アドホック Timer（参照なし）は何も除かない。
    expect(pendingOrders(items, [timerFor(null)], NOW)).toBe(items);
  });

  it("interruptedAt は結果を変えない（性質 7.3′）——中断された品目は期限内なら未調理として戻る", () => {
    const interrupted = { ...unstarted, interruptedAt: NOW - 30_000 };
    expect(pendingOrders([interrupted], [], NOW)).toEqual([interrupted]);
    const interruptedButExpired = { ...expired, interruptedAt: NOW - 30_000 };
    // 期限は戻さない（判断 6）——arrivalTime は中断で動かないので、期限外なら現れない。
    expect(pendingOrders([interruptedButExpired], [], NOW)).toEqual([]);
  });

  it("二度当てても冪等（planTargets が再び liveOrders を通してよい）", () => {
    const once = pendingOrders([done, unstarted, cooking, expired], timers, NOW);
    expect(pendingOrders(once, timers, NOW)).toBe(once);
    expect(liveOrders(once, NOW)).toBe(once);
  });
});

describe("Feature: order-lifecycle — orderItemsToBroadcast は期限内 ∨ 生きた Timer の参照先（AC 3.2・性質 7.7）", () => {
  /** 注文から 1 時間 59 分で 10 分茹での品目を開始し、2 時間 1 分に snapshot を送る（判断 5 の例）。 */
  const arrived = NOW;
  const startedAt = arrived + 119 * MINUTE;
  const snapshotAt = arrived + 121 * MINUTE;
  const item = order("o-late", arrived);
  const cooking = timerFor(item);

  it("期限を超えた調理中の品目は Complete まで配信され、計画と左レールには現れない", () => {
    expect(isLive(item, startedAt)).toBe(true);
    expect(isLive(item, snapshotAt)).toBe(false);
    expect(orderItemsToBroadcast([item], [cooking], snapshotAt)).toEqual([item]);
    expect(pendingOrders([item], [cooking], snapshotAt)).toEqual([]);
  });

  it("Complete で Timer が消えれば（done・期限切れ）配信から消える。未調理で期限切れも消える", () => {
    const completed = { ...item, completedAt: snapshotAt };
    expect(orderItemsToBroadcast([completed], [], snapshotAt)).toEqual([]);
    expect(orderItemsToBroadcast([item], [], snapshotAt)).toEqual([]);
  });

  it("期限内なら unstarted / cooking / done のすべてを載せる（状態は受け手が導く）", () => {
    const unstarted = order("o-unstarted", NOW - MINUTE);
    const started = order("o-cooking", NOW - 2 * MINUTE);
    const done: OrderItem = { ...order("o-done", NOW - 3 * MINUTE), completedAt: NOW };
    const items = [unstarted, started, done];
    expect(orderItemsToBroadcast(items, [timerFor(started)], NOW)).toBe(items);
    // pendingOrders はそのうち unstarted だけ——期限判定を共有することと同じ集合を読むことは別（判断 5）。
    expect(pendingOrders(items, [timerFor(started)], NOW)).toEqual([unstarted]);
  });
});

describe("Feature: order-lifecycle — orderItemOf は Timer → 品目の参照解決（AC 4.6）", () => {
  const item = order("o-1", NOW - MINUTE);
  const items = [order("o-0", NOW - 2 * MINUTE), item];

  it("参照が null（アドホック開始）なら null", () => {
    expect(orderItemOf(timerFor(null), items)).toBeNull();
  });

  it("参照先が集合に無い（v12 由来の走行中 Timer）なら null——注文なしと同じ経路", () => {
    expect(orderItemOf(timerFor(order("o-gone", NOW)), items)).toBeNull();
    expect(orderItemOf(timerFor({ ...item, itemIndex: 7 }), items)).toBeNull();
  });

  it("参照先が在ればその品目（同じ参照）。engine の Timer（tableId 付きの参照）からも引ける", () => {
    expect(orderItemOf(timerFor(item), items)).toBe(item);
    const engineTimer = createTimer({
      id: "t-1" as TimerId,
      slotIds: nonEmpty(["0" as SlotId]),
      noodleType: "Thin" as NoodleType,
      firmness: "normal",
      startTime: NOW as EpochMillis,
      endTime: (NOW + MINUTE) as EpochMillis,
      seq: 0,
      orderItem: { externalOrderId: "o-1", itemIndex: 0, tableId: "t-9" },
    });
    expect(orderItemOf(engineTimer, items)).toBe(item);
  });
});
