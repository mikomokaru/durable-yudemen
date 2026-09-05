// tests/client/liftGroups.example.test.ts — 群の導出・連鎖・釜の組の境界（lift-group-display）。
//
// **Validates: Requirements 1.3, 1.7, 1.8, 1.9, 2.1〜2.4, 2.7, 2.9, 2.10, 4.3〜4.5, 4.7, 4.9**
//
// 性質テストは「全域でこうなる」を言うが、線がどこに引かれているかは言わない。ここは線そのものを名指しで
// 固定する——レビューの再現（茹で 510 / 360 / 330 秒の同卓 3 品）で先頭だけが押せること、連鎖が「1 本目が
// 始まった」で解禁されること、茹で上がりの転移で後続が隠れること、釜の組が距離と index で断たれること。

import { describe, expect, it } from "vitest";
import { EMPTY_VIEW, type ClientTimer, type ClientView } from "../../src/client/connection";
import {
  headOf,
  liftGroups,
  pairSlots,
  slotSuggestions,
  visibleGroups,
} from "../../src/client/components/liftGroups";
import type { CookRecommendation } from "../../src/domain/messages";
import type { PendingOrder } from "../../src/domain/order";
import { defaultUnitOrigins, type NoodlePreset } from "../../src/domain/store";
import type { NonEmptyArray } from "../../src/domain/timer";
import { nonEmpty } from "../nonEmpty";

const T0 = 1_700_000_000_000;
const SECOND = 1000;

/** 茹で 510 / 360 / 330 秒の 3 麺種（レビューの再現・観測事実 14）。 */
const PRESETS: NonEmptyArray<NoodlePreset> = [
  { noodleType: "Long", boilSeconds: { extraHard: 510, hard: 510, normal: 510, soft: 510 } },
  { noodleType: "Mid", boilSeconds: { extraHard: 360, hard: 360, normal: 360, soft: 360 } },
  { noodleType: "Short", boilSeconds: { extraHard: 330, hard: 330, normal: 330, soft: 330 } },
];

function order(overrides: Partial<PendingOrder> & { externalOrderId: string }): PendingOrder {
  return {
    itemIndex: 0,
    noodleType: "Long",
    firmness: "normal",
    tableId: "t-1",
    arrivalTime: T0 - 60 * SECOND,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
    ...overrides,
  };
}

function recommendation(
  externalOrderId: string,
  slotIds: readonly string[],
  startAt: number,
): CookRecommendation {
  return { externalOrderId, itemIndex: 0, slotIds: nonEmpty(slotIds), startAt };
}

function timer(overrides: Partial<ClientTimer> & { id: string; endTime: number }): ClientTimer {
  return {
    slotIds: nonEmpty(["0"]),
    noodleType: "Long",
    firmness: "normal",
    startTime: overrides.endTime - 510 * SECOND,
    orderItem: { externalOrderId: "started", itemIndex: 0, tableId: "t-1" },
    origin: "server",
    ...overrides,
  };
}

function view(overrides: Partial<ClientView>): ClientView {
  return {
    ...EMPTY_VIEW,
    connectivity: "up",
    sync: "synced",
    unitCount: 1,
    unitOrigins: defaultUnitOrigins(1),
    noodlePresets: PRESETS,
    ...overrides,
  };
}

/** 同卓 3 品（開始予定 0 / 150 / 180 秒・serveAt は 510 秒で揃う）。 */
const THREE = [
  order({ externalOrderId: "long", noodleType: "Long" }),
  order({ externalOrderId: "mid", noodleType: "Mid" }),
  order({ externalOrderId: "short", noodleType: "Short" }),
];
const THREE_PLAN = [
  recommendation("long", ["0"], T0),
  recommendation("mid", ["1"], T0 + 150 * SECOND),
  recommendation("short", ["2"], T0 + 180 * SECOND),
];

function suggestionsAt(current: ClientView, corrected: number) {
  return slotSuggestions(visibleGroups(liftGroups(current, corrected)), current, corrected);
}

describe("Feature: lift-group-display — 同卓 3 品で押せるのは先頭だけ（判断 17・レビューの再現）", () => {
  const current = view({ pendingOrders: THREE, recommendations: THREE_PLAN });

  it("3 品は一つの群（serveAt 510 秒）に束なり、先頭は 510 秒の品目だけ", () => {
    const groups = liftGroups(current, T0);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.serveAt).toBe(T0 + 510 * SECOND);
    expect(groups[0]!.items.map((item) => item.order.externalOrderId)).toEqual([
      "long",
      "mid",
      "short",
    ]);
    expect(headOf(groups[0]!).map((item) => item.order.externalOrderId)).toEqual(["long"]);
  });

  it("180 秒経って全品の startAt が過ぎても head は 510 秒の品目だけで、他 2 品は member（濃くならない）", () => {
    const bySlot = suggestionsAt(current, T0 + 180 * SECOND);
    expect(bySlot.get(0)).toEqual([
      { role: "head", phase: "solid", item: expect.objectContaining({ order: THREE[0] }) },
    ]);
    expect(bySlot.get(1)).toEqual([
      { role: "member", item: expect.objectContaining({ order: THREE[1] }) },
    ]);
    expect(bySlot.get(2)).toEqual([
      { role: "member", item: expect.objectContaining({ order: THREE[2] }) },
    ]);
  });

  it("Prep_Lead の 60 秒前に薄く現れ、startAt で濃くなる（先頭）。仲間は 60 秒前まで現れない", () => {
    expect(suggestionsAt(current, T0 - 61 * SECOND).size).toBe(0);
    expect(suggestionsAt(current, T0 - 60 * SECOND).get(0)?.[0]).toMatchObject({
      role: "head",
      phase: "faint",
    });
    expect(suggestionsAt(current, T0 - SECOND).get(0)?.[0]).toMatchObject({ phase: "faint" });
    expect(suggestionsAt(current, T0).get(0)?.[0]).toMatchObject({ phase: "solid" });
    // mid の startAt は 150 秒。89 秒では現れず、90 秒で member として現れる。
    expect(suggestionsAt(current, T0 + 89 * SECOND).has(1)).toBe(false);
    expect(suggestionsAt(current, T0 + 90 * SECOND).get(1)?.[0]).toMatchObject({ role: "member" });
  });
});

describe("Feature: lift-group-display — 連鎖は「1 本目が始まった」で解禁される（判断 16・19）", () => {
  /** 別卓の群 G2（開始予定 200 秒・Prep_Lead は 140 秒）。 */
  const other = order({ externalOrderId: "other", tableId: "t-2", noodleType: "Mid" });
  const otherPlan = recommendation("other", ["3"], T0 + 200 * SECOND);

  it("先頭の群が started でない間、後の群は Prep_Lead が来ても出ない", () => {
    const current = view({
      pendingOrders: [...THREE, other],
      recommendations: [...THREE_PLAN, otherPlan],
    });
    const groups = liftGroups(current, T0 + 180 * SECOND);
    expect(groups.map((group) => group.tableId)).toEqual(["t-1", "t-2"]);
    expect(visibleGroups(groups).map((group) => group.tableId)).toEqual(["t-1"]);
    expect(suggestionsAt(current, T0 + 180 * SECOND).has(3)).toBe(false);
  });

  it("1 本目を始める（同卓・endTime = serveAt の走行中）と群は started になり、次の先頭が濃くなり、後の群も出る", () => {
    // long を釜 0 で始めた snapshot：推奨から消え、残り 2 品の serveAt は走行中の endTime に一致する。
    const current = view({
      pendingOrders: [THREE[1]!, THREE[2]!, other],
      recommendations: [THREE_PLAN[1]!, THREE_PLAN[2]!, otherPlan],
      timers: [timer({ id: "long", endTime: T0 + 510 * SECOND })],
    });
    const groups = liftGroups(current, T0 + 180 * SECOND);
    expect(groups[0]).toMatchObject({ tableId: "t-1", started: true });
    expect(headOf(groups[0]!).map((item) => item.order.externalOrderId)).toEqual(["mid"]);
    expect(visibleGroups(groups).map((group) => group.tableId)).toEqual(["t-1", "t-2"]);
    const bySlot = suggestionsAt(current, T0 + 180 * SECOND);
    expect(bySlot.get(1)?.[0]).toMatchObject({ role: "head", phase: "solid" });
    expect(bySlot.get(2)?.[0]).toMatchObject({ role: "member" });
    expect(bySlot.get(3)?.[0]).toMatchObject({ role: "head", phase: "faint" });
    // 走行中の釜 0 には何も出ない（idle でない釜の提案は slotDisplay が載せないが、導出の段でも無い）。
    expect(bySlot.has(0)).toBe(false);
  });

  it("卓の一致だけ（endTime 不一致）・endTime の一致だけ（卓なし・別卓）では started にならない", () => {
    const serveAt = T0 + 510 * SECOND;
    const remaining = view({
      pendingOrders: [THREE[1]!, THREE[2]!],
      recommendations: [THREE_PLAN[1]!, THREE_PLAN[2]!],
    });
    const startedWith = (running: ClientTimer) =>
      liftGroups({ ...remaining, timers: [running] }, T0)[0]!.started;
    expect(startedWith(timer({ id: "same-table-off", endTime: serveAt + 1 }))).toBe(false);
    expect(startedWith(timer({ id: "adhoc", endTime: serveAt, orderItem: null }))).toBe(false);
    expect(
      startedWith(
        timer({
          id: "foreign",
          endTime: serveAt,
          orderItem: { externalOrderId: "x", itemIndex: 0, tableId: "t-9" },
        }),
      ),
    ).toBe(false);
    expect(startedWith(timer({ id: "mate", endTime: serveAt }))).toBe(true);
  });

  it("茹で上がりの転移：599 秒では G2 が見え、600 秒で G1 が started でなくなり G2 は隠れ、G1 の残りが先頭として濃く残る", () => {
    // 仲間の endTime は 600 秒。G1 の残り 1 品（開始予定 240 秒・茹で 360 秒）と、別卓の G2（開始予定 300 秒）。
    const rest = order({ externalOrderId: "rest", noodleType: "Mid" });
    const g2 = order({ externalOrderId: "g2", tableId: "t-2", noodleType: "Short" });
    const current = view({
      pendingOrders: [rest, g2],
      recommendations: [
        recommendation("rest", ["1"], T0 + 240 * SECOND),
        recommendation("g2", ["2"], T0 + 300 * SECOND),
      ],
      timers: [timer({ id: "mate", endTime: T0 + 600 * SECOND })],
    });
    const at599 = suggestionsAt(current, T0 + 599 * SECOND);
    expect(at599.get(1)?.[0]).toMatchObject({ role: "head", phase: "solid" });
    expect(at599.get(2)?.[0]).toMatchObject({ role: "head", phase: "solid" });
    const at600 = suggestionsAt(current, T0 + 600 * SECOND);
    expect(liftGroups(current, T0 + 600 * SECOND)[0]!.started).toBe(false);
    expect(at600.get(1)?.[0]).toMatchObject({ role: "head", phase: "solid" });
    expect(at600.has(2)).toBe(false);
  });
});

describe("Feature: lift-group-display — 群に入らない推奨と全釜 idle（AC 1.3・2.7）", () => {
  it("品目が待ち行列に無い・麺種がプリセットに無い推奨は群に入らない", () => {
    const retired = order({ externalOrderId: "retired", noodleType: "Retired" });
    const current = view({
      pendingOrders: [THREE[0]!, retired],
      recommendations: [
        THREE_PLAN[0]!,
        recommendation("retired", ["1"], T0),
        recommendation("absent", ["2"], T0),
      ],
    });
    const groups = liftGroups(current, T0);
    expect(
      groups.flatMap((group) => group.items.map((item) => item.order.externalOrderId)),
    ).toEqual(["long"]);
  });

  it("卓なしの品目は 1 品 1 群で、同じ serveAt でも束ならない", () => {
    const a = order({ externalOrderId: "a", tableId: null });
    const b = order({ externalOrderId: "b", tableId: null });
    const current = view({
      pendingOrders: [a, b],
      recommendations: [recommendation("a", ["0"], T0), recommendation("b", ["1"], T0)],
    });
    const groups = liftGroups(current, T0);
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.tableId === null && !group.started)).toBe(true);
    // 先頭の群だけが見える（卓なしは started を持たないので 1 本ずつ現れる）。
    expect(visibleGroups(groups)).toHaveLength(1);
  });

  it("複数釜の推奨は一部の釜が埋まっていればどの釜にも出ず、boiled の釜も埋まっている", () => {
    const wide = order({ externalOrderId: "wide", slotSpan: 2 });
    const plan = recommendation("wide", ["0", "1"], T0);
    const idle = view({ pendingOrders: [wide], recommendations: [plan] });
    expect([...suggestionsAt(idle, T0).keys()].sort()).toEqual([0, 1]);
    // 釜 1 が茹で上がり（endTime ≤ corrected）でも Complete までは埋まっている。担当外の卓なし Timer でも同じ。
    const boiled = view({
      pendingOrders: [wide],
      recommendations: [plan],
      timers: [timer({ id: "b", slotIds: nonEmpty(["1"]), endTime: T0 - SECOND, orderItem: null })],
    });
    expect(suggestionsAt(boiled, T0).size).toBe(0);
  });
});

describe("Feature: lift-group-display — 釜の組（pairSlots・判断 10）", () => {
  const empty = view({});

  it("slotSpan 1 は押した釜だけ。起点の釜が埋まっていれば slotSpan 1 でも null", () => {
    expect(pairSlots(3, 1, empty)).toEqual(["3"]);
    const taken = view({
      timers: [timer({ id: "t", slotIds: nonEmpty(["3"]), endTime: T0 + 60 * SECOND })],
    });
    expect(pairSlots(3, 1, taken)).toBeNull();
    expect(pairSlots(3, 2, taken)).toBeNull();
  });

  it("最も近い空き釜を近い順に、同距離は index で断つ（既定の台：横 10・縦 10・斜め 14）", () => {
    // 釜 0 から：釜 1（横）と釜 2（縦）が 10 で同距離 → index の小さい釜 1。次は釜 2、その次に斜めの釜 3。
    expect(pairSlots(0, 2, empty)).toEqual(["0", "1"]);
    expect(pairSlots(0, 3, empty)).toEqual(["0", "1", "2"]);
    expect(pairSlots(0, 4, empty)).toEqual(["0", "1", "2", "3"]);
    // 釜 1 が埋まっていれば釜 2、次は斜めの釜 3。
    const taken = view({
      timers: [timer({ id: "t", slotIds: nonEmpty(["1"]), endTime: T0 + 60 * SECOND })],
    });
    expect(pairSlots(0, 2, taken)).toEqual(["0", "2"]);
    expect(pairSlots(0, 3, taken)).toEqual(["0", "2", "3"]);
  });

  it("許容距離の内側に足りなければ null（既定 14 は斜め隣接まで・2 マス直線の 20 は届かない）", () => {
    // 釜 0 の隣接（1・2・3）が埋まると、残りは釜 4（縦 2 マス＝20）と釜 5（24）で内側に無い。
    const boxed = view({
      timers: [timer({ id: "t", slotIds: nonEmpty(["1", "2", "3"]), endTime: T0 + 60 * SECOND })],
    });
    expect(pairSlots(0, 2, boxed)).toBeNull();
    // 許容距離を広げれば釜 4 が組める（距離は config の許容距離で測る・AC 4.7）。
    expect(pairSlots(0, 2, { ...boxed, affinityToleranceDistance: 20 })).toEqual(["0", "4"]);
    // 5 釜要る品目は、6 釜のうち 1 つでも許容距離の外なら組めない（釜 0 から釜 4・5 は 20・24）。
    expect(pairSlots(0, 5, empty)).toBeNull();
  });

  it("担当ユニットを跨いでよい——距離が近ければ別の台の釜も組む（既定の台の離隔では届かない）", () => {
    const two = view({ unitCount: 2, unitOrigins: defaultUnitOrigins(2) });
    // 釜 1（x=1）から隣の台の釜 6（x=4）は 30。既定の 14 では届かず、同じ台の釜 0・3 が組まれる。
    expect(pairSlots(1, 3, two)).toEqual(["1", "0", "3"]);
    // 許容距離 30 なら、同じ台の釜（0・3 が 10、2 が 14、5 が 20、4 が 24）を使い切った後に釜 6（30）が組まれる。
    const wide = { ...two, affinityToleranceDistance: 30 };
    expect(pairSlots(1, 6, wide)).toEqual(["1", "0", "3", "2", "5", "4"]);
    // 釜 4・5 が埋まれば釜 6 が繰り上がる。釜 8（x=4, y=1）は 34 で内側に無く、6 釜要る品目は組めない。
    const taken = {
      ...wide,
      timers: [timer({ id: "t", slotIds: nonEmpty(["4", "5"]), endTime: T0 + SECOND })],
    };
    expect(pairSlots(1, 5, taken)).toEqual(["1", "0", "3", "2", "6"]);
    expect(pairSlots(1, 6, taken)).toBeNull();
  });
});
