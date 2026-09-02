// Tail／Consumer から Producer への逆方向経路が実行時に 0 件であることの call trace 検証。
// 9.2 の O4 はソーステキストの capability 不在を、10.3 は一方向の値の流れを見る。本テストはそのどちらでもなく、
// 実物の Tail Worker と Queue Consumer を全 fixture で走らせ、逆方向 capability を tripwire として
// 与えたうえで一度も触れないことを call trace で確かめる（要件 1.9, 4.10, 4.13, 4.14, 4.15）。
// tripwire を「与える」のが要点である。binding が仮に存在しても使わないことを示せて初めて、
// 逆方向の不在は設定の偶然ではなく実装の性質になる。

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

// root wrangler.jsonc の "name" と一致する、現存するただ一つの Producer script。
const PRODUCER_SCRIPT = "yude-men-timer";
const EVENT_TIME = 1_700_000_100_000;
const START_TIME = 1_700_000_000_000;

/** Data Platform 側 env へ差し込む逆方向 binding の tripwire 名。触れた時点で違反となる。 */
const REVERSE_BINDINGS = [
  "STORE_TIMER_DO",
  "STORE_REGISTRY_DO",
  "PRODUCER",
  "PRODUCER_URL",
  "TIMER_SERVICE",
] as const;

type CallTrace = string[];

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
function producerLines(): readonly string[] {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  tryWriteOperationLines(true, boiledObservation);
  const lines = log.mock.calls.map((call) => call[0] as string);
  log.mockRestore();
  return lines;
}

/**
 * 逆方向 capability の代役。property 参照・呼出し・construct のすべてを trace へ残すため、
 * 「binding があっても使わない」ことを到達の有無として観測できる。
 */
function tripwire(trace: CallTrace, path: string): unknown {
  return new Proxy(function tripwireTarget() {} as object, {
    get(_target, property) {
      trace.push(`${path}.${String(property)}:get`);
      return tripwire(trace, `${path}.${String(property)}`);
    },
    apply() {
      trace.push(`${path}:call`);
      return undefined;
    },
    construct() {
      trace.push(`${path}:new`);
      return {};
    },
  });
}

/** 宣言済み binding の参照を trace へ残し、逆方向 binding を tripwire として同じ env に同居させる。 */
function envWithTripwires<T extends object>(trace: CallTrace, declared: T): T {
  const env: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(declared)) {
    Object.defineProperty(env, name, {
      enumerable: true,
      get() {
        trace.push(`env.${name}:get`);
        return value;
      },
    });
  }
  for (const name of REVERSE_BINDINGS) {
    Object.defineProperty(env, name, {
      enumerable: true,
      get() {
        trace.push(`env.${name}:get`);
        return tripwire(trace, `env.${name}`);
      },
    });
  }
  return env as T;
}

type TailLog = { readonly level: string; readonly message: readonly unknown[] };

function tailEvent(scriptName: string, logs: readonly TailLog[]): TraceItem {
  return { scriptName, logs } as unknown as TraceItem;
}

type Pipeline = {
  readonly trace: readonly string[];
  readonly acks: readonly string[];
  readonly retries: readonly string[];
  readonly ackReceivers: readonly string[];
  readonly storedKeys: readonly string[];
  readonly producerLogCalls: number;
  readonly waitUntilCalls: number;
};

/**
 * 実物の Tail Worker → Queue → Consumer → R2 を、call trace を採る擬装越しに直列に走らせる。
 * 擬装は Queue delivery と R2 put の成否だけを再現し、逆方向は tripwire としてのみ存在する。
 */
async function runWithCallTrace(
  events: readonly TraceItem[],
  options: {
    readonly queueSendFails?: boolean;
    readonly putFailsFor?: (key: string) => boolean;
  } = {},
): Promise<Pipeline> {
  const trace: CallTrace = [];
  const producerLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  // global の HTTP／WebSocket も tripwire にする。binding を持たずとも到達し得る経路を塞ぐ。
  vi.stubGlobal("fetch", (...args: readonly unknown[]) => {
    trace.push(`globalFetch:call ${String(args[0])}`);
    throw new Error("reverse HTTP");
  });
  vi.stubGlobal(
    "WebSocket",
    class {
      constructor() {
        trace.push("WebSocket:new");
        throw new Error("reverse WebSocket");
      }
    },
  );

  let waitUntilCalls = 0;
  const ctx = {
    waitUntil() {
      waitUntilCalls += 1;
      trace.push("ctx.waitUntil:call");
    },
    passThroughOnException() {
      trace.push("ctx.passThroughOnException:call");
    },
  } as unknown as ExecutionContext;

  const queued: OperationRecordMessage[] = [];
  const queue = {
    async sendBatch(messages: Iterable<{ body: OperationRecordMessage }>) {
      trace.push("queue.sendBatch:call");
      if (options.queueSendFails === true) throw new Error("Queue send failed");
      queued.push(...[...messages].map((entry) => entry.body));
      return {} as unknown as QueueSendBatchResponse;
    },
  } as unknown as Queue<OperationRecordMessage>;

  const tailEnv = envWithTripwires(trace, { OPERATION_RECORDS: queue } satisfies TailWorkerEnv);
  try {
    await tailWorker.tail!(events as TraceItem[], tailEnv, ctx);
  } catch (error) {
    trace.push(`tail:threw ${error instanceof Error ? error.message : String(error)}`);
  }

  const storedKeys: string[] = [];
  const bucket = {
    async put(key: string, value: string, putOptions?: R2PutOptions) {
      trace.push("bucket.put:call");
      if (options.putFailsFor?.(key) === true) throw new Error("R2 put failed");
      storedKeys.push(`${key}|${value}|${putOptions?.customMetadata?.producerScript ?? ""}`);
      return {} as unknown as R2Object;
    },
  } as unknown as R2Bucket;

  const acks: string[] = [];
  const retries: string[] = [];
  const ackReceivers: string[] = [];
  const messages = queued.map((body, index) => {
    const id = `msg-${index + 1}`;
    const message = {
      id,
      timestamp: new Date(0),
      body,
      attempts: 1,
      ack() {
        trace.push(`message.${id}.ack:call`);
        ackReceivers.push(`queue-message:${id}`);
        acks.push(id);
      },
      retry() {
        trace.push(`message.${id}.retry:call`);
        retries.push(id);
      },
    };
    return new Proxy(message, {
      get(target, property) {
        trace.push(`message.${String(property)}:get`);
        return Reflect.get(target, property) as unknown;
      },
    });
  });

  const consumerEnv = envWithTripwires(trace, {
    OPERATION_RAW_ARRIVALS: bucket,
  } satisfies RawArrivalConsumerEnv);
  if (messages.length > 0) {
    const batch = new Proxy(
      { queue: "operation-records", messages },
      {
        get(target, property) {
          trace.push(`batch.${String(property)}:get`);
          return Reflect.get(target, property) as unknown;
        },
      },
    ) as unknown as MessageBatch<OperationRecordMessage>;
    await rawArrivalConsumer.queue!(batch, consumerEnv, ctx);
  }

  return {
    trace,
    acks,
    retries,
    ackReceivers,
    storedKeys,
    producerLogCalls: producerLog.mock.calls.length,
    waitUntilCalls,
  };
}

/** 全 fixture。妥当・除外・不正・重複・put 失敗・Queue send 失敗を一巡させる。 */
async function allFixtures(): Promise<readonly Pipeline[]> {
  const lines = producerLines();
  const valid = [
    tailEvent(
      PRODUCER_SCRIPT,
      lines.map((line) => ({ level: "log", message: [line] })),
    ),
  ];
  const excluded = [
    tailEvent("other-worker", [{ level: "log", message: [lines[0]] }]),
    tailEvent(PRODUCER_SCRIPT, [
      { level: "warn", message: [lines[0]] },
      { level: "log", message: [lines[0], "extra"] },
      { level: "log", message: [{ observation: "hibernation-debug" }] },
      { level: "log", message: [`${lines[0]}\n${lines[0]}`] },
    ]),
  ];
  const malformed = [
    tailEvent(PRODUCER_SCRIPT, [
      { level: "log", message: ["not-json"] },
      { level: "log", message: ['{"storeId":"store-1"}'] },
    ]),
  ];
  const duplicated = [
    tailEvent(PRODUCER_SCRIPT, [
      { level: "log", message: [lines[0]] },
      { level: "log", message: [lines[0]] },
    ]),
  ];

  return [
    await runWithCallTrace(valid),
    await runWithCallTrace(excluded),
    await runWithCallTrace(malformed),
    await runWithCallTrace(duplicated),
    await runWithCallTrace(valid, { putFailsFor: (key) => key.endsWith("-msg-1-1.json") }),
    await runWithCallTrace(valid, { queueSendFails: true }),
  ];
}

const reversePath =
  /STORE_TIMER_DO|STORE_REGISTRY_DO|PRODUCER|TIMER_SERVICE|idFromName|getByName|newUniqueId|setAlarm|deleteAlarm|WebSocket|globalFetch|scheduled/i;

const FORWARD_BINDINGS = ["env.OPERATION_RECORDS:get", "env.OPERATION_RAW_ARRIVALS:get"];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Validates: Requirements 1.9, 4.10, 4.13, 4.14, 4.15 */
describe("Tail／Consumer から Producer への逆方向経路の不在（call trace）", () => {
  it("全 fixture の call trace が Queue producer と R2 の前向き edge だけで構成される", async () => {
    const pipelines = await allFixtures();

    // 前向き edge が現に踏まれている fixture があってこそ、逆方向 0 件の主張は空虚でない。
    const allCapabilityTrace = pipelines.flatMap((pipeline) =>
      pipeline.trace.filter((entry) => entry.startsWith("env.")),
    );
    for (const forward of FORWARD_BINDINGS) expect(allCapabilityTrace).toContain(forward);

    for (const pipeline of pipelines) {
      for (const entry of pipeline.trace.filter((item) => item.startsWith("env."))) {
        expect(FORWARD_BINDINGS, `${entry} は Data Platform に許された binding ではない`).toContain(
          entry,
        );
      }
      expect(pipeline.trace.filter((entry) => reversePath.test(entry))).toEqual([]);
      expect(pipeline.trace.filter((entry) => entry.endsWith(":new"))).toEqual([]);
      // Data Platform の外向き作用は Queue send と R2 put だけである。
      expect(
        pipeline.trace.filter((entry) => entry.endsWith(":call") && !entry.startsWith("message.")),
      ).toEqual(
        pipeline.trace.filter(
          (entry) => entry === "queue.sendBatch:call" || entry === "bucket.put:call",
        ),
      );
      // 逆方向の待機・保持経路も作らない。
      expect(pipeline.waitUntilCalls).toBe(0);
      // Producer への再出力要求は 0 件（Data Platform 実行中に canonical 行が一件も再生産されない）。
      expect(pipeline.producerLogCalls).toBe(0);
    }
  });

  it("ack と retry は受領した Queue message だけを宛先にする", async () => {
    const pipelines = await allFixtures();

    for (const pipeline of pipelines) {
      for (const receiver of pipeline.ackReceivers) {
        expect(receiver).toMatch(/^queue-message:msg-\d+$/);
      }
      const ackTrace = pipeline.trace.filter(
        (entry) => entry.endsWith(":call") && /(?:ack|retry)/.test(entry),
      );
      for (const entry of ackTrace) {
        expect(entry, `${entry} の ack 宛先が Queue message ではない`).toMatch(
          /^message\.msg-\d+\.(?:ack|retry):call$/,
        );
      }
      expect(pipeline.acks.length + pipeline.retries.length).toBe(
        new Set(pipeline.acks.concat(pipeline.retries)).size,
      );
      // ack は R2 put 成功件数と一致し、Producer 側へは一件も向かない。
      expect(pipeline.acks).toHaveLength(pipeline.storedKeys.length);
    }
  });

  it("Tail Worker と Consumer は tail／queue 以外の起動口を実行時にも公開しない", () => {
    expect(Object.keys(tailWorker)).toEqual(["tail"]);
    expect(Object.keys(rawArrivalConsumer)).toEqual(["queue"]);
    const tailHandler = tailWorker as Record<string, unknown>;
    const consumerHandler = rawArrivalConsumer as Record<string, unknown>;
    for (const entrypoint of [
      "fetch",
      "scheduled",
      "alarm",
      "webSocketMessage",
      "webSocketClose",
      "webSocketError",
      "queue",
    ]) {
      expect(tailHandler[entrypoint], `Tail Worker が ${entrypoint} を公開する`).toBeUndefined();
    }
    for (const entrypoint of [
      "fetch",
      "scheduled",
      "alarm",
      "webSocketMessage",
      "webSocketClose",
      "webSocketError",
      "tail",
    ]) {
      expect(consumerHandler[entrypoint], `Consumer が ${entrypoint} を公開する`).toBeUndefined();
    }
  });
});
