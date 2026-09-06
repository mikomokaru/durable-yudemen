// Feature: plan-stability, Component 2 / Component 4 / Data Models
// **Validates: Requirements 1.1, 1.5, 2.1〜2.4, 2.6, 5.9**
//
// tests/core/stability.example.test.ts — Shown_Plan の組み立て（shownPlanOf）と変更費用（changeCost）の境界を名指しで固定する。
//
// Shown_Plan は前回配信対象として確定した提案の履歴であり、次の計画と比べる相手である。ここで固定するのは
// 「何を写すか」——配置（Placement）から釜・開始・提供・錨を、`recommend` の出力から群の所属を——と、
// 群の所属の表現（識別子ではなく同じ群の相手の鍵・自分を含まず対称・AC 1.5）である。

import { describe, expect, it } from "vitest";
import {
  changeCost,
  EMPTY_SHOWN_PLAN,
  shownPlanOf,
  type ChangeContext,
  type ShownItem,
  type ShownPlan,
} from "../../src/engine/stability";
import { recommend } from "../../src/engine/recommend";
import type { CookSchedule, Placement } from "../../src/engine/schedule";
import type { ScheduleParams } from "../../src/engine/objective";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import type { CookRecommendation } from "../../src/domain/messages";
import {
  itemKeyOf,
  liveOrders,
  ORDER_LIFETIME_MS,
  type PendingOrder,
} from "../../src/domain/order";
import type { NoodlePreset } from "../../src/domain/store";
import { schedulingDefaults } from "../storeConfigDefaults";
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

// ────────────────────────────────────────────────────────────────────────────
// Feature: plan-stability, Component 2 — changeCost
// **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.6, 5.9**
//
// 4 種の費用（先頭 2L・釜 L・まとまり L・時刻の移動）をそれぞれ一つの場面で名指しで固定する。L = 45 秒・arms は場面ごと。
// 茹で時間は 60 秒の 1 種（h_i = 60 × toleranceRatio 20 % = 12 秒）。
// ────────────────────────────────────────────────────────────────────────────

const L = 45;
const BOIL_SECONDS = 60;
const PRESETS: readonly NoodlePreset[] = [
  {
    noodleType: "Short",
    boilSeconds: {
      extraHard: BOIL_SECONDS,
      hard: BOIL_SECONDS,
      normal: BOIL_SECONDS,
      soft: BOIL_SECONDS,
    },
  },
];
const PARAMS: ScheduleParams = {
  ...schedulingDefaults(1),
  arms: 1,
  liftIntervalSeconds: L,
  toleranceRatio: 20,
};
const H_SECONDS = (BOIL_SECONDS * PARAMS.toleranceRatio) / 100;

/** 品目。到着は同時で、同値の順は externalOrderId の辞書順（a → b → c）。 */
function order(externalOrderId: string): PendingOrder {
  return {
    externalOrderId,
    itemIndex: 0,
    noodleType: "Short",
    firmness: "normal",
    tableId: null,
    arrivalTime: T0,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
  };
}
const PENDING: readonly PendingOrder[] = [order("a"), order("b"), order("c")];

/** 旧 Shown_Plan の 1 品目。serveAt は startAt + 茹で時間。 */
function shownItem(
  externalOrderId: string,
  slotIds: readonly string[],
  startSeconds: number,
  overrides: { readonly mates?: readonly string[]; readonly anchor?: number | null } = {},
): ShownItem {
  return {
    externalOrderId,
    itemIndex: 0,
    slotIds: nonEmpty(slotIds.map((s) => s as SlotId)),
    startAt: at(startSeconds),
    serveAt: at(startSeconds + BOIL_SECONDS),
    anchor:
      overrides.anchor === undefined || overrides.anchor === null ? null : at(overrides.anchor),
    mates: (overrides.mates ?? []).map((mate) => keyOf(mate)),
  };
}

/** 新しい計画の 1 配置。 */
function next(
  externalOrderId: string,
  slotIds: readonly string[],
  startSeconds: number,
  anchor: number | null = null,
): Placement {
  return placement(externalOrderId, slotIds, startSeconds, startSeconds + BOIL_SECONDS, { anchor });
}

/** 一片ごとに配置を束ねた計画と、その推奨（群は recommend が付ける・同じ一片で同じ serveAt なら同じ群）。 */
function planOf(...slices: readonly (readonly Placement[])[]) {
  const schedule: CookSchedule = {
    slices: slices.map((placements, index) => ({ tableKey: `t-${index}`, placements })),
  };
  return { schedule, recommendations: recommend(schedule) };
}

/** 釜 slot を遠い未来まで塞ぐ走行中 Timer（占有釜）。 */
function runningOn(slot: string): Timer {
  return createTimer({
    id: `t-${slot}` as TimerId,
    slotIds: nonEmpty([slot as SlotId]),
    noodleType: "Short" as NoodleType,
    firmness: "normal",
    startTime: T0 as EpochMillis,
    endTime: at(10_000),
    seq: Number(slot),
  });
}

function contextOf(
  shown: ShownPlan,
  nowSeconds: number,
  running: readonly Timer[] = [],
): ChangeContext {
  return { shown, running, now: at(nowSeconds), pending: PENDING, presets: PRESETS };
}

describe("Feature: plan-stability — changeCost は旧 Shown_Plan からの変更を秒相当で数える", () => {
  it("(a) 先頭の変更：旧 Head の品目が新しい計画の Head に無ければ 2L（新規の品目に押し出されても、費用は対応する品目にだけ付く）", () => {
    // arms 1。旧：A を 0 秒に（10 秒の時点で Head）。新：新規の B が 0 秒に入り A は 10 秒へ——時刻順で B が先頭、A は外れる。
    // A の移動 10 秒は h_i 12 秒の内側（(d) は付かない）。B は Shown_Plan に無いので数えない（AC 2.3）。
    const shown: ShownPlan = [shownItem("a", ["0"], 0)];
    const moved = planOf([next("b", ["1"], 0)], [next("a", ["0"], 10)]);
    expect(changeCost(moved, contextOf(shown, 10), PARAMS)).toBe(2 * L);

    // 同じ計画で A が先頭のまま（B が後ろ）なら 0。
    const kept = planOf([next("a", ["0"], 10)], [next("b", ["1"], 11)]);
    expect(changeCost(kept, contextOf(shown, 11), PARAMS)).toBe(0);
  });

  it("(b) 釜の変更：slotIds が変われば L。並びと表記の違いは変更ではない", () => {
    const shown: ShownPlan = [shownItem("a", ["0"], 0)];
    expect(changeCost(planOf([next("a", ["1"], 0)]), contextOf(shown, 0), PARAMS)).toBe(L);

    const wide: ShownPlan = [shownItem("a", ["0", "1"], 0)];
    expect(changeCost(planOf([next("a", ["1", "0"], 0)]), contextOf(wide, 0), PARAMS)).toBe(0);
    expect(changeCost(planOf([next("a", ["00", "1"], 0)]), contextOf(wide, 0), PARAMS)).toBe(0);
  });

  it("(c-1) まとまりの分割：旧で同じ群だった 2 品目が別の群になれば組ごとに L", () => {
    // 100 秒先の 2 品目（now 0 ではどちらの側も Head に無く、先頭の費用は付かない）。釜も時刻も同じ。
    const shown: ShownPlan = [
      shownItem("a", ["0"], 100, { mates: ["b"] }),
      shownItem("b", ["1"], 100, { mates: ["a"] }),
    ];
    // 同じ一片・同じ serveAt なら同じ群（0 円）。別の一片なら別の群。
    const together = planOf([next("a", ["0"], 100), next("b", ["1"], 100)]);
    expect(changeCost(together, contextOf(shown, 0), PARAMS)).toBe(0);
    const split = planOf([next("a", ["0"], 100)], [next("b", ["1"], 100)]);
    expect(changeCost(split, contextOf(shown, 0), PARAMS)).toBe(L);

    // 旧で別の群だった 2 品目が同じ群になっても、分割ではない（費用 0）。
    const apart: ShownPlan = [shownItem("a", ["0"], 100), shownItem("b", ["1"], 100)];
    expect(changeCost(together, contextOf(apart, 0), PARAMS)).toBe(0);

    // 時刻が来ている 2 品目を割れば、後ろの群は先頭の群が始まるまで隠れる（連鎖の規則）ので、分割 L に
    // 加えて B の先頭消失 2L が付く。まとまりを割ることは、現場から見れば次に押せる品目が減ることでもある。
    const heads: ShownPlan = [
      shownItem("a", ["0"], 0, { mates: ["b"] }),
      shownItem("b", ["1"], 0, { mates: ["a"] }),
    ];
    const splitNow = planOf([next("a", ["0"], 0)], [next("b", ["1"], 0)]);
    expect(changeCost(splitNow, contextOf(heads, 0), { ...PARAMS, arms: 2 })).toBe(L + 2 * L);
  });

  it("(c-2) 順の逆転：別の群でも、対応する 2 品目の startAt の順が入れ替われば L（h_i の内側の移動でも）", () => {
    // 100 秒先の 2 品目（Head に関わらない）。A 100 → 110 秒・B 110 → 100 秒はどちらも h_i 12 秒の内側。
    const shown: ShownPlan = [shownItem("a", ["0"], 100), shownItem("b", ["1"], 110)];
    const reversed = planOf([next("a", ["0"], 110)], [next("b", ["1"], 100)]);
    expect(changeCost(reversed, contextOf(shown, 0), PARAMS)).toBe(L);

    // 同時刻になるのは逆転ではない（符号の積が 0）。
    const tied = planOf([next("a", ["0"], 105)], [next("b", ["1"], 105)]);
    expect(changeCost(tied, contextOf(shown, 0), PARAMS)).toBe(0);
  });

  it("(d) 時刻の移動：h_i を超えて 1 窓動けば L。ミリ秒の 45000 ではなく秒の 45", () => {
    // 旧 10 秒（now 0 から 0 個目の間隔・Head ではない）→ 新 55 秒。Δ 45 秒 > h_i 12 秒・窓 1・減衰 1/(0+1)。
    const shown: ShownPlan = [shownItem("a", ["0"], 10)];
    expect(changeCost(planOf([next("a", ["0"], 10 + L)]), contextOf(shown, 0), PARAMS)).toBe(L);
    expect(changeCost(planOf([next("a", ["0"], 10 + L)]), contextOf(shown, 0), PARAMS)).not.toBe(
      L * 1000,
    );
    // 早める方向も同じ幅で同じ費用（旧 40 秒 → 新 0 秒・Δ 40 秒・窓 1・k 0）。
    const late: ShownPlan = [shownItem("a", ["0"], 40)];
    expect(changeCost(planOf([next("a", ["0"], 0)]), contextOf(late, 0), PARAMS)).toBe(L);
    // 45 秒 + 1 ms は 2 窓。
    const bit = planOf([{ ...next("a", ["0"], 10 + L), startAt: (at(10 + L) + 1) as EpochMillis }]);
    expect(changeCost(bit, contextOf(shown, 0), PARAMS)).toBe(2 * L);
  });

  it("(d) 減衰：同じ 45 秒の移動でも、旧 startAt が今から k 個目の間隔なら L / (k + 1) の床", () => {
    const moveBy = (startSeconds: number) =>
      changeCost(
        planOf([next("a", ["0"], startSeconds + L)]),
        contextOf([shownItem("a", ["0"], startSeconds)], 0),
        PARAMS,
      );
    expect(moveBy(10)).toBe(L); // k = 0
    expect(moveBy(L + 10)).toBe(Math.floor(L / 2)); // k = 1 → 22
    expect(moveBy(2 * L + 10)).toBe(Math.floor(L / 3)); // k = 2 → 15
    expect(moveBy(10 * L)).toBe(Math.floor(L / 11)); // k = 10 → 4
  });

  it("(d) h_i の内側の移動は数えない（ちょうど h_i も内側）", () => {
    const shown: ShownPlan = [shownItem("a", ["0"], 10)];
    expect(
      changeCost(planOf([next("a", ["0"], 10 + H_SECONDS)]), contextOf(shown, 0), PARAMS),
    ).toBe(0);
    expect(
      changeCost(planOf([next("a", ["0"], 10 + H_SECONDS + 1)]), contextOf(shown, 0), PARAMS),
    ).toBe(L);
  });

  it("同じ計画は now と Timer 集合に依らず 0——時間経過で Head に入った品目も、錨の失効で隠れた群も（性質 5.1）", () => {
    // 一片 0：A（錨 30 秒に合流・B と同じ群）。一片 1：C は 40 秒。錨が失効する 30 秒以降は C の群が先頭に繰り上がる。
    const schedule = planOf(
      [next("a", ["0"], 0, 30), next("b", ["1"], 0, 30)],
      [next("c", ["2"], 40)],
    );
    const shown = shownPlanOf(schedule.schedule, schedule.recommendations);
    for (const nowSeconds of [-100, 0, 10, 29, 30, 31, 40, 100, 1000]) {
      for (const running of [[], [runningOn("0")], [runningOn("1"), runningOn("2")]]) {
        expect(changeCost(schedule, contextOf(shown, nowSeconds, running), PARAMS)).toBe(0);
      }
    }
  });

  it("「10 秒に開始」と示した品目は 10 秒以降の比較で旧 Head に入り、先頭から外す計画に 2L が付く（性質 5.9）", () => {
    // 釜 1 は走行中（占有）。A を占有釜へ動かす計画は表示できず Head から外れる（釜の変更 L + 先頭 2L）。
    // 空いている釜 2 へ動かす計画は Head のまま（釜の変更 L だけ）。差がちょうど 2L。
    const shown: ShownPlan = [shownItem("a", ["0"], 10)];
    const running = [runningOn("1")];
    const toOccupied = planOf([next("a", ["1"], 10)]);
    const toIdle = planOf([next("a", ["2"], 10)]);
    for (const nowSeconds of [10, 11, 60]) {
      expect(changeCost(toOccupied, contextOf(shown, nowSeconds, running), PARAMS)).toBe(3 * L);
      expect(changeCost(toIdle, contextOf(shown, nowSeconds, running), PARAMS)).toBe(L);
    }
    // 10 秒より前は Head ではないので、どちらも釜の変更 L だけ。
    expect(changeCost(toOccupied, contextOf(shown, 9, running), PARAMS)).toBe(L);
    expect(changeCost(toIdle, contextOf(shown, 9, running), PARAMS)).toBe(L);
  });

  it("開始済み・キャンセル済み（pending に無い）・新規（Shown_Plan に無い）・欠落（next に無い）の品目は数えない（AC 2.3・2.4）", () => {
    const shown: ShownPlan = [
      shownItem("a", ["0"], 100),
      shownItem("gone", ["3"], 0, { mates: ["a"] }),
    ];
    // gone は pending に無い（開始済みかキャンセル済み）。next は A をそのまま、新規の C を遠い将来に置く。
    const plan = planOf([next("a", ["0"], 100)], [next("c", ["2"], 500)]);
    expect(changeCost(plan, contextOf(shown, 0), PARAMS)).toBe(0);
    // A が next から欠けても、その品目に費用は付かない（ハード制約が閉じる・AC 2.4）。
    expect(changeCost(planOf([next("c", ["2"], 500)]), contextOf(shown, 0), PARAMS)).toBe(0);
    // 空の Shown_Plan は比較の相手なし。
    expect(changeCost(plan, contextOf(EMPTY_SHOWN_PLAN, 0), PARAMS)).toBe(0);
  });

  it("費用は加法で、整数で閉じる（AC 2.6）", () => {
    // arms 1・now 0。旧：A 0 秒 釜 0（Head）・B 600 秒 釜 0。新：B 0 秒 釜 0（Head）・A 60 秒 釜 1。
    // (a) A 2L = 90・(b) A の釜 L = 45・(c-2) 逆転 L = 45・(d) A: 60 秒 → 2 窓・k 0 → 90、B: 600 秒 → 14 窓・k 13 → floor(630/14) = 45。
    const shown: ShownPlan = [shownItem("a", ["0"], 0), shownItem("b", ["0"], 600)];
    const plan = planOf([next("b", ["0"], 0)], [next("a", ["1"], 60)]);
    const cost = changeCost(plan, contextOf(shown, 0), PARAMS);
    expect(cost).toBe(90 + 45 + 45 + 90 + 45);
    expect(Number.isInteger(cost)).toBe(true);
  });
});

// Feature: pending-order-expiry, Component 3 / **Validates: Requirements 2.4**
describe("Feature: pending-order-expiry — 期限切れの品目は対応から外れて費用に倒れない（AC 2.4・レビュー実走）", () => {
  // 期限切れの旧先頭 A（釜 0・今の 1 秒前）と、生きている次品目 B（釜 1・今）。arms 1・L 45・茹で 600 秒（h_i 60 秒）。
  const L = 45;
  const PRESETS: readonly NoodlePreset[] = [
    { noodleType: "Long", boilSeconds: { extraHard: 600, hard: 600, normal: 600, soft: 600 } },
  ];
  const PARAMS: ScheduleParams = { ...schedulingDefaults(1), arms: 1, liftIntervalSeconds: L };
  const order = (externalOrderId: string, arrivalTime: number): PendingOrder => ({
    externalOrderId,
    itemIndex: 0,
    noodleType: "Long",
    firmness: "normal",
    tableId: "t-1",
    arrivalTime,
    slotSpan: 1,
    itemName: null,
    sizeName: null,
  });
  const A = order("a", T0 - ORDER_LIFETIME_MS);
  const B = order("b", T0 - 60 * SECOND);
  const previous: CookSchedule = {
    slices: [
      {
        tableKey: "t-1",
        placements: [placement("a", ["0"], -1, 599), placement("b", ["1"], 0, 600)],
      },
    ],
  };
  const shown = shownPlanOf(previous, recommend(previous));
  const contextWith = (pending: readonly PendingOrder[]): ChangeContext => ({
    shown,
    running: [],
    now: T0 as EpochMillis,
    pending,
    presets: PRESETS,
  });
  const costOf = (schedule: CookSchedule, pending: readonly PendingOrder[]) =>
    changeCost({ schedule, recommendations: recommend(schedule) }, contextWith(pending), PARAMS);
  /** B を 1 秒遅らせる計画（A は期限切れゆえ計画に無い）。 */
  const delayed: CookSchedule = {
    slices: [{ tableKey: "t-1", placements: [placement("b", ["1"], 1, 601)] }],
  };

  it("B を 1 秒遅らせる計画：正しい文脈（A を除いた pending）では B が旧 Head で、先頭の変更 2L = 90", () => {
    expect(costOf(delayed, liveOrders([A, B], T0))).toBe(2 * L);
  });

  it("期限切れの A を文脈に残すと旧 Head は A（arms 1・1 秒早い）になり、B の先頭消失が 0 に消える", () => {
    expect(costOf(delayed, [A, B])).toBe(0);
  });

  it("期限切れの品目そのものの変更（釜・時刻）も、正しい文脈では対応が無く 0", () => {
    // A を釜 3・100 秒へ動かした計画。A を文脈に残せば釜の変更 L・時刻の移動・先頭消失が付く。
    const moved: CookSchedule = {
      slices: [
        {
          tableKey: "t-1",
          placements: [placement("a", ["3"], 100, 700), placement("b", ["1"], 0, 600)],
        },
      ],
    };
    expect(costOf(moved, liveOrders([A, B], T0))).toBe(0);
    expect(costOf(moved, [A, B])).toBeGreaterThan(0);
  });
});
