// core/event.ts — core への入力イベント。
// cloudflare:workers にも storage にも触れない純粋モジュール。
//
// コマンド（外部由来）と内部イベント（Alarm 発火・rehydrate 整合）を一つの代数的データ型に
// 集約する。`now` は shell が Date.now() で採取して渡す（core は時計を持たない＝純粋）。
// `newTimerId` も shell が採取して渡し、crypto.randomUUID() という副作用を core から閉め出す。

import type { EpochMillis, TimerId } from "../engine/types";

/** core への入力イベント。すべて `now` を入力として受け取る。 */
export type Event =
  | {
      readonly type: "Start";
      readonly slotIds: readonly string[];
      readonly noodleType: string;
      readonly boilSeconds: number;
      readonly newTimerId: TimerId;
      readonly now: EpochMillis;
    }
  | { readonly type: "Cancel"; readonly timerId: string; readonly now: EpochMillis }
  | { readonly type: "AlarmFired"; readonly now: EpochMillis }
  // rehydrate 直後の整合（即時発火含む）
  | { readonly type: "Reconcile"; readonly now: EpochMillis };
