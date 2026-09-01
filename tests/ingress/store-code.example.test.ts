// tests/ingress/store-code.example.test.ts — Store_Code ごとの分配の example test。
//
// property test が「順序・分割・一意」を面で押さえるのに対し、ここは実バッチの形（複数店舗の混在と
// 同一店舗の非連続な再出現）を点で固定する。

import { describe, expect, it } from "vitest";
import type { ArrivalRecord } from "../../src/ingress/batch";
import { groupByStoreCode } from "../../src/ingress/store-code";

/** seq で並びを追えるだけの最小の Record（分配の判断に関わるのは store_id のみ）。 */
function record(storeId: unknown, sequenceNumber: string): ArrivalRecord {
  return {
    path: "/lio/order",
    payload: storeId === undefined ? {} : { store_id: storeId },
    arrivalTimestampMs: 1_770_000_000_000,
    sequenceNumber,
  };
}

const seqs = (records: readonly ArrivalRecord[]): readonly string[] =>
  records.map((r) => r.sequenceNumber);

describe("ingress/store-code — groupByStoreCode", () => {
  it("複数店舗が混在するバッチを店舗ごとの組へ畳む（AC 5.1）", () => {
    const groups = groupByStoreCode([record(1, "a"), record(2, "b"), record(3, "c")]);

    expect([...groups.byStoreCode.keys()]).toEqual(["1", "2", "3"]);
    expect(seqs(groups.byStoreCode.get("2") ?? [])).toEqual(["b"]);
    expect(groups.unreadableStoreCode).toEqual([]);
  });

  it("同一店舗が非連続に現れても 1 つの組へ畳まれ、間に他店舗が挟まっても到着順が保たれる（AC 4.7・5.3）", () => {
    const groups = groupByStoreCode([
      record(1, "a"),
      record(2, "b"),
      record(1, "c"),
      record(3, "d"),
      record(1, "e"),
    ]);

    expect(groups.byStoreCode.size).toBe(3);
    expect(seqs(groups.byStoreCode.get("1") ?? [])).toEqual(["a", "c", "e"]);
  });

  it("数値と文字列は文字列化を経て同一の Store_Code へ落ちる（AC 6.18・14.5）", () => {
    const groups = groupByStoreCode([record(1, "a"), record("1", "b")]);

    expect([...groups.byStoreCode.keys()]).toEqual(["1"]);
    expect(seqs(groups.byStoreCode.get("1") ?? [])).toEqual(["a", "b"]);
  });

  it("Store_Code を読み出せない Record は組から除かれ、別の列として返る（欠落を作らない）", () => {
    const groups = groupByStoreCode([
      record(1, "a"),
      record(undefined, "missing"),
      record(null, "null"),
      record("", "empty"),
      record(Number.NaN, "nan"),
      record({}, "object"),
      record(2, "b"),
    ]);

    // 読み出せた分だけが組になる（宛先が定まらない Record は照会の対象にならない）。
    expect([...groups.byStoreCode.keys()]).toEqual(["1", "2"]);
    // 到着順のまま、1 件も落とさずに返る（分類は RecordOutcome の関心事ゆえここでは種別を名乗らない）。
    expect(seqs(groups.unreadableStoreCode)).toEqual(["missing", "null", "empty", "nan", "object"]);
  });

  it("空のバッチは空の組と空の列を返す（全件が上流で除外された結果を失敗としない・AC 1.12）", () => {
    const groups = groupByStoreCode([]);

    expect(groups.byStoreCode.size).toBe(0);
    expect(groups.unreadableStoreCode).toEqual([]);
  });
});
