// core/decide.ts — 唯一の状態遷移関数。(現在の状態, イベント) → 結果。
// cloudflare:workers にも storage にも触れない純粋モジュール。副作用なし・決定的（同じ入力に同じ出力）。
//
// decide は core への唯一の入口であり、イベント種別で各純粋変換へディスパッチするだけの薄い関数。
// 各変換が Persist 先頭の Effect 列を組み立てるため、decide は結果を一切並べ替えず素通しする
// （SSOT 規律＝Effect 列は常に Persist が先頭、の不変条件は委譲先が担い、ここでは保つに徹する）。

import type { TimerState } from "./state";
import type { Event } from "./event";
import type { Outcome } from "./effect";
import type { SettleParams } from "./settle";
import { startTimer } from "./start";
import { cancelTimer } from "./cancel";
import { completeTimer } from "./complete";
import { adjustTimer } from "./adjust";
import { fireDueTimers, reconcile } from "./fire";
import { arriveOrder, cancelOrder } from "./order";
import { receivePlan } from "./plan";
import { arriveRecords } from "./receive";

/**
 * 唯一の状態遷移関数（要件8.1 / 8.4 / 8.7・本機能の要件7.1 / 7.2）。
 *
 * Start → startTimer / Cancel → cancelTimer / Complete → completeTimer /
 * AlarmFired → fireDueTimers / Reconcile → reconcile /
 * OrderArrived → arriveOrder / OrderCancelled → cancelOrder / PlanArrived → receivePlan /
 * RecordsReceived → arriveRecords。
 * 網羅は型で保証する（Event は判別共用体であり、未処理の種別は never に落ちて型エラーになる）。
 *
 * params は同期計算・採点の値と麺プリセット（SettleParams）。engine は StoreConfig 型を知らず、ただの値の束
 * として受け取る（非純粋を端へ寄せる規律）。集合や窓を変える Start / Cancel / Complete / Adjust に加え、発火経路の
 * AlarmFired / Reconcile も settle 経由で残り running を全体再同期するため、すべての分岐に params を渡す。
 */
export function decide(state: TimerState, event: Event, params: SettleParams): Outcome {
  switch (event.type) {
    case "Start":
      return startTimer(state, event, params);
    case "Cancel":
      return cancelTimer(state, event.timerId, event.now, params);
    case "Complete":
      return completeTimer(state, event.timerId, event.now, params);
    case "Adjust":
      return adjustTimer(state, event.timerId, event.firmness, event.boilSeconds, event.now, params);
    case "AlarmFired":
      return fireDueTimers(state, event.now, params);
    case "Reconcile":
      return reconcile(state, event.now, params);
    case "OrderArrived":
      return arriveOrder(state, event, params);
    case "OrderCancelled":
      return cancelOrder(state, event.externalOrderId, event.now, params);
    // 計画受領は Acceptance_Gate を通す（採用があれば mayRequestPlan = false で settle・全棄却なら無変化）。
    // 産み手は復路の deliverPlan RPC ただ一つ——Solver_Worker（src/solver/index.ts）が計算完了時に呼び、
    // shell がスキーマ検証を通してからこの分岐へ流す（engine は検証済みの型だけを受ける）。
    case "PlanArrived":
      return receivePlan(state, event, params);
    // 受領は 1 イベントで畳む（Record ごとに分ければ Persist が件数だけ生じる）。重複の読み飛ばしも
    // 判定材料の更新も arriveRecords の内側に閉じ、decide は素通しに徹する。
    case "RecordsReceived":
      return arriveRecords(state, event, params);
  }
}
