// engine/complete.ts — ユーザーの明示完了（boiled の消し込み）の純粋変換。対象 Timer を除去し Alarm を張り直す。
// cloudflare:workers にも storage にも触れない。副作用なし・決定的（同じ入力に同じ出力）。
//
// cancel と同形（id 指定で除去）だが別概念。cancel は走行中の中断、complete は茹で上がりの確認消し込み。
// かつては区別をワイヤの意味論メッセージ（cancelled / completed）で運んでいたが、snapshot 単一表現化により
// どちらも「snapshot から Timer が消える」として一様に現れる。クライアントは消えた Timer から残滓を導く。
// 除去後の Timer 集合は元集合の部分集合であり、完了した Timer は二度と現れない。

import type { EpochMillis } from "../engine/types";
import type { TimerState } from "./state";
import type { Outcome } from "./effect";
import { settle } from "./settle";
import type { SyncParams } from "./sync";

/**
 * タイマー明示完了の状態遷移。対象 Timer を除去し、残り running 集合全体を再同期する（本機能の要件7.2）。
 *
 * 対象が存在しなければ TimerNotFound を返し、状態を一切変更しない。拒否は例外ではなく戻り値。
 * 除去後の running 集合全体を settle が synchronize で再同期し、Effect 列を組む。成功時の Effect 列は
 * [Persist, (SetAlarm|ClearAlarm), Broadcast(snapshot)]（snapshot は残余 Timer の調整変化を含む全量・唯一の
 * 権威表現）。Persist を先頭に置くのは SSOT 規律の表明。
 */
export function completeTimer(state: TimerState, timerId: string, now: EpochMillis, params: SyncParams): Outcome {
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
  const moved: TimerState = {
    timers: state.timers.filter((t) => t.id !== timerId),
    nextSeq: state.nextSeq,
  };
  return settle(state, moved, params, now);
}
