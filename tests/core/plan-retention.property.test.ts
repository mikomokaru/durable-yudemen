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
import { SLOTS_PER_UNIT, UNIT_COUNT_MAX, UNIT_COUNT_MIN } from "../../src/domain/store";
import {
  KNOWN_NOODLE_TYPES,
  UNKNOWN_NOODLE_TYPE,
  genOrderSpec,
  genParams,
  genRunning,
} from "./scheduleScenes";
import {
  candidatesOf,
  changeOf,
  contextOf,
  planOf,
  samePlan,
  sceneOf,
  totalOf,
  type RawScene,
  type Scene,
} from "./restoreScenes";
import type { CookSchedule } from "../../src/engine/schedule";

export const genRaw: fc.Arbitrary<RawScene> = fc
  .integer({ min: UNIT_COUNT_MIN, max: UNIT_COUNT_MAX })
  .chain((unitCount) =>
    fc.record({
      unitCount: fc.constant(unitCount),
      params: genParams(unitCount),
      running: fc.array(genRunning(unitCount * SLOTS_PER_UNIT), { maxLength: 5 }),
      orders: fc.array(genOrderSpec([...KNOWN_NOODLE_TYPES, UNKNOWN_NOODLE_TYPE]), {
        maxLength: 5,
      }),
    }),
  );

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
      fc.property(genRaw, (raw) => {
        const scene = sceneOf(raw);
        const first = planOf(scene, null);
        const second = retains(scene, first);
        retains(scene, second);
      }),
      { numRuns: 300 },
    );
  });
});
