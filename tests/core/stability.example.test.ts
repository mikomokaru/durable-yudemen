// Feature: plan-stability, Component 4 / Data Models
// **Validates: Requirements 1.1, 1.5**
//
// tests/core/stability.example.test.ts — Shown_Plan の組み立て（shownPlanOf）の境界を名指しで固定する。
//
// Shown_Plan は前回配信対象として確定した提案の履歴であり、次の計画と比べる相手である。ここで固定するのは
// 「何を写すか」——配置（Placement）から釜・開始・提供・錨を、`recommend` の出力から群の所属を——と、
// 群の所属の表現（識別子ではなく同じ群の相手の鍵・自分を含まず対称・AC 1.5）である。

import { describe, expect, it } from "vitest";
import { EMPTY_SHOWN_PLAN, shownPlanOf } from "../../src/engine/stability";
import { recommend } from "../../src/engine/recommend";
import type { CookSchedule, Placement } from "../../src/engine/schedule";
import type { EpochMillis, SlotId } from "../../src/engine/types";
import type { CookRecommendation } from "../../src/domain/messages";
import { itemKeyOf } from "../../src/domain/order";
import { nonEmpty } from "../nonEmpty";

const T0 = 1_700_000_000_000;
const SECOND = 1000;
const at = (seconds: number) => (T0 + seconds * SECOND) as EpochMillis;

function placement(
  externalOrderId: string,
  slotIds: readonly string[],
  startAt: number,
  serveAt: number,
  overrides: { readonly itemIndex?: number; readonly anchor?: number | null } = {},
): Placement {
  return {
    externalOrderId,
    itemIndex: overrides.itemIndex ?? 0,
    slotIds: nonEmpty(slotIds.map((s) => s as SlotId)),
    startAt: at(startAt),
    serveAt: at(serveAt),
    anchor:
      overrides.anchor === undefined || overrides.anchor === null ? null : at(overrides.anchor),
  };
}

const keyOf = (name: string, itemIndex = 0) => itemKeyOf({ externalOrderId: name, itemIndex });

/**
 * 一片 0：A と B は同じ serveAt の batch（同じ群）、C は別の serveAt（別の群）。
 * 一片 1：D は走行中の錨 300 秒に合流し、上げ窓で serveAt が錨より後ろ（310 秒）へ延びている。
 */
const SCHEDULE: CookSchedule = {
  slices: [
    {
      tableKey: "t-1",
      placements: [
        placement("a", ["0"], 0, 60),
        placement("b", ["1"], 0, 60),
        placement("c", ["2"], 30, 90),
      ],
    },
    {
      tableKey: "t-2",
      placements: [placement("d", ["3", "4"], 250, 310, { anchor: 300 })],
    },
  ],
};

describe("Feature: plan-stability — shownPlanOf は配置と推奨の群から Shown_Plan を組む", () => {
  it("釜・開始・提供・錨は配置（Placement）の値で、上げ窓で延びた serveAt と錨は別々に残る", () => {
    const shown = shownPlanOf(SCHEDULE, recommend(SCHEDULE));

    expect(shown.map((item) => item.externalOrderId)).toEqual(["a", "b", "c", "d"]);
    const d = shown[3]!;
    expect(d.slotIds).toEqual(["3", "4"]);
    expect(d.startAt).toBe(at(250));
    // serveAt は Placement の値（錨 300 秒ではなく延期後の 310 秒）。ワイヤの推奨は serveAt を運ばないので、
    // 配置から取らなければ埋まらない（design Data Models の入力契約）。
    expect(d.serveAt).toBe(at(310));
    expect(d.anchor).toBe(at(300));
    expect(shown[0]!.anchor).toBeNull();
  });

  it("mates は同じ群の相手の鍵で、自分を含まず対称に持つ。別の群の品目は空", () => {
    const shown = shownPlanOf(SCHEDULE, recommend(SCHEDULE));
    const byName = new Map(shown.map((item) => [item.externalOrderId, item]));

    expect(byName.get("a")!.mates).toEqual([keyOf("b")]);
    expect(byName.get("b")!.mates).toEqual([keyOf("a")]);
    expect(byName.get("c")!.mates).toEqual([]);
    expect(byName.get("d")!.mates).toEqual([]);
  });

  it("群の所属は recommend が付けた group から取り、serveAt や卓から引き直さない", () => {
    // A と C は serveAt が違うが、推奨が同じ群だと言えば（合流の錨で束ねた場合など）その通りに持つ。
    // B は同じ serveAt でも別の群。
    const recommendations: readonly CookRecommendation[] = [
      {
        externalOrderId: "a",
        itemIndex: 0,
        slotIds: nonEmpty(["0"]),
        startAt: at(0),
        group: "g",
        anchor: null,
      },
      {
        externalOrderId: "b",
        itemIndex: 0,
        slotIds: nonEmpty(["1"]),
        startAt: at(0),
        group: "h",
        anchor: null,
      },
      {
        externalOrderId: "c",
        itemIndex: 0,
        slotIds: nonEmpty(["2"]),
        startAt: at(30),
        group: "g",
        anchor: null,
      },
      {
        externalOrderId: "d",
        itemIndex: 0,
        slotIds: nonEmpty(["3", "4"]),
        startAt: at(250),
        group: "i",
        anchor: at(300),
      },
    ];

    const shown = shownPlanOf(SCHEDULE, recommendations);

    expect(shown.map((item) => item.mates)).toEqual([[keyOf("c")], [], [keyOf("a")], []]);
  });

  it("鍵は externalOrderId と itemIndex の組で、同じ注文の別の品目を取り違えない", () => {
    const schedule: CookSchedule = {
      slices: [
        {
          tableKey: "t-1",
          placements: [
            placement("o", ["0"], 0, 60, { itemIndex: 0 }),
            placement("o", ["1"], 0, 60, { itemIndex: 1 }),
            placement("o", ["2"], 30, 90, { itemIndex: 2 }),
          ],
        },
      ],
    };

    const shown = shownPlanOf(schedule, recommend(schedule));

    expect(shown.map((item) => item.itemIndex)).toEqual([0, 1, 2]);
    expect(shown[0]!.mates).toEqual([keyOf("o", 1)]);
    expect(shown[1]!.mates).toEqual([keyOf("o", 0)]);
    expect(shown[2]!.mates).toEqual([]);
  });

  it("並びは計画順（一片の順・配置の順）で、同じ入力から同じ Shown_Plan が出る", () => {
    const once = shownPlanOf(SCHEDULE, recommend(SCHEDULE));
    const twice = shownPlanOf(SCHEDULE, recommend(SCHEDULE));

    expect(twice).toEqual(once);
    expect(once.map((item) => item.externalOrderId)).toEqual(["a", "b", "c", "d"]);
  });

  it("空の計画は空の Shown_Plan（比較の相手なし）", () => {
    expect(shownPlanOf({ slices: [] }, [])).toEqual(EMPTY_SHOWN_PLAN);
  });

  it("推奨を持たない配置は落とさず、まとまりの無い単独の品目として残す", () => {
    // recommend は全配置に推奨を付けるので通常は起きない。起きても履歴の欠けは費用 0 に倒れるだけで、
    // 品目を失わせる理由にならない。
    const shown = shownPlanOf(SCHEDULE, []);

    expect(shown).toHaveLength(4);
    expect(shown.every((item) => item.mates.length === 0)).toBe(true);
  });
});
