// domain/order の toPendingOrders が「到着の内容が不正なら全体を拒否する」ことを固定する（要件1.4）。
//
// 部分受理は現場が欠品に気づけない嘘になるため、1 品目でも不正なら null へ落ちる。逆に妥当な到着は
// 余剰フィールドを落とし、卓なし（tableId 欠落）を単独グループ（null）へ正規化して通る。
// slotSpan は欠落のみ 1 スロット占有へ畳み、値域外・非整数は他の型違反と同じく到着全体の拒否へ落ちる。
// 受理拒否（400）への写しは shell の受け口の関心事ゆえ、ここでは null か否かだけを見る。

import { describe, it, expect } from "vitest";
import { toPendingOrders } from "../../src/domain/order";
import { DEFAULT_NOODLE_PRESETS, SLOT_SPAN_MAX, SLOT_SPAN_MIN } from "../../src/domain/store";

const presets = DEFAULT_NOODLE_PRESETS;
const arrivalTime = 1_700_000_000_000;

/** 妥当な 1 品目の生値（各テストがこの一箇所だけを崩して不正を作る）。 */
const validItem = {
  externalOrderId: "order-7",
  itemIndex: 0,
  noodleType: "Thin",
  firmness: "hard",
  tableId: "table-3",
  // 既定（1）と異なる幅を据える——既定と同値では「持たせている」ことと「畳んでいる」ことが見分けられない。
  slotSpan: 2,
  itemName: null,
  sizeName: null,
} as const;

describe("toPendingOrders — 正常値の正規化", () => {
  it("妥当な到着を PendingOrder 列へ写し、受理時刻を arrivalTime に据える", () => {
    expect(toPendingOrders([validItem], presets, arrivalTime)).toEqual([
      {
        externalOrderId: "order-7",
        itemIndex: 0,
        noodleType: "Thin",
        firmness: "hard",
        tableId: "table-3",
        arrivalTime,
        slotSpan: 2,
        itemName: null,
        sizeName: null,
      },
    ]);
  });

  it("slotSpan の欠落を 1 スロット占有へ畳む（麺量の語彙を持たない到着）", () => {
    const withoutSpan: Record<string, unknown> = { ...validItem };
    delete withoutSpan.slotSpan;

    expect(toPendingOrders([withoutSpan], presets, arrivalTime)?.[0]?.slotSpan).toBe(1);
  });

  it("slotSpan の値域の境界（SLOT_SPAN_MIN・SLOT_SPAN_MAX）を通す", () => {
    const bounds = [SLOT_SPAN_MIN, SLOT_SPAN_MAX];

    const orders = toPendingOrders(
      bounds.map((slotSpan, itemIndex) => ({ ...validItem, itemIndex, slotSpan })),
      presets,
      arrivalTime,
    );

    expect(orders?.map((order) => order.slotSpan)).toEqual(bounds);
  });

  it("tableId の欠落・null を単独グループ（null）へ正規化する", () => {
    const withoutTable = { ...validItem, tableId: undefined };
    const explicitNull = { ...validItem, itemIndex: 1, tableId: null };

    const orders = toPendingOrders([withoutTable, explicitNull], presets, arrivalTime);

    expect(orders?.map((order) => order.tableId)).toEqual([null, null]);
  });

  it("余剰フィールドと生値の arrivalTime 主張を落とす（起点は受け手側の事実）", () => {
    const noisy = { ...validItem, boilSeconds: 999, arrivalTime: 1, note: "extra" };

    const orders = toPendingOrders([noisy], presets, arrivalTime);

    expect(orders?.[0]).toEqual({ ...validItem, arrivalTime });
  });
});

describe("toPendingOrders — 不正な到着は全体を拒否する", () => {
  it("配列でない生値・空配列を拒否する", () => {
    expect(toPendingOrders(validItem, presets, arrivalTime)).toBeNull();
    expect(toPendingOrders(null, presets, arrivalTime)).toBeNull();
    expect(toPendingOrders([], presets, arrivalTime)).toBeNull();
  });

  it("必須属性の欠落を拒否する", () => {
    for (const missing of ["externalOrderId", "itemIndex", "noodleType", "firmness"] as const) {
      const item: Record<string, unknown> = { ...validItem };
      delete item[missing];

      expect(toPendingOrders([item], presets, arrivalTime), `${missing} の欠落が通った`).toBeNull();
    }
  });

  it("未知の品目種別を拒否する", () => {
    expect(
      toPendingOrders([{ ...validItem, noodleType: "Udon" }], presets, arrivalTime),
    ).toBeNull();
    expect(toPendingOrders([{ ...validItem, noodleType: "" }], presets, arrivalTime)).toBeNull();
  });

  it("型違反を拒否する", () => {
    const violations: readonly Record<string, unknown>[] = [
      { ...validItem, externalOrderId: 7 },
      { ...validItem, externalOrderId: "" },
      { ...validItem, itemIndex: "0" },
      { ...validItem, itemIndex: 1.5 },
      { ...validItem, itemIndex: -1 },
      { ...validItem, itemIndex: Number.NaN },
      { ...validItem, noodleType: 1 },
      { ...validItem, firmness: "veryHard" },
      { ...validItem, tableId: 3 },
      { ...validItem, tableId: "" },
      // 値域外はクランプせず拒否する（勝手に寄せれば、要求されていない占有幅を作ってしまう）。
      { ...validItem, slotSpan: SLOT_SPAN_MIN - 1 },
      { ...validItem, slotSpan: SLOT_SPAN_MAX + 1 },
      { ...validItem, slotSpan: -1 },
      { ...validItem, slotSpan: 1.5 },
      { ...validItem, slotSpan: "1" },
      { ...validItem, slotSpan: null },
      { ...validItem, slotSpan: Number.NaN },
    ];

    for (const item of violations) {
      expect(
        toPendingOrders([item], presets, arrivalTime),
        `${JSON.stringify(item)} が通った`,
      ).toBeNull();
    }
  });

  it("妥当な品目に 1 件の不正が混ざれば到着全体を拒否する（部分受理をしない）", () => {
    const arrival = [validItem, { ...validItem, itemIndex: 1, firmness: "veryHard" }];

    expect(toPendingOrders(arrival, presets, arrivalTime)).toBeNull();
  });
});
