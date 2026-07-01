// engine/project.ts — engine の Timer を wire の TimerFact へ射影する唯一の関数。
// cloudflare:workers にも storage にも触れない純粋モジュール。
//
// 射影はここ一箇所に集約する（重複の根絶）。seq / boiledAt / adjustment は engine 専用の事実ゆえ
// 削ぎ落とし、endTime には実効値（オリジナル + adjustment）を畳んで載せる。実効 endTime の算出が
// 二度書かれれば二つの真実になるため、start.ts / adjust.ts / shell はこの関数を import して用いる。

import type { EpochMillis } from "./types";
import type { Timer } from "./timer";
import type { TimerFact } from "../domain/timer";

/**
 * 実効茹で上がり時刻（Adjusted_Boil_Time）。オリジナル endTime に Adjustment を載せた事実。
 *
 * オリジナル endTime（不変アンカー）は書き換えず、符号付き adjustment を足して実効値を導出する。
 * adjustment が 0 のとき実効値はオリジナル endTime に等しい。
 */
export function adjustedEndTime(timer: Timer): EpochMillis {
  return (timer.endTime + timer.adjustment) as EpochMillis;
}

/**
 * engine の Timer を wire の TimerFact へ射影する唯一の関数。
 *
 * seq / boiledAt / adjustment（いずれも engine 専用）を削ぎ、endTime に実効値（= endTime + adjustment）を
 * 載せる。client は調整の存在を知らず、受け取った endTime から残り時間・boiled を今までどおり導出する。
 */
export function toWireTimer(timer: Timer): TimerFact {
  return {
    id: timer.id,
    slotIds: timer.slotIds,
    noodleType: timer.noodleType,
    firmness: timer.firmness,
    startTime: timer.startTime,
    endTime: adjustedEndTime(timer),
  };
}
