import { describe, expect, it } from "vitest";
// `?raw` の default は vite/client の `declare module '*?raw'` が与えるため tsc は通る。oxlint の resolver はその宣言を
// 読まず `?raw` を落として実ファイルへ解決するので、実在する .ts を指すときだけ default 無しと誤判定する。
// oxlint-disable-next-line import/default
import deriveSource from "../../src/operation-history/derive.ts?raw";
import {
  recordsFromCommittedDiff,
  type OperationObservation,
} from "../../src/operation-history/derive";
import { createTimer } from "../../src/engine/timer";
import type { Timer } from "../../src/engine/timer";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import type { Firmness } from "../../src/domain/firmness";
import { nonEmpty } from "../nonEmpty";

const EVENT_TIME = 1_700_000_100_000;
const START_TIME = 1_700_000_000_000;

function timer(
  id: string,
  input: {
    readonly firmness?: Firmness;
    readonly endTime?: number;
    readonly adjustment?: number;
    readonly boiledAt?: number | null;
    readonly seq?: number;
  } = {},
): Timer {
  return createTimer({
    id: id as TimerId,
    slotIds: nonEmpty([`slot-${id}` as SlotId]),
    noodleType: "Thin" as NoodleType,
    firmness: input.firmness ?? "normal",
    startTime: START_TIME as EpochMillis,
    endTime: (input.endTime ?? START_TIME + 60_000) as EpochMillis,
    ...(input.adjustment === undefined ? {} : { adjustment: input.adjustment }),
    ...(input.boiledAt === undefined
      ? {}
      : { boiledAt: input.boiledAt === null ? null : (input.boiledAt as EpochMillis) }),
    seq: input.seq ?? 0,
  });
}

function state(timers: readonly Timer[]): TimerState {
  return { ...EMPTY_STATE, timers, nextSeq: timers.length };
}

function observation(
  eventKind: OperationObservation["eventKind"],
  before: readonly Timer[],
  after: readonly Timer[],
): OperationObservation {
  return {
    storeId: "store-1",
    eventTime: EVENT_TIME,
    eventKind,
    before: state(before),
    after: state(after),
  };
}

describe("recordsFromCommittedDiff", () => {
  it("Start の追加を after 事実と実効 endTime から一件導出する", () => {
    const existing = timer("existing");
    const added = timer("added", { adjustment: -8_000, seq: 1 });

    expect(recordsFromCommittedDiff(observation("Start", [existing], [existing, added]))).toEqual([
      {
        storeId: "store-1",
        timerId: "added",
        eventTime: EVENT_TIME,
        slotIds: ["slot-added"],
        noodleType: "Thin",
        firmness: "normal",
        operationKind: "boil-started",
        startTime: START_TIME,
        endTime: START_TIME + 52_000,
      },
    ]);
  });

  it.each([
    ["Complete", "completed"],
    ["Cancel", "cancelled"],
  ] as const)("%s の除去を before 事実から導出する", (eventKind, operationKind) => {
    const removed = timer("removed", { firmness: "hard" });

    expect(recordsFromCommittedDiff(observation(eventKind, [removed], []))).toEqual([
      {
        storeId: "store-1",
        timerId: "removed",
        eventTime: EVENT_TIME,
        slotIds: ["slot-removed"],
        noodleType: "Thin",
        firmness: "hard",
        operationKind,
      },
    ]);
  });

  it("Adjust の firmness または実効 endTime が変わった差分だけを after 事実から導出する", () => {
    const unchanged = timer("unchanged", { seq: 0 });
    const beforeFirmness = timer("firmness", { seq: 1 });
    const afterFirmness = timer("firmness", { firmness: "hard", seq: 1 });
    const beforeEndTime = timer("end-time", { seq: 2 });
    const afterEndTime = timer("end-time", { endTime: START_TIME + 55_000, seq: 2 });
    const beforeResynchronized = timer("resynchronized", { seq: 3 });
    const afterResynchronized = timer("resynchronized", { adjustment: -5_000, seq: 3 });

    const records = recordsFromCommittedDiff(
      observation(
        "Adjust",
        [unchanged, beforeFirmness, beforeEndTime, beforeResynchronized],
        [unchanged, afterFirmness, afterEndTime, afterResynchronized],
      ),
    );

    expect(
      records.map((record) => [record.timerId, record.operationKind, record.eventTime]),
    ).toEqual([
      ["firmness", "adjusted", EVENT_TIME],
      ["end-time", "adjusted", EVENT_TIME],
      ["resynchronized", "adjusted", EVENT_TIME],
    ]);
    expect(records[0]).toMatchObject({
      timerId: "firmness",
      slotIds: ["slot-firmness"],
      firmness: "hard",
      endTime: START_TIME + 60_000,
    });
    expect(records[1]).toMatchObject({ timerId: "end-time", endTime: START_TIME + 55_000 });
    expect(records[2]).toMatchObject({ timerId: "resynchronized", endTime: START_TIME + 55_000 });
  });

  it.each(["AlarmFired", "Reconcile"] as const)(
    "%s の running → boiled を after 順・同一 Event Time で一差分一件導出する",
    (eventKind) => {
      const beforeFirst = timer("first", { seq: 0 });
      const beforeSecond = timer("second", { seq: 1 });
      const alreadyBoiled = timer("already", { boiledAt: EVENT_TIME - 1, seq: 2 });
      const afterFirst = timer("first", { boiledAt: EVENT_TIME, seq: 0 });
      const afterSecond = timer("second", {
        firmness: "hard",
        adjustment: -7_000,
        boiledAt: EVENT_TIME + 1,
        seq: 1,
      });

      const records = recordsFromCommittedDiff(
        observation(
          eventKind,
          [beforeFirst, beforeSecond, alreadyBoiled],
          [afterSecond, alreadyBoiled, afterFirst],
        ),
      );

      expect(
        records.map((record) => [record.timerId, record.operationKind, record.eventTime]),
      ).toEqual([
        ["second", "boiled", EVENT_TIME],
        ["first", "boiled", EVENT_TIME],
      ]);
      expect(records[0]).toMatchObject({
        timerId: "second",
        firmness: "hard",
        endTime: START_TIME + 53_000,
        boiledAt: EVENT_TIME + 1,
      });
    },
  );

  it("Reconcile は running → boiled 以外の差分を出力対象にしない", () => {
    const running = timer("running");
    const resynchronized = timer("running", { adjustment: -5_000 });
    const addedBoiled = timer("added", { boiledAt: EVENT_TIME, seq: 1 });

    expect(
      recordsFromCommittedDiff(observation("Reconcile", [running], [resynchronized, addedBoiled])),
    ).toEqual([]);
  });

  it.each(["Start", "Adjust", "Complete", "Cancel", "AlarmFired", "Reconcile"] as const)(
    "%s の拒否・no-opを表す確定差分なし入力は 0 件を返す",
    (eventKind) => {
      const unchanged = timer("unchanged");
      expect(recordsFromCommittedDiff(observation(eventKind, [unchanged], [unchanged]))).toEqual(
        [],
      );
    },
  );

  it("純粋導出から Reconcile、Persist、または platform 作用を起動する依存経路を持たない", () => {
    const imports = [...deriveSource.matchAll(/^import(?: type)? .* from "([^"]+)";$/gm)].map(
      (match) => match[1],
    );

    expect(imports).toEqual([
      "../engine/project",
      "../engine/state",
      "../engine/timer",
      "../domain/timer",
      "./record",
    ]);
    expect(deriveSource).not.toMatch(/\b(?:decide|reconcile|fetch|setAlarm|put|waitUntil)\s*\(/);
    expect(deriveSource).not.toMatch(/\b(?:console|storage|ctx|env)\s*\./);
  });
});
