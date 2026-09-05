// tests/client/slotDisplay.property.test.ts — 担当範囲の射影と提案の載せ方（lift-group-display Property 6）。
//
// **Validates: Requirements 6.6, 6.2, 1.6, 2.12**
//
// 群・開始・連鎖・全釜 idle は店舗全体で判定し（liftGroups.property が担う）、担当範囲で絞るのは表示
// （assignedSlotDisplays）だけである。ここで問うのはその絞り方——表示できる群のどの品目も担当外の釜にあれば
// 端末は空白であること（担当外の空白）と、担当範囲の取り方が釜の提案を変えないこと（units A と B で共通する
// 釜の idle の next が一致する）。後者は「liftGroups が担当範囲を引数に取らない」という静的な事実の動的な側で、
// 端末間の一致を単端末の可読性より上に置いた判断 8 を固定する。
//
// 時刻はすべて生成器が引数値として吐き、Date.now のスタブは用いない。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ClientView } from "../../src/client/connection";
import { assignedSlotDisplays } from "../../src/client/components/slotDisplay";
import {
  liftGroups,
  slotSuggestions,
  visibleGroups,
  type SlotSuggestion,
} from "../../src/client/components/liftGroups";
import { slotsOfUnits } from "../../src/client/assignment";
import { SLOTS_PER_UNIT, slotOf } from "../../src/domain/store";
import { genLiftScene } from "./generators";

const NUM_RUNS = 300;

/** SlotBoard と同じ順で釜ごとの提案を導く（群 → 表示できる群 → 釜ごと）。 */
function suggestionsOf(
  view: ClientView,
  corrected: number,
): ReadonlyMap<number, readonly SlotSuggestion[]> {
  return slotSuggestions(visibleGroups(liftGroups(view, corrected)), view, corrected);
}

/** 表示できる群の全品目が指す釜のユニット。 */
function unitsTouched(view: ClientView, corrected: number): ReadonlySet<number> {
  return new Set(
    visibleGroups(liftGroups(view, corrected)).flatMap((group) =>
      group.items.flatMap((item) =>
        item.suggestion.slotIds.map((slotId) => Math.floor(slotOf(slotId) / SLOTS_PER_UNIT)),
      ),
    ),
  );
}

/** 担当ユニットの部分集合（空も含む）。 */
function genUnits(view: ClientView): fc.Arbitrary<readonly number[]> {
  return fc.subarray(Array.from({ length: view.unitCount }, (_, unit) => unit));
}

describe("Feature: lift-group-display, Property 6: 担当外の空白", () => {
  it("表示できる群のどの品目も担当外の釜にあれば、idle の next はすべて空である", () => {
    fc.assert(
      // Feature: lift-group-display, Property 6
      // Validates: Requirements 6.6, 2.12
      fc.property(genLiftScene, ({ view, corrected }) => {
        // 担当は、表示できる群が触れないユニットに限る。全ユニットが触れられていれば場面は成立しない。
        const touched = unitsTouched(view, corrected);
        const units = Array.from({ length: view.unitCount }, (_, unit) => unit).filter(
          (unit) => !touched.has(unit),
        );
        fc.pre(units.length > 0);
        // 対照：店舗全体では提案が出ている（空白が「そもそも提案が無い」ことの帰結でないと言うため）。
        const bySlot = suggestionsOf(view, corrected);
        fc.pre(bySlot.size > 0);
        // now は補正後現在時刻から逆算する（assignedSlotDisplays は生の時刻と offset を受ける）。
        const now = corrected - view.offset;
        for (const display of assignedSlotDisplays(view, units, now, bySlot)) {
          if (display.kind === "idle") expect(display.next).toEqual([]);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Feature: lift-group-display, Property 2（表示の側）: 担当範囲の取り方は釜の提案を変えない", () => {
  it("units A と units B で共通する釜の idle の next は一致し、担当範囲の釜以外は現れない", () => {
    fc.assert(
      // Feature: lift-group-display, Property 2
      // Validates: Requirements 6.2, 1.6
      fc.property(
        genLiftScene.chain(({ view, corrected }) =>
          fc.record({
            view: fc.constant(view),
            corrected: fc.constant(corrected),
            unitsA: genUnits(view),
            unitsB: genUnits(view),
          }),
        ),
        ({ view, corrected, unitsA, unitsB }) => {
          const bySlot = suggestionsOf(view, corrected);
          const now = corrected - view.offset;
          const displaysA = assignedSlotDisplays(view, unitsA, now, bySlot);
          const displaysB = assignedSlotDisplays(view, unitsB, now, bySlot);
          // 射影は担当範囲の釜をちょうど昇順に並べる（担当外は構造的に現れない）。
          expect(displaysA.map((display) => display.slot)).toEqual(
            [...slotsOfUnits(unitsA)].sort((a, b) => a - b),
          );
          for (const a of displaysA) {
            const b = displaysB.find((candidate) => candidate.slot === a.slot);
            if (b === undefined) continue; // A にだけ在る釜
            expect(b).toEqual(a);
            // idle の next は店舗全体の導出そのもの（担当範囲で選び直さない）。
            if (a.kind === "idle") expect(a.next).toEqual(bySlot.get(a.slot) ?? []);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
