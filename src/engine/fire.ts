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
 * `endTime ≤ now + ε`（ε = EPSILON_MS）を満たす running（boiledAt === null）の全 Timer を
 * `(endTime, seq)` 昇順で一括処理し、除去せず boiled（boiledAt = now）へ遷移させる。boiled は
 * ユーザーの明示完了（Complete）まで集合に残り、消し込み待ちの状態として保持される。残存 running
 * から nextAlarmEffect で Alarm を張り直す（running があれば SetAlarm(最早)、ゼロなら ClearAlarm）。
 * boiled へ新たに遷移した分だけを endTime 昇順（同一は seq 順）で `boiled` 通知として Broadcast する。
 *
 * 既に boiled の Timer は対象外（boiledAt !== null）なので、多重発火・rehydrate 整合で再評価されても
 * 二度 boiled 通知を出さない（冪等）。成功時の Effect 列は [Persist, (SetAlarm|ClearAlarm), Broadcast(boiled)*]。
 * Persist を先頭に置くのは SSOT 規律の表明であり、shell は put 成功の上にのみ Alarm / Broadcast を立てる。
 */
export function fireDueTimers(state: TimerState, now: EpochMillis): Outcome {
  // ε 許容窓。境界に位置する Timer を取りこぼさず一括で茹で上げる閾値（要件2.3 / 2.10 / 3.3）。
  const dueThreshold = now + EPSILON_MS;
  // 新たに茹で上がる対象＝running かつ期限到来。処理順（endTime 昇順、同一は seq 順）に並べる（要件3.6）。
  const newlyBoiled = state.timers
    .filter((t) => t.boiledAt === null && t.endTime <= dueThreshold)
    .sort(byEndTimeThenSeq);
  // 除去はしない。対象を boiled（boiledAt = now）へ写し、それ以外（running・既 boiled）はそのまま残す。
  const boiledIds = new Set<string>(newlyBoiled.map((t) => t.id));
  const nextTimers: readonly Timer[] = state.timers.map((t) =>
    boiledIds.has(t.id) ? { ...t, boiledAt: now } : t,
  );
  // nextSeq は導出順の事実であり発火では変えない。
  const nextState: TimerState = { timers: nextTimers, nextSeq: state.nextSeq };
  // 茹で上がり通知。残り秒は送らず timerId と serverTime（= now）を運ぶ（要件2.5）。新たに boiled に
  // なった分だけ通知する（既 boiled は再通知しない＝冪等）。
  const boiledBroadcasts: readonly Effect[] = newlyBoiled.map((t) => {
    const boiled: ServerMessage = { type: "boiled", serverTime: now, timerId: t.id };
    return { type: "Broadcast", message: boiled };
  });
  // Alarm は running（boiledAt === null）の最早だけを対象に張り直す（boiled の過去 endTime で再発火しない）。
  const effects: readonly Effect[] = [
    { type: "Persist", snapshot: toSnapshot(nextState) },
    nextAlarmEffect(nextTimers),
    ...boiledBroadcasts,
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
