// tests/core/expiryScenes.ts — pending-order-expiry の「混在の場面」（design Component 3・レビュー実走）を、変更費用の
// 文脈を組む 4 入口のテスト（settle / receivePlan / admit / solver）と自前解のテストが共有する。
//
// **場面。** 期限切れの旧先頭 A と、生きている次品目 B（大盛・2 釜）・C（同卓）。走行中の仲間 M（釜 0）が 600 秒に
// 上がり、B・C はその錨に合流したい。上げ窓（L 45・arms 1・上限 arms + HELPER_ARMS = 3）は M と B（span 2）で満ちるので、
// C は次の窓（645 秒）へ押される。前回の提案（Shown_Plan）は A を今の 1 秒前（釜 5）・B を今（釜 2・3）・C を 45 秒後（釜 4）。
//
// **主張。** 正しい文脈（A を除いた pending）では B が旧 Head（先頭 1 本）である。B・C を両方 45 秒後へ pack する計画は
// 業務費用を 45 秒改善する（卓の遅れ −90・待ち +45）が、先頭の変更 2L = 90 秒を払って総費用で劣る——ゆえに B は今に残る。
// 期限切れの A を文脈に残せば旧 Head は A になり（A は計画に無いので対応も無く）、pack の変更費用は 0 に消えて pack が
// 採られる（レビュー指摘：期限切れの旧先頭を文脈に残せば、生きている次品目を遅らせる計画の先頭の変更が 0 に消える）。
//
// 4 入口それぞれで「B が今に残る」ことと、pack の変更費用が 2L = 90（正しい文脈）／0（A を残した文脈）であることを見る。
// 場面を `now` から組むのは、solver が自分の時計（Date.now()）で絞るためである。

import { EMPTY_STATE, type TimerState } from "../../src/engine/state";
import type { SettleParams } from "../../src/engine/settle";
import type { CookSchedule } from "../../src/engine/schedule";
import { changeCost, type ShownPlan } from "../../src/engine/stability";
import { recommend } from "../../src/engine/recommend";
import { createTimer, type Timer } from "../../src/engine/timer";
import type { EpochMillis, NoodleType, SlotId, TimerId } from "../../src/engine/types";
import { itemKeyOf, ORDER_LIFETIME_MS, type OrderItem } from "../../src/domain/order";
import type { NoodlePreset } from "../../src/domain/store";
import { schedulingDefaults } from "../storeConfigDefaults";
import { nonEmpty } from "../nonEmpty";

export const SECOND = 1_000;

/** 茹で 600 秒の麺だけを持つ店（h_i = 60 秒・1 窓 45 秒の移動は h_i の内側）。 */
export const EXPIRY_PRESETS: readonly NoodlePreset[] = [
  { noodleType: "Long", boilSeconds: { extraHard: 600, hard: 600, normal: 600, soft: 600 } },
];

/** 1 ユニット（6 釜）・arms 1・L 45・w_table 2（既定）。Boil_Sync も arms 1（走行中は 1 本だけなので動かない）。 */
export const EXPIRY_PARAMS: SettleParams = {
  noodlePresets: EXPIRY_PRESETS,
  planner: "ts" as const,
  ...schedulingDefaults(1),
  arms: 1,
  // 許容 10%（h_i = 60 秒）を前提にした場面。既定は 5% に下がった（2026-09-07）
  toleranceRatio: 10,
};

export interface MixedScene {
  readonly now: EpochMillis;
  /** 期限切れの旧先頭（arrivalTime + 寿命 = now・ちょうど切れる）。 */
  readonly expired: OrderItem;
  /** 生きている次品目（大盛・2 釜）。正しい文脈では旧 Head。 */
  readonly next: OrderItem;
  /** 同卓の生きている品目。 */
  readonly mate: OrderItem;
  /** 正本（期限切れを含む）。 */
  readonly pending: readonly OrderItem[];
  /** 生きている待ち行列（liveOrders(pending, now) と同じ値）。 */
  readonly live: readonly OrderItem[];
  /** 走行中の仲間 M（釜 0・600 秒に上がる）。 */
  readonly running: readonly Timer[];
  /** 前回の提案：A 今の 1 秒前（釜 5）・B 今（釜 2・3）・C 45 秒後（釜 4）。 */
  readonly shown: ShownPlan;
  /** B を今に残す分割（正しい文脈の自前解）。 */
  readonly split: CookSchedule;
  /** B・C とも 45 秒後の pack（前回が無い／A を文脈に残したときの自前解）。 */
  readonly pack: CookSchedule;
  /** 走行中・正本・前回の提案を持つ状態（採用済み一片は無し）。 */
  readonly state: TimerState;
}

/** 混在の場面を `now` から組む。 */
export function mixedScene(now: EpochMillis): MixedScene {
  const item = (externalOrderId: string, arrivalTime: number, portions = 1): OrderItem => ({
    externalOrderId,
    itemIndex: 0,
    noodleType: "Long",
    firmness: "normal",
    tableId: "t-1",
    arrivalTime,
    portions,
    itemName: null,
    sizeName: null,
    completedAt: null,
    interruptedAt: null,
    tableAssignedAt: null,
  });
  const at = (seconds: number) => (now + seconds * SECOND) as EpochMillis;
  const expired = item("A", now - ORDER_LIFETIME_MS);
  const next = item("B", now - 60 * SECOND, 2);
  const mate = item("C", now - 60 * SECOND + 1);
  const running: readonly Timer[] = [
    createTimer({
      id: "m" as TimerId,
      slotIds: nonEmpty(["0" as SlotId]),
      noodleType: "Long" as NoodleType,
      firmness: "normal",
      startTime: now,
      endTime: at(600),
      seq: 0,
      orderItem: { externalOrderId: "run-m", itemIndex: 0, tableId: "t-1" },
    }),
  ];
  const shownItem = (
    order: OrderItem,
    slots: readonly string[],
    startSeconds: number,
    anchorSeconds: number | null,
    mates: readonly OrderItem[],
  ) => ({
    externalOrderId: order.externalOrderId,
    itemIndex: order.itemIndex,
    slotIds: nonEmpty(slots.map((slot) => slot as SlotId)),
    startAt: at(startSeconds),
    serveAt: at(startSeconds + 600),
    anchor: anchorSeconds === null ? null : at(anchorSeconds),
    mates: mates.map((each) => itemKeyOf(each)),
  });
  const shown: ShownPlan = [
    shownItem(expired, ["5"], -1, null, []),
    shownItem(next, ["2", "3"], 0, 600, [mate]),
    shownItem(mate, ["4"], 45, 600, [next]),
  ];
  const placement = (order: OrderItem, slots: readonly string[], startSeconds: number) => ({
    externalOrderId: order.externalOrderId,
    itemIndex: order.itemIndex,
    slotIds: nonEmpty(slots.map((slot) => slot as SlotId)),
    startAt: at(startSeconds),
    serveAt: at(startSeconds + 600),
    anchor: at(600),
  });
  const split: CookSchedule = {
    slices: [
      {
        tableKey: "t-1",
        placements: [placement(next, ["2", "3"], 0), placement(mate, ["4"], 45)],
      },
    ],
  };
  const pack: CookSchedule = {
    slices: [
      {
        tableKey: "t-1",
        placements: [placement(next, ["2", "3"], 45), placement(mate, ["4"], 45)],
      },
    ],
  };
  const pending = [expired, next, mate];
  return {
    now,
    expired,
    next,
    mate,
    pending,
    live: [next, mate],
    running,
    shown,
    split,
    pack,
    state: {
      ...EMPTY_STATE,
      timers: running,
      nextSeq: 1,
      orderItems: pending,
      shownPlan: shown,
    },
  };
}

/** 場面の文脈（旧 Shown_Plan・走行中・now）で、`pending` を対応の相手として数えた変更費用。 */
export function changeCostOf(
  schedule: CookSchedule,
  scene: MixedScene,
  pending: readonly OrderItem[],
): number {
  return changeCost(
    { schedule, recommendations: recommend(schedule) },
    {
      shown: scene.shown,
      running: scene.running,
      now: scene.now,
      pending,
      presets: EXPIRY_PRESETS,
    },
    EXPIRY_PARAMS,
  );
}

/** 配置（または推奨）を「品目と now からの開始秒」に写す。 */
export function startOffsets(
  items: readonly { readonly externalOrderId: string; readonly startAt: number }[],
  now: number,
): readonly (readonly [string, number])[] {
  return items.map((item) => [item.externalOrderId, (item.startAt - now) / SECOND] as const);
}
