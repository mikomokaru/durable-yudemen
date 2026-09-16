// 遅延記録の canonical 一行。順序の固定、往復、そして操作履歴と混ざらないことを見る。

import { describe, expect, it } from "vitest";
import { parseLiftDelayLine, printCanonicalLiftDelayLine } from "../../src/lift-delay/codec";
import {
  LIFT_DELAY_PAYLOAD_VERSION,
  LIFT_DELAY_RECORD_TYPE,
  completionDelayMs,
  liftDelayEventId,
  type LiftDelayRecord,
} from "../../src/lift-delay/record";
import {
  parseOperationLines,
  printCanonicalOperationLine,
} from "../../src/operation-history/codec";
import type { OperationRecord } from "../../src/operation-history/record";

const completed: LiftDelayRecord = {
  recordType: LIFT_DELAY_RECORD_TYPE,
  payloadVersion: LIFT_DELAY_PAYLOAD_VERSION,
  eventId: liftDelayEventId("store-1", "timer-1", "completed"),
  storeId: "store-1",
  timerId: "timer-1",
  outcome: "completed",
  startedAt: 1_700_000_000_000,
  dueAt: 1_700_000_090_000,
  terminalAt: 1_700_000_105_000,
  noodleType: "REG",
  firmness: "normal",
  slotIds: ["4"],
};

const cancelled: LiftDelayRecord = {
  ...completed,
  eventId: liftDelayEventId("store-1", "timer-1", "cancelled"),
  outcome: "cancelled",
};

describe("canonical な一行", () => {
  it("属性を固定順序で出す", () => {
    expect(Object.keys(JSON.parse(printCanonicalLiftDelayLine(completed)))).toEqual([
      "recordType",
      "payloadVersion",
      "eventId",
      "storeId",
      "timerId",
      "outcome",
      "startedAt",
      "dueAt",
      "terminalAt",
      "noodleType",
      "firmness",
      "slotIds",
    ]);
  });

  it("改行も余分な空白も持たない", () => {
    const line = printCanonicalLiftDelayLine(completed);

    expect(line).not.toMatch(/[\n\r]/);
    expect(line).not.toMatch(/: /);
  });

  it("往復して同じ record と同じ byte 列になる", () => {
    for (const record of [completed, cancelled]) {
      const line = printCanonicalLiftDelayLine(record);
      const parsed = parseLiftDelayLine(line);

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.record).toEqual(record);
      expect(printCanonicalLiftDelayLine(parsed.record)).toBe(line);
    }
  });
});

describe("安定イベント ID", () => {
  it("店舗・Timer・終端種別だけから決まる", () => {
    expect(liftDelayEventId("store-1", "timer-1", "completed")).toBe("store-1:timer-1:completed");
    // 同じ終端は何度作っても同じ ID。時刻を混ぜないので再送で増えない。
    expect(liftDelayEventId("store-1", "timer-1", "completed")).toBe(completed.eventId);
  });

  it("完了と取消は別の ID になる", () => {
    expect(completed.eventId).not.toBe(cancelled.eventId);
  });
});

describe("遅延の導出", () => {
  it("完了は符号付きの差を返す", () => {
    expect(completionDelayMs(completed)).toBe(15_000);
    expect(completionDelayMs({ ...completed, terminalAt: completed.dueAt - 3_000 })).toBe(-3_000);
    expect(completionDelayMs({ ...completed, terminalAt: completed.dueAt })).toBe(0);
  });

  it("取消には遅延を割り当てない", () => {
    expect(completionDelayMs(cancelled)).toBeNull();
  });
});

describe("解析の失敗", () => {
  const brokenOf = (patch: Record<string, unknown>) => {
    const line = JSON.stringify({
      ...JSON.parse(printCanonicalLiftDelayLine(completed)),
      ...patch,
    });
    const parsed = parseLiftDelayLine(line);
    return parsed.ok ? null : parsed.failure;
  };

  it("他の形式の行は失敗ではなく別形式として返す", () => {
    expect(parseLiftDelayLine('{"operationKind":"completed"}')).toEqual({
      ok: false,
      failure: "other-record-type",
    });
  });

  it("未対応の形式版を区別する", () => {
    // 版 1・2 はどちらも読める（`LIFT_DELAY_SUPPORTED_PAYLOAD_VERSIONS`）。未知の版だけを弾く。
    expect(brokenOf({ payloadVersion: 3 })).toBe("unsupported-payload-version");
  });

  it("必須属性の欠落・型違反・値違反を分ける", () => {
    expect(brokenOf({ dueAt: undefined })).toBe("missing-required-attribute");
    expect(brokenOf({ dueAt: "1700000090000" })).toBe("attribute-type");
    expect(brokenOf({ dueAt: 0 })).toBe("attribute-type");
    expect(brokenOf({ outcome: "boiled" })).toBe("attribute-value");
    expect(brokenOf({ firmness: "very-hard" })).toBe("attribute-value");
    expect(brokenOf({ slotIds: [] })).toBe("attribute-type");
  });

  it("JSON でない行を弾く", () => {
    expect(parseLiftDelayLine("not json")).toEqual({ ok: false, failure: "invalid-json" });
    expect(parseLiftDelayLine("[]")).toEqual({ ok: false, failure: "invalid-json" });
  });
});

describe("操作履歴と混ざらない", () => {
  const operation = {
    storeId: "store-1",
    timerId: "timer-1",
    operationKind: "completed",
    eventTime: 1_700_000_105_000 as OperationRecord["eventTime"],
    slotIds: ["4"],
    noodleType: "REG",
    firmness: "normal",
  } satisfies OperationRecord;

  it("遅延の行を操作履歴として受理しない", () => {
    const line = printCanonicalLiftDelayLine(completed);
    const [parsed] = parseOperationLines(line);

    // 操作履歴の parser は未知属性を無視するが、canonical 再出力が一致しないので候補にならない。
    expect(parsed?.ok === true && printCanonicalOperationLine(parsed.record) === line).toBe(false);
  });

  it("操作履歴の行を遅延記録として数えない", () => {
    expect(parseLiftDelayLine(printCanonicalOperationLine(operation))).toEqual({
      ok: false,
      failure: "other-record-type",
    });
  });

  it("遅延の行は operationKind を名乗らない", () => {
    // 共通 Tail は operationKind の有無で操作履歴の候補を選ぶ。遅延の行がそこへ紛れない。
    expect(printCanonicalLiftDelayLine(completed)).not.toContain('"operationKind"');
  });
});
