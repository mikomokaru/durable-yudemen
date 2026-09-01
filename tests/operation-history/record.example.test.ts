import { describe, expect, it } from "vitest";
import type { OperationRecord } from "../../src/operation-history/record";

const timestamp = (value: number): OperationRecord["eventTime"] =>
  value as OperationRecord["eventTime"];

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

// 不正な Operation_Record が型として構築できないことの検証。実行はせず、型検査だけが目的である。
const rejectedByType = (): void => {
  const completedWithEndTime: OperationRecord = {
    ...common,
    operationKind: "completed",
    // @ts-expect-error completed は endTime を許可しない。
    endTime: timestamp(1),
  };
  // 欠落は識別子の位置に報告されるため、この一つだけ宣言の直上に置く。
  // @ts-expect-error boiled は boiledAt を必須とする。
  const boiledWithoutBoiledAt: OperationRecord = {
    ...common,
    operationKind: "boiled",
    endTime: timestamp(1),
  };
  const emptySlots: OperationRecord = {
    ...common,
    operationKind: "cancelled",
    // @ts-expect-error slotIds は非空でなければならない。
    slotIds: [],
  };
  const unverifiedTimestamp: OperationRecord = {
    ...common,
    operationKind: "cancelled",
    // @ts-expect-error timestamp は検証されていない number を直接受け入れない。
    eventTime: 0,
  };
  const withPerson: OperationRecord = {
    ...common,
    operationKind: "cancelled",
    // @ts-expect-error 自然人属性は既知契約に含めない。
    operatorName: "person",
  };
  const withSequence: OperationRecord = {
    ...common,
    operationKind: "cancelled",
    // @ts-expect-error 採番属性は既知契約に含めない。
    seq: 1,
  };
  void [
    completedWithEndTime,
    boiledWithoutBoiledAt,
    emptySlots,
    unverifiedTimestamp,
    withPerson,
    withSequence,
  ];
};
void rejectedByType;

describe("OperationRecord", () => {
  it("kind ごとの既知属性だけを持つ", () => {
    expect(records.map((record) => Object.keys(record))).toEqual([
      [
        "storeId",
        "timerId",
        "eventTime",
        "slotIds",
        "noodleType",
        "firmness",
        "operationKind",
        "startTime",
        "endTime",
      ],
      [
        "storeId",
        "timerId",
        "eventTime",
        "slotIds",
        "noodleType",
        "firmness",
        "operationKind",
        "endTime",
        "boiledAt",
      ],
      [
        "storeId",
        "timerId",
        "eventTime",
        "slotIds",
        "noodleType",
        "firmness",
        "operationKind",
        "endTime",
      ],
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
