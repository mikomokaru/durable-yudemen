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
import { startOrderItemTimer, startTimer } from "./start";
import { cancelTimer } from "./cancel";
import { completeTimer } from "./complete";
import { adjustTimer } from "./adjust";
import { fireDueTimers, reconcile } from "./fire";
import { arriveOrder, cancelOrder } from "./order";
import { receivePlan } from "./plan";
import { arriveRecords } from "./receive";
import { slotOf } from "../domain/store";
import type { Rejection } from "./rejection";

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
/**
 * duplicatedSlot — 状態の中で**同じ釜を 2 つ以上の Timer が占めていないか**（1 釜 ≤ 1 Timer・2026-09-14）。
 *
 * **これが無い間、釜の本数を超える Timer を持つ状態が正本に作れた。** 釜 12 本に 14 本の麺が
 * 茹だっている、という物理的に存在しない事実である（`timers` は釜を鍵にした表ではなく配列で、
 * 開始の側にも占有の検査が無かった）。
 *
 * **遷移の結果に当てる。** 開始の入口ごとに置くと、経路を足すたびに書き忘れる余地が残る
 * ——`decide` は core への唯一の入口なので、ここで「この状態は物理的に在りうるか」を一度だけ問えば
 * すべての遷移が覆われる。大盛（2 釜）は同じ Timer が 2 釜を占めるだけで重複ではない。
 *
 * 述語は釜番号の写像 `slotOf`（domain）ただ一つを通す——`occupiedSlotsOf` と同じ規則である。
 */
function duplicatedSlot(state: TimerState): Rejection | null {
  const owner = new Map<number, string>();
  for (const timer of state.timers)
    for (const slotId of timer.slotIds) {
      const slot = slotOf(slotId);
      const held = owner.get(slot);
      if (held !== undefined && held !== timer.id)
        return { code: "SlotOccupied", message: `釜 ${slotId} は使用中` };
      owner.set(slot, timer.id);
    }
  return null;
}

export function decide(state: TimerState, event: Event, params: SettleParams): Outcome {
  const outcome = dispatch(state, event, params);
  // **物理的に在りえない状態を確定させない（2026-09-14）。** 遷移が成功しても、その結果が
  // 「同じ釜に 2 つの Timer」を含むなら拒否して状態を変えない。**遷移の手前ではなく結果に当てる**
  // ——入口ごとの検査は経路を足すたびに書き忘れる余地が残るが、ここは core への唯一の入口である。
  //
  // **既に壊れている状態を受け取った場合は、そこで止めない。** 遷移が重複を**新たに作った**
  // ときだけ拒否する。永続から復元した状態に重複が在れば、あらゆる操作が永久に拒否されて
  // 店舗が動かなくなる——境界（`migrate`）で直すべきものを、業務の入口で塞いではいけない。
  if (!outcome.ok) return outcome;
  const rejection = duplicatedSlot(outcome.state);
  if (rejection === null || duplicatedSlot(state) !== null) return outcome;
  return { ok: false, rejection };
}

function dispatch(state: TimerState, event: Event, params: SettleParams): Outcome {
  switch (event.type) {
    case "Start":
      return startTimer(state, event, params);
    case "StartOrderItem":
      return startOrderItemTimer(state, event, params);
    case "Cancel":
      return cancelTimer(state, event.timerId, event.now, params);
    case "Complete":
      return completeTimer(state, event.timerId, event.now, params);
    case "Adjust":
      return adjustTimer(
        state,
        event.timerId,
        event.firmness,
        event.boilSeconds,
        event.now,
        params,
      );
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
