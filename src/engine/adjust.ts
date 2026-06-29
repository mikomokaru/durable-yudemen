// engine/adjust.ts — 走行中タイマーの茹で加減変更の純粋変換（endTime 再計算・Alarm 張り直し）。
// cloudflare:workers にも storage にも触れない。副作用なし・決定的（同じ入力に同じ出力）。
//
// 茹で加減ごとの茹で秒は「麺の種類ごと」に StoreConfig で定義される。engine は設定を持たないため、
// shell が対象 Timer の noodleType と新 firmness から boilSeconds を解決して Adjust イベントへ載せる。
// ここでは endTime = startTime + boilSeconds*1000 で引き直し（経過はそのまま・総時間が変わる）、
// firmness を更新する。startTime は不変。残存から Alarm を張り直す（最早算出は nextAlarmEffect に集約）。

import { BOIL_SECONDS_MIN, BOIL_SECONDS_MAX } from "../engine/types";
import type { EpochMillis } from "../engine/types";
import type { Firmness } from "../domain/firmness";
import type { TimerState } from "./state";
import type { Timer } from "./timer";
import type { Outcome, Effect } from "./effect";
import { toSnapshot } from "./snapshot";
import { nextAlarmEffect } from "./alarm";
import type { ServerMessage } from "../domain/messages";
import type { TimerFact } from "../domain/timer";

/** Timer をワイヤ表現へ射影する（adjusted で更新後の事実を運ぶ）。 */
function toWireTimer(timer: Timer): TimerFact {
  return {
    id: timer.id,
    slotIds: timer.slotIds,
    noodleType: timer.noodleType,
    firmness: timer.firmness,
    startTime: timer.startTime,
    endTime: timer.endTime,
  };
}

/**
 * 茹で加減変更の状態遷移。対象 Timer の endTime を新しい茹で秒で引き直し、firmness を更新する。
 *
 * 対象が存在しなければ TimerNotFound、解決された boilSeconds が範囲外なら InvalidBoilSeconds を返し、
 * いずれも状態を一切変更しない（拒否は戻り値）。成功時の Effect 列は
 * [Persist, (SetAlarm|ClearAlarm), Broadcast(adjusted), Reply(adjusted)]。Persist 先頭は SSOT 規律。
 * endTime が過去になっても許容する（既存の発火経路＝Alarm/Reconcile が due として処理する）。
 */
export function adjustTimer(
  state: TimerState,
  timerId: string,
  firmness: Firmness,
  boilSeconds: number,
  now: EpochMillis,
): Outcome {
  const target = state.timers.find((t) => t.id === timerId);
  if (target === undefined) {
    return {
      ok: false,
      rejection: { code: "TimerNotFound", message: `指定された timerId の Timer は存在しない: ${timerId}` },
    };
  }
  // shell が StoreConfig から解決した秒。防御的に範囲を再検証する（設定が壊れていても不正 endTime を作らない）。
  if (!Number.isFinite(boilSeconds) || boilSeconds < BOIL_SECONDS_MIN || boilSeconds > BOIL_SECONDS_MAX) {
    return {
      ok: false,
      rejection: {
        code: "InvalidBoilSeconds",
        message: `茹で時間は ${BOIL_SECONDS_MIN}〜${BOIL_SECONDS_MAX} 秒の範囲で指定する`,
      },
    };
  }
  // startTime 固定で総時間だけ差し替える。残り時間は endTime からの導出ゆえ即反映される。
  const endTime = (target.startTime + boilSeconds * 1000) as EpochMillis;
  const updated: Timer = { ...target, firmness, endTime };
  const nextState: TimerState = {
    timers: state.timers.map((t) => (t.id === timerId ? updated : t)),
    nextSeq: state.nextSeq,
  };
  const adjusted: ServerMessage = { type: "adjusted", serverTime: now, timer: toWireTimer(updated) };
  const effects: readonly Effect[] = [
    { type: "Persist", snapshot: toSnapshot(nextState) },
    nextAlarmEffect(nextState.timers),
    { type: "Broadcast", message: adjusted },
    { type: "Reply", message: adjusted },
  ];
  return { ok: true, state: nextState, effects };
}
