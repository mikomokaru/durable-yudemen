// tests/core/start.property.test.ts — Property 14（endTime 算出）・Property 7（開始拒否）・Property 6（容量上限）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { startTimer } from "../../src/engine/start";
import type { Event } from "../../src/engine/event";
import type { EpochMillis, TimerId } from "../../src/engine/types";
import type { TimerState } from "../../src/engine/state";
import { genState, genStateExact } from "./generators";

/** Start イベントを組み立てる（startTimer は Start 種別だけを受け取る）。 */
function startEvent(input: {
  slotId: string;
  noodleType: string;
  boilSeconds: number;
  now: number;
}): Extract<Event, { type: "Start" }> {
  return {
    type: "Start",
    slotId: input.slotId,
    noodleType: input.noodleType,
    boilSeconds: input.boilSeconds,
    newTimerId: "new-timer-id" as TimerId,
    now: input.now as EpochMillis,
  };
}

/** 状態の不変性を比較するための素の写し（startTimer は拒否時に状態を変えない）。 */
function plain(state: TimerState): unknown {
  return structuredClone({ timers: state.timers, nextSeq: state.nextSeq });
}

describe("core/start", () => {
  // Feature: yude-men-timer, Property 14: 開始した Timer の endTime は now + boilSeconds*1000 に一致する。
  // 範囲内の有効な Start について、追加 Timer の endTime は厳密に now + boilSeconds*1000、件数は +1。
  it("Property 14: 開始成功時の endTime は now + boilSeconds*1000、件数は 1 件増える", () => {
    fc.assert(
      fc.property(
        genState.filter((s) => s.timers.length < 100),
        fc.integer({ min: 1, max: 1800 }),
        fc.string({ minLength: 1, maxLength: 6 }),
        fc.string({ minLength: 1, maxLength: 6 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        (state, boilSeconds, slotId, noodleType, now) => {
          const outcome = startTimer(state, startEvent({ slotId, noodleType, boilSeconds, now }));
          expect(outcome.ok).toBe(true);
          if (outcome.ok) {
            expect(outcome.state.timers.length).toBe(state.timers.length + 1);
            const added = outcome.state.timers[outcome.state.timers.length - 1];
            expect(added?.endTime).toBe(now + boilSeconds * 1000);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: yude-men-timer, Property 7: 茹で時間範囲外・未定義 slot/noodle の開始は拒否され状態不変。
  // 範囲外 boilSeconds は InvalidBoilSeconds、空 slot/noodle は InvalidSlotOrNoodle を返し、状態を変えない。
  it("Property 7: 範囲外・未定義の開始入力は拒否され状態は不変", () => {
    const genInvalidStart = fc.oneof(
      // boilSeconds が範囲外（slot/noodle は妥当）→ InvalidBoilSeconds。
      fc
        .record({
          boilSeconds: fc.oneof(fc.integer({ max: 0 }), fc.integer({ min: 1801 }), fc.constantFrom(Number.NaN, Infinity, -Infinity)),
          slotId: fc.string({ minLength: 1, maxLength: 6 }),
          noodleType: fc.string({ minLength: 1, maxLength: 6 }),
        })
        .map((input) => ({ input, expected: "InvalidBoilSeconds" as const })),
      // slot/noodle が未定義（空文字。boilSeconds は妥当）→ InvalidSlotOrNoodle。
      fc
        .record({
          boilSeconds: fc.integer({ min: 1, max: 1800 }),
          slotId: fc.oneof(fc.constant(""), fc.string({ minLength: 1, maxLength: 6 })),
          noodleType: fc.oneof(fc.constant(""), fc.string({ minLength: 1, maxLength: 6 })),
        })
        .filter((r) => r.slotId === "" || r.noodleType === "")
        .map((input) => ({ input, expected: "InvalidSlotOrNoodle" as const })),
    );

    fc.assert(
      fc.property(genState, genInvalidStart, fc.integer({ min: 0, max: 5_000_000 }), (state, { input, expected }, now) => {
        const before = plain(state);
        const outcome = startTimer(state, startEvent({ ...input, now }));
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
          expect(outcome.rejection.code).toBe(expected);
        }
        expect(plain(state)).toEqual(before);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: yude-men-timer, Property 6: 容量上限を超えて Timer は増えない。
  // 100 件状態と有効な Start について、startTimer は CapacityExceeded を返し状態を変えない。
  it("Property 6: 100 件走行中の有効な開始は CapacityExceeded で拒否され状態は不変", () => {
    fc.assert(
      fc.property(
        genStateExact(100),
        fc.record({
          slotId: fc.string({ minLength: 1, maxLength: 6 }),
          noodleType: fc.string({ minLength: 1, maxLength: 6 }),
          boilSeconds: fc.integer({ min: 1, max: 1800 }),
        }),
        fc.integer({ min: 0, max: 5_000_000 }),
        (state, input, now) => {
          expect(state.timers.length).toBe(100);
          const before = plain(state);
          const outcome = startTimer(state, startEvent({ ...input, now }));
          expect(outcome.ok).toBe(false);
          if (!outcome.ok) {
            expect(outcome.rejection.code).toBe("CapacityExceeded");
          }
          expect(plain(state)).toEqual(before);
        },
      ),
      { numRuns: 100 },
    );
  });
});
