// engine/order.ts — POS 由来のオーダー到着・取り消しの純粋変換。
// cloudflare:workers にも storage にも触れない。副作用なし・決定的（同じ入力に同じ出力）。
//
// 2 つの遷移を 1 ファイルに置く（fire.ts が発火と整合を並べているのと同じ形）。どちらも Timer には
// 一切触れず Order_Item 集合だけを動かす変換であり、集合操作（pending.ts）の上に「遷移」という
// 一枚を被せるだけの薄さゆえ、別々のファイルに分けても各ファイルが 1 つの式しか持たない。
//
// 拒否経路を持たない。到着の内容の検証は受け口（domain の toOrderItems と shell の receiveOrder）が
// 済ませており、キャンセルの対象不在は集合を変えない no-op である（AC 1.6）——ここに拒否を作れば
// 「POS の申告が正しいかどうか」を engine が判断することになる。変化が無ければ settle が Effect を出さない。

import type { EpochMillis } from "./types";
import type { TimerState } from "./state";
import type { Event } from "./event";
import type { Outcome } from "./effect";
import { removeOrder, upsertOrder } from "./pending";
import { settle } from "./settle";
import type { SettleParams } from "./settle";

/** OrderArrived イベントの本体。arriveOrder はこの形だけを受け取る（event.ts の唯一の出所を再利用）。 */
type OrderArrivedEvent = Extract<Event, { type: "OrderArrived" }>;

/**
 * オーダー到着の状態遷移（要件1.7 / AC 1.2 / 1.3 / 1.8）。
 *
 * upsert ひとつで新規・再送・変更のすべてを受ける（意味論の正本は pending.ts の upsertOrder）。
 * Timer の集合を渡すのは、後着に無い品目を除くかどうか（未調理だけ除く・order-lifecycle AC 2.5）を品目の状態
 * （`itemStatusOf`）で判定するため。内容が現在の集合と同一なら upsertOrder が同じ集合を返し、settle が Effect を
 * 出さない（冪等・AC 1.3）。
 *
 * `mayRequestPlan` は真——到着は計画の入力が変わる契機そのものであり、外部へ改善を求めてよい（AC 5.5）。
 */
export function arriveOrder(
  state: TimerState,
  args: OrderArrivedEvent,
  params: SettleParams,
): Outcome {
  const moved: TimerState = {
    ...state,
    orderItems: upsertOrder(state.orderItems, state.timers, args.arrival),
  };
  return settle(state, moved, params, args.now, true);
}

/**
 * オーダー取り消しの状態遷移（AC 1.5 / 1.6）。当該 External_Order_Id の未調理の品目だけを集合から除く
 * （調理中・調理済みは残す・order-lifecycle AC 2.5）。
 *
 * **Timer には触らない。** 開始済み Timer を自動キャンセルしない——釜の中の麺を外部システムの都合で
 * 消せば、現場が「無くなった理由」を確かめる手段を持たない。対応する未調理の品目が無ければ集合は変わらず、
 * settle が Effect を出さない（未到達・既に除去済み・全品目が開始済みを区別しない）。
 */
export function cancelOrder(
  state: TimerState,
  externalOrderId: string,
  now: EpochMillis,
  params: SettleParams,
): Outcome {
  const moved: TimerState = {
    ...state,
    orderItems: removeOrder(state.orderItems, state.timers, externalOrderId),
  };
  return settle(state, moved, params, now, true);
}
