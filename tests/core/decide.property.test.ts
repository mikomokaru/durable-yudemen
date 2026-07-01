// tests/core/decide.property.test.ts — Property 2（Persist 先頭）・Property 1（状態に残り秒なし）・Property 12（決定性）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide } from "../../src/engine/decide";
import type { Event } from "../../src/engine/event";
import type { TimerId } from "../../src/engine/types";
import type { TimerState } from "../../src/engine/state";
import type { SyncParams } from "../../src/engine/sync";
import { genNow, genState } from "./generators";

/** 固定の同期パラメータ（既定域内・arms=2 / toleranceRatio=10%）。decide は Start/Cancel/Complete を settle 経由で再同期する。 */
const PARAMS: SyncParams = { arms: 2, toleranceRatio: 10 };

/** 妥当寄りの Start イベント（ok:true を多く踏ませ、Effect 列の構造を検証可能にする）。 */
const genStartEvent: fc.Arbitrary<Event> = fc
  .record({
    slotIds: fc.array(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 3 }),
    noodleType: fc.string({ minLength: 1, maxLength: 6 }),
    boilSeconds: fc.integer({ min: 1, max: 1800 }),
    newTimerId: fc.string({ minLength: 1, maxLength: 8 }),
    now: genNow,
  })
  .map((r) => ({
    type: "Start",
    slotIds: r.slotIds,
    noodleType: r.noodleType,
    boilSeconds: r.boilSeconds,
    newTimerId: `nid-${r.newTimerId}` as TimerId,
    now: r.now,
  }));

/** 状態に応じたイベント生成器（Cancel は既存 id を多めに選び、ok:true を踏みやすくする）。 */
function genEventFor(state: TimerState): fc.Arbitrary<Event> {
  const existingId =
    state.timers.length > 0 ? fc.constantFrom(...state.timers.map((t) => t.id as string)) : fc.constant("absent");
  return fc.oneof(
    genStartEvent,
    genNow.map((now) => ({ type: "AlarmFired", now }) satisfies Event),
    genNow.map((now) => ({ type: "Reconcile", now }) satisfies Event),
    fc
      .record({ timerId: fc.oneof(existingId, fc.string()), now: genNow })
      .map((r) => ({ type: "Cancel", timerId: r.timerId, now: r.now }) satisfies Event),
  );
}

const genStateAndEvent: fc.Arbitrary<{ state: TimerState; event: Event }> = genState.chain((state) =>
  genEventFor(state).map((event) => ({ state, event })),
);

describe("core/decide", () => {
  // Feature: yude-men-timer, Property 2: Effect 列は常に Persist を先頭に持つ（SSOT 規律・要件7.7）。
  // Start / Cancel / Complete / Adjust は Running_Timer 集合を必ず変えるため、ok なら effects は非空で先頭
  // が Persist（Persist は唯一）。AlarmFired / Reconcile は「新規 boiled なし＋再同期で確定結果不変」の
  // とき put も broadcast もしない no-op ゆえ、ok かつ空 Effect を返しうる（要件7.7 の正しい表明）。空でない
  // ときは他の遷移と同じく Persist 先頭・唯一。
  it("Property 2: ok 成功時の effects は Persist 先頭・唯一（発火/整合の no-op は空 Effect を許す）", () => {
    fc.assert(
      fc.property(genStateAndEvent, ({ state, event }) => {
        const outcome = decide(state, event, PARAMS);
        if (outcome.ok) {
          const noopAllowed = event.type === "AlarmFired" || event.type === "Reconcile";
          // 確定結果が直前と変わらない発火/整合は空 Effect が正しい（put も broadcast もしない）。
          if (noopAllowed && outcome.effects.length === 0) return;
          expect(outcome.effects.length).toBeGreaterThanOrEqual(1);
          expect(outcome.effects[0]?.type).toBe("Persist");
          const persistCount = outcome.effects.filter((e) => e.type === "Persist").length;
          expect(persistCount).toBe(1);
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: yude-men-timer, Property 1: 状態は残り秒を持たない（導出値が状態に昇格していない）。
  // 任意のイベント列を decide で畳み込んだ後も、各 Timer は 0 以上の整数 endTime のみを持ち remaining を持たない。
  it("Property 1: 任意のイベント列適用後も状態は endTime のみ保持し、残り秒フィールドを持たない", () => {
    fc.assert(
      fc.property(genState, fc.array(genStartEvent, { maxLength: 30 }), (initial, events) => {
        let state = initial;
        for (const event of events) {
          const outcome = decide(state, event, PARAMS);
          if (outcome.ok) state = outcome.state;
        }
        for (const timer of state.timers) {
          // 状態が保持する事実は id/slotIds/noodleType/startTime/endTime/firmness/seq/boiledAt/adjustment のみ。remaining は存在しない（要件10.1）。
          // startTime/endTime は開始・終了の絶対時刻（事実）。firmness は茹で加減の共有事実。boiledAt は発火を記録した
          // engine 専用の事実（null=running・非null=boiled）。adjustment は同期のための engine 専用オフセット（初期値 0）。
          // いずれも残り秒・進捗の昇格ではない（それらは導出）。
          expect(Object.keys(timer).sort()).toEqual([
            "adjustment",
            "boiledAt",
            "endTime",
            "firmness",
            "id",
            "noodleType",
            "seq",
            "slotIds",
            "startTime",
          ]);
          expect("remaining" in timer).toBe(false);
          expect(typeof timer.endTime).toBe("number");
          expect(Number.isInteger(timer.endTime as number)).toBe(true);
          expect((timer.endTime as number) >= 0).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  // Feature: yude-men-timer, Property 12: decide は決定的（純粋性）。
  // 同じ (state, event) で decide を二度評価すると Outcome は完全に等しい。
  it("Property 12: decide は同じ入力に同じ Outcome を返す（決定的）", () => {
    fc.assert(
      fc.property(genStateAndEvent, ({ state, event }) => {
        const first = decide(state, event, PARAMS);
        const second = decide(state, event, PARAMS);
        expect(first).toEqual(second);
      }),
      { numRuns: 300 },
    );
  });
});
