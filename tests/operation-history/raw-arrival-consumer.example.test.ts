import { describe, expect, it } from "vitest";
import { printCanonicalOperationLine } from "../../src/operation-history/codec";
import type { OperationRecord } from "../../src/operation-history/record";
import type { OperationRecordMessage } from "../../src/data-platform/tail-worker";
import rawArrivalConsumer, {
  canonicalLineHash,
  rawArrivalObject,
  type RawArrivalConsumerEnv,
} from "../../src/data-platform/raw-arrival-consumer";

const canonicalLine = printCanonicalOperationLine({
  storeId: "store-1",
  timerId: "timer-1",
  operationKind: "completed",
  eventTime: 1 as OperationRecord["eventTime"],
  slotIds: ["slot-1"],
  noodleType: "Thin",
  firmness: "normal",
});

const body: OperationRecordMessage = {
  canonicalLine,
  firstObservedAt: Date.UTC(2026, 5, 26, 7, 8, 9),
  producerScript: "yude-men-timer-prod",
};

type StoredObject = {
  readonly body: string;
  readonly customMetadata: Record<string, string> | undefined;
};

// put だけを受ける Data Platform 側 R2 の擬装。delete も list も持たないため raw arrival は消えない。
function fakeBucket(failFor: (key: string) => boolean = () => false) {
  const stored = new Map<string, StoredObject[]>();
  const bucket = {
    async put(key: string, value: string, options?: R2PutOptions) {
      if (failFor(key)) throw new Error("R2 put failed");
      const writes = stored.get(key) ?? [];
      writes.push({ body: value, customMetadata: options?.customMetadata });
      stored.set(key, writes);
      return {} as unknown as R2Object;
    },
  } as unknown as R2Bucket;
  return { bucket, stored };
}

function fakeMessage(id: string, attempts = 1) {
  const calls: string[] = [];
  const message = {
    id,
    timestamp: new Date(0),
    body,
    attempts,
    ack() {
      calls.push("ack");
    },
    retry() {
      calls.push("retry");
    },
  };
  return { message, calls };
}

function batchOf(messages: readonly ReturnType<typeof fakeMessage>["message"][]) {
  return {
    queue: "operation-records",
    messages,
    ackAll() {
      throw new Error("ackAll は使わない");
    },
    retryAll() {
      throw new Error("retryAll は使わない");
    },
  } as unknown as MessageBatch<OperationRecordMessage>;
}

// Requirements 4.5, 4.11, 4.13, 4.15, 5.3, 5.4, 5.5, 5.7, 6.1
describe("rawArrivalObject", () => {
  it("canonical 一行を本体に、観測側 metadata を分離して持ち、key は delivery identity から決まる", () => {
    const object = rawArrivalObject(body, {
      queueMessageId: "msg-1",
      deliveryAttempt: 1,
      arrivedAt: 1_800_000_000_000,
      canonicalHash: "abc",
    });

    expect(object.key).toBe("raw/2026/06/26/1782457689000-msg-1-1.json");
    expect(object.canonicalLine).toBe(canonicalLine);
    expect(object.observation).toEqual({
      firstObservedAt: "1782457689000",
      arrivedAt: "1800000000000",
      producerScript: "yude-men-timer-prod",
      queueMessageId: "msg-1",
      deliveryAttempt: "1",
      canonicalHash: "abc",
    });
  });

  it("同一 message の再配送試行ごとに別 key となり既存 object を上書きしない", () => {
    const first = rawArrivalObject(body, {
      queueMessageId: "msg-1",
      deliveryAttempt: 1,
      arrivedAt: 1,
      canonicalHash: "abc",
    });
    const redelivered = rawArrivalObject(body, {
      queueMessageId: "msg-1",
      deliveryAttempt: 2,
      arrivedAt: 2,
      canonicalHash: "abc",
    });

    expect(redelivered.key).not.toBe(first.key);
  });
});

describe("rawArrivalConsumer.queue", () => {
  it("R2 put 成功後だけ ack し、canonical 一行と観測側 metadata を保存する", async () => {
    const { bucket, stored } = fakeBucket();
    const { message, calls } = fakeMessage("msg-1");

    await rawArrivalConsumer.queue!(
      batchOf([message]),
      { OPERATION_RAW_ARRIVALS: bucket } satisfies RawArrivalConsumerEnv,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );

    expect(calls).toEqual(["ack"]);
    const written = stored.get("raw/2026/06/26/1782457689000-msg-1-1.json");
    expect(written).toHaveLength(1);
    expect(written![0]!.body).toBe(canonicalLine);
    expect(written![0]!.customMetadata).toMatchObject({
      firstObservedAt: "1782457689000",
      producerScript: "yude-men-timer-prod",
      queueMessageId: "msg-1",
      deliveryAttempt: "1",
      canonicalHash: await canonicalLineHash(canonicalLine),
    });
  });

  it("put 失敗の message は ack 0 件で再配送へ委ね、後続 message の保存を止めない", async () => {
    const failing = "raw/2026/06/26/1782457689000-msg-1-1.json";
    const { bucket, stored } = fakeBucket((key) => key === failing);
    const first = fakeMessage("msg-1");
    const second = fakeMessage("msg-2");

    await rawArrivalConsumer.queue!(
      batchOf([first.message, second.message]),
      { OPERATION_RAW_ARRIVALS: bucket } satisfies RawArrivalConsumerEnv,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );

    expect(first.calls).toEqual(["retry"]);
    expect(second.calls).toEqual(["ack"]);
    expect(stored.has(failing)).toBe(false);
    expect(stored.has("raw/2026/06/26/1782457689000-msg-2-1.json")).toBe(true);
  });

  it("重複配送でも先の raw arrival を残したまま全件を保持する", async () => {
    const { bucket, stored } = fakeBucket();
    const first = fakeMessage("msg-1", 1);
    const redelivered = fakeMessage("msg-1", 2);
    const env = { OPERATION_RAW_ARRIVALS: bucket } satisfies RawArrivalConsumerEnv;
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

    await rawArrivalConsumer.queue!(batchOf([first.message]), env, ctx);
    await rawArrivalConsumer.queue!(batchOf([redelivered.message]), env, ctx);

    expect([...stored.keys()]).toEqual([
      "raw/2026/06/26/1782457689000-msg-1-1.json",
      "raw/2026/06/26/1782457689000-msg-1-2.json",
    ]);
    expect([...stored.values()].every((writes) => writes.length === 1)).toBe(true);
  });
});
