// 遅延の要約。取消を混ぜない、不明を埋めない、0 件で 0 秒と言わない、を固定する。

import { describe, expect, it } from "vitest";
import { summarizeLiftDelayRows } from "../../src/observe/lift-delay-summary";
import {
  printCanonicalLiftDelayLine,
  printCanonicalLiftDelayStartLine,
} from "../../src/lift-delay/codec";
import {
  liftDelayEventId,
  liftDelayStartEventId,
  type LiftDelayRecord,
  type LiftDelayStartRecord,
} from "../../src/lift-delay/record";

const START = 1_700_000_000_000;

const terminal = (
  timerId: string,
  delayMs: number,
  outcome: LiftDelayRecord["outcome"] = "completed",
): LiftDelayRecord => ({
  recordType: "lift-delay",
  payloadVersion: 1,
  eventId: liftDelayEventId("store-1", timerId, outcome),
  storeId: "store-1",
  timerId,
  outcome,
  startedAt: START,
  dueAt: START + 90_000,
  terminalAt: START + 90_000 + delayMs,
  noodleType: "REG",
  firmness: "normal",
  slotIds: ["4"],
});

const start = (timerId: string, pendingOtherItems = 2): LiftDelayStartRecord => ({
  recordType: "lift-delay-start",
  payloadVersion: 2,
  eventId: liftDelayStartEventId("store-1", timerId),
  storeId: "store-1",
  timerId,
  startedAt: START,
  source: "order-item",
  pendingBeforeStart: pendingOtherItems + 1,
  pendingOtherItems,
  activeTimerCount: 2,
  occupiedSlotCount: 2,
  shownPlacement: { kind: "absent" },
  appliedWait: { kind: "not-introduced" },
  orderItem: { externalOrderId: "order-1", itemIndex: 0 },
});

const rowOf = (canonicalPayload: string) => ({ canonicalPayload });
const rowsOf = (records: readonly (LiftDelayRecord | LiftDelayStartRecord)[]) =>
  records.map((record) =>
    rowOf(
      record.recordType === "lift-delay-start"
        ? printCanonicalLiftDelayStartLine(record)
        : printCanonicalLiftDelayLine(record),
    ),
  );

describe("件数の分け方", () => {
  it("完了と取消を分け、取消を遅延の標本に入れない", () => {
    const summary = summarizeLiftDelayRows(
      rowsOf([terminal("t1", 10_000), terminal("t2", 0, "cancelled")]),
    );

    expect(summary.counts).toMatchObject({ completed: 1, cancelled: 1, terminalRows: 2 });
    expect(summary.delay.samples).toBe(1);
  });

  it("開始の行が無い終端を文脈不明として数える", () => {
    const summary = summarizeLiftDelayRows(
      rowsOf([start("t1"), terminal("t1", 5_000), terminal("t2", 5_000)]),
    );

    expect(summary.counts.contextUnknown).toBe(1);
    expect(summary.contextMatch).toEqual({ matched: 1, terminals: 2, rate: 0.5 });
  });

  it("同じ ID の異内容を競合として外す", () => {
    const original = terminal("t1", 5_000);
    const tampered = { ...original, terminalAt: original.terminalAt + 1_000 };

    const summary = summarizeLiftDelayRows(rowsOf([original, tampered]));

    expect(summary.counts.conflicts).toBe(1);
    // 最初に見た内容だけを標本にする。上書きしない。
    expect(summary.delay.samples).toBe(1);
    expect(summary.delay.maxMs).toBe(5_000);
  });

  it("同じ ID の同内容は 1 件に収束させる", () => {
    const record = terminal("t1", 5_000);

    const summary = summarizeLiftDelayRows(rowsOf([record, record]));

    expect(summary.counts.conflicts).toBe(0);
    expect(summary.delay.samples).toBe(1);
  });

  it("読めない行を数に残す", () => {
    const summary = summarizeLiftDelayRows([
      rowOf('{"recordType":"lift-delay","payloadVersion":1}'),
      rowOf("not json"),
      { canonicalPayload: 42 },
    ]);

    expect(summary.counts.faults).toBe(3);
    expect(summary.delay.samples).toBe(0);
  });
});

describe("遅れの数え方", () => {
  it("早め・ちょうど・遅れを分ける", () => {
    const summary = summarizeLiftDelayRows(
      rowsOf([terminal("t1", -3_000), terminal("t2", 0), terminal("t3", 12_000)]),
    );

    expect(summary.delay).toMatchObject({ samples: 3, early: 1, zero: 1, late: 1 });
  });

  it("中央値は偶数なら中央 2 値の平均にする", () => {
    const summary = summarizeLiftDelayRows(
      rowsOf([
        terminal("t1", 1_000),
        terminal("t2", 3_000),
        terminal("t3", 5_000),
        terminal("t4", 11_000),
      ]),
    );

    expect(summary.delay.medianMs).toBe(4_000);
  });

  it("p90 は nearest-rank で取る", () => {
    const rows = rowsOf(
      Array.from({ length: 10 }, (_unused, index) => terminal(`t${index}`, (index + 1) * 1_000)),
    );

    // 10 件なら ceil(0.9 * 10) = 9 番目（1 始まり）。
    expect(summarizeLiftDelayRows(rows).delay.p90Ms).toBe(9_000);
  });

  it("0 件では分位点を null にする（0 秒と言わない）", () => {
    const summary = summarizeLiftDelayRows(rowsOf([terminal("t1", 0, "cancelled")]));

    expect(summary.delay).toMatchObject({
      samples: 0,
      medianMs: null,
      p90Ms: null,
      maxMs: null,
    });
    expect(summary.contextMatch.rate).toBe(0);
  });

  it("行が無ければ突合率も算出不能にする", () => {
    expect(summarizeLiftDelayRows([]).contextMatch).toEqual({
      matched: 0,
      terminals: 0,
      rate: null,
    });
  });

  it("分布の区切りへ入れる", () => {
    const summary = summarizeLiftDelayRows(
      rowsOf([
        terminal("t1", -1_000),
        terminal("t2", 0),
        terminal("t3", 3_000),
        terminal("t4", 10_000),
        terminal("t5", 20_000),
        terminal("t6", 45_000),
        terminal("t7", 90_000),
        terminal("t8", 300_000),
      ]),
    );

    expect(summary.delay.distribution).toEqual({
      negative: 1,
      zero: 1,
      upTo5s: 1,
      upTo15s: 1,
      upTo30s: 1,
      upTo60s: 1,
      upTo120s: 1,
      over120s: 1,
    });
  });
});

describe("条件と日別", () => {
  it("日別は timezone を明示して数える", () => {
    const summary = summarizeLiftDelayRows(rowsOf([terminal("t1", 0)]), "Asia/Tokyo");

    expect(summary.timezone).toBe("Asia/Tokyo");
    expect(Object.values(summary.byDay)).toEqual([1]);
  });

  it("文脈のある終端だけから条件の代表値を出す", () => {
    const summary = summarizeLiftDelayRows(
      rowsOf([start("t1", 5), terminal("t1", 1_000), terminal("t2", 1_000)]),
    );

    // 文脈不明の t2 を 0 件として混ぜない。
    expect(summary.byBackorder).toEqual({ withContext: 1, medianPendingOtherItems: 5 });
  });
});
