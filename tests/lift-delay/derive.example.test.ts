// 遅延記録の導出。二つの時点を混ぜないこと、不明を埋めないことを固定する。

import { describe, expect, it } from "vitest";
import { startContextOf, startRecordOf, terminalRecordOf } from "../../src/lift-delay/derive";
import {
  parseLiftDelayLine,
  parseLiftDelayStartLine,
  printCanonicalLiftDelayStartLine,
} from "../../src/lift-delay/codec";
import { completionDelayMs } from "../../src/lift-delay/record";
import { createTimer } from "../../src/engine/timer";
import type { Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { nonEmpty } from "../nonEmpty";
import type { ShownPlan } from "../../src/engine/stability";

const START = 1_700_000_000_000;

const timerOf = (
  patch: {
    readonly slotIds?: readonly string[];
    readonly startTime?: number;
    readonly adjustment?: number;
  } = {},
): Timer => {
  // 既存テストと同じ作法で、ブランド型は生成の一点で明示する（tests/core の runningTimer）。
  const slotIds = (patch.slotIds ?? ["4"]).map((slotId) => slotId as SlotId);
  const timer = createTimer({
    id: "timer-1" as TimerId,
    slotIds: nonEmpty(slotIds),
    noodleType: "REG" as NoodleType,
    firmness: "normal",
    startTime: (patch.startTime ?? START) as EpochMillis,
    endTime: (START + 90_000) as EpochMillis,
    seq: 1,
    boiledAt: null,
  });
  return patch.adjustment === undefined ? timer : { ...timer, adjustment: patch.adjustment };
};

const item = (itemIndex: number) => ({ externalOrderId: "order-1", itemIndex });

const shownPlan = (mates: number): ShownPlan =>
  [
    {
      externalOrderId: "order-1",
      itemIndex: 1,
      slotIds: ["4"],
      startAt: START,
      serveAt: START + 180_000,
      anchor: null,
      mates: Array.from({ length: mates }, (_unused, index) => ({
        externalOrderId: "order-2",
        itemIndex: index,
      })),
    },
  ] as unknown as ShownPlan;

describe("開始時点の文脈", () => {
  it("未着手の件数と、対象自身を除いた件数を分けて持つ", () => {
    const context = startContextOf({
      startedAt: START,
      orderItem: item(1),
      pending: [item(1), item(2), item(3)],
      activeTimers: [{ slotIds: ["1"] }, { slotIds: ["2", "3"] }],
      shownPlan: [],
    });

    expect(context).toMatchObject({
      kind: "recorded",
      source: "order-item",
      pendingBeforeStart: 3,
      pendingOtherItems: 2,
      activeTimerCount: 2,
      occupiedSlotCount: 3,
    });
  });

  it("64 件を超える未着手をそのまま数える", () => {
    // 計画対象を先頭 64 件へ絞るのは計画の都合であって、厨房が抱えている数ではない。
    const pending = Array.from({ length: 80 }, (_unused, index) => item(index));

    const context = startContextOf({
      startedAt: START,
      orderItem: item(0),
      pending,
      activeTimers: [],
      shownPlan: [],
    });

    expect(context).toMatchObject({ pendingBeforeStart: 80, pendingOtherItems: 79 });
  });

  it("アドホック開始を注文由来と区別し、対象を除く操作をしない", () => {
    const context = startContextOf({
      startedAt: START,
      orderItem: null,
      pending: [item(1), item(2)],
      activeTimers: [],
      shownPlan: shownPlan(2),
    });

    expect(context).toMatchObject({
      source: "ad-hoc",
      pendingBeforeStart: 2,
      pendingOtherItems: 2,
      shownPlacement: { kind: "absent" },
    });
  });

  it("提案にあれば配置と同群の人数を持つ", () => {
    const context = startContextOf({
      startedAt: START,
      orderItem: item(1),
      pending: [item(1)],
      activeTimers: [],
      shownPlan: shownPlan(2),
    });

    expect(context).toMatchObject({
      shownPlacement: { kind: "found", startAt: START, serveAt: START + 180_000, mates: 2 },
    });
  });

  it("提案に無ければ不明として残し、単独群と読まない", () => {
    const context = startContextOf({
      startedAt: START,
      orderItem: item(9),
      pending: [item(9)],
      activeTimers: [],
      shownPlan: shownPlan(2),
    });

    // mates: 0 ではなく absent。「提案が無かった」と「1 人の群だった」は別の事実である。
    expect(context).toMatchObject({ shownPlacement: { kind: "absent" } });
  });

  it("同じ釜を使う Timer が重なってもスロットを二重に数えない", () => {
    const context = startContextOf({
      startedAt: START,
      orderItem: null,
      pending: [],
      activeTimers: [{ slotIds: ["1", "2"] }, { slotIds: ["2"] }],
      shownPlan: [],
    });

    expect(context).toMatchObject({ activeTimerCount: 2, occupiedSlotCount: 2 });
  });

  it("適用ウェイトは未導入のままにする", () => {
    const context = startContextOf({
      startedAt: START,
      orderItem: null,
      pending: [],
      activeTimers: [],
      shownPlan: [],
    });

    expect(context).toMatchObject({ appliedWait: { kind: "not-introduced" } });
  });
});

describe("開始の 1 行", () => {
  it("業務の保存に触れず、その場で出せる形になる", () => {
    const record = startRecordOf("store-1", "timer-1", {
      startedAt: START,
      orderItem: item(1),
      pending: [item(1), item(2)],
      activeTimers: [{ slotIds: ["1"] }],
      shownPlan: shownPlan(1),
    });

    expect(record).toEqual({
      recordType: "lift-delay-start",
      // 版 2 で `orderItem` を足した（注文到着との突合・order-arrival-log）。
      payloadVersion: 2,
      eventId: "store-1:timer-1:start",
      storeId: "store-1",
      timerId: "timer-1",
      orderItem: { externalOrderId: "order-1", itemIndex: 1 },
      startedAt: START,
      source: "order-item",
      pendingBeforeStart: 2,
      pendingOtherItems: 1,
      activeTimerCount: 1,
      occupiedSlotCount: 1,
      shownPlacement: { kind: "found", startAt: START, serveAt: START + 180_000, mates: 1 },
      appliedWait: { kind: "not-introduced" },
    });
  });

  it("canonical 一行として往復する", () => {
    const record = startRecordOf("store-1", "timer-1", {
      startedAt: START,
      orderItem: null,
      pending: [],
      activeTimers: [],
      shownPlan: [],
    });
    const line = printCanonicalLiftDelayStartLine(record);
    const parsed = parseLiftDelayStartLine(line);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record).toEqual(record);
    expect(printCanonicalLiftDelayStartLine(parsed.record)).toBe(line);
  });

  it("終端の行と混ざらない", () => {
    const start = printCanonicalLiftDelayStartLine(
      startRecordOf("store-1", "timer-1", {
        startedAt: START,
        orderItem: null,
        pending: [],
        activeTimers: [],
        shownPlan: [],
      }),
    );

    // 終端の parser は開始の行を「別形式」として返し、壊れた終端として数えない。
    expect(parseLiftDelayLine(start)).toEqual({ ok: false, failure: "other-record-type" });
    expect(start).not.toContain('"operationKind"');
  });
});

describe("終端記録", () => {
  const terminalOf = (patch: Record<string, unknown> = {}) =>
    terminalRecordOf({
      storeId: "store-1",
      timer: timerOf(),
      outcome: "completed",
      terminalAt: START + 105_000,
      ...patch,
    } as Parameters<typeof terminalRecordOf>[0]);

  it("実効予定時刻を調整込みで取る", () => {
    // 調整が入った Timer では endTime そのものではなく adjustedEndTime を使う（要件 1.3）。
    expect(terminalOf({ timer: timerOf({ adjustment: 30_000 }) }).dueAt).toBe(START + 120_000);
    expect(terminalOf().dueAt).toBe(START + 90_000);
  });

  it("早め・ちょうど・遅れを同じ形で残す", () => {
    const cases = [
      [START + 80_000, -10_000],
      [START + 90_000, 0],
      [START + 600_000, 510_000],
    ] as const;

    for (const [terminalAt, expected] of cases) {
      expect(completionDelayMs(terminalOf({ terminalAt }))).toBe(expected);
    }
  });

  it("取消には遅延を割り当てない", () => {
    const cancelled = terminalOf({ outcome: "cancelled" });

    expect(completionDelayMs(cancelled)).toBeNull();
    expect(cancelled.eventId).toBe("store-1:timer-1:cancelled");
  });

  it("複数スロットをそのまま持ち、杯数に読み替えない", () => {
    const record = terminalOf({ timer: timerOf({ slotIds: ["3", "4"] }) });

    expect(record.slotIds).toEqual(["3", "4"]);
  });

  it("終端の行は文脈を載せず、原時刻だけを持つ", () => {
    // 文脈は開始の行にある。突き合わせできない麺は「文脈不明」であって、0 杯ではない。
    const record = terminalOf();

    expect(record).not.toHaveProperty("startContext");
    expect([record.startedAt, record.dueAt, record.terminalAt]).toEqual([
      START,
      START + 90_000,
      START + 105_000,
    ]);
  });

  it("開始時刻は Timer の事実から取る", () => {
    const record = terminalOf({ timer: timerOf({ startTime: START - 60_000 }) });

    expect(record.startedAt).toBe(START - 60_000);
  });
});
