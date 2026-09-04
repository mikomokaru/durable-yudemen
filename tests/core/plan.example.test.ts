// tests/core/plan.example.test.ts — 計画受領の遷移 receivePlan（src/engine/plan.ts）の回帰テスト。
//
// admit の 2 段判定そのものは admit.example.test.ts と Property 4・5・7 が固定している。ここで固定するのは
// **遷移としての振る舞い**——採用があれば acceptedSlices だけを進めて Persist 先頭の Effect 列を出し、
// 全棄却なら状態も Effect も一切動かないこと（AC 6.5 / 6.6）。加えて受領が新たな要求の契機にならないこと
// （`RequestPlan` を出さない・指紋を書かない・AC 5.7）と、`decide` の PlanArrived 分岐がこの遷移へ
// 配線されていることを見る。
//
// **場面は「使える釜が 1 つだけ」に作る。** 釜が余っていれば全品目が並列に入り、改善する計画を作れない
// （採用の経路が踏めない）。unitCount の下限は 1 ＝ 6 釜ゆえ、5 釜を遠い未来まで走る Timer で塞ぐ。
// 塞ぐ Timer の茹で上がりは互いに十分離し、許容調整割合を 1% に置く——Boil_Sync が単独クラスタとして
// Adjustment 0 を割り当てるため、受領が Timer 集合を動かさないことを厳密な一致で言える。

import { describe, expect, it } from "vitest";
import { decide } from "../../src/engine/decide";
import { receivePlan } from "../../src/engine/plan";
import { committedSchedule } from "../../src/engine/commit";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import type { SettleParams } from "../../src/engine/settle";
import type { CookSchedule } from "../../src/engine/schedule";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import type { PendingOrder } from "../../src/domain/order";
import type { NoodlePreset } from "../../src/domain/store";
import { schedulingDefaults } from "../storeConfigDefaults";
import { nonEmpty } from "../nonEmpty";

const NOW = 1_700_000_000_000 as EpochMillis;
const SECOND = 1_000;

/** 茹で時間 600 秒と 60 秒の 2 種だけを持つ店（順序の効果だけが計画の良し悪しに出る）。 */
const PRESETS: readonly NoodlePreset[] = [
  { noodleType: "Long", boilSeconds: { extraHard: 600, hard: 600, normal: 600, soft: 600 } },
  { noodleType: "Short", boilSeconds: { extraHard: 60, hard: 60, normal: 60, soft: 60 } },
];

/** 1 ユニット（6 釜）・重みと許容幅は既定。Boil_Sync は arms 1・許容 1%（塞ぐ Timer を動かさない値）。 */
const PARAMS: SettleParams = {
  toleranceRatio: 1,
  noodlePresets: PRESETS,
  ...schedulingDefaults(1),
  arms: 1,
};

/** 釜 1〜5 を遠い未来まで塞ぐ Timer。茹で上がりを 2000 秒ずつ離し、同期の対象にならないようにする。 */
const BLOCKED: readonly Timer[] = [1, 2, 3, 4, 5].map((slot) =>
  createTimer({
    id: `t-blocked-${slot}` as TimerId,
    slotIds: nonEmpty([String(slot) as SlotId]),
    noodleType: "Long" as NoodleType,
    firmness: "normal",
    startTime: NOW,
    endTime: (NOW + (10_000 + 2_000 * slot) * SECOND) as EpochMillis,
    seq: slot,
  }),
);

/** 長い麺の A（卓 t-a）と短い麺の B（卓 t-b）。同時到着ゆえ自前解は卓 id 順に A → B と置く。 */
const LONG: PendingOrder = {
  externalOrderId: "o-long",
  itemIndex: 0,
  noodleType: "Long",
  firmness: "normal",
  tableId: "t-a",
  arrivalTime: NOW,
  slotSpan: 1,
  itemName: null,
  sizeName: null,
};
const SHORT: PendingOrder = {
  ...LONG,
  externalOrderId: "o-short",
  noodleType: "Short",
  tableId: "t-b",
};

/** 待ち行列と塞がれた釜を持つ状態（採用済み計画は無い＝確定計画は自前解そのもの）。 */
const STATE: TimerState = {
  ...EMPTY_STATE,
  timers: BLOCKED,
  nextSeq: BLOCKED.length,
  pendingOrders: [LONG, SHORT],
};

/** B（60 秒）を先に入れる計画。自前解（A → B・総和 1260）より良い（総和 720）。 */
const IMPROVING: CookSchedule = {
  slices: [
    {
      tableKey: "t-b",
      placements: [
        {
          externalOrderId: SHORT.externalOrderId,
          itemIndex: 0,
          slotIds: nonEmpty(["0" as SlotId]),
          startAt: NOW,
          serveAt: (NOW + 60 * SECOND) as EpochMillis,
        },
      ],
    },
  ],
};

/** 受領遷移へ通す。 */
function receive(state: TimerState, plan: CookSchedule) {
  return receivePlan(state, { type: "PlanArrived", plan, now: NOW }, PARAMS);
}

describe("receivePlan — 採用（AC 6.5）", () => {
  it("採用された接頭辞で acceptedSlices を更新し、Persist 先頭の Effect 列を出す", () => {
    const outcome = receive(STATE, IMPROVING);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // score は engine が算出した値（60 秒待ち）に差し替わる。
    expect(outcome.state.acceptedSlices).toEqual([IMPROVING.slices[0]!]);
    expect(outcome.effects.map((effect) => effect.type)).toEqual([
      "Persist",
      "SetAlarm",
      "Broadcast",
    ]);
  });

  it("Timer 集合・待ち行列には触れない（受領が動かすのは採用済み計画だけ・AC 9.1）", () => {
    const outcome = receive(STATE, IMPROVING);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.timers).toEqual(BLOCKED);
    expect(outcome.state.pendingOrders).toEqual(STATE.pendingOrders);
  });

  it("受領は新たな計画要求の契機にならない（RequestPlan を出さず指紋も書かない・AC 5.7）", () => {
    const outcome = receive(STATE, IMPROVING);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.effects.some((effect) => effect.type === "RequestPlan")).toBe(false);
    expect(outcome.state.requestedDigest).toBeNull();
  });

  it("配信される推奨は採用後の確定計画から導かれる（B が先・A はその後）", () => {
    const outcome = receive(STATE, IMPROVING);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const broadcast = outcome.effects.find((effect) => effect.type === "Broadcast");
    expect(broadcast?.type === "Broadcast" && broadcast.message.type === "snapshot").toBe(true);
    if (broadcast?.type !== "Broadcast" || broadcast.message.type !== "snapshot") return;
    expect(
      broadcast.message.recommendations.map((each) => [each.externalOrderId, each.startAt]),
    ).toEqual([
      [SHORT.externalOrderId, NOW],
      [LONG.externalOrderId, NOW + 60 * SECOND],
    ]);
  });
});

describe("receivePlan — 全棄却（AC 6.6）", () => {
  /** 棄却は状態を変えず Effect も出さない。返る状態が引数そのものであることまで見る。 */
  function expectUntouched(plan: CookSchedule, state: TimerState = STATE) {
    const outcome = receive(state, plan);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state).toBe(state);
    expect(outcome.effects).toEqual([]);
  }

  it("空の計画は状態を変えず Persist も Broadcast も出さない", () => {
    expectUntouched({ slices: [] });
  });

  it("現行 Committed_Plan と同値の計画を棄却する（同値は改善ではない）", () => {
    expectUntouched(committedSchedule([], STATE.pendingOrders, BLOCKED, NOW, PRESETS, PARAMS));
  });

  it("部分和は改善するが合成後の総和が悪化する計画を棄却する（段 2）", () => {
    // B を 500 秒遊ばせてから茹でる。B の待ちは改善するが、その間釜が塞がり A が遅れて総和は悪化する。
    const worse: CookSchedule = {
      slices: [
        {
          tableKey: "t-b",
          placements: [
            {
              externalOrderId: SHORT.externalOrderId,
              itemIndex: 0,
              slotIds: nonEmpty(["0" as SlotId]),
              startAt: (NOW + 500 * SECOND) as EpochMillis,
              serveAt: (NOW + 560 * SECOND) as EpochMillis,
            },
          ],
        },
      ],
    };

    expectUntouched(worse);
  });

  it("採用済みの計画と同じ計画が再び届いても棄却する（比較基準が Committed_Plan であること）", () => {
    const accepted = receive(STATE, IMPROVING);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    // 基準が Baseline_Plan なら「A → B より良い」でもう一度採用され、Persist と Broadcast が空振りする。
    expectUntouched(IMPROVING, accepted.state);
  });
});

describe("decide — PlanArrived の配線", () => {
  it("PlanArrived を receivePlan へ流す（採用が decide 経由でも成立する）", () => {
    const outcome = decide(STATE, { type: "PlanArrived", plan: IMPROVING, now: NOW }, PARAMS);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.acceptedSlices).toEqual([IMPROVING.slices[0]!]);
  });

  it("棄却された受領は decide 経由でも状態を変えない", () => {
    const outcome = decide(STATE, { type: "PlanArrived", plan: { slices: [] }, now: NOW }, PARAMS);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state).toBe(STATE);
    expect(outcome.effects).toEqual([]);
  });
});
