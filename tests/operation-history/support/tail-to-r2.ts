// Tail Worker → Queue → Consumer → R2 を実物のまま直列に繋ぐ、テスト側の配線。
// 擬装するのは Queue delivery と R2 put の成否だけで、Producer への逆 binding を一つも持たない
// （要件 4.13, 4.14, 4.15）。同じ配線を二つの統合テスト（tail-queue-r2 / unobserved-telemetry）が
// 使うため、配線の定義はここに一度だけ置く。

import { EMPTY_STATE, type TimerState } from "../../../src/engine/state";
import { createTimer, type Timer } from "../../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../../src/engine/types";
import tailWorker, {
  type OperationRecordMessage,
  type TailWorkerEnv,
} from "../../../src/data-platform/tail-worker";
import rawArrivalConsumer, {
  type RawArrivalConsumerEnv,
} from "../../../src/data-platform/raw-arrival-consumer";
import { nonEmpty } from "../../nonEmpty";

/** root wrangler.jsonc の "name" と一致する、現存するただ一つの Producer script。 */
export const PRODUCER_SCRIPT = "yude-men-timer";
export const START_TIME = 1_700_000_000_000;
export const BOIL_DURATION = 60_000;

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

/**
 * 観測対象になる engine Timer 一件。事実は id と boiledAt と登録順、そして実効 endTime を動かす
 * adjustment だけ変える。adjustment は engine 専用の事実ゆえ record には出ず、既存 toWireTimer の
 * 射影を通って実効 endTime として現れる（要件 1.6 / 2.16）。
 */
export function producerTimer(
  id: string,
  boiledAt: number | null,
  seq: number,
  adjustment = 0,
): Timer {
  return createTimer({
    id: id as TimerId,
    slotIds: nonEmpty([`slot-${id}` as SlotId]),
    noodleType: "Thin" as NoodleType,
    firmness: "normal",
    startTime: START_TIME as EpochMillis,
    endTime: (START_TIME + BOIL_DURATION) as EpochMillis,
    boiledAt: boiledAt === null ? null : (boiledAt as EpochMillis),
    seq,
    adjustment,
  });
}

export function timerStateOf(timers: readonly Timer[]): TimerState {
  return { ...EMPTY_STATE, timers, nextSeq: timers.length };
}

export type TailLog = { readonly level: string; readonly message: readonly unknown[] };

export function tailEvent(scriptName: string, logs: readonly TailLog[]): TraceItem {
  return { scriptName, logs } as unknown as TraceItem;
}

export type Pipeline = {
  readonly queued: readonly OperationRecordMessage[];
  readonly sendBatchCalls: number;
  readonly acks: readonly string[];
  readonly retries: readonly string[];
  readonly stored: ReadonlyMap<string, readonly string[]>;
  readonly tailEnvBindings: readonly string[];
  readonly consumerEnvBindings: readonly string[];
};

export async function runTailToR2(
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
