// core/decide.ts — 唯一の状態遷移関数。(現在の状態, イベント) → 結果。
// cloudflare:workers にも storage にも触れない純粋モジュール。副作用なし・決定的（同じ入力に同じ出力）。
//
// decide は core への唯一の入口であり、イベント種別で各純粋変換へディスパッチするだけの薄い関数。
// 各変換が Persist 先頭の Effect 列を組み立てるため、decide は結果を一切並べ替えず素通しする
// （SSOT 規律＝Effect 列は常に Persist が先頭、の不変条件は委譲先が担い、ここでは保つに徹する）。

import type { TimerState } from "./state";
import type { Event } from "./event";
import type { Outcome } from "./effect";
import { startTimer } from "./start";
import { cancelTimer } from "./cancel";
import { completeTimer } from "./complete";
import { adjustTimer } from "./adjust";
import { fireDueTimers, reconcile } from "./fire";

/**
 * 唯一の状態遷移関数（要件8.1 / 8.4 / 8.7）。
 *
 * Start → startTimer / Cancel → cancelTimer / Complete → completeTimer /
 * AlarmFired → fireDueTimers / Reconcile → reconcile。
 * 網羅は型で保証する（Event は判別共用体であり、未処理の種別は never に落ちて型エラーになる）。
 */
export function decide(state: TimerState, event: Event): Outcome {
  switch (event.type) {
    case "Start":
      return startTimer(state, event);
    case "Cancel":
      return cancelTimer(state, event.timerId, event.now);
    case "Complete":
      return completeTimer(state, event.timerId, event.now);
    case "Adjust":
      return adjustTimer(state, event.timerId, event.firmness, event.boilSeconds, event.now);
    case "AlarmFired":
      return fireDueTimers(state, event.now);
    case "Reconcile":
      return reconcile(state, event.now);
  }
}
