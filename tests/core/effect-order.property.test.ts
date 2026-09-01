// tests/core/effect-order.property.test.ts — Property 12（Effect 列の不変条件）。
//
// 主張は 2 つ。**先頭は `Persist`** ——確定の起点は storage.put 成功のみという SSOT 規律の表明であり、
// shell が put 成功の上にのみ Alarm / Broadcast / 外部要求を立てられる形をここで保証する。
// **`RequestPlan` は末尾にのみ現れる** ——現場への反映（broadcast）を改善の投機（外部要求）より先に立てる。
//
// **末尾の主張には歯がある。** 場面の状態は `requestedDigest` が `EMPTY_STATE` の初期値（null）ゆえ、確定後の
// 入力から導く指紋と必ず食い違う。よって受領（`PlanArrived`）以外のイベントで確定結果が変わり、かつ計画対象が
// 非空であれば、settle は列の末尾に `RequestPlan` を積む。待ち行列を空に固定しない生成器はその場面を日常的に
// 踏む（seed 20260626 の 300 場面で、空でない列 156 件のうち 128 件が要求を含む——末尾の番犬がこれを守る）。
//
// **位置で検査し、`RequestPlan` が 0 件であることは主張しない。** 見たいのは要求の有無ではなく、要求が出るとき
// 現場への反映（broadcast）より後ろに立つことである。0 件を主張すれば要求が出る場面で必ず落ち、逆に件数の下限を
// property 側で主張すれば、要求が出ない正当な場面（受領の遷移・空の待ち行列・指紋が一致して抑制される遷移）で
// 落ちる。位置の主張だけが、どちらの場面でも同じ形で立つ。
//
// 列を組む場所は settle の assembleEffects ただ一つだが、主張は decide の出力に対して立てる——不変条件が
// 守られるべきなのは「shell が受け取る列」であって、内部関数の戻り値ではない。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide } from "../../src/engine/decide";
import type { Effect } from "../../src/engine/effect";
import type { SettleParams } from "../../src/engine/settle";
import { genScheduledScene, type ScheduledScene } from "./schedulingScenes";

describe("engine/settle — Effect 列の不変条件", () => {
  // Feature: online-cook-scheduling, Property: 12 — Effect 列の不変条件
  // **Validates: Requirements 5.8**
  it("Property 12: 列が空でなければ先頭は Persist・RequestPlan は末尾にのみ現れる", () => {
    fc.assert(
      fc.property(genScheduledScene, (scene: ScheduledScene) => {
        const params: SettleParams = scene.params;
        const outcome = decide(scene.state, scene.event, params);
        // 拒否は Effect 列を生まない。no-op（確定結果が変わらない）は空列で、不変条件の主張の対象外。
        if (!outcome.ok || outcome.effects.length === 0) return;

        expect(outcome.effects[0]!.type).toBe("Persist");

        // Persist は列にちょうど 1 つ（確定の起点が 2 つある列を作らない）。
        expect(outcome.effects.filter((effect: Effect) => effect.type === "Persist").length).toBe(
          1,
        );

        // RequestPlan は末尾にのみ。要求が出た場面だけに歯が立ち、出ない場面は素通りする（冒頭の注記）。
        const last = outcome.effects.length - 1;
        outcome.effects.forEach((effect: Effect, index: number) => {
          if (effect.type === "RequestPlan") expect(index).toBe(last);
        });
      }),
      { numRuns: 300 },
    );
  });

  // 生成器が RequestPlan を含む列を踏むことの確認。踏まなければ末尾の主張は空虚に通り、Property 12 は
  // 「先頭は Persist」だけを見ていることになる（生成器の退化を検知する番犬）。
  it("生成器は RequestPlan を含む Effect 列を踏む", () => {
    const scenes = fc.sample(genScheduledScene, { numRuns: 300, seed: 20_260_626 });
    const requesting = scenes.filter((scene: ScheduledScene) => {
      const outcome = decide(scene.state, scene.event, scene.params);
      return outcome.ok && outcome.effects.some((effect: Effect) => effect.type === "RequestPlan");
    });

    // 固定 seed の実測は 300 場面中 128 件。下限は余裕を持って置く。
    expect(requesting.length).toBeGreaterThanOrEqual(50);
  });
});
