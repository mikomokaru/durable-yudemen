// tests/core/alarm.property.test.ts — Property 3（単一 Alarm の正しさ：残存最早に一致／残存ゼロで ClearAlarm）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { nextAlarmEffect } from "../../src/engine/alarm";
import { genTimers } from "./generators";

describe("core/alarm", () => {
  // Feature: yude-men-timer, Property 3: Alarm は常に残存最早に一致するか、残存ゼロなら ClearAlarm。
  // 任意の Timer 集合で、空でなければ最早 endTime の SetAlarm、空なら ClearAlarm を返す。
  it("Property 3: nextAlarmEffect は残存最早の SetAlarm か、残存ゼロで ClearAlarm を返す", () => {
    fc.assert(
      fc.property(genTimers, (timers) => {
        const effect = nextAlarmEffect(timers);
        if (timers.length === 0) {
          // 残存ゼロは ClearAlarm（要件3.4 / 6.4 / 7.7）。
          expect(effect).toEqual({ type: "ClearAlarm" });
        } else {
          // SetAlarm の at は残存の最早 endTime に一致する（同一 endTime は seq 最小だが at は同値）。
          const earliest = Math.min(...timers.map((t) => t.endTime as number));
          expect(effect).toEqual({ type: "SetAlarm", at: earliest });
        }
      }),
      { numRuns: 200 },
    );
  });
});
