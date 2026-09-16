// Tail から Stream へ直接送る入口。送る batch と、送らずに数える一件の分かれ方を固定する。

import { describe, expect, it } from "vitest";
import type { HistoryArrival } from "../../src/data-platform/arrival";
import historyTail, {
  SEND_BATCH_LIMIT,
  SEND_BYTE_LIMIT,
  SEND_RECORD_LIMIT,
  historyIntake,
  type HistoryTailEnv,
  type ObservedTailEvent,
} from "../../src/data-platform/history-tail";
import {
  operationRecordPayload,
  printCanonicalOperationLine,
} from "../../src/operation-history/codec";
import {
  liftDelayStartPayload,
  printCanonicalLiftDelayLine,
  printCanonicalLiftDelayStartLine,
} from "../../src/lift-delay/codec";
import { startRecordOf, terminalRecordOf } from "../../src/lift-delay/derive";
import { EMPTY_SHOWN_PLAN } from "../../src/engine/stability";
import type { OperationRecord } from "../../src/operation-history/record";
import { completedRecord, timestamp } from "./support/arrival-fixture";

const OBSERVED_AT = 1_700_000_000_500;

const line = (record: OperationRecord) => printCanonicalOperationLine(record);

const event = (
  messages: readonly unknown[],
  overrides: Partial<ObservedTailEvent> = {},
): ObservedTailEvent => ({
  scriptName: "yude-men-timer",
  logs: messages.map((message) => ({ level: "log", message: [message] })),
  truncated: false,
  ...overrides,
});

const ids = () => {
  let next = 0;
  return () => {
    next += 1;
    return `arrival-${next}`;
  };
};

const intakeOf = (events: readonly ObservedTailEvent[]) =>
  historyIntake(events, OBSERVED_AT, ids());

const manyRecords = (count: number): OperationRecord[] =>
  Array.from({ length: count }, (_unused, index) => ({
    ...completedRecord,
    timerId: `timer-${index}`,
    eventTime: timestamp(1_700_000_000_000 + index),
  }));

describe("観測行の取り込み", () => {
  it("妥当な行を物理行へ写して 1 batch に載せる", () => {
    const intake = intakeOf([event([line(completedRecord)])]);

    expect(intake.discards).toEqual([]);
    expect(intake.batches).toHaveLength(1);
    expect(intake.batches[0]).toHaveLength(1);
    expect(intake.batches[0]?.[0]).toMatchObject({
      dataset: "operation",
      arrivalId: "arrival-1",
      storeId: completedRecord.storeId,
      eventTime: completedRecord.eventTime,
      observedAt: OBSERVED_AT,
      canonicalPayload: line(completedRecord),
    });
  });

  it("不正行を理由と行番号で数え、後続の妥当行は送る", () => {
    // 操作記録を名乗る（operationKind を持つ）壊れた行だけが失敗として数えられる。
    const intake = intakeOf([event(['{"operationKind":}', line(completedRecord)])]);

    expect(intake.discards).toEqual([{ kind: "codec", lineNumber: 1, failure: "invalid-json" }]);
    expect(intake.batches.flat()).toHaveLength(1);
  });

  it("同じWorkerの他のアプリログを失敗として数えない", () => {
    // 本番で毎分 200 件の警告を出していた原因。名乗らない行は観測の対象外にする。
    const intake = intakeOf([
      event([
        '{"event":"cpsat.plan-decided","storeId":"store-1","slots":3}',
        '{"seq":1,"direction":"send","messageType":"snapshot"}',
        "plain text log",
      ]),
    ]);

    expect(intake).toEqual({ batches: [], discards: [] });
  });

  it("想定 Producer 以外の行を取り込まない", () => {
    const intake = intakeOf([
      event([line(completedRecord)], { scriptName: "other-worker" }),
      event([line(completedRecord)], { scriptName: null }),
    ]);

    expect(intake).toEqual({ batches: [], discards: [] });
  });

  it("合成プローブの script だけを合成として印す", () => {
    const probeLine = line({ ...completedRecord, timerId: "probe-42" });
    const intake = intakeOf([
      event([probeLine], { scriptName: "yude-men-history-probe" }),
      event([line(completedRecord)]),
    ]);

    expect(intake.batches.flat().map((arrival) => [arrival.isSynthetic, arrival.probeId])).toEqual([
      [true, "probe-42"],
      [false, null],
    ]);
  });

  it("切詰めを検出済み・否定確認済み・不明で書き分ける", () => {
    const truncations = [
      event([line(completedRecord)], { truncated: true }),
      event([line(completedRecord)], { truncated: false }),
      // 旧 runtime のように値が無い場合。false で埋めない。
      { scriptName: "yude-men-timer", logs: [{ level: "log", message: [line(completedRecord)] }] },
    ];

    const metadata = intakeOf(truncations)
      .batches.flat()
      .map((arrival) => JSON.parse(arrival.sourceMetadata));

    expect(metadata.map((entry) => [entry.truncation, entry.truncationBasis])).toEqual([
      ["detected", "trace-item"],
      ["not-detected", "trace-item"],
      ["unknown", "unavailable"],
    ]);
  });

  it("件数の上限で batch を分ける", () => {
    const intake = intakeOf([event(manyRecords(SEND_RECORD_LIMIT + 1).map(line))]);

    expect(intake.batches.map((batch) => batch.length)).toEqual([SEND_RECORD_LIMIT, 1]);
    expect(intake.discards).toEqual([]);
  });

  it("byte の上限で batch を分ける", () => {
    // 1 行あたりの上限に近い大きな行を並べ、件数の上限より先に byte の上限が効くことを見る。
    const wide = "x".repeat(15_000);
    const records = manyRecords(SEND_RECORD_LIMIT).map((record) => ({
      ...record,
      noodleType: wide,
    }));

    const batches = intakeOf([event(records.map(line))]).batches;

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((batch) => batch.length < SEND_RECORD_LIMIT)).toBe(true);
    expect(
      batches.every(
        (batch) =>
          batch.reduce(
            (bytes, arrival) => bytes + new TextEncoder().encode(JSON.stringify(arrival)).length,
            0,
          ) <= SEND_BYTE_LIMIT,
      ),
    ).toBe(true);
  });

  it("送信回数の予算を超えた分は送らずに数える", () => {
    const overflow = SEND_RECORD_LIMIT * SEND_BATCH_LIMIT + 2;
    const intake = intakeOf([event(manyRecords(overflow).map(line))]);

    expect(intake.batches).toHaveLength(SEND_BATCH_LIMIT);
    expect(intake.batches.flat()).toHaveLength(SEND_RECORD_LIMIT * SEND_BATCH_LIMIT);
    expect(intake.discards).toEqual([
      { kind: "send-budget", arrivalId: `arrival-${SEND_RECORD_LIMIT * SEND_BATCH_LIMIT + 1}` },
      { kind: "send-budget", arrivalId: `arrival-${SEND_RECORD_LIMIT * SEND_BATCH_LIMIT + 2}` },
    ]);
  });

  it("行ごとに別の arrival ID を採番する", () => {
    const intake = intakeOf([event(manyRecords(3).map(line))]);

    expect(intake.batches.flat().map((arrival) => arrival.arrivalId)).toEqual([
      "arrival-1",
      "arrival-2",
      "arrival-3",
    ]);
  });
});

const delayStartLine = printCanonicalLiftDelayStartLine(
  startRecordOf("store-1", "timer-9", {
    startedAt: 1_700_000_000_000,
    orderItem: null,
    pending: [],
    activeTimers: [],
    shownPlan: [],
  }),
);
const delayTerminalLine = printCanonicalLiftDelayLine(
  terminalRecordOf({
    storeId: "store-1",
    timer: {
      id: "timer-9",
      slotIds: ["4"],
      noodleType: "REG",
      firmness: "normal",
      startTime: 1_700_000_000_000,
      endTime: 1_700_000_090_000,
      adjustment: 0,
    } as never,
    outcome: "completed",
    terminalAt: 1_700_000_105_000,
  }),
);

describe("遅延ログの合流", () => {
  it("開始と終端の行を lift-delay dataset として送る", () => {
    const rows = intakeOf([event([delayStartLine, delayTerminalLine])]).batches.flat();

    expect(rows.map((row) => [row.dataset, row.eventId, row.eventTime])).toEqual([
      ["lift-delay", "store-1:timer-9:start", 1_700_000_000_000],
      ["lift-delay", "store-1:timer-9:completed", 1_700_000_105_000],
    ]);
    // 原文はそのまま運ぶ。
    expect(rows[0]?.canonicalPayload).toBe(delayStartLine);
  });

  it("操作履歴と遅延が同じ invocation に混ざっても両方送る", () => {
    const rows = intakeOf([event([line(completedRecord), delayTerminalLine])]).batches.flat();

    expect(rows.map((row) => row.dataset)).toEqual(["lift-delay", "operation"]);
  });

  it("名乗った行が壊れていれば遅延の失敗として数える", () => {
    const intake = intakeOf([event(['{"recordType":"lift-delay","payloadVersion":1}'])]);

    expect(intake.discards).toEqual([
      { kind: "lift-delay-codec", lineNumber: 1, failure: "missing-required-attribute" },
    ]);
  });

  it("名乗らない行は遅延の失敗として数えない", () => {
    const intake = intakeOf([event(['{"recordType":"something-else","payloadVersion":1}'])]);

    expect(intake).toEqual({ batches: [], discards: [] });
  });
});

// Producer が出す姿（オブジェクト）で入口まで通す。文字列は配備の入れ替え中だけの経路である。
describe("オブジェクトで届く経路の取り込み", () => {
  it("payload を物理行へ写し、canonical 文字列を Tail が組む", () => {
    const intake = intakeOf([event([operationRecordPayload(completedRecord)])]);

    expect(intake.discards).toEqual([]);
    expect(intake.batches).toHaveLength(1);
    const [arrival] = intake.batches[0] ?? [];
    expect(arrival?.dataset).toBe("operation");
    // 保存する原文は Tail が出し直した canonical。Producer が組んだ byte 列と一致する。
    expect(arrival?.canonicalPayload).toBe(line(completedRecord));
  });

  it("文字列とオブジェクトが同じ invocation に混ざっても両方送る", () => {
    const intake = intakeOf([
      event([
        line({ ...completedRecord, timerId: "from-string" }),
        operationRecordPayload({ ...completedRecord, timerId: "from-object" }),
      ]),
    ]);

    expect(intake.discards).toEqual([]);
    expect(intake.batches[0]?.map((arrival) => arrival.canonicalPayload)).toEqual([
      line({ ...completedRecord, timerId: "from-string" }),
      line({ ...completedRecord, timerId: "from-object" }),
    ]);
  });

  it("検査に通らない payload を、理由と落ちた場とともに数える", () => {
    const intake = intakeOf([
      event([{ ...operationRecordPayload(completedRecord), firmness: "molten" }]),
    ]);

    expect(intake.batches).toEqual([]);
    expect(intake.discards).toHaveLength(1);
    expect(intake.discards[0]).toMatchObject({ kind: "codec", failure: "schema-invalid" });
  });

  it("名乗らない payload を候補にも失敗にも含めない", () => {
    const intake = intakeOf([event([{ event: "cpsat.plan-decided", storeId: "store-1" }])]);

    expect(intake.batches).toEqual([]);
    expect(intake.discards).toEqual([]);
  });

  it("遅延ログも payload のまま dataset を分けて送る", () => {
    const start = startRecordOf("store-1", "timer-1", {
      startedAt: 1_700_000_000_000,
      orderItem: null,
      pending: [],
      activeTimers: [],
      shownPlan: EMPTY_SHOWN_PLAN,
    });
    const intake = intakeOf([
      event([operationRecordPayload(completedRecord), liftDelayStartPayload(start)]),
    ]);

    expect(intake.discards).toEqual([]);
    expect(intake.batches.map((batch) => batch[0]?.dataset)).toEqual(["lift-delay", "operation"]);
    expect(
      intake.batches.find((batch) => batch[0]?.dataset === "lift-delay")?.[0]?.canonicalPayload,
    ).toBe(printCanonicalLiftDelayStartLine(start));
  });
});

describe("Stream への送信", () => {
  const fakeEnv = () => {
    const sent: HistoryArrival[][] = [];
    const delayed: HistoryArrival[][] = [];
    const orders: HistoryArrival[][] = [];
    const collector = (into: HistoryArrival[][]) => ({
      send: async (records: HistoryArrival[]) => {
        into.push(records);
      },
    });
    const env: HistoryTailEnv = {
      HISTORY_ARRIVALS: collector(sent) as unknown as HistoryTailEnv["HISTORY_ARRIVALS"],
      LIFT_DELAY_ARRIVALS: collector(delayed) as unknown as HistoryTailEnv["LIFT_DELAY_ARRIVALS"],
      ORDER_ARRIVAL_ARRIVALS: collector(
        orders,
      ) as unknown as HistoryTailEnv["ORDER_ARRIVAL_ARRIVALS"],
    };
    return { env, sent, delayed, orders };
  };

  const fakeContext = () => {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) };
    return { ctx, settled: () => Promise.all(pending) };
  };

  it("観測した行を Stream へ送る", async () => {
    const { env, sent } = fakeEnv();
    const { ctx, settled } = fakeContext();

    await historyTail.tail?.(
      [event([line(completedRecord)])] as unknown as TraceItem[],
      env,
      ctx as unknown as ExecutionContext,
    );
    await settled();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.[0]?.canonicalPayload).toBe(line(completedRecord));
  });

  it("dataset ごとに別の Stream へ送る", async () => {
    const { env, sent, delayed } = fakeEnv();
    const { ctx, settled } = fakeContext();

    await historyTail.tail?.(
      [event([line(completedRecord), delayTerminalLine])] as unknown as TraceItem[],
      env,
      ctx as unknown as ExecutionContext,
    );
    await settled();

    // 同じ invocation の 2 行が、混ざらずにそれぞれの Stream へ行く。
    expect(sent.flat().map((row) => row.dataset)).toEqual(["operation"]);
    expect(delayed.flat().map((row) => row.dataset)).toEqual(["lift-delay"]);
  });

  it("送る行が無ければ送信しない", async () => {
    const { env, sent } = fakeEnv();
    const { ctx, settled } = fakeContext();

    await historyTail.tail?.(
      [event(["prefix", 42])] as unknown as TraceItem[],
      env,
      ctx as unknown as ExecutionContext,
    );
    await settled();

    expect(sent).toEqual([]);
  });

  it("送信の失敗を握り潰して外へ伝えない", async () => {
    const { ctx, settled } = fakeContext();
    const rejecting = {
      send: () => Promise.reject(new Error("stream unavailable")),
    } as unknown as HistoryTailEnv["HISTORY_ARRIVALS"];
    const env: HistoryTailEnv = {
      HISTORY_ARRIVALS: rejecting,
      LIFT_DELAY_ARRIVALS: rejecting,
      ORDER_ARRIVAL_ARRIVALS: rejecting,
    };

    await historyTail.tail?.(
      [event([line(completedRecord)])] as unknown as TraceItem[],
      env,
      ctx as unknown as ExecutionContext,
    );

    await expect(settled()).resolves.toBeDefined();
  });
});
