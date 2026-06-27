// core/effect.ts — 純粋変換が「次に実行すべき作用」をデータとして記述する型と、その結果。
// cloudflare:workers にも storage にも触れない純粋モジュール。
//
// 変換は世界を変えない。何が起きるべきかをデータ（Effect）として返し、端（shell）が起こす。
// 不変条件: Effect 列は常に Persist を先頭に持つ（確定の起点は storage.put 成功のみ＝SSOT 規律）。

import type { EpochMillis } from "./types";
import type { TimerState } from "./state";
import type { ActiveTimersSnapshot } from "./snapshot";
import type { Rejection } from "./rejection";
import type { ServerMessage } from "../shared/messages";

/** 純粋変換が返す作用の記述。shell が先頭から順に実行する。 */
export type Effect =
  | { readonly type: "Persist"; readonly snapshot: ActiveTimersSnapshot } // storage.put（確定の起点）
  | { readonly type: "SetAlarm"; readonly at: EpochMillis } // storage.setAlarm
  | { readonly type: "ClearAlarm" } // storage.deleteAlarm
  | { readonly type: "Broadcast"; readonly message: ServerMessage } // 接続中の全 WS へ
  | { readonly type: "Reply"; readonly message: ServerMessage }; // 要求元の WS へ

/** 純粋変換の結果。成功なら新状態と Effect 列、失敗なら拒否理由。 */
export type Outcome =
  | { readonly ok: true; readonly state: TimerState; readonly effects: readonly Effect[] }
  | { readonly ok: false; readonly rejection: Rejection };
