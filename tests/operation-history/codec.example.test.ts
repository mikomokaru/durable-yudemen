import { describe, expect, it } from "vitest";
import { parseOperationLines, printCanonicalOperationLine, printCanonicalOperationLines } from "../../src/operation-history/codec";
import type { OperationRecord } from "../../src/operation-history/record";

const timestamp = (value: number): OperationRecord["eventTime"] => value as OperationRecord["eventTime"];
const common = {
  storeId: "store-1",
  timerId: "timer-1",
  eventTime: timestamp(1_700_000_000_000),
  slotIds: ["slot-2", "slot-1"],
  noodleType: "Thin",
  firmness: "normal",
} as const;
const records = [
  { ...common, operationKind: "boil-started", startTime: timestamp(1), endTime: timestamp(2) },
  { ...common, operationKind: "boiled", endTime: timestamp(2), boiledAt: timestamp(3) },
  { ...common, operationKind: "adjusted", endTime: timestamp(4) },
  { ...common, operationKind: "completed" },
  { ...common, operationKind: "cancelled" },
] satisfies readonly OperationRecord[];

describe("canonical Operation Record printer", () => {
  it("全kindの既知属性を固定順で出力する", () => {
    expect(records.map((record) => Object.keys(JSON.parse(printCanonicalOperationLine(record))))).toEqual([
      ["storeId", "timerId", "operationKind", "eventTime", "slotIds", "noodleType", "firmness", "startTime", "endTime"],
      ["storeId", "timerId", "operationKind", "eventTime", "slotIds", "noodleType", "firmness", "endTime", "boiledAt"],
      ["storeId", "timerId", "operationKind", "eventTime", "slotIds", "noodleType", "firmness", "endTime"],
      ["storeId", "timerId", "operationKind", "eventTime", "slotIds", "noodleType", "firmness"],
      ["storeId", "timerId", "operationKind", "eventTime", "slotIds", "noodleType", "firmness"],
    ]);
  });

  it("標準JSON表記を使い、未知・自然人・採番・導出属性を出力しない", () => {
    const record: OperationRecord & Record<string, unknown> = {
      ...records[3]!, storeId: "店\"舗\n\\", unknown: true, operatorName: "person",
      Record_Seq: 1, seq: 2, nextSeq: 3, remaining: 4,
    };
    const line = printCanonicalOperationLine(record);
    expect(line).toBe(JSON.stringify({
      storeId: "店\"舗\n\\", timerId: common.timerId, operationKind: "completed",
      eventTime: common.eventTime, slotIds: common.slotIds, noodleType: common.noodleType, firmness: common.firmness,
    }));
    expect(line).not.toContain("\n");
    expect(line).not.toContain("\uFEFF");
  });

  it("複数recordをLF一個で連結しrecordとslotIdsの順序を保つ", () => {
    const selected: readonly OperationRecord[] = [records[4]!, records[0]!];
    expect(printCanonicalOperationLines(selected)).toBe(selected.map(printCanonicalOperationLine).join("\n"));
    const firstLine = printCanonicalOperationLines(selected).split("\n")[0]!;
    expect(JSON.parse(firstLine).slotIds).toEqual(["slot-2", "slot-1"]);
    expect(printCanonicalOperationLines([])).toBe("");
  });
});


describe("Operation Record line parser", () => {
  it.each(records)("$operationKind の既知属性だけを復元する", (record) => {
    const parsed = parseOperationLines(printCanonicalOperationLine(record));
    expect(parsed).toEqual([{ ok: true, record }]);
  });

  it("未知属性とその重複を無視し、既知属性とslotIds順を保つ", () => {
    const line = '{"unknown":{"eventTime":"ignored"},"storeId":"store-1","unknown":false,"timerId":"timer-1","operationKind":"completed","eventTime":1700000000000,"slotIds":["slot-2","slot-1"],"noodleType":"Thin","firmness":"normal"}';
    expect(parseOperationLines(line)).toEqual([{ ok: true, record: records[3] }]);
  });

  it("escape表現を含む同じ既知属性の重複を拒否する", () => {
    const line = '{"storeId":"store-1","store\\u0049d":"store-2","timerId":"timer-1","operationKind":"completed","eventTime":1700000000000,"slotIds":["slot-2"],"noodleType":"Thin","firmness":"normal"}';
    expect(parseOperationLines(line)).toEqual([
      { ok: false, lineNumber: 1, failure: "duplicate-known-attribute" },
    ]);
  });

  it("kind別の必須属性と不許可な既知属性を拒否する", () => {
    const missingEndTime = '{"storeId":"store-1","timerId":"timer-1","operationKind":"adjusted","eventTime":1,"slotIds":["slot-1"],"noodleType":"Thin","firmness":"normal"}';
    const completedWithEndTime = '{"storeId":"store-1","timerId":"timer-1","operationKind":"completed","eventTime":1,"slotIds":["slot-1"],"noodleType":"Thin","firmness":"normal","endTime":2}';
    expect(parseOperationLines(missingEndTime)).toEqual([
      { ok: false, lineNumber: 1, failure: "missing-required-attribute" },
    ]);
    expect(parseOperationLines(completedWithEndTime)).toEqual([
      { ok: false, lineNumber: 1, failure: "disallowed-operation-kind-attribute" },
    ]);
  });

  it("既知属性の型制約と値制約を区別して拒否する", () => {
    const wrongType = '{"storeId":"store-1","timerId":"timer-1","operationKind":"completed","eventTime":"1","slotIds":["slot-1"],"noodleType":"Thin","firmness":"normal"}';
    const wrongValue = '{"storeId":"INVALID","timerId":"timer-1","operationKind":"completed","eventTime":0,"slotIds":[],"noodleType":"","firmness":"unknown"}';
    expect(parseOperationLines(wrongType)).toEqual([
      { ok: false, lineNumber: 1, failure: "known-attribute-type" },
    ]);
    expect(parseOperationLines(wrongValue)).toEqual([
      { ok: false, lineNumber: 1, failure: "known-attribute-value" },
    ]);
  });

  it("複合問題を規定の優先順位で一種類だけに分類する", () => {
    const lines = [
      '{"storeId":"store-1","storeId":"store-2"',
      '{"storeId":"store-1","storeId":"store-2"}',
      '{"operationKind":"completed","endTime":"bad"}',
      '{"storeId":"store-1","timerId":"timer-1","operationKind":"completed","eventTime":"bad","slotIds":["slot-1"],"noodleType":"Thin","firmness":"normal","endTime":"bad"}',
      '{"storeId":"","timerId":"timer-1","operationKind":"completed","eventTime":"bad","slotIds":["slot-1"],"noodleType":"Thin","firmness":"normal"}',
      '{"storeId":"INVALID","timerId":"","operationKind":"completed","eventTime":0,"slotIds":[],"noodleType":"","firmness":"unknown"}',
    ];

    expect(parseOperationLines(lines.join("\n"))).toEqual([
      { ok: false, lineNumber: 1, failure: "invalid-json" },
      { ok: false, lineNumber: 2, failure: "duplicate-known-attribute" },
      { ok: false, lineNumber: 3, failure: "missing-required-attribute" },
      { ok: false, lineNumber: 4, failure: "disallowed-operation-kind-attribute" },
      { ok: false, lineNumber: 5, failure: "known-attribute-type" },
      { ok: false, lineNumber: 6, failure: "known-attribute-value" },
    ]);
  });

  it("不正行の後続を含む全行を入力順で解析する", () => {
    const validCompleted = printCanonicalOperationLine(records[3]!);
    const validCancelled = printCanonicalOperationLine(records[4]!);
    const lines = [validCompleted, "not-json", validCancelled].join("\n");

    expect(parseOperationLines(lines)).toEqual([
      { ok: true, record: records[3] },
      { ok: false, lineNumber: 2, failure: "invalid-json" },
      { ok: true, record: records[4] },
    ]);
  });
});

describe("Operation History Codec example / edge coverage", () => {
  it("全kindのcanonical UTF-8 bytesを固定する", () => {
    const goldenLines = [
      '{"storeId":"store-1","timerId":"timer-1","operationKind":"boil-started","eventTime":1700000000000,"slotIds":["slot-2","slot-1"],"noodleType":"Thin","firmness":"normal","startTime":1,"endTime":2}',
      '{"storeId":"store-1","timerId":"timer-1","operationKind":"boiled","eventTime":1700000000000,"slotIds":["slot-2","slot-1"],"noodleType":"Thin","firmness":"normal","endTime":2,"boiledAt":3}',
      '{"storeId":"store-1","timerId":"timer-1","operationKind":"adjusted","eventTime":1700000000000,"slotIds":["slot-2","slot-1"],"noodleType":"Thin","firmness":"normal","endTime":4}',
      '{"storeId":"store-1","timerId":"timer-1","operationKind":"completed","eventTime":1700000000000,"slotIds":["slot-2","slot-1"],"noodleType":"Thin","firmness":"normal"}',
      '{"storeId":"store-1","timerId":"timer-1","operationKind":"cancelled","eventTime":1700000000000,"slotIds":["slot-2","slot-1"],"noodleType":"Thin","firmness":"normal"}',
    ];
    const encode = (line: string) => [...new TextEncoder().encode(line)];

    expect(records.map((record) => encode(printCanonicalOperationLine(record)))).toEqual(goldenLines.map(encode));
  });

  it("Unicode、quote、backslash、制御文字をJSON.stringifyと同じ表記でescapeしてround-tripする", () => {
    const record = {
      ...records[3]!,
      timerId: 'タイマー"\\\u0000\b\f\n\r\t',
      slotIds: ["釜一", '釜"二\\'] as const,
      noodleType: "細麺\n\t",
    } satisfies OperationRecord;
    const line = printCanonicalOperationLine(record);
    const expected = JSON.stringify({
      storeId: record.storeId,
      timerId: record.timerId,
      operationKind: record.operationKind,
      eventTime: record.eventTime,
      slotIds: record.slotIds,
      noodleType: record.noodleType,
      firmness: record.firmness,
    });

    expect([...new TextEncoder().encode(line)]).toEqual([...new TextEncoder().encode(expected)]);
    expect(line).not.toContain("\n");
    expect(parseOperationLines(line)).toEqual([{ ok: true, record }]);
  });

  it("正整数timestampの下限と安全整数上限を受理し、0・負数・小数を拒否する", () => {
    const boundaryRecord = {
      ...common,
      operationKind: "boil-started",
      eventTime: timestamp(1),
      startTime: timestamp(1),
      endTime: timestamp(Number.MAX_SAFE_INTEGER),
    } satisfies OperationRecord;
    const invalidLines = [
      printCanonicalOperationLine(boundaryRecord).replace('"eventTime":1', '"eventTime":0'),
      printCanonicalOperationLine(boundaryRecord).replace('"startTime":1', '"startTime":-1'),
      printCanonicalOperationLine(boundaryRecord).replace(`"endTime":${Number.MAX_SAFE_INTEGER}`, '"endTime":1.5'),
    ];

    expect(parseOperationLines(printCanonicalOperationLine(boundaryRecord))).toEqual([{ ok: true, record: boundaryRecord }]);
    expect(parseOperationLines(invalidLines.join("\n"))).toEqual([
      { ok: false, lineNumber: 1, failure: "known-attribute-value" },
      { ok: false, lineNumber: 2, failure: "known-attribute-value" },
      { ok: false, lineNumber: 3, failure: "known-attribute-value" },
    ]);
  });

  it("empty line、BOM、末尾LFを独立した不正行として固定する", () => {
    const valid = printCanonicalOperationLine(records[3]!);

    expect(parseOperationLines("")).toEqual([
      { ok: false, lineNumber: 1, failure: "invalid-json" },
    ]);
    expect(parseOperationLines(`\uFEFF${valid}`)).toEqual([
      { ok: false, lineNumber: 1, failure: "invalid-json" },
    ]);
    expect(parseOperationLines(`${valid}\n`)).toEqual([
      { ok: true, record: records[3] },
      { ok: false, lineNumber: 2, failure: "invalid-json" },
    ]);
  });

  it("CRLFを行区切りとして受理し、物理的な埋込改行は行ごとの不正JSONにする", () => {
    const completed = printCanonicalOperationLine(records[3]!);
    const cancelled = printCanonicalOperationLine(records[4]!);
    expect(parseOperationLines(`${completed}\r\n${cancelled}`)).toEqual([
      { ok: true, record: records[3] },
      { ok: true, record: records[4] },
    ]);

    const embeddedNewline = completed.replace('"timer-1"', '"timer\n-1"');
    expect(parseOperationLines(`${embeddedNewline}\n${cancelled}`)).toEqual([
      { ok: false, lineNumber: 1, failure: "invalid-json" },
      { ok: false, lineNumber: 2, failure: "invalid-json" },
      { ok: true, record: records[4] },
    ]);
  });

  it("全kindでparse(print(record))とprint(parse(canonical line))をexampleとして固定する", () => {
    for (const record of records) {
      const line = printCanonicalOperationLine(record);
      const [parsed] = parseOperationLines(line);
      expect(parsed).toEqual({ ok: true, record });
      if (parsed?.ok) {
        expect([...new TextEncoder().encode(printCanonicalOperationLine(parsed.record))])
          .toEqual([...new TextEncoder().encode(line)]);
      }
    }
  });
});