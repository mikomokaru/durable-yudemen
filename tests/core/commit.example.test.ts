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
import type { EpochMillis, SlotId } from "../../src/engine/types";
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
