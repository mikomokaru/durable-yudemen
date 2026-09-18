// tests/core/adoptedPlanScene.ts — 外部計画が**確実に採用される**場面を共有する。
//
// この場面が要るのは 2 つの spec である。
//   - `pending-order-expiry` 性質 5.9 の前提（`order-expiry-independence.example`）——期限内側では採用され、
//     期限切れ側では全一片が `isStale` で棄却される。
//   - `order-item-truncation` 性質 5.11 の前提（`order-item-forgotten.example`）——品目が在る側では採用され、
//     その品目を**忘れた**側では卓の計画対象が空になって一片が `isStale` で落ちる。
//
// どちらも「片側は採用・片側は全棄却、それでも同期済みの走行中 Timer は等しい」という同じ形を要求する。
// **採用が起きる場面を組むのは難しい**——自前解に総費用で勝つ計画でなければ Acceptance_Gate を通らない——ので、
// 通ることが確かめられたこの一組を共有する。各テストが自前に組めば、片方だけが黙って採用されなくなり、
// 「何も起きないもの同士が等しい」に痩せても気づけない（実際 `order-item-forgotten.property` の無作為な
// `PlanArrived` は 945 scene で採用 0 件だった）。
//
// 共有するのは**場面**だけで、主張は各テストが持つ。ここに `expect` は書かないし、主張のための射影も置かない
// （実効終了の秒への変換は、それを読む一方のテストが持つ）。

import type { CookSchedule } from "../../src/engine/schedule";
import type { SettleParams } from "../../src/engine/settle";
import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import type { OrderItem } from "../../src/domain/order";
import type { NoodlePreset } from "../../src/domain/store";
import { schedulingDefaults } from "../storeConfigDefaults";
import { nonEmpty } from "../nonEmpty";

export const PLAN_NOW = 1_700_000_000_000 as EpochMillis;
export const PLAN_SECOND = 1_000;

/** 茹で時間 600 秒と 60 秒の 2 種だけを持つ店（`plan.example` と同じ）。パラメータ経由でだけ使う。 */
const ADOPTED_PLAN_PRESETS: readonly NoodlePreset[] = [
  { noodleType: "Long", boilSeconds: { extraHard: 600, hard: 600, normal: 600, soft: 600 } },
  { noodleType: "Short", boilSeconds: { extraHard: 60, hard: 60, normal: 60, soft: 60 } },
];

/** 1 ユニット・arms 2・許容 1%。近い 2 本は一つの Sync_Set に入り、遠い塞ぎ Timer は入らない。 */
export const ADOPTED_PLAN_PARAMS: SettleParams = {
  noodlePresets: ADOPTED_PLAN_PRESETS,
  planner: "ts" as const,
  ...schedulingDefaults(1),
  toleranceRatio: 1,
  arms: 2,
};

function planSceneTimer(
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
    startTime: (PLAN_NOW + startOffsetSeconds * PLAN_SECOND) as EpochMillis,
    endTime: (PLAN_NOW + endOffsetSeconds * PLAN_SECOND) as EpochMillis,
    seq,
  });
}

/**
 * 未同期の 2 本（釜 1・2、茹で 1200 秒、上がりが +1030 秒と +1033 秒——窓は各 ±12 秒で重なる）と、
 * 遠い未来まで釜 3〜5 を塞ぐ 3 本（上がりが 2000 秒ずつ離れ、同期の対象にならない）。釜 0 だけが空いている。
 *
 * **同期していない形で持つ。** 同期済みを要る側は `synchronize` を通す——「未同期なら成り立たない」ことを
 * 見るテストが在るので、同期の有無は場面ではなく各テストの選択である。
 */
export const UNSYNCED_PLAN_TIMERS: readonly Timer[] = [
  planSceneTimer("t-near-1", 1, -170, 1030, 1),
  planSceneTimer("t-near-2", 2, -167, 1033, 2),
  ...[3, 4, 5].map((slot) =>
    planSceneTimer(`t-blocked-${slot}`, slot, 0, 10_000 + 2_000 * slot, slot),
  ),
];

/** 長い麺の A（卓 t-a）。同時到着ゆえ自前解は A → B と置く（総和 1260 秒）。 */
export const PLAN_LONG_ITEM: OrderItem = {
  externalOrderId: "o-long",
  itemIndex: 0,
  noodleType: "Long",
  firmness: "normal",
  tableId: "t-a",
  arrivalTime: PLAN_NOW,
  portions: 1,
  itemName: null,
  sizeName: null,
  completedAt: null,
  interruptedAt: null,
  tableAssignedAt: null,
};

/** 短い麺の B（卓 t-b）。改善計画はこちらを先に入れる。 */
export const PLAN_SHORT_ITEM: OrderItem = {
  ...PLAN_LONG_ITEM,
  externalOrderId: "o-short",
  noodleType: "Short",
  tableId: "t-b",
};

/** B を先に入れる計画（総和 720 秒）。B が計画対象に在る側では採用される。 */
export const IMPROVING_PLAN: CookSchedule = {
  slices: [
    {
      tableKey: "t-b",
      placements: [
        {
          externalOrderId: PLAN_SHORT_ITEM.externalOrderId,
          itemIndex: 0,
          slotIds: nonEmpty(["0" as SlotId]),
          startAt: PLAN_NOW,
          serveAt: (PLAN_NOW + 60 * PLAN_SECOND) as EpochMillis,
          anchor: null,
        },
      ],
    },
  ],
};

/** 場面の状態を組む（Timer と品目集合だけを差し替える）。 */
export function planSceneState(
  timers: readonly Timer[],
  orderItems: readonly OrderItem[],
): TimerState {
  return { ...EMPTY_STATE, timers, nextSeq: timers.length, orderItems };
}
