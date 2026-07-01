// tests/core/fire.property.test.ts — Property 4（一括ドレイン）・Property 5（冪等性）・Property 11（snapshot 単一表現）。
//
// 新モデル: 発火は除去せず running → boiled へ遷移させ、boiled は集合に残す（明示完了 Complete まで）。
// 発火の基準は実効 endTime（Adjusted_Boil_Time = endTime + adjustment・要件4.4）。実効時刻で due になった
// running を先に boiled へ凍結し、その後 settle で残り running を再同期する（要件7.3）。Alarm の張り直しは
// running（boiledAt === null）の実効最早だけを対象にし、boiled の過去 endTime で再発火しない。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fireDueTimers, reconcile } from "../../src/engine/fire";
import { adjustedEndTime } from "../../src/engine/project";
import { EPSILON_MS } from "../../src/engine/types";
import type { SyncParams } from "../../src/engine/sync";
import { genStateAndNow } from "./generators";

/** 固定の同期パラメータ（既定域内・arms=2 / toleranceRatio=10%）。発火後の残り running を settle が再同期する。 */
const PARAMS: SyncParams = { arms: 2, toleranceRatio: 10 };

describe("core/fire", () => {
  // Feature: yude-men-timer, Property 4: 一括ドレイン後、走行中は実効 endTime が now+ε より未来のみ・期限到来分は boiled として残る。
  it("Property 4: ドレイン後、走行中は実効 endTime が now+ε より未来のみ・期限到来分は boiled へ遷移し残る", () => {
    fc.assert(
      fc.property(genStateAndNow, ({ state, now }) => {
        const outcome = fireDueTimers(state, now, PARAMS);
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          const threshold = (now as number) + EPSILON_MS;
          // 発火は除去しない。件数は不変。
          expect(outcome.state.timers.length).toBe(state.timers.length);
          for (const t of outcome.state.timers) {
            // 実効値は fire 後の adjustment で評価する（残り running は settle で再同期され adjustment が変わりうる）。
            const effective = adjustedEndTime(t) as number;
            if (t.boiledAt === null) {
              // 走行中は実効 endTime が厳密に now+ε より未来（境界以下は走行中に残らない・要件2.10 / 3.3 / 4.4 / 7.6）。
              expect(effective > threshold).toBe(true);
            } else {
              // boiled は実効期限到来済み（実効 endTime ≤ now+ε）で、発火時刻は now。Adjustment は凍結される。
              expect(effective <= threshold).toBe(true);
              expect(t.boiledAt as number).toBe(now as number);
            }
          }
          // reconcile は fireDueTimers と同形（要件7.6 / 7.7）。
          expect(reconcile(state, now, PARAMS)).toEqual(outcome);
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: yude-men-timer, Property 5: fireDueTimers は冪等的に安定（at-least-once 多重発火への安定性）。
  // 同じ now で再適用すると新規 boiled は無く、再同期でも確定結果が変わらないため settle は Effect 空（Broadcast 0 件）を返す。
  it("Property 5: 同一 now の再適用で状態は不変、二度目の snapshot ブロードキャストは生じない", () => {
    fc.assert(
      fc.property(genStateAndNow, ({ state, now }) => {
        const first = fireDueTimers(state, now, PARAMS);
        expect(first.ok).toBe(true);
        if (first.ok) {
          const second = fireDueTimers(first.state, now, PARAMS);
          expect(second.ok).toBe(true);
          if (second.ok) {
            // 二度目の結果状態は一度目と等しい（settle の no-op は state: prev を返す＝多重発火に対して安定）。
            expect(second.state).toEqual(first.state);
            // 二度目は新規 boiled 無し＋再同期で確定結果不変ゆえ settle が Effect 空を返す（snapshot Broadcast を一切出さない）。
            const broadcasts = second.effects.filter((e) => e.type === "Broadcast");
            expect(broadcasts.length).toBe(0);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: yude-men-timer, Property 11: 茹で上がりは snapshot 単一表現で伝わる（意味論 boiled は撤去済み）。
  // 発火が確定変化を生むとき、Broadcast はちょうど 1 個の snapshot で、boiled になった Timer はすべてその
  // snapshot.timers に実効 endTime ≤ now+ε で載る（client が endTime から boiled をローカル導出できる・要件4.4）。
  it("Property 11: 発火の Broadcast は単一 snapshot で、boiled Timer は実効 endTime ≤ now+ε で載る", () => {
    fc.assert(
      fc.property(genStateAndNow, ({ state, now }) => {
        const outcome = fireDueTimers(state, now, PARAMS);
        expect(outcome.ok).toBe(true);
        if (outcome.ok) {
          // 今回の発火で新たに boiled へ遷移した Timer（boiledAt === now）。
          const newlyBoiled = outcome.state.timers.filter((t) => t.boiledAt === (now as number));
          // 新規 boiled が無ければ確定変化なし（no-op・Effect 空）。Property 5 が別途担保するのでここでは対象外。
          if (newlyBoiled.length === 0) return;
          // 確定変化時の Broadcast はちょうど 1 個で snapshot（単一表現・SSOT）。
          const broadcasts = outcome.effects.filter((e) => e.type === "Broadcast");
          expect(broadcasts.length).toBe(1);
          const message = broadcasts[0]!.message;
          expect(message.type).toBe("snapshot");
          if (message.type === "snapshot") {
            const threshold = (now as number) + EPSILON_MS;
            const wireById = new Map(message.timers.map((t) => [t.id, t]));
            for (const boiled of newlyBoiled) {
              // boiled は除去せず snapshot に残す（明示完了 Complete まで）。実効 endTime ≤ now+ε で載り、
              // client はこの endTime から boiled を導出する（意味論メッセージなしで一致する）。
              const wire = wireById.get(boiled.id as string);
              expect(wire).toBeDefined();
              expect((wire!.endTime as number) <= threshold).toBe(true);
            }
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});
