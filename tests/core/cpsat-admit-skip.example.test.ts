// tests/core/cpsat-admit-skip.example.test.ts — **CP-SAT モードは通らない一片を飛ばして続ける**。
//
// **Validates: cpsat-planner-integration R5.4, ADR-0016**
//
// 実データでは 1 伝票に麺が 2〜4 杯あり、CP-SAT はそれらを別々の時刻に置く。すると釜の時刻が
// 片をまたいで交錯し、**接頭辞（最初に落ちた一片以降を捨てる）では後続が道連れになる**。
// 実測（空き釜 4 本）では届いた一片の 24% がこれで落ちていた——現場からは「出ていた提案が
// 取り下げられた」に見える（2026-09-15 のユーザー観察）。
//
// **TS モードは接頭辞のまま**である（尾部を自前解で埋めるので飛ばす必要がない）。
import { describe, expect, it } from "vitest";
import { admitDetailed } from "../../src/engine/admit";
import { committedSchedule } from "../../src/engine/commit";
import type { CookSchedule } from "../../src/engine/schedule";
import { EMPTY_SHOWN_PLAN } from "../../src/engine/stability";
import type { NoodlePreset } from "../../src/domain/store";
import { pendingOrders, type OrderItem } from "../../src/domain/order";
import { tableKeyOf } from "../../src/engine/project";
import type { EpochMillis, SlotId } from "../../src/engine/types";
import { nonEmpty } from "../nonEmpty";
import { schedulingDefaults } from "../storeConfigDefaults";

const NOW = 1_700_000_000_000 as EpochMillis;
const BOIL = 420_000;
const PRESETS: readonly NoodlePreset[] = [
  { noodleType: "REG", boilSeconds: { extraHard: 150, hard: 270, normal: 420, soft: 540 } },
];

/** 伝票ごとに 1 杯（卓なし＝伝票が群の鍵）。 */
function queue(count: number): readonly OrderItem[] {
  return Array.from({ length: count }, (_unused, index) => ({
    externalOrderId: `POS-${index}`,
    itemIndex: 0,
    noodleType: "REG",
    firmness: "normal" as const,
    tableId: null,
    arrivalTime: (NOW - (count - index) * 30_000) as EpochMillis,
    portions: 1,
    itemName: null,
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
    tableAssignedAt: null,
  }));
}

/**
 * **釜の時刻が交錯する計画**を組む。片 0 が釜 0 を遅い時刻で使い、片 1 が同じ釜を早い時刻で使う。
 * どちらも単体では実行可能で、**採る順序だけが噛み合っていない**（釜 0 は 0〜420 秒と
 * 600〜1020 秒で連続して使える）。片 2 は別の釜で、接頭辞では片 1 の道連れになる。
 */
function crossingPlan(items: readonly OrderItem[]): CookSchedule {
  const at = (offsetMs: number) => ({
    startAt: (NOW + offsetMs) as EpochMillis,
    serveAt: (NOW + offsetMs + BOIL) as EpochMillis,
    anchor: null,
  });
  const slice = (item: OrderItem, slot: string, offsetMs: number) => ({
    tableKey: tableKeyOf(item),
    placements: [
      {
        externalOrderId: item.externalOrderId,
        itemIndex: item.itemIndex,
        slotIds: nonEmpty([slot as SlotId]),
        ...at(offsetMs),
      },
    ],
  });
  return {
    slices: [slice(items[0]!, "0", 600_000), slice(items[1]!, "0", 0), slice(items[2]!, "1", 0)],
  };
}

function decide(planner: "ts" | "cpsat") {
  const params = { ...schedulingDefaults(2), planner };
  const pending = queue(3);
  const live = pendingOrders(pending, [], NOW);
  const committed = committedSchedule([], live, [], NOW, PRESETS, params, null);
  return admitDetailed(
    crossingPlan(live),
    committed,
    live,
    [],
    EMPTY_SHOWN_PLAN,
    NOW,
    PRESETS,
    params,
  );
}

describe("釜の時刻が片をまたいで交錯する計画", () => {
  it("**CP-SAT モードは落ちた片を飛ばし、後続を採る**", () => {
    const outcome = decide("cpsat");
    // 片 0（釜 0 を 600 秒から）と片 2（釜 1）は採れる。片 1 は釜 0 が塞がっているので落ちる。
    expect(outcome.slices).toHaveLength(2);
    // **段は「飛ばした理由」を残す**——採用が起きたことで観測が消えない。
    expect(outcome.stage).toBe("release");
  });

  it("**TS モードは接頭辞のまま**（落ちたらそこで止める・尾部が作り直す）", () => {
    const outcome = decide("ts");
    expect(outcome.slices.length).toBeLessThanOrEqual(1);
  });
});
