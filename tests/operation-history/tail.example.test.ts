import { describe, expect, it } from "vitest";
import { printCanonicalOperationLine } from "../../src/operation-history/codec";
import type { OperationRecord } from "../../src/operation-history/record";
import { operationLinesFromTailEvents } from "../../src/operation-history/tail";

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
const event = (scriptName: string | null, logs: readonly {
  readonly level: string;
  readonly message: readonly unknown[];
}[]) => ({ scriptName, logs });

// Requirements 4.3, 4.4, 4.13, 4.14
describe("operationLinesFromTailEvents", () => {
  it("実在するProducer scriptのeventから妥当な候補を入力順で抽出する", () => {
    const events = [
      event(PRODUCER_SCRIPT, [{ level: "log", message: [line] }]),
      event(PRODUCER_SCRIPT, [{ level: "log", message: [line] }]),
      event(PRODUCER_SCRIPT, [{ level: "log", message: [line] }]),
    ];
    expect(operationLinesFromTailEvents(events)).toEqual({
      candidates: [line, line, line],
      failures: [],
    });
  });

  it.each([
    ["未知script", event("other-worker", [{ level: "log", message: [line] }])],
    ["未導入の環境別script", event("yude-men-timer-prod", [{ level: "log", message: [line] }])],
    ["log以外", event(PRODUCER_SCRIPT, [{ level: "warn", message: [line] }])],
    ["複数引数", event(PRODUCER_SCRIPT, [{ level: "log", message: [line, "extra"] }])],
    ["非string", event(PRODUCER_SCRIPT, [{ level: "log", message: [42] }])],
    ["複数行", event(PRODUCER_SCRIPT, [{ level: "log", message: [`${line}\n${line}`] }])],
    ["非canonical JSON", event(PRODUCER_SCRIPT, [{ level: "log", message: [` ${line}`] }])],
  ])("%sをQueue候補にもcodec失敗にも含めない", (_label, candidate) => {
    expect(operationLinesFromTailEvents([candidate])).toEqual({
      candidates: [],
      failures: [],
    });
  });

  it("codecへ到達した候補の1始まり位置と解析失敗種別を保持する", () => {
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

    expect(operationLinesFromTailEvents(events)).toEqual({
      candidates: [line],
      failures: [
        { lineNumber: 1, failure: "invalid-json" },
        { lineNumber: 3, failure: "missing-required-attribute" },
      ],
    });
  });

  it("src/observe debug JSONをQueueへ送らずcodec失敗として観測側に残す", () => {
    const debugLine = '{"seq":1,"at":1,"atIso":"x","direction":"send","messageType":"snapshot","payload":{}}';

    expect(operationLinesFromTailEvents([
      event(PRODUCER_SCRIPT, [{ level: "log", message: [debugLine] }]),
    ])).toEqual({
      candidates: [],
      failures: [{ lineNumber: 1, failure: "missing-required-attribute" }],
    });
  });
});
