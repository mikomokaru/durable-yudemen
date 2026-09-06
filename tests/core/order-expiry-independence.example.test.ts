// tests/core/order-expiry-independence.example.test.ts — 性質 5.9（注文期限からの独立）の前提「Timer は現在の設定で
// 同期済み」を、前提を外したときの反例と共に残す。
//
// Feature: pending-order-expiry, Property 5.9 / Requirement 4
// **Validates: Requirements 4.1, 4.2, 5.9**
//
// レビュー実走（2026-09-06）。同じ Timer・設定・時刻・受領計画で、待ち行列の期限だけを変えると：
//   - 同期前の実効終了：+1030 秒 / +1033 秒（設定変更の直後の形——現在の設定なら 1031.5 秒に揃うはず）
//   - 期限内側：改善計画を採用し、settle の再同期で両方 +1031.5 秒
//   - 期限切れ側：全一片が isStale で棄却され、元の状態を返す——+1030 秒 / +1033 秒のまま
// これは既存の「全棄却なら状態不変」の正しい帰結であり、棄却を再同期させる修正は要らない。独立性の主張は同期済みの
// 入力に限る（`order-expiry-independence.property` の前提）。同期済みなら採用側の再同期は恒等で、両状態の Timer は等しい。

import { describe, expect, it } from "vitest";
import { receivePlan } from "../../src/engine/plan";
import { adjustedEndTime } from "../../src/engine/project";
import type { CookSchedule } from "../../src/engine/schedule";
import type { SettleParams } from "../../src/engine/settle";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import { synchronize } from "../../src/engine/sync";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { ORDER_LIFETIME_MS, type PendingOrder } from "../../src/domain/order";
import type { NoodlePreset } from "../../src/domain/store";
import { schedulingDefaults } from "../storeConfigDefaults";
import { nonEmpty } from "../nonEmpty";

const NOW = 1_700_000_000_000 as EpochMillis;
const SECOND = 1_000;

/** 茹で時間 600 秒と 60 秒の 2 種だけを持つ店（`plan.example` と同じ）。 */
const PRESETS: readonly NoodlePreset[] = [
  { noodleType: "Long", boilSeconds: { extraHard: 600, hard: 600, normal: 600, soft: 600 } },
  { noodleType: "Short", boilSeconds: { extraHard: 60, hard: 60, normal: 60, soft: 60 } },
];

/** 1 ユニット・arms 2・許容 1%。近い 2 本は一つの Sync_Set に入り、遠い塞ぎ Timer は入らない。 */
const PARAMS: SettleParams = {
  noodlePresets: PRESETS,
  ...schedulingDefaults(1),
  toleranceRatio: 1,
  arms: 2,
};

function timer(
  id: string,
  slot: number,
  startOffsetSeconds: number,
  endOffsetSeconds: number,
  seq: number,
): Timer {
  return createTimer({
    id: id as TimerId,
    slotIds: nonEmpty([String(slot) as SlotId]),
    noodleType: "Long" as NoodleType,
    firmness: "normal",
    startTime: (NOW + startOffsetSeconds * SECOND) as EpochMillis,
    endTime: (NOW + endOffsetSeconds * SECOND) as EpochMillis,
    seq,
  });
}

/**
 * 未同期の 2 本（釜 1・2、茹で 1200 秒、上がりが +1030 秒と +1033 秒——窓は各 ±12 秒で重なる）と、遠い未来まで釜 3〜5 を
 * 塞ぐ 3 本（上がりが 2000 秒ずつ離れ、同期の対象にならない）。釜 0 だけが空いている。
 */
const UNSYNCED: readonly Timer[] = [
  timer("t-near-1", 1, -170, 1030, 1),
  timer("t-near-2", 2, -167, 1033, 2),
  ...[3, 4, 5].map((slot) => timer(`t-blocked-${slot}`, slot, 0, 10_000 + 2_000 * slot, slot)),
];

/** 長い麺の A（卓 t-a）と短い麺の B（卓 t-b）。同時到着ゆえ自前解は A → B と置く（総和 1260 秒）。 */
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

/** B を先に入れる計画（総和 720 秒）。生きている待ち行列では採用される。 */
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

function stateWith(timers: readonly Timer[], pending: readonly PendingOrder[]): TimerState {
  return { ...EMPTY_STATE, timers, nextSeq: timers.length, pendingOrders: pending };
}

/** 待ち行列の arrivalTime だけを寿命以上過去へ動かす（Timer・設定・時刻・計画は同じ）。 */
function expiredOf(pending: readonly PendingOrder[]): readonly PendingOrder[] {
  return pending.map((order) => ({
    ...order,
    arrivalTime: order.arrivalTime - ORDER_LIFETIME_MS - SECOND,
  }));
}

const endSeconds = (timers: readonly Timer[]) =>
  timers.slice(0, 2).map((t) => (adjustedEndTime(t) - NOW) / SECOND);

describe("性質 5.9 の前提——Timer は現在の設定で同期済み（pending-order-expiry Requirement 4）", () => {
  it("未同期の Timer では成り立たない：採用側だけが再同期し（+1031.5 秒 × 2）、全棄却側は元の状態のまま（+1030 / +1033 秒）", () => {
    expect(endSeconds(UNSYNCED)).toEqual([1030, 1033]);

    const alive = receivePlan(
      stateWith(UNSYNCED, [LONG, SHORT]),
      { type: "PlanArrived", plan: IMPROVING, now: NOW },
      PARAMS,
    );
    const expired = receivePlan(
      stateWith(UNSYNCED, expiredOf([LONG, SHORT])),
      { type: "PlanArrived", plan: IMPROVING, now: NOW },
      PARAMS,
    );
    if (!alive.ok || !expired.ok) throw new Error("受領は拒否されない");

    // 生きている側：採用され、settle が Timer を再同期する。
    expect(alive.effects.length).toBeGreaterThan(0);
    expect(endSeconds(alive.state.timers)).toEqual([1031.5, 1031.5]);
    // 期限切れ側：一片が isStale で落ちて全棄却——状態は変わらず、再同期もしない（既存の規則の正しい帰結）。
    expect(expired.effects).toEqual([]);
    expect(endSeconds(expired.state.timers)).toEqual([1030, 1033]);
    expect(alive.state.timers).not.toEqual(expired.state.timers);
  });

  it("同期済みの Timer なら成り立つ：採用側の再同期は恒等で、両状態の Timer は等しい", () => {
    const synced = synchronize(UNSYNCED, PARAMS);
    expect(endSeconds(synced)).toEqual([1031.5, 1031.5]);

    const alive = receivePlan(
      stateWith(synced, [LONG, SHORT]),
      { type: "PlanArrived", plan: IMPROVING, now: NOW },
      PARAMS,
    );
    const expired = receivePlan(
      stateWith(synced, expiredOf([LONG, SHORT])),
      { type: "PlanArrived", plan: IMPROVING, now: NOW },
      PARAMS,
    );
    if (!alive.ok || !expired.ok) throw new Error("受領は拒否されない");

    expect(alive.effects.length).toBeGreaterThan(0);
    expect(expired.effects).toEqual([]);
    expect(alive.state.timers).toEqual(expired.state.timers);
    expect(alive.state.timers.map(adjustedEndTime)).toEqual(
      expired.state.timers.map(adjustedEndTime),
    );
  });
});
