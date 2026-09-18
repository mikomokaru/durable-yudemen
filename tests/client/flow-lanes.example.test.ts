// tests/client/flow-lanes.example.test.ts — オーダーの流れ（KANBAN）のレーン導出（プロトタイプ）。
//
// 検証対象は flowLanes / timelinePlacements の純粋層だけである。段階と既存モデルの対応（Waiting = 未調理・
// Boiling = 生きた Timer・Plating = completedAt あり ∧ 未確認・Done = 確認済み）と、各レーンの並びを問う。
// WS・DOM・時計に触れないため既定 pool で走る。now は引数で運ぶ。

import { describe, expect, it } from "vitest";
import { EMPTY_VIEW, type ClientTimer, type ClientView } from "../../src/client/connection";
import {
  BOWL_PREP_LEAD_MS,
  flowLanes,
  planClusters,
  planGroups,
  rebasePlan,
  ticketNumberOf,
  timelinePlacements,
} from "../../src/client/components/flowLanes";
import { itemKeyOf, ORDER_LIFETIME_MS, type OrderItem } from "../../src/domain/order";
import type { CookRecommendation } from "../../src/domain/messages";
import { DEFAULT_NOODLE_PRESETS } from "../../src/domain/store";

const T = 1_700_000_000_000;

function order(
  externalOrderId: string,
  itemIndex: number,
  arrivalTime: number,
  overrides: Partial<OrderItem> = {},
): OrderItem {
  return {
    externalOrderId,
    itemIndex,
    noodleType: "Thin",
    firmness: "normal",
    tableId: null,
    arrivalTime,
    portions: 1,
    itemName: null,
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
    tableAssignedAt: null,
    ...overrides,
  };
}

function timer(
  id: string,
  endTime: number,
  orderItem: ClientTimer["orderItem"],
  slotIds: ClientTimer["slotIds"] = ["0"],
): ClientTimer {
  return {
    id,
    slotIds,
    noodleType: "Thin",
    firmness: "normal",
    startTime: endTime - 60_000,
    endTime,
    orderItem,
    origin: "server",
  };
}

function recommendation(
  externalOrderId: string,
  itemIndex: number,
  startAt: number,
): CookRecommendation {
  return { externalOrderId, itemIndex, slotIds: ["0"], startAt, group: "g", anchor: null };
}

function synced(overrides: Partial<ClientView>): ClientView {
  return {
    ...EMPTY_VIEW,
    sync: "synced",
    connectivity: "up",
    noodlePresets: DEFAULT_NOODLE_PRESETS,
    ...overrides,
  };
}

describe("flowLanes — 段階は既存モデルからの導出である", () => {
  it("未調理は Waiting、生きた Timer の参照先は Boiling、completedAt ありは Plating（未確認）か Done（確認済み）", () => {
    const waiting = order("W", 0, T - 10_000);
    const cooking = order("C", 0, T - 60_000);
    const plating = order("P", 0, T - 120_000, { completedAt: T - 5_000 });
    const done = order("D", 0, T - 180_000, { completedAt: T - 60_000 });
    const view = synced({
      orderItems: [waiting, cooking, plating, done],
      timers: [timer("t1", T + 30_000, { externalOrderId: "C", itemIndex: 0 })],
    });
    const lanes = flowLanes(view, new Set([itemKeyOf(done)]), T);
    expect(lanes.synced).toBe(true);
    expect(lanes.waiting.map((e) => e.order.externalOrderId)).toEqual(["W"]);
    expect(lanes.waiting[0]?.waitingMs).toBe(10_000);
    expect(lanes.boiling.map((e) => e.order?.externalOrderId)).toEqual(["C"]);
    expect(lanes.boiling[0]?.remainingMs).toBe(30_000);
    expect(lanes.boiling[0]?.overdueMs).toBe(0);
    expect(lanes.plating.map((e) => e.order.externalOrderId)).toEqual(["P"]);
    expect(lanes.plating[0]?.waitingMs).toBe(120_000);
    expect(lanes.done.map((e) => e.order.externalOrderId)).toEqual(["D"]);
  });

  it("Waiting は推奨の startAt 昇順、推奨の無い品目は到着順で末尾", () => {
    const a = order("A", 0, T - 30_000);
    const b = order("B", 0, T - 20_000);
    const c = order("C", 0, T - 10_000);
    const d = order("D", 0, T - 40_000);
    const view = synced({
      orderItems: [a, b, c, d],
      recommendations: [recommendation("B", 0, T + 10_000), recommendation("C", 0, T + 5_000)],
    });
    const lanes = flowLanes(view, new Set(), T);
    expect(lanes.waiting.map((e) => e.order.externalOrderId)).toEqual(["C", "B", "D", "A"]);
    expect(lanes.waiting.map((e) => e.startAt)).toEqual([T + 5_000, T + 10_000, null, null]);
  });

  it("Boiling は endTime 昇順で、アドホック（注文なし）の Timer も含み、茹で上がりは remaining 0 / overdue 正", () => {
    const view = synced({
      orderItems: [],
      timers: [
        timer("late", T + 90_000, null, ["3"]),
        timer("up", T - 15_000, null, ["1"]),
        timer("soon", T + 5_000, null, ["2"]),
      ],
    });
    const lanes = flowLanes(view, new Set(), T);
    expect(lanes.boiling.map((e) => e.timer.id)).toEqual(["up", "soon", "late"]);
    expect(lanes.boiling[0]).toMatchObject({ order: null, remainingMs: 0, overdueMs: 15_000 });
  });

  it("prep は boiling のうち残りが準備猶予（90 秒）以下の部分列で、茹で上がりも含み、上がる順を保つ", () => {
    const view = synced({
      orderItems: [],
      timers: [
        timer("far", T + BOWL_PREP_LEAD_MS + 1, null, ["0"]),
        timer("edge", T + BOWL_PREP_LEAD_MS, null, ["1"]),
        timer("soon", T + 5_000, null, ["2"]),
        timer("up", T - 3_000, null, ["3"]),
      ],
    });
    const lanes = flowLanes(view, new Set(), T);
    expect(lanes.prep.map((e) => e.timer.id)).toEqual(["up", "soon", "edge"]);
    expect(lanes.bowls.map((b) => (b.kind === "boiling" ? b.entry.timer.id : "?"))).toEqual([
      "up",
      "soon",
      "edge",
    ]);
    // degraded でも Timer 由来なので出る（棚は秒読みと同じくローカルで続く）。
    expect(flowLanes({ ...view, connectivity: "down" }, new Set(), T).prep).toHaveLength(3);
  });

  it("Plating はオーダーから長く待っている順、Done は上げた時刻の新しい順", () => {
    const p1 = order("P1", 0, T - 100_000, { completedAt: T - 60_000 });
    const p2 = order("P2", 0, T - 200_000, { completedAt: T - 30_000 });
    const d1 = order("D1", 0, T - 100_000, { completedAt: T - 30_000 });
    const d2 = order("D2", 0, T - 100_000, { completedAt: T - 60_000 });
    const view = synced({ orderItems: [p1, p2, d1, d2] });
    const lanes = flowLanes(view, new Set([itemKeyOf(d1), itemKeyOf(d2)]), T);
    expect(lanes.plating.map((e) => e.order.externalOrderId)).toEqual(["P2", "P1"]);
    expect(lanes.plating.map((e) => e.waitingMs)).toEqual([200_000, 100_000]);
    expect(lanes.done.map((e) => e.order.externalOrderId)).toEqual(["D1", "D2"]);
    // 棚は盛りつけ中を先頭（右端）に置き、Done は含めない。
    expect(lanes.bowls.map((b) => `${b.kind}:${b.entry.order?.externalOrderId}`)).toEqual([
      "plating:P2",
      "plating:P1",
    ]);
  });

  it("期限切れの品目はどのレーンにも現れない（Timer の参照先は Boiling に残る）", () => {
    const expired = order("X", 0, T - ORDER_LIFETIME_MS);
    const expiredDone = order("Y", 0, T - ORDER_LIFETIME_MS, { completedAt: T - 1_000 });
    const expiredCooking = order("Z", 0, T - ORDER_LIFETIME_MS);
    const view = synced({
      orderItems: [expired, expiredDone, expiredCooking],
      timers: [timer("t", T + 10_000, { externalOrderId: "Z", itemIndex: 0 })],
    });
    const lanes = flowLanes(view, new Set(), T);
    expect(lanes.waiting).toEqual([]);
    expect(lanes.plating).toEqual([]);
    expect(lanes.done).toEqual([]);
    expect(lanes.boiling.map((e) => e.order?.externalOrderId)).toEqual(["Z"]);
  });

  it("degraded・再整合待ちでは品目のレーンを列挙せず、Boiling だけ出す", () => {
    const item = order("W", 0, T - 10_000);
    const base = synced({ orderItems: [item], timers: [timer("t", T + 10_000, null)] });
    for (const view of [
      { ...base, connectivity: "down" as const },
      { ...base, awaitingResync: true },
    ]) {
      const lanes = flowLanes(view, new Set(), T);
      expect(lanes.synced).toBe(false);
      expect(lanes.waiting).toEqual([]);
      expect(lanes.boiling).toHaveLength(1);
    }
  });
});

describe("timelinePlacements — 縦位置は時刻そのもの、重なりは横の列へ避ける", () => {
  it("重なる札は次の列へ、空いた列には戻る", () => {
    const { placements, columns } = timelinePlacements(
      [
        { remainingMs: 0 },
        { remainingMs: 1_000 },
        { remainingMs: 30_000 },
        { remainingMs: 70_000 },
        { remainingMs: 75_000 },
      ],
      1,
      60,
      6,
    );
    // 上端は歪めない。0 と 1 は重なるので列 0 / 1、30 は列 0 の下端 66 より上なので列 1 の下端 67 と比べても入らず列 2、
    // 70 は列 0（下端 66）へ戻り、75 は列 0 の新しい下端 136 より上なので列 1（下端 67）へ。
    expect(placements.map((p) => [p.top, p.column])).toEqual([
      [0, 0],
      [1, 1],
      [30, 2],
      [70, 0],
      [75, 1],
    ]);
    expect(columns).toBe(3);
  });
});

describe("ticketNumberOf — 食券番号（4 桁）の導出", () => {
  it("Unique_Key 形の id は 3 番目（bill_no）の下 4 桁を 0 詰めで、区切りの無い id は末尾の数字の下 4 桁", () => {
    expect(ticketNumberOf("1108:3:12345:2026-09-17T10%3A00%3A00")).toBe("2345");
    expect(ticketNumberOf("1108:3:7:2026-09-17T10%3A00%3A00")).toBe("0007");
    expect(ticketNumberOf("1108:3:%3042:x")).toBe("0042"); // %XX を戻してから読む
    expect(ticketNumberOf("K-1001")).toBe("1001");
    expect(ticketNumberOf("A-101")).toBe("0101");
    expect(ticketNumberOf("no-digits")).toBe("gits");
  });
});

describe("planGroups — 最新の計画を群で束ねる", () => {
  it("群ごとに startAt 昇順で束ね、開始できない推奨（品目が未調理に無い）は落とす。degraded では空", () => {
    const a = order("A", 0, T - 30_000);
    const b = order("B", 0, T - 20_000);
    const c = order("C", 0, T - 10_000);
    const gone = order("G", 0, T - 5_000, { completedAt: T - 1_000 });
    const view = synced({
      orderItems: [a, b, c, gone],
      recommendations: [
        { ...recommendation("B", 0, T + 30_000), group: "g1" },
        { ...recommendation("A", 0, T + 5_000), group: "g1" },
        { ...recommendation("C", 0, T - 1_000), group: "g0" },
        { ...recommendation("G", 0, T + 1_000), group: "g2" },
      ],
    });
    const groups = planGroups(view, T);
    expect(groups.map((g) => g.group)).toEqual(["g0", "g1"]);
    expect(groups[1]?.items.map((i) => i.order.externalOrderId)).toEqual(["A", "B"]);
    expect(groups[1]?.startAt).toBe(T + 5_000);
    // Thin normal は 60 秒なので上がりは startAt + 60s。
    expect(groups[0]?.serveAt).toBe(T - 1_000 + 60_000);
    expect(planGroups({ ...view, connectivity: "down" }, T)).toEqual([]);
  });
});

describe("planClusters — 一度に上げるまとまり（上がり時刻が等しい群）で束ねる", () => {
  it("上がりが同じ別卓の群は同じクラスタに入り、クラスタは上がりの早い順", () => {
    const a = order("A", 0, T - 30_000, { tableId: "1" });
    const b = order("B", 0, T - 20_000, { tableId: "2" });
    const c = order("C", 0, T - 10_000, { tableId: "1" });
    const view = synced({
      orderItems: [a, b, c],
      recommendations: [
        { ...recommendation("A", 0, T), group: "t1" },
        { ...recommendation("B", 0, T), group: "t2" }, // 別卓・同じ上がり
        { ...recommendation("C", 0, T + 180_000), group: "t1b" },
      ],
    });
    const clusters = planClusters(view, T);
    expect(clusters.map((c) => c.serveAt)).toEqual([T + 60_000, T + 240_000]);
    expect(clusters[0]?.groups.map((g) => g.group)).toEqual(["t1", "t2"]);
    expect(clusters[1]?.groups.map((g) => g.group)).toEqual(["t1b"]);
  });
});

describe("rebasePlan — 先頭の遅れを全クラスタに足して「いま始めたら」の目盛りにする", () => {
  it("先頭が過去なら遅れぶんを全部に足し、先頭が未来なら入力のまま", () => {
    const a = order("A", 0, T - 30_000, { tableId: "1" });
    const b = order("B", 0, T - 20_000, { tableId: "2" });
    const view = synced({
      orderItems: [a, b],
      recommendations: [
        { ...recommendation("A", 0, T - 40_000), group: "t1" },
        { ...recommendation("B", 0, T + 140_000), group: "t2" },
      ],
    });
    const clusters = planClusters(view, T);
    const rebased = rebasePlan(clusters, T);
    expect(rebased.lagMs).toBe(40_000);
    expect(rebased.clusters.map((c) => c.startAt)).toEqual([T, T + 180_000]);
    expect(rebased.clusters.map((c) => c.serveAt)).toEqual([T + 60_000, T + 240_000]);
    // 後続との間隔（180 秒）は保たれる。
    const fresh = rebasePlan(clusters, T - 60_000);
    expect(fresh.lagMs).toBe(0);
    expect(fresh.clusters).toBe(clusters);
  });
});
