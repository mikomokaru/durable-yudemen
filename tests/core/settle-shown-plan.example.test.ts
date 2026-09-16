// Feature: plan-stability, Component 4 — settle は確定結果の Persist にだけ Shown_Plan を載せる
// **Validates: Requirements 1.1, 1.2, 1.6, 1.7**
//
// tests/core/settle-shown-plan.example.test.ts — Shown_Plan の更新が確定結果の `Persist` にだけ伴うことを固定する。
//
// 確定変化の遷移では、Persist に載る snapshot の `shownPlan` が同じ Effect 列の Broadcast が運ぶ推奨と一致する
// （配信対象として永続確定した提案）。no-op（確定結果が直前と同一）・棄却（receivePlan の早期 return）・
// hydration（shell が toWireSnapshot を直接呼ぶ経路）では更新しない——時刻が進めば自前解の尾部が動いて導く推奨は
// 旧 Shown_Plan と違いうるが、それは配信対象として確定していない（AC 1.6）。
//
// 場面は plan.example と同じ「使える釜が 1 つだけ」——釜 1〜5 を遠い未来まで塞ぎ、自前解が時刻に依存する形に
// 置く（now が進めば残る釜 0 に置く startAt も進み、hydration と no-op が「推奨が違っても更新しない」を踏める）。

import { describe, expect, it } from "vitest";
import { settle, toWireSnapshot, type SettleParams } from "../../src/engine/settle";
import { receivePlan } from "../../src/engine/plan";
import { committedSchedule } from "../../src/engine/commit";
import { shownPlanOf, type ShownPlan } from "../../src/engine/stability";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import type { CookSchedule } from "../../src/engine/schedule";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import type { Effect } from "../../src/engine/effect";
import type { ServerMessage } from "../../src/domain/messages";
import type { OrderItem } from "../../src/domain/order";
import type { NoodlePreset } from "../../src/domain/store";
import { schedulingDefaults } from "../storeConfigDefaults";
import { nonEmpty } from "../nonEmpty";

const NOW = 1_700_000_000_000 as EpochMillis;
const SECOND = 1_000;
const LATER = (NOW + 100 * SECOND) as EpochMillis;

const PRESETS: readonly NoodlePreset[] = [
  { noodleType: "Long", boilSeconds: { extraHard: 600, hard: 600, normal: 600, soft: 600 } },
  { noodleType: "Short", boilSeconds: { extraHard: 60, hard: 60, normal: 60, soft: 60 } },
];

/** 1 ユニット（6 釜）・Boil_Sync は arms 1・許容 1%（塞ぐ Timer を動かさない値）。 */
const PARAMS: SettleParams = {
  noodlePresets: PRESETS,
  planner: "ts" as const,
  ...schedulingDefaults(1),
  toleranceRatio: 1,
  arms: 1,
};

/** 釜 1〜5 を遠い未来まで塞ぐ Timer。 */
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

const LONG: OrderItem = {
  externalOrderId: "o-long",
  itemIndex: 0,
  noodleType: "Long",
  firmness: "normal",
  tableId: "t-a",
  arrivalTime: NOW,
  slotSpan: 1,
  itemName: null,
  sizeName: null,
  completedAt: null,
  interruptedAt: null,
};
const SHORT: OrderItem = {
  ...LONG,
  externalOrderId: "o-short",
  noodleType: "Short",
  tableId: "t-b",
};

/** 塞がれた釜だけを持ち、待ち行列は空の状態（前回の提案なし）。 */
const EMPTY_QUEUE: TimerState = { ...EMPTY_STATE, timers: BLOCKED, nextSeq: BLOCKED.length };

type Snapshot = Extract<ServerMessage, { readonly type: "snapshot" }>;

function broadcastOf(effects: readonly Effect[]): Snapshot {
  const broadcast = effects.find((effect) => effect.type === "Broadcast");
  if (broadcast?.type !== "Broadcast") throw new Error("Broadcast が無い");
  const message = broadcast.message;
  if (message.type !== "snapshot") throw new Error("snapshot でない");
  return message;
}

function persistedShownPlan(effects: readonly Effect[]): ShownPlan {
  const persist = effects[0];
  if (persist?.type !== "Persist") throw new Error("Persist が先頭に無い");
  return persist.snapshot.shownPlan;
}

/** 推奨と Shown_Plan の突き合わせに使う射影（鍵・釜・開始・錨——推奨が運ぶ項目）。 */
function placementFacts(
  items: readonly {
    readonly externalOrderId: string;
    readonly itemIndex: number;
    readonly slotIds: readonly string[];
    readonly startAt: number;
    readonly anchor: number | null;
  }[],
) {
  return items.map((item) => ({
    externalOrderId: item.externalOrderId,
    itemIndex: item.itemIndex,
    slotIds: [...item.slotIds],
    startAt: item.startAt,
    anchor: item.anchor,
  }));
}

/** 待ち行列に A と B が届いた遷移（確定変化）。 */
function arrive(prev: TimerState, now: EpochMillis) {
  const outcome = settle(prev, { ...prev, orderItems: [LONG, SHORT] }, PARAMS, now, false);
  if (!outcome.ok) throw new Error("settle が拒否した");
  return outcome;
}

describe("settle — 確定結果の Persist に Shown_Plan が同乗する（AC 1.1 / 1.7）", () => {
  it("Persist の shownPlan は同じ Effect 列の Broadcast が運ぶ推奨と一致し、返る状態にも載る", () => {
    const outcome = arrive(EMPTY_QUEUE, NOW);

    const snapshot = broadcastOf(outcome.effects);
    const persisted = persistedShownPlan(outcome.effects);
    expect(persisted).toHaveLength(2);
    expect(placementFacts(persisted)).toEqual(placementFacts(snapshot.recommendations));
    // 返る状態の shownPlan も同じ値（永続と状態が食い違わない）。
    expect(outcome.state.shownPlan).toBe(persisted);
  });

  it("Persist の shownPlan は確定計画と配信した推奨から shownPlanOf で組んだものそのもの", () => {
    const outcome = arrive(EMPTY_QUEUE, NOW);

    const snapshot = broadcastOf(outcome.effects);
    const committed = committedSchedule(
      outcome.state.acceptedSlices,
      outcome.state.orderItems,
      outcome.state.timers,
      NOW,
      PRESETS,
      PARAMS,
      null,
    );
    expect(persistedShownPlan(outcome.effects)).toEqual(
      shownPlanOf(committed, snapshot.recommendations),
    );
  });

  it("比較の相手は遷移前の状態の shownPlan で、確定するのは選んだ計画の推奨（取り違えない・AC 1.7）", () => {
    const first = arrive(EMPTY_QUEUE, NOW);
    // 時刻が進んで B が（推奨より先に）開始された遷移。残る A の推奨は新しい now と走行中から導かれ、前回
    // （A が今・B は 600 秒後）とは違う。確定するのは新しい推奨で、前回のものは prev 側にだけ残る。
    const started = createTimer({
      id: "t-short" as TimerId,
      slotIds: nonEmpty(["0" as SlotId]),
      noodleType: "Short" as NoodleType,
      firmness: "normal",
      startTime: LATER,
      endTime: (LATER + 60 * SECOND) as EpochMillis,
      seq: first.state.nextSeq,
      orderItem: { externalOrderId: SHORT.externalOrderId, itemIndex: 0, tableId: "t-b" },
    });
    const moved: TimerState = {
      ...first.state,
      timers: [...first.state.timers, started],
      nextSeq: first.state.nextSeq + 1,
      orderItems: [LONG],
    };

    const second = settle(first.state, moved, PARAMS, LATER, false);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const persisted = persistedShownPlan(second.effects);
    expect(placementFacts(persisted)).toEqual(
      placementFacts(broadcastOf(second.effects).recommendations),
    );
    expect(persisted.map((item) => item.externalOrderId)).toEqual([LONG.externalOrderId]);
    expect(persisted).not.toEqual(first.state.shownPlan);
    // 遷移前の状態は触られない（比較の相手として残る）。
    expect(first.state.shownPlan.map((item) => item.externalOrderId)).toEqual([
      LONG.externalOrderId,
      SHORT.externalOrderId,
    ]);
  });
});

describe("settle — no-op・棄却・hydration では Shown_Plan を更新しない（AC 1.6）", () => {
  it("no-op（確定結果が直前と同一）は、時刻が進んで導く推奨が違っても shownPlan を prev のまま返す", () => {
    const prev = arrive(EMPTY_QUEUE, NOW).state;
    // 前提：時刻が進めば導く推奨は前回と違う（A の startAt が動く）。違わなければこの主張は空振りになる。
    const hydrated = toWireSnapshot(prev, PARAMS, LATER);
    if (hydrated.type !== "snapshot") throw new Error("snapshot でない");
    expect(placementFacts(hydrated.recommendations)).not.toEqual(placementFacts(prev.shownPlan));

    const outcome = settle(
      prev,
      { ...prev, orderItems: [...prev.orderItems] },
      PARAMS,
      LATER,
      false,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.effects).toEqual([]);
    expect(outcome.state).toBe(prev);
    expect(outcome.state.shownPlan).toBe(prev.shownPlan);
  });

  it("棄却された受領（receivePlan の早期 return）は状態を変えず、shownPlan も prev のまま", () => {
    const prev = arrive(EMPTY_QUEUE, NOW).state;
    // 現行 Committed_Plan と同値の計画は改善ではないので棄却される。
    const same: CookSchedule = committedSchedule(
      prev.acceptedSlices,
      prev.orderItems,
      prev.timers,
      NOW,
      PRESETS,
      PARAMS,
      null,
    );

    const outcome = receivePlan(prev, { type: "PlanArrived", plan: same, now: NOW }, PARAMS);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.effects).toEqual([]);
    expect(outcome.state).toBe(prev);
    expect(outcome.state.shownPlan).toBe(prev.shownPlan);
  });

  it("hydration（toWireSnapshot）は推奨を導くだけで状態を返さず、shownPlan は動かない", () => {
    const prev = arrive(EMPTY_QUEUE, NOW).state;
    const before = prev.shownPlan;

    const message = toWireSnapshot(prev, PARAMS, LATER);

    expect(message.type).toBe("snapshot");
    if (message.type !== "snapshot") return;
    // 導いた推奨は時刻が進んだ分だけ前回と違うが、配信対象として確定していない。
    expect(placementFacts(message.recommendations)).not.toEqual(placementFacts(before));
    expect(prev.shownPlan).toBe(before);
    // 確定するのは次の確定変化の Persist だけ（そのとき初めて、進んだ時刻で導いた推奨に置き換わる）。
    const next = arrive({ ...prev, orderItems: [] }, LATER).state.shownPlan;
    expect(placementFacts(next)).toEqual(placementFacts(message.recommendations));
    expect(placementFacts(next)).not.toEqual(placementFacts(before));
  });
});
