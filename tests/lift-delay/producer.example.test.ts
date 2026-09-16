// 遅延ログの Producer。確定差分から出る行と、出ない場合を固定する。

import { describe, expect, it, vi } from "vitest";
// Producer が出す payload の契約は、いまや Tail 側の検査そのものである。文字列の parser ではなく
// この schema で確かめることで、「Producer が出したものを Tail が通す」ことを 1 本の検査で押さえる。
import {
  liftDelayRecordSchema,
  liftDelayStartRecordSchema,
} from "../../src/data-platform/record-schema";
import {
  liftDelayLinesFromCommittedDiff,
  tryWriteLiftDelayLines,
  type LiftDelayObservation,
} from "../../src/lift-delay/producer";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { nonEmpty } from "../nonEmpty";

const START = 1_700_000_000_000;

const timerOf = (id: string, startTime = START): Timer =>
  createTimer({
    id: id as TimerId,
    slotIds: nonEmpty(["4" as SlotId]),
    noodleType: "REG" as NoodleType,
    firmness: "normal",
    startTime: startTime as EpochMillis,
    endTime: (startTime + 90_000) as EpochMillis,
    seq: 1,
    boiledAt: null,
  });

const stateWith = (timers: readonly Timer[]): TimerState => ({ ...EMPTY_STATE, timers });

const observationOf = (patch: Partial<LiftDelayObservation> = {}): LiftDelayObservation => ({
  storeId: "store-1",
  eventTime: START + 105_000,
  eventKind: "Complete",
  before: stateWith([timerOf("timer-1")]),
  after: EMPTY_STATE,
  ...patch,
});

describe("確定差分から出る行", () => {
  it("開始では開始の行を 1 本出す", () => {
    const lines = liftDelayLinesFromCommittedDiff(
      observationOf({
        eventKind: "Start",
        eventTime: START,
        before: EMPTY_STATE,
        after: stateWith([timerOf("timer-1")]),
        pendingBeforeStart: [{ externalOrderId: "order-1", itemIndex: 0 }],
      }),
    );

    expect(lines).toHaveLength(1);
    const parsed = liftDelayStartRecordSchema.safeParse(lines[0]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({
      storeId: "store-1",
      timerId: "timer-1",
      startedAt: START,
      source: "ad-hoc",
      pendingBeforeStart: 1,
    });
  });

  it("品目からの開始では注文由来として記録する", () => {
    const lines = liftDelayLinesFromCommittedDiff(
      observationOf({
        eventKind: "StartOrderItem",
        eventTime: START,
        before: EMPTY_STATE,
        after: stateWith([timerOf("timer-1")]),
        pendingBeforeStart: [
          { externalOrderId: "order-1", itemIndex: 0 },
          { externalOrderId: "order-1", itemIndex: 1 },
        ],
        startedOrderItem: { externalOrderId: "order-1", itemIndex: 0 },
      }),
    );

    const parsed = liftDelayStartRecordSchema.safeParse(lines[0]);
    expect(parsed.success && parsed.data).toMatchObject({
      source: "order-item",
      pendingBeforeStart: 2,
      pendingOtherItems: 1,
    });
  });

  it("完了では終端の行を出し、原時刻を持つ", () => {
    const lines = liftDelayLinesFromCommittedDiff(observationOf());

    const parsed = liftDelayRecordSchema.safeParse(lines[0]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toMatchObject({
      outcome: "completed",
      timerId: "timer-1",
      startedAt: START,
      dueAt: START + 90_000,
      terminalAt: START + 105_000,
      eventId: "store-1:timer-1:completed",
    });
  });

  it("取消も終端の行として残す", () => {
    const lines = liftDelayLinesFromCommittedDiff(observationOf({ eventKind: "Cancel" }));

    const parsed = liftDelayRecordSchema.safeParse(lines[0]);
    expect(parsed.success && parsed.data.outcome).toBe("cancelled");
  });

  it("除かれた Timer が無ければ何も出さない", () => {
    const unchanged = stateWith([timerOf("timer-1")]);

    expect(
      liftDelayLinesFromCommittedDiff(observationOf({ before: unchanged, after: unchanged })),
    ).toEqual([]);
  });

  it("一括完了では除かれた Timer の数だけ出す", () => {
    const lines = liftDelayLinesFromCommittedDiff(
      observationOf({
        before: stateWith([timerOf("timer-1"), timerOf("timer-2"), timerOf("timer-3")]),
        after: stateWith([timerOf("timer-3")]),
      }),
    );

    expect(lines).toHaveLength(2);
    expect(
      lines.map((payload) => {
        const parsed = liftDelayRecordSchema.safeParse(payload);
        return parsed.success ? parsed.data.timerId : null;
      }),
    ).toEqual(["timer-1", "timer-2"]);
  });
});

describe("出力の境界", () => {
  it("無効なら 1 行も出さない", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      tryWriteLiftDelayLines(false, observationOf());
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("有効なら payload を console へ出し、それが Tail の検査を通る", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      tryWriteLiftDelayLines(true, observationOf());

      expect(log).toHaveBeenCalledTimes(1);
      const [payload] = log.mock.calls[0] ?? [];
      expect(liftDelayRecordSchema.safeParse(payload).success).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it("console が投げても外へ伝播しない", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("console unavailable");
    });
    try {
      // 記録の失敗で厨房操作を失敗させない（要件 4.2）。
      expect(() => tryWriteLiftDelayLines(true, observationOf())).not.toThrow();
    } finally {
      log.mockRestore();
    }
  });

  it("1 行が失敗しても残りを出す", () => {
    let calls = 0;
    const log = vi.spyOn(console, "log").mockImplementation(() => {
      calls += 1;
      if (calls === 1) throw new Error("first line failed");
    });
    try {
      tryWriteLiftDelayLines(
        true,
        observationOf({
          before: stateWith([timerOf("timer-1"), timerOf("timer-2")]),
          after: EMPTY_STATE,
        }),
      );

      expect(calls).toBe(2);
    } finally {
      log.mockRestore();
    }
  });
});
