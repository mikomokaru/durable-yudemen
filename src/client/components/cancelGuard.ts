// client/components/cancelGuard.ts — 走行中カードの停止ボタンの純粋な決定ロジック（早め上げ／Cancel 誤タップ保険）。
//
// SlotCard の対話（残り時間による二分・armed 2 段タップ・直後バウンス無視・3 秒窓の自動解除）から
// 副作用（onComplete / onCancel の送信・setArmedAt・window リスナ）を切り離し、決定的にテストできる形にする。
//
// 残り時間の二分は操作の意味を分ける（order-lifecycle 判断 4・Requirement 5.1）。残り < しきいの 1 タップは
// 「早め上げ」＝完了（`complete`・参照先の品目に completedAt が書かれる）であり、残り ≥ しきいの 2 段タップは
// 「中断」＝Cancel（`cancel`・品目は未調理へ戻り interruptedAt が書かれる）である。しきいは UI の関心事のまま
// （engine は残り時間で判定しない）。
// 時刻・残り時間・armedAt はすべて引数で受け取り、内部で Date.now() を読まない（計算と作用の分離）。
//
// armed か否かは「状態」ではなく armedAt（armed に入った絶対時刻）+ 3 秒窓 + 現在時刻からの導出値。
// 残り秒を状態に昇格させないのと同じ規律で、armed も導出に留める（真: 状態について嘘をつかない）。

/**
 * 停止ボタンの意味を分ける残り時間しきい。これ以上なら 2 段タップ（armed 経由）で cancel、未満なら 1 タップで即 complete。
 * 調理都合の「早め上げ」は残り僅少帯で正当かつ頻繁ゆえ、その帯には摩擦を足さず、完了として記録する。
 */
export const CANCEL_GUARD_THRESHOLD_MS = 60_000;
/** armed の有効窓。この経過で自動解除する。判定は既存の 1 秒描画 tick 上の導出で行い、新規常設タイマーを持たない。 */
export const CANCEL_ARMED_WINDOW_MS = 3_000;
/** armed 遷移直後の入力無視窓。濡れ指のバウンス連打が 2 タップ目へ貫通して即キャンセルするのを防ぐ。 */
export const CANCEL_ARMED_BOUNCE_MS = 300;

/** armed を判定する導出の入力（すべて引数で運ぶ・内部で時計を読まない）。 */
export interface CancelGuardInput {
  /** 対象 running Timer の残り時間（導出値・サーバ補正済みクロック由来）。 */
  readonly remainingMs: number;
  /** armed に入った絶対時刻。未 armed は null。 */
  readonly armedAt: number | null;
  /** 現在時刻（描画時に採取した絶対時刻）。 */
  readonly now: number;
}

/**
 * 停止タップに対する決定。副作用は持たず「何をすべきか」だけを返す（shell 相当の SlotCard が実行する）。
 * - complete: 早め上げ。サーバへ complete を送る（残り < しきいの 1 タップ・order-lifecycle 性質 7.4）。
 * - cancel  : 中断。サーバへ cancel を送る（＋ armed を解除する）。
 * - arm     : armedAt を at(= now) に確立する（1 タップ目 / 窓超過での再 arm）。
 * - ignore  : 何もしない（armed 直後 CANCEL_ARMED_BOUNCE_MS のバウンス無視）。
 */
export type CancelTapDecision =
  | { readonly kind: "complete" }
  | { readonly kind: "cancel" }
  | { readonly kind: "arm"; readonly at: number }
  | { readonly kind: "ignore" };

/**
 * 停止タップの決定。
 *
 * 残り < しきい: 1 タップで即 complete（早め上げの正当帯・摩擦を足さない・完了として記録する）。
 * 残り ≥ しきい:
 *   - 未 armed        → arm（送信せず armed 化・カウントダウンは継続）
 *   - armed 直後 <300ms → ignore（バウンス貫通防止）
 *   - armed 窓内       → cancel（2 タップ目＝確定）
 *   - armed 窓超過     → arm（tick 遅延で armed 表示が残存していた場合、改めて 1 タップ目扱い）
 */
export function decideCancelTap(input: CancelGuardInput): CancelTapDecision {
  if (input.remainingMs < CANCEL_GUARD_THRESHOLD_MS) {
    return { kind: "complete" };
  }
  if (input.armedAt === null) {
    return { kind: "arm", at: input.now };
  }
  const elapsed = input.now - input.armedAt;
  if (elapsed < CANCEL_ARMED_BOUNCE_MS) {
    return { kind: "ignore" };
  }
  if (elapsed < CANCEL_ARMED_WINDOW_MS) {
    return { kind: "cancel" };
  }
  return { kind: "arm", at: input.now };
}

/**
 * armed 表示か（ボタンを警告表現にするか）の導出。残り ≥ しきい かつ armedAt が 3 秒窓内のときだけ true。
 * 残り < しきい・未 armed・窓超過はすべて false（前提が崩れれば黙って解除、と同じ導出）。
 */
export function isCancelArmed(input: CancelGuardInput): boolean {
  if (input.remainingMs < CANCEL_GUARD_THRESHOLD_MS) return false;
  if (input.armedAt === null) return false;
  return input.now - input.armedAt < CANCEL_ARMED_WINDOW_MS;
}
