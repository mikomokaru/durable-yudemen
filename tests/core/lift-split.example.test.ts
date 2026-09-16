// tests/core/lift-split.example.test.ts — 上限を超える合流の列は、候補の窓の残り容量で先頭の塊を切る。
//
// Feature: lift-group-planning, Requirement 9.8（上限を超える列の分割）
// **Validates: Requirements 9.4, 9.8**
//
// 実測の再現：走行中 1 本（72 秒に上がる）の錨に同じ卓の 5 本が合流する。上限（arms 2 + 手伝い 2 = 4）そのもので
// 先頭 4 本を切ると、走行中の 1 本と合わせて窓の負荷が 5 になり先頭の塊が次の窓（117 秒）へ押され、余りの 1 本だけが
// 今の窓に入る。残り容量（4 − 1 = 3）で切れば、3 本が今の窓、2 本が次の窓になる。

import { describe, expect, it } from "vitest";
import { baselineSchedule, initialRelease } from "../../src/engine/schedule";
import { scoreSchedule } from "../../src/engine/objective";
import { initialLifts, liftsOf } from "../../src/engine/lift";
import { tableMembers } from "../../src/engine/project";
import { createTimer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import type { OrderItem } from "../../src/domain/order";
import { DEFAULT_NOODLE_PRESETS, occupiedSlotsOf } from "../../src/domain/store";
import { schedulingDefaults } from "../storeConfigDefaults";
import { nonEmpty } from "../nonEmpty";

const NOW = 1_700_000_000_000 as EpochMillis;
const SECOND = 1000;
const PARAMS = { ...schedulingDefaults(1), arms: 2, liftIntervalSeconds: 45 };

describe("上限を超える合流の列は候補の窓の残り容量で切る", () => {
  it("走行中 1 本の錨に 5 本が合流する：3 本が今の窓、2 本が次の窓（先頭の塊が押されて余りだけが今にならない）", () => {
    const running = [
      createTimer({
        id: "t-first" as TimerId,
        slotIds: nonEmpty(["0" as SlotId]),
        noodleType: "Thin" as NoodleType,
        firmness: "normal",
        startTime: (NOW + 12 * SECOND) as EpochMillis,
        endTime: (NOW + 72 * SECOND) as EpochMillis,
        seq: 1,
        orderItem: { externalOrderId: "o0", itemIndex: 0, tableId: "T1" },
      }),
    ];
    const pending: OrderItem[] = [1, 2, 3, 4, 5].map((index) => ({
      externalOrderId: `o${index}`,
      itemIndex: 0,
      noodleType: "Thin",
      firmness: "normal",
      tableId: "T1",
      arrivalTime: (NOW + index * SECOND) as EpochMillis,
      slotSpan: 1,
      itemName: null,
      sizeName: null,
      completedAt: null,
      interruptedAt: null,
    }));
    const now = (NOW + 12 * SECOND) as EpochMillis;
    const schedule = baselineSchedule(
      pending,
      initialRelease(running, now, 6),
      tableMembers(running),
      initialLifts(running),
      DEFAULT_NOODLE_PRESETS,
      PARAMS,
      now,
      occupiedSlotsOf(running),
      null,
    );
    const serveSeconds = schedule.slices
      .flatMap((slice) => slice.placements)
      .map((placement) => [placement.externalOrderId, (placement.serveAt - NOW) / SECOND] as const);
    expect(serveSeconds.filter(([, s]) => s === 72).map(([id]) => id)).toEqual(["o1", "o2", "o3"]);
    expect(serveSeconds.filter(([, s]) => s === 117).map(([id]) => id)).toEqual(["o4", "o5"]);
  });
});

describe("将来の走行中の上げ窓に残る容量も分割候補に使う", () => {
  it.each([2, 3])("未着手 %i 杯の先頭を空きに置き、既存の総費用を下げる", (count) => {
    const { schedule, pending, context, params } = residualWindow(count, 0);
    const placements = schedule.slices.flatMap((slice) => slice.placements);
    expect(placements.map((p) => [p.externalOrderId, (p.serveAt - NOW) / SECOND])).toEqual(
      pending.map((p, index) => [p.externalOrderId, index === 0 ? 278 : count === 2 ? 323 : 345]),
    );
    // 半開区間の全変化点を独立に検査する。2 杯目の 323 秒は先頭の 278 秒からちょうど L。
    const lifts = [...context.lifts, ...liftsOf(placements)];
    for (const origin of lifts) {
      expect(
        lifts
          .filter((lift) => origin.at <= lift.at && lift.at < origin.at + 45 * SECOND)
          .reduce((sum, lift) => sum + lift.span, 0),
      ).toBeLessThanOrEqual(4);
    }
    // 全杯を 345 秒へ送る pack と、同じ釜・同じ目的式で比較する。
    // 旧版の 3 杯は末尾だけ 278 秒へ置けており、今回の差は総費用ではなく提供順にある。
    const pack = schedule.slices.map((slice) => ({
      ...slice,
      placements: slice.placements.map((p) => ({
        ...p,
        startAt: (NOW + 75 * SECOND) as EpochMillis,
        serveAt: (NOW + 345 * SECOND) as EpochMillis,
      })),
    }));
    expect(
      scoreSchedule(pack, pending, context, params).total -
        scoreSchedule(schedule.slices, pending, context, params).total,
    ).toBe(count === 2 ? 44 : 67);
  });

  it("同時提供の費用が大きければ、分割できても pack を選ぶ", () => {
    const { schedule } = residualWindow(2, 2);
    expect(
      schedule.slices.flatMap((s) => s.placements).map((p) => (p.serveAt - NOW) / SECOND),
    ).toEqual([345, 345]);
  });
});

function residualWindow(count: number, tableSyncWeight: number) {
  const running = [0, 1, 2].map((index) =>
    createTimer({
      id: `running-${index}` as TimerId,
      slotIds: nonEmpty([String(index) as SlotId]),
      noodleType: "Thin" as NoodleType,
      firmness: "normal",
      startTime: NOW,
      endTime: (NOW + 300 * SECOND) as EpochMillis,
      seq: index + 1,
      orderItem: { externalOrderId: `running-${index}`, itemIndex: 0, tableId: "other" },
    }),
  );
  const pending: OrderItem[] = Array.from({ length: count }, (_, index) => ({
    externalOrderId: `pending-${index}`,
    itemIndex: 0,
    noodleType: "Thin",
    firmness: "normal",
    tableId: "T1",
    arrivalTime: (NOW + index * SECOND) as EpochMillis,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
  }));
  const now = (NOW + 8 * SECOND) as EpochMillis;
  const params = { ...PARAMS, tableSyncWeight };
  const context = { members: tableMembers(running), lifts: initialLifts(running), change: null };
  const schedule = baselineSchedule(
    pending,
    initialRelease(running, now, 6),
    context.members,
    context.lifts,
    [{ noodleType: "Thin", boilSeconds: { extraHard: 270, hard: 270, normal: 270, soft: 270 } }],
    params,
    now,
    occupiedSlotsOf(running),
    null,
  );
  return { schedule, pending, context, params };
}
