// 注文到着の名乗りと検査。**封筒だけを検査し、`order_items` 以下には触れない**ことを固定する。

import { describe, expect, it } from "vitest";
import { orderArrivalPayload, printCanonicalOrderArrivalLine } from "../../src/order-arrival/codec";
import { orderArrivalRecordOf } from "../../src/order-arrival/derive";
import { orderArrivalLinesFromTailEvents } from "../../src/order-arrival/tail";
import type { ArrivalRecord } from "../../src/ingress/batch";

const PRODUCER = new Set(["yude-men-timer"]);
const ARRIVED_AT = 1_700_000_000_000;

/** 上流が届ける Record。payload はベンダー由来の申告値そのままである。 */
const arrivalRecord = (payload: Record<string, unknown>): ArrivalRecord => ({
  path: "/lio/order",
  payload,
  arrivalTimestampMs: ARRIVED_AT,
  sequenceNumber: "42",
});

const simplePayload = {
  store_id: "1102",
  terminal_id: "1",
  bill_no: "7",
  datetime: "2026-09-16T18:52:19",
  order_items: [{ plu_no: "11421", child_items: [{ plu_no: "10010" }] }],
};

const recordOf = (payload: Record<string, unknown> = simplePayload) =>
  orderArrivalRecordOf(
    "yamaokaya-1102",
    "1102:1:7:2026-09-16T18%3A52%3A19",
    arrivalRecord(payload),
  );

const event = (messages: readonly unknown[]) => ({
  scriptName: "yude-men-timer",
  logs: messages.map((message) => ({ level: "log", message: [message] })),
});

describe("名乗りと検査", () => {
  it("Producer が出す payload をそのまま候補にする", () => {
    const record = recordOf();
    const observed = orderArrivalLinesFromTailEvents(
      [event([orderArrivalPayload(record)])],
      PRODUCER,
    );

    expect(observed.failures).toEqual([]);
    expect(observed.candidates).toEqual([{ line: printCanonicalOrderArrivalLine(record), record }]);
  });

  it("名乗らないオブジェクトを候補にも失敗にも含めない", () => {
    const observed = orderArrivalLinesFromTailEvents(
      [event([{ event: "cpsat.plan-decided" }, { recordType: "lift-delay" }])],
      PRODUCER,
    );

    expect(observed).toEqual({ candidates: [], failures: [] });
  });

  it("封筒が欠けていれば理由とともに失敗にする", () => {
    const observed = orderArrivalLinesFromTailEvents(
      [event([{ ...orderArrivalPayload(recordOf()), arrivalTimestampMs: 0 }])],
      PRODUCER,
    );

    expect(observed.candidates).toEqual([]);
    expect(observed.failures[0]).toMatchObject({ failure: "schema-invalid" });
    expect(observed.failures[0]?.issues?.[0]).toContain("arrivalTimestampMs");
  });
});

describe("素通しの範囲", () => {
  it("未知のフィールドが増えても通す", () => {
    // **ベンダーが項目を 1 つ増やしただけで記録が壊れないこと。** これが素通し原則の要点である。
    const record = recordOf({
      ...simplePayload,
      brand_new_field: { nested: [1, 2, 3] },
      order_items: [
        { plu_no: "11421", child_items: [{ plu_no: "10010", item_name: "かため" }], new_key: 1 },
      ],
    });
    const observed = orderArrivalLinesFromTailEvents(
      [event([orderArrivalPayload(record)])],
      PRODUCER,
    );

    expect(observed.failures).toEqual([]);
    expect(observed.candidates).toHaveLength(1);
    // 生ペイロードは解釈されず、そのまま残る。
    expect(JSON.parse(observed.candidates[0]?.record.rawPayload ?? "null")).toEqual(
      JSON.parse(record.rawPayload),
    );
    expect(observed.candidates[0]?.record.rawPayload).toContain("brand_new_field");
  });

  it("order_items が配列でなくても通す", () => {
    const observed = orderArrivalLinesFromTailEvents(
      [event([orderArrivalPayload(recordOf({ ...simplePayload, order_items: "unexpected" }))])],
      PRODUCER,
    );

    expect(observed.failures).toEqual([]);
    expect(observed.candidates).toHaveLength(1);
  });

  it("order_items が無くても通す", () => {
    const { order_items: _dropped, ...withoutItems } = simplePayload;
    const observed = orderArrivalLinesFromTailEvents(
      [event([orderArrivalPayload(recordOf(withoutItems))])],
      PRODUCER,
    );

    expect(observed.failures).toEqual([]);
    expect(observed.candidates).toHaveLength(1);
  });

  it("大きい payload でも検査では弾かない（上限は物理行の側が持つ）", () => {
    const observed = orderArrivalLinesFromTailEvents(
      [event([orderArrivalPayload(recordOf({ ...simplePayload, note: "x".repeat(100_000) }))])],
      PRODUCER,
    );

    expect(observed.failures).toEqual([]);
    expect(observed.candidates[0]?.record.payloadBytes).toBeGreaterThan(100_000);
  });
});

describe("rawPayload は妥当な JSON オブジェクトであること", () => {
  const withRawPayload = (rawPayload: unknown) => ({
    ...orderArrivalPayload(recordOf()),
    rawPayload,
  });

  it("壊れた JSON を弾く", () => {
    const observed = orderArrivalLinesFromTailEvents(
      [event([withRawPayload('{"store_id":"1102"')])],
      PRODUCER,
    );

    expect(observed.candidates).toEqual([]);
    expect(observed.failures[0]).toMatchObject({ failure: "schema-invalid" });
    expect(observed.failures[0]?.issues?.[0]).toContain("rawPayload");
  });

  it("途中で切れた JSON を弾く", () => {
    const full = recordOf().rawPayload;
    const observed = orderArrivalLinesFromTailEvents(
      [event([withRawPayload(full.slice(0, Math.floor(full.length / 2)))])],
      PRODUCER,
    );

    expect(observed.candidates).toEqual([]);
    expect(observed.failures[0]).toMatchObject({ failure: "schema-invalid" });
  });

  it.each([
    ["配列", "[1,2,3]"],
    ["数値", "42"],
    ["文字列", '"text"'],
    ["null", "null"],
    ["空文字", ""],
  ])("JSON オブジェクトでない %s を弾く", (_label, rawPayload) => {
    const observed = orderArrivalLinesFromTailEvents(
      [event([withRawPayload(rawPayload)])],
      PRODUCER,
    );

    expect(observed.candidates).toEqual([]);
    expect(observed.failures[0]).toMatchObject({ failure: "schema-invalid" });
  });

  it("空のオブジェクトは通す（中身を問わないため）", () => {
    const observed = orderArrivalLinesFromTailEvents([event([withRawPayload("{}")])], PRODUCER);

    expect(observed.failures).toEqual([]);
    expect(observed.candidates).toHaveLength(1);
  });

  it("鍵が増えても、値の型が変わっても通す", () => {
    // **構造は見ない。** ベンダーの変更で受信が止まらないことが素通しの理由である。
    const observed = orderArrivalLinesFromTailEvents(
      [
        event([
          withRawPayload('{"store_id":1102,"order_items":"文字列","brand_new":{"deep":[1,[2]]}}'),
        ]),
      ],
      PRODUCER,
    );

    expect(observed.failures).toEqual([]);
    expect(observed.candidates).toHaveLength(1);
  });
});

describe("到着の同定", () => {
  it("同じ注文の後着を別の到着として数える", () => {
    // 上流は同じ一意キーの新しい Record で未着手品目を置き換える。連番を混ぜずに畳めば
    // 「置き換えが起きた」事実が消える。
    const first = recordOf();
    const second = orderArrivalRecordOf("yamaokaya-1102", "1102:1:7:2026-09-16T18%3A52%3A19", {
      ...arrivalRecord(simplePayload),
      sequenceNumber: "43",
    });

    expect(first.eventId).not.toBe(second.eventId);
    expect(first.externalOrderId).toBe(second.externalOrderId);
  });

  it("上流の到着時刻をそのまま持つ（受信時刻を混ぜない）", () => {
    expect(recordOf().arrivalTimestampMs).toBe(ARRIVED_AT);
  });
});
