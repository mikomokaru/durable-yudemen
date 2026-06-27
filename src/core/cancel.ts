// core/cancel.ts — タイマーキャンセルの純粋変換（対象 Timer の除去・Alarm 張り直し）。
// cloudflare:workers にも storage にも触れない。副作用なし・決定的（同じ入力に同じ出力）。
//
// 除去後の Timer 集合は元集合の部分集合であり、キャンセルされた Timer は二度と発火対象に
// 現れない（要件6.5）。残存からの Alarm 導出は必ず nextAlarmEffect を通す（最早算出の重複を根絶）。

import type { EpochMillis } from "./types";
import type { TimerState } from "./state";
import type { Outcome, Effect } from "./effect";
import { toSnapshot } from "./snapshot";
import { nextAlarmEffect } from "./alarm";
import type { ServerMessage } from "../shared/messages";

/**
 * タイマーキャンセルの状態遷移。対象 Timer を除去し、残存から Alarm を張り直す（要件6.1 / 6.3 / 6.4 / 6.5）。
 *
 * 対象が存在しなければ TimerNotFound を返し、状態を一切変更しない（要件6.6）。拒否は例外ではなく戻り値。
 * 成功時の Effect 列は [Persist, (SetAlarm|ClearAlarm), Broadcast(cancelled), Reply(cancelled)]。Persist を
 * 先頭に置くのは SSOT 規律の表明であり、shell は put 成功の上にのみ Alarm / Broadcast を立てる。
 * 残存ゼロなら nextAlarmEffect が ClearAlarm を返す（要件6.4）。
 */
export function cancelTimer(state: TimerState, timerId: string, now: EpochMillis): Outcome {
  // 対象が存在しなければ状態不変で拒否する（要件6.6）。
  if (!state.timers.some((t) => t.id === timerId)) {
    return {
      ok: false,
      rejection: {
        code: "TimerNotFound",
        message: `指定された timerId の Timer は存在しない: ${timerId}`,
      },
    };
  }
  // 対象を除去する。残存は元集合の部分集合であり、除去後は発火対象に現れない（要件6.5）。
  const nextState: TimerState = {
    timers: state.timers.filter((t) => t.id !== timerId),
    nextSeq: state.nextSeq,
  };
  // cancelled は要求元への Reply と全 WS への Broadcast で同一内容を運ぶ（serverTime = now）。
  const cancelled: ServerMessage = {
    type: "cancelled",
    serverTime: now,
    timerId,
  };
  // 最早 Alarm の算出は必ず nextAlarmEffect を通す（残存ありで SetAlarm、ゼロで ClearAlarm）。
  const effects: readonly Effect[] = [
    { type: "Persist", snapshot: toSnapshot(nextState) },
    nextAlarmEffect(nextState.timers),
    { type: "Broadcast", message: cancelled },
    { type: "Reply", message: cancelled },
  ];
  return { ok: true, state: nextState, effects };
}
