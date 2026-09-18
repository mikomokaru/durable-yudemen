// tests/core/cpsat-plan-retention.example.test.ts — **CP-SAT モードで画面が空にならない**ことを固定する。
//
// **Validates: cpsat-planner-integration R1.4, R5.9**
//
// **これは本番で画面が空だった欠陥の回帰試験である**（2026-09-13・`yamaokaya-1108` の観測）。
//
// 計画は `CPSAT_DELIVERY_LEAD_MS` だけ先から始まる。人がその時刻に始めなければ先頭の配置は
// 過去開始になり、旧い実装では `cannotStart` が**一片の列を打ち切った**——CP-SAT モードには
// 尾部の自前解が無い（R1.4）ので、**届いてから 8 秒で全 24 片が消えた**。注文が 10〜20 分に
// 1 件の店では、画面はほぼ常に空だった。
//
// 直しは 2 つで、どちらも「一片ごと全部落とす」をやめるものである。
//   1. **滑らせる**（`retimed`）——先頭が過去にならないよう、保持中の計画を全体で同じ幅だけ
//      後ろへ倒す。相対関係は保たれる。
//   2. **杯ごとに落とす**（`retainedSlice`）——開始・完了で計画対象から外れた配置だけを除く。
//
// **物理の検査は一つも省いていない。** 滑らせた上で解放表・上げ表・錨を当て直す（`livePrefix`）。
import { describe, expect, it } from "vitest";
import { admitDetailed } from "../../src/engine/admit";
import { committedSchedule } from "../../src/engine/commit";
import { baselineSchedule, initialRelease } from "../../src/engine/schedule";
import { initialLifts } from "../../src/engine/lift";
import { tableMembers } from "../../src/engine/project";
import { EMPTY_SHOWN_PLAN } from "../../src/engine/stability";
import { occupiedSlotsOf, type NoodlePreset } from "../../src/domain/store";
import { pendingOrders, type OrderItem } from "../../src/domain/order";
import { CPSAT_DELIVERY_LEAD_MS } from "../../src/cpsat/request";
import type { Timer } from "../../src/engine/timer";
import type { EpochMillis } from "../../src/engine/types";
import { schedulingDefaults } from "../storeConfigDefaults";

const NOW = 1_700_000_000_000 as EpochMillis;
const PRESETS: readonly NoodlePreset[] = [
  { noodleType: "REG", boilSeconds: { extraHard: 150, hard: 270, normal: 420, soft: 540 } },
];
/** **CP-SAT モードの規則で見る**（R1.4）。TS モードは尾部が埋めるのでこの欠陥を持たない。 */
const PARAMS = { ...schedulingDefaults(2), planner: "cpsat" as const };
const COUNT = 24;

/** 卓が分からない受注（実データの多数派）。1 伝票 1 杯ゆえ群は品目ごとに 1 つ。 */
function queue(count: number): readonly OrderItem[] {
  return Array.from({ length: count }, (_, index) => ({
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

/** 採用済みの計画（本番と同じく lead だけ先から置いたものを、受領時刻 NOW で採る）。 */
function adopted() {
  const pending = queue(COUNT);
  const live = pendingOrders(pending, [], NOW);
  const slots = PARAMS.unitOrigins.length * 6;
  const from = (NOW + CPSAT_DELIVERY_LEAD_MS) as EpochMillis;
  const arrived = baselineSchedule(
    live,
    initialRelease([], from, slots),
    tableMembers([]),
    initialLifts([]),
    PRESETS,
    PARAMS,
    from,
    occupiedSlotsOf([]),
    null,
  );
  const committed = committedSchedule([], live, [], NOW, PRESETS, PARAMS, null);
  const outcome = admitDetailed(
    arrived,
    committed,
    live,
    [],
    EMPTY_SHOWN_PLAN,
    NOW,
    PRESETS,
    PARAMS,
  );
  return { pending, accepted: outcome.slices };
}

/** `at` の時点で画面に出る配置の数（`committedSchedule` が導出するもの＝正本）。 */
function onScreen(
  accepted: ReturnType<typeof adopted>["accepted"],
  pending: readonly OrderItem[],
  running: readonly Timer[],
  at: EpochMillis,
): number {
  const live = pendingOrders(pending, running, at);
  const screen = committedSchedule(accepted, live, running, at, PRESETS, PARAMS, null);
  return screen.slices.reduce((count, slice) => count + slice.placements.length, 0);
}

describe("CP-SAT モードの保持——画面が空にならない", () => {
  it("**時間が経つだけでは 1 杯も消えない**（旧実装は lead を過ぎた瞬間に全滅した）", () => {
    const { pending, accepted } = adopted();
    expect(accepted).toHaveLength(COUNT);

    // lead の内側。ここは旧実装でも出ていた。
    expect(onScreen(accepted, pending, [], (NOW + 5_000) as EpochMillis)).toBe(COUNT);
    // **lead を過ぎた直後。旧実装はここで 0 になった。**
    expect(
      onScreen(accepted, pending, [], (NOW + CPSAT_DELIVERY_LEAD_MS + 1_000) as EpochMillis),
    ).toBe(COUNT);
    // 5 分後。注文が 10〜20 分に 1 件の店では、ここが常態である。
    expect(onScreen(accepted, pending, [], (NOW + 300_000) as EpochMillis)).toBe(COUNT);
  });

  it("**1 杯開始したら、その 1 杯だけ消える**（残りは道連れにならない）", () => {
    const { pending, accepted } = adopted();
    const head = accepted[0]!.placements[0]!;
    const started = {
      id: "t1",
      slotIds: [head.slotIds[0]],
      noodleType: "REG",
      firmness: "normal",
      startTime: NOW,
      endTime: NOW + 420_000,
      adjustment: 0,
      boiledAt: null,
      completedAt: null,
      seq: 1,
      orderItem: {
        externalOrderId: head.externalOrderId,
        itemIndex: head.itemIndex,
        tableId: null,
      },
    } as unknown as Timer;

    expect(onScreen(accepted, pending, [started], (NOW + 1_000) as EpochMillis)).toBe(COUNT - 1);
    // 時間が経っても残りは残る（滑りと杯ごとの除去が両方効いている）。
    expect(onScreen(accepted, pending, [started], (NOW + 300_000) as EpochMillis)).toBe(COUNT - 1);
  });
});
