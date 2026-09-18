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
import { synchronize } from "../../src/engine/sync";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import { toWireSnapshot, type SettleParams } from "../../src/engine/settle";
import type { CookSchedule } from "../../src/engine/schedule";
import { EMPTY_SHOWN_PLAN } from "../../src/engine/stability";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { liveOrders, ORDER_LIFETIME_MS, type OrderItem } from "../../src/domain/order";
import type { NoodlePreset } from "../../src/domain/store";
import { schedulingDefaults } from "../storeConfigDefaults";
import { nonEmpty } from "../nonEmpty";
import { changeCostOf, EXPIRY_PARAMS, mixedScene, startOffsets } from "./expiryScenes";

const NOW = 1_700_000_000_000 as EpochMillis;
const SECOND = 1_000;

/** 茹で時間 600 秒と 60 秒の 2 種だけを持つ店（順序の効果だけが計画の良し悪しに出る）。 */
const PRESETS: readonly NoodlePreset[] = [
  { noodleType: "Long", boilSeconds: { extraHard: 600, hard: 600, normal: 600, soft: 600 } },
  { noodleType: "Short", boilSeconds: { extraHard: 60, hard: 60, normal: 60, soft: 60 } },
];

/** 1 ユニット（6 釜）・重みと許容幅は既定。Boil_Sync は arms 1・許容 1%（塞ぐ Timer を動かさない値）。 */
const PARAMS: SettleParams = {
  noodlePresets: PRESETS,
  planner: "ts" as const,
  ...schedulingDefaults(1),
  toleranceRatio: 1,
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
const LONG: OrderItem = {
  externalOrderId: "o-long",
  itemIndex: 0,
  noodleType: "Long",
  firmness: "normal",
  tableId: "t-a",
  arrivalTime: NOW,
  portions: 1,
  itemName: null,
  sizeName: null,
  completedAt: null,
  interruptedAt: null,
  tableAssignedAt: null,
};
const SHORT: OrderItem = {
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
  orderItems: [LONG, SHORT],
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
          anchor: null,
        },
      ],
    },
  ],
};

/** 受領遷移へ通す。 */
function receive(state: TimerState, plan: CookSchedule) {
  return receivePlan(state, { type: "PlanArrived", plan, now: NOW }, PARAMS);
}

describe("receivePlan — 読む集合は未調理の品目（order-lifecycle AC 4.1）", () => {
  it("一片が指す品目が調理中（自分を指す生きた Timer が在る）なら陳腐化として全棄却し、状態も Effect も動かない", () => {
    // SHORT を釜 0 で始めた Timer。品目は正本に残るが未調理ではない。
    const cookingShort = createTimer({
      id: "t-short" as TimerId,
      slotIds: nonEmpty(["0" as SlotId]),
      noodleType: "Short" as NoodleType,
      firmness: "normal",
      startTime: NOW,
      endTime: (NOW + 60 * SECOND) as EpochMillis,
      seq: BLOCKED.length,
      orderItem: { externalOrderId: SHORT.externalOrderId, itemIndex: 0, tableId: "t-b" },
    });
    const state: TimerState = {
      ...STATE,
      timers: [...BLOCKED, cookingShort],
      nextSeq: BLOCKED.length + 1,
    };
    const outcome = receive(state, IMPROVING);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state).toBe(state);
    expect(outcome.effects).toEqual([]);
  });
});

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
    expect(outcome.state.orderItems).toEqual(STATE.orderItems);
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
    expectUntouched(committedSchedule([], STATE.orderItems, BLOCKED, NOW, PRESETS, PARAMS, null));
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
              anchor: null,
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

describe("receivePlan — 採否は採用後に確定する走行中と同じ実効 endTime で判定する（レビュー指摘・2026-09-05）", () => {
  // 設定の差し替えを跨いだ状態を作る。走行中の仲間 T（卓 t-a・基底 endTime は 600 秒後）は旧設定の同期で
  // +60 秒の adjustment を持ったままだが、現行設定（許容 1%・単独クラスタ）で同期し直せば 0 に戻る。
  // 判定が旧錨（660 秒）を見て、確定が新錨（600 秒）を見れば、両者は食い違う。
  const SIBLING: Timer = createTimer({
    id: "t-sibling" as TimerId,
    slotIds: nonEmpty(["1" as SlotId]),
    noodleType: "Long" as NoodleType,
    firmness: "normal",
    startTime: NOW,
    endTime: (NOW + 600 * SECOND) as EpochMillis,
    seq: 10,
    adjustment: 60 * SECOND,
    orderItem: { externalOrderId: "o-sibling", itemIndex: 0, tableId: "t-a" },
  });
  /** 釜 2〜5 を塞ぎ、釜 1 は仲間が使う。空いているのは釜 0 だけ。 */
  const TIMERS: readonly Timer[] = [...BLOCKED.filter((t) => t.slotIds[0] !== "1"), SIBLING];

  function slice(startSeconds: number) {
    return {
      tableKey: "t-a",
      placements: [
        {
          externalOrderId: LONG.externalOrderId,
          itemIndex: 0,
          slotIds: nonEmpty(["0" as SlotId]),
          startAt: (NOW + startSeconds * SECOND) as EpochMillis,
          serveAt: (NOW + (startSeconds + 600) * SECOND) as EpochMillis,
          anchor: null,
        },
      ],
    };
  }
  /** 新錨（600 秒）に揃う配置と、旧錨（660 秒）に揃う配置。 */
  const AT_600 = slice(0);
  const AT_660 = slice(60);

  function stateWith(accepted: ReturnType<typeof slice>): TimerState {
    return {
      ...EMPTY_STATE,
      timers: TIMERS,
      nextSeq: 11,
      orderItems: [LONG],
      acceptedSlices: [accepted],
    };
  }

  it("旧錨に揃える計画は「改善」にならず棄却される（状態も Effect も動かない）", () => {
    // 旧錨で採点すれば 660 < 720（採用済みの 600 秒は 60 秒の遅れ）に見えるが、確定後の錨は 600 秒であり
    // 660 秒へ遅らせる計画は 780 へ悪化する。
    const state = stateWith(AT_600);
    const outcome = receive(state, { slices: [AT_660] });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state).toBe(state);
    expect(outcome.effects).toEqual([]);
  });

  it("旧錨に揃えた採用済み一片は、判定の前の再同期で合成が捨て、新錨に揃える外部計画は同値として棄却される", () => {
    // 逆向き。採用済みの一片は旧錨（660 秒）に揃えていた。判定は再同期後の走行中（錨 600 秒）で合成するので、
    // その一片は「合流できる品目を押し出している」として捨てられ、確定計画は自前解（600 秒に揃う）になる。
    // 届いた外部計画はそれと同値ゆえ棄却され、状態は動かない——確定計画は既に新錨に揃っている。
    const state = stateWith(AT_660);
    const outcome = receive(state, { slices: [AT_600] });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state).toBe(state);
    expect(outcome.effects).toEqual([]);
    // 再同期後の走行中で合成した確定計画は、採用済み一片ではなく新錨に揃った自前解である。
    const resynced = synchronize(state.timers, PARAMS);
    const committed = committedSchedule(
      state.acceptedSlices,
      state.orderItems,
      resynced,
      NOW,
      PARAMS.noodlePresets,
      PARAMS,
      null,
    );
    expect(committed.slices.flatMap((slice) => slice.placements).map((p) => p.serveAt)).toEqual([
      AT_600.placements[0]!.serveAt,
    ]);
  });
});

describe("receivePlan — 期限切れの品目（pending-order-expiry AC 2.3 / 2.4）", () => {
  /** 2 時間前に届いて誰も作らなかった注文（卓 t-x）。正本には残るが、生きている待ち行列には無い。 */
  const EXPIRED: OrderItem = {
    ...SHORT,
    externalOrderId: "o-expired",
    tableId: "t-x",
    arrivalTime: NOW - ORDER_LIFETIME_MS,
  };
  const WITH_EXPIRED: TimerState = { ...STATE, orderItems: [EXPIRED, LONG, SHORT] };

  function placementFor(order: OrderItem, startAt: number, boilSeconds: number) {
    return {
      externalOrderId: order.externalOrderId,
      itemIndex: order.itemIndex,
      slotIds: nonEmpty(["0" as SlotId]),
      startAt: startAt as EpochMillis,
      serveAt: (startAt + boilSeconds * SECOND) as EpochMillis,
      anchor: null,
    };
  }

  it("期限切れの品目を指す一片は計画対象と一致せず（isStale）、接頭辞ゆえ後続も道連れになって状態は動かない", () => {
    const arrived: CookSchedule = {
      slices: [
        { tableKey: "t-x", placements: [placementFor(EXPIRED, NOW, 60)] },
        IMPROVING.slices[0]!,
      ],
    };

    const outcome = receive(WITH_EXPIRED, arrived);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state).toBe(WITH_EXPIRED);
    expect(outcome.effects).toEqual([]);
  });

  it("生きている品目だけを指す一片は、期限切れの品目が正本に在っても採用され、配る待ち行列は生きている分だけ", () => {
    const outcome = receive(WITH_EXPIRED, IMPROVING);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.acceptedSlices).toEqual([IMPROVING.slices[0]!]);
    // 正本は全件のまま（性質 5.7）。snapshot は生きている待ち行列（性質 5.5）。
    expect(outcome.state.orderItems).toBe(WITH_EXPIRED.orderItems);
    const broadcast = outcome.effects.find((effect) => effect.type === "Broadcast");
    if (broadcast?.type !== "Broadcast" || broadcast.message.type !== "snapshot") {
      throw new Error("snapshot が無い");
    }
    expect(broadcast.message.orderItems).toEqual(liveOrders(WITH_EXPIRED.orderItems, NOW));
    expect(broadcast.message.orderItems).toEqual([LONG, SHORT]);
  });

  it("採用済みの一片が期限切れの品目を指していれば合成が捨て、尾部を自前解が埋める", () => {
    const state: TimerState = {
      ...WITH_EXPIRED,
      acceptedSlices: [{ tableKey: "t-x", placements: [placementFor(EXPIRED, NOW, 60)] }],
    };

    const message = toWireSnapshot(state, PARAMS, NOW);

    if (message.type !== "snapshot") throw new Error("snapshot でない");
    // 期限切れの一片は落ち、自前解（A → B・使える釜は 0 番だけ）が置く。期限切れの品目は推奨にも待ち行列にも現れない。
    expect(message.recommendations.map((each) => [each.externalOrderId, each.startAt])).toEqual([
      [LONG.externalOrderId, NOW],
      [SHORT.externalOrderId, NOW + 600 * SECOND],
    ]);
    expect(message.orderItems).toEqual([LONG, SHORT]);
  });

  describe("混在（レビュー実走）：期限切れの旧先頭を文脈から外す（AC 2.4）", () => {
    const scene = mixedScene(NOW);
    /** 現行 Committed_Plan を分割（B 今・C 45 秒後）に固定した状態。採用済み一片は採用の事実ゆえ文脈を読まない。 */
    const committedSplit: TimerState = { ...scene.state, acceptedSlices: [scene.split.slices[0]!] };
    const arrivedPack = { type: "PlanArrived", plan: scene.pack, now: NOW } as const;

    it("B・C を 45 秒後へ pack する外部計画は、業務費用 45 秒の改善が先頭の変更 2L = 90 秒に食われて棄却される", () => {
      const outcome = receivePlan(committedSplit, arrivedPack, EXPIRY_PARAMS);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.state).toBe(committedSplit);
      expect(outcome.effects).toEqual([]);
    });

    it("比較の相手が無ければ（Shown_Plan 空）同じ pack は採用される——棄却の理由が変更費用であること", () => {
      const outcome = receivePlan(
        { ...committedSplit, shownPlan: EMPTY_SHOWN_PLAN },
        arrivedPack,
        EXPIRY_PARAMS,
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.state.acceptedSlices).toEqual(scene.pack.slices);
      const broadcast = outcome.effects.find((effect) => effect.type === "Broadcast");
      if (broadcast?.type !== "Broadcast" || broadcast.message.type !== "snapshot") {
        throw new Error("snapshot が無い");
      }
      expect(startOffsets(broadcast.message.recommendations, NOW)).toEqual([
        ["B", 45],
        ["C", 45],
      ]);
    });

    it("pack の変更費用は正しい文脈（A を除いた pending）で 90、期限切れの A を残した文脈では 0", () => {
      expect(changeCostOf(scene.pack, scene, scene.live)).toBe(
        2 * EXPIRY_PARAMS.liftIntervalSeconds,
      );
      expect(changeCostOf(scene.pack, scene, scene.pending)).toBe(0);
    });
  });
});

describe("receivePlan — 未知麺種を含む卓の外部計画が採用できる（plan-stability Requirement 7・startable-placement task 3′.1）", () => {
  // Feature: plan-stability
  // **Validates: Requirements 7.4, 7.5**
  /** 卓 t-b に B と並ぶ、プリセットに無い麺種の品目（設定の差し替えを跨いで残った）。 */
  const GHOST: OrderItem = { ...SHORT, externalOrderId: "o-ghost", noodleType: "Ghost" };
  const WITH_GHOST: TimerState = { ...STATE, orderItems: [LONG, SHORT, GHOST] };
  const GHOST_PRESET: NoodlePreset = {
    noodleType: "Ghost",
    boilSeconds: { extraHard: 60, hard: 60, normal: 60, soft: 60 },
  };

  it("卓 t-b に置けない品目が在っても、置ける品目 B を正しく置く一片は採用され、状態が進む", () => {
    const outcome = receive(WITH_GHOST, IMPROVING);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state.acceptedSlices).toEqual([IMPROVING.slices[0]!]);
    expect(outcome.effects[0]?.type).toBe("Persist");
  });

  it("Ghost がプリセットに加わると同じ一片は置ける品目の欠落で落ち、状態も Effect も動かない（AC 7.5）", () => {
    const params: SettleParams = { ...PARAMS, noodlePresets: [...PRESETS, GHOST_PRESET] };
    const outcome = receivePlan(
      WITH_GHOST,
      { type: "PlanArrived", plan: IMPROVING, now: NOW },
      params,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.state).toBe(WITH_GHOST);
    expect(outcome.effects).toEqual([]);
  });
});
