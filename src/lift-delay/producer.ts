// 遅延ログの Producer（lift-delay-log 要件 4）。
//
// 操作履歴の Producer と同じ規律で動く。**確定した差分だけを、同期 console 出力として 1 回試みる。**
// 失敗は外へ出さない。待たない。再試行しない。業務の保存にも Alarm にも触れない。
//
// 出すのは 2 種類である。開始の行は開始が確定した瞬間に、終端の行は完了または取消が確定した瞬間に出す。
// 開始文脈を完了まで預けないので、店舗の保存は一切変わらない（2026-09-16 の設計変更）。

import type { TimerState } from "../engine/state";
import type { OrderItem } from "../domain/order";
import { liftDelayPayload, liftDelayStartPayload } from "./codec";
import { startRecordOf, terminalRecordOf } from "./derive";

/** Persist が成功した差分と、その差分を作った入力。 */
export interface LiftDelayObservation {
  readonly storeId: string;
  /** 当該 decide へ渡したサーバ now。壁時計を採り直さない。 */
  readonly eventTime: number;
  readonly eventKind: "Start" | "StartOrderItem" | "Complete" | "Cancel";
  readonly before: TimerState;
  readonly after: TimerState;
  /**
   * 開始直前の未着手品目。`pendingOrders(before.orderItems, before.timers, now)` の結果を渡す。
   * **絞る前の集合**であることが要件 2.2 の要点で、呼び出し側がそれを守る。
   */
  readonly pendingBeforeStart?: readonly Pick<OrderItem, "externalOrderId" | "itemIndex">[];
  /** 開始しようとした品目。アドホック開始では null。 */
  readonly startedOrderItem?: Pick<OrderItem, "externalOrderId" | "itemIndex"> | null;
}

/**
 * 確定差分から出すべき payload を純粋に決める。
 *
 * console へ渡すのは**オブジェクト**である（2026-09-16 に文字列から変えた）。検査は Tail 側が
 * Zod で行う。**配備の順序: Tail を先に出す。**
 */
export function liftDelayLinesFromCommittedDiff(
  observation: LiftDelayObservation,
): readonly Record<string, unknown>[] {
  const { storeId, before, after, eventKind } = observation;
  const beforeIds = new Set(before.timers.map((timer) => timer.id));
  const afterIds = new Set(after.timers.map((timer) => timer.id));

  if (eventKind === "Start" || eventKind === "StartOrderItem") {
    return after.timers
      .filter((timer) => !beforeIds.has(timer.id))
      .map((timer) =>
        liftDelayStartPayload(
          startRecordOf(storeId, timer.id, {
            startedAt: timer.startTime,
            orderItem: observation.startedOrderItem ?? null,
            // 渡されなければ空として数える。数えられなかったことを 0 件と偽らないため、
            // 呼び出し側は必ず `pendingOrders` の結果を渡す（tests/lift-delay の検査）。
            pending: observation.pendingBeforeStart ?? [],
            activeTimers: before.timers,
            shownPlan: before.shownPlan,
          }),
        ),
      );
  }

  return before.timers
    .filter((timer) => !afterIds.has(timer.id))
    .map((timer) =>
      liftDelayPayload(
        terminalRecordOf({
          storeId,
          timer,
          outcome: eventKind === "Complete" ? "completed" : "cancelled",
          terminalAt: observation.eventTime,
        }),
      ),
    );
}

/**
 * 確定差分を best-effort に console へ出す。
 *
 * 操作履歴の `tryWriteOperationLines` と同じ形である。1 行の失敗を他の行へも Timer 本体へも
 * 伝播させない（要件 4.2）。
 */
export function tryWriteLiftDelayLines(enabled: boolean, observation: LiftDelayObservation): void {
  if (!enabled) return;

  try {
    for (const payload of liftDelayLinesFromCommittedDiff(observation)) {
      try {
        console.log(payload);
      } catch {
        // 1 行の観測失敗を Timer 本体にも後続の行にも伝播させない。
      }
    }
  } catch {
    return;
  }
}
