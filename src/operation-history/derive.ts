import { toWireTimer } from "../engine/project";
import type { TimerState } from "../engine/state";
import type { Timer } from "../engine/timer";
import type { TimerFact } from "../domain/timer";
import type { OperationRecord } from "./record";

export interface OperationObservation {
  readonly storeId: string;
  readonly eventTime: number;
  readonly eventKind: "Start" | "Adjust" | "Complete" | "Cancel" | "AlarmFired" | "Reconcile";
  readonly before: TimerState;
  readonly after: TimerState;
}

type CommonRecord = Pick<
  OperationRecord,
  "storeId" | "timerId" | "eventTime" | "slotIds" | "noodleType" | "firmness"
>;
type PositiveEpochMillis = OperationRecord["eventTime"];

function positiveEpochMillis(value: number): PositiveEpochMillis {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("Operation Record の timestamp は正の安全な整数でなければならない");
  }
  return value as PositiveEpochMillis;
}

type ProjectedTimer = {
  readonly engineTimer: Timer;
  readonly fact: TimerFact;
};

function projectTimer(engineTimer: Timer): ProjectedTimer {
  return { engineTimer, fact: toWireTimer(engineTimer) };
}

function commonRecord(
  storeId: string,
  eventTime: PositiveEpochMillis,
  fact: TimerFact,
): CommonRecord {
  return {
    storeId,
    timerId: fact.id,
    eventTime,
    slotIds: fact.slotIds,
    noodleType: fact.noodleType,
    firmness: fact.firmness,
  };
}

/** Persist 成功済みの before／after 差分を、一差分一件の Operation Record へ写す純粋導出。 */
export function recordsFromCommittedDiff(
  observation: OperationObservation,
): readonly OperationRecord[] {
  const { storeId, eventKind, before, after } = observation;
  const eventTime = positiveEpochMillis(observation.eventTime);
  const beforeTimers = before.timers.map(projectTimer);
  const afterTimers = after.timers.map(projectTimer);
  const beforeById = new Map(beforeTimers.map((timer) => [timer.fact.id, timer]));
  const afterById = new Map(afterTimers.map((timer) => [timer.fact.id, timer]));

  switch (eventKind) {
    case "Start":
      return afterTimers
        .filter(({ fact }) => !beforeById.has(fact.id))
        .map(({ fact }): OperationRecord => ({
          ...commonRecord(storeId, eventTime, fact),
          operationKind: "boil-started",
          startTime: positiveEpochMillis(fact.startTime),
          endTime: positiveEpochMillis(fact.endTime),
        }));

    case "Complete":
    case "Cancel":
      return beforeTimers
        .filter(({ fact }) => !afterById.has(fact.id))
        .map(({ fact }): OperationRecord => ({
          ...commonRecord(storeId, eventTime, fact),
          operationKind: eventKind === "Complete" ? "completed" : "cancelled",
        }));

    case "Adjust":
      return afterTimers.flatMap(({ fact }): readonly OperationRecord[] => {
        const previous = beforeById.get(fact.id);
        if (previous === undefined) return [];

        const firmnessChanged = previous.fact.firmness !== fact.firmness;
        const endTimeChanged = previous.fact.endTime !== fact.endTime;
        if (!firmnessChanged && !endTimeChanged) return [];

        return [
          {
            ...commonRecord(storeId, eventTime, fact),
            operationKind: "adjusted",
            endTime: positiveEpochMillis(fact.endTime),
          },
        ];
      });

    case "AlarmFired":
    case "Reconcile":
      return afterTimers.flatMap(({ engineTimer, fact }): readonly OperationRecord[] => {
        const previous = beforeById.get(fact.id);
        if (
          previous === undefined ||
          previous.engineTimer.boiledAt !== null ||
          engineTimer.boiledAt === null
        ) {
          return [];
        }

        return [
          {
            ...commonRecord(storeId, eventTime, fact),
            operationKind: "boiled",
            endTime: positiveEpochMillis(fact.endTime),
            boiledAt: positiveEpochMillis(engineTimer.boiledAt),
          },
        ];
      });
  }
}
