// core/fire.ts — 茹で上がりの一括ドレイン発火と、rehydrate 直後の整合の純粋変換。
// cloudflare:workers にも storage にも触れない。副作用なし・決定的（同じ入力に同じ出力）。
//
// 発火は「1 件ずつ」ではなく「endTime ≤ now + ε を満たす全 Timer を一度に」処理する。
// Alarm は at-least-once であり多重・境界付近で起動されうるため、1 件ずつ処理すると ε 窓内の
// 複数 Timer に対して再発火が連鎖し無限スルーの恐れがある。一括ドレインにより残存最早は
// 必ず now + ε より未来となり、連鎖が構造的に断たれる（要件2.10 / 3.3 を不変条件の帰結として満たす）。

import { EPSILON_MS } from "../engine/types";
import type { EpochMillis } from "../engine/types";
import type { TimerState } from "./state";
import type { Timer } from "./timer";
import type { Outcome, Effect } from "./effect";
import { toSnapshot } from "./snapshot";
import { nextAlarmEffect } from "./alarm";
import type { ServerMessage } from "../domain/messages";

/** 処理順の比較。endTime 昇順、同一 endTime は seq 昇順（要件3.6）。 */
function byEndTimeThenSeq(a: Timer, b: Timer): number {
  return a.endTime - b.endTime || a.seq - b.seq;
}

/**
 * 茹で上がりの一括ドレイン発火（要件2.3 / 2.5 / 2.8 / 2.9 / 3.3 / 3.4 / 3.6）。
 *
 * `endTime ≤ now + ε`（ε = EPSILON_MS）を満たす全 Timer を `(endTime, seq)` 昇順で一括処理して
 * 除去する。残存 Timer から nextAlarmEffect で Alarm を張り直す（残存ありなら SetAlarm(最早)、
 * 残存ゼロなら ClearAlarm）。done は endTime 昇順（同一は seq 順）で Broadcast する。
 *
 * 成功時の Effect 列は [Persist, (SetAlarm|ClearAlarm), Broadcast(done)*]。Persist を先頭に置くのは
 * SSOT 規律の表明であり、shell は put 成功の上にのみ Alarm / Broadcast を立てる。due が空でも
 * （多重発火・整合の冪等性）Persist 先頭の Effect 列を返し、状態は元と等しく保たれる。
 */
export function fireDueTimers(state: TimerState, now: EpochMillis): Outcome {
  // ε 許容窓。境界に位置する Timer を取りこぼさず一括で茹で上げる閾値（要件2.3 / 2.10 / 3.3）。
  const dueThreshold = now + EPSILON_MS;
  // 期限到来分を処理順（endTime 昇順、同一は seq 順）に並べる（要件3.6）。
  const due = state.timers
    .filter((t) => t.endTime <= dueThreshold)
    .sort(byEndTimeThenSeq);
  // 残存は厳密に now + ε より未来のものだけ。これにより残存最早が境界以下になることはない。
  const remaining = state.timers.filter((t) => t.endTime > dueThreshold);
  // nextSeq は導出順の事実であり発火では減らさない（除去で seq を再利用しない）。
  const nextState: TimerState = { timers: remaining, nextSeq: state.nextSeq };
  // 茹で上がり通知。残り秒は送らず timerId と serverTime（= now）を運ぶ（要件2.5）。
  const doneBroadcasts: readonly Effect[] = due.map((t) => {
    const done: ServerMessage = { type: "done", serverTime: now, timerId: t.id };
    return { type: "Broadcast", message: done };
  });
  // 最早 Alarm の算出は必ず nextAlarmEffect を通す（残存ありで SetAlarm、ゼロで ClearAlarm）。
  const effects: readonly Effect[] = [
    { type: "Persist", snapshot: toSnapshot(nextState) },
    nextAlarmEffect(remaining),
    ...doneBroadcasts,
  ];
  return { ok: true, state: nextState, effects };
}

/**
 * rehydrate 直後の整合（要件7.6 / 7.7）。期限到来分を即時発火し Alarm を張り直す。
 *
 * 整合は発火と同形である（期限到来分の一括ドレイン → 残存から Alarm 再導出）。同じ概念を二度
 * 書かず fireDueTimers に委ねることで、最早算出・発火処理の重複を根絶する。残存最早が
 * 必ず now + ε より未来になる保証も fireDueTimers がそのまま担う。
 */
export function reconcile(state: TimerState, now: EpochMillis): Outcome {
  return fireDueTimers(state, now);
}
