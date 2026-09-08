// Feature: plan-stability, Component 1 / **Validates: Requirements 4.3, Glossary Head**
//
// tests/domain/lift-group.example.test.ts — 群の連鎖と Head の共有導出の境界を名指しで固定する。
//
// client の表示（liftGroups.*・slot-board-suggestions.*）はビューを通してこの関数を検証している。ここはビューを
// 持たず、engine が Change_Cost の先頭の判定で呼ぶ形——推奨・品目・茹で秒（LiftItem）・占有釜・now・arms——で
// 直に呼ぶ。線は Glossary の Head の定義そのもの：表示できる群（先頭と、それより前がすべて started の群）の
// 品目のうち、全釜 idle・Prep_Lead・開始推奨時刻が来たものを時刻順（同値は群の順・品目の順）に並べた先頭 arms 本。

import { describe, expect, it } from "vitest";
import {
  displayableItemsOf,
  headsOf,
  liftGroupsOf,
  visibleGroupsOf,
  type LiftItem,
} from "../../src/domain/lift-group";
import { PREP_LEAD_MS, type CookRecommendation } from "../../src/domain/messages";
import { itemKeyOf, type OrderItem } from "../../src/domain/order";
import { nonEmpty } from "../nonEmpty";

const T0 = 1_700_000_000_000;
const SECOND = 1000;
const NONE: ReadonlySet<number> = new Set();

function order(overrides: Partial<OrderItem> & { externalOrderId: string }): OrderItem {
  return {
    itemIndex: 0,
    noodleType: "Long",
    firmness: "normal",
    tableId: "t-1",
    arrivalTime: T0 - 60 * SECOND,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
    ...overrides,
  };
}

/** 群の 1 品目。群の所属 `group` と錨 `anchor` は engine が付ける値（既定は合流していない）。 */
function item(
  externalOrderId: string,
  slotIds: readonly string[],
  startAt: number,
  group: string,
  overrides: { readonly anchor?: number | null; readonly arrivalTime?: number } = {},
): LiftItem {
  const recommendation: CookRecommendation = {
    externalOrderId,
    itemIndex: 0,
    slotIds: nonEmpty(slotIds),
    startAt,
    group,
    anchor: overrides.anchor ?? null,
  };
  const pending =
    overrides.arrivalTime === undefined
      ? order({ externalOrderId })
      : order({ externalOrderId, arrivalTime: overrides.arrivalTime });
  return { recommendation, order: pending, boilSeconds: 510 };
}

const keyOf = (name: string) => itemKeyOf({ externalOrderId: name, itemIndex: 0 });

describe("Feature: plan-stability, Component 1 — 群の導出（liftGroupsOf）", () => {
  it("group で束ね、群の中は startAt 昇順・同値は到着順、群どうしは先頭品目の順に並ぶ。started は anchor が now より後", () => {
    const groups = liftGroupsOf(
      [
        item("b-late", ["1"], T0 + 30 * SECOND, "g2"),
        item("a-second", ["2"], T0, "g1", { arrivalTime: T0 - 10 * SECOND }),
        item("a-first", ["0"], T0, "g1", { arrivalTime: T0 - 20 * SECOND }),
        item("c", ["3"], T0 - 5 * SECOND, "g3", { anchor: T0 + 400 * SECOND }),
      ],
      T0,
    );
    expect(
      groups.map((group) => ({
        group: group.group,
        anchor: group.anchor,
        started: group.started,
        items: group.items.map((entry) => entry.order.externalOrderId),
      })),
    ).toEqual([
      { group: "g3", anchor: T0 + 400 * SECOND, started: true, items: ["c"] },
      { group: "g1", anchor: null, started: false, items: ["a-first", "a-second"] },
      { group: "g2", anchor: null, started: false, items: ["b-late"] },
    ]);
  });

  it("錨が now 以前（茹で上がり）の群は started でない——茹で上がり後は保持しない", () => {
    const groups = liftGroupsOf([item("a", ["0"], T0, "g1", { anchor: T0 })], T0);
    expect(groups[0]).toMatchObject({ anchor: T0, started: false });
    expect(liftGroupsOf([item("a", ["0"], T0, "g1", { anchor: T0 + 1 })], T0)[0]?.started).toBe(
      true,
    );
  });
});

describe("Feature: plan-stability, Component 1 — 連鎖（visibleGroupsOf）", () => {
  it("先頭の群は常に表示でき、以降は直前までがすべて started の間だけ続く", () => {
    const anchor = T0 + 400 * SECOND;
    const groups = liftGroupsOf(
      [
        item("g1", ["0"], T0, "g1", { anchor }),
        item("g2", ["1"], T0 + 10 * SECOND, "g2", { anchor }),
        item("g3", ["2"], T0 + 20 * SECOND, "g3"),
        item("g4", ["3"], T0 + 30 * SECOND, "g4", { anchor }),
      ],
      T0,
    );
    // g1・g2 は started、g3 で止まる。g4 は started でも、前に g3 が在るので出ない。
    expect(visibleGroupsOf(groups).map((group) => group.group)).toEqual(["g1", "g2", "g3"]);
    // 錨が茹で上がると（now が anchor を跨ぐ）g1 が started でなくなり、連鎖は g1 で止まる。
    expect(
      visibleGroupsOf(
        liftGroupsOf(
          groups.flatMap((g) => g.items),
          anchor,
        ),
      ).map((g) => g.group),
    ).toEqual(["g1"]);
    expect(visibleGroupsOf([])).toEqual([]);
  });
});

describe("Feature: plan-stability, Component 1 — Head（headsOf）", () => {
  /** 同卓 3 品（開始予定 0 / 150 / 180 秒）が一つの群 g1。 */
  const three = liftGroupsOf(
    [
      item("long", ["0"], T0, "g1"),
      item("mid", ["1"], T0 + 150 * SECOND, "g1"),
      item("short", ["2"], T0 + 180 * SECOND, "g1"),
    ],
    T0,
  );

  it("開始推奨時刻が来た品目だけが Head。Prep_Lead の内側は表示できるが Head でない", () => {
    expect(headsOf(three, NONE, T0, 2)).toEqual([keyOf("long")]);
    // 90 秒：mid は Prep_Lead（150 − 60）が来て表示できるが、startAt は来ていない。
    const shown = displayableItemsOf(three, NONE, T0 + 150 * SECOND - PREP_LEAD_MS);
    expect(shown.map((entry) => entry.order.externalOrderId)).toEqual(["long", "mid"]);
    expect(headsOf(three, NONE, T0 + 150 * SECOND - PREP_LEAD_MS, 2)).toEqual([keyOf("long")]);
    // 150 秒：mid の startAt が来て 2 本目の Head。
    expect(headsOf(three, NONE, T0 + 150 * SECOND, 2)).toEqual([keyOf("long"), keyOf("mid")]);
  });

  it("arms が上限——全品の startAt が過ぎても時刻順の先頭 arms 本だけ。0 以下なら空", () => {
    const lapsed = T0 + 180 * SECOND;
    expect(headsOf(three, NONE, lapsed, 2)).toEqual([keyOf("long"), keyOf("mid")]);
    expect(headsOf(three, NONE, lapsed, 1)).toEqual([keyOf("long")]);
    expect(headsOf(three, NONE, lapsed, 3)).toEqual([keyOf("long"), keyOf("mid"), keyOf("short")]);
    expect(headsOf(three, NONE, lapsed, 0)).toEqual([]);
    expect(headsOf(three, NONE, lapsed, -1)).toEqual([]);
  });

  it("占有釜——slotIds のいずれかが occupied なら表示できず Head にもならない。空いた釜の後続が繰り上がる", () => {
    const lapsed = T0 + 180 * SECOND;
    expect(headsOf(three, new Set([0]), lapsed, 2)).toEqual([keyOf("mid"), keyOf("short")]);
    // 2 釜の推奨は片方が埋まっていれば出ない（一部の釜が空いていても出さない）。
    const pair = liftGroupsOf([item("pair", ["0", "1"], T0, "g1")], T0);
    expect(displayableItemsOf(pair, new Set([1]), lapsed)).toEqual([]);
    expect(headsOf(pair, new Set([1]), lapsed, 2)).toEqual([]);
    expect(headsOf(pair, new Set([2]), lapsed, 2)).toEqual([keyOf("pair")]);
  });

  it("並びは開始推奨時刻の順で、群の順ではない——後の群の早い品目が前の群の遅い品目より先に Head になる", () => {
    const anchor = T0 + 400 * SECOND;
    const groups = liftGroupsOf(
      [
        item("g1-early", ["0"], T0, "g1", { anchor }),
        item("g1-late", ["1"], T0 + 100 * SECOND, "g1", { anchor }),
        item("g2", ["2"], T0 + 50 * SECOND, "g2"),
      ],
      T0,
    );
    const visible = visibleGroupsOf(groups);
    expect(visible.map((group) => group.group)).toEqual(["g1", "g2"]);
    expect(headsOf(visible, NONE, T0 + 100 * SECOND, 2)).toEqual([keyOf("g1-early"), keyOf("g2")]);
    // 同じ startAt は群の順・群の中の順（到着順）で断つ。群の順は先頭品目の到着順ゆえ、g2（−30 秒）が
    // g1（先頭は g1-a・−20 秒）より前。どちらも started で、両方が表示できる。
    const tied = liftGroupsOf(
      [
        item("g2", ["2"], T0, "g2", { anchor, arrivalTime: T0 - 30 * SECOND }),
        item("g1-b", ["1"], T0, "g1", { anchor, arrivalTime: T0 - 10 * SECOND }),
        item("g1-a", ["0"], T0, "g1", { anchor, arrivalTime: T0 - 20 * SECOND }),
      ],
      T0,
    );
    expect(visibleGroupsOf(tied).map((group) => group.group)).toEqual(["g2", "g1"]);
    expect(headsOf(visibleGroupsOf(tied), NONE, T0, 3)).toEqual([
      keyOf("g2"),
      keyOf("g1-a"),
      keyOf("g1-b"),
    ]);
  });

  it("表示できない群（前に started でない群が在る）の品目は、startAt が来ていても Head にならない", () => {
    const groups = liftGroupsOf(
      [item("g1", ["0"], T0 + 100 * SECOND, "g1"), item("g2", ["1"], T0, "g2")],
      T0,
    );
    // 群の順は最早 startAt：g2（T0）が先頭で g1 が 2 番目。g2 は started でないので g1 は表示できず、
    // g1 の startAt が来ても Head は g2 だけ。
    expect(groups.map((group) => group.group)).toEqual(["g2", "g1"]);
    const visible = visibleGroupsOf(groups);
    expect(visible.map((group) => group.group)).toEqual(["g2"]);
    expect(headsOf(visible, NONE, T0 + 100 * SECOND, 2)).toEqual([keyOf("g2")]);
    // 全群を渡せば（連鎖を経なければ）g1 も数えられてしまう——Head は表示できる群に対して導くこと。
    expect(headsOf(groups, NONE, T0 + 100 * SECOND, 2)).toEqual([keyOf("g2"), keyOf("g1")]);
  });
});
