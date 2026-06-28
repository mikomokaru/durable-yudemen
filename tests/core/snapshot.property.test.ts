// tests/core/snapshot.property.test.ts — Property 9（snapshot ラウンドトリップ）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fromSnapshot, toSnapshot } from "../../src/engine/snapshot";
import { CURRENT_SCHEMA_VERSION } from "../../src/engine/types";
import { genState } from "./generators";

describe("core/snapshot", () => {
  // Feature: yude-men-timer, Property 9: snapshot ラウンドトリップは状態を保存する。
  // 任意の TimerState で fromSnapshot(toSnapshot(state)) === state、出力は常に version = 1、空状態も往復保存。
  it("Property 9: fromSnapshot(toSnapshot(state)) は元の状態を保存し、version は常に 1", () => {
    fc.assert(
      fc.property(genState, (state) => {
        const snapshot = toSnapshot(state);
        // version は常に現行スキーマバージョン（= 1）を名乗る（要件11.1）。
        expect(snapshot.version).toBe(CURRENT_SCHEMA_VERSION);
        // 往復で timers の各フィールドと nextSeq が完全に保存される（空状態も含む・要件8.3 / 8.7）。
        expect(fromSnapshot(snapshot)).toEqual(state);
      }),
      { numRuns: 200 },
    );
  });
});
