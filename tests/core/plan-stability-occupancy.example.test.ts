// tests/core/plan-stability-occupancy.example.test.ts — plan-stability 性質 5.6（同じ入力で続けて計画すると、同じ計画か総費用が
// 真に下がる計画になる）を**実占有**（`occupiedSlotsOf(running)`）で走らせたときの反例だった 4 場面を、具体的な場面として固定する。
//
// Feature: plan-stability, Property 5.6 / Requirement 6（保持候補 R）
// **Validates: Requirements plan-stability 3.1, 3.2, 5.6, 6.1, 6.2**
//
// task 3 の 2 段目（前回に忠実な候補 `Continuity.faithful` による**再生成**）では、前回の 2 段目の出力を常には再現できず、3000 場面に
// 2〜4 回、同じ入力で総費用が悪化する計画に変わった（fast-check で縮約した 4 場面）。機構は 2 つあった。
//   (a) **下限（floor）**：2 段目が 1 段目の `startAt` を下限に残し、次回の 1 段目は同じ下限を持たずに自然な時刻を見つけて業務費用を
//       改善するが、変更費用がそれを上回る（場面 D：31 秒の改善に 64 秒の変更費用。場面 A：139 秒の改善に 141 秒）。
//   (b) **取り置き（reservation）**：2 段目が後の群の「今」の固定配置の釜を手前の群に対して取り置き、次回の 1 段目は一片の順に表を
//       進めるので手前の卓が先に取り、後の単独品が「今」を失う（場面 C：先頭の消失 2L を含む 76 秒。場面 B：業務費用 40 秒悪化）。
// 保持候補 R（Requirement 6・`retain`）は前回そのものを `TimerState.shownPlan` から一片の列に**復元**し、合成と同じ述語で検証して
// 総費用で比べる（同点は前回）。4 場面すべてで R は前回の計画を保つ。

import { describe, expect, it } from "vitest";
import type { ScheduleParams } from "../../src/engine/objective";
import type { Firmness } from "../../src/domain/firmness";
import { DEFAULT_SLOT_OFFSETS, defaultUnitOrigins } from "../../src/domain/store";
import { NOW, type ItemSpec, type OrderSpec, type RunningSpec } from "./scheduleScenes";
import {
  candidatesOf,
  changeOf,
  contextOf,
  planOf,
  samePlan,
  sceneOf,
  totalOf,
  type RawScene,
} from "./restoreScenes";

/** 採点の重みをすべて 0、許容幅を最小にしたパラメータ（縮約した反例の値）。効くのは arms と L だけ。 */
function paramsOf(unitCount: number, arms: number, liftIntervalSeconds: number): ScheduleParams {
  return {
    orderSyncWeight: 0,
    tableSyncWeight: 0,
    affinityWeight: 0,
    arms,
    toleranceRatio: 1,
    orderSyncToleranceSeconds: 0,
    tableSyncToleranceSeconds: 0,
    affinityToleranceDistance: 0,
    liftIntervalSeconds,
    unitOrigins: defaultUnitOrigins(unitCount),
    slotOffsets: DEFAULT_SLOT_OFFSETS,
  };
}

/** 走行中 1 本（`timerOn` の素データ）。endOffset は NOW からのミリ秒。 */
function running(
  slot: number,
  endOffset: number,
  tableId: string | null,
  boiled = false,
): RunningSpec {
  return { slot, endOffset, boiled, tableId };
}

/** 注文 1 件。到着は NOW からのミリ秒（負）。`toPending` が並びの位置から `o-<index>` を振る。 */
function order(arrivalOffset: number, items: readonly ItemSpec[]): OrderSpec {
  return { arrivalTime: NOW + arrivalOffset, items };
}

function item(
  noodleType: "Thin" | "Medium" | "Thick",
  firmness: Firmness,
  tableId: string | null,
  slotSpan = 1,
): ItemSpec {
  return { noodleType, firmness, tableId, slotSpan };
}

/** 場面 A：12 釜・arms 1・L 5。下限の機構（業務費用 139 秒改善・変更費用 141 秒で総費用 2 秒悪化）。 */
const SCENE_A: RawScene = {
  unitCount: 2,
  params: paramsOf(2, 1, 5),
  running: [
    running(3, 145_000, null),
    running(0, 140_001, null),
    running(5, 0, null),
    running(1, 0, null),
    running(4, 233_001, null),
  ],
  orders: [
    order(-599_998, [
      item("Thin", "extraHard", "t-1", 2),
      item("Thin", "extraHard", null),
      item("Thick", "soft", "t-2"),
      item("Thick", "extraHard", "t-1"),
    ]),
    order(-599_998, [item("Thin", "extraHard", null), item("Thin", "extraHard", null)]),
    order(-599_999, [
      item("Thin", "soft", null, 2),
      item("Thin", "extraHard", "t-2", 2),
      item("Thin", "extraHard", "t-1", 2),
      item("Thin", "soft", null),
    ]),
    order(-599_999, [
      item("Medium", "normal", "t-1", 2),
      item("Thin", "extraHard", "t-2"),
      item("Thin", "extraHard", "t-2"),
      item("Thin", "extraHard", "t-1", 2),
    ]),
    order(-600_000, [
      item("Thin", "extraHard", "t-2"),
      item("Thin", "extraHard", "t-2"),
      item("Thin", "extraHard", "t-2"),
      item("Thin", "extraHard", null, 2),
    ]),
  ],
};

/**
 * 場面 B：6 釜・arms 1・L 5。取り置きの機構——前回、卓なしの o-3#1 は釜 5 に「今」。次回はその釜が卓の一片に渡らないが、
 * 1 段目で失った「今」を 2 段目が下限で戻せず、o-3#1 が 45 秒後へ動く（業務費用 40 秒悪化・変更費用 60 秒）。
 */
const SCENE_B: RawScene = {
  unitCount: 1,
  params: paramsOf(1, 1, 5),
  running: [running(4, 0, "t-1"), running(0, 50_000, "t-1")],
  orders: [
    order(-600_000, [item("Thin", "extraHard", "t-2")]),
    order(-600_000, [item("Thin", "extraHard", "t-1")]),
    order(-599_999, [
      item("Thin", "hard", "t-2"),
      item("Thin", "extraHard", "t-1"),
      item("Thin", "extraHard", null),
    ]),
    order(-599_999, [
      item("Thin", "extraHard", "t-1"),
      item("Thin", "extraHard", null),
      item("Thin", "extraHard", "t-2"),
    ]),
  ],
};

/**
 * 場面 C：6 釜・arms 1・L 5。取り置きの機構——2 段目は卓なしの o-0#2 を占有された釜 5 から釜 3 へ「今」で移し、その釜を
 * 手前の卓 t-2 に対して取り置いた。次回の 1 段目は一片の順に表を進めるので釜 3 を t-2 が先に取り、o-0#2 は 50 秒後へ。
 * 業務費用は同点のまま、先頭の消失（2L）を含む 76 秒の変更費用が付く。
 */
const SCENE_C: RawScene = {
  unitCount: 1,
  params: paramsOf(1, 1, 5),
  running: [running(5, 0, "t-1")],
  orders: [
    order(-599_999, [
      item("Thin", "extraHard", "t-2"),
      item("Medium", "soft", "t-2"),
      item("Thin", "extraHard", null),
    ]),
    order(-600_000, [
      item("Thin", "extraHard", null),
      item("Thin", "extraHard", "t-1"),
      item("Thin", "extraHard", null),
      item("Thin", "extraHard", "t-1"),
    ]),
    order(-600_000, [item("Thin", "extraHard", "t-2", 2)]),
    order(-600_000, [item("Medium", "normal", "t-1")]),
  ],
};

/**
 * 場面 D：18 釜・arms 4・L 16。下限の機構——1 段目は卓 t-1 の 3 品を 60 / 60 / 61 秒に上げ、窓 [45, 61) が埋まって卓 t-2 の
 * o-2#0 を 31 秒開始（76 秒提供）に遅らせた。2 段目は「今」の 3 品を占有された釜 0 から配り直し、t-1 は 60 / 61 / 61 秒に
 * なって窓に余りが出るが、o-2#0 は 1 段目の下限（31 秒）に留まった。次回の 1 段目は Shown_Plan の t-1 から出発して
 * o-2#0 を「今」（45 秒提供）に置ける——業務費用 31 秒の改善に、釜の変更・時刻の移動・順の逆転で 64 秒の変更費用。
 */
const SCENE_D: RawScene = {
  unitCount: 3,
  params: paramsOf(3, 4, 16),
  running: [running(0, 0, "t-1")],
  orders: [
    order(-600_000, [
      item("Thin", "extraHard", "t-1", 2),
      item("Thin", "extraHard", null),
      item("Thin", "extraHard", "t-1", 2),
    ]),
    order(-600_000, [
      item("Thin", "extraHard", null),
      item("Thin", "normal", "t-1", 2),
      item("Thick", "extraHard", null),
    ]),
    order(-600_000, [item("Thin", "extraHard", "t-2")]),
  ],
};

const SCENES: readonly (readonly [string, RawScene])[] = [
  ["A（下限・12 釜）", SCENE_A],
  ["B（取り置き・業務費用も悪化）", SCENE_B],
  ["C（取り置き・業務費用は同点）", SCENE_C],
  ["D（下限・31 秒の繰り上げ）", SCENE_D],
];

describe("Feature: plan-stability, Property 5.6 — 実占有でかつて反例だった 4 場面", () => {
  for (const [name, raw] of SCENES) {
    it(`${name}: 同じ入力で続けて計画すると同じ計画で、Change_Cost は 0（3 回目まで）`, () => {
      const scene = sceneOf(raw);
      const first = planOf(scene, null);
      const ctx = contextOf(scene, first);
      const second = planOf(scene, ctx);
      expect(second).toEqual(first);
      expect(changeOf(scene, second, ctx)).toBe(0);
      const third = planOf(scene, contextOf(scene, second));
      expect(third).toEqual(second);
    });

    it(`${name}: 保持候補 R は前回の計画そのもの（変更費用 0）で、生成候補 F に総費用で劣らない（同点は前回）`, () => {
      const scene = sceneOf(raw);
      const first = planOf(scene, null);
      const ctx = contextOf(scene, first);
      const { fresh, retained } = candidatesOf(scene, ctx);
      expect(retained).not.toBeNull();
      expect(samePlan(retained!, first)).toBe(true);
      expect(changeOf(scene, retained!, ctx)).toBe(0);
      expect(totalOf(scene, retained!, ctx)).toBeLessThanOrEqual(totalOf(scene, fresh, ctx));
    });
  }
});
