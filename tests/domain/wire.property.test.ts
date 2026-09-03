// tests/domain/wire.property.test.ts — verified-wire-contract の Property 2 / 3。
//
// **Validates: Requirements 2.6, 4.1, 4.2, 4.4**
//
// 往復（Property 2）は「契約の全種別が復号を通り、意味を失わない」ことを言う。全域性（Property 3）は
// 「どんな入力でも例外を送出せず、通った値は宣言型を満たす」ことを言う。二つで、関門が型について嘘を
// つかないことを実行時から押さえる（静的側は wire-no-cast.test.ts が担う）。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { toClientMessage, toServerMessage } from "../../src/domain/wire";
import { isNonEmpty } from "../../src/domain/timer";
import {
  genClientWireText,
  genServerWireText,
  genValidClientMessage,
  genValidServerMessage,
} from "./wireGenerators";

/** 復号後の値が宣言型の Cardinality_Guarantee を満たすか（型が保証を主張する全項目を実測で確かめる）。 */
function satisfiesCardinality(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const record = message as Record<string, unknown>;
  if (record.type === "start") return isNonEmpty(record.slotIds as readonly string[]);
  if (record.type === "snapshot") {
    const timers = record.timers as readonly { readonly slotIds: readonly string[] }[];
    const recommendations = record.recommendations as readonly {
      readonly slotIds: readonly string[];
    }[];
    return (
      timers.every((timer) => isNonEmpty(timer.slotIds)) &&
      recommendations.every((recommendation) => isNonEmpty(recommendation.slotIds))
    );
  }
  if (record.type === "config") {
    const presets = record.noodlePresets as readonly unknown[];
    const offsets = record.slotOffsets as readonly unknown[];
    return isNonEmpty(presets) && offsets.length === 6;
  }
  return true;
}

describe("Feature: verified-wire-contract, Property 2: 往復", () => {
  it("妥当な ServerMessage は直列化と復号で深く等価に戻る（3 種すべて）", () => {
    fc.assert(
      fc.property(genValidServerMessage, (message) => {
        expect(toServerMessage(JSON.stringify(message))).toEqual(message);
      }),
      { numRuns: 200 },
    );
  });

  it("妥当な ClientMessage は直列化と復号で深く等価に戻る（4 種すべて）", () => {
    fc.assert(
      fc.property(genValidClientMessage, (message) => {
        expect(toClientMessage(JSON.stringify(message))).toEqual(message);
      }),
      { numRuns: 200 },
    );
  });
});

describe("Feature: verified-wire-contract, Property 3: 全域性", () => {
  it("任意の Wire_Text に対し ServerMessage の関門は例外を送出せず、通った値は基数を満たす", () => {
    fc.assert(
      fc.property(genServerWireText, (text) => {
        const message = toServerMessage(text);
        if (message !== null) expect(satisfiesCardinality(message)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("任意の Wire_Text に対し ClientMessage の関門は例外を送出せず、通った値は基数を満たす", () => {
    fc.assert(
      fc.property(genClientWireText, (text) => {
        const message = toClientMessage(text);
        if (message !== null) expect(satisfiesCardinality(message)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
