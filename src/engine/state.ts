// core/state.ts — core が扱う状態。残り秒を持たない「事実」だけの集合。
// cloudflare:workers にも storage にも触れない純粋モジュール。

import type { Timer } from "./timer";
import type { AcceptedSlice } from "./schedule";
import type { InputDigest } from "./digest";
import type { PendingOrder } from "../domain/order";

/**
 * TimerState — core の状態。
 *
 * 「これ以上分解できない事実」だけに絞る。残り秒は存在しない（導出値であって状態ではない）。
 *
 * 調理順スケジューリングが足すのは 3 フィールドだけで、これが決定性の四つ組
 * （対象集合, パラメータ, 採用済み計画, 直前要求時点の Input_Fingerprint）の状態側を担う（AC 7.3。
 * パラメータは StoreConfig 由来で状態には属さない）。
 *
 * 次の 4 つは**いずれも状態に置かない**（AC 7.2）。すべて上の事実からの導出値であり、状態として持てば
 * 二つの真実の源が生まれて必ずズレる（design-philosophy.md「導出値を状態に昇格させない」）。
 *   - Committed_Plan — acceptedSlices と現在の Pending_Order / Timer 集合から committedSchedule が導く
 *   - Cook_Recommendation — Committed_Plan から recommend が導く
 *   - 現在の Input_Fingerprint — 現在の入力から digestInput が導く（保持するのは「直前に要求した時点の値」だけ）
 *   - Wait_Time — arrivalTime（事実）と提供時刻から引き算で出る
 */
export interface TimerState {
  /** アクティブな全 Timer。 */
  readonly timers: readonly Timer[];
  /** 次に割り当てる登録順（seq）。 */
  readonly nextSeq: number;
  /** 未着手オーダーの品目集合。POS の状態ではなくここが正本（AC 2.1）。 */
  readonly pendingOrders: readonly PendingOrder[];
  /** Acceptance_Gate が採用した外部計画の一片。再計算では復元できない事実ゆえ状態に属する（AC 7.1）。 */
  readonly acceptedSlices: readonly AcceptedSlice[];
  /** 直前に外部計画を要求した時点の入力の指紋。null は「まだ一度も要求していない」。 */
  readonly requestedDigest: InputDigest | null;
}

/** 空の初期状態。Timer なし・seq は 0 から・待ち行列も採用済み計画も空・未要求。 */
export const EMPTY_STATE: TimerState = {
  timers: [],
  nextSeq: 0,
  pendingOrders: [],
  acceptedSlices: [],
  requestedDigest: null,
};
