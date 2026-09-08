// engine/complete.ts — ユーザーの明示完了（boiled の消し込み・早め上げ）の純粋変換。対象 Timer を除去し、参照先の
// 品目に完了の事実（completedAt）を記録して Alarm を張り直す。
// cloudflare:workers にも storage にも触れない。副作用なし・決定的（同じ入力に同じ出力）。
//
// cancel と同形（id 指定で除去）だが別概念。cancel は走行中の中断（品目は unstarted へ戻る）、complete は茹で上がりの
// 確認消し込みと早め上げ（品目は done になる・order-lifecycle 判断 3・4）。Timer の除去は snapshot 単一表現化により
// どちらも「snapshot から Timer が消える」として一様に現れ、クライアントは消えた Timer から残滓を導く。品目の側で
// 両者を分けるのは completedAt / interruptedAt の記録である。除去後の Timer 集合は元集合の部分集合であり、完了した
// Timer は二度と現れない。boiled は検査しない（走行中でも受ける・早め上げ）。

import type { EpochMillis } from "../engine/types";
import type { TimerState } from "./state";
import type { Outcome } from "./effect";
import { settle } from "./settle";
import type { SettleParams } from "./settle";
import { orderItemOf } from "../domain/order";

/**
 * タイマー明示完了の状態遷移。対象 Timer を除去し、参照先の品目に `completedAt = now` を記録し、残り running 集合全体を
 * 再同期する（本機能の要件7.2・order-lifecycle AC 1.3）。
 *
 * 対象が存在しなければ TimerNotFound を返し、状態を一切変更しない。拒否は例外ではなく戻り値。
 * 除去後の running 集合全体を settle が synchronize で再同期し、Effect 列を組む。成功時の Effect 列は
 * [Persist, (SetAlarm|ClearAlarm), Broadcast(snapshot)]（snapshot は残余 Timer の調整変化を含む全量・唯一の
 * 権威表現）。Persist を先頭に置くのは SSOT 規律の表明。
 *
 * **参照先が無ければ品目には何も書かない**（アドホック開始・v12 由来で参照先の無い Timer・判断 13 / 14）。推測で品目を
 * 作らない。一括完了は client がメンバーごとに `complete` を送るので、対象 Timer が参照していた各品目に自然に記録される。
 */
export function completeTimer(
  state: TimerState,
  timerId: string,
  now: EpochMillis,
  params: SettleParams,
): Outcome {
  const target = state.timers.find((t) => t.id === timerId);
  // 対象が存在しなければ状態不変で拒否する。
  if (target === undefined) {
    return {
      ok: false,
      rejection: {
        code: "TimerNotFound",
        message: `指定された timerId の Timer は存在しない: ${timerId}`,
      },
    };
  }
  // 対象を除去する。残存は元集合の部分集合。
  const completed = orderItemOf(target, state.orderItems);
  const moved: TimerState = {
    ...state,
    timers: state.timers.filter((t) => t.id !== timerId),
    orderItems:
      completed === null
        ? state.orderItems
        : state.orderItems.map((item) =>
            item === completed ? { ...item, completedAt: now } : item,
          ),
  };
  return settle(state, moved, params, now, true);
}
