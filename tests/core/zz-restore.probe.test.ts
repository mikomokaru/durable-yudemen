// tests/core/zz-restore.probe.test.ts — plan-stability 性質 5.6 を**実占有**で、前回の提案を復元する規則（規則 B）の
// 試作（`restoreScenes.ts`）に対して主張する。src は変えない——現行の `baselineSchedule` では同じ主張が 3000 場面に
// 2〜4 回破れる（`plan-stability-occupancy.example` に 4 場面を固定）。
//
// Feature: plan-stability, Property 5.6（実占有・復元による保持）
// **Validates: Requirements plan-stability 3.1, 3.2, 5.6**
//
// 規則 B：前回の計画（Shown_Plan）を `TimerState.shownPlan` の形から一片の列に**復元**し、合成（`livePrefix`）と同じ述語
// （`isStale`（置ける品目に限る）/ `cannotStart` / 解放表 / `keepsAnchor` / `withinLiftCap`）で現在の入力に対して一片ずつ
// 検証する。不正な一片は**その位置で**その卓の現在の品目を自前解に置き直させ（inplace）、続きを検証する。こうして得た
// 候補 R と、現行の自前解（前回の文脈つきの再生成）F を総費用（業務費用 ＋ 変更費用）で比べ、R ≤ F なら R（同点は前回）。
//   - 同じ入力なら前回の一片は（boiled の釜で待つ配置＝`cannotStart` を除いて）すべて有効で、待つ配置の置き直しも同じ
//     配置に落ちるので、R は前回そのもの（変更費用 0）。2 回目は 1 回目と同じ計画か、F が真に良いときだけ F。
//   - 2 回目は現行の再生成 F と比べて総費用で劣らない（R ≤ F または F そのもの）。
//   - 3 回目は 2 回目と同じ（落ち着く）。

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

const genRaw: fc.Arbitrary<RawScene> = fc
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

describe("Feature: plan-stability, Property 5.6 — 実占有・前回の提案を復元する規則 B", () => {
  it("2 回目は 1 回目と同じ計画（Change_Cost 0）か総費用が真に下がる計画で、現行の再生成に劣らず、3 回目は 2 回目と同じ", () => {
    fc.assert(
      fc.property(genRaw, (raw) => {
        const scene = sceneOf(raw);
        const first = planOf(scene, null);
        const ctx1 = contextOf(scene, first);
        const selected = select(scene, ctx1, RULE_B);
        const second = selected.plan;
        // 同じ入力で落ちる一片は boiled の釜で待つ配置（意図した待ち・AC 1.4）と、その置き直しが空けた釜の取り合いだけ。
        for (const { reason } of selected.dropped)
          expect(["cannotStart", "release", "anchor"]).toContain(reason);
        if (samePlan(first, second)) expect(changeOf(scene, second, ctx1)).toBe(0);
        else expect(totalOf(scene, second, ctx1)).toBeLessThan(totalOf(scene, first, ctx1));
        expect(totalOf(scene, second, ctx1)).toBeLessThanOrEqual(
          totalOf(scene, planOf(scene, ctx1), ctx1),
        );
        const third = select(scene, contextOf(scene, second), RULE_B).plan;
        expect(third).toEqual(second);
      }),
      { numRuns: 300 },
    );
  });
});
