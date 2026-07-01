// domain/messages.ts — WS 上のワイヤ表現とメッセージプロトコル（engine と client が共有）。
// プラットフォーム非依存の純粋な型定義。
//
// サーバは残り時間を送らず、endTime（事実）と serverTime（送信時点のサーバ現在時刻）を送る
// （要件10.2）。残りの算出はクライアントの導出であって、状態として持たない。
//
// ワイヤ上の Timer 表現は TimerFact（既定の型パラメータ＝生プリミティブ）そのもの。別名は設けない。
// engine 専用の seq やブランド型はワイヤに出さない（既定の生表現に縮退する）。

import type { TimerFact } from "./timer";
import type { NoodlePreset } from "./store";
import type { Firmness } from "./firmness";

/** client → server のメッセージ。 */
export type ClientMessage =
  | {
      readonly type: "start";
      readonly slotIds: readonly string[];
      readonly noodleType: string;
      readonly boilSeconds: number;
    }
  | { readonly type: "cancel"; readonly timerId: string } // 走行中の中断（要件6）
  | { readonly type: "complete"; readonly timerId: string } // 茹で上がりの明示消し込み（boiled → 除去）
  | { readonly type: "adjust"; readonly timerId: string; readonly firmness: Firmness }; // 走行中の茹で加減変更（endTime 再計算）

/** server → client のメッセージ。すべて serverTime を付与する。
 *
 * 確定した状態変化ごとに送るのは snapshot ただ一つ（唯一の権威表現・SSOT）。
 * 意味論メッセージ（started/cancelled/completed/boiled/adjusted）は撤去した
 * ——同一事実に二つの表現を持たせないための引き算（bug#1 の構造的消滅）。 */
export type ServerMessage =
  | { readonly type: "snapshot"; readonly serverTime: number; readonly timers: readonly TimerFact[] } // 唯一の権威表現（hydration も状態変化も同一・全量／要件4.1）
  | { readonly type: "config"; readonly serverTime: number; readonly unitCount: number; readonly noodlePresets: readonly NoodlePreset[] } // 店舗設定の一方向配信（サーバ権威・クライアント不変）
  | { readonly type: "error"; readonly serverTime: number; readonly code: string; readonly message: string }; // 各拒否・失敗（要求元へ直接 ws.send）
