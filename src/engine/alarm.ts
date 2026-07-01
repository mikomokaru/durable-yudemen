// core/alarm.ts — Alarm 導出を一関数へ集約する純粋モジュール。
// cloudflare:workers にも storage にも触れない。副作用なし・決定的（同じ入力に同じ出力）。
//
// 実効最早 endTime（Adjusted_Boil_Time）の算出と Alarm の張り直し/解除は、開始・キャンセル・
// 発火・調整・rehydrate のすべてがこの一関数（nextAlarmEffect）を通る。実効時刻の算出は
// project.ts の adjustedEndTime へ集約し、最早算出も二度書かない。こうして「同じ概念は一箇所」を
// 守り、Alarm の正しさを単一の不変条件へ畳み込む。

import type { EpochMillis } from "../engine/types";
import type { Timer } from "./timer";
import type { Effect } from "./effect";
import { adjustedEndTime } from "./project";

/**
 * 残存 Timer の実効最早 endTime（Adjusted_Boil_Time = endTime + adjustment）を算出する。空集合なら null。
 *
 * 比較の基準はオリジナル endTime ではなく実効 endTime。実効値の算出は project.ts の adjustedEndTime に
 * 集約し（実効時刻を二度書かない）、Alarm もこの実効最早に張る。同一実効 endTime が複数あるときは
 * seq 最小の 1 件を選ぶ（要件3.2 のタイブレーク）。返すのは実効 endTime という「事実」の値のみ。
 */
export function earliestEndTime(timers: readonly Timer[]): EpochMillis | null {
  let earliest: Timer | null = null;
  for (const t of timers) {
    // 実効 endTime が早い方を優先。同着なら seq が小さい方を採る（要件3.2 の全順序）。
    if (
      earliest === null ||
      adjustedEndTime(t) < adjustedEndTime(earliest) ||
      (adjustedEndTime(t) === adjustedEndTime(earliest) && t.seq < earliest.seq)
    ) {
      earliest = t;
    }
  }
  return earliest === null ? null : adjustedEndTime(earliest);
}

/**
 * 残存 Timer から次に張るべき Alarm の作用を決める Alarm 導出の唯一の関数。
 *
 * 対象は running（boiledAt === null）だけ。boiled（発火済み・明示完了待ち）は endTime が過去ゆえ
 * Alarm の対象にすると過去時刻へ張られ無限再発火する。ここで running に絞ることで「Alarm は
 * 走行中の実効最早にのみ張る」規律を一箇所へ畳み込む。running があれば実効最早（Adjusted_Boil_Time）へ
 * SetAlarm、running ゼロなら ClearAlarm を返す。DO は同時に 1 Alarm のみ。
 */
export function nextAlarmEffect(timers: readonly Timer[]): Effect {
  const running = timers.filter((t) => t.boiledAt === null);
  const at = earliestEndTime(running);
  return at === null ? { type: "ClearAlarm" } : { type: "SetAlarm", at };
}
