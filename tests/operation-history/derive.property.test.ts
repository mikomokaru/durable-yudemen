import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Firmness } from "../../src/domain/firmness";
import { recordsFromCommittedDiff, type OperationObservation } from "../../src/operation-history/derive";
import { toWireTimer } from "../../src/engine/project";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { nonEmpty } from "../nonEmpty";

const NUM_RUNS = 200;
const FIRMNESSES: readonly Firmness[] = ["extraHard", "hard", "normal", "soft"];

type TimerSeed = {
  readonly slotId: string;
  readonly noodleType: string;
  readonly firmness: Firmness;
  readonly startTime: number;
  readonly duration: number;
  readonly adjustment: number;
  readonly changeAmount: number;
  readonly adjustKind: "firmness" | "end-time" | "both";
};

type SeededTimer = TimerSeed & { readonly id: string; readonly seq: number };

type Blueprint = {
  readonly storeId: string;
  readonly eventTime: number;
  readonly eventKind: OperationObservation["eventKind"];
  readonly shared: readonly TimerSeed[];
  readonly targets: readonly TimerSeed[];
  readonly noise: readonly TimerSeed[];
};

type Scenario = {
  readonly observation: OperationObservation;
  readonly expectedKind: "boil-started" | "boiled" | "adjusted" | "completed" | "cancelled";
  readonly sources: readonly Timer[];
};

const genIdentifier = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-"), { minLength: 1, maxLength: 16 })
  .map((characters) => characters.join(""));

const genTimerSeed: fc.Arbitrary<TimerSeed> = fc.record({
  slotId: fc.string({ minLength: 1, maxLength: 12 }),
  noodleType: fc.string({ minLength: 1, maxLength: 12 }),
  firmness: fc.constantFrom(...FIRMNESSES),
  startTime: fc.integer({ min: 1, max: 1_000_000_000 }),
  duration: fc.integer({ min: 2_001, max: 1_000_000 }),
  adjustment: fc.integer({ min: -1_000, max: 1_000 }),
  changeAmount: fc.integer({ min: 1, max: 1_000 }),
  adjustKind: fc.constantFrom("firmness", "end-time", "both"),
});

const genBlueprint: fc.Arbitrary<Blueprint> = fc.record({
  storeId: genIdentifier,
  eventTime: fc.integer({ min: 1, max: 2_000_000_000_000 }),
  eventKind: fc.constantFrom<OperationObservation["eventKind"]>(
    "Start",
    "Adjust",
    "Complete",
    "Cancel",
    "AlarmFired",
    "Reconcile",
  ),
  shared: fc.array(genTimerSeed, { maxLength: 4 }),
  targets: fc.array(genTimerSeed, { maxLength: 4 }),
  noise: fc.array(genTimerSeed, { maxLength: 3 }),
});

function seededTimers(seeds: readonly TimerSeed[], prefix: string, seqOffset: number): readonly SeededTimer[] {
  return seeds.map((seed, index) => ({ ...seed, id: `${prefix}-${index}`, seq: seqOffset + index }));
}

function nextFirmness(firmness: Firmness): Firmness {
  return FIRMNESSES[(FIRMNESSES.indexOf(firmness) + 1) % FIRMNESSES.length] ?? "normal";
}

function timer(
  seed: SeededTimer,
  changes: {
    readonly firmness?: Firmness;
    readonly endTimeDelta?: number;
    readonly adjustmentDelta?: number;
    readonly boiledAt?: number | null;
  } = {},
): Timer {
  return createTimer({
    id: seed.id as TimerId,
    slotIds: nonEmpty([seed.slotId as SlotId]),
    noodleType: seed.noodleType as NoodleType,
    firmness: changes.firmness ?? seed.firmness,
    startTime: seed.startTime as EpochMillis,
    endTime: (seed.startTime + seed.duration + (changes.endTimeDelta ?? 0)) as EpochMillis,
    adjustment: seed.adjustment + (changes.adjustmentDelta ?? 0),
    boiledAt:
      changes.boiledAt === undefined
        ? null
        : changes.boiledAt === null
          ? null
          : (changes.boiledAt as EpochMillis),
    seq: seed.seq,
  });
}

function state(timers: readonly Timer[], nextSeq: number): TimerState {
  return { ...EMPTY_STATE, timers, nextSeq };
}

function adjustedTimer(seed: SeededTimer): Timer {
  const changesFirmness = seed.adjustKind !== "end-time";
  const changesEndTime = seed.adjustKind !== "firmness";
  return timer(seed, {
    ...(changesFirmness ? { firmness: nextFirmness(seed.firmness) } : {}),
    ...(changesEndTime ? { adjustmentDelta: seed.changeAmount } : {}),
  });
}

function scenarioFromBlueprint(blueprint: Blueprint): Scenario {
  const shared = seededTimers(blueprint.shared, "shared", 0);
  const targets = seededTimers(blueprint.targets, "target", shared.length);
  const noise = seededTimers(blueprint.noise, "noise", shared.length + targets.length);
  const nextSeq = shared.length + targets.length + noise.length;
  const baseShared = shared.map((seed) => timer(seed));
  const baseTargets = targets.map((seed) => timer(seed));
  const observation = (before: readonly Timer[], after: readonly Timer[]): OperationObservation => ({
    storeId: blueprint.storeId,
    eventTime: blueprint.eventTime,
    eventKind: blueprint.eventKind,
    before: state(before, nextSeq),
    after: state(after, nextSeq),
  });

  switch (blueprint.eventKind) {
    case "Start": {
      const resynchronized = shared.map((seed) => timer(seed, { adjustmentDelta: seed.changeAmount }));
      return {
        observation: observation(baseShared, [...resynchronized, ...baseTargets]),
        expectedKind: "boil-started",
        sources: baseTargets,
      };
    }
    case "Complete":
    case "Cancel": {
      const resynchronized = shared.map((seed) => timer(seed, { adjustmentDelta: seed.changeAmount }));
      return {
        observation: observation([...baseShared, ...baseTargets], resynchronized),
        expectedKind: blueprint.eventKind === "Complete" ? "completed" : "cancelled",
        sources: baseTargets,
      };
    }
    case "Adjust": {
      const changedTargets = targets.map(adjustedTimer);
      const factPreservingNoise = noise.map((seed) =>
        timer(seed, { endTimeDelta: seed.changeAmount, adjustmentDelta: -seed.changeAmount }),
      );
      return {
        observation: observation([...baseTargets, ...baseShared, ...noise.map((seed) => timer(seed))], [
          ...changedTargets,
          ...baseShared,
          ...factPreservingNoise,
        ]),
        expectedKind: "adjusted",
        sources: changedTargets,
      };
    }
    case "AlarmFired":
    case "Reconcile": {
      const stableShared = shared.map((seed, index) =>
        timer(seed, { boiledAt: index % 2 === 0 ? blueprint.eventTime : null }),
      );
      const boiledTargets = targets.map((seed) => timer(seed, { boiledAt: blueprint.eventTime }));
      const addedBoiledNoise = noise.map((seed) => timer(seed, { boiledAt: blueprint.eventTime }));
      return {
        observation: observation([...stableShared, ...baseTargets], [
          ...addedBoiledNoise,
          ...boiledTargets,
          ...stableShared,
        ]),
        expectedKind: "boiled",
        sources: boiledTargets,
      };
    }
  }
}

function expectRecordFromSource(record: ReturnType<typeof recordsFromCommittedDiff>[number], source: Timer): void {
  const fact = toWireTimer(source);
  expect(record).toMatchObject({
    timerId: fact.id,
    slotIds: fact.slotIds,
    noodleType: fact.noodleType,
    firmness: fact.firmness,
  });

  if (record.operationKind === "boil-started") {
    expect(record.startTime).toBe(fact.startTime);
    expect(record.endTime).toBe(fact.endTime);
  } else if (record.operationKind === "boiled") {
    expect(record.endTime).toBe(fact.endTime);
    expect(record.boiledAt).toBe(source.boiledAt);
  } else if (record.operationKind === "adjusted") {
    expect(record.endTime).toBe(fact.endTime);
  }
}

describe("Property 1: 確定差分と record の一対一対応", () => {
  // **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.11, 2.12, 2.13**
  it("対象差分だけを取得元の Timer 事実と同じ Event Time で一件ずつ導出する", () => {
    fc.assert(
      fc.property(genBlueprint.map(scenarioFromBlueprint), ({ observation, expectedKind, sources }) => {
        const records = recordsFromCommittedDiff(observation);

        expect(records).toHaveLength(sources.length);
        expect(records.map((record) => record.timerId)).toEqual(sources.map((source) => source.id));
        for (const [index, record] of records.entries()) {
          expect(record.operationKind).toBe(expectedKind);
          expect(record.storeId).toBe(observation.storeId);
          expect(record.eventTime).toBe(observation.eventTime);
          expectRecordFromSource(record, sources[index] as Timer);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
