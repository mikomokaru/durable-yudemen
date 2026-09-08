// tests/client/persistence.example.test.ts — Timer → 品目の参照（orderItem）の永続と復元（order-lifecycle design Component 4）。
//
// **Validates: Requirements 4.4, 4.6（client の復元経路）**
//
// 品目の集合（orderItems）は永続しない（従来どおり）が、Timer は永続され `toClientTimer` が復元するので、参照の
// 復元経路が要る。新しい保存データでは `orderItem` を検証して復元し、旧 localStorage ブロブの欠如と不正は null に
// 畳んで **Timer を失わない**——参照は釜のカードの表示に要る事実だが、秒読みの継続はそれに依らない（レビュー P2）。
// wire（snapshot ごと落とす）とは義務が違う。

import { describe, expect, it } from "vitest";
import { EMPTY_VIEW, type ClientTimer, type ClientView } from "../../src/client/connection";
import { parsePersistedView, serializeView } from "../../src/client/persistence";

const T0 = 1_700_000_000_000;

function timer(overrides: Partial<ClientTimer> & { readonly id: string }): ClientTimer {
  return {
    slotIds: ["0"],
    noodleType: "Thin",
    firmness: "normal",
    startTime: T0,
    endTime: T0 + 60_000,
    orderItem: null,
    origin: "server",
    ...overrides,
  };
}

/** 保存ブロブを手組みする（旧ブロブ・不正な参照はコーデックの save では作れない）。 */
function blobWith(timers: readonly unknown[]): string {
  return JSON.stringify({ version: 1, timers, offset: 0, processedIds: [] });
}

const REF = { externalOrderId: "o-1", itemIndex: 2 } as const;

describe("Feature: order-lifecycle — Timer.orderItem の保存往復と復元", () => {
  it("参照付きの Timer は保存 → 復元で参照ごと戻る（null の Timer・provisional も同じ）", () => {
    const view: ClientView = {
      ...EMPTY_VIEW,
      timers: [
        timer({ id: "a", orderItem: REF }),
        timer({ id: "b" }),
        timer({ id: "c", orderItem: { externalOrderId: "o-2", itemIndex: 0 }, origin: "local" }),
      ],
    };
    const restored = parsePersistedView(serializeView(view));
    expect(restored.timers).toEqual(view.timers);
    // 品目の集合は永続しない（従来どおり・起動時に古い写しを出さない）。
    expect(JSON.parse(serializeView({ ...view, orderItems: [] }))).not.toHaveProperty("orderItems");
  });

  it("orderItem を持たない旧 localStorage ブロブは null に畳んで復元し、Timer を失わない", () => {
    const { orderItem: _dropped, ...legacy } = timer({ id: "old" });
    const restored = parsePersistedView(blobWith([legacy]));
    expect(restored.timers).toEqual([timer({ id: "old", orderItem: null })]);
  });

  it("不正な orderItem（非オブジェクト・空 id・負 / 非整数 / 文字列の itemIndex・鍵の欠如）は null に畳み、Timer は残る", () => {
    for (const broken of [
      "o-1",
      1,
      [],
      { externalOrderId: "", itemIndex: 0 },
      { externalOrderId: "o-1", itemIndex: -1 },
      { externalOrderId: "o-1", itemIndex: 1.5 },
      { externalOrderId: "o-1", itemIndex: "2" },
      { externalOrderId: "o-1" },
      { itemIndex: 0 },
    ]) {
      const restored = parsePersistedView(
        blobWith([
          { ...timer({ id: "kept" }), orderItem: broken },
          timer({ id: "ok", orderItem: REF }),
        ]),
      );
      expect(restored.timers, JSON.stringify(broken)).toEqual([
        timer({ id: "kept", orderItem: null }),
        timer({ id: "ok", orderItem: REF }),
      ]);
    }
  });

  it("参照の余剰フィールド（engine 側の tableId）は写さない——復元する参照は鍵だけ", () => {
    const restored = parsePersistedView(
      blobWith([{ ...timer({ id: "t" }), orderItem: { ...REF, tableId: "12" } }]),
    );
    expect(restored.timers[0]?.orderItem).toEqual(REF);
  });
});
