// tests/core/plan-stability-occupancy.example.test.ts — plan-stability 性質 5.6（同じ入力で続けて計画すると、同じ計画か総費用が
// 真に下がる計画になる）を**実占有**（`occupiedSlotsOf(running)`）で走らせたときの反例を、具体的な場面として固定する。
//
// Feature: plan-stability, Property 5.6 / startable-placement（2 段の計画）
// **Validates: Requirements plan-stability 3.1, 3.2, 5.6**
//
// `schedule.property` の 5.6 は占有なし（1 段目）で見ている。実占有では、前回に忠実な候補（`Continuity.faithful`）が
// `buildSchedule` による**再生成**であり、前回の 2 段目の出力を常には再現できない——ゆえに 3000 場面に 2〜4 回、同じ入力で
// 総費用が悪化する計画に変わる（性質 5.6 の反例・fast-check で縮約した 4 場面）。機構は 3 つ。
//   (a) **下限（floor）**：2 段目は 1 段目の `startAt` を下限に残す（startable-placement AC 1.8）。1 段目の窓が埋まっていて
//       遅らせた品目は、2 段目で釜が配り直されて窓が空いても下限の時刻に留まる。次回の 1 段目は Shown_Plan の配置から
//       出発するので同じ下限を持たず、自然な時刻を見つけて業務費用を改善するが、変更費用がそれを上回る（場面 D：
//       31 秒の改善に 64 秒の変更費用。場面 A：139 秒の改善に 141 秒）。
//   (b) **取り置き（reservation）**：2 段目は後の群の「今」の固定配置の釜を手前の群に対して取り置く。次回の 1 段目は一片の
//       順に表を進めるので、その釜を手前の卓が先に取り、後の単独品が「今」を失う（場面 C：業務費用は同点のまま先頭の
//       消失 2L を含む 76 秒の変更費用。場面 B：業務費用 40 秒悪化・変更費用 60 秒）。
//   (c) 前回そのもの（変更費用 0・総費用 = 業務費用）は復元すれば常に候補にできる——再生成に頼らず `TimerState.shownPlan`
//       から一片の列に戻し、合成（`livePrefix`）と同じハード制約の述語で現在の入力に対して検証し、新しく組んだ候補と
//       総費用で比べて同点なら前回を採る（規則 B・`restoreScenes.ts` の試作）。4 場面すべてで規則 B は前回の計画を保つ。
//
// 望む振る舞い（同じ計画か総費用が真に下がる）は `it.fails` で赤に固定し、機構の観測値（費用の差）は通常の `it` に置く
// ——修正が入れば前者が緑に、後者が赤になって観測を消す合図になる。

import { describe, expect, it } from "vitest";
import type { ScheduleParams } from "../../src/engine/objective";
import type { Firmness } from "../../src/domain/firmness";
import { DEFAULT_SLOT_OFFSETS, defaultUnitOrigins } from "../../src/domain/store";
import { NOW, type ItemSpec, type OrderSpec, type RunningSpec } from "./scheduleScenes";
import {
  RULE_B,
  changeOf,
  contextOf,
  planOf,
  samePlan,
  sceneOf,
  select,
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
 * なって窓に余りが出るが、o-2#0 は 1 段目の下限（31 秒）に留まる（`raiseToFloor`）。次回の 1 段目は Shown_Plan の t-1 から
 * 出発して o-2#0 を「今」（45 秒提供）に置ける——業務費用 31 秒の改善に、釜の変更・時刻の移動・順の逆転で 64 秒の変更費用。
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

interface Observed {
  readonly name: string;
  readonly raw: RawScene;
  /** 業務費用の差（前回 − 今回・秒）。負は悪化。 */
  readonly businessGain: number;
  /** 今回の計画の変更費用（秒）。 */
  readonly change: number;
}

const SCENES: readonly Observed[] = [
  { name: "A（下限・12 釜）", raw: SCENE_A, businessGain: 139, change: 141 },
  { name: "B（取り置き・業務費用も悪化）", raw: SCENE_B, businessGain: -40, change: 60 },
  { name: "C（取り置き・業務費用は同点）", raw: SCENE_C, businessGain: 0, change: 76 },
  { name: "D（下限・31 秒の繰り上げ）", raw: SCENE_D, businessGain: 31, change: 64 },
];

describe("Feature: plan-stability, Property 5.6 — 実占有での反例（同じ入力の再計画が総費用で悪化する）", () => {
  for (const { name, raw, businessGain, change } of SCENES) {
    // 望む振る舞い（`schedule.property` の 5.6 と同じ符号化を実占有で）。現状は赤。
    it.fails(`${name}: 同じ入力で続けて計画すると、同じ計画（Change_Cost 0）か総費用が真に下がる計画になる`, () => {
      const scene = sceneOf(raw);
      const first = planOf(scene, null);
      const ctx = contextOf(scene, first);
      const second = planOf(scene, ctx);
      if (changeOf(scene, second, ctx) === 0) expect(second).toEqual(first);
      else expect(totalOf(scene, second, ctx)).toBeLessThan(totalOf(scene, first, ctx));
    });

    // 【修正前の観測・5.6 が実占有で成り立てば消す】機構の値。前回そのものは変更費用 0 で、今回はそれより総費用が高い。
    it(`${name}: 観測——業務費用の差 ${businessGain} 秒・変更費用 ${change} 秒で、前回（変更費用 0）より総費用が高い`, () => {
      const scene = sceneOf(raw);
      const first = planOf(scene, null);
      const ctx = contextOf(scene, first);
      const second = planOf(scene, ctx);
      expect(changeOf(scene, first, ctx)).toBe(0);
      expect(totalOf(scene, first, null) - totalOf(scene, second, null)).toBe(businessGain);
      expect(changeOf(scene, second, ctx)).toBe(change);
      expect(totalOf(scene, second, ctx)).toBeGreaterThan(totalOf(scene, first, ctx));
      // 3 回目は 2 回目に落ち着く（振動はしない）。
      const third = planOf(scene, contextOf(scene, second));
      expect(third).toEqual(second);
    });

    // 規則 B（復元 → 検証 → 総費用で比較・同点は前回）：前回の計画は現在の入力に対して全一片が有効で、そのまま残る。
    it(`${name}: 規則 B は前回の計画を復元して保つ（落ちる一片は無く、総費用は前回以下・変更費用 0）`, () => {
      const scene = sceneOf(raw);
      const first = planOf(scene, null);
      const ctx = contextOf(scene, first);
      const selected = select(scene, ctx, RULE_B);
      expect(selected.dropped).toEqual([]);
      expect(selected.chosen).toBe("R");
      expect(samePlan(selected.plan, first)).toBe(true);
      expect(changeOf(scene, selected.plan, ctx)).toBe(0);
      // 現行の候補（前回の文脈つきの再生成）と比べても前回が勝つ。
      const regenerated = planOf(scene, ctx);
      expect(selected.totalR).toBeLessThan(totalOf(scene, regenerated, ctx));
    });
  }
});
