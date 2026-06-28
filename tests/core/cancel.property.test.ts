// tests/core/cancel.property.test.ts — Property 8（非存在キャンセル拒否）・Property 10（結果集合は部分集合）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cancelTimer } from "../../src/engine/cancel";
import { fireDueTimers } from "../../src/engine/fire";
import type { Timer } from "../../src/engine/timer";
import type { EpochMillis } from "../../src/engine/types";
import { genState, nowArbFor } from "./generators";

/** 結果 timers が元集合の部分集合か（id で対応づけ、各残存が元集合に同一内容で存在する）。 */
function isSubset(result: readonly Timer[], origin: readonly Timer[]): boolean {
  return result.every((r) => origin.some((o) => o.id === r.id && JSON.stringify(o) === JSON.stringify(r)));
}

describe("core/cancel", () => {
  // Feature: yude-men-timer, Property 8: 存在しない timerId のキャンセルは拒否され状態不変。
  // 状態に存在しない任意の timerId について、cancelTimer は TimerNotFound を返し状態を変えない。
  it("Property 8: 非存在 timerId のキャンセルは TimerNotFound で拒否され状態は不変", () => {
    fc.assert(
      fc.property(genState, fc.string(), fc.integer({ min: 0, max: 5_000_000 }), (state, suffix, now) => {
        const timerId = `absent-${suffix}`; // 生成器の id は "timer-N"。前置で衝突を排除する。
        fc.pre(!state.timers.some((t) => t.id === timerId));
        const before = structuredClone({ timers: state.timers, nextSeq: state.nextSeq });
        const outcome = cancelTimer(state, timerId, now as EpochMillis);
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
          expect(outcome.rejection.code).toBe("TimerNotFound");
        }
        expect({ timers: state.timers, nextSeq: state.nextSeq }).toEqual(before);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: yude-men-timer, Property 10: 発火・キャンセル後の Timer 集合は元集合の部分集合。
  // fireDueTimers / cancelTimer の結果 timers は元集合の部分集合であり、キャンセル対象は残らない。
  it("Property 10: 発火・キャンセル後の timers は元集合の部分集合（キャンセル対象は残らない）", () => {
    const genStateNowCancel = genState.chain((state) => {
      const idArb = state.timers.length > 0 ? fc.constantFrom(...state.timers.map((t) => t.id as string)) : fc.constant("absent");
      return fc.record({ state: fc.constant(state), now: nowArbFor(state), cancelId: idArb });
    });

    fc.assert(
      fc.property(genStateNowCancel, ({ state, now, cancelId }) => {
        // 一括ドレイン発火の結果は元集合の部分集合。
        const fired = fireDueTimers(state, now);
        expect(fired.ok).toBe(true);
        if (fired.ok) {
          expect(isSubset(fired.state.timers, state.timers)).toBe(true);
        }
        // キャンセルの結果も部分集合で、対象 id は残らない（要件6.5）。
        const cancelled = cancelTimer(state, cancelId, now);
        if (cancelled.ok) {
          expect(isSubset(cancelled.state.timers, state.timers)).toBe(true);
          expect(cancelled.state.timers.some((t) => t.id === cancelId)).toBe(false);
        } else {
          expect(cancelled.rejection.code).toBe("TimerNotFound");
        }
      }),
      { numRuns: 200 },
    );
  });
});
