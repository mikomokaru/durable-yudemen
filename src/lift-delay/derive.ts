// 遅延記録の純粋導出（lift-delay-log 要件 1・2）。
//
// **二つの時点を混ぜない。** 開始文脈は「開始が確定する直前」の断面で、終端記録は「終端の操作を
// 適用する直前」の Timer から作る。どちらも後から現在の状態で埋め直さない——埋め直せば、遅れの
// 条件別分析が観測時点の状態に引きずられる（要件 2.1・2.6）。
//
// 作用を持たない。時刻も乱数も呼ばず、shell が採った値を受け取るだけである。

import { adjustedEndTime } from "../engine/project";
import type { Timer } from "../engine/timer";
import type { OrderItem } from "../domain/order";
import type { ShownPlan } from "../engine/stability";
import {
  LIFT_DELAY_PAYLOAD_VERSION,
  LIFT_DELAY_RECORD_TYPE,
  LIFT_DELAY_START_RECORD_TYPE,
  liftDelayEventId,
  liftDelayStartEventId,
  type LiftDelayRecord,
  type LiftDelayStartContext,
  type LiftDelayStartRecord,
  type ShownPlacement,
  type TerminalOutcome,
} from "./record";

/** 開始が確定する直前に shell が渡す断面。件数はここで数え終わっている。 */
export interface StartObservation {
  readonly startedAt: number;
  /** 開始しようとしている品目。アドホック開始では null。 */
  readonly orderItem: Pick<OrderItem, "externalOrderId" | "itemIndex"> | null;
  /** 開始直前の未着手品目（`pendingOrders` の結果そのまま）。 */
  readonly pending: readonly Pick<OrderItem, "externalOrderId" | "itemIndex">[];
  /** 開始直前の稼働 Timer。数えるのは釜の識別子だけなので、素の文字列で受ける。 */
  readonly activeTimers: readonly { readonly slotIds: readonly string[] }[];
  /** 開始直前に永続していた提案。 */
  readonly shownPlan: ShownPlan;
}

function sameItem(
  left: Pick<OrderItem, "externalOrderId" | "itemIndex">,
  right: Pick<OrderItem, "externalOrderId" | "itemIndex">,
): boolean {
  return left.externalOrderId === right.externalOrderId && left.itemIndex === right.itemIndex;
}

/**
 * 提案の中の自分の配置。**見つからないことを「単独群だった」と読まない**（要件 2.3）。
 *
 * `mates` の数だけを持つ。品目の鍵をそのまま運べば、提案の全量を記録へ写すことになり、
 * 記録が過去の提案の複製になる。ここで要るのは「何人の群として提案されていたか」だけである。
 */
function placementOf(
  shownPlan: ShownPlan,
  orderItem: Pick<OrderItem, "externalOrderId" | "itemIndex"> | null,
): ShownPlacement {
  if (orderItem === null) return { kind: "absent" };
  const shown = shownPlan.find((item) => sameItem(item, orderItem));
  if (shown === undefined) return { kind: "absent" };
  return {
    kind: "found",
    startAt: shown.startAt,
    serveAt: shown.serveAt,
    mates: shown.mates.length,
  };
}

/**
 * 開始時点の文脈を作る。
 *
 * 未着手の件数は `pendingOrders` が返した集合の大きさをそのまま使う。**計画対象の先頭 64 件へ
 * 絞った後の数を使わない**（要件 2.2）——絞りは計画の都合であって、厨房が抱えている数ではない。
 */
export function startContextOf(observation: StartObservation): LiftDelayStartContext {
  const occupiedSlotCount = new Set(observation.activeTimers.flatMap((timer) => [...timer.slotIds]))
    .size;

  return {
    kind: "recorded",
    startedAt: observation.startedAt,
    source: observation.orderItem === null ? "ad-hoc" : "order-item",
    pendingBeforeStart: observation.pending.length,
    // 対象自身を除いた数。対象が未着手に含まれていなければ全体と同じになる。
    pendingOtherItems: observation.pending.filter(
      (item) => observation.orderItem === null || !sameItem(item, observation.orderItem),
    ).length,
    activeTimerCount: observation.activeTimers.length,
    occupiedSlotCount,
    shownPlacement: placementOf(observation.shownPlan, observation.orderItem),
    appliedWait: { kind: "not-introduced" },
  };
}

/**
 * 開始の瞬間に出す 1 行を作る。**業務の保存には触れない**——ここで出し切るので、完了まで
 * どこかへ預ける必要が無い（要件 2.1・4.4）。
 */
export function startRecordOf(
  storeId: string,
  timerId: string,
  observation: StartObservation,
): LiftDelayStartRecord {
  const context = startContextOf(observation);
  if (context.kind !== "recorded") {
    // startContextOf は常に recorded を返す。型の網羅のためだけの枝で、到達しない。
    throw new Error("start context must be recorded");
  }
  return {
    recordType: LIFT_DELAY_START_RECORD_TYPE,
    payloadVersion: LIFT_DELAY_PAYLOAD_VERSION,
    eventId: liftDelayStartEventId(storeId, timerId),
    storeId,
    timerId,
    startedAt: context.startedAt,
    source: context.source,
    pendingBeforeStart: context.pendingBeforeStart,
    pendingOtherItems: context.pendingOtherItems,
    activeTimerCount: context.activeTimerCount,
    occupiedSlotCount: context.occupiedSlotCount,
    shownPlacement: context.shownPlacement,
    appliedWait: context.appliedWait,
    // 注文由来なら品目への参照を載せる。アドホック開始は注文が無いので null（版 1 の「未記録」とは
    // `source` で分かれる・`record.ts` の該当箇所）。
    orderItem:
      observation.orderItem === null
        ? null
        : {
            externalOrderId: observation.orderItem.externalOrderId,
            itemIndex: observation.orderItem.itemIndex,
          },
  };
}

/** 終端の操作を適用する直前に shell が渡す断面。 */
export interface TerminalObservation {
  readonly storeId: string;
  /** 除去される直前の Timer。ここから実効予定時刻を取る。 */
  readonly timer: Timer;
  readonly outcome: TerminalOutcome;
  /** 当該 decide へ渡したサーバ now。壁時計を再採取しない。 */
  readonly terminalAt: number;
}

/**
 * 終端記録を作る。
 *
 * `dueAt` は `adjustedEndTime` から取る。画面の残り時間と同じ出所であり、Alarm の実発火時刻でも
 * 未調整の `endTime` でもない（要件 1.3）。差はここでは計算しない。
 */
export function terminalRecordOf(observation: TerminalObservation): LiftDelayRecord {
  const { timer, outcome } = observation;
  return {
    recordType: LIFT_DELAY_RECORD_TYPE,
    payloadVersion: LIFT_DELAY_PAYLOAD_VERSION,
    eventId: liftDelayEventId(observation.storeId, timer.id, outcome),
    storeId: observation.storeId,
    timerId: timer.id,
    outcome,
    startedAt: timer.startTime,
    dueAt: adjustedEndTime(timer),
    terminalAt: observation.terminalAt,
    noodleType: timer.noodleType,
    firmness: timer.firmness,
    slotIds: timer.slotIds,
  };
}
