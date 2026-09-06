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
import { initialLifts } from "../../src/engine/lift";
import { tableMembers } from "../../src/engine/project";
import { createTimer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import type { PendingOrder } from "../../src/domain/order";
import { DEFAULT_NOODLE_PRESETS } from "../../src/domain/store";
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
    const pending: PendingOrder[] = [1, 2, 3, 4, 5].map((index) => ({
      externalOrderId: `o${index}`,
      itemIndex: 0,
      noodleType: "Thin",
      firmness: "normal",
      tableId: "T1",
      arrivalTime: (NOW + index * SECOND) as EpochMillis,
      slotSpan: 1,
      itemName: null,
      sizeName: null,
    }));
    const now = (NOW + 12 * SECOND) as EpochMillis;
    const schedule = baselineSchedule(
      pending,
      initialRelease(running, now, 6),
      tableMembers(running),
      initialLifts(running),
      DEFAULT_NOODLE_PRESETS,
      PARAMS,
      null,
    );
    const serveSeconds = schedule.slices
      .flatMap((slice) => slice.placements)
      .map((placement) => [placement.externalOrderId, (placement.serveAt - NOW) / SECOND] as const);
    expect(serveSeconds.filter(([, s]) => s === 72).map(([id]) => id)).toEqual(["o1", "o2", "o3"]);
    expect(serveSeconds.filter(([, s]) => s === 117).map(([id]) => id)).toEqual(["o4", "o5"]);
  });
});
