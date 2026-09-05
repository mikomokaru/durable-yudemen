// tests/client/liftGroups.property.test.ts — 群の導出・連鎖・先頭・釜ごとの提案の性質（lift-group-display）。
//
// **Validates: Requirements 1.10, 6.1, 6.2, 6.3, 6.5, 6.8, 6.9, 6.10, 6.11**
//
// 群も先頭も提案も状態ではない。snapshot（推奨・待ち行列・Timer の全量）と補正後現在時刻からの導出値であり、
// ビューに保持しない。ここで問うのは導出の性質——群の所属（`group` だけで束ねる）・端末に依らない一意・時間に
// 対する単調性（分割点は `anchor` と、濃くなる点の `startAt`）・群の境界・全釜 idle・先頭の上限（店舗全体で
// `arms` 本・判断 21）・開始の事実（`anchor` と Corrected_Now だけ）・degraded の沈黙——である。
//
// 「提案は idle にしか現れない」「member にボタンが無い」は型で真になる（PBT で検査する内容が無い）。描画の
// 見え方は slot-card の example が担う。時刻はすべて生成器が引数値として吐き、Date.now のスタブは用いない。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ClientView } from "../../src/client/connection";
import {
  liftGroups,
  slotSuggestions,
  visibleGroups,
  type GroupItem,
  type LiftGroup,
  type SlotSuggestion,
} from "../../src/client/components/liftGroups";
import { suggestedItemOf } from "../../src/client/components/queueDisplay";
import { PREP_LEAD_MS, type CookRecommendation } from "../../src/domain/messages";
import { slotOf } from "../../src/domain/store";
import { genConnectivity, genLiftScene, genUnreachableReason } from "./generators";

const NUM_RUNS = 300;

/** 品目の鍵。群の品目と釜の提案を突き合わせる（参照ではなく鍵で比べ、別の導出どうしを比較できるようにする）。 */
function keyOf(item: GroupItem): string {
  return `${item.order.externalOrderId}#${item.order.itemIndex}`;
}

/** 推奨の鍵（品目の鍵と同じ形）。 */
function recommendationKeyOf(recommendation: CookRecommendation): string {
  return `${recommendation.externalOrderId}#${recommendation.itemIndex}`;
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

/**
 * 品目の鍵ごとの役（head / member）。同じ品目は含まれる全釜で同じ役である（1 件の推奨は各釜に同じ提案・AC 2.14）
 * ——釜ごとに役が割れていれば、ここで落ちる。
 */
function rolesOf(
  bySlot: ReadonlyMap<number, readonly SlotSuggestion[]>,
): ReadonlyMap<string, SlotSuggestion["role"]> {
  const roles = new Map<string, SlotSuggestion["role"]>();
  for (const { suggestion } of flatten(bySlot)) {
    const key = keyOf(suggestion.item);
    const seen = roles.get(key);
    if (seen !== undefined) expect(seen).toBe(suggestion.role);
    roles.set(key, suggestion.role);
  }
  return roles;
}

/**
 * 先頭の期待値——表示できる群の品目を（群の順, 品目の順）に並べ、全釜 idle と Prep_Lead を満たし、かつ
 * `startAt ≤ corrected` のものの先頭 `arms` 本（AC 1.9・判断 21）。導出側の `slotSuggestions` を照合に使わず、
 * 群の並びと占有から直に組む（同じ関数を両辺に置けば等式が空になる）。
 */
function expectedHeads(
  visible: readonly LiftGroup[],
  view: ClientView,
  corrected: number,
): readonly string[] {
  const occupied = occupiedOf(view);
  // 先頭は開始推奨時刻の順（同値は群の順・品目の順）で数える（判断 21）。群の順で数えると、同じ snapshot で
  // 時刻が進んだだけで前の群の後の品目が後の群の先頭を押しのける。
  return visible
    .flatMap((group) => group.items)
    .map((item, order) => ({ item, order }))
    .filter(
      ({ item }) =>
        !item.suggestion.slotIds.some((slotId) => occupied.has(slotOf(slotId))) &&
        corrected >= item.suggestion.startAt - PREP_LEAD_MS &&
        corrected >= item.suggestion.startAt,
    )
    .sort((a, b) => a.item.suggestion.startAt - b.item.suggestion.startAt || a.order - b.order)
    .slice(0, view.arms)
    .map(({ item }) => keyOf(item));
}

/** 群の形（識別子を除く）——anchor・品目の鍵の列・started。群の付け替えの前後で比べる。 */
function shapeOf(group: LiftGroup) {
  return { anchor: group.anchor, items: group.items.map(keyOf), started: group.started };
}

/** 配列の並べ替え（同じ要素の別順）。 */
function permutationOf<T>(values: readonly T[]): fc.Arbitrary<readonly T[]> {
  return fc.shuffledSubarray([...values], { minLength: values.length, maxLength: values.length });
}

describe("Feature: lift-group-display, Property 1: 群の所属", () => {
  it("同じ群の任意の 2 品目は推奨の group が等しく、群の anchor はその推奨の anchor で、serveAt は startAt + 茹で秒の再計算である", () => {
    fc.assert(
      // Feature: lift-group-display, Property 1
      // Validates: Requirements 6.1, 1.1, 1.2, 1.3
      fc.property(genLiftScene, ({ view, corrected }) => {
        const groups = liftGroups(view, corrected);
        for (const group of groups) {
          for (const item of group.items) {
            const recommendation = view.recommendations.find(
              (candidate) => recommendationKeyOf(candidate) === keyOf(item),
            );
            expect(recommendation).toBeDefined();
            expect(recommendation!.group).toBe(group.group);
            expect(recommendation!.anchor).toBe(group.anchor);
            // serveAt は茹で秒の再計算（プリセット × 茹で加減・表示用・AC 1.1）。引けない品目は群に入っていない。
            // 照合はプリセットから直に引く——導出側の関数を照合に使えば、同じ誤りを両辺に写して等式が空になる。
            const preset = view.noodlePresets.find((p) => p.noodleType === item.order.noodleType);
            expect(preset).toBeDefined();
            const boilSeconds = preset!.boilSeconds[item.order.firmness];
            expect(item.suggestion.serveAt).toBe(item.suggestion.startAt + boilSeconds * 1000);
            expect(view.pendingOrders).toContain(item.order);
          }
        }
        // 逆向き：開始できる推奨（品目が待ち行列に在り、麺種がプリセットに在る）の group がそのまま群の集合である。
        const startable = view.recommendations.filter(
          (recommendation) => suggestedItemOf(view, recommendation) !== null,
        );
        expect(new Set(groups.map((group) => group.group))).toEqual(
          new Set(startable.map((recommendation) => recommendation.group)),
        );
        expect(groups.reduce((n, group) => n + group.items.length, 0)).toBe(startable.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("client は group 以外から群を導かない——同じ卓・同じ serveAt でも group を分ければ別の群になり、group の付け替えは群の形を変えない", () => {
    fc.assert(
      // Feature: lift-group-display, Property 1（group だけが鍵）
      // Validates: Requirements 6.1, 1.2
      fc.property(genLiftScene, fc.nat(), ({ view, corrected }, seed) => {
        fc.pre(view.recommendations.length > 0);
        const groups = liftGroups(view, corrected);

        // 1 件の推奨だけ group を分ける。卓も serveAt も anchor も変えない。
        const picked = seed % view.recommendations.length;
        const target = view.recommendations[picked]!;
        const split: ClientView = {
          ...view,
          recommendations: view.recommendations.map((recommendation, index) =>
            index === picked
              ? { ...recommendation, group: `${recommendation.group}:split` }
              : recommendation,
          ),
        };
        const splitGroups = liftGroups(split, corrected);
        const item = suggestedItemOf(view, target);
        if (item === null) {
          // 開始できない推奨は群に入らないので、group を分けても何も変わらない。
          expect(splitGroups).toEqual(groups);
        } else {
          // 分けた推奨は 1 品だけの群になり、元の群からその品目が抜ける（他の群は形を保つ）。
          const alone = splitGroups.find((group) => group.group === `${target.group}:split`);
          expect(alone?.items.map(keyOf)).toEqual([recommendationKeyOf(target)]);
          expect(alone?.anchor).toBe(target.anchor);
          const before = groups.find((group) => group.group === target.group)!;
          const rest = splitGroups.find((group) => group.group === target.group);
          expect(rest?.items.map(keyOf) ?? []).toEqual(
            before.items.map(keyOf).filter((key) => key !== recommendationKeyOf(target)),
          );
          expect(
            splitGroups
              .filter((group) => group.group !== target.group && group.group !== alone!.group)
              .map(shapeOf),
          ).toEqual(groups.filter((group) => group.group !== target.group).map(shapeOf));
        }

        // group を全部付け替えても（単射）、群は識別子を除いて同じ形である——識別子は snapshot 内で閉じた記号にすぎない。
        const renamed: ClientView = {
          ...view,
          recommendations: view.recommendations.map((recommendation) => ({
            ...recommendation,
            group: `x:${recommendation.group}`,
          })),
        };
        const renamedGroups = liftGroups(renamed, corrected);
        expect(renamedGroups.map(shapeOf)).toEqual(groups.map(shapeOf));
        expect(renamedGroups.map((group) => group.group)).toEqual(
          groups.map((group) => `x:${group.group}`),
        );
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Feature: lift-group-display, Property 2: 一意（担当範囲・端末に依らない）", () => {
  it("全量の並べ替えと端末ローカルの項目の変更に対して、群・表示できる群・釜ごとの提案（先頭と後続）は構造的に等しい", () => {
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
          // 先頭（濃・押せる）と後続も端末に依らない。live か否かだけは提案の有無を決める（Property 11 の主語）
          // ので、接続の状態は元のまま比べる——それ以外のローカルの項目は提案に現れない。
          const otherLive: ClientView = { ...other, connectivity: view.connectivity };
          expect(slotSuggestions(visibleGroups(otherGroups), otherLive, corrected)).toEqual(
            slotSuggestions(visibleGroups(groups), view, corrected),
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Feature: lift-group-display, Property 3: 単調な出現（例外つき）", () => {
  it("同じ snapshot で時刻を進めても、表示できる群の anchor を跨がない限り群は変わらず提案は消えない。表示できる品目の startAt も跨がなければ先頭・後続の役も変わらない", () => {
    fc.assert(
      // Feature: lift-group-display, Property 3
      // Validates: Requirements 6.3, 2.3
      fc.property(
        genLiftScene,
        fc.integer({ min: 0, max: 600_000 }),
        ({ view, corrected }, delta) => {
          const before = visibleGroups(liftGroups(view, corrected));
          // 群の分割点は「表示できる群の anchor」だけ。Timer の endTime（錨の Timer のものを含め）は client の判定に
          // 現れないので分割点にならない——跨いでも何も変わらない（started は anchor だけで決まる・AC 1.7）。
          const splits = before
            .map((group) => group.anchor)
            .filter((anchor): anchor is number => anchor !== null && anchor > corrected);
          // 次の分割点の手前までしか進めない（跨げば例外の場面になる）。
          const later = Math.min(corrected + delta, ...splits.map((split) => split - 1));

          // 表示できる群は同じ（群・anchor・started・並びとも）。
          expect(visibleGroups(liftGroups(view, later))).toEqual(before);

          const earlier = flatten(slotSuggestions(before, view, corrected));
          const survivorsIn = (
            list: readonly { readonly slot: number; readonly suggestion: SlotSuggestion }[],
            slot: number,
            item: GroupItem,
          ) =>
            list.find(
              (candidate) =>
                candidate.slot === slot && keyOf(candidate.suggestion.item) === keyOf(item),
            );

          // 一度現れた提案は消えない（Prep_Lead も全釜 idle も時刻に対して単調）。
          const after = flatten(
            slotSuggestions(visibleGroups(liftGroups(view, later)), view, later),
          );
          for (const { slot, suggestion } of earlier) {
            const survivor = survivorsIn(after, slot, suggestion.item);
            expect(survivor).toBeDefined();
            // startAt がまだ来ていない後続は、進めても後続のまま（濃くなるのは startAt が来てから・AC 2.3）。
            if (suggestion.item.suggestion.startAt > later) {
              expect(suggestion.role).toBe("member");
              expect(survivor!.suggestion.role).toBe("member");
            }
            // 一度先頭になった品目は、始めるまで先頭のまま——新たに時刻が来た品目は開始推奨時刻の順で後ろに並び、
            // 先頭を押しのけない（判断 21・6.3「薄から濃へ一方向」）。
            if (suggestion.role === "head") expect(survivor!.suggestion.role).toBe("head");
          }

          // 役の分割点は表示できる品目の startAt（濃くなる点）。それも跨がなければ先頭も後続も変わらない——
          // 先頭は「startAt が来た品目の並びの先頭 arms 本」（判断 21）で、並びは snapshot が決め、startAt を跨がない
          // 限り「来た品目」の集合が変わらないからである。
          const startAts = before
            .flatMap((group) => group.items.map((item) => item.suggestion.startAt))
            .filter((startAt) => startAt > corrected);
          const steady = Math.min(later, ...startAts.map((startAt) => startAt - 1));
          const held = flatten(
            slotSuggestions(visibleGroups(liftGroups(view, steady)), view, steady),
          );
          for (const { slot, suggestion } of earlier) {
            expect(survivorsIn(held, slot, suggestion.item)?.suggestion.role).toBe(suggestion.role);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("例外：表示できる群の anchor を跨ぐと、その群は started でなくなり後続の群の提案は消える", () => {
    fc.assert(
      // Feature: lift-group-display, Property 3（例外の側）
      // Validates: Requirements 6.3, 1.7
      fc.property(genLiftScene, ({ view, corrected }) => {
        const groups = liftGroups(view, corrected);
        const visible = visibleGroups(groups);
        // 表示できる群のうち started のものの anchor（最小のもの）を跨ぐ。started ⇒ anchor は非 null で corrected より後。
        const split = Math.min(
          ...visible
            .filter((group) => group.started)
            .map((group) => group.anchor)
            .filter((anchor): anchor is number => anchor !== null),
        );
        fc.pre(Number.isFinite(split));
        const afterGroups = liftGroups(view, split);
        // 跨いだ時刻で、その錨に合流していた群はもう started でない（anchor ≤ corrected は数えない）。
        for (const group of visible) {
          if (!group.started || group.anchor !== split) continue;
          const same = afterGroups.find((candidate) => candidate.group === group.group);
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

describe("Feature: lift-group-display, Property 9: 先頭の上限", () => {
  it("head は店舗全体で arms 本以下、いずれも startAt ≤ corrected で、開始推奨時刻の順（同値は群の順・品目の順）の先頭から取られる。放置して全品の startAt が過ぎても arms 本を超えない", () => {
    fc.assert(
      // Feature: lift-group-display, Property 9
      // Validates: Requirements 6.9, 1.9, 2.2, 2.3, 2.4
      fc.property(genLiftScene, ({ view, corrected }) => {
        // 放置して全品の startAt が過ぎた時刻も踏む——表示できる品目がすべて濃くなれる時刻で、上限だけが効く。
        const lapsed = Math.max(corrected, ...view.recommendations.map((r) => r.startAt)) + 1;
        for (const time of [corrected, lapsed]) {
          const visible = visibleGroups(liftGroups(view, time));
          const bySlot = slotSuggestions(visible, view, time);
          const roles = rolesOf(bySlot);
          const heads = [...roles].filter(([, role]) => role === "head").map(([key]) => key);
          expect(heads.length).toBeLessThanOrEqual(view.arms);
          for (const { suggestion } of flatten(bySlot)) {
            // 先頭は startAt が来ている。後続は「表示できるがそれ以外」——startAt が来ていても濃くならない（AC 2.3）。
            if (suggestion.role === "head") {
              expect(suggestion.item.suggestion.startAt).toBeLessThanOrEqual(time);
            }
          }
          // 先頭の集合は、群の並びと占有から直に組んだ期待値と一致する（並びの先頭 arms 本・AC 1.9）。
          expect(new Set(heads)).toEqual(new Set(expectedHeads(visible, view, time)));
          if (time === lapsed) {
            // 全品の startAt が過ぎれば、表示できる品目が arms 本を超える限り先頭はちょうど arms 本（上限が効く）。
            expect(heads.length).toBe(Math.min(view.arms, roles.size));
          }
        }
        // 表示される品目の集合は arms に依らない（上限は濃さにだけ効き、表示の数に上限は無い・AC 2.11）。
        const visible = visibleGroups(liftGroups(view, corrected));
        const shownWith = (arms: number) =>
          new Set(
            flatten(slotSuggestions(visible, { ...view, arms }, corrected)).map(
              ({ slot, suggestion }) => `${slot}:${keyOf(suggestion.item)}`,
            ),
          );
        expect(shownWith(view.arms + 1)).toEqual(shownWith(view.arms));
        expect(shownWith(1)).toEqual(shownWith(view.arms));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("Feature: lift-group-display, Property 10: 開始の事実の一意", () => {
  it("started は anchor と corrected だけで決まる——anchor null は決して started でなく、anchor ≤ corrected も started でなく、Timer の有無に依らない", () => {
    fc.assert(
      // Feature: lift-group-display, Property 10
      // Validates: Requirements 6.10, 1.7, 1.10
      fc.property(genLiftScene, ({ view, corrected }) => {
        const groups = liftGroups(view, corrected);
        for (const group of groups) {
          expect(group.started).toBe(group.anchor !== null && group.anchor > corrected);
          // 合流していない群（同じ卓の後の batch を含む）は、錨に一致する Timer が在っても started でない。
          if (group.anchor === null) expect(group.started).toBe(false);
          // 錨が茹で上がり（anchor ≤ corrected）に転じた群は started でない（保持しない・判断 16）。
          if (group.anchor !== null && group.anchor <= corrected) expect(group.started).toBe(false);
        }
        // 途中接続した端末（Timer をまだ持たない）も、Timer の endTime が動いた snapshot も、同じ推奨からは同じ
        // started に達する——走行中 Timer の照合を判定に用いない（AC 1.7）。
        const withoutTimers: ClientView = { ...view, timers: [] };
        expect(liftGroups(withoutTimers, corrected)).toEqual(groups);
        const shifted: ClientView = {
          ...view,
          timers: view.timers.map((timer) => ({ ...timer, endTime: timer.endTime + 1 })),
        };
        expect(liftGroups(shifted, corrected)).toEqual(groups);
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
