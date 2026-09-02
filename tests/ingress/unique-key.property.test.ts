// tests/ingress/unique-key.property.test.ts — Unique_Key の導出（src/ingress/unique-key.ts）の property test。
//
// Property 3: Unique_Key は決定的で上流と一致する。
//   同一 payload から常に同一の値を返し、4 要素のいずれかが欠ければ null を返す。導いた値は上流の
//   エンコード規則が許す文字だけで構成され、区切りの `:` はちょうど 3 つ現れる（要素内の `:` は
//   `%3A` へ写るため、区切りと要素内容が混ざらない）。
//   上流のエンコード規則そのものとの一致は example test（unique-key.example.test.ts）が点で固定する。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { toUniqueKey } from "../../src/ingress/unique-key";

const UNIQUE_KEY_FIELDS = ["store_id", "terminal_id", "bill_no", "datetime"] as const;

/** Unique_Key の 4 要素に当たらないキーか（余剰フィールドの生成に用いる）。 */
const isExtraKey = (key: string): boolean =>
  !(UNIQUE_KEY_FIELDS as readonly string[]).includes(key);

/**
 * 読み出せる要素の値（非空文字列と有限の数値）。実データでは 3 要素が数値・`datetime` が文字列で届くが、
 * 要素ごとに規則を変えないため両方をどの要素にも生成する。真偽値・オブジェクト・配列は読み出せない側
 * （毒）ゆえ、ここには含めず後段の breaker で扱う。
 */
const genElement: fc.Arbitrary<unknown> = fc.oneof(
  fc.integer({ min: 0, max: 10_000_000 }),
  fc.string({ minLength: 1, maxLength: 20 }),
  // 上流との差が出る記号・多バイト・区切り文字を意図的に含める。
  fc.constantFrom("a/b", "!*'()", "~-_.", "2026-08-17T20:52:19", "麺", " ", "a:b", "%2F"),
);

/** payload の余剰フィールド。Unique_Key に影響しないことの土台になる。 */
const genExtras: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  fc.string({ maxLength: 8 }).filter(isExtraKey),
  fc.anything(),
  { maxKeys: 4 },
);

/** 4 要素が揃った payload。余剰フィールドの上に 4 要素を載せる（4 要素が余剰に潰されない）。 */
function completePayload(
  [storeId, terminalId, billNo, datetime]: readonly [unknown, unknown, unknown, unknown],
  extras: Record<string, unknown>,
): Record<string, unknown> {
  return { ...extras, store_id: storeId, terminal_id: terminalId, bill_no: billNo, datetime };
}

const genCompletePayload: fc.Arbitrary<Record<string, unknown>> = fc
  .tuple(fc.tuple(genElement, genElement, genElement, genElement), genExtras)
  .map(([elements, extras]) => completePayload(elements, extras));

/** 上流の規則が許す文字（無予約文字・`/`・`%XX` の `%`・区切りの `:`）だけで構成される。 */
const ALLOWED_CHARS = /^[A-Za-z0-9\-./_~%:]+$/;

describe("ingress/unique-key — toUniqueKey", () => {
  // Feature: pos-order-ingress, Property 3: Unique_Key は決定的で上流と一致する
  // **Validates: Requirements 6.1, 6.2**
  it("Property 3: 同一 payload から常に同一の値を返す（キーの並び順にも依らない）", () => {
    fc.assert(
      fc.property(genCompletePayload, (payload) => {
        const first = toUniqueKey(payload);
        expect(toUniqueKey(payload)).toBe(first);
        // 挿入順を変えた同内容の payload でも同一（並びは payload の事実ではない）。
        const reordered = Object.fromEntries([...Object.entries(payload)].reverse());
        expect(toUniqueKey(reordered)).toBe(first);
      }),
      { numRuns: 300 },
    );
  });

  // Feature: pos-order-ingress, Property 3: Unique_Key は決定的で上流と一致する
  // **Validates: Requirements 6.1, 6.2**
  it("Property 3: 導いた値は上流の許す文字だけで構成され、区切りの `:` がちょうど 3 つ現れる", () => {
    fc.assert(
      fc.property(genCompletePayload, (payload) => {
        const key = toUniqueKey(payload);
        expect(key).not.toBeNull();
        const text = key as string;
        expect(text).toMatch(ALLOWED_CHARS);
        // 要素内の `:` は `%3A` へ写るため、残る `:` は区切りだけである。
        expect(text.split(":").length - 1).toBe(3);
      }),
      { numRuns: 300 },
    );
  });

  // Feature: pos-order-ingress, Property 3: Unique_Key は決定的で上流と一致する
  // Feature: pos-order-ingress, Property 3: Unique_Key は決定的で上流と一致する
  // **Validates: Requirements 6.18, 14.5**
  //
  // 読み出せるのは非空文字列と有限の数値だけである（`readDeclaredText`）。真偽値・オブジェクト・配列・
  // 非有限の数値は AC 6.18 の文言（欠落・null・文字列化した結果が空文字）に触れていないが、毒として
  // 扱う——`"true"` や `[object Object]` を識別子として成立させれば、宛先の読み出し（Store_Code）と
  // 結論が食い違い、原因が「宛先未登録の 2 時間保留」に化けて観測されずに消える。
  it("Property 3: 4 要素のいずれかが読み出せなければ null を返す", () => {
    const genBreaker = fc.constantFrom<
      "delete" | "null" | "undefined" | "empty" | "array" | "object" | "boolean" | "not-finite"
    >("delete", "null", "undefined", "empty", "array", "object", "boolean", "not-finite");
    fc.assert(
      fc.property(
        genCompletePayload,
        fc.constantFrom(...UNIQUE_KEY_FIELDS),
        genBreaker,
        (payload, field, breaker) => {
          const broken: Record<string, unknown> = { ...payload };
          if (breaker === "delete") delete broken[field];
          else if (breaker === "null") broken[field] = null;
          else if (breaker === "undefined") broken[field] = undefined;
          else if (breaker === "empty") broken[field] = "";
          else if (breaker === "array") broken[field] = [7];
          else if (breaker === "object") broken[field] = {};
          else if (breaker === "boolean") broken[field] = true;
          else broken[field] = Number.NaN;
          expect(toUniqueKey(broken)).toBeNull();
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: pos-order-ingress, Property 3: Unique_Key は決定的で上流と一致する
  // **Validates: Requirements 6.3**
  it("Property 3: order_id を置換・削除しても値が変わらない", () => {
    fc.assert(
      fc.property(genCompletePayload, fc.anything(), (payload, orderId) => {
        const withoutOrderId: Record<string, unknown> = { ...payload };
        delete withoutOrderId.order_id;
        const expected = toUniqueKey(withoutOrderId);
        expect(toUniqueKey({ ...withoutOrderId, order_id: orderId })).toBe(expected);
        expect(toUniqueKey({ ...withoutOrderId, order_id: null })).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });

  // Feature: pos-order-ingress, Property 3: Unique_Key は決定的で上流と一致する
  // **Validates: Requirements 14.2, 14.3, 14.4**
  it("Property 3: 余剰フィールドを混ぜても値が変わらない（素通しは payload に閉じる）", () => {
    fc.assert(
      fc.property(
        genCompletePayload,
        fc.string({ maxLength: 8 }).filter(isExtraKey),
        fc.anything(),
        (payload, key, value) => {
          expect(toUniqueKey({ ...payload, [key]: value })).toBe(toUniqueKey(payload));
        },
      ),
      { numRuns: 300 },
    );
  });
});
