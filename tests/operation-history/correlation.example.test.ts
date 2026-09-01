import { describe, expect, it } from "vitest";
// `?raw` の default は vite/client の `declare module '*?raw'` が与えるため tsc は通る。oxlint の resolver はその宣言を
// 読まず `?raw` を落として実ファイルへ解決するので、実在する .ts を指すときだけ default 無しと誤判定する。
// oxlint-disable-next-line import/default
import correlationSource from "../../src/operation-history/correlation.ts?raw";
import {
  correlationCandidatesFromOperationEvidence,
  operationArrivalQualityFromEvidence,
} from "../../src/operation-history/correlation";
import type { OperationRecord } from "../../src/operation-history/record";

const timestamp = (value: number): OperationRecord["eventTime"] =>
  value as OperationRecord["eventTime"];
const common = {
  storeId: "store-1",
  timerId: "timer-1",
  eventTime: timestamp(1_700_000_000_000),
  slotIds: ["slot-1", "slot-2"],
  noodleType: "Thin",
  firmness: "normal",
} as const;

const completed = { ...common, operationKind: "completed" } satisfies OperationRecord;
const cancelled = { ...common, operationKind: "cancelled" } satisfies OperationRecord;
const boilStarted = {
  ...common,
  operationKind: "boil-started",
  startTime: timestamp(1_699_999_940_000),
  endTime: timestamp(1_700_000_000_000),
} satisfies OperationRecord;
const boiled = {
  ...common,
  operationKind: "boiled",
  endTime: timestamp(1_700_000_000_000),
  boiledAt: timestamp(1_700_000_000_001),
} satisfies OperationRecord;
const adjusted = {
  ...common,
  operationKind: "adjusted",
  endTime: timestamp(1_700_000_010_000),
} satisfies OperationRecord;

describe("correlationCandidatesFromOperationEvidence", () => {
  it("4つの一次属性だけで入力順に候補を作る", () => {
    const laterCompleted = { ...completed, eventTime: timestamp(1_700_000_000_001) };
    const candidates = correlationCandidatesFromOperationEvidence([
      { record: completed },
      { record: cancelled },
      { record: { ...completed } },
      { record: laterCompleted },
    ]);

    expect(
      candidates.map(({ primary, records }) => ({ primary, arrivals: records.length })),
    ).toEqual([
      {
        primary: {
          storeId: "store-1",
          timerId: "timer-1",
          operationKind: "completed",
          eventTime: common.eventTime,
        },
        arrivals: 2,
      },
      {
        primary: {
          storeId: "store-1",
          timerId: "timer-1",
          operationKind: "cancelled",
          eventTime: common.eventTime,
        },
        arrivals: 1,
      },
      {
        primary: {
          storeId: "store-1",
          timerId: "timer-1",
          operationKind: "completed",
          eventTime: laterCompleted.eventTime,
        },
        arrivals: 1,
      },
    ]);
  });

  it.each([
    ["slotIds", completed, { ...completed, slotIds: ["slot-2", "slot-1"] }],
    ["noodleType", completed, { ...completed, noodleType: "Thick" }],
    ["firmness", completed, { ...completed, firmness: "hard" }],
    ["startTime", boilStarted, { ...boilStarted, startTime: timestamp(boilStarted.startTime + 1) }],
    [
      "boil-started endTime",
      boilStarted,
      { ...boilStarted, endTime: timestamp(boilStarted.endTime + 1) },
    ],
    ["boiled endTime", boiled, { ...boiled, endTime: timestamp(boiled.endTime + 1) }],
    ["boiledAt", boiled, { ...boiled, boiledAt: timestamp(boiled.boiledAt + 1) }],
    ["adjusted endTime", adjusted, { ...adjusted, endTime: timestamp(adjusted.endTime + 1) }],
  ] satisfies readonly (readonly [string, OperationRecord, OperationRecord])[])(
    "%s の不一致を Timer 事実の競合として残す",
    (_name, left, right) => {
      const [candidate] = correlationCandidatesFromOperationEvidence([
        { record: left },
        { record: right },
      ]);

      expect(candidate).toMatchObject({ timerFactsConsistent: false });
      expect(candidate?.records).toEqual([left, right]);
    },
  );

  it("一致する Timer 事実を kind ごとに整合済みと判定する", () => {
    const candidates = correlationCandidatesFromOperationEvidence(
      [boilStarted, boiled, adjusted, completed, cancelled].flatMap((record) => [
        { record },
        { record: { ...record } as OperationRecord },
      ]),
    );

    expect(candidates).toHaveLength(5);
    expect(candidates.every(({ timerFactsConsistent }) => timerFactsConsistent)).toBe(true);
  });

  it("hash と trace metadata を一次候補や record identity にせず、不整合時だけ補助根拠にする", () => {
    const firstTrace = { scriptName: "producer", outcome: "ok", traceId: "trace-1" };
    const secondTrace = { scriptName: "producer", outcome: "ok", traceId: "trace-2" };
    const consistent = correlationCandidatesFromOperationEvidence([
      { record: completed, canonicalHash: "hash-1", traceMetadata: firstTrace },
      { record: { ...completed }, canonicalHash: "hash-2", traceMetadata: secondTrace },
    ]);

    expect(consistent).toHaveLength(1);
    expect(consistent[0]).toEqual({
      primary: {
        storeId: completed.storeId,
        timerId: completed.timerId,
        operationKind: completed.operationKind,
        eventTime: completed.eventTime,
      },
      records: [completed, { ...completed }],
      timerFactsConsistent: true,
    });

    const conflicting = correlationCandidatesFromOperationEvidence([
      { record: completed, canonicalHash: "hash-1", traceMetadata: firstTrace },
      {
        record: { ...completed, firmness: "hard" },
        canonicalHash: "hash-2",
        traceMetadata: secondTrace,
      },
    ]);

    expect(conflicting).toHaveLength(1);
    expect(conflicting[0]).toMatchObject({
      timerFactsConsistent: false,
      ambiguityEvidence: {
        canonicalHashes: ["hash-1", "hash-2"],
        traceMetadata: [firstTrace, secondTrace],
      },
    });
    expect(Object.keys(conflicting[0]!.primary)).toEqual([
      "storeId",
      "timerId",
      "operationKind",
      "eventTime",
    ]);
    expect(conflicting[0]!.primary).not.toHaveProperty("canonicalHash");
    expect(conflicting[0]!.primary).not.toHaveProperty("traceMetadata");
    expect(conflicting[0]!.primary).not.toHaveProperty("seq");
  });

  it("同じ補助 metadata でも異なる一次属性の record を統合しない", () => {
    const candidates = correlationCandidatesFromOperationEvidence([
      { record: completed, canonicalHash: "same-hash", traceMetadata: { traceId: "same-trace" } },
      { record: cancelled, canonicalHash: "same-hash", traceMetadata: { traceId: "same-trace" } },
    ]);

    expect(candidates).toHaveLength(2);
    expect(candidates.map(({ primary }) => primary.operationKind)).toEqual([
      "completed",
      "cancelled",
    ]);
  });

  it("Operation Record 以外のモデルや platform capability に依存しない純粋 module である", () => {
    const imports = [...correlationSource.matchAll(/^import(?: type)? .* from "([^"]+)";$/gm)].map(
      (match) => match[1],
    );

    expect(imports).toEqual(["./record"]);
    expect(correlationSource).not.toMatch(/\b(?:console|storage|ctx|env|Date)\s*\./);
    expect(correlationSource).not.toMatch(/\b(?:fetch|setAlarm|put|waitUntil)\s*\(/);
  });
});

describe("operationArrivalQualityFromEvidence", () => {
  it("同一 record の raw arrival 全件を保持して分析用一件と n-1 件へ収束する", () => {
    const arrivals = [
      { record: completed, canonicalHash: "hash-1" },
      { record: { ...completed } as OperationRecord, canonicalHash: "hash-2" },
      { record: { ...completed } as OperationRecord, traceMetadata: { traceId: "trace-3" } },
    ] as const;

    const result = operationArrivalQualityFromEvidence(
      arrivals,
      [completed],
      [{ storeId: completed.storeId, timerId: completed.timerId }],
    );

    expect(result.rawArrivals).toBe(arrivals);
    expect(result.convergedRecords).toHaveLength(1);
    expect(result.convergedRecords[0]).toMatchObject({
      analysisRecord: completed,
      arrivalCount: 3,
      duplicateCount: 2,
    });
    expect(result.convergedRecords[0]?.rawArrivals).toEqual(arrivals);
    expect(result.quality).toEqual({
      missing: [],
      orphan: [],
      conflict: [],
      duplicate: [arrivals],
    });
  });

  it("raw 重複の到達順列ごとに全件と順序を保持し、同じ n 件と n-1 件へ収束する", () => {
    const first = { record: completed, canonicalHash: "hash-1" } as const;
    const second = {
      record: { ...completed } as OperationRecord,
      traceMetadata: { traceId: "trace-2" },
    } as const;
    const third = { record: { ...completed } as OperationRecord, canonicalHash: "hash-3" } as const;
    const permutations = [
      [first, second, third],
      [first, third, second],
      [second, first, third],
      [second, third, first],
      [third, first, second],
      [third, second, first],
    ] as const;

    for (const arrivals of permutations) {
      const result = operationArrivalQualityFromEvidence(
        arrivals,
        [completed],
        [{ storeId: completed.storeId, timerId: completed.timerId }],
      );

      expect(result.rawArrivals).toBe(arrivals);
      expect(result.convergedRecords).toHaveLength(1);
      expect(result.convergedRecords[0]).toMatchObject({ arrivalCount: 3, duplicateCount: 2 });
      expect(result.convergedRecords[0]?.rawArrivals).toEqual(arrivals);
      expect(result.quality.duplicate).toEqual([arrivals]);
      expect(result.quality.missing).toEqual([]);
      expect(result.quality.orphan).toEqual([]);
      expect(result.quality.conflict).toEqual([]);
    }
  });

  it("同じ一次候補の重複と競合を独立状態にし、各既知事実を別々に収束する", () => {
    const duplicateArrival = { record: { ...completed } as OperationRecord };
    const conflictingArrival = {
      record: { ...completed, firmness: "hard" } as OperationRecord,
    };
    const arrivals = [{ record: completed }, duplicateArrival, conflictingArrival] as const;

    const result = operationArrivalQualityFromEvidence(arrivals, [completed]);

    expect(
      result.convergedRecords.map(({ arrivalCount, duplicateCount }) => ({
        arrivalCount,
        duplicateCount,
      })),
    ).toEqual([
      { arrivalCount: 2, duplicateCount: 1 },
      { arrivalCount: 1, duplicateCount: 0 },
    ]);
    expect(result.quality.conflict).toEqual([arrivals]);
    expect(result.quality.duplicate).toEqual([[arrivals[0], duplicateArrival]]);
    expect(result.quality.orphan).toEqual([[arrivals[0], duplicateArrival], [conflictingArrival]]);
  });

  it("欠落と孤児を別状態で保持し、判定の前後で根拠 arrival を変更しない", () => {
    const arrivals = [{ record: completed, traceMetadata: { traceId: "trace-1" } }] as const;
    const before = structuredClone(arrivals);

    const result = operationArrivalQualityFromEvidence(arrivals, [completed, boiled]);

    expect(result.quality.missing).toEqual([boiled]);
    expect(result.quality.orphan).toEqual([arrivals]);
    expect(result.quality.conflict).toEqual([]);
    expect(result.quality.duplicate).toEqual([]);
    expect(arrivals).toEqual(before);
    expect(result.rawArrivals[0]).toBe(arrivals[0]);
    expect(result.quality.orphan[0]?.[0]).toBe(arrivals[0]);
  });

  it("観測済み boil-started または復元可能な開始事実へ相関できる record は孤児にしない", () => {
    const observedStart = operationArrivalQualityFromEvidence(
      [{ record: boilStarted }, { record: completed }],
      [],
    );
    const recoveredStart = operationArrivalQualityFromEvidence(
      [{ record: completed }],
      [],
      [{ storeId: completed.storeId, timerId: completed.timerId }],
    );

    expect(observedStart.quality.orphan).toEqual([]);
    expect(recoveredStart.quality.orphan).toEqual([]);
  });
});
