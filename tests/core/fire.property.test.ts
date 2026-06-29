// tests/core/fire.property.test.ts — Property 4（一括ドレイン）・Property 5（冪等性）・Property 11（処理順）。
//
// 新モデル: 発火は除去せず running → boiled へ遷移させ、boiled は集合に残す（明示完了 Complete まで）。
// Alarm の張り直しは running（boiledAt === null）の最早だけを対象にし、boiled の過去 endTime で再発火しない。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fireDueTimers, reconcile } from "../../src/engine/fire";
import { EPSILON_MS } from "../../src/engine/types";
import type { Timer } from "../../src/engine/timer";
import { genStateAndNow } from "./generators";

describe("core/fire", () => {
  // Feature: yude-men-timer, Property 4: 一括ドレイン後、走行中は now+ε より未来のみ・期限到来分は boiled として残る。
  it("Property 4: ドレイン後、走行中は now+ε より未来のみ・期限到来分は boiled へ遷移し残る", () => {
    fc.assert(
      fc.property(genStateAndNow, ({ state, now }) => {
        const outcome = fireDueTimers(state, now);
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          const threshold = (now as number) + EPSILON_MS;
          // 発火は除去しない。件数は不変。
          expect(outcome.state.timers.length).toBe(state.timers.length);
          for (const t of outcome.state.timers) {
            if (t.boiledAt === null) {
              // 走行中は厳密に now+ε より未来（境界以下は走行中に残らない・要件2.10 / 3.3 / 7.6）。
              expect((t.endTime as number) > threshold).toBe(true);
            } else {
              // boiled は期限到来済み（endTime ≤ now+ε）で、発火時刻は now。
              expect((t.endTime as number) <= threshold).toBe(true);
              expect(t.boiledAt as number).toBe(now as number);
            }
          }
          // reconcile は fireDueTimers と同形（要件7.6 / 7.7）。
          expect(reconcile(state, now)).toEqual(outcome);
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: yude-men-timer, Property 5: fireDueTimers は冪等的に安定（at-least-once 多重発火への安定性）。
  // 同じ now で再適用すると状態は不変で、二度目の boiled ブロードキャストは生じない（既 boiled は再通知しない）。
  it("Property 5: 同一 now の再適用で状態は不変、二度目の boiled ブロードキャストは生じない", () => {
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
            // 二度目は新たに boiled になる Timer が無いため、Broadcast を一切出さない。
            const broadcasts = second.effects.filter((e) => e.type === "Broadcast");
            expect(broadcasts.length).toBe(0);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: yude-men-timer, Property 11: 茹で上がりの処理順は endTime 昇順（同一は seq 順）。
  // fireDueTimers が返す Broadcast(boiled) 列は、対応 Timer の (endTime, seq) について昇順に整列している。
  it("Property 11: boiled ブロードキャスト列は対応 Timer の (endTime, seq) 昇順", () => {
    fc.assert(
      fc.property(genStateAndNow, ({ state, now }) => {
        const outcome = fireDueTimers(state, now);
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          const byId = new Map<string, Timer>(state.timers.map((t) => [t.id as string, t]));
          const boiledTimers: Timer[] = [];
          for (const effect of outcome.effects) {
            if (effect.type === "Broadcast" && effect.message.type === "boiled") {
              const timer = byId.get(effect.message.timerId);
              if (timer !== undefined) boiledTimers.push(timer);
            }
          }
          for (let i = 1; i < boiledTimers.length; i++) {
            const prev = boiledTimers[i - 1]!;
            const curr = boiledTimers[i]!;
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
