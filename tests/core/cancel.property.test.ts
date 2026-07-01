// tests/core/cancel.property.test.ts — Property 8（非存在キャンセル拒否）・Property 10（結果集合は部分集合）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cancelTimer } from "../../src/engine/cancel";
import { fireDueTimers } from "../../src/engine/fire";
import type { Timer } from "../../src/engine/timer";
import type { EpochMillis } from "../../src/engine/types";
import type { SyncParams } from "../../src/engine/sync";
import { genState, nowArbFor } from "./generators";

/** 固定の同期パラメータ（既定域内・arms=2 / toleranceRatio=10%）。cancel は settle 経由で残余を再同期する。 */
const PARAMS: SyncParams = { arms: 2, toleranceRatio: 10 };

/** adjustment を除いた Timer のアンカー恒等（id・startTime・endTime・seq・boiledAt・slotIds 等）。 */
function anchorOf(t: Timer): unknown {
  const { adjustment: _adjustment, ...anchor } = t;
  return anchor;
}

/**
 * 結果 timers が元集合の部分集合か。cancel は残余 running を再同期するため adjustment は変わりうる。
 * ゆえに adjustment を除いたアンカー恒等（id・時刻事実・seq・boiledAt）が元集合に同一で存在するかで判定する。
 */
function isSubset(result: readonly Timer[], origin: readonly Timer[]): boolean {
  return result.every((r) =>
    origin.some((o) => o.id === r.id && JSON.stringify(anchorOf(o)) === JSON.stringify(anchorOf(r))),
  );
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
        const outcome = cancelTimer(state, timerId, now as EpochMillis, PARAMS);
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
  // 発火は除去せず boiled として残すため id 集合は元と一致（部分集合かつ同数）。cancelTimer の結果 timers は
  // 元集合の部分集合であり、キャンセル対象は残らない。
  it("Property 10: 発火後の id は元集合に含まれ件数不変・キャンセル後は部分集合でキャンセル対象は残らない", () => {
    const genStateNowCancel = genState.chain((state) => {
      const idArb = state.timers.length > 0 ? fc.constantFrom(...state.timers.map((t) => t.id as string)) : fc.constant("absent");
      return fc.record({ state: fc.constant(state), now: nowArbFor(state), cancelId: idArb });
    });

    fc.assert(
      fc.property(genStateNowCancel, ({ state, now, cancelId }) => {
        // 一括ドレイン発火は除去しない。id は元集合に含まれ、件数は不変（boiled として残る）。
        const fired = fireDueTimers(state, now, PARAMS);
        expect(fired.ok).toBe(true);
        if (fired.ok) {
          const originIds = new Set(state.timers.map((t) => t.id as string));
          expect(fired.state.timers.every((t) => originIds.has(t.id as string))).toBe(true);
          expect(fired.state.timers.length).toBe(state.timers.length);
        }
        // キャンセルの結果は部分集合で、対象 id は残らない（要件6.5）。残余 running の adjustment は再同期で変わりうる。
        const cancelled = cancelTimer(state, cancelId, now, PARAMS);
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
