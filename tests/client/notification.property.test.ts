// tests/client/notification.property.test.ts — Property 16（通知の冪等性）。
// notification.ts は純粋関数のため workerd を必要としない（plain vitest）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { markProcessed, shouldHandleDone } from "../../src/client/notification";

// 通知 1 件。done / cancelled は同一の処理済み記録と判定規律を共有する（要件6.8）。
// timerId は小さなプールに絞り、重複・混在・相互干渉の検査を確実に踏ませる。
const genNotification = fc.record({
  timerId: fc.constantFrom("t-a", "t-b", "t-c", "t-d"),
  kind: fc.constantFrom<"done" | "cancelled">("done", "cancelled"),
});

describe("client/notification", () => {
  // Feature: yude-men-timer, Property 16: 通知の冪等性 — 各 timerId につき高々 1 回だけ処理
  // 重複・done/cancelled 混在の任意列を畳み込み、各 timerId で shouldHandleDone が高々 1 回 true、
  // 登録後は以後 false、異なる timerId は相互不干渉であることを検証する（要件2.11 / 2.12 / 6.8）。
  it("Property 16: 各 timerId につき高々 1 回だけ処理し、登録後は以後 false、異なる timerId は相互不干渉", () => {
    fc.assert(
      fc.property(fc.array(genNotification, { maxLength: 50 }), (sequence) => {
        // 処理済み記録を畳み込みで育てる。集合は表示制御用ローカル情報であり SSOT ではない。
        let processedIds = new Set<string>();
        // timerId ごとに shouldHandleDone が true を返した回数。
        const handledCount = new Map<string, number>();
        // 列に登場した全 timerId。
        const seenIds = new Set<string>();

        for (const notification of sequence) {
          const { timerId } = notification;
          seenIds.add(timerId);
          const alreadyRegistered = processedIds.has(timerId);
          const handle = shouldHandleDone(timerId, processedIds);

          // 登録後は以後 false（要件2.11 / 2.12）。登録済みなら必ず無視される。
          if (alreadyRegistered) {
            expect(handle).toBe(false);
          }

          if (handle) {
            handledCount.set(timerId, (handledCount.get(timerId) ?? 0) + 1);
            processedIds = markProcessed(processedIds, timerId);
          }
        }

        // 各 timerId につき処理は高々 1 回（登場 id は厳密に 1 回処理される）。
        for (const id of seenIds) {
          expect(handledCount.get(id)).toBe(1);
          // 畳み込み後、登場済み id は登録済みなので以後は処理されない。
          expect(shouldHandleDone(id, processedIds)).toBe(false);
        }

        // 相互不干渉：登場していない timerId は誰かの処理に影響されず依然 true。
        const absentIds = ["t-a", "t-b", "t-c", "t-d", "t-absent"].filter((id) => !seenIds.has(id));
        for (const id of absentIds) {
          expect(shouldHandleDone(id, processedIds)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});
