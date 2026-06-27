// tests/core/fire.property.test.ts — Property 4（一括ドレイン）・Property 5（冪等性）・Property 11（処理順）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fireDueTimers, reconcile } from "../../src/core/fire";
import { EPSILON_MS } from "../../src/core/types";
import type { Timer } from "../../src/core/timer";
import { genStateAndNow } from "./generators";

describe("core/fire", () => {
  // Feature: yude-men-timer, Property 4: 一括ドレイン後、due は消滅し残存最早は必ず now+ε より未来。
  // fireDueTimers / reconcile 適用後、endTime ≤ now+ε の Timer は残らず、残存最早は厳密に now+ε より未来。
  it("Property 4: ドレイン後に due は残らず、残存最早は厳密に now+ε より未来", () => {
    fc.assert(
      fc.property(genStateAndNow, ({ state, now }) => {
        const outcome = fireDueTimers(state, now);
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          const threshold = (now as number) + EPSILON_MS;
          for (const t of outcome.state.timers) {
            // 残存は厳密に now+ε より未来（境界以下は一件も残らない・要件2.10 / 3.3 / 7.6）。
            expect((t.endTime as number) > threshold).toBe(true);
          }
          // reconcile は fireDueTimers と同形（要件7.6 / 7.7）。
          expect(reconcile(state, now)).toEqual(outcome);
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: yude-men-timer, Property 5: fireDueTimers は冪等的に安定（at-least-once 多重発火への安定性）。
  // 同じ now で再適用すると二度目の due は空・結果状態は一度目と等しく、done ブロードキャストも生じない。
  it("Property 5: 同一 now の再適用で状態は不変、二度目の done ブロードキャストは生じない", () => {
    fc.assert(
      fc.property(genStateAndNow, ({ state, now }) => {
        const first = fireDueTimers(state, now);
        expect(first.ok).toBe(true);
        if (first.ok) {
          const second = fireDueTimers(first.state, now);
          expect(second.ok).toBe(true);
          if (second.ok) {
            // 二度目の結果状態は一度目と等しい（多重発火に対して状態は安定）。
            expect(second.state).toEqual(first.state);
            // 二度目は due 空ゆえ done ブロードキャストを一切出さない。
            const doneBroadcasts = second.effects.filter((e) => e.type === "Broadcast");
            expect(doneBroadcasts.length).toBe(0);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: yude-men-timer, Property 11: 茹で上がりの処理順は endTime 昇順（同一は seq 順）。
  // fireDueTimers が返す Broadcast(done) 列は、対応 Timer の (endTime, seq) について昇順に整列している。
  it("Property 11: done ブロードキャスト列は対応 Timer の (endTime, seq) 昇順", () => {
    fc.assert(
      fc.property(genStateAndNow, ({ state, now }) => {
        const outcome = fireDueTimers(state, now);
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          const byId = new Map<string, Timer>(state.timers.map((t) => [t.id as string, t]));
          const doneTimers: Timer[] = [];
          for (const effect of outcome.effects) {
            if (effect.type === "Broadcast" && effect.message.type === "done") {
              const timer = byId.get(effect.message.timerId);
              if (timer !== undefined) doneTimers.push(timer);
            }
          }
          for (let i = 1; i < doneTimers.length; i++) {
            const prev = doneTimers[i - 1]!;
            const curr = doneTimers[i]!;
            const ordered =
              prev.endTime < curr.endTime || (prev.endTime === curr.endTime && prev.seq <= curr.seq);
            expect(ordered).toBe(true);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
