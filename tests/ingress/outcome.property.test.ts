// tests/ingress/outcome.property.test.ts — 1 Record の分類（src/ingress/outcome.ts）の property test。
//
// Property 1: 解釈は全域である。
//   分類も解釈の一部であり、どの生値も 5 種のいずれかへ落ちて例外を投げない。ここでは 4 つの面から
//   押さえる——(a) 任意の `path` が既知 2 値のいずれかか未知のちょうど 1 つに落ちること、
//   (b) `RecordOutcome` の 5 種を網羅する総関数が全ての値を捌けること（種別を足せば型で破れる）、
//   (c) `toRecordOutcome` が任意の生値に対し例外を投げず 5 種のいずれかを返すこと、
//   (d) 返った種別と入力の関係（構造の破れ・値域窓・`path`・Unique_Key の 4 段）が意図どおりであること。
// Property 2: 素通しは payload に閉じる。
//   `toRecordOutcome` の層でも、`payload` へ何を混ぜても分類が変わらない。拒否されるのは 4 構造か
//   Unique_Key の 4 要素が欠けたときだけである。
//
// (d) の期待値は**構成から定める**（生値を作った側が種別を知っている形にする）。実装の関門を呼び直して
// 期待値を導けば同値の検証ではなく同一の言い換えになり、何も検証しない。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ArrivalRecord } from "../../src/ingress/batch";
import { ARRIVAL_WINDOW_MS } from "../../src/ingress/arrival-window";
import {
  KNOWN_RECORD_PATHS,
  toRecordOutcome,
  type PoisonReason,
  type RecordOutcome,
} from "../../src/ingress/outcome";
import { toUniqueKey } from "../../src/ingress/unique-key";

/** 4 つの構造を通った Record（分類の `order` が運ぶ形）。 */
const genArrivalRecord: fc.Arbitrary<ArrivalRecord> = fc.record({
  path: fc.constantFrom("/lio/order", "/lio/status"),
  payload: fc.dictionary(fc.string(), fc.anything()),
  arrivalTimestampMs: fc.integer({ min: 0, max: 4_000_000_000_000 }),
  sequenceNumber: fc.string({ minLength: 1, maxLength: 56 }),
});

/** seq を取り出せない Record が実在するため optional。exactOptionalPropertyTypes ゆえ省略で表す。 */
const genMaybeSequenceNumber = fc.option(fc.string({ minLength: 1, maxLength: 56 }), {
  nil: undefined,
});

const genPoisonReason: fc.Arbitrary<PoisonReason> = fc.constantFrom(
  "path-missing",
  "payload-missing",
  "sequence-number-missing",
  "unique-key-incomplete",
);

const genOutcome: fc.Arbitrary<RecordOutcome> = fc.oneof(
  fc.record({
    kind: fc.constant("order" as const),
    record: genArrivalRecord,
    uniqueKey: fc.string(),
  }),
  genMaybeSequenceNumber.map((seq) => attachSequenceNumber({ kind: "status" as const }, seq)),
  genMaybeSequenceNumber.map((seq) => attachSequenceNumber({ kind: "unknown-path" as const }, seq)),
  fc
    .tuple(genPoisonReason, genMaybeSequenceNumber)
    .map(([reason, seq]) => attachSequenceNumber({ kind: "poison" as const, reason }, seq)),
  fc
    .tuple(fc.anything(), genMaybeSequenceNumber)
    .map(([raw, seq]) => attachSequenceNumber({ kind: "contract-violation" as const, raw }, seq)),
);

describe("ingress/outcome — 分類の判別基準", () => {
  // Feature: pos-order-ingress, Property 1: 解釈は全域である
  // **Validates: Requirements 7.1, 7.6**
  it("Property 1: 任意の path が既知 2 値のいずれかか未知のちょうど 1 つへ落ち、例外を投げない", () => {
    fc.assert(
      fc.property(fc.string(), (path) => {
        const kind = KNOWN_RECORD_PATHS.get(path);
        // 引けたことが既知であることであり、引いた値がそのまま分岐である（判別基準が 1 つ）。
        expect(KNOWN_RECORD_PATHS.has(path)).toBe(kind !== undefined);
        if (kind !== undefined) expect(["order", "status"]).toContain(kind);
      }),
      { numRuns: 500 },
    );
  });

  // Feature: pos-order-ingress, Property 1: 解釈は全域である
  // **Validates: Requirements 7.1, 7.6**
  it("Property 1: 既知 2 値の外にある path はすべて未知として同一に扱われる", () => {
    fc.assert(
      fc.property(
        fc.string().filter((path) => path !== "/lio/order" && path !== "/lio/status"),
        (path) => {
          expect(KNOWN_RECORD_PATHS.get(path)).toBeUndefined();
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("ingress/outcome — RecordOutcome の網羅性", () => {
  // Feature: pos-order-ingress, Property 1: 解釈は全域である
  // **Validates: Requirements 9.3, 8.15**
  it("Property 1: 5 種を網羅する総関数が全ての分類を捌き、例外を投げない", () => {
    fc.assert(
      fc.property(genOutcome, (outcome) => {
        const label = outcomeLabel(outcome);
        expect(label.length).toBeGreaterThan(0);
        // 診断ログは seq と理由の 2 項目のみ（AC 9.3）。理由は毒の事由から一意に定まる。
        if (outcome.kind === "poison") expect(label).toBe(`poison:${outcome.reason}`);
        // 隔離は検証前の生値を運ぶ（型違反の Record は ArrivalRecord を構築できない・AC 8.15）。
        if (outcome.kind === "contract-violation") expect("raw" in outcome).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

/**
 * 5 種を網羅する総関数。`default` の `never` 代入が網羅性の錠であり、種別を足せばここが型で破れる
 * （分類が全域であることを型で確かめる唯一の場所）。
 */
function outcomeLabel(outcome: RecordOutcome): string {
  switch (outcome.kind) {
    case "order":
      return `order:${outcome.uniqueKey}`;
    case "status":
      return "status";
    case "unknown-path":
      return "unknown-path";
    case "poison":
      return `poison:${outcome.reason}`;
    case "contract-violation":
      return "contract-violation";
    default: {
      const unreachable: never = outcome;
      throw new Error(`分類されていない RecordOutcome: ${String(unreachable)}`);
    }
  }
}

/** exactOptionalPropertyTypes ゆえ `undefined` を代入せずフィールドを省く形で組む。 */
function attachSequenceNumber<T extends object>(base: T, sequenceNumber: string | undefined): T {
  return sequenceNumber === undefined ? base : { ...base, sequenceNumber };
}

// ---------------------------------------------------------------------------
// toRecordOutcome — 生値 1 件を分類する関門の全域性（Property 1）と、素通しの範囲（Property 2）。
// ---------------------------------------------------------------------------

/** 受理時刻。実運用の桁（2025 年台のエポックミリ秒）を用いる。 */
const NOW = 1_755_460_339_000;

/** Unique_Key を成す 4 要素。分類の最後の段（`order` か `unique-key-incomplete` か）を分ける。 */
const UNIQUE_KEY_FIELDS = ["store_id", "terminal_id", "bill_no", "datetime"] as const;

const isExtraKey = (key: string): boolean =>
  !(UNIQUE_KEY_FIELDS as readonly string[]).includes(key);

/** 分類の期待値を添えた生値。**構成から期待値が定まる形で作る**（実装を呼び直して導かない）。 */
interface OutcomeScene {
  readonly raw: unknown;
  readonly kind: RecordOutcome["kind"];
  readonly reason?: PoisonReason;
}

/** 生値の 1 フィールドを壊す操作。omit と replace の 2 通りに閉じる（欠落と型違いの両方を踏む）。 */
type Breaker = (base: Record<string, unknown>) => Record<string, unknown>;

const omit =
  (field: string): Breaker =>
  (base) => {
    const broken = { ...base };
    delete broken[field];
    return broken;
  };

const replace =
  (field: string, value: unknown): Breaker =>
  (base) => ({ ...base, [field]: value });

/** 読み出せる要素の値（実データでは 3 要素が数値・`datetime` が文字列で届く）。 */
const genUniqueKeyElement: fc.Arbitrary<unknown> = fc.oneof(
  fc.integer({ min: 0, max: 10_000_000 }),
  fc.string({ minLength: 1, maxLength: 12 }),
  fc.constantFrom("a/b", "!*'()", "2026-08-17T20:52:19", "麺"),
);

/** payload の余剰フィールド。4 要素を潰さない位置に置く（素通しの土台）。 */
const genExtraFields: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  fc.string({ maxLength: 6 }).filter(isExtraKey),
  fc.anything(),
  { maxKeys: 3 },
);

/** 4 要素が揃った payload。余剰の上に 4 要素を載せる（4 要素が余剰に潰されない）。 */
function completePayload(
  [storeId, terminalId, billNo, datetime]: readonly [unknown, unknown, unknown, unknown],
  extras: Record<string, unknown>,
): Record<string, unknown> {
  return { ...extras, store_id: storeId, terminal_id: terminalId, bill_no: billNo, datetime };
}

const genCompletePayload: fc.Arbitrary<Record<string, unknown>> = fc
  .tuple(
    fc.tuple(genUniqueKeyElement, genUniqueKeyElement, genUniqueKeyElement, genUniqueKeyElement),
    genExtraFields,
  )
  .map(([elements, extras]) => completePayload(elements, extras));

/** 4 要素のいずれかを読み出せなくする（`declared-text.ts` が読めない値へ倒す）。 */
const genUniqueKeyBreaker: fc.Arbitrary<Breaker> = fc
  .constantFrom(...UNIQUE_KEY_FIELDS)
  .chain((field) =>
    fc.constantFrom<Breaker>(
      omit(field),
      replace(field, null),
      replace(field, ""),
      replace(field, true),
      replace(field, {}),
      replace(field, [7]),
      replace(field, Number.NaN),
    ),
  );

const genInWindow = fc.integer({ min: NOW - ARRIVAL_WINDOW_MS, max: NOW });
/** 窓の外（下限より古い・受理時刻より未来の両側）。型としては通り、値域で落ちる。 */
const genOutOfWindow = fc.oneof(
  fc.integer({ min: 0, max: NOW - ARRIVAL_WINDOW_MS - 1 }),
  fc.integer({ min: NOW + 1, max: NOW + 86_400_000 }),
);

const genSequenceNumber = fc.string({ minLength: 1, maxLength: 56 });

const genKnownPath = fc.constantFrom("/lio/order", "/lio/status");
const genUnknownPath = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((path) => !KNOWN_RECORD_PATHS.has(path));
const genAnyPath = fc.oneof(genKnownPath, genUnknownPath);

/** 4 構造を満たす生値（ワイヤのキー名は上流の snake_case）。 */
function wellFormed(
  path: string,
  payload: Record<string, unknown>,
  arrivalTimestampMs: number,
  sequenceNumber: string,
): Record<string, unknown> {
  return {
    path,
    payload,
    arrival_timestamp_ms: arrivalTimestampMs,
    sequence_number: sequenceNumber,
  };
}

/** Order_Path・窓内・4 要素揃い → `order`。 */
const genOrderScene: fc.Arbitrary<OutcomeScene> = fc
  .tuple(genCompletePayload, genInWindow, genSequenceNumber)
  .map(([payload, arrival, seq]) => ({
    raw: wellFormed("/lio/order", payload, arrival, seq),
    kind: "order" as const,
  }));

/** Order_Path・窓内・4 要素のいずれかが読めない → `unique-key-incomplete` の毒。 */
const genUniqueKeyIncompleteScene: fc.Arbitrary<OutcomeScene> = fc
  .tuple(genCompletePayload, genUniqueKeyBreaker, genInWindow, genSequenceNumber)
  .map(([payload, breaker, arrival, seq]) => ({
    raw: wellFormed("/lio/order", breaker(payload), arrival, seq),
    kind: "poison" as const,
    reason: "unique-key-incomplete" as const,
  }));

/**
 * Status_Path・窓内 → `status`。**payload に 4 要素を要求しない**——破棄先へ落ちる Record に識別子は
 * 要らず、先に導けば破棄されるだけの Record が毒として数えられる（AC 7.9 の分離）。
 */
const genStatusScene: fc.Arbitrary<OutcomeScene> = fc
  .tuple(fc.oneof(genCompletePayload, genExtraFields), genInWindow, genSequenceNumber)
  .map(([payload, arrival, seq]) => ({
    raw: wellFormed("/lio/status", payload, arrival, seq),
    kind: "status" as const,
  }));

/** 既知 2 値の外の `path`・窓内 → `unknown-path`（Unique_Key の可否に依らない）。 */
const genUnknownPathScene: fc.Arbitrary<OutcomeScene> = fc
  .tuple(
    genUnknownPath,
    fc.oneof(genCompletePayload, genExtraFields),
    genInWindow,
    genSequenceNumber,
  )
  .map(([path, payload, arrival, seq]) => ({
    raw: wellFormed(path, payload, arrival, seq),
    kind: "unknown-path" as const,
  }));

/**
 * 4 構造は満たすが到着時刻が窓の外 → `contract-violation`。**`path` の既知・未知に依らない**——窓の
 * 検査が `path` の分岐より前に立つ（起点を推測で埋めないことが `path` の解釈より先に決まる）。
 */
const genOutOfWindowScene: fc.Arbitrary<OutcomeScene> = fc
  .tuple(genAnyPath, genCompletePayload, genOutOfWindow, genSequenceNumber)
  .map(([path, payload, arrival, seq]) => ({
    raw: wellFormed(path, payload, arrival, seq),
    kind: "contract-violation" as const,
  }));

/** 構造が破れた生値。破れ方によって結末が違う（毒 3 種と隔離 1 種）。 */
const genBrokenStructureScene: fc.Arbitrary<OutcomeScene> = fc
  .tuple(genAnyPath, genCompletePayload, genInWindow, genSequenceNumber)
  .chain(([path, payload, arrival, seq]) => {
    const base = wellFormed(path, payload, arrival, seq);
    return fc.oneof(
      fc
        .constantFrom<Breaker>(
          omit("path"),
          replace("path", ""),
          replace("path", 1),
          replace("path", null),
        )
        .map((breaker) => ({
          raw: breaker(base),
          kind: "poison" as const,
          reason: "path-missing" as const,
        })),
      fc
        .constantFrom<Breaker>(
          omit("payload"),
          replace("payload", []),
          replace("payload", null),
          replace("payload", "x"),
        )
        .map((breaker) => ({
          raw: breaker(base),
          kind: "poison" as const,
          reason: "payload-missing" as const,
        })),
      // 上流の契約違反（Upstream_Contract は型を保証する）。毒にすれば上流のバグでデータが静かに消える。
      fc
        .constantFrom<Breaker>(
          omit("arrival_timestamp_ms"),
          replace("arrival_timestamp_ms", -1),
          replace("arrival_timestamp_ms", 1.5),
          replace("arrival_timestamp_ms", Number.NaN),
          replace("arrival_timestamp_ms", "0"),
        )
        .map((breaker) => ({ raw: breaker(base), kind: "contract-violation" as const })),
      fc
        .constantFrom<Breaker>(
          omit("sequence_number"),
          replace("sequence_number", ""),
          replace("sequence_number", 1),
          replace("sequence_number", null),
        )
        .map((breaker) => ({
          raw: breaker(base),
          kind: "poison" as const,
          reason: "sequence-number-missing" as const,
        })),
    );
  });

/** Record の形をなさない生値。`path` を読み出す先が無いため `path-missing` の毒へ落ちる。 */
const genNotARecordScene: fc.Arbitrary<OutcomeScene> = fc
  .oneof(
    fc.integer(),
    fc.string(),
    fc.boolean(),
    fc.constant(null),
    fc.constant(undefined),
    fc.array(fc.anything(), { maxLength: 3 }),
  )
  .map((raw) => ({ raw, kind: "poison" as const, reason: "path-missing" as const }));

const genScene: fc.Arbitrary<OutcomeScene> = fc.oneof(
  genOrderScene,
  genUniqueKeyIncompleteScene,
  genStatusScene,
  genUnknownPathScene,
  genOutOfWindowScene,
  genBrokenStructureScene,
  genNotARecordScene,
);

const OUTCOME_KINDS: readonly RecordOutcome["kind"][] = [
  "order",
  "status",
  "unknown-path",
  "poison",
  "contract-violation",
];

describe("ingress/outcome — toRecordOutcome の全域性", () => {
  // Feature: pos-order-ingress, Property 1: 解釈は全域である
  // **Validates: Requirements 1.11, 14.1**
  it("Property 1: 任意の生値と任意の now に対し 5 種のいずれかを返し、例外を投げない", () => {
    fc.assert(
      fc.property(fc.anything(), fc.integer({ min: 0, max: 4_000_000_000_000 }), (raw, now) => {
        // 上流が何を送っても受け口が落ちない（Worker はこの結果に対する分岐しか持たない・AC 1.8）。
        expect(OUTCOME_KINDS).toContain(toRecordOutcome(raw, now).kind);
      }),
      { numRuns: 1000 },
    );
  });

  // Feature: pos-order-ingress, Property 1: 解釈は全域である
  // **Validates: Requirements 7.1, 7.3, 7.6, 8.15, 9.3**
  it("Property 1: 構成した生値が意図した種別へ落ちる（構造・窓・path・Unique_Key の 4 段）", () => {
    fc.assert(
      fc.property(genScene, ({ raw, kind, reason }) => {
        const outcome = toRecordOutcome(raw, NOW);
        expect(outcome.kind).toBe(kind);
        if (outcome.kind === "poison") expect(outcome.reason).toBe(reason);
      }),
      { numRuns: 1000 },
    );
  });

  // Feature: pos-order-ingress, Property 1: 解釈は全域である
  // **Validates: Requirements 7.2, 6.1, 14.5**
  it("Property 1: order が現れるのは 4 構造・窓・Order_Path・Unique_Key の全てが揃ったときだけ", () => {
    fc.assert(
      fc.property(genScene, ({ raw }) => {
        const outcome = toRecordOutcome(raw, NOW);
        if (outcome.kind !== "order") return;
        const source = raw as Record<string, unknown>;
        expect(outcome.record.path).toBe("/lio/order");
        // payload は参照のまま運ばれる（写像の前に正規化も検証もしない・AC 14.5）。
        expect(outcome.record.payload).toBe(source.payload);
        expect(outcome.record.arrivalTimestampMs).toBe(source.arrival_timestamp_ms);
        expect(outcome.record.sequenceNumber).toBe(source.sequence_number);
        // 窓の内であることが order の前提である（窓外は隔離へ落ちる）。
        expect(outcome.record.arrivalTimestampMs).toBeLessThanOrEqual(NOW);
        expect(outcome.record.arrivalTimestampMs).toBeGreaterThanOrEqual(NOW - ARRIVAL_WINDOW_MS);
        // 識別子の出所は toUniqueKey ただ一つである（分類の側で導き直していない）。
        expect(outcome.uniqueKey).toBe(toUniqueKey(outcome.record.payload));
      }),
      { numRuns: 1000 },
    );
  });

  // Feature: pos-order-ingress, Property 1: 解釈は全域である
  // **Validates: Requirements 9.3**
  it("Property 1: 診断ログの seq は構造が破れた生値からも拾え、拾えなければ載らない", () => {
    fc.assert(
      fc.property(genScene, ({ raw }) => {
        const outcome = toRecordOutcome(raw, NOW);
        // order は検証済みの record が seq を運ぶ（optional の側は残る 4 種の関心事）。
        if (outcome.kind === "order") return;
        const declared = declaredSequenceNumber(raw);
        if (declared === null) {
          // exactOptionalPropertyTypes ゆえ「値が無い」はフィールドの不在で表す。
          expect("sequenceNumber" in outcome).toBe(false);
        } else {
          expect(outcome.sequenceNumber).toBe(declared);
        }
      }),
      { numRuns: 1000 },
    );
  });

  // Feature: pos-order-ingress, Property 1: 解釈は全域である
  // **Validates: Requirements 1.11**
  it("Property 1: 同一の生値と now から常に同一の分類を得る（決定的）", () => {
    fc.assert(
      fc.property(genScene, ({ raw }) => {
        expect(toRecordOutcome(raw, NOW)).toEqual(toRecordOutcome(raw, NOW));
      }),
      { numRuns: 500 },
    );
  });
});

describe("ingress/outcome — 素通しは payload に閉じる", () => {
  // Feature: pos-order-ingress, Property 2: 素通しは payload に閉じる
  // **Validates: Requirements 14.2, 14.3, 14.4, 14.6**
  it("Property 2: payload へ未知フィールド・型違い・想定外の値を混ぜても分類が変わらない", () => {
    fc.assert(
      fc.property(
        genScene,
        fc.string({ maxLength: 8 }).filter(isExtraKey),
        fc.anything(),
        ({ raw }, key, value) => {
          const mixed = mixIntoPayload(raw, key, value);
          if (mixed === null) return;
          const before = toRecordOutcome(raw, NOW);
          const after = toRecordOutcome(mixed, NOW);
          expect(after.kind).toBe(before.kind);
          if (before.kind === "poison" && after.kind === "poison")
            expect(after.reason).toBe(before.reason);
          if (before.kind === "order" && after.kind === "order")
            expect(after.uniqueKey).toBe(before.uniqueKey);
        },
      ),
      { numRuns: 1000 },
    );
  });

  // Feature: pos-order-ingress, Property 2: 素通しは payload に閉じる
  // **Validates: Requirements 14.2, 14.3, 14.4, 14.10, 14.11**
  it("Property 2: 4 構造と Unique_Key 4 要素が揃っていれば、payload に何を混ぜても拒否されない", () => {
    fc.assert(
      fc.property(
        genCompletePayload,
        genInWindow,
        genSequenceNumber,
        fc.string({ maxLength: 8 }).filter(isExtraKey),
        fc.anything(),
        (payload, arrival, seq, key, value) => {
          const raw = wellFormed("/lio/order", { ...payload, [key]: value }, arrival, seq);
          // 拒否（毒・隔離）が起こる余地は 4 構造と 4 要素の外に存在しない。
          expect(toRecordOutcome(raw, NOW).kind).toBe("order");
        },
      ),
      { numRuns: 1000 },
    );
  });
});

/** 生値の `payload` へ 1 つ混ぜる。payload がオブジェクトでない生値は混ぜる先が無い（`null` を返す）。 */
function mixIntoPayload(raw: unknown, key: string, value: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const payload = source.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  return { ...source, payload: { ...(payload as Record<string, unknown>), [key]: value } };
}

/**
 * 診断ログに載る seq の期待値。読めるのは非空文字列だけである——数値を文字列へ写せば
 * `sequence-number-missing` の毒とログに載る seq が食い違う。
 */
function declaredSequenceNumber(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const sequenceNumber = (raw as Record<string, unknown>).sequence_number;
  return typeof sequenceNumber === "string" && sequenceNumber.length > 0 ? sequenceNumber : null;
}
