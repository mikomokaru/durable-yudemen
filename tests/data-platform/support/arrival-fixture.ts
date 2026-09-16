// data-platform の物理契約テストが共有する固定値。branded な timestamp の作り方を
// tests/operation-history 側と揃える。

import type { TailObservation } from "../../../src/data-platform/arrival";
import type { OperationRecord } from "../../../src/operation-history/record";

export const timestamp = (value: number): OperationRecord["eventTime"] =>
  value as OperationRecord["eventTime"];

export const completedRecord = {
  storeId: "store-1",
  timerId: "timer-1",
  operationKind: "completed",
  eventTime: timestamp(1_700_000_000_000),
  slotIds: ["slot-1"],
  noodleType: "Thin",
  firmness: "normal",
} satisfies OperationRecord;

export const canonicalPayload = JSON.stringify(completedRecord);

export const observation: TailObservation = {
  arrivalId: "0195c0de-0000-7000-8000-000000000001",
  observedAt: 1_700_000_000_500,
  producerScript: "yude-men-timer",
  truncation: "not-detected",
  probeId: null,
};
