// tests/client/liftGroups.property.test.ts — 群の導出・連鎖・先頭・釜ごとの提案の性質（lift-group-display）。
//
// **Validates: Requirements 1.10, 6.1, 6.2, 6.3, 6.5, 6.8, 6.9, 6.10, 6.11**
//
// 群も先頭も提案も状態ではない。snapshot（推奨・待ち行列・Timer の全量）と補正後現在時刻からの導出値であり、
// ビューに保持しない。ここで問うのは導出の性質——群の等号・端末に依らない一意・時間に対する単調性・群の境界・
// 全釜 idle・先頭の一意・開始の事実・degraded の沈黙——である。
//
// 「提案は idle にしか現れない」「member にボタンが無い」は型で真になる（PBT で検査する内容が無い）。描画の
// 見え方は slot-card の example が担う。時刻はすべて生成器が引数値として吐き、Date.now のスタブは用いない。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ClientView } from "../../src/client/connection";
import {
  headOf,
  liftGroups,
  slotSuggestions,
  visibleGroups,
  type GroupItem,
  type LiftGroup,
  type SlotSuggestion,
} from "../../src/client/components/liftGroups";
import { slotOf } from "../../src/domain/store";
import { genConnectivity, genLiftScene, genUnreachableReason } from "./generators";

const NUM_RUNS = 300;

/** 品目の鍵。群の品目と釜の提案を突き合わせる（参照ではなく鍵で比べ、別の導出どうしを比較できるようにする）。 */
function keyOf(item: GroupItem): string {
  return `${item.order.externalOrderId}#${item.order.itemIndex}`;
}

/** 釜ごとの提案を平らにする（釜番号つき）。 */
function flatten(
  bySlot: ReadonlyMap<number, readonly SlotSuggestion[]>,
): readonly { readonly slot: number; readonly suggestion: SlotSuggestion }[] {
  return [...bySlot.entries()].flatMap(([slot, list]) =>
    list.map((suggestion) => ({ slot, suggestion })),
  );
}

/** 店舗全体で Timer が駆動する釜（running / boiled とも）。 */
function occupiedOf(view: ClientView): ReadonlySet<number> {
  return new Set(view.timers.flatMap((timer) => timer.slotIds.map(slotOf)));
}

/** 品目が属する群を鍵で引く。 */
function groupOf(groups: readonly LiftGroup[], item: GroupItem): LiftGroup {
  const found = groups.find((group) => group.items.some((member) => keyOf(member) === keyOf(item)));
  if (found === undefined) throw new Error(`群に無い品目: ${keyOf(item)}`);
  return found;
}

/** 配列の並べ替え（同じ要素の別順）。 */
function permutationOf<T>(values: readonly T[]): fc.Arbitrary<readonly T[]> {
  return fc.shuffledSubarray([...values], { minLength: values.length, maxLength: values.length });
}

describe("Feature: lift-group-display, Property 1: 群の等号（片方向）", () => {
  it("同じ群の任意の 2 品目は卓が同じで serveAt が等しく、serveAt は startAt + 茹で秒の再計算である", () => {
    fc.assert(
      // Feature: lift-group-display, Property 1
      // Validates: Requirements 6.1, 1.1, 1.2, 1.3
      fc.property(genLiftScene, ({ view, corrected }) => {
        for (const group of liftGroups(view, corrected)) {
          for (const item of group.items) {
            expect(item.order.tableId).toBe(group.tableId);
            expect(item.suggestion.serveAt).toBe(group.serveAt);
            // 等号の左辺は茹で秒の再計算（プリセット × 茹で加減）。引けない品目は群に入っていない。
            // 照合はプリセットから直に引く——導出側の関数を照合に使えば、同じ誤りを両辺に写して等式が空になる。
            const preset = view.noodlePresets.find((p) => p.noodleType === item.order.noodleType);
            expect(preset).toBeDefined();
            const boilSeconds = preset!.boilSeconds[item.order.firmness];
            expect(item.suggestion.serveAt).toBe(item.suggestion.startAt + boilSeconds * 1000);
            expect(view.pendingOrders).toContain(item.order);
          }
          // 卓なしは 1 品 1 群（同じ鍵の品目しか含まない）。
          if (group.tableId === null) {
            expect(new Set(group.items.map(keyOf)).size).toBe(1);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Feature: lift-group-display, Property 2: 一意（担当範囲・端末に依らない）", () => {
  it("全量の並べ替えと端末ローカルの項目の変更に対して、群・表示できる群・先頭は構造的に等しい", () => {
    fc.assert(
      // Feature: lift-group-display, Property 2
      // Validates: Requirements 6.2, 1.6, 1.10
      fc.property(
        genLiftScene.chain(({ view, corrected }) =>
          fc.record({
            view: fc.constant(view),
            corrected: fc.constant(corrected),
            timers: permutationOf(view.timers),
            recommendations: permutationOf(view.recommendations),
            pendingOrders: permutationOf(view.pendingOrders),
            connectivity: genConnectivity,
            unreachableReason: genUnreachableReason,
            sync: fc.constantFrom<ClientView["sync"]>("connecting", "synced", "syncFailed"),
            processedIds: fc.uniqueArray(fc.string({ maxLength: 4 })).map((ids) => new Set(ids)),
            error: fc.option(fc.record({ code: fc.string(), message: fc.string() }), { nil: null }),
            offset: fc.integer({ min: -100_000, max: 100_000 }),
            lastResults: fc.constant(new Map([["0", { noodleType: "Thin", at: 0 }]])),
          }),
        ),
        ({ view, corrected, ...local }) => {
          const other: ClientView = { ...view, ...local };
          const groups = liftGroups(view, corrected);
          const otherGroups = liftGroups(other, corrected);
          expect(otherGroups).toEqual(groups);
          expect(visibleGroups(otherGroups)).toEqual(visibleGroups(groups));
          expect(otherGroups.map(headOf)).toEqual(groups.map(headOf));
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Feature: lift-group-display, Property 3: 単調な出現（例外つき）", () => {
  it("同じ snapshot で時刻を進めても、同卓の仲間の endTime を跨がない限り提案は消えず薄→濃だけである", () => {
    fc.assert(
      // Feature: lift-group-display, Property 3
      // Validates: Requirements 6.3
      fc.property(
        genLiftScene,
        fc.integer({ min: 0, max: 600_000 }),
        ({ view, corrected }, delta) => {
          const before = visibleGroups(liftGroups(view, corrected));
          // 分割点は「可視の群の serveAt に等しい endTime を持つ同卓の走行中 Timer」の endTime だけ。
          // 他卓・endTime 不一致・orderItem: null の Timer の endTime は分割点にならない（跨いでも破れない）。
          const splits = view.timers
            .filter((timer) =>
              before.some(
                (group) =>
                  group.tableId !== null &&
                  timer.orderItem?.tableId === group.tableId &&
                  timer.endTime === group.serveAt,
              ),
            )
            .map((timer) => timer.endTime)
            .filter((endTime) => endTime > corrected);
          // 次の分割点の手前までしか進めない（跨げば例外の場面になる）。
          const later = Math.min(corrected + delta, ...splits.map((split) => split - 1));

          const earlier = flatten(slotSuggestions(before, view, corrected));
          const after = flatten(
            slotSuggestions(visibleGroups(liftGroups(view, later)), view, later),
          );
          for (const { slot, suggestion } of earlier) {
            const survivor = after.find(
              (candidate) =>
                candidate.slot === slot &&
                keyOf(candidate.suggestion.item) === keyOf(suggestion.item),
            );
            expect(survivor).toBeDefined();
            expect(survivor!.suggestion.role).toBe(suggestion.role);
            if (suggestion.role === "head" && survivor!.suggestion.role === "head") {
              // 濃から薄へ戻らない。
              if (suggestion.phase === "solid") expect(survivor!.suggestion.phase).toBe("solid");
            }
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("例外：同卓の仲間の endTime を跨ぐと、その群は started でなくなり後続の群の提案は消える", () => {
    fc.assert(
      // Feature: lift-group-display, Property 3（例外の側）
      // Validates: Requirements 6.3, 1.7
      fc.property(genLiftScene, ({ view, corrected }) => {
        const groups = liftGroups(view, corrected);
        const visible = visibleGroups(groups);
        // 可視の群のうち started のものの、走行中の仲間の endTime（最小のもの）を跨ぐ。
        const split = Math.min(
          ...view.timers
            .filter(
              (timer) =>
                timer.endTime > corrected &&
                visible.some(
                  (group) =>
                    group.started &&
                    timer.orderItem?.tableId === group.tableId &&
                    timer.endTime === group.serveAt,
                ),
            )
            .map((timer) => timer.endTime),
        );
        fc.pre(Number.isFinite(split));
        const afterGroups = liftGroups(view, split);
        // 跨いだ時刻で、その仲間が始めていた群はもう started でない（endTime ≤ corrected は数えない）。
        for (const group of visible) {
          if (!group.started || group.serveAt !== split) continue;
          const same = afterGroups.find(
            (candidate) => candidate.tableId === group.tableId && candidate.serveAt === split,
          );
          expect(same?.started).toBe(false);
        }
        // 表示できる群は、跨ぐ前の連鎖の接頭辞に縮む（並びは時刻に依らない）。
        const afterVisible = visibleGroups(afterGroups);
        expect(afterVisible.length).toBeLessThanOrEqual(visible.length);
        afterVisible.forEach((group, index) => {
          expect(group.items.map(keyOf)).toEqual(visible[index]!.items.map(keyOf));
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Feature: lift-group-display, Property 5: 群の境界", () => {
  it("ある群より前に started でない群があれば、その群の品目はどの釜にも現れない", () => {
    fc.assert(
      // Feature: lift-group-display, Property 5
      // Validates: Requirements 6.5, 2.9
      fc.property(genLiftScene, ({ view, corrected }) => {
        const groups = liftGroups(view, corrected);
        const shown = new Set(
          flatten(slotSuggestions(visibleGroups(groups), view, corrected)).map(({ suggestion }) =>
            keyOf(suggestion.item),
          ),
        );
        const firstStop = groups.findIndex((group) => !group.started);
        if (firstStop === -1) return;
        for (const group of groups.slice(firstStop + 1)) {
          for (const item of group.items) expect(shown.has(keyOf(item))).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Feature: lift-group-display, Property 8: 全釜 idle", () => {
  it("現れた提案の slotIds は店舗全体の占有（running / boiled とも）と交わらず、含まれる各釜に同じ提案が出る", () => {
    fc.assert(
      // Feature: lift-group-display, Property 8
      // Validates: Requirements 6.8, 2.7, 2.14
      fc.property(genLiftScene, ({ view, corrected }) => {
        const occupied = occupiedOf(view);
        const bySlot = slotSuggestions(visibleGroups(liftGroups(view, corrected)), view, corrected);
        for (const { slot, suggestion } of flatten(bySlot)) {
          const slots = suggestion.item.suggestion.slotIds.map(slotOf);
          expect(slots).toContain(slot);
          for (const member of slots) {
            expect(occupied.has(member)).toBe(false);
            expect(bySlot.get(member)).toContain(suggestion);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Feature: lift-group-display, Property 9: 先頭の一意", () => {
  it("head の品目は群の startAt 最小のものだけで、全品の startAt を過ぎても変わらない", () => {
    fc.assert(
      // Feature: lift-group-display, Property 9
      // Validates: Requirements 6.9, 1.9, 2.4
      fc.property(genLiftScene, ({ view, corrected }) => {
        const groups = liftGroups(view, corrected);
        for (const group of groups) {
          const earliest = Math.min(...group.items.map((item) => item.suggestion.startAt));
          expect(headOf(group).map(keyOf).sort()).toEqual(
            group.items
              .filter((item) => item.suggestion.startAt === earliest)
              .map(keyOf)
              .sort(),
          );
        }
        // 放置して全品の startAt が過ぎた時刻でも、先頭の集合は同じ（先頭は時刻の関数でない）。
        const lapsed = Math.max(corrected, ...view.recommendations.map((r) => r.startAt)) + 1;
        const lapsedGroups = liftGroups(view, lapsed);
        for (const time of [corrected, lapsed]) {
          const current = time === corrected ? groups : lapsedGroups;
          for (const { suggestion } of flatten(
            slotSuggestions(visibleGroups(current), view, time),
          )) {
            const heads = headOf(groupOf(current, suggestion.item)).map(keyOf);
            expect(heads.includes(keyOf(suggestion.item))).toBe(suggestion.role === "head");
          }
        }
        expect(lapsedGroups.map((group) => headOf(group).map(keyOf))).toEqual(
          groups.map((group) => headOf(group).map(keyOf)),
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Feature: lift-group-display, Property 10: 開始の事実の一意", () => {
  it("started は同卓の走行中 Timer の endTime と群の serveAt の等号だけで決まり、同じ卓の後の batch は偽", () => {
    fc.assert(
      // Feature: lift-group-display, Property 10
      // Validates: Requirements 6.10, 1.7
      fc.property(genLiftScene, ({ view, corrected }) => {
        const groups = liftGroups(view, corrected);
        for (const group of groups) {
          const mates = view.timers.filter(
            (timer) =>
              group.tableId !== null &&
              timer.orderItem?.tableId === group.tableId &&
              timer.endTime === group.serveAt,
          );
          // 卓の一致だけ・endTime の一致だけでは真にならず、boiled（endTime ≤ corrected）は数えない。
          expect(group.started).toBe(mates.some((timer) => timer.endTime > corrected));
          if (group.tableId === null) expect(group.started).toBe(false);
        }
        // 同じ卓の別の batch（serveAt が違う群）は、自身の仲間が無ければ started でない。
        for (const group of groups) {
          if (!group.started) continue;
          for (const sibling of groups) {
            if (sibling.tableId !== group.tableId || sibling.serveAt === group.serveAt) continue;
            const own = view.timers.some(
              (timer) =>
                timer.orderItem?.tableId === sibling.tableId &&
                timer.endTime === sibling.serveAt &&
                timer.endTime > corrected,
            );
            if (!own) expect(sibling.started).toBe(false);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Feature: lift-group-display, Property 11: 非 live の沈黙", () => {
  it("degraded では釜ごとの提案が空である（群は導けても、押しても送られない提案を出さない）", () => {
    fc.assert(
      // Feature: lift-group-display, Property 11
      // Validates: Requirements 6.11, 2.13
      fc.property(genLiftScene, genUnreachableReason, ({ view, corrected }, unreachableReason) => {
        const visible = visibleGroups(liftGroups(view, corrected));
        // 対照：live で提案が出る場面に限る。degraded の空が「そもそも提案が無い」ことの帰結でないと言うため。
        fc.pre(slotSuggestions(visible, view, corrected).size > 0);
        const degraded: ClientView = { ...view, connectivity: "down", unreachableReason };
        expect(slotSuggestions(visible, degraded, corrected).size).toBe(0);
        expect(
          slotSuggestions(visibleGroups(liftGroups(degraded, corrected)), degraded, corrected).size,
        ).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
