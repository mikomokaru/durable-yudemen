// engine/complete.ts — ユーザーの明示完了（boiled の消し込み）の純粋変換。対象 Timer を除去し Alarm を張り直す。
// cloudflare:workers にも storage にも触れない。副作用なし・決定的（同じ入力に同じ出力）。
//
// cancel と同形（id 指定で除去）だが別概念。cancel は走行中の中断、complete は茹で上がりの確認消し込み。
// 区別はワイヤのメッセージ種別（cancelled / completed）に現れ、クライアントは completed を直前結果の
// 表示契機にする。除去後の Timer 集合は元集合の部分集合であり、完了した Timer は二度と現れない。

import type { EpochMillis } from "../engine/types";
import type { TimerState } from "./state";
import type { Outcome, Effect } from "./effect";
import { toSnapshot } from "./snapshot";
import { nextAlarmEffect } from "./alarm";
import type { ServerMessage } from "../domain/messages";

/**
 * タイマー明示完了の状態遷移。対象 Timer を除去し、残存 running から Alarm を張り直す。
 *
 * 対象が存在しなければ TimerNotFound を返し、状態を一切変更しない。拒否は例外ではなく戻り値。
 * 成功時の Effect 列は [Persist, (SetAlarm|ClearAlarm), Broadcast(completed), Reply(completed)]。Persist を
 * 先頭に置くのは SSOT 規律の表明であり、shell は put 成功の上にのみ Alarm / Broadcast を立てる。
 */
export function completeTimer(state: TimerState, timerId: string, now: EpochMillis): Outcome {
  // 対象が存在しなければ状態不変で拒否する。
  if (!state.timers.some((t) => t.id === timerId)) {
    return {
      ok: false,
      rejection: {
        code: "TimerNotFound",
        message: `指定された timerId の Timer は存在しない: ${timerId}`,
      },
    };
  }
  // 対象を除去する。残存は元集合の部分集合。
  const nextState: TimerState = {
    timers: state.timers.filter((t) => t.id !== timerId),
    nextSeq: state.nextSeq,
  };
  // completed は要求元への Reply と全 WS への Broadcast で同一内容を運ぶ（serverTime = now）。
  const completed: ServerMessage = {
    type: "completed",
    serverTime: now,
    timerId,
  };
  // 最早 Alarm の算出は必ず nextAlarmEffect を通す（running ありで SetAlarm、ゼロで ClearAlarm）。
  const effects: readonly Effect[] = [
    { type: "Persist", snapshot: toSnapshot(nextState) },
    nextAlarmEffect(nextState.timers),
    { type: "Broadcast", message: completed },
    { type: "Reply", message: completed },
  ];
  return { ok: true, state: nextState, effects };
}
