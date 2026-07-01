// core/cancel.ts — タイマーキャンセルの純粋変換（対象 Timer の除去・Alarm 張り直し）。
// cloudflare:workers にも storage にも触れない。副作用なし・決定的（同じ入力に同じ出力）。
//
// 除去後の Timer 集合は元集合の部分集合であり、キャンセルされた Timer は二度と発火対象に
// 現れない（要件6.5）。残存からの Alarm 導出は必ず nextAlarmEffect を通す（最早算出の重複を根絶）。

import type { EpochMillis } from "../engine/types";
import type { TimerState } from "./state";
import type { Outcome } from "./effect";
import { settle } from "./settle";
import type { SyncParams } from "./sync";

/**
 * タイマーキャンセルの状態遷移。対象 Timer を除去し、残り running 集合全体を再同期する（要件6.1 / 6.3 / 6.4 / 6.5・本機能の要件7.2）。
 *
 * 対象が存在しなければ TimerNotFound を返し、状態を一切変更しない（要件6.6）。拒否は例外ではなく戻り値。
 * 除去後の running 集合全体を settle が synchronize で再同期し、Effect 列を組む。成功時の Effect 列は
 * [Persist, (SetAlarm|ClearAlarm), Broadcast(snapshot)]（snapshot は残余 Timer の調整変化を含む全量・唯一の
 * 権威表現）。Persist を先頭に置くのは SSOT 規律の表明。
 * 残存ゼロなら settle 内の nextAlarmEffect が ClearAlarm を返す（要件6.4）。
 */
export function cancelTimer(state: TimerState, timerId: string, now: EpochMillis, params: SyncParams): Outcome {
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
  const moved: TimerState = {
    timers: state.timers.filter((t) => t.id !== timerId),
    nextSeq: state.nextSeq,
  };
  return settle(state, moved, params, now);
}
