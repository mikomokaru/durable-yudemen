// tests/ingress/store-code.property.test.ts — Store_Code ごとの分配（src/ingress/store-code.ts）の
// property test。
//
// 検証する 3 つの事実（design の番号付き Property ではなく、AC を直接押さえる）。
//   ・同一 Store_Code 内の到着順が保たれる（結果の各組が入力の部分列である・AC 5.3）
//   ・入力の全 Record が漏れなく・重複なくどこかに現れる（欠落を作らない・AC 5.1）
//   ・Store_Code は結果に 1 回だけ現れ、組の構成員は全員そのコードを持つ（AC 4.7）

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ArrivalRecord } from "../../src/ingress/batch";
import { groupByStoreCode } from "../../src/ingress/store-code";

/**
 * `payload.store_id` の生成。実データは数値で届くため数値を厚く取り、値域を数店舗へ絞って同一
 * Store_Code の再出現（畳み込みと順序の対象）を必ず起こす。読み出せない値も混ぜて分割を検証する。
 */
const genStoreId: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(1, 2, 3, 101) },
  { weight: 3, arbitrary: fc.constantFrom("1", "2", "s-001") },
  { weight: 1, arbitrary: fc.constantFrom(null, undefined, "", Number.NaN, true, {}, []) },
);

/** 4 つの構造を満たす ArrivalRecord。store_id 以外は分配の判断に関わらない。 */
const genRecord: fc.Arbitrary<ArrivalRecord> = fc
  .tuple(genStoreId, fc.integer({ min: 0, max: 4_000_000_000_000 }), fc.string({ minLength: 1, maxLength: 8 }))
  .map(([storeId, arrivalTimestampMs, sequenceNumber]) => ({
    path: "/lio/order",
    // undefined は「キーの欠落」として表す（AC 6.18 の欠落に当たる形を実際に作る）。
    payload: storeId === undefined ? {} : { store_id: storeId },
    arrivalTimestampMs,
    sequenceNumber,
  }));

const genRecords = fc.array(genRecord, { maxLength: 24 });

describe("ingress/store-code — groupByStoreCode", () => {
  // **Validates: Requirements 5.3**
  it("同一 Store_Code 内の到着順が保たれる（各組が入力の部分列である）", () => {
    fc.assert(
      fc.property(genRecords, (records) => {
        const groups = groupByStoreCode(records);
        for (const arrived of groups.byStoreCode.values()) {
          expect(isSubsequence(arrived, records)).toBe(true);
        }
        // 読み出せなかった列も到着順のまま返る（後段の診断ログが seq の並びを保てる）。
        expect(isSubsequence(groups.unreadableStoreCode, records)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  // **Validates: Requirements 5.1**
  it("全 Record が漏れなく・重複なくどこかに現れる（欠落を作らない）", () => {
    fc.assert(
      fc.property(genRecords, (records) => {
        const groups = groupByStoreCode(records);
        const distributed = [...groups.byStoreCode.values()].flat().concat(groups.unreadableStoreCode);
        expect(distributed.length).toBe(records.length);
        expect(countByRecord(distributed)).toEqual(countByRecord(records));
      }),
      { numRuns: 300 },
    );
  });

  // **Validates: Requirements 4.7**
  it("Store_Code は 1 回だけ現れ、組の構成員は全員そのコードを持つ", () => {
    fc.assert(
      fc.property(genRecords, (records) => {
        const groups = groupByStoreCode(records);
        for (const [storeCode, arrived] of groups.byStoreCode) {
          // 空の組は作らない（照会するコードは必ず Record を伴う）。
          expect(arrived.length).toBeGreaterThan(0);
          // 文字列化を経た値で畳むため、構成員の store_id は全員このコードへ写る（AC 6.18・14.5）。
          for (const record of arrived) {
            expect(String(record.payload.store_id)).toBe(storeCode);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});

/** group の各要素が records に同じ相対順序で現れるか（参照の重複にも耐える走査）。 */
function isSubsequence(group: readonly ArrivalRecord[], records: readonly ArrivalRecord[]): boolean {
  let cursor = 0;
  for (const record of group) {
    const found = records.indexOf(record, cursor);
    if (found < 0) return false;
    cursor = found + 1;
  }
  return true;
}

/** 参照ごとの出現回数（順序を捨てて多重集合として比べるため）。 */
function countByRecord(records: readonly ArrivalRecord[]): Map<ArrivalRecord, number> {
  const counts = new Map<ArrivalRecord, number>();
  for (const record of records) {
    counts.set(record, (counts.get(record) ?? 0) + 1);
  }
  return counts;
}
