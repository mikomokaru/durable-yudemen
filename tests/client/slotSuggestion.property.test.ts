// tests/client/slotSuggestion.property.test.ts — 提案の導出（slot-suggested-start Property 1 / 2 / 6）。
//
// **Validates: Requirements 1.1, 1.2, 1.6, 2.12**
//
// 提案は状態ではない。受信済みの推奨・待ち行列・プリセット・補正済み現在時刻からの導出値であり、
// ビューに保持しない。ここで問うのは導出の 3 つの性質——選び方（最小 startAt）・純粋性（同じ入力から
// 同じ結果）・degraded での不在——である。
//
// 「提案は idle にしか現れない」は性質として書かない。`next` を持つのは `SlotDisplay` の idle 相の型だけで
// あり、型で真になる（PBT で検査する内容が無い）。running / boiled に何も足さないことは要件 7.5 の担当で、
// 実描画テストが見る。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EMPTY_VIEW, type ClientView } from "../../src/client/connection";
import { orderQueueEntries } from "../../src/client/components/queueDisplay";
import { assignedSlotDisplays } from "../../src/client/components/slotDisplay";
import { slotOf } from "../../src/domain/store";
import type { PendingOrder } from "../../src/domain/order";
import type { CookRecommendation } from "../../src/domain/messages";
import { nonEmpty } from "../nonEmpty";

const NOW = 1_700_000_000_000;
/** 担当ユニット 1 台（= 6 釜）。釜の数そのものは主張に関与しない。 */
const UNITS = [0] as const;
/** DEFAULT_NOODLE_PRESETS が持つ麺種（茹で秒が引ける＝提案が成立する条件）。 */
const NOODLE = "Thin";

const genSlot = fc.integer({ min: 0, max: 5 });

/** 待ち行列の 1 品目。提案が成立する麺種に固定する（成立しない場合の検査は example が担う）。 */
const genOrder: fc.Arbitrary<PendingOrder> = fc
  .tuple(fc.string({ minLength: 1, maxLength: 6 }), fc.nat({ max: 3 }))
  .map(([externalOrderId, itemIndex]) => ({
    externalOrderId,
    itemIndex,
    noodleType: NOODLE,
    firmness: "normal" as const,
    tableId: null,
    arrivalTime: NOW - 60_000,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
  }));

/** ある品目への推奨 1 件。釜集合と startAt を振る。 */
function recommendationFor(
  order: PendingOrder,
  slots: readonly number[],
  startAt: number,
): CookRecommendation {
  return {
    externalOrderId: order.externalOrderId,
    itemIndex: order.itemIndex,
    slotIds: nonEmpty(slots.map((slot) => String(slot))),
    startAt,
    group: "g",
    anchor: null,
  };
}

/** 同期済みのビュー（待ち行列と推奨だけを差し替える）。 */
function syncedView(
  pendingOrders: readonly PendingOrder[],
  recommendations: readonly CookRecommendation[],
): ClientView {
  return { ...EMPTY_VIEW, sync: "synced", connectivity: "up", pendingOrders, recommendations };
}

/** idle の釜の next を引く（担当範囲の全件から当該釜のものを取る）。 */
function nextOf(view: ClientView, slot: number) {
  const entries = orderQueueEntries(view, UNITS, NOW);
  const display = assignedSlotDisplays(view, UNITS, NOW, entries).find(
    (candidate) => candidate.slot === slot,
  );
  return display !== undefined && display.kind === "idle" ? display.next : undefined;
}

describe("Feature: slot-suggested-start, Property 1: 提案は当該釜の最小 startAt", () => {
  it("同じ釜に複数の推奨があれば startAt 最小の 1 件が next になる", () => {
    fc.assert(
      fc.property(
        genSlot,
        fc.uniqueArray(fc.integer({ min: NOW - 300_000, max: NOW + 300_000 }), {
          minLength: 2,
          maxLength: 5,
        }),
        (slot, startAts) => {
          // 品目は推奨 1 件ごとに別で用意する（同一品目への複数推奨は待ち行列側で 1 件へ畳まれる）。
          const orders = startAts.map((_unused, index) => ({
            externalOrderId: `o-${index}`,
            itemIndex: 0,
            noodleType: NOODLE,
            firmness: "normal" as const,
            tableId: null,
            arrivalTime: NOW - 60_000,
            slotSpan: 1,
            itemName: null,
            sizeName: null,
          }));
          const view = syncedView(
            orders,
            orders.map((order, index) => recommendationFor(order, [slot], startAts[index]!)),
          );
          expect(nextOf(view, slot)?.startAt).toBe(Math.min(...startAts));
        },
      ),
      { numRuns: 200 },
    );
  });

  it("推奨が含まない釜の next は null（担当内でも当該釜が対象でなければ出さない）", () => {
    fc.assert(
      fc.property(genOrder, genSlot, genSlot, (order, target, other) => {
        fc.pre(target !== other);
        const view = syncedView([order], [recommendationFor(order, [target], NOW)]);
        expect(nextOf(view, other)).toBeNull();
      }),
      { numRuns: 200 },
    );
  });

  it("複数釜にまたがる推奨は含まれる各釜に同じ提案として現れる（要件 1.5）", () => {
    fc.assert(
      fc.property(
        genOrder,
        fc.uniqueArray(genSlot, { minLength: 2, maxLength: 4 }),
        (order, slots) => {
          const view = syncedView([order], [recommendationFor(order, slots, NOW)]);
          const seen = slots.map((slot) => nextOf(view, slot));
          for (const suggestion of seen) expect(suggestion).not.toBeNull();
          // 同じ 1 件が各釜に出る（釜ごとに別物を作らない）。
          for (const suggestion of seen) expect(suggestion).toEqual(seen[0]);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("Feature: slot-suggested-start, Property 2: 提案は状態に昇格しない", () => {
  it("同じビュー・担当・時刻から二度導出すれば深く等価である", () => {
    fc.assert(
      fc.property(genOrder, genSlot, (order, slot) => {
        const view = syncedView([order], [recommendationFor(order, [slot], NOW)]);
        const entries = orderQueueEntries(view, UNITS, NOW);
        expect(assignedSlotDisplays(view, UNITS, NOW, entries)).toEqual(
          assignedSlotDisplays(view, UNITS, NOW, entries),
        );
      }),
      { numRuns: 200 },
    );
  });

  it("推奨の集合が同じなら釜の並び順に依らず同じ next になる", () => {
    fc.assert(
      fc.property(genOrder, genSlot, (order, slot) => {
        const forward = recommendationFor(order, [slot], NOW);
        const reversed = { ...forward, slotIds: nonEmpty([...forward.slotIds].reverse()) };
        expect(nextOf(syncedView([order], [forward]), slot)?.startAt).toBe(
          nextOf(syncedView([order], [reversed]), slot)?.startAt,
        );
      }),
      { numRuns: 100 },
    );
  });
});

describe("Feature: slot-suggested-start, Property 6: degraded では提案が出ない", () => {
  it("到達不能なビューでは全 idle 釜の next が null になる", () => {
    fc.assert(
      fc.property(
        genOrder,
        genSlot,
        fc.constantFrom<ClientView["unreachableReason"]>("offline", "noAccess", "signInRequired"),
        (order, slot, unreachableReason) => {
          const live = syncedView([order], [recommendationFor(order, [slot], NOW)]);
          // 到達性が落ちれば Mode は degraded になる（判定は connection.mode ただ一つ）。
          const degraded: ClientView = { ...live, connectivity: "down", unreachableReason };
          const entries = orderQueueEntries(degraded, UNITS, NOW);
          for (const display of assignedSlotDisplays(degraded, UNITS, NOW, entries)) {
            if (display.kind === "idle") expect(display.next).toBeNull();
          }
          // 対照：live では出る。degraded の不在が「そもそも提案が無い」ことの帰結でないことを示す。
          expect(nextOf(live, slot)).not.toBeNull();
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("Feature: slot-suggested-start — 導出は担当範囲の絞り込みを再実装しない", () => {
  it("next の slotIds は必ず当該釜を含む", () => {
    fc.assert(
      fc.property(genOrder, genSlot, (order, slot) => {
        const view = syncedView([order], [recommendationFor(order, [slot], NOW)]);
        const next = nextOf(view, slot);
        expect(next).not.toBeNull();
        expect(next!.slotIds.some((slotId) => slotOf(slotId) === slot)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
