// engine/migrate の v6 → v8 移行を固定する（要件2.5、pos-order-ingress 要件6.25 / 10.5）。
//
// v7 は待ち行列・採用済み計画・指紋を永続へ載せ、v8 は占有幅（slotSpan）と取り込みの判定材料
// （lastSequenceByTerminal）を載せる。いずれの版上げも既存 Timer の計時の事実（endTime / adjustment /
// boiledAt）に一切触れてはならない。スキーマの版上げが走行中の釜の挙動を変えないことがここの眼目である。
// v6 以前からの各段（v1 の単一 slotId ／ boiledAt・startTime・firmness・adjustment の欠如）も v8 へ着地する。

import { describe, it, expect } from "vitest";
import { migrate } from "../../src/engine/migrate";
import { CURRENT_SCHEMA_VERSION } from "../../src/engine/types";

/** v6 の永続値に載っていた Timer 一件（v6 は adjustment まで持ち、orderItem を持たない）。 */
const v6Timer = {
  id: "timer-1",
  slotIds: ["slot-1", "slot-2"],
  noodleType: "Thin",
  firmness: "hard",
  startTime: 1_700_000_000_000,
  endTime: 1_700_000_090_000,
  seq: 41,
  boiledAt: 1_700_000_091_000,
  adjustment: -1_500,
} as const;

/** v6 の永続値（単一キー "activeTimers" に丸ごと入っていた形）。 */
const v6Raw = { version: 6, timers: [v6Timer], nextSeq: 42 } as const;

describe("migrate — v5 Adjustment → current", () => {
  // Feature: synchronized-boil-adjustment, Migration: Adjustment v5→current
  // **Validates: Requirements 4.5**
  it("v5 Timer の欠如した adjustment を 0 で復元して現行版へ移行する", () => {
    const v5Raw = {
      version: 5,
      timers: [
        {
          id: "timer-v5",
          slotIds: ["slot-1"],
          noodleType: "Thin",
          firmness: "normal",
          startTime: 1_700_000_000_000,
          endTime: 1_700_000_090_000,
          seq: 0,
          boiledAt: null,
        },
      ],
      nextSeq: 1,
    } as const;

    const result = migrate(structuredClone(v5Raw));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.snapshot.timers).toHaveLength(1);
    expect(result.snapshot.timers[0]!.adjustment).toBe(0);
  });
});

describe("migrate — v6 → v8", () => {
  it("後続版の追加フィールドを空値と null で埋め、version を現行へ上げる", () => {
    const result = migrate(structuredClone(v6Raw));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.snapshot.pendingOrders).toEqual([]);
    expect(result.snapshot.acceptedSlices).toEqual([]);
    expect(result.snapshot.requestedDigest).toBeNull();
    expect(result.snapshot.lastSequenceByTerminal).toEqual({});
    expect(result.snapshot.nextSeq).toBe(42);
  });

  it("既存 Timer の endTime / adjustment / boiledAt を変えない", () => {
    const result = migrate(structuredClone(v6Raw));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const timer = result.snapshot.timers[0]!;
    expect(timer.endTime).toBe(v6Timer.endTime);
    expect(timer.adjustment).toBe(v6Timer.adjustment);
    expect(timer.boiledAt).toBe(v6Timer.boiledAt);
    // 残りの事実も写しであることを確かめる（版上げが計時以外の事実も動かさない）。
    expect(timer.startTime).toBe(v6Timer.startTime);
    expect(timer.slotIds).toEqual([...v6Timer.slotIds]);
    expect(timer.firmness).toBe(v6Timer.firmness);
    expect(timer.seq).toBe(v6Timer.seq);
  });

  it("v6 の Timer は orderItem を持たないため null へ落ちる（アドホック麺茹で扱い）", () => {
    const result = migrate(structuredClone(v6Raw));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.timers[0]!.orderItem).toBeNull();
  });

  it("v6 以前の各段（v1 の単一 slotId・後続版の欠如フィールド）も v8 へ着地する", () => {
    const v1Raw = {
      timers: [
        {
          id: "timer-0",
          slotId: "slot-9",
          noodleType: "Thick",
          endTime: 1_700_000_000_000,
          seq: 0,
        },
      ],
      nextSeq: 1,
    };

    const result = migrate(v1Raw);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const timer = result.snapshot.timers[0]!;
    expect(result.snapshot.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(timer.slotIds).toEqual(["slot-9"]);
    expect(timer.boiledAt).toBeNull();
    expect(timer.startTime).toBe(1_700_000_000_000);
    expect(timer.firmness).toBe("normal");
    expect(timer.adjustment).toBe(0);
    expect(timer.orderItem).toBeNull();
    expect(result.snapshot.pendingOrders).toEqual([]);
    expect(result.snapshot.acceptedSlices).toEqual([]);
    expect(result.snapshot.requestedDigest).toBeNull();
    expect(result.snapshot.lastSequenceByTerminal).toEqual({});
  });
});

describe("migrate — v7 → v8", () => {
  it("v7 で書いた orderItem / 待ち行列 / 採用済み計画 / 指紋を読み戻す", () => {
    const v7Raw = {
      version: 7,
      timers: [{ ...v6Timer, orderItem: { externalOrderId: "order-7", itemIndex: 1 } }],
      nextSeq: 42,
      pendingOrders: [
        {
          externalOrderId: "order-8",
          itemIndex: 0,
          noodleType: "Thin",
          firmness: "normal",
          tableId: "table-3",
          arrivalTime: 1_700_000_050_000,
        },
      ],
      acceptedSlices: [
        {
          tableKey: "table-3",
          placements: [
            {
              externalOrderId: "order-8",
              itemIndex: 0,
              slotIds: ["slot-3"],
              startAt: 1_700_000_100_000,
              serveAt: 1_700_000_190_000,
            },
          ],
          score: 140,
        },
      ],
      requestedDigest: 123_456,
    };

    const result = migrate(structuredClone(v7Raw));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.timers[0]!.orderItem).toEqual({
      externalOrderId: "order-7",
      itemIndex: 1,
    });
    // v7 の待ち行列は slotSpan を持たない。欠如は 1 スロット占有として読み戻る（当時の実際の挙動に一致する）。
    expect(result.snapshot.pendingOrders).toEqual([{ ...v7Raw.pendingOrders[0], slotSpan: 1 }]);
    expect(result.snapshot.acceptedSlices).toEqual(v7Raw.acceptedSlices);
    expect(result.snapshot.requestedDigest).toBe(123_456);
    // v7 以前は取り込み経路が存在せず、判定材料を持つ端末が無い。空から始めれば最初の Record が必ず受理される。
    expect(result.snapshot.lastSequenceByTerminal).toEqual({});
  });

  it("形を満たさない orderItem は移行失敗にせず null へ畳む（計時は保たれる）", () => {
    const result = migrate({
      version: 7,
      timers: [{ ...v6Timer, orderItem: { externalOrderId: "" } }],
      nextSeq: 42,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.timers[0]!.orderItem).toBeNull();
    expect(result.snapshot.timers[0]!.endTime).toBe(v6Timer.endTime);
  });

  it("数値でない requestedDigest は null へ畳む（次の状態変化で 1 回余分に要求が出るだけ）", () => {
    const result = migrate({ version: 7, timers: [], nextSeq: 0, requestedDigest: "digest" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.requestedDigest).toBeNull();
  });

  it("待ち行列と採用済み計画の不正要素は全体を移行失敗にする（部分受理という嘘を作らない）", () => {
    const badPending = migrate({
      version: 7,
      timers: [],
      nextSeq: 0,
      pendingOrders: [{ externalOrderId: "order-9" }],
    });
    const badAccepted = migrate({
      version: 7,
      timers: [],
      nextSeq: 0,
      acceptedSlices: [{ tableKey: "t", placements: [], score: 1.5 }],
    });

    expect(badPending.ok).toBe(false);
    expect(badAccepted.ok).toBe(false);
    if (badPending.ok || badAccepted.ok) return;
    expect(badPending.failure.code).toBe("MigrationFailed");
    expect(badAccepted.failure.code).toBe("MigrationFailed");
  });
});

describe("migrate — v8 の往復", () => {
  /** v8 で書いた待ち行列 1 件（slotSpan を持つ）。 */
  const v8Order = {
    externalOrderId: "order-8",
    itemIndex: 0,
    noodleType: "Thin",
    firmness: "normal",
    tableId: null,
    arrivalTime: 1_700_000_050_000,
    slotSpan: 2,
  } as const;

  it("v8 で書いた slotSpan と判定材料を読み戻す", () => {
    const v8Raw = {
      version: 8,
      timers: [],
      nextSeq: 0,
      pendingOrders: [v8Order],
      lastSequenceByTerminal: {
        "terminal-1": "00000000000000000000000000000000000000000000000000000042",
      },
    };

    const result = migrate(structuredClone(v8Raw));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.pendingOrders).toEqual([v8Order]);
    expect(result.snapshot.lastSequenceByTerminal).toEqual(v8Raw.lastSequenceByTerminal);
  });

  it("値域外・非整数の slotSpan は全体を移行失敗にする（既存の全体拒否の規律）", () => {
    const tooWide = migrate({
      version: 8,
      timers: [],
      nextSeq: 0,
      pendingOrders: [{ ...v8Order, slotSpan: 7 }],
    });
    const fractional = migrate({
      version: 8,
      timers: [],
      nextSeq: 0,
      pendingOrders: [{ ...v8Order, slotSpan: 1.5 }],
    });
    const zero = migrate({
      version: 8,
      timers: [],
      nextSeq: 0,
      pendingOrders: [{ ...v8Order, slotSpan: 0 }],
    });

    expect([tooWide.ok, fractional.ok, zero.ok]).toEqual([false, false, false]);
    if (tooWide.ok || fractional.ok || zero.ok) return;
    expect(tooWide.failure.code).toBe("MigrationFailed");
    expect(fractional.failure.code).toBe("MigrationFailed");
    expect(zero.failure.code).toBe("MigrationFailed");
  });

  it("形を満たさない判定材料は空へ畳む（喪失が生むのは重複だけで欠落は生じない）", () => {
    const notRecord = migrate({
      version: 8,
      timers: [],
      nextSeq: 0,
      lastSequenceByTerminal: ["terminal-1"],
    });
    const badValue = migrate({
      version: 8,
      timers: [],
      nextSeq: 0,
      lastSequenceByTerminal: { "terminal-1": 42 },
    });

    expect(notRecord.ok).toBe(true);
    expect(badValue.ok).toBe(true);
    if (!notRecord.ok || !badValue.ok) return;
    expect(notRecord.snapshot.lastSequenceByTerminal).toEqual({});
    expect(badValue.snapshot.lastSequenceByTerminal).toEqual({});
  });
});
