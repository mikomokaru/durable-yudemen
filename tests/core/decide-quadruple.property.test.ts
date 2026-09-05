// tests/core/decide-quadruple.property.test.ts — online-cook-scheduling の Property 10（決定性は四つ組に
// 対して立つ）・Property 11（冪等）。
//
// **decide.property.test.ts へ足さない。** あちらは yude-men-timer の Property 1 / 2 / 12 を持ち、生成器
// （generators.ts の genState）は待ち行列も採用済み計画も持たない世界を作る。四つ組の決定性はその 2 つと
// `requestedDigest` を明示的な入力として含む主張であり、場面の素材が違う（schedulingScenes.ts を要する）。
// 加えて Property 11 は**採用が起きる外部計画**を要し、あちらの生成器では一度も踏めない。
//
// **既にある「Property 12: decide は決定的」との差は 3 点である**（同じ主張を二度書いてはいない）。
//   1. 四つ組の残り 3 要素（待ち行列と開始済み Timer の対象集合・採用済み計画・`requestedDigest`）を
//      場面が実際に持つ。あちらは前二者が常に空で、指紋は常に null。
//   2. 入力を**別インスタンスへ複製して**渡す。同じ参照を二度渡す形では「内部で入力を書き換えて
//      たまたま同じ結果になる」実装を落とせない（決定性は参照の一致ではなく値の一致に対する主張である）。
//   3. 呼び出しの前後で入力そのものが不変であることも見る（隠れた破壊的変更を残さない）。
//
// 対象は `decide` である——四つ組は状態と引数の全体を指し、判定（admit）だけの主張ではない。

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide } from "../../src/engine/decide";
import { digestInput, type InputDigest } from "../../src/engine/digest";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import type { Event } from "../../src/engine/event";
import type { Outcome } from "../../src/engine/effect";
import type { SettleParams } from "../../src/engine/settle";
import {
  DEFAULT_NOODLE_PRESETS,
  SLOTS_PER_UNIT,
  UNIT_COUNT_MAX,
  UNIT_COUNT_MIN,
} from "../../src/domain/store";
import {
  KNOWN_NOODLE_TYPES,
  NOW,
  externalPlan,
  genOrderSpec,
  genParams,
  genRunning,
  shortestFirstPlan,
  timerOn,
  toPending,
} from "./scheduleScenes";
import { genScheduledScene, type ScheduledScene } from "./schedulingScenes";

/**
 * 値だけを写した別インスタンス。ブランド型・非空タプルは構造としては素の値・素の配列ゆえ複製できる
 * （`nonEmpty` が実行時検証で型を確立するのと対称に、ここは複製が値を保つことに依る）。
 */
function copyOf<T>(value: T): T {
  return structuredClone(value) as T;
}

/** 四つ組（の状態側）と、そこへ流す 1 イベント。決定性の主張が要するのはこの 3 つだけである。 */
interface QuadrupleScene {
  readonly state: TimerState;
  readonly event: Event;
  readonly params: SettleParams;
}

/** 指紋だけを差し替えた状態（他のフィールドはそのまま）。 */
function withDigest(state: TimerState, requestedDigest: InputDigest | null): TimerState {
  return { ...state, requestedDigest };
}

/** 場面に `requestedDigest` の変化を足す（null＝未要求 と 現在の入力の指紋＝抑制が効く側の双方を踏む）。 */
const genSceneWithDigest: fc.Arbitrary<QuadrupleScene> = genScheduledScene.chain(
  (scene: ScheduledScene) =>
    fc.boolean().map((requested) => ({
      state: withDigest(
        scene.state,
        requested ? digestInput(scene.state.pendingOrders, scene.state.timers, scene.params) : null,
      ),
      event: scene.event,
      params: scene.params,
    })),
);

/**
 * 計画受領の場面。改善しうる外部計画（別パラメータで組み、Table_Group を 1 つ落とす）が届く。
 *
 * **now は NOW に固定する**——now を進めると外部計画の開始時刻が過去になり（計画は NOW の
 * 解放表の上で組まれている）ハード制約 (c) が全部を落とし、採用が一度も起きない場面ばかりになる
 * （admit.property.test.ts が同じ理由で同じ固定を採っている）。
 */
const genDeliveryScene: fc.Arbitrary<QuadrupleScene> = fc
  .oneof(
    // 釜が少ない場面へ寄せる（釜が余っていれば全品目が並列に入り、順序が総和に効かない＝改善する計画が
    // 存在しない）。全域も残す——ユニット数が判定に効かないことは他の property の持ち場である。
    { arbitrary: fc.constant(UNIT_COUNT_MIN), weight: 3 },
    { arbitrary: fc.integer({ min: UNIT_COUNT_MIN, max: UNIT_COUNT_MAX }), weight: 1 },
  )
  .chain((unitCount) => {
    const slotCount = unitCount * SLOTS_PER_UNIT;
    return fc.record({
      slotCount: fc.constant(slotCount),
      arms: fc.integer({ min: 1, max: 4 }),
      toleranceRatio: fc.integer({ min: 1, max: 30 }),
      // 状態側の採点パラメータと、外部計画を組むパラメータを別に振る（両者が食い違うほど計画がずれる）。
      schedule: genParams(unitCount),
      planParams: genParams(unitCount),
      dropPick: fc.nat({ max: 12 }),
      // 計画の作り方を 2 通り振る。**茹で時間の短い順**は段 2 まで通る改善を生み、**Table_Group を
      // 1 つ落とす**手は部分和だけが改善して段 2 で落ちる場面を生む（採用と全棄却の双方を踏む）。
      shortestFirst: fc.boolean(),
      // 開始済み Timer は釜を塞ぐ。計画対象が釜を取り合う場面（改善の余地がある場面）を作る主要な手。
      running: fc.array(genRunning(slotCount), { minLength: 1, maxLength: 5 }),
      // 品目数が釜数を超える場面を多く踏む（順序が総和に効かなければ改善する計画は存在しない）。
      orders: fc.array(genOrderSpec(KNOWN_NOODLE_TYPES), { minLength: 3, maxLength: 8 }),
    });
  })
  .map((seed) => {
    const timers = seed.running.map(timerOn);
    const pending = toPending(seed.orders);
    const params: SettleParams = {
      noodlePresets: DEFAULT_NOODLE_PRESETS,
      ...seed.schedule,
      toleranceRatio: seed.toleranceRatio,
      arms: seed.arms,
    };
    const state: TimerState = {
      ...EMPTY_STATE,
      timers,
      nextSeq: timers.length,
      pendingOrders: pending,
    };
    const plan = seed.shortestFirst
      ? shortestFirstPlan(pending, timers, seed.slotCount, seed.planParams)
      : externalPlan(pending, timers, seed.slotCount, seed.planParams, seed.dropPick);
    return { state, event: { type: "PlanArrived", plan, now: NOW } satisfies Event, params };
  });

/**
 * 決定性を見る場面。**2 つの生成器の和である。**
 *
 * `genScheduledScene` は Event の 9 種すべてを振るが、その PlanArrived は自前解そのもの（同値ゆえ全棄却）
 * であり、**受領の採用経路を一度も踏まない**。採用が起きる受領は `genDeliveryScene` だけが作る——採用の
 * 側で状態を破壊的に書き換える実装は、前者だけでは見つからない。
 */
const genQuadrupleScene: fc.Arbitrary<QuadrupleScene> = fc.oneof(
  genSceneWithDigest,
  genDeliveryScene,
);

/** イベントを 1 回適用する（受領は必ず ok ゆえ、状態と Effect 列を取り出せる）。 */
function applyOnce(
  scene: QuadrupleScene,
  state: TimerState,
): { state: TimerState; effects: readonly unknown[] } {
  const outcome = decide(state, scene.event, scene.params);
  if (!outcome.ok) throw new Error("受領は拒否を持たない遷移である（生成器の不変条件違反）");
  return { state: outcome.state, effects: outcome.effects };
}

describe("engine/decide — 四つ組に対する決定性と冪等", () => {
  // Feature: online-cook-scheduling, Property: 10 — 決定性は四つ組に対して立つ
  // **Validates: Requirements 7.3**
  //
  // 同一の（対象集合, パラメータ, 採用済み計画, requestedDigest）と同一イベントについて、decide は同一の
  // 新状態と同一の Effect 列を返す。**参照ではなく値の一致で見る**——入力を別インスタンスへ複製して渡す。
  it("Property 10: 同じ四つ組と同じイベントを別インスタンスで渡しても同一の Outcome を返す", () => {
    fc.assert(
      fc.property(genQuadrupleScene, (scene) => {
        const first: Outcome = decide(scene.state, scene.event, scene.params);
        // 同じインスタンスへの再適用。入力を破壊的に触る実装なら、二度目はもう同じ四つ組を見ない。
        const again: Outcome = decide(scene.state, scene.event, scene.params);
        // 値だけを写した別インスタンス。決定性は参照の一致ではなく値の一致に対する主張である。
        const onCopies: Outcome = decide(
          copyOf(scene.state),
          copyOf(scene.event),
          copyOf(scene.params),
        );

        expect(again).toEqual(first);
        expect(onCopies).toEqual(first);
        // 新状態と Effect 列を明示的に突き合わせる（Outcome 全体の一致に埋もれさせない）。
        expect(onCopies.ok).toBe(first.ok);
        if (first.ok && onCopies.ok) {
          expect(onCopies.state).toEqual(first.state);
          expect(onCopies.effects).toEqual(first.effects);
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: online-cook-scheduling, Property: 10 — 決定性は四つ組に対して立つ（隠れた入力を作らない側面）
  // **Validates: Requirements 7.3**
  //
  // 四つ組が「明示的な入力のすべて」であるためには、decide が入力そのものを書き換えないことを要する。
  // 書き換えるなら二度目の呼び出しは別の四つ組を見ることになり、決定性の主張が成立する土台が消える。
  it("Property 10: decide は与えられた状態・イベント・パラメータを書き換えない", () => {
    fc.assert(
      fc.property(genQuadrupleScene, (scene) => {
        const pristine = {
          state: copyOf(scene.state),
          event: copyOf(scene.event),
          params: copyOf(scene.params),
        };

        decide(scene.state, scene.event, scene.params);

        expect(scene.state).toEqual(pristine.state);
        expect(scene.event).toEqual(pristine.event);
        expect(scene.params).toEqual(pristine.params);
      }),
      { numRuns: 300 },
    );
  });

  // Feature: online-cook-scheduling, Property: 11 — 計画受領の冪等
  // **Validates: Requirements 7.4**
  //
  // 同一の四つ組に同一イベントを 2 回適用した結果は、1 回適用した結果と一致する。対象は計画受領
  // （PlanArrived）——同じ計画を二度届けても二度目は何も動かない。
  //
  // 構造的な理由は改善判定である。一度目に採用された一片は、二度目には現行 Committed_Plan の対応部分和と
  // **同値**になる（`committedSchedule` が採用済み一片を engine 自身の採点でやり直すため）。同値は棄却
  // ゆえ段 1 が落とし、仮に同値を通したとしても合成後の総和が現行と同値になって段 2 が落とす（AC 6.2(d)）。
  // 一度目が全棄却だった場合も、二度目は同じ四つ組を見て同じく全棄却する。
  //
  // **変異テストの実測（記録）**: 段 1 と段 2 の同値棄却を**両方**緩めると（`>=` → `>`・`<` → `<=`）、
  // 二度目に別の一片が採用されて状態が伸び、この property は 9 件目の場面で落ちた。片方だけを緩めても
  // もう片方が落とすため通る——二重に守られていることの裏返しである。
  it("Property 11: 同じ計画を二度届けても状態は一度目のまま動かず、二度目は Effect を出さない", () => {
    fc.assert(
      fc.property(genDeliveryScene, (scene) => {
        const first = applyOnce(scene, scene.state);
        const second = applyOnce(scene, first.state);

        expect(second.state).toEqual(first.state);
        expect(second.effects).toEqual([]);
        // 全棄却は状態を触らない（返る状態が引数そのもの）。採用があった場合も二度目はこの経路へ落ちる。
        expect(second.state).toBe(first.state);
      }),
      { numRuns: 300 },
    );
  });

  // 生成器が採用の起きる場面を含むことの確認。含まなければ Property 11 は「全棄却が二度続く」だけを
  // 見ていることになり、段 1 の同値棄却が担う本題（一度採用された計画の二度目）を通らない。
  it("生成器は採用が起きる場面（一度目に Effect が出る受領）を含む", () => {
    const scenes = fc.sample(genDeliveryScene, { numRuns: 200, seed: 20_260_626 });
    const accepted = scenes.filter((scene) => applyOnce(scene, scene.state).effects.length > 0);

    // 固定 seed の実測は 200 場面中 39 件。下限は余裕を持って置く（生成器の退化を検知する番犬）。
    expect(accepted.length).toBeGreaterThanOrEqual(20);
  });
});
