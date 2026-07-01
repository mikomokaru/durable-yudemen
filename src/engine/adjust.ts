// engine/adjust.ts — 走行中タイマーの茹で加減変更の純粋変換（endTime アンカー引き直し・全体再同期）。
// cloudflare:workers にも storage にも触れない。副作用なし・決定的（同じ入力に同じ出力）。
//
// 茹で加減ごとの茹で秒は「麺の種類ごと」に StoreConfig で定義される。engine は設定を持たないため、
// shell が対象 Timer の noodleType と新 firmness から boilSeconds を解決して Adjust イベントへ載せる。
// ここでは対象のオリジナル endTime（不変アンカー）を startTime + boilSeconds*1000 で引き直し（経過は
// そのまま・総時間が変わる）、firmness を更新する。startTime は不変。
//
// アンカーの引き直しは Tolerance_Window そのものを動かすため、続けて settle が running 集合全体を
// synchronize で再同期し Adjustment を全体置換する（design「Adjust（茹で加減変更）」）。再同期・no-op 検出・
// Effect 列組み立ては settle に委ね、この変換は「アンカー引き直しまで」に徹する。

import { BOIL_SECONDS_MIN, BOIL_SECONDS_MAX } from "../engine/types";
import type { EpochMillis } from "../engine/types";
import type { Firmness } from "../domain/firmness";
import type { TimerState } from "./state";
import type { Timer } from "./timer";
import type { Outcome } from "./effect";
import { settle } from "./settle";
import type { SyncParams } from "./sync";

/**
 * 茹で加減変更の状態遷移。対象 Timer のオリジナル endTime（アンカー）を新しい茹で秒で引き直し、
 * firmness を更新したのち、running 集合全体を再同期する（本機能の要件7.1）。
 *
 * 対象が存在しなければ TimerNotFound、解決された boilSeconds が範囲外なら InvalidBoilSeconds を返し、
 * いずれも状態を一切変更しない（拒否は戻り値・新種別を増やさない）。成功時の Effect 列は settle が組む
 * [Persist, (SetAlarm|ClearAlarm), Broadcast(snapshot)]（snapshot は再同期で変わりうる他 Timer の調整も含む
 * 全量・実効 endTime を載せる唯一の権威表現）。
 * Persist 先頭は SSOT 規律。endTime が過去になっても許容する（発火経路＝Alarm/Reconcile が due として処理）。
 */
export function adjustTimer(
  state: TimerState,
  timerId: string,
  firmness: Firmness,
  boilSeconds: number,
  now: EpochMillis,
  params: SyncParams,
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
  // startTime 固定でオリジナル endTime（アンカー）だけ差し替える。残り時間は endTime からの導出ゆえ即反映される。
  const endTime = (target.startTime + boilSeconds * 1000) as EpochMillis;
  const updated: Timer = { ...target, firmness, endTime };
  // 基底の集合変更（対象のアンカーと firmness を差し替え）。同期・no-op 検出・Effect 列組み立ては settle に委ねる。
  const moved: TimerState = {
    timers: state.timers.map((t) => (t.id === timerId ? updated : t)),
    nextSeq: state.nextSeq,
  };
  return settle(state, moved, params, now);
}
