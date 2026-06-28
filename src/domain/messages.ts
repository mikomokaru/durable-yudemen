// domain/messages.ts — WS 上のワイヤ表現とメッセージプロトコル（engine と client が共有）。
// プラットフォーム非依存の純粋な型定義。
//
// サーバは残り時間を送らず、endTime（事実）と serverTime（送信時点のサーバ現在時刻）を送る
// （要件10.2）。残りの算出はクライアントの導出であって、状態として持たない。
//
// ワイヤ上の Timer 表現は TimerFact（既定の型パラメータ＝生プリミティブ）そのもの。別名は設けない。
// engine 専用の seq やブランド型はワイヤに出さない（既定の生表現に縮退する）。

import type { TimerFact } from "./timer";

/** client → server のメッセージ。 */
export type ClientMessage =
  | {
      readonly type: "start";
      readonly slotIds: readonly string[];
      readonly noodleType: string;
      readonly boilSeconds: number;
    }
  | { readonly type: "cancel"; readonly timerId: string };

/** server → client のメッセージ。すべて serverTime を付与する。 */
export type ServerMessage =
  | { readonly type: "snapshot"; readonly serverTime: number; readonly timers: readonly TimerFact[] } // hydration 全量（要件4.1）
  | { readonly type: "started"; readonly serverTime: number; readonly timer: TimerFact } // 開始反映（要件1.3）
  | { readonly type: "cancelled"; readonly serverTime: number; readonly timerId: string } // 要件6.2
  | { readonly type: "done"; readonly serverTime: number; readonly timerId: string } // 茹で上がり（要件2.5）
  | { readonly type: "error"; readonly serverTime: number; readonly code: string; readonly message: string }; // 各拒否・失敗
