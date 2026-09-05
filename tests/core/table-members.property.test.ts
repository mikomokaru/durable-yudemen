// tests/core/table-members.property.test.ts — 走行中 Timer から卓ごとの提供時刻の表を引く射影（project.ts の
// tableMembers）の性質。
//
// Feature: lift-group-planning, Property 11 / 12（design「設計から追加で立つ性質」）
// **Validates: Requirements 2.1（卓なしは成員にならない）, 3.3（錨は実効 endTime の最大）, 3.5**
//
// 表は状態ではなく毎回作って捨てる導出値である。ここで固定するのは 3 つ——tableId を持たない Timer は
// どの鍵にも属さないこと、鍵ごとの値は実効 endTime（endTime + adjustment）の昇順で全員が入ること、
// 単独キー（NUL 始まり）が非空の tableId と決して一致しないこと。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { adjustedEndTime, tableMembers } from "../../src/engine/project";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { nonEmpty } from "../nonEmpty";

const NOW = 1_700_000_000_000;

/** 走行中 Timer 1 本。卓は「無し」「t-1」「t-2」を振り、adjustment で実効 endTime をずらす。 */
const genTimer: fc.Arbitrary<Timer> = fc
  .record({
    seq: fc.nat({ max: 1000 }),
    slot: fc.integer({ min: 0, max: 11 }),
    endOffset: fc.integer({ min: -60_000, max: 600_000 }),
    adjustment: fc.integer({ min: -30_000, max: 30_000 }),
    orderItem: fc.option(
      fc.record({
        externalOrderId: fc.string({ minLength: 1, maxLength: 6 }),
        itemIndex: fc.nat({ max: 3 }),
        tableId: fc.option(fc.constantFrom("t-1", "t-2"), { nil: null }),
      }),
      { nil: null },
    ),
  })
  .map(({ seq, slot, endOffset, adjustment, orderItem }) =>
    createTimer({
      id: `t-${seq}` as TimerId,
      slotIds: nonEmpty([String(slot) as SlotId]),
      noodleType: "Thin" as NoodleType,
      firmness: "normal",
      startTime: (NOW + endOffset - 60_000) as EpochMillis,
      endTime: (NOW + endOffset) as EpochMillis,
      seq,
      adjustment,
      orderItem,
    }),
  );

const genRunning: fc.Arbitrary<readonly Timer[]> = fc.array(genTimer, { maxLength: 8 });

describe("engine/project — tableMembers", () => {
  it("Property 11: tableId を持たない走行中はどの鍵にも属さない（卓なし同士も束ねない）", () => {
    fc.assert(
      fc.property(genRunning, (running) => {
        const members = tableMembers(running);
        const keyed = running.filter((timer) => timer.orderItem?.tableId != null);
        // 表に在る鍵は、卓を持つ Timer の tableId の集合と一致する。
        expect(new Set(members.keys())).toEqual(new Set(keyed.map((t) => t.orderItem!.tableId!)));
        // 値の総数は卓を持つ Timer の本数に一致する（卓なしはどこにも数えられていない）。
        const total = [...members.values()].reduce((sum, ends) => sum + ends.length, 0);
        expect(total).toBe(keyed.length);
      }),
      { numRuns: 300 },
    );
  });

  it("Property 12: 単独キー（NUL 始まり）は非空の tableId と一致せず、表に当たらない", () => {
    fc.assert(
      fc.property(
        genRunning,
        fc.string({ minLength: 1, maxLength: 6 }),
        fc.nat({ max: 3 }),
        (running, externalOrderId, itemIndex) => {
          const members = tableMembers(running);
          const soloKey = `\u0000${externalOrderId}\u0000${itemIndex}`;
          expect(members.get(soloKey)).toBeUndefined();
        },
      ),
      { numRuns: 200 },
    );
  });

  it("鍵ごとの値は実効 endTime（endTime + adjustment）の昇順で、走行中の並びに依らない", () => {
    fc.assert(
      fc.property(
        genRunning.chain((running) =>
          fc.shuffledSubarray([...running], { minLength: running.length }).map((shuffled) => ({
            running,
            shuffled,
          })),
        ),
        ({ running, shuffled }) => {
          const members = tableMembers(running);
          for (const [tableId, ends] of members) {
            const expected = running
              .filter((timer) => timer.orderItem?.tableId === tableId)
              .map(adjustedEndTime)
              .sort((a, b) => a - b);
            expect([...ends]).toEqual(expected);
            expect(ends.length).toBeGreaterThan(0);
          }
          // 並びを変えても同じ表になる（決定性・Property 13 の前提）。
          expect(tableMembers(shuffled)).toEqual(members);
        },
      ),
      { numRuns: 200 },
    );
  });
});
