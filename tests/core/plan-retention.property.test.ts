// tests/core/plan-retention.property.test.ts — plan-stability 性質 5.6 を**実占有**（`occupiedSlotsOf(running)`）で、保持候補 R
// （`retain`：Shown_Plan の復元 → retime → 一片ごとに検証 → 不正はその位置で再生成）と生成候補 F を総費用で比べる
// `baselineSchedule` そのものに対して主張する。
//
// Feature: plan-stability, Property 5.6（2026-09-07 改訂・実占有・配置の一致と Change_Cost = 0 を別々に検査）
// **Validates: Requirements plan-stability 3.1, 3.2, 5.6, 6.1, 6.2, 6.5**
//
// 同じ入力で続けて計画する——2 回目は 1 回目の計画を Shown_Plan（`shownPlanOf`）として渡す——と、**同じ計画**（配置の値と
// 一片の並びが一致）で **Change_Cost が 0** か、総費用（業務費用 ＋ 変更費用）が**真に下がる**計画になる。配置の一致と
// 変更費用 0 は別々に検査する（変更費用 0 は窓の内側の移動や遠い将来の移動を数えないので、一致から 0 は従うが 0 から一致は
// 従わない）。同じ入力なら前回の一片は（boiled の釜で待つ配置＝`cannotStart` を除いて）すべて有効で、待つ配置の置き直しも
// 同じ配置に落ちるので、R は前回そのもの（変更費用 0）。R ≤ F なら R（同点は前回）ゆえ、2 回目が前回と違うのは F が真に
// 良いときだけ。3 回目は 2 回目に対して同じ主張が成り立つ。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { KNOWN_NOODLE_TYPES, genOrderSpec } from "./scheduleScenes";
import {
  candidatesOf,
  changeOf,
  contextOf,
  contextWith,
  genRawScene,
  physicalViolationsOf,
  planOf,
  samePlan,
  sceneFrom,
  sceneOf,
  totalOf,
  type Scene,
} from "./restoreScenes";
import type { CookSchedule } from "../../src/engine/schedule";
import { boilMillisOf } from "../../src/engine/boil";
import { recommend } from "../../src/engine/recommend";
import { shownPlanOf } from "../../src/engine/stability";
import { createTimer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { headsOf, liftGroupsOf, visibleGroupsOf, type LiftItem } from "../../src/domain/lift-group";
import { itemKeyOf, type OrderItem } from "../../src/domain/order";
import { DEFAULT_NOODLE_PRESETS } from "../../src/domain/store";
import { toPending } from "./scheduleScenes";
import { nonEmpty } from "../nonEmpty";

/** 前回 `previous` を Shown_Plan にした再計画が、同じ計画（変更費用 0）か総費用が真に下がる計画であること。返すのは再計画。 */
function retains(scene: Scene, previous: CookSchedule): CookSchedule {
  const shown = contextOf(scene, previous);
  const next = planOf(scene, shown);
  if (samePlan(next, previous)) {
    expect(changeOf(scene, next, shown)).toBe(0);
  } else {
    expect(totalOf(scene, next, shown)).toBeLessThan(totalOf(scene, previous, shown));
  }
  // 選ばれた計画は生成候補 F 単独より総費用で劣らない（R ≤ F なら R・そうでなければ F そのもの）。
  const { fresh, retained } = candidatesOf(scene, shown);
  // Shown_Plan が空（前回に配置が無い）なら比較の相手が無く、R は組まれない。
  if (retained === null) expect(shown.shown).toHaveLength(0);
  expect(totalOf(scene, next, shown)).toBeLessThanOrEqual(totalOf(scene, fresh, shown));
  return next;
}

describe("Feature: plan-stability, Property 5.6 — 実占有・保持候補 R による自前解の保持", () => {
  it("2 回目は 1 回目と同じ計画（Change_Cost 0）か総費用が真に下がる計画で、F に劣らず、3 回目も 2 回目に対して同じ", () => {
    fc.assert(
      fc.property(genRawScene, (raw) => {
        const scene = sceneOf(raw);
        const first = planOf(scene, null);
        const second = retains(scene, first);
        retains(scene, second);
      }),
      { numRuns: 300 },
    );
  });
});

// ── 性質 5.11：保持は劣化しない（摂動あり）─────────────────────────────────────────────────────
//
// Feature: plan-stability, Property 5.11（2026-09-07）
// **Validates: Requirements plan-stability 5.10, 5.11, 6.1, 6.3**
//
// 摂動（2 秒の時間経過・表示の先頭の開始・新着・boiled の Complete）の後、選ばれた計画の総費用（同じ旧 Shown_Plan に対する
// 業務費用 ＋ 変更費用）は生成候補 F 単独より高くならない（選択規則から従う）。併せて選ばれた計画が物理的なハード制約を守る
// こと（5.10）を見る。実測で重要なのは改善幅に加え、R が選ばれる頻度と実際の提案変更量なので、集計して主張する。

/** 摂動の種類。 */
type Perturbation = "elapse" | "start" | "arrive" | "complete";

/** 摂動した場面。`previous` の Shown_Plan はそのまま持ち越す（遷移前の状態が持つ旧 Shown_Plan・AC 6.5）。 */
function perturb(
  scene: Scene,
  previous: CookSchedule,
  kind: Perturbation,
  arrival: readonly OrderItem[],
): Scene | null {
  const { pending, running, slotCount, params, now } = scene;
  switch (kind) {
    case "elapse":
      return sceneFrom(pending, running, slotCount, params, (now + 2_000) as EpochMillis);
    case "arrive":
      return sceneFrom([...pending, ...arrival], running, slotCount, params, now);
    case "complete": {
      const boiled = running.find((timer) => timer.boiledAt !== null);
      if (boiled === undefined) return null;
      return sceneFrom(
        pending,
        running.filter((timer) => timer !== boiled),
        slotCount,
        params,
        now,
      );
    }
    case "start": {
      // 表示の先頭（群 → 連鎖 → 全釜 idle → 先頭 arms 本）を提案の釜で始める。
      const orderByKey = new Map(pending.map((order) => [itemKeyOf(order), order]));
      const items: LiftItem[] = recommend(previous).flatMap((recommendation) => {
        const order = orderByKey.get(itemKeyOf(recommendation));
        const boilMillis = order === undefined ? null : boilMillisOf(order, DEFAULT_NOODLE_PRESETS);
        return order === undefined || boilMillis === null
          ? []
          : [{ recommendation, order, boilSeconds: boilMillis / 1000 }];
      });
      const head = headsOf(
        visibleGroupsOf(liftGroupsOf(items, now)),
        scene.occupied,
        now,
        params.arms,
      )[0];
      if (head === undefined) return null;
      const item = items.find((entry) => itemKeyOf(entry.order) === head)!;
      const timer = createTimer({
        id: `started-${head}` as TimerId,
        slotIds: nonEmpty([...item.recommendation.slotIds] as SlotId[]),
        noodleType: item.order.noodleType as NoodleType,
        firmness: item.order.firmness,
        startTime: now,
        endTime: (now + item.boilSeconds * 1000) as EpochMillis,
        seq: 10_000,
        orderItem: {
          externalOrderId: item.order.externalOrderId,
          itemIndex: item.order.itemIndex,
          tableId: item.order.tableId,
        },
      });
      return sceneFrom(
        pending.filter((order) => itemKeyOf(order) !== head),
        [...running, timer],
        slotCount,
        params,
        now,
      );
    }
  }
}

describe("Feature: plan-stability, Property 5.11 — 摂動の後も保持は劣化しない", () => {
  it("2 秒経過・先頭の開始・新着・Complete の後、選ばれた計画は F 単独に総費用で劣らず、物理的なハード制約を守る（集計つき）", () => {
    const counts = { scenes: 0, retainedChosen: 0, changeTotal: 0, changeFree: 0 };
    fc.assert(
      fc.property(
        genRawScene,
        fc.constantFrom<Perturbation>("elapse", "start", "arrive", "complete"),
        genOrderSpec(KNOWN_NOODLE_TYPES),
        (raw, kind, extra) => {
          const scene = sceneOf(raw);
          const previous = planOf(scene, null);
          const arrival = toPending([extra]).map((order) => ({
            ...order,
            externalOrderId: "o-new",
          }));
          const next = perturb(scene, previous, kind, arrival);
          if (next === null) return;
          const shown = contextWith(next, shownPlanOf(previous, recommend(previous)));
          const { fresh, retained } = candidatesOf(next, shown);
          const chosen = planOf(next, shown);
          const totalChosen = totalOf(next, chosen, shown);
          expect(totalChosen).toBeLessThanOrEqual(totalOf(next, fresh, shown));
          expect(physicalViolationsOf(next, chosen)).toEqual([]);
          if (retained !== null) expect(physicalViolationsOf(next, retained)).toEqual([]);
          counts.scenes++;
          if (retained !== null && samePlan(chosen, retained) && !samePlan(retained, fresh))
            counts.retainedChosen++;
          const change = changeOf(next, chosen, shown);
          counts.changeTotal += change;
          if (change === 0) counts.changeFree++;
        },
      ),
      { numRuns: 300 },
    );
    // 集計（主張は「集計できたこと」——値そのものは実測として tasks.md に記す）。
    expect(counts.scenes).toBeGreaterThan(0);
    expect(counts.retainedChosen).toBeGreaterThan(0);
    expect(counts.changeFree).toBeGreaterThan(0);
  });
});
