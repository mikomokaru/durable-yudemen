// Tail → Queue → Consumer → R2 を、完了済み Producer の実出力から起点で貫く統合テスト。
// Producer 側は tryWriteOperationLines が実際に console へ書いた行だけを tail fixture の材料にし、
// 以降は Data Platform 側の Tail Worker と Queue Consumer を実物のまま繋ぐ（要件 4.2〜4.5, 4.11, 4.13〜4.15, 5.5, 5.7）。

import { afterEach, describe, expect, it, vi } from "vitest";
import { tryWriteOperationLines } from "../../src/operation-history/producer";
import type { OperationObservation } from "../../src/operation-history/derive";
import { createTimer } from "../../src/engine/timer";
import type { Timer } from "../../src/engine/timer";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import tailWorker, {
  type OperationRecordMessage,
  type TailWorkerEnv,
} from "../../src/data-platform/tail-worker";
import rawArrivalConsumer, {
  type RawArrivalConsumerEnv,
} from "../../src/data-platform/raw-arrival-consumer";
import { nonEmpty } from "../nonEmpty";

const PRODUCER_SCRIPT = "yude-men-timer-prod";
const EVENT_TIME = 1_700_000_100_000;
const START_TIME = 1_700_000_000_000;

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

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

const boiledObservation: OperationObservation = {
  storeId: "store-1",
  eventTime: EVENT_TIME,
  eventKind: "AlarmFired",
  before: state([timer("first", null, 0), timer("second", null, 1)]),
  after: state([timer("first", EVENT_TIME, 0), timer("second", EVENT_TIME + 1, 1)]),
};

/** 完了済み Producer invocation が実際に出力した canonical 一行を採取する。 */
function producerLines() {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  tryWriteOperationLines(true, boiledObservation);
  const trace = (): readonly unknown[][] => log.mock.calls.map((call) => [...call]);
  return { lines: log.mock.calls.map((call) => call[0] as string), trace };
}

type TailLog = { readonly level: string; readonly message: readonly unknown[] };

function tailEvent(scriptName: string, logs: readonly TailLog[]): TraceItem {
  return { scriptName, logs } as unknown as TraceItem;
}

type Pipeline = {
  readonly queued: readonly OperationRecordMessage[];
  readonly sendBatchCalls: number;
  readonly acks: readonly string[];
  readonly retries: readonly string[];
  readonly stored: ReadonlyMap<string, readonly string[]>;
  readonly tailEnvBindings: readonly string[];
  readonly consumerEnvBindings: readonly string[];
};

/**
 * 実物の Tail Worker と Queue Consumer を、擬装した Queue と R2 越しに直列に繋ぐ。
 * 擬装は Queue delivery と R2 put の成否だけを再現し、Producer への逆 binding を一切持たない。
 */
async function runTailToR2(
  events: readonly TraceItem[],
  options: { readonly queueSendFails?: boolean; readonly putFailsFor?: (key: string) => boolean } = {},
): Promise<Pipeline> {
  const queued: OperationRecordMessage[] = [];
  let sendBatchCalls = 0;
  const queue = {
    async sendBatch(messages: Iterable<{ body: OperationRecordMessage }>) {
      sendBatchCalls += 1;
      if (options.queueSendFails === true) throw new Error("Queue send failed");
      queued.push(...[...messages].map((entry) => entry.body));
      return {} as unknown as QueueSendBatchResponse;
    },
  } as unknown as Queue<OperationRecordMessage>;

  const tailEnv = { OPERATION_RECORDS: queue } satisfies TailWorkerEnv;
  await tailWorker.tail!(events as TraceItem[], tailEnv, ctx);

  const stored = new Map<string, string[]>();
  const bucket = {
    async put(key: string, value: string, putOptions?: R2PutOptions) {
      if (options.putFailsFor?.(key) === true) throw new Error("R2 put failed");
      const writes = stored.get(key) ?? [];
      writes.push(`${value}|${putOptions?.customMetadata?.producerScript ?? ""}`);
      stored.set(key, writes);
      return {} as unknown as R2Object;
    },
  } as unknown as R2Bucket;

  const acks: string[] = [];
  const retries: string[] = [];
  const messages = queued.map((body, index) => ({
    id: `msg-${index + 1}`,
    timestamp: new Date(0),
    body,
    attempts: 1,
    ack() {
      acks.push(this.id);
    },
    retry() {
      retries.push(this.id);
    },
  }));

  const consumerEnv = { OPERATION_RAW_ARRIVALS: bucket } satisfies RawArrivalConsumerEnv;
  if (messages.length > 0) {
    await rawArrivalConsumer.queue!(
      { queue: "operation-records", messages } as unknown as MessageBatch<OperationRecordMessage>,
      consumerEnv,
      ctx,
    );
  }

  return {
    queued,
    sendBatchCalls,
    acks,
    retries,
    stored,
    tailEnvBindings: Object.keys(tailEnv),
    consumerEnvBindings: Object.keys(consumerEnv),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Tail → Queue → Consumer → R2 の一方向搬送", () => {
  it("完了済み Producer の canonical 一行だけが Queue と R2 まで届く", async () => {
    const { lines } = producerLines();
    const events = [
      // 想定外 script の event は、同じ canonical 一行でも搬送対象にしない。
      tailEvent("other-worker", [{ level: "log", message: [lines[0]] }]),
      tailEvent(PRODUCER_SCRIPT, [
        { level: "log", message: [lines[0]] },
        { level: "warn", message: [lines[1]] },
        { level: "log", message: [lines[1], "extra"] },
        { level: "log", message: [{ observation: "hibernation-debug" }] },
        { level: "log", message: [`${lines[1]}\n${lines[1]}`] },
        { level: "log", message: [lines[1]] },
      ]),
    ];

    const pipeline = await runTailToR2(events);

    expect(pipeline.queued).toEqual([
      { canonicalLine: lines[0], firstObservedAt: expect.any(Number), producerScript: PRODUCER_SCRIPT },
      { canonicalLine: lines[1], firstObservedAt: expect.any(Number), producerScript: PRODUCER_SCRIPT },
    ]);
    expect(pipeline.acks).toEqual(["msg-1", "msg-2"]);
    expect(pipeline.retries).toEqual([]);
    expect([...pipeline.stored.values()].map((writes) => writes[0])).toEqual([
      `${lines[0]}|${PRODUCER_SCRIPT}`,
      `${lines[1]}|${PRODUCER_SCRIPT}`,
    ]);
    // 逆方向 binding は両側の env に存在しない（要件 4.13, 4.14, 4.15）。
    expect(pipeline.tailEnvBindings).toEqual(["OPERATION_RECORDS"]);
    expect(pipeline.consumerEnvBindings).toEqual(["OPERATION_RAW_ARRIVALS"]);
  });

  it("不正行は Queue 0 件で、1 始まり位置と失敗種別が Data Platform 側に残る", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const events = [
      tailEvent(PRODUCER_SCRIPT, [
        { level: "log", message: ["not-json"] },
        { level: "log", message: ['{"storeId":"store-1"}'] },
      ]),
    ];

    const pipeline = await runTailToR2(events);

    expect(pipeline.queued).toEqual([]);
    expect(pipeline.sendBatchCalls).toBe(0);
    expect(pipeline.stored.size).toBe(0);
    expect(pipeline.acks).toEqual([]);
    expect(warn.mock.calls.map(([entry]) => JSON.parse(entry as string))).toEqual([
      { observation: "codec-failure", lineNumber: 1, failure: "invalid-json" },
      { observation: "codec-failure", lineNumber: 2, failure: "missing-required-attribute" },
    ]);
  });

  it("Queue send 失敗は Data Platform 内に留まり Producer trace に現れない", async () => {
    const { lines, trace } = producerLines();
    const producerTrace = trace();
    const events = [tailEvent(PRODUCER_SCRIPT, [{ level: "log", message: [lines[0]] }])];

    await expect(runTailToR2(events, { queueSendFails: true })).rejects.toThrow("Queue send failed");

    // Producer の console trace は tail 側の失敗後も一行も増減しない（再出力要求が存在しない）。
    expect(trace()).toEqual(producerTrace);
  });

  it("R2 put 失敗の message は ack 0 件で再配送対象になる", async () => {
    const { lines } = producerLines();
    const events = [
      tailEvent(PRODUCER_SCRIPT, [
        { level: "log", message: [lines[0]] },
        { level: "log", message: [lines[1]] },
      ]),
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const pipeline = await runTailToR2(events, { putFailsFor: (key) => key.endsWith("-msg-1-1.json") });

    expect(pipeline.acks).toEqual(["msg-2"]);
    expect(pipeline.retries).toEqual(["msg-1"]);
    expect(pipeline.stored.size).toBe(1);
    expect(warn.mock.calls.map(([entry]) => JSON.parse(entry as string))).toEqual([
      { observation: "raw-arrival-put-failure", messageId: "msg-1", error: "Error: R2 put failed" },
    ]);
  });

  it("重複 delivery でも raw arrival は全件残る", async () => {
    const { lines } = producerLines();
    const events = [
      tailEvent(PRODUCER_SCRIPT, [
        { level: "log", message: [lines[0]] },
        { level: "log", message: [lines[0]] },
      ]),
    ];

    const pipeline = await runTailToR2(events);

    expect(pipeline.queued.map((message) => message.canonicalLine)).toEqual([lines[0], lines[0]]);
    expect(pipeline.acks).toEqual(["msg-1", "msg-2"]);
    expect(pipeline.stored.size).toBe(2);
    expect([...pipeline.stored.values()].every((writes) => writes.length === 1)).toBe(true);
    expect([...pipeline.stored.values()].map((writes) => writes[0])).toEqual([
      `${lines[0]}|${PRODUCER_SCRIPT}`,
      `${lines[0]}|${PRODUCER_SCRIPT}`,
    ]);
  });
});
