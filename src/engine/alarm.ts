// core/alarm.ts — Alarm 導出を一関数へ集約する純粋モジュール。
// cloudflare:workers にも storage にも触れない。副作用なし・決定的（同じ入力に同じ出力）。
//
// 最早 endTime の算出と Alarm の張り直し/解除は、開始・キャンセル・発火・rehydrate の
// すべてがこの一関数（nextAlarmEffect）を通る。最早算出を二度書かないことで、
// 「同じ概念は一箇所」を守り、Alarm の正しさを単一の不変条件へ畳み込む。

import type { EpochMillis } from "../engine/types";
import type { Timer } from "./timer";
import type { Effect } from "./effect";

/**
 * 残存 Timer の最早 endTime を算出する。空集合なら null。
 *
 * 同一 endTime が複数あるときは seq 最小の 1 件を選ぶ（要件3.2 のタイブレーク）。
 * 返すのは endTime という「事実」の値のみ。状態も作用も持たない。
 */
export function earliestEndTime(timers: readonly Timer[]): EpochMillis | null {
  let earliest: Timer | null = null;
  for (const t of timers) {
    // endTime が早い方を優先。同着なら seq が小さい方を採る（要件3.2）。
    if (
      earliest === null ||
      t.endTime < earliest.endTime ||
      (t.endTime === earliest.endTime && t.seq < earliest.seq)
    ) {
      earliest = t;
    }
  }
  return earliest === null ? null : earliest.endTime;
}

/**
 * 残存 Timer から次に張るべき Alarm の作用を決める Alarm 導出の唯一の関数。
 *
 * 対象は running（boiledAt === null）だけ。boiled（発火済み・明示完了待ち）は endTime が過去ゆえ
 * Alarm の対象にすると過去時刻へ張られ無限再発火する。ここで running に絞ることで「Alarm は
 * 走行中の最早にのみ張る」規律を一箇所へ畳み込む。running があれば最早 endTime へ SetAlarm、
 * running ゼロなら ClearAlarm を返す。DO は同時に 1 Alarm のみ。
 */
export function nextAlarmEffect(timers: readonly Timer[]): Effect {
  const running = timers.filter((t) => t.boiledAt === null);
  const at = earliestEndTime(running);
  return at === null ? { type: "ClearAlarm" } : { type: "SetAlarm", at };
}
