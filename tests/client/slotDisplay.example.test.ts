// tests/client/slotDisplay.example.test.ts — 釜のカードが品目を引く口（order-lifecycle AC 4.6・Requirement 5.2）。
//
// **Validates: Requirements 4.6, 5.2**
// Feature: lift-order-numbering — running は `liftOrder`（店舗全体の上がり順・担当外の Timer が押し上げる）を持ち、
// boiled は持たない（**Validates: lift-order-numbering Requirements 1.2, 1.3, 1.5, 3.4, 3.5**）。
//
// running / boiled の SlotDisplay は `orderItem`＝`orderItemOf(timer, view.orderItems)` を持つ。参照が null（アドホック
// 開始）でも、参照先が集合に無くても（v12 由来・判断 14）null で、呼び手は「注文なし」と同じ経路を通る（判断 13）。
// 何を出すか（番号・卓・品名・中断の色分け）は lift-order-numbering の関心事で、ここでは引けることだけを固定する。

import { describe, expect, it } from "vitest";
import { EMPTY_VIEW, type ClientTimer, type ClientView } from "../../src/client/connection";
import { assignedSlotDisplays } from "../../src/client/components/slotDisplay";
import type { OrderItem } from "../../src/domain/order";
import { liftOrderLabel } from "../../src/domain/lift-order";

const NOW = 1_700_000_000_000;

const ITEM: OrderItem = {
  externalOrderId: "o-1",
  itemIndex: 1,
  noodleType: "Thin",
  firmness: "normal",
  tableId: "12",
  arrivalTime: NOW - 60_000,
  portions: 1,
  itemName: "かけ",
  sizeName: null,
  completedAt: null,
  interruptedAt: null,
  tableAssignedAt: null,
};

function timer(
  overrides: Partial<ClientTimer> & {
    readonly id: string;
    readonly slotIds: ClientTimer["slotIds"];
  },
): ClientTimer {
  return {
    noodleType: "Thin",
    firmness: "normal",
    startTime: NOW - 30_000,
    endTime: NOW + 30_000,
    orderItem: null,
    origin: "server",
    ...overrides,
  };
}

const VIEW: ClientView = {
  ...EMPTY_VIEW,
  connectivity: "up",
  sync: "synced",
  orderItems: [ITEM],
  timers: [
    // 釜 0：ITEM を指す走行中。
    timer({
      id: "running-ref",
      slotIds: ["0"],
      orderItem: { externalOrderId: "o-1", itemIndex: 1 },
    }),
    // 釜 1：ITEM を指す boiled（Complete 待ち）。
    timer({
      id: "boiled-ref",
      slotIds: ["1"],
      endTime: NOW - 1_000,
      orderItem: { externalOrderId: "o-1", itemIndex: 1 },
    }),
    // 釜 2：アドホック（参照なし）。
    timer({ id: "adhoc", slotIds: ["2"] }),
    // 釜 3：参照先が集合に無い（v12 由来・同じ注文の別の品目）。
    timer({ id: "orphan", slotIds: ["3"], orderItem: { externalOrderId: "o-1", itemIndex: 0 } }),
  ],
};

function orderItemAt(slot: number) {
  const display = assignedSlotDisplays(VIEW, [0], NOW).find((each) => each.slot === slot);
  if (display === undefined || (display.kind !== "running" && display.kind !== "boiled")) {
    throw new Error(`釜 ${slot} は running / boiled でない`);
  }
  return { kind: display.kind, orderItem: display.orderItem };
}

describe("Feature: order-lifecycle — running / boiled の SlotDisplay は orderItemOf で品目を引ける（AC 4.6）", () => {
  it("参照が集合の品目を指せば、その品目（同じ参照）が載る——走行中も boiled も", () => {
    expect(orderItemAt(0)).toEqual({ kind: "running", orderItem: ITEM });
    expect(orderItemAt(0).orderItem).toBe(ITEM);
    expect(orderItemAt(1)).toEqual({ kind: "boiled", orderItem: ITEM });
  });

  it("参照が null（アドホック）でも、参照先が集合に無くても（v12 由来）null——注文なしと同じ経路（判断 13 / 14）", () => {
    expect(orderItemAt(2)).toEqual({ kind: "running", orderItem: null });
    expect(orderItemAt(3)).toEqual({ kind: "running", orderItem: null });
  });

  it("後着で卓が変われば、次の snapshot のカードは新しい卓を引く（品目は最新の注文情報・Timer は開始時点の記録・性質 7.8）", () => {
    const moved: ClientView = { ...VIEW, orderItems: [{ ...ITEM, tableId: "7" }] };
    const display = assignedSlotDisplays(moved, [0], NOW).find((each) => each.slot === 0);
    expect(display?.kind === "running" ? display.orderItem?.tableId : null).toBe("7");
  });
});

describe("Feature: lift-order-numbering — running は店舗全体の上がり順 liftOrder を持つ（AC 1.5・性質 3.4 / 3.5）", () => {
  const OFFSET = 5_000;

  function displaysOf(view: ClientView, units: readonly number[]) {
    return assignedSlotDisplays(view, units, NOW);
  }

  /** 釜のカードが持つ上がり順を表記（`4a` の形）で読む。走行中でなければ null。 */
  function liftOrderAt(view: ClientView, units: readonly number[], slot: number): string | null {
    const display = displaysOf(view, units).find((each) => each.slot === slot);
    if (display === undefined) throw new Error(`釜 ${slot} が担当に無い`);
    return display.kind === "running" ? liftOrderLabel(display.liftOrder) : null;
  }

  it("担当外（別ユニット）の Timer が先に上がれば、担当の釜の番号は押し上げられる（担当内で振らない・判断 1）", () => {
    const view: ClientView = {
      ...VIEW,
      timers: [
        // 担当ユニット 0 の釜 0：90 秒後に上がる。
        timer({
          id: "mine",
          slotIds: ["0"],
          endTime: NOW + 90_000,
          orderItem: { externalOrderId: "o-1", itemIndex: 1 },
        }),
        // ユニット 1（担当外）の釜 6：30 秒後に上がる（先）。
        timer({
          id: "theirs",
          slotIds: ["6"],
          endTime: NOW + 30_000,
          orderItem: { externalOrderId: "o-9", itemIndex: 0 },
        }),
      ],
    };
    expect(liftOrderAt(view, [0], 0)).toBe("2a");
    // 担当を両ユニットに広げても番号は変わらない（性質 3.4）。担当外の釜は表示に現れないだけ。
    expect(liftOrderAt(view, [0, 1], 0)).toBe("2a");
    expect(liftOrderAt(view, [0, 1], 6)).toBe("1a");
    expect(displaysOf(view, [0]).some((each) => each.slot === 6)).toBe(false);
  });

  it("同じ Timer が駆動する 2 釜のカードは同じ番号（1 本として数える・性質 3.5）", () => {
    const view: ClientView = {
      ...VIEW,
      timers: [
        timer({
          id: "large",
          slotIds: ["0", "1"],
          endTime: NOW + 60_000,
          orderItem: { externalOrderId: "o-1", itemIndex: 1 },
        }),
        timer({
          id: "single",
          slotIds: ["2"],
          endTime: NOW + 90_000,
          orderItem: { externalOrderId: "o-2", itemIndex: 0 },
        }),
      ],
    };
    expect(liftOrderAt(view, [0], 0)).toBe("1a");
    expect(liftOrderAt(view, [0], 1)).toBe("1a");
    expect(liftOrderAt(view, [0], 2)).toBe("2a");
  });

  it("boiled は上がり順を持たず、走行中だけが 1 から詰めて振られる。枝は Timer の参照する注文（参照先が集合に無くても同じ注文なら同じ枝）（判断 2・3）", () => {
    // VIEW：釜 0 走行中（o-1 の品目 1）・釜 1 boiled・釜 2 アドホック走行中・釜 3 参照先なし走行中（o-1 の品目 0・v12 由来）。
    // すべて同じ endTime＝同じクラスタ。釜 0 と釜 3 は同じ注文 o-1 を指すので同じ枝（品目が集合に無いことは枝に効かない）。
    // 釜 2 のアドホックは 1 本で 1 つの枝なので、同じクラスタの中で枝が分かれる（1a と 1b）。
    const displays = displaysOf(VIEW, [0]);
    const boiled = displays.find((each) => each.slot === 1);
    expect(boiled?.kind).toBe("boiled");
    expect(boiled !== undefined && "liftOrder" in boiled).toBe(false);
    const [slot0, slot2, slot3] = [0, 2, 3].map((slot) => liftOrderAt(VIEW, [0], slot));
    expect(slot0).toBe(slot3);
    expect(new Set([slot0, slot2])).toEqual(new Set(["1a", "1b"]));
  });

  it("走行中の判定と番号の対象は同じ線（補正後現在時刻）——offset を足せば上がっている Timer は番号から外れ、残りが繰り上がる", () => {
    const view: ClientView = {
      ...VIEW,
      offset: OFFSET,
      timers: [
        // ローカル時計では走行中に見えるが、補正後（NOW + OFFSET）では上がっている。
        timer({
          id: "edge",
          slotIds: ["0"],
          endTime: NOW + OFFSET,
          orderItem: { externalOrderId: "o-1", itemIndex: 1 },
        }),
        timer({
          id: "next",
          slotIds: ["1"],
          endTime: NOW + OFFSET + 1,
          orderItem: { externalOrderId: "o-2", itemIndex: 0 },
        }),
      ],
    };
    expect(liftOrderAt(view, [0], 0)).toBeNull();
    expect(liftOrderAt(view, [0], 1)).toBe("1a");
  });

  it("未確定（provisional・origin local）の Timer も同じ規則で数える（best effort・判断 6）", () => {
    const view: ClientView = {
      ...VIEW,
      timers: [
        timer({ id: "local", slotIds: ["0"], endTime: NOW + 30_000, origin: "local" }),
        timer({
          id: "server",
          slotIds: ["1"],
          endTime: NOW + 60_000,
          orderItem: { externalOrderId: "o-1", itemIndex: 1 },
        }),
      ],
    };
    expect(liftOrderAt(view, [0], 0)).toBe("1a");
    expect(liftOrderAt(view, [0], 1)).toBe("2a");
  });
});
