// tests/core/commit.example.test.ts — 確定計画の合成 committedSchedule（src/engine/commit.ts）の例示。
//
// Feature: lift-group-planning（コードレビュー指摘・2026-09-05）
// **Validates: Requirements 4.1, 4.6**
//
// 採用済み一片は採用時の制約の上に組まれている。v9 は slotSpan を読まずに 1 釜で組んだので、v10 へ
// 移行した後もそのまま維持されると「2 釜の品目を 1 釜で始める」推奨が出続ける。合成は永続を書き換えず、
// 現在の slotSpan で再検証して食い違う一片から先を自前解で置き換える。

import { describe, expect, it } from "vitest";
import { committedSchedule } from "../../src/engine/commit";
import type { AcceptedSlice } from "../../src/engine/schedule";
import type { ScheduleParams } from "../../src/engine/objective";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import type { PendingOrder } from "../../src/domain/order";
import type { NoodlePreset } from "../../src/domain/store";
import { schedulingDefaults } from "../storeConfigDefaults";
import { nonEmpty } from "../nonEmpty";

const NOW = 1_700_000_000_000 as EpochMillis;
const SECOND = 1_000;
const PRESETS: readonly NoodlePreset[] = [
  { noodleType: "Thin", boilSeconds: { extraHard: 60, hard: 60, normal: 60, soft: 60 } },
];
const PARAMS: ScheduleParams = schedulingDefaults(1);

/** 大盛（2 釜）の 1 品目。 */
const WIDE: PendingOrder = {
  externalOrderId: "o-wide",
  itemIndex: 0,
  noodleType: "Thin",
  firmness: "normal",
  tableId: "t-a",
  arrivalTime: NOW,
  slotSpan: 2,
  itemName: null,
  sizeName: null,
};

/** v9 で採用された一片——品目は同じだが 1 釜で組まれている（v9 は slotSpan を読まなかった）。 */
const FROM_V9: AcceptedSlice = {
  tableKey: "t-a",
  placements: [
    {
      externalOrderId: WIDE.externalOrderId,
      itemIndex: 0,
      slotIds: nonEmpty(["0" as SlotId]),
      startAt: (NOW + 30 * SECOND) as EpochMillis,
      serveAt: (NOW + 90 * SECOND) as EpochMillis,
    },
  ],
};

describe("committedSchedule — 採用済み一片を現在の slotSpan で再検証する", () => {
  it("1 釜で組まれた採用済み一片は維持されず、自前解が 2 釜で置き直す", () => {
    const schedule = committedSchedule([FROM_V9], [WIDE], [], NOW, PRESETS, PARAMS);
    const placements = schedule.slices.flatMap((slice) => slice.placements);

    expect(placements).toHaveLength(1);
    expect(placements[0]!.slotIds).toHaveLength(2);
    expect(new Set(placements[0]!.slotIds).size).toBe(2);
    // 採用時の開始時刻（30 秒後）は引き継がれない——釜が空いているので今始める。
    expect(placements[0]!.startAt).toBe(NOW);
  });

  it("slotSpan を満たす採用済み一片はそのまま維持される（比較対照）", () => {
    const fits: AcceptedSlice = {
      tableKey: "t-a",
      placements: [
        { ...FROM_V9.placements[0]!, slotIds: nonEmpty(["0" as SlotId, "1" as SlotId]) },
      ],
    };
    const schedule = committedSchedule([fits], [WIDE], [], NOW, PRESETS, PARAMS);
    expect(schedule.slices).toEqual([fits]);
  });
});

describe("committedSchedule — 採用済み一片は現在の錨で再検証する（判断 17・keepsAnchor）", () => {
  // Feature: lift-group-planning, 判断 17
  // **Validates: Requirements 4.8, 5.3**
  //
  // 走行中の仲間（卓 t-a・釜 5・基底 endTime 600 秒）。錨は実効 endTime（endTime + adjustment）で、
  // Boil_Sync が adjustment を動かすと採用済み一片の前提（採用時の錨）が崩れる。
  const SECS = 1_000;
  function sibling(adjustment: number, endSeconds = 600) {
    return createTimer({
      id: "t-sibling" as TimerId,
      slotIds: nonEmpty(["5" as SlotId]),
      noodleType: "Thin" as NoodleType,
      firmness: "normal",
      startTime: (NOW + (endSeconds - 60) * SECS) as EpochMillis,
      endTime: (NOW + endSeconds * SECS) as EpochMillis,
      seq: 1,
      adjustment,
      orderItem: { externalOrderId: "o-first", itemIndex: 0, tableId: "t-a" },
    });
  }
  /** 同じ卓の未着手（Thin 60 秒・1 釜）。 */
  const REST: PendingOrder = { ...WIDE, externalOrderId: "o-rest", slotSpan: 1 };
  /** 採用時の錨 600 秒に合流した一片（釜 0・540 秒に始めて 600 秒に上がる）。 */
  const JOINED_AT_600: AcceptedSlice = {
    tableKey: "t-a",
    placements: [
      {
        externalOrderId: REST.externalOrderId,
        itemIndex: 0,
        slotIds: nonEmpty(["0" as SlotId]),
        startAt: (NOW + 540 * SECS) as EpochMillis,
        serveAt: (NOW + 600 * SECS) as EpochMillis,
      },
    ],
  };
  function serveSecondsOf(
    running: readonly Timer[],
    accepted: readonly AcceptedSlice[] = [JOINED_AT_600],
  ) {
    const schedule = committedSchedule(accepted, [REST], running, NOW, PRESETS, PARAMS);
    return schedule.slices
      .flatMap((slice) => slice.placements)
      .map((p) => (p.serveAt - NOW) / 1000);
  }

  it("錨が動いていなければ一片は維持される", () => {
    expect(serveSecondsOf([sibling(0)])).toEqual([600]);
  });

  it("錨が +Δ 動くと合流分は錨より手前になり、一片は捨てられて自前解が新しい錨（630 秒）へ揃え直す", () => {
    expect(serveSecondsOf([sibling(30 * SECS)])).toEqual([630]);
  });

  it("錨が −Δ 動いてもまだ合流できるなら押し出しになり、一片は捨てられて新しい錨（570 秒）へ揃え直す", () => {
    expect(serveSecondsOf([sibling(-30 * SECS)])).toEqual([570]);
  });

  it("錨が早まって本当に合流できなくなった品目の一片は、正当な後続の batch として維持される", () => {
    // 仲間が 30 秒後に上がる（基底 60 秒・−30 秒）。Thin 60 秒はもう届かない。一片は 90 秒に置いていた。
    const late: AcceptedSlice = {
      tableKey: "t-a",
      placements: [
        {
          ...JOINED_AT_600.placements[0]!,
          startAt: (NOW + 30 * SECS) as EpochMillis,
          serveAt: (NOW + 90 * SECS) as EpochMillis,
        },
      ],
    };
    expect(serveSecondsOf([sibling(-30 * SECS, 60)], [late])).toEqual([90]);
  });

  it("容量分割の一片（合流分は錨に一致・残りは後続）は維持される", () => {
    // 6 釜。仲間が釜 4・5 を占めて 600 秒に上がる。同卓の 1 釜の品目 5 本：4 本が合流し、5 本目は釜が空く 600 秒に始める。
    const first = createTimer({
      id: "t-first" as TimerId,
      slotIds: nonEmpty(["4" as SlotId, "5" as SlotId]),
      noodleType: "Thin" as NoodleType,
      firmness: "normal",
      startTime: (NOW + 540 * SECS) as EpochMillis,
      endTime: (NOW + 600 * SECS) as EpochMillis,
      seq: 1,
      orderItem: { externalOrderId: "o-first", itemIndex: 0, tableId: "t-a" },
    });
    const items = [1, 2, 3, 4, 5].map((itemIndex) => ({
      ...REST,
      externalOrderId: "o-rest",
      itemIndex,
    }));
    const place = (itemIndex: number, slot: string, startSeconds: number) => ({
      externalOrderId: "o-rest",
      itemIndex,
      slotIds: nonEmpty([slot as SlotId]),
      startAt: (NOW + startSeconds * SECS) as EpochMillis,
      serveAt: (NOW + (startSeconds + 60) * SECS) as EpochMillis,
    });
    const split: AcceptedSlice = {
      tableKey: "t-a",
      placements: [
        place(1, "0", 540),
        place(2, "1", 540),
        place(3, "2", 540),
        place(4, "3", 540),
        place(5, "4", 600),
      ],
    };
    const schedule = committedSchedule([split], items, [first], NOW, PRESETS, PARAMS);
    expect(schedule.slices).toEqual([split]);
  });

  it("外部解が自前解と別の合流集合を選んでも、押し出しが無ければ維持される", () => {
    // 空きは釜 0 だけ（釜 1〜4 は遠い未来まで塞ぐ）。同卓の A・B のうち 1 本しか合流できない。自前解は正準順の
    // A を選ぶが、外部解が B を合流させ A を釜 5 の空く 600 秒に回す一片は、A が B の後では合流できないので守っている。
    const blocked = [1, 2, 3, 4].map((slot) =>
      createTimer({
        id: `t-blocked-${slot}` as TimerId,
        slotIds: nonEmpty([String(slot) as SlotId]),
        noodleType: "Thin" as NoodleType,
        firmness: "normal",
        startTime: NOW,
        endTime: (NOW + 10_000 * SECS) as EpochMillis,
        seq: 10 + slot,
      }),
    );
    const A: PendingOrder = { ...REST, externalOrderId: "o-A", arrivalTime: NOW };
    const B: PendingOrder = {
      ...REST,
      externalOrderId: "o-B",
      arrivalTime: (NOW + 1) as EpochMillis,
    };
    const joinB: AcceptedSlice = {
      tableKey: "t-a",
      placements: [
        {
          externalOrderId: "o-B",
          itemIndex: 0,
          slotIds: nonEmpty(["0" as SlotId]),
          startAt: (NOW + 540 * SECS) as EpochMillis,
          serveAt: (NOW + 600 * SECS) as EpochMillis,
        },
        {
          externalOrderId: "o-A",
          itemIndex: 0,
          slotIds: nonEmpty(["5" as SlotId]),
          startAt: (NOW + 600 * SECS) as EpochMillis,
          serveAt: (NOW + 660 * SECS) as EpochMillis,
        },
      ],
    };
    const schedule = committedSchedule(
      [joinB],
      [A, B],
      [sibling(0), ...blocked],
      NOW,
      PRESETS,
      PARAMS,
    );
    expect(schedule.slices).toEqual([joinB]);
    // 対照：自前解は A を合流させる。
    const own = committedSchedule([], [A, B], [sibling(0), ...blocked], NOW, PRESETS, PARAMS);
    const joined = own.slices[0]!.placements.find((p) => p.serveAt === NOW + 600 * SECS)!;
    expect(joined.externalOrderId).toBe("o-A");
  });
});
