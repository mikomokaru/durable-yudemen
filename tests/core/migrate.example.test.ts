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
    // v7 の orderItem は卓を持たない。欠如は null（卓なし）へ畳む（v10）。
    expect(result.snapshot.timers[0]!.orderItem).toEqual({
      externalOrderId: "order-7",
      itemIndex: 1,
      tableId: null,
    });
    // v7 の待ち行列は slotSpan / itemName / sizeName を持たない。欠如は 1 スロット占有と「名前なし」として
    // 読み戻る（当時の実際の挙動に一致する——v7 に商品名の概念が無かったことと、名前が無い状態は同じである）。
    expect(result.snapshot.pendingOrders).toEqual([
      { ...v7Raw.pendingOrders[0], slotSpan: 1, itemName: null, sizeName: null },
    ]);
    // v10 で一片は点数を持たない。v7 の score（140）は余剰として捨てられ、鍵と配置は写しである。
    // v11 で配置は合流の所属（anchor）を持つ。v7 の配置は持たないので null で埋まる。
    expect(result.snapshot.acceptedSlices).toEqual(
      v7Raw.acceptedSlices.map(({ score: _score, ...rest }) => ({
        ...rest,
        placements: rest.placements.map((placement) => ({ ...placement, anchor: null })),
      })),
    );
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
      // 配置の形が満たされない（品目の鍵が空）。score は読まないので、不正の根拠にはならない。
      acceptedSlices: [{ tableKey: "t", placements: [{ externalOrderId: "" }] }],
    });
    // 小数の score だけでは落ちない——v10 は score を読まない（外し忘れれば v10 の永続が全滅する）。
    const fractionalScore = migrate({
      version: 7,
      timers: [],
      nextSeq: 0,
      acceptedSlices: [{ tableKey: "t", placements: [], score: 1.5 }],
    });
    expect(fractionalScore.ok).toBe(true);

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
    itemName: null,
    sizeName: null,
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

describe("migrate — v10 → v11（lift-group-planning 判断 20・AC 9.9）", () => {
  /** v10 で採用された一片の配置（合流の所属 anchor を持たない）。 */
  const v10Placement = {
    externalOrderId: "order-11",
    itemIndex: 0,
    slotIds: ["0"],
    startAt: 1_700_000_540_000,
    serveAt: 1_700_000_600_000,
  } as const;
  const v10Raw = {
    version: 10,
    timers: [],
    nextSeq: 0,
    pendingOrders: [],
    acceptedSlices: [{ tableKey: "t-1", placements: [v10Placement] }],
    requestedDigest: null,
    lastSequenceByTerminal: {},
  } as const;

  it("v10 の一片の配置は anchor = null で読み戻す（移行は設定を持たず h_i の窓を引けない）", () => {
    // 錨 600 秒に合流していた配置でも、toleranceRatio が永続に無い以上 h_i は引けず、所属は推定しない。
    // 合成（committedSchedule）が現在の走行中で再検証し、1 品の単位として切るか維持する。
    const result = migrate(structuredClone(v10Raw));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.snapshot.acceptedSlices).toEqual([
      { tableKey: "t-1", placements: [{ ...v10Placement, anchor: null }] },
    ]);
  });

  it("v11 の永続値は anchor（数値・null）をそのまま読み戻す", () => {
    const v11Raw = {
      ...v10Raw,
      version: 11,
      acceptedSlices: [
        {
          tableKey: "t-1",
          placements: [
            { ...v10Placement, anchor: 1_700_000_600_000 },
            { ...v10Placement, itemIndex: 1, slotIds: ["1"], anchor: null },
          ],
        },
      ],
    };

    const result = migrate(structuredClone(v11Raw));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.acceptedSlices).toEqual(v11Raw.acceptedSlices);
  });

  it("形を満たさない anchor（文字列・非有限数）は全体を移行失敗にする（自分が書いた値の形が違う）", () => {
    // 採用は再計算で復元できない事実。壊れた一片を黙って落とせば「この店が採用した計画」が書き換わる。
    const text = migrate({
      ...structuredClone(v10Raw),
      version: 11,
      acceptedSlices: [{ tableKey: "t-1", placements: [{ ...v10Placement, anchor: "600" }] }],
    });
    const infinite = migrate({
      ...structuredClone(v10Raw),
      version: 11,
      acceptedSlices: [
        { tableKey: "t-1", placements: [{ ...v10Placement, anchor: Number.POSITIVE_INFINITY }] },
      ],
    });

    expect([text.ok, infinite.ok]).toEqual([false, false]);
    if (text.ok || infinite.ok) return;
    expect(text.failure.code).toBe("MigrationFailed");
    expect(infinite.failure.code).toBe("MigrationFailed");
  });
});

describe("migrate — v11 → v12（plan-stability 判断 1・AC 1.3・性質 5.8）", () => {
  /** v11 の永続値（前回の提案 shownPlan を持たない——それが v11 であることの定義）。 */
  const v11Raw = {
    version: 11,
    timers: [v6Timer],
    nextSeq: 42,
    pendingOrders: [],
    acceptedSlices: [
      {
        tableKey: "t-1",
        placements: [
          {
            externalOrderId: "order-12",
            itemIndex: 0,
            slotIds: ["0"],
            startAt: 1_700_000_540_000,
            serveAt: 1_700_000_600_000,
            anchor: null,
          },
        ],
      },
    ],
    requestedDigest: 7,
    lastSequenceByTerminal: {
      "terminal-1": "00000000000000000000000000000000000000000000000000000042",
    },
  } as const;

  /** v12 が書く Shown_Plan の 1 品目（合流の錨を持ち、同じ群の相手を 1 つ持つ）。 */
  const shownItem = {
    externalOrderId: "order-12",
    itemIndex: 0,
    slotIds: ["0", "1"],
    startAt: 1_700_000_540_000,
    serveAt: 1_700_000_610_000,
    anchor: 1_700_000_600_000,
    mates: ["order-12:1"],
  } as const;

  it("v11 の永続値は shownPlan を空として読み戻し、他の事実は写しである（比較の相手なし）", () => {
    const result = migrate(structuredClone(v11Raw));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.snapshot.shownPlan).toEqual([]);
    expect(result.snapshot.acceptedSlices).toEqual(v11Raw.acceptedSlices);
    expect(result.snapshot.requestedDigest).toBe(7);
    expect(result.snapshot.lastSequenceByTerminal).toEqual(v11Raw.lastSequenceByTerminal);
    expect(result.snapshot.timers[0]!.endTime).toBe(v6Timer.endTime);
  });

  it("v12 の永続値は shownPlan（錨の数値・null・mates）をそのまま読み戻す", () => {
    const v12Raw = {
      ...v11Raw,
      version: 12,
      shownPlan: [shownItem, { ...shownItem, itemIndex: 1, anchor: null, mates: [] }],
    };

    const result = migrate(structuredClone(v12Raw));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.shownPlan).toEqual(v12Raw.shownPlan);
  });

  it("形を満たさない要素はその要素だけ落とし、残りは保つ（履歴の欠けは費用 0 に倒れるだけ）", () => {
    // 待ち行列・採用済み計画の「一件でも不正なら全体を移行失敗」とは規律が違う。Shown_Plan は比較にだけ使う
    // 履歴で、要素の欠けは嘘を生まない。壊れた 1 要素で店舗を起動不能にする代償の方が大きい。
    const broken = [
      { ...shownItem, externalOrderId: "" },
      { ...shownItem, itemIndex: -1 },
      { ...shownItem, slotIds: [] },
      { ...shownItem, startAt: "540" },
      { ...shownItem, serveAt: 1.5 },
      { ...shownItem, anchor: "600" },
      { ...shownItem, mates: [1] },
      { ...shownItem, mates: [""] },
      "not-an-object",
      null,
    ];
    const survivor = { ...shownItem, itemIndex: 9, anchor: null };
    const v12Raw = { ...v11Raw, version: 12, shownPlan: [shownItem, ...broken, survivor] };

    const result = migrate(structuredClone(v12Raw));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.shownPlan).toEqual([shownItem, survivor]);
    // 落としたのは Shown_Plan の要素だけで、他の事実は写しのまま。
    expect(result.snapshot.acceptedSlices).toEqual(v11Raw.acceptedSlices);
  });

  it("配列でない shownPlan は空へ畳む（移行失敗にしない）", () => {
    const result = migrate({ ...structuredClone(v11Raw), version: 12, shownPlan: { a: 1 } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.shownPlan).toEqual([]);
  });
});
