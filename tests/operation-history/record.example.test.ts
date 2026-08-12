import { describe, expect, it } from "vitest";
import type { OperationRecord } from "../../src/operation-history/record";

const timestamp = (value: number): OperationRecord["eventTime"] => value as OperationRecord["eventTime"];

const common = {
  storeId: "store-1",
  timerId: "timer-1",
  eventTime: timestamp(1_700_000_000_000),
  slotIds: ["slot-1", "slot-2"],
  noodleType: "Thin",
  firmness: "normal",
} as const;

const records = [
  {
    ...common,
    operationKind: "boil-started",
    startTime: timestamp(1_700_000_000_000),
    endTime: timestamp(1_700_000_060_000),
  },
  {
    ...common,
    operationKind: "boiled",
    endTime: timestamp(1_700_000_060_000),
    boiledAt: timestamp(1_700_000_060_001),
  },
  { ...common, operationKind: "adjusted", endTime: timestamp(1_700_000_052_000) },
  { ...common, operationKind: "completed" },
  { ...common, operationKind: "cancelled" },
] satisfies readonly OperationRecord[];

if (false) {
  // @ts-expect-error completed は endTime を許可しない。
  const completedWithEndTime: OperationRecord = { ...common, operationKind: "completed", endTime: timestamp(1) };
  // @ts-expect-error boiled は boiledAt を必須とする。
  const boiledWithoutBoiledAt: OperationRecord = { ...common, operationKind: "boiled", endTime: timestamp(1) };
  // @ts-expect-error slotIds は非空でなければならない。
  const emptySlots: OperationRecord = { ...common, operationKind: "cancelled", slotIds: [] };
  // @ts-expect-error timestamp は検証されていない number を直接受け入れない。
  const unverifiedTimestamp: OperationRecord = { ...common, operationKind: "cancelled", eventTime: 0 };
  // @ts-expect-error 自然人属性は既知契約に含めない。
  const withPerson: OperationRecord = { ...common, operationKind: "cancelled", operatorName: "person" };
  // @ts-expect-error 採番属性は既知契約に含めない。
  const withSequence: OperationRecord = { ...common, operationKind: "cancelled", seq: 1 };
  void [completedWithEndTime, boiledWithoutBoiledAt, emptySlots, unverifiedTimestamp, withPerson, withSequence];
}
describe("OperationRecord", () => {
  it("kind ごとの既知属性だけを持つ", () => {
    expect(records.map((record) => Object.keys(record))).toEqual([
      ["storeId", "timerId", "eventTime", "slotIds", "noodleType", "firmness", "operationKind", "startTime", "endTime"],
      ["storeId", "timerId", "eventTime", "slotIds", "noodleType", "firmness", "operationKind", "endTime", "boiledAt"],
      ["storeId", "timerId", "eventTime", "slotIds", "noodleType", "firmness", "operationKind", "endTime"],
      ["storeId", "timerId", "eventTime", "slotIds", "noodleType", "firmness", "operationKind"],
      ["storeId", "timerId", "eventTime", "slotIds", "noodleType", "firmness", "operationKind"],
    ]);
  });

  it("禁止された採番・自然人・導出属性を持たない", () => {
    for (const record of records) {
      expect(record).not.toHaveProperty("Record_Seq");
      expect(record).not.toHaveProperty("seq");
      expect(record).not.toHaveProperty("nextSeq");
      expect(record).not.toHaveProperty("operatorName");
      expect(record).not.toHaveProperty("remaining");
    }
  });
});