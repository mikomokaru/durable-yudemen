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
import { synchronize } from "../../src/engine/sync";
import type { Timer } from "../../src/engine/timer";
import { ORDER_LIFETIME_MS, type OrderItem } from "../../src/domain/order";
import {
  ADOPTED_PLAN_PARAMS,
  IMPROVING_PLAN,
  PLAN_LONG_ITEM,
  PLAN_NOW,
  PLAN_SECOND,
  PLAN_SHORT_ITEM,
  planSceneEndSeconds,
  planSceneState,
  UNSYNCED_PLAN_TIMERS,
} from "./adoptedPlanScene";

// 場面（プリセット・パラメータ・塞ぎ Timer・LONG / SHORT・改善計画）は `adoptedPlanScene.ts` を共有する
// ——`order-item-truncation` 性質 5.11 の前提も同じ形を要るためで、採用が起きる場面を各テストが自前に
// 組めば、片方だけが黙って採用されなくなっても気づけない。ここが持つのは主張だけである。
const NOW = PLAN_NOW;
const SECOND = PLAN_SECOND;
const PARAMS = ADOPTED_PLAN_PARAMS;
const UNSYNCED = UNSYNCED_PLAN_TIMERS;
const LONG = PLAN_LONG_ITEM;
const SHORT = PLAN_SHORT_ITEM;
const IMPROVING = IMPROVING_PLAN;

/** 待ち行列の arrivalTime だけを寿命以上過去へ動かす（Timer・設定・時刻・計画は同じ）。 */
function expiredOf(pending: readonly OrderItem[]): readonly OrderItem[] {
  return pending.map((order) => ({
    ...order,
    arrivalTime: order.arrivalTime - ORDER_LIFETIME_MS - SECOND,
  }));
}

const endSeconds = (timers: readonly Timer[]) => planSceneEndSeconds(timers, adjustedEndTime);

describe("性質 5.9 の前提——Timer は現在の設定で同期済み（pending-order-expiry Requirement 4）", () => {
  it("未同期の Timer では成り立たない：採用側だけが再同期し（+1031.5 秒 × 2）、全棄却側は元の状態のまま（+1030 / +1033 秒）", () => {
    expect(endSeconds(UNSYNCED)).toEqual([1030, 1033]);

    const alive = receivePlan(
      planSceneState(UNSYNCED, [LONG, SHORT]),
      { type: "PlanArrived", plan: IMPROVING, now: NOW },
      PARAMS,
    );
    const expired = receivePlan(
      planSceneState(UNSYNCED, expiredOf([LONG, SHORT])),
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
      planSceneState(synced, [LONG, SHORT]),
      { type: "PlanArrived", plan: IMPROVING, now: NOW },
      PARAMS,
    );
    const expired = receivePlan(
      planSceneState(synced, expiredOf([LONG, SHORT])),
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
