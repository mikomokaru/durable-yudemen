import { describe, expect, it } from "vitest";
import {
  operationRecordPayload,
  printCanonicalOperationLine,
} from "../../src/operation-history/codec";
import type { OperationRecord } from "../../src/operation-history/record";
import { operationLinesFromTailEvents } from "../../src/operation-history/tail";

const record: OperationRecord = {
  storeId: "store-1",
  timerId: "timer-1",
  operationKind: "completed",
  eventTime: 1 as OperationRecord["eventTime"],
  slotIds: ["slot-1"],
  noodleType: "Thin",
  firmness: "normal",
};
const line = printCanonicalOperationLine(record);
/** Producer がいま console へ渡す形。 */
const payload = () => operationRecordPayload(record);
/** 候補 1 件の期待値。canonical 一行と、その元になった記録の両方を持つ。 */
const candidate = { line, record };
// root wrangler.jsonc の "name" と一致する、現存するただ一つの Producer script。
const PRODUCER_SCRIPT = "yude-men-timer";
const event = (
  scriptName: string | null,
  logs: readonly {
    readonly level: string;
    readonly message: readonly unknown[];
  }[],
) => ({ scriptName, logs });

// Requirements 4.3, 4.4, 4.13, 4.14
describe("operationLinesFromTailEvents", () => {
  it("実在するProducer scriptのeventから妥当な候補を入力順で抽出する", () => {
    const events = [
      event(PRODUCER_SCRIPT, [{ level: "log", message: [line] }]),
      event(PRODUCER_SCRIPT, [{ level: "log", message: [line] }]),
      event(PRODUCER_SCRIPT, [{ level: "log", message: [line] }]),
    ];
    expect(operationLinesFromTailEvents(events)).toEqual({
      candidates: [candidate, candidate, candidate],
      failures: [],
    });
  });

  it.each([
    ["未知script", event("other-worker", [{ level: "log", message: [line] }])],
    ["未導入の環境別script", event("yude-men-timer-prod", [{ level: "log", message: [line] }])],
    ["log以外", event(PRODUCER_SCRIPT, [{ level: "warn", message: [line] }])],
    ["複数引数", event(PRODUCER_SCRIPT, [{ level: "log", message: [line, "extra"] }])],
    ["object でも string でもない引数", event(PRODUCER_SCRIPT, [{ level: "log", message: [42] }])],
    ["配列", event(PRODUCER_SCRIPT, [{ level: "log", message: [[record]] }])],
    ["null", event(PRODUCER_SCRIPT, [{ level: "log", message: [null] }])],
    ["複数行", event(PRODUCER_SCRIPT, [{ level: "log", message: [`${line}\n${line}`] }])],
    ["非canonical JSON", event(PRODUCER_SCRIPT, [{ level: "log", message: [` ${line}`] }])],
  ])("%sをQueue候補にもcodec失敗にも含めない", (_label, candidate) => {
    expect(operationLinesFromTailEvents([candidate])).toEqual({
      candidates: [],
      failures: [],
    });
  });

  it("codecへ到達した候補の1始まり位置と解析失敗種別を保持する", () => {
    // 操作記録を名乗る（operationKind を持つ）行だけが codec へ進む。名乗らない行は他機能の
    // アプリログであり、失敗として数えない（2026-09-16 の本番観測を受けた変更）。
    const claimsButBroken = '{"operationKind":"completed","storeId":"store-1"';
    const claimsButIncomplete = '{"operationKind":"completed","storeId":"store-1"}';
    const otherAppLog = '{"storeId":"store-1","event":"cpsat.plan-decided"}';
    const events = [
      event(PRODUCER_SCRIPT, [
        { level: "warn", message: ["not-json"] },
        { level: "log", message: ["not-json"] },
        { level: "log", message: [otherAppLog] },
        { level: "log", message: [line, "extra"] },
        { level: "log", message: [line] },
        { level: "log", message: [claimsButBroken] },
        { level: "log", message: [claimsButIncomplete] },
      ]),
    ];

    expect(operationLinesFromTailEvents(events)).toEqual({
      candidates: [candidate],
      failures: [
        { lineNumber: 4, failure: "invalid-json" },
        { lineNumber: 5, failure: "missing-required-attribute" },
      ],
    });
  });

  it("同じWorkerの他の構造化ログを送らず、失敗としても数えない", () => {
    // 旧版はこれを codec 失敗として数えていた。本番では cpsat 計画ログ等が同じ形で出るため、
    // その数え方だと失敗件数がアプリのログ量になり、品質指標の分母が濁る。
    const debugLine =
      '{"seq":1,"at":1,"atIso":"x","direction":"send","messageType":"snapshot","payload":{}}';
    const planLine = '{"event":"cpsat.plan-decided","storeId":"store-1","slots":3}';

    expect(
      operationLinesFromTailEvents([
        event(PRODUCER_SCRIPT, [
          { level: "log", message: [debugLine] },
          { level: "log", message: [planLine] },
        ]),
      ]),
    ).toEqual({ candidates: [], failures: [] });
  });
});

// オブジェクトで届く経路（2026-09-16）。Producer はこちらで出し、Tail が Zod で検査する。
describe("operationLinesFromTailEvents — オブジェクトで届く経路", () => {
  it("Producer が出す payload をそのまま候補にする", () => {
    expect(
      operationLinesFromTailEvents([
        event(PRODUCER_SCRIPT, [{ level: "log", message: [payload()] }]),
      ]),
    ).toEqual({ candidates: [candidate], failures: [] });
  });

  it("文字列とオブジェクトが混ざっても入力順を保つ", () => {
    // 配備の入れ替え中は両方が同じ event に載り得る。どちらも落とさない。
    expect(
      operationLinesFromTailEvents([
        event(PRODUCER_SCRIPT, [
          { level: "log", message: [line] },
          { level: "log", message: [payload()] },
        ]),
      ]),
    ).toEqual({ candidates: [candidate, candidate], failures: [] });
  });

  it("名乗らないオブジェクトを候補にも失敗にも含めない", () => {
    // 同じ Worker が出す構造化ログ。オブジェクトで出ても、名乗らなければ対象外である。
    expect(
      operationLinesFromTailEvents([
        event(PRODUCER_SCRIPT, [
          { level: "log", message: [{ event: "cpsat.plan-decided", storeId: "store-1" }] },
          { level: "log", message: [{ operationKind: 42 }] },
        ]),
      ]),
    ).toEqual({ candidates: [], failures: [] });
  });

  it("名乗ったが検査に通らないオブジェクトを、落ちた場とともに失敗にする", () => {
    const observed = operationLinesFromTailEvents([
      event(PRODUCER_SCRIPT, [{ level: "log", message: [{ ...payload(), eventTime: -1 }] }]),
    ]);

    expect(observed.candidates).toEqual([]);
    expect(observed.failures).toHaveLength(1);
    expect(observed.failures[0]).toMatchObject({ lineNumber: 1, failure: "schema-invalid" });
    expect(observed.failures[0]?.issues?.[0]).toContain("eventTime");
  });

  it("kind に属さない既知属性を持つ行を通さない", () => {
    // `completed` は `endTime` を持たない。文字列時代の disallowed-operation-kind-attribute と同じ禁。
    const observed = operationLinesFromTailEvents([
      event(PRODUCER_SCRIPT, [{ level: "log", message: [{ ...payload(), endTime: 2 }] }]),
    ]);

    expect(observed.candidates).toEqual([]);
    expect(observed.failures[0]).toMatchObject({ failure: "schema-invalid" });
  });

  it("未知の属性を持つ行を通さない", () => {
    const observed = operationLinesFromTailEvents([
      event(PRODUCER_SCRIPT, [{ level: "log", message: [{ ...payload(), vendorExtra: "x" }] }]),
    ]);

    expect(observed.candidates).toEqual([]);
    expect(observed.failures[0]).toMatchObject({ failure: "schema-invalid" });
  });

  it("直列化できない値を持つ行を通さない", () => {
    // Producer は組み立てをやめたので、こういう値はここまで届く。**ここで止める。**
    const observed = operationLinesFromTailEvents([
      event(PRODUCER_SCRIPT, [{ level: "log", message: [{ ...payload(), slotIds: [1n] }] }]),
    ]);

    expect(observed.candidates).toEqual([]);
    expect(observed.failures[0]).toMatchObject({ failure: "schema-invalid" });
  });

  it("入れ子の深い・長い値でも、契約に無ければ通さない", () => {
    // 実測では値は途中で切れずに届く（2026-09-16）。届いた上で、契約に無いので落ちる。
    const observed = operationLinesFromTailEvents([
      event(PRODUCER_SCRIPT, [
        { level: "log", message: [{ ...payload(), noodleType: "x".repeat(100_000) }] },
      ]),
    ]);

    // 長いこと自体は禁じていない。**長さの上限は物理行の側が持つ**（arrival の検証）。
    expect(observed.candidates).toHaveLength(1);
    expect(observed.failures).toEqual([]);
  });
});
