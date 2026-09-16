// 注文到着の Producer。**取り込みの応答にも保存にも触れない**ことと、出す形を固定する。

import { describe, expect, it, vi } from "vitest";
import type { ArrivalRecord } from "../../src/ingress/batch";
import { orderArrivalRecordSchema } from "../../src/data-platform/record-schema";
import { tryWriteOrderArrivalLines } from "../../src/order-arrival/producer";

const record = (sequenceNumber: string): ArrivalRecord => ({
  path: "/lio/order",
  payload: { store_id: "1102", terminal_id: "1", bill_no: "7", datetime: "2026-09-16T18:52:19" },
  arrivalTimestampMs: 1_700_000_000_000,
  sequenceNumber,
});

const observation = (count: number) => ({
  storeId: "yamaokaya-1102",
  records: Array.from({ length: count }, (_unused, index) => ({
    record: record(`${index}`),
    externalOrderId: "1102:1:7:2026-09-16T18%3A52%3A19",
  })),
});

describe("出力の境界", () => {
  it("無効なら 1 件も出さない", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      tryWriteOrderArrivalLines(false, observation(2));
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("有効なら 1 件に 1 回、payload を渡し、それが Tail の検査を通る", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      tryWriteOrderArrivalLines(true, observation(2));

      expect(log).toHaveBeenCalledTimes(2);
      for (const [payload] of log.mock.calls) {
        expect(orderArrivalRecordSchema.safeParse(payload).success).toBe(true);
      }
    } finally {
      log.mockRestore();
    }
  });

  it("console が投げても外へ伝播しない", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("console unavailable");
    });
    try {
      // 記録の失敗で POS の取り込みを失敗させない。
      expect(() => tryWriteOrderArrivalLines(true, observation(2))).not.toThrow();
    } finally {
      log.mockRestore();
    }
  });

  it("1 件が失敗しても残りを出す", () => {
    let calls = 0;
    const log = vi.spyOn(console, "log").mockImplementation(() => {
      calls += 1;
      if (calls === 1) throw new Error("first fails");
    });
    try {
      tryWriteOrderArrivalLines(true, observation(3));
      expect(calls).toBe(3);
    } finally {
      log.mockRestore();
    }
  });
});
