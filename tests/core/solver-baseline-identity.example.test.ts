// tests/core/solver-baseline-identity.example.test.ts — **Solver_Worker の解は engine の自前解と同一で、
// ゆえに採用され得ない**ことを固定する。
//
// **Validates: cpsat-planner-integration R1.4**
//
// 2026-09-13、標本外の店舗（CP-SAT の段階投入に入っていない 164 店舗）で SOLVER を呼ばない判断をした。
// 根拠は「`yude-men-solver` が返すのは engine の自前解と同じもので、届いても同値で棄却されるだけ。
// 送れば費用だけが増える」である。**それは主張なので、ここで確かめる。**
//
// 主張を 2 段で押さえる。
//   1. `searchPlan`（Solver_Worker の中身）の解が、engine の `committedSchedule([], …)` と一致する
//   2. その解を `admit` へ渡すと、接頭辞を 1 つも採らない（同値は棄却）
import { describe, expect, it } from "vitest";
import { searchPlan } from "../../src/solver/index";
import { admit } from "../../src/engine/admit";
import { committedSchedule } from "../../src/engine/commit";
import { EMPTY_SHOWN_PLAN } from "../../src/engine/stability";
import type { PlanRequest } from "../../src/solver/request";
import type { NoodlePreset } from "../../src/domain/store";
import type { OrderItem } from "../../src/domain/order";
import type { EpochMillis } from "../../src/engine/types";
import { schedulingDefaults } from "../storeConfigDefaults";

const NOW = Date.now() as EpochMillis;
const PRESETS: readonly NoodlePreset[] = [
  { noodleType: "REG", boilSeconds: { extraHard: 150, hard: 270, normal: 420, soft: 540 } },
];
const PARAMS = { ...schedulingDefaults(2), planner: "ts" as const };

function queue(count: number): readonly OrderItem[] {
  return Array.from({ length: count }, (_, index) => ({
    externalOrderId: `POS-${index}`,
    itemIndex: 0,
    noodleType: "REG",
    firmness: "normal" as const,
    tableId: index % 2 === 0 ? "t-a" : "t-b",
    arrivalTime: (NOW - (count - index) * 30_000) as EpochMillis,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
  }));
}

/** 配置を比較できる形へ（品目 → 釜と開始時刻）。時刻は `now` を跨ぐので相対では比べない。 */
function placements(schedule: {
  readonly slices: readonly { readonly placements: readonly unknown[] }[];
}) {
  return schedule.slices
    .flatMap(
      (slice) =>
        slice.placements as {
          externalOrderId: string;
          itemIndex: number;
          slotIds: readonly string[];
        }[],
    )
    .map(
      (placement) =>
        `${placement.externalOrderId}#${placement.itemIndex}@${[...placement.slotIds].join(",")}`,
    )
    .sort();
}

describe("Solver_Worker の解は engine の自前解と同一である", () => {
  for (const count of [3, 8, 20]) {
    it(`待ち行列 ${count} 件で、置いた品目と釜が一致する`, () => {
      const pending = queue(count);
      const request: PlanRequest = {
        storeId: "identity",
        pending,
        running: [],
        params: PARAMS,
        noodlePresets: PRESETS,
        digest: 0,
        shownPlan: EMPTY_SHOWN_PLAN,
      };
      const solved = searchPlan(request, Date.now() + 10_000);
      const own = committedSchedule([], pending, [], NOW, PRESETS, PARAMS, null);

      expect(solved).not.toBeNull();
      expect(placements(solved!)).toEqual(placements(own));
    });
  }

  it("**その解は `admit` に採用されない**（同値は棄却）——送っても費用が増えるだけである", () => {
    const pending = queue(8);
    const request: PlanRequest = {
      storeId: "identity",
      pending,
      running: [],
      params: PARAMS,
      noodlePresets: PRESETS,
      digest: 0,
      shownPlan: EMPTY_SHOWN_PLAN,
    };
    const solved = searchPlan(request, Date.now() + 10_000);
    const committed = committedSchedule([], pending, [], NOW, PRESETS, PARAMS, null);

    expect(admit(solved!, committed, pending, [], EMPTY_SHOWN_PLAN, NOW, PRESETS, PARAMS)).toEqual(
      [],
    );
  });
});
