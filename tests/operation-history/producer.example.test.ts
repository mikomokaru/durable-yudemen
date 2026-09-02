import { afterEach, describe, expect, it, vi } from "vitest";
import { printCanonicalOperationLine } from "../../src/operation-history/codec";
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

  it("recordごとにcanonical line一引数を一回だけ同期出力する", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const observation = boiledObservation();

    expect(tryWriteOperationLines(true, observation)).toBeUndefined();

    const expected = observation.after.timers.map((afterTimer, index) =>
      printCanonicalOperationLine({
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
    expect(log.mock.calls).toEqual(expected.map((line) => [line]));
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

  it("一件のprinter失敗後も後続recordを出力し、診断行を追加しない", () => {
    const observation = boiledObservation();
    const invalidSlots = [1n] as unknown as Timer["slotIds"];
    const first = { ...observation.after.timers[0]!, slotIds: invalidSlots };
    const after = state([first, observation.after.timers[1]!]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(() => tryWriteOperationLines(true, { ...observation, after })).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]).toHaveLength(1);
    expect(log.mock.calls[0]?.[0]).toContain('"timerId":"second"');
  });

  it("record構築失敗を伝播させずconsoleへ別行を出さない", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(() =>
      tryWriteOperationLines(true, { ...boiledObservation(), eventTime: 0 }),
    ).not.toThrow();
    expect(log).not.toHaveBeenCalled();
  });
});
