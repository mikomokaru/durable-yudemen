// transport/rejection.ts — 接続拒否の close code（client と shell が共有する単一の確定値）。
//
// shell（StoreTimerDO）が「店舗の状態による接続禁止」で接続中の WS を閉じるときに添える close code と、
// client（Connectivity_Watch）がそれを「接続拒否」と解して Entry へ戻る判定に使う close code は、同一の
// 確定値でなければならない。両者が同じ定数をここから取り込むことで二重定義を根絶し、「同じ概念は
// ただ一箇所で定義する」規律を守る（heartbeat.ts と同じトランスポート共有の作法）。
//
// これは WebSocket の close code（数値）であり、ワイヤ形式（messages.ts の ServerMessage / ClientMessage）
// には一切手を加えない。

/**
 * 接続拒否の close code（要件6.6 / 7.6）。
 *
 * 4000〜4999 は WebSocket 仕様がアプリ専用に予約する私的レンジ。新規接続の拒否に使う HTTP 403 と同じ
 * 「店舗の状態による禁止」を単一のアプリ固有シグナルで表すため、その 403 を映した 4403 を採る。
 * shell は非活性化（deactivated）で接続中の WS をこの符号で閉じ、client はこの符号を接続拒否と解して
 * Entry へ戻り行き先を解決し直す（design.md Component 8 / 10）。
 */
export const REJECTION_CLOSE_CODE = 4403;
