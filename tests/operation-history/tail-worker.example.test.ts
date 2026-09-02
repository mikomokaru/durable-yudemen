import { describe, expect, it } from "vitest";
import { printCanonicalOperationLine } from "../../src/operation-history/codec";
import type { OperationRecord } from "../../src/operation-history/record";
import tailWorker, {
  operationRecordMessagesFromTailEvents,
  type OperationRecordMessage,
  type TailWorkerEnv,
} from "../../src/data-platform/tail-worker";

const line = printCanonicalOperationLine({
  storeId: "store-1",
  timerId: "timer-1",
  operationKind: "completed",
  eventTime: 1 as OperationRecord["eventTime"],
  slotIds: ["slot-1"],
  noodleType: "Thin",
  firmness: "normal",
});

// root wrangler.jsonc の "name" と一致する、現存するただ一つの Producer script。
const PRODUCER_SCRIPT = "yude-men-timer";

// TraceItem を構造的に満たす最小の tail event。純粋 filter が読むのは scriptName と logs だけ。
const event = (
  scriptName: string | null,
  logs: readonly {
    readonly level: string;
    readonly message: readonly unknown[];
  }[],
) => ({ scriptName, logs }) as unknown as TraceItem;

// sendBatch 呼び出しを捕捉する Data Platform 側 Queue の擬装。Producer への逆経路を持たない。
function fakeQueue() {
  const batches: OperationRecordMessage[][] = [];
  const queue = {
    async sendBatch(messages: Iterable<{ body: OperationRecordMessage }>) {
      batches.push([...messages].map((m) => m.body));
      return { outcome: "" } as unknown as QueueSendBatchResponse;
    },
    async send() {
      throw new Error("send は使わない");
    },
    async metrics() {
      throw new Error("metrics は使わない");
    },
  } as unknown as Queue<OperationRecordMessage>;
  return { queue, batches };
}

// Requirements 4.1, 4.2, 4.3, 4.4, 4.11, 4.13, 4.14
describe("operationRecordMessagesFromTailEvents", () => {
  it("実在するProducerの妥当な候補を入力順でQueue message化し観測時刻を添える", () => {
    const events = [
      event(PRODUCER_SCRIPT, [{ level: "log", message: [line] }]),
      event(PRODUCER_SCRIPT, [{ level: "log", message: [line] }]),
      event(PRODUCER_SCRIPT, [{ level: "log", message: [line] }]),
    ];
    expect(operationRecordMessagesFromTailEvents(events, 1000)).toEqual({
      messages: [
        { canonicalLine: line, firstObservedAt: 1000, producerScript: PRODUCER_SCRIPT },
        { canonicalLine: line, firstObservedAt: 1000, producerScript: PRODUCER_SCRIPT },
        { canonicalLine: line, firstObservedAt: 1000, producerScript: PRODUCER_SCRIPT },
      ],
      failures: [],
    });
  });

  it("不正行はmessageにせず1始まり位置と失敗種別を観測側へ残す", () => {
    const missingRequired = '{"storeId":"store-1"}';
    const events = [
      event(PRODUCER_SCRIPT, [
        { level: "warn", message: ["not-json"] },
        { level: "log", message: ["not-json"] },
        { level: "log", message: [line, "extra"] },
        { level: "log", message: [line] },
        { level: "log", message: [missingRequired] },
      ]),
    ];
    expect(operationRecordMessagesFromTailEvents(events, 2000)).toEqual({
      messages: [{ canonicalLine: line, firstObservedAt: 2000, producerScript: PRODUCER_SCRIPT }],
      failures: [
        { lineNumber: 1, failure: "invalid-json" },
        { lineNumber: 3, failure: "missing-required-attribute" },
      ],
    });
  });
});

describe("tailWorker.tail", () => {
  it("妥当な候補だけをQueueへ一括送信する", async () => {
    const { queue, batches } = fakeQueue();
    const events = [
      event(PRODUCER_SCRIPT, [
        { level: "log", message: [line] },
        { level: "log", message: ['{"storeId":"store-1"}'] },
      ]),
    ];

    await tailWorker.tail!(
      events as TraceItem[],
      { OPERATION_RECORDS: queue } as TailWorkerEnv,
      {
        waitUntil() {},
        passThroughOnException() {},
      } as unknown as ExecutionContext,
    );

    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((m) => m.canonicalLine)).toEqual([line]);
  });

  it("妥当な候補が無ければQueueへ送信しない", async () => {
    const { queue, batches } = fakeQueue();
    const events = [event("other-worker", [{ level: "log", message: [line] }])];

    await tailWorker.tail!(
      events as TraceItem[],
      { OPERATION_RECORDS: queue } as TailWorkerEnv,
      {
        waitUntil() {},
        passThroughOnException() {},
      } as unknown as ExecutionContext,
    );

    expect(batches).toEqual([]);
  });
});
