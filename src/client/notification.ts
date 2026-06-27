// client/notification.ts — 通知の冪等性を担う純粋導出。副作用なし・決定的。
// サーバ状態（SSOT）を一切変更しない、表示制御用ローカル情報の上だけで判定する。
//
// Alarm は at-least-once であり、同一 timerId の done が二度届きうる（Persist 成功 →
// done ブロードキャスト後にプロセスが落ち、Alarm がリトライ再発火する経路）。サーバの
// 状態冪等性（fireDueTimers）は通知の冪等性を保証しないため、二重のアラーム音・通知再提示を
// 弾く責務はクライアント側にある。処理済み timerId 集合は表示制御のためだけのローカル情報で
// あって SSOT のコピーではない（要件2.13）。
//
// 判定は timerId 基準（Slot 単位ではない）。同一 Slot で先行 Timer の完了後に開始した別 Timer は
// 異なる timerId を持つため、timerId 基準なら同一 Slot への正当な新しい通知を握り潰さない（要件の真）。
// done と cancelled は同一の処理済み記録と判定規律を共有する（要件6.8）。

/**
 * この timerId の done/cancelled を処理すべきか。
 *
 * 処理済み記録に未登録なら true（表示を切り替え、続けて markProcessed で登録する）、
 * 登録済みなら false（無視＝音・通知・カウントダウン表示の変更を行わない）。要件2.11 / 2.12 / 6.8。
 */
export function shouldHandleDone(timerId: string, processedIds: ReadonlySet<string>): boolean {
  return !processedIds.has(timerId);
}

/**
 * timerId を処理済みとして記録に加えた新しい集合を返す。元集合は変更しない（不変）。
 *
 * 二つの真実の源を作らないため in-place の変更を避け、新しい Set を返す。
 */
export function markProcessed(processedIds: ReadonlySet<string>, timerId: string): Set<string> {
  return new Set(processedIds).add(timerId);
}
