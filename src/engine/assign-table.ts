// engine/assign-table.ts — 店が品目の卓を決める純粋変換（2026-09-17）。
// cloudflare:workers にも storage にも触れない。副作用なし・決定的（同じ入力に同じ出力）。
//
// 品目の `tableId` を書き、`tableAssignedAt = now` を刻む。この刻印があると POS の後着は卓を上書きしない
// （pending.ts の withOrderAttributes）——店の判断は現場に近く、POS の再送で黙って戻されてはならない。
//
// **走行中 Timer の卓も書き換える**（ユーザー確定 2026-09-17・「計画にも反映」）。Timer.orderItem.tableId は計画の錨
// （同卓の上がりを揃える tableMembers）の出所で、ADR-0003 は POS の後着ではこれを据え置くと定めた。店が卓を決める
// のは POS の後着とは別の事象——「この麺はこの卓へ行く」という現場の宣言——なので、錨も追随させる。settle の
// 再同期と次の計画がこの卓で組み直す。
//
// 品目の状態は問わない（unstarted / cooking / done のどれでも書ける）。集合に無い品目だけ OrderItemNotFound。
// 同じ卓を再指定しても tableAssignedAt が進むので確定変化になる（店の判断の時刻が新しくなる）。

import type { TimerState } from "./state";
import type { Event } from "./event";
import type { Outcome } from "./effect";
import type { Timer } from "./timer";
import { refersTo, type OrderItem } from "../domain/order";
import { settle } from "./settle";
import type { SettleParams } from "./settle";

/** AssignTable イベントの本体（event.ts の唯一の出所を再利用）。 */
type AssignTableEvent = Extract<Event, { type: "AssignTable" }>;

/**
 * 卓の指定の状態遷移。対象が集合に無ければ OrderItemNotFound で状態不変。
 *
 * `mayRequestPlan` は真——卓は計画の入力（Table_Group）そのものであり、外部へ改善を求めてよい。
 */
export function assignTable(
  state: TimerState,
  args: AssignTableEvent,
  params: SettleParams,
): Outcome {
  const target = state.orderItems.find((item) => refersTo(args, item));
  if (target === undefined) {
    return {
      ok: false,
      rejection: {
        code: "OrderItemNotFound",
        message: `指定された品目は集合に無い: ${args.externalOrderId}#${args.itemIndex}`,
      },
    };
  }
  const orderItems: readonly OrderItem[] = state.orderItems.map((item) =>
    item === target ? { ...item, tableId: args.tableId, tableAssignedAt: args.now } : item,
  );
  const timers: readonly Timer[] = state.timers.map((timer) =>
    timer.orderItem !== null && refersTo(timer.orderItem, target)
      ? { ...timer, orderItem: { ...timer.orderItem, tableId: args.tableId } }
      : timer,
  );
  return settle(state, { ...state, orderItems, timers }, params, args.now, true);
}
