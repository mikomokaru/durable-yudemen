import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimerFact } from "../../src/domain/timer";
import type { Effect } from "../../src/engine/effect";
import { toSnapshot, type StoreSnapshot } from "../../src/engine/snapshot";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { recordsFromCommittedDiff, type OperationObservation } from "../../src/operation-history/derive";
import type { OperationRecord } from "../../src/operation-history/record";
import { tryWriteOperationLines } from "../../src/operation-history/producer";
import { nonEmpty } from "../nonEmpty";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type AllKeys<T> = T extends unknown ? keyof T : never;
type VariantKeys<K extends Effect["type"]> = keyof Extract<Effect, { readonly type: K }>;
type ObservationOnlyKeys = "storeId" | "timerId" | "operationKind" | "eventTime" | "Record_Seq";
type SequenceKeys = "Record_Seq" | "seq" | "nextSeq";
type ModelShapeAssertions = [
  Assert<Equal<keyof TimerFact, "id" | "slotIds" | "noodleType" | "firmness" | "startTime" | "endTime">>,
  Assert<Equal<keyof Timer, keyof TimerFact | "seq" | "boiledAt" | "adjustment" | "orderItem">>,
  // 調理順スケジューリング（online-cook-scheduling タスク 5.1）が 3 フィールドを足した。この主張の眼目は
  // 「Operation History が Timer モデルへフィールドを足さないこと」であり、他 spec による正当な拡張は追随させる。
  // POS オーダー取り込み（pos-order-ingress タスク 10）が重複排除の判定材料を 1 つ足した。
  Assert<
    Equal<
      keyof TimerState,
      "timers" | "nextSeq" | "pendingOrders" | "acceptedSlices" | "requestedDigest" | "lastSequenceByTerminal"
    >
  >,
  // 永続スキーマ v7（online-cook-scheduling タスク 6.2）が同じ 3 フィールドを永続へ載せ、型名を
  // ActiveTimersSnapshot から StoreSnapshot へ改めた。ストレージキー "activeTimers" は据え置き。
  // v8（pos-order-ingress タスク 12）が判定材料を永続へ載せた——別キーにすれば注文と別の put になり、
  // 「判定材料だけ進んで注文が無い」欠落が生じるため、同じスナップショットに乗る。
  Assert<
    Equal<
      keyof StoreSnapshot,
      | "version"
      | "timers"
      | "nextSeq"
      | "pendingOrders"
      | "acceptedSlices"
      | "requestedDigest"
      | "lastSequenceByTerminal"
    >
  >,
  // 調理順スケジューリング（online-cook-scheduling タスク 12.2）が Effect 語彙へ RequestPlan を足した。
  // 上と同じ眼目——Operation History 自身が Effect を増やさないことを主張し、他 spec の正当な拡張は追随させる。
  // RequestPlan は列の末尾にのみ現れ、Persist 先頭の不変条件を動かさない。
  Assert<Equal<Effect["type"], "Persist" | "SetAlarm" | "ClearAlarm" | "Broadcast" | "RequestPlan">>,
  Assert<Equal<VariantKeys<"Persist">, "type" | "snapshot">>,
  Assert<Equal<VariantKeys<"SetAlarm">, "type" | "at">>,
  Assert<Equal<VariantKeys<"ClearAlarm">, "type">>,
  Assert<Equal<VariantKeys<"Broadcast">, "type" | "message">>,
  Assert<Equal<VariantKeys<"RequestPlan">, "type" | "pending" | "running" | "params" | "digest">>,
  Assert<Equal<Extract<Effect, { readonly type: "Persist" }>["snapshot"], StoreSnapshot>>,
  Assert<Equal<Extract<keyof TimerFact | keyof TimerState | keyof StoreSnapshot, ObservationOnlyKeys>, never>>,
  Assert<Equal<Extract<AllKeys<OperationRecord>, SequenceKeys>, never>>,
];
const modelShapeAssertions: ModelShapeAssertions = [
  true, true, true, true, true, true, true, true, true, true, true, true, true,
];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const operationHistorySourcePaths = ["record.ts", "derive.ts", "codec.ts", "producer.ts"] as const;
const operationHistorySources = operationHistorySourcePaths.map((path) => ({
  path,
  source: readFileSync(resolve(repoRoot, "src/operation-history", path), "utf8"),
}));
const deriveSource = operationHistorySources.find(({ path }) => path === "derive.ts")!.source;

function fixtureTimer(): Timer {
  return createTimer({
    id: "timer-1" as TimerId,
    slotIds: nonEmpty(["slot-1" as SlotId, "slot-2" as SlotId]),
    noodleType: "Thin" as NoodleType,
    firmness: "normal",
    startTime: 1_700_000_000_000 as EpochMillis,
    endTime: 1_700_000_060_000 as EpochMillis,
    seq: 41,
  });
}

function startObservation(): OperationObservation {
  const timer = fixtureTimer();
  return {
    storeId: "store-1",
    eventTime: 1_700_000_000_001,
    eventKind: "Start",
    before: { ...EMPTY_STATE, timers: [], nextSeq: 41 },
    after: { ...EMPTY_STATE, timers: [timer], nextSeq: 42 },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Operation History の Timer モデル規律", () => {
  it("Timer モデルと Effect の既存フィールド集合を変えない", () => {
    expect(modelShapeAssertions.every(Boolean)).toBe(true);
  });

  it("Persist payload は既存 StoreSnapshot だけを保持する", () => {
    const state: TimerState = { ...EMPTY_STATE, timers: [fixtureTimer()], nextSeq: 42 };
    const effect: Extract<Effect, { readonly type: "Persist" }> = { type: "Persist", snapshot: toSnapshot(state) };

    expect(effect).toMatchInlineSnapshot(`
      {
        "snapshot": {
          "acceptedSlices": [],
          "lastSequenceByTerminal": {},
          "nextSeq": 42,
          "pendingOrders": [],
          "requestedDigest": null,
          "timers": [
            {
              "adjustment": 0,
              "boiledAt": null,
              "endTime": 1700000060000,
              "firmness": "normal",
              "id": "timer-1",
              "noodleType": "Thin",
              "orderItem": null,
              "seq": 41,
              "slotIds": [
                "slot-1",
                "slot-2",
              ],
              "startTime": 1700000000000,
            },
          ],
          "version": 8,
        },
        "type": "Persist",
      }
    `);
  });

  it("Operation Record と実際の console 行へ採番属性を出さない", () => {
    const observation = startObservation();
    const records = recordsFromCommittedDiff(observation);
    const calls: unknown[][] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { calls.push(args); });

    tryWriteOperationLines(true, observation);

    expect(records).toHaveLength(1);
    expect(records[0]).not.toHaveProperty("Record_Seq");
    expect(records[0]).not.toHaveProperty("seq");
    expect(records[0]).not.toHaveProperty("nextSeq");
    expect(calls).toMatchInlineSnapshot(`
      [
        [
          "{"storeId":"store-1","timerId":"timer-1","operationKind":"boil-started","eventTime":1700000000001,"slotIds":["slot-1","slot-2"],"noodleType":"Thin","firmness":"normal","startTime":1700000000000,"endTime":1700000060000}",
        ],
      ]
    `);
    const line = calls[0]?.[0];
    expect(typeof line).toBe("string");
    expect(JSON.parse(line as string)).not.toEqual(expect.objectContaining({ Record_Seq: expect.anything() }));
    expect(JSON.parse(line as string)).not.toEqual(expect.objectContaining({ seq: expect.anything() }));
    expect(JSON.parse(line as string)).not.toEqual(expect.objectContaining({ nextSeq: expect.anything() }));
  });

  it("Operation History の record／console 経路は採番フィールドを参照しない", () => {
    for (const { source } of operationHistorySources) {
      expect(source).not.toMatch(/\b(?:Record_Seq|seq|nextSeq)\b/);
    }
  });

  it("Timer 事実は toWireTimer だけで射影し、実効 endTime を再計算しない", () => {
    expect(deriveSource).toMatch(/import\s+\{\s*toWireTimer\s*\}\s+from\s+["']\.\.\/engine\/project["']/);
    expect(deriveSource.match(/\btoWireTimer\s*\(/g)).toHaveLength(1);
    expect(deriveSource).not.toMatch(/\.adjustment\b|\badjustedEndTime\b|\.endTime\s*[+-]|[+-]\s*[^;\n]*\.endTime/);
  });

  it("engine Timer から直接読む観測差分値を boiledAt に限定する", () => {
    const fields = [...deriveSource.matchAll(/(?:\bengineTimer|\bprevious\.engineTimer)\.([A-Za-z_$][\w$]*)/g)];
    expect(new Set(fields.map((match) => match[1]))).toEqual(new Set(["boiledAt"]));
  });
});