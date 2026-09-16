import { afterEach, describe, expect, it, vi } from "vitest";
import { operationRecordPayload } from "../../src/operation-history/codec";
import type { OperationObservation } from "../../src/operation-history/derive";
import { tryWriteOperationLines } from "../../src/operation-history/producer";
import { createTimer } from "../../src/engine/timer";
import type { Timer } from "../../src/engine/timer";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { nonEmpty } from "../nonEmpty";

const EVENT_TIME = 1_700_000_100_000;
const START_TIME = 1_700_000_000_000;

function timer(id: string, boiledAt: number | null, seq: number): Timer {
  return createTimer({
    id: id as TimerId,
    slotIds: nonEmpty([`slot-${id}` as SlotId]),
    noodleType: "Thin" as NoodleType,
    firmness: "normal",
    startTime: START_TIME as EpochMillis,
    endTime: (START_TIME + 60_000) as EpochMillis,
    boiledAt: boiledAt === null ? null : (boiledAt as EpochMillis),
    seq,
  });
}

function state(timers: readonly Timer[]): TimerState {
  return { ...EMPTY_STATE, timers, nextSeq: timers.length };
}

function boiledObservation(): OperationObservation {
  return {
    storeId: "store-1",
    eventTime: EVENT_TIME,
    eventKind: "AlarmFired",
    before: state([timer("first", null, 0), timer("second", null, 1)]),
    after: state([timer("first", EVENT_TIME, 0), timer("second", EVENT_TIME + 1, 1)]),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tryWriteOperationLines", () => {
  it("OFF時はrecord構築前に同期returnする", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const observation = {
      get storeId(): string {
        throw new Error("record construction must not start");
      },
    } as OperationObservation;

    expect(tryWriteOperationLines(false, observation)).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it("recordごとに payload 一引数を一回だけ同期出力する", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const observation = boiledObservation();

    expect(tryWriteOperationLines(true, observation)).toBeUndefined();

    const expected = observation.after.timers.map((afterTimer, index) =>
      operationRecordPayload({
        storeId: "store-1",
        timerId: afterTimer.id,
        operationKind: "boiled",
        eventTime: EVENT_TIME as never,
        slotIds: afterTimer.slotIds,
        noodleType: afterTimer.noodleType,
        firmness: afterTimer.firmness,
        endTime: afterTimer.endTime as never,
        boiledAt: (EVENT_TIME + index) as never,
      }),
    );
    expect(log.mock.calls).toEqual(expected.map((payload) => [payload]));
  });

  it("一件のconsole失敗後も後続recordを各一回試行し再試行しない", () => {
    const log = vi
      .spyOn(console, "log")
      .mockImplementationOnce(() => {
        throw new Error("console failed");
      })
      .mockImplementation(() => undefined);

    expect(() => tryWriteOperationLines(true, boiledObservation())).not.toThrow();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("直列化できない値を持つ record も出し、判定を Tail へ委ねる", () => {
    // **文字列時代との違い。** 以前は Producer が canonical へ組む途中で例外になり、その record だけが
    // 消えていた。今は組まずに渡すので、両方が console へ出る。**値が不正であることの判定は Tail 側の
    // 検査の仕事**で、そこで理由付きの失敗として数えられる（tests/lift-delay・tail の検査）。
    // Producer 側に判定を戻さないのは、判定を二箇所に置かないためである。
    const observation = boiledObservation();
    const invalidSlots = [1n] as unknown as Timer["slotIds"];
    const first = { ...observation.after.timers[0]!, slotIds: invalidSlots };
    const after = state([first, observation.after.timers[1]!]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(() => tryWriteOperationLines(true, { ...observation, after })).not.toThrow();
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.map((call) => call.length)).toEqual([1, 1]);
    const payloads = log.mock.calls.map(([payload]) => payload as Record<string, unknown>);
    expect(payloads[0]?.slotIds).toEqual([1n]);
    expect(payloads[1]?.timerId).toBe("second");
  });

  it("record構築失敗を伝播させずconsoleへ別行を出さない", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(() =>
      tryWriteOperationLines(true, { ...boiledObservation(), eventTime: 0 }),
    ).not.toThrow();
    expect(log).not.toHaveBeenCalled();
  });
});
