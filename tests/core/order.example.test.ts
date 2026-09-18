// domain/order の toOrderItems が「到着の内容が不正なら全体を拒否する」ことを固定する（要件1.4）。
//
// 部分受理は現場が欠品に気づけない嘘になるため、1 品目でも不正なら null へ落ちる。逆に妥当な到着は
// 余剰フィールドを落とし、卓なし（tableId 欠落）を単独グループ（null）へ正規化して通る。
// slotSpan は欠落のみ 1 スロット占有へ畳み、値域外・非整数は他の型違反と同じく到着全体の拒否へ落ちる。
// 受理拒否（400）への写しは shell の受け口の関心事ゆえ、ここでは null か否かだけを見る。

import { describe, it, expect } from "vitest";
import { toOrderItems } from "../../src/domain/order";
import { DEFAULT_NOODLE_PRESETS, PORTIONS_MAX, PORTIONS_MIN } from "../../src/domain/store";

const presets = DEFAULT_NOODLE_PRESETS;
const arrivalTime = 1_700_000_000_000;

/** 妥当な 1 品目の生値（各テストがこの一箇所だけを崩して不正を作る）。 */
const validItem = {
  externalOrderId: "order-7",
  itemIndex: 0,
  noodleType: "Thin",
  firmness: "hard",
  tableId: "table-3",
  // 玉数は必須の事実（noodle-portions 判断 4）。代表値と異なる値を据えて、写されていることを見分ける。
  portions: 2,
  itemName: null,
  sizeName: null,
  completedAt: null,
  interruptedAt: null,
  tableAssignedAt: null,
} as const;

describe("toOrderItems — 正常値の正規化", () => {
  it("妥当な到着を OrderItem 列へ写し、受理時刻を arrivalTime に据える", () => {
    expect(toOrderItems([validItem], presets, arrivalTime)).toEqual([
      {
        externalOrderId: "order-7",
        itemIndex: 0,
        noodleType: "Thin",
        firmness: "hard",
        tableId: "table-3",
        arrivalTime,
        portions: 2,
        itemName: null,
        sizeName: null,
        completedAt: null,
        interruptedAt: null,
        tableAssignedAt: null,
      },
    ]);
  });

  it("portions の欠落を 1 玉へ畳む（麺量の語彙を持たない到着・指定が無い入力の形に対する既定）", () => {
    const withoutPortions: Record<string, unknown> = { ...validItem };
    delete withoutPortions.portions;

    expect(toOrderItems([withoutPortions], presets, arrivalTime)?.[0]?.portions).toBe(1);
  });

  it("portions の値域の境界（PORTIONS_MIN・PORTIONS_MAX）と 0.5 刻みを通す", () => {
    const bounds = [PORTIONS_MIN, 1.5, PORTIONS_MAX];

    const orders = toOrderItems(
      bounds.map((portions, itemIndex) => ({ ...validItem, itemIndex, portions })),
      presets,
      arrivalTime,
    );

    expect(orders?.map((order) => order.portions)).toEqual(bounds);
  });

  it("tableId の欠落・null を単独グループ（null）へ正規化する", () => {
    const withoutTable = { ...validItem, tableId: undefined };
    const explicitNull = { ...validItem, itemIndex: 1, tableId: null };

    const orders = toOrderItems([withoutTable, explicitNull], presets, arrivalTime);

    expect(orders?.map((order) => order.tableId)).toEqual([null, null]);
  });

  it("余剰フィールドと生値の arrivalTime 主張を落とす（起点は受け手側の事実）", () => {
    const noisy = { ...validItem, boilSeconds: 999, arrivalTime: 1, note: "extra" };

    const orders = toOrderItems([noisy], presets, arrivalTime);

    expect(orders?.[0]).toEqual({ ...validItem, arrivalTime });
  });
});

describe("toOrderItems — 不正な到着は全体を拒否する", () => {
  it("配列でない生値・空配列を拒否する", () => {
    expect(toOrderItems(validItem, presets, arrivalTime)).toBeNull();
    expect(toOrderItems(null, presets, arrivalTime)).toBeNull();
    expect(toOrderItems([], presets, arrivalTime)).toBeNull();
  });

  it("必須属性の欠落を拒否する", () => {
    for (const missing of ["externalOrderId", "itemIndex", "noodleType", "firmness"] as const) {
      const item: Record<string, unknown> = { ...validItem };
      delete item[missing];

      expect(toOrderItems([item], presets, arrivalTime), `${missing} の欠落が通った`).toBeNull();
    }
  });

  it("未知の品目種別を拒否する", () => {
    expect(toOrderItems([{ ...validItem, noodleType: "Udon" }], presets, arrivalTime)).toBeNull();
    expect(toOrderItems([{ ...validItem, noodleType: "" }], presets, arrivalTime)).toBeNull();
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
      // 値域外・刻み外はクランプせず拒否する（勝手に寄せれば、要求されていない玉数を作ってしまう）。
      { ...validItem, portions: PORTIONS_MIN - 0.5 },
      { ...validItem, portions: PORTIONS_MAX + 0.5 },
      { ...validItem, portions: -1 },
      { ...validItem, portions: 1.25 },
      { ...validItem, portions: "1" },
      { ...validItem, portions: null },
      { ...validItem, portions: Number.NaN },
    ];

    for (const item of violations) {
      expect(
        toOrderItems([item], presets, arrivalTime),
        `${JSON.stringify(item)} が通った`,
      ).toBeNull();
    }
  });

  it("妥当な品目に 1 件の不正が混ざれば到着全体を拒否する（部分受理をしない）", () => {
    const arrival = [validItem, { ...validItem, itemIndex: 1, firmness: "veryHard" }];

    expect(toOrderItems(arrival, presets, arrivalTime)).toBeNull();
  });
});
