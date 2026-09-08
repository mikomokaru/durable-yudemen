// core/cancel.ts — タイマーキャンセル（厨房の中断）の純粋変換（対象 Timer の除去・参照先への中断の記録・Alarm 張り直し）。
// cloudflare:workers にも storage にも触れない。副作用なし・決定的（同じ入力に同じ出力）。
//
// 除去後の Timer 集合は元集合の部分集合であり、キャンセルされた Timer は二度と発火対象に
// 現れない（要件6.5）。残存からの Alarm 導出は必ず nextAlarmEffect を通す（最早算出の重複を根絶）。
// 厨房の Cancel だけが品目を「調理中 → 未調理」へ戻す操作である（order-lifecycle 判断 3）——品目に書くのは
// interruptedAt（中断の事実・状態には効かない）だけで、completedAt は書かないので品目は unstarted へ戻る。

import type { EpochMillis } from "../engine/types";
import type { TimerState } from "./state";
import type { Outcome } from "./effect";
import { settle } from "./settle";
import type { SettleParams } from "./settle";
import { orderItemOf } from "../domain/order";

/**
 * タイマーキャンセルの状態遷移。対象 Timer を除去し、参照先の品目に `interruptedAt = now` を記録（上書き）し、残り running
 * 集合全体を再同期する（要件6.1 / 6.3 / 6.4 / 6.5・本機能の要件7.2・order-lifecycle AC 1.4）。
 *
 * 対象が存在しなければ TimerNotFound を返し、状態を一切変更しない（要件6.6）。拒否は例外ではなく戻り値。
 * 除去後の running 集合全体を settle が synchronize で再同期し、Effect 列を組む。成功時の Effect 列は
 * [Persist, (SetAlarm|ClearAlarm), Broadcast(snapshot)]（snapshot は残余 Timer の調整変化を含む全量・唯一の
 * 権威表現）。Persist を先頭に置くのは SSOT 規律の表明。
 * 残存ゼロなら settle 内の nextAlarmEffect が ClearAlarm を返す（要件6.4）。
 *
 * **品目の `arrivalTime` は更新しない**（判断 6）——「注文から 2 時間」を「最後にやり直した時刻から 2 時間」に変えない。
 * 期限内なら左レールと計画に再び現れ、期限外なら現れない。**参照先が無ければ何も記録しない**（アドホック開始・v12 由来で
 * 参照先の無い Timer・判断 14）。この旧 Timer を Cancel しても注文品目は戻らない（限界の明示）。
 */
export function cancelTimer(
  state: TimerState,
  timerId: string,
  now: EpochMillis,
  params: SettleParams,
): Outcome {
  const target = state.timers.find((t) => t.id === timerId);
  // 対象が存在しなければ状態不変で拒否する（要件6.6）。
  if (target === undefined) {
    return {
      ok: false,
      rejection: {
        code: "TimerNotFound",
        message: `指定された timerId の Timer は存在しない: ${timerId}`,
      },
    };
  }
  // 対象を除去する。残存は元集合の部分集合であり、除去後は発火対象に現れない（要件6.5）。
  const interrupted = orderItemOf(target, state.orderItems);
  const moved: TimerState = {
    ...state,
    timers: state.timers.filter((t) => t.id !== timerId),
    orderItems:
      interrupted === null
        ? state.orderItems
        : state.orderItems.map((item) =>
            item === interrupted ? { ...item, interruptedAt: now } : item,
          ),
  };
  return settle(state, moved, params, now, true);
}
