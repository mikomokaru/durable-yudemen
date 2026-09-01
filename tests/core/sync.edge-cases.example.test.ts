import { describe, expect, it } from "vitest";
import { formSyncSets, synchronize, type SyncParams } from "../../src/engine/sync";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { nonEmpty } from "../nonEmpty";

const PARAMS = { arms: 2, toleranceRatio: 10 } satisfies SyncParams;
const FIRST_INTERSECTION = { left: 9_900, right: 10_100 } as const;
const RESIDUAL_INTERSECTION = { left: 10_000, right: 10_200 } as const;

function runningTimer(input: {
  readonly id: string;
  readonly slotId: string;
  readonly endTime: number;
  readonly seq: number;
  readonly adjustment: number;
}): Timer {
  return createTimer({
    id: input.id as TimerId,
    slotIds: nonEmpty([input.slotId as SlotId]),
    noodleType: "ramen" as NoodleType,
    firmness: "normal",
    startTime: (input.endTime - 1_000) as EpochMillis,
    endTime: input.endTime as EpochMillis,
    seq: input.seq,
    adjustment: input.adjustment,
  });
}

describe("engine/sync — example and edge cases", () => {
  it("Requirements 1.8: 空の running 集合は空のまま返す", () => {
    expect(synchronize([], PARAMS)).toEqual([]);
  });

  it("Requirements 2.2, 2.6, 3.4: arms=2 で同着順に分割し、残余を最遠端へ離す", () => {
    const sameEndLaterSeq = runningTimer({
      id: "same-end-later-seq",
      slotId: "0",
      endTime: 10_000,
      seq: 20,
      adjustment: 45,
    });
    const residual = runningTimer({
      id: "residual",
      slotId: "2",
      endTime: 10_100,
      seq: 30,
      adjustment: -55,
    });
    const sameEndEarlierSeq = runningTimer({
      id: "same-end-earlier-seq",
      slotId: "1",
      endTime: 10_000,
      seq: 10,
      adjustment: 25,
    });
    const running = [sameEndLaterSeq, residual, sameEndEarlierSeq];

    const sets = formSyncSets(running, PARAMS);
    expect(sets.map((set) => set.map((timer) => timer.id))).toEqual([
      [sameEndEarlierSeq.id, sameEndLaterSeq.id],
      [residual.id],
    ]);

    const synchronizedById = new Map(
      synchronize(running, PARAMS).map((timer) => [timer.id, timer]),
    );
    const synchronizedTimer = (id: TimerId): Timer => {
      const timer = synchronizedById.get(id);
      if (timer === undefined) throw new Error(`同期結果に ${id} が存在しない`);
      return timer;
    };
    const earlierResult = synchronizedTimer(sameEndEarlierSeq.id);
    const laterResult = synchronizedTimer(sameEndLaterSeq.id);
    const residualResult = synchronizedTimer(residual.id);
    const firstTarget = earlierResult.endTime + earlierResult.adjustment;
    const laterSameTarget = laterResult.endTime + laterResult.adjustment;
    const residualTarget = residualResult.endTime + residualResult.adjustment;

    // 両区間の最遠端を選ぶため、maximin の一意解は 9,900ms と 10,200ms になる。
    expect(firstTarget).toBe(9_900);
    expect(laterSameTarget).toBe(firstTarget);
    expect(residualTarget).toBe(10_200);
    expect(residualTarget - firstTarget).toBe(300);
    expect(residualTarget).toBeGreaterThan(firstTarget);

    expect(firstTarget).toBeGreaterThanOrEqual(FIRST_INTERSECTION.left);
    expect(firstTarget).toBeLessThanOrEqual(FIRST_INTERSECTION.right);
    expect(residualTarget).toBeGreaterThanOrEqual(RESIDUAL_INTERSECTION.left);
    expect(residualTarget).toBeLessThanOrEqual(RESIDUAL_INTERSECTION.right);

    expect(running.map((timer) => timer.adjustment)).toEqual([45, -55, 25]);
    expect([laterResult.adjustment, residualResult.adjustment, earlierResult.adjustment]).toEqual([
      -100, 100, -100,
    ]);
  });
});
