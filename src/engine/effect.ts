// core/effect.ts — 純粋変換が「次に実行すべき作用」をデータとして記述する型と、その結果。
// cloudflare:workers にも storage にも触れない純粋モジュール。
//
// 変換は世界を変えない。何が起きるべきかをデータ（Effect）として返し、端（shell）が起こす。
// 不変条件: Effect 列は常に Persist を先頭に持ち、RequestPlan は末尾にのみ現れる
// （確定の起点は storage.put 成功のみ＝SSOT 規律。現場への反映＝broadcast を、改善の投機＝外部要求より先に立てる）。
// 順序は Persist → SetAlarm|ClearAlarm → Broadcast → RequestPlan。型では強制せず、列を組む一箇所
// （settle の assembleEffects）とここのコメントの規律で保ち、Property 12（タスク 14.5）が検査する。

import type { EpochMillis } from "../engine/types";
import type { TimerState } from "./state";
import type { Timer } from "./timer";
import type { StoreSnapshot } from "./snapshot";
import type { Rejection } from "./rejection";
import type { ScheduleParams } from "./objective";
import type { InputDigest } from "./digest";
import type { PendingOrder } from "../domain/order";
import type { NoodlePreset } from "../domain/store";
import type { ServerMessage } from "../domain/messages";

/** 純粋変換が返す作用の記述。shell が先頭から順に実行する。 */
export type Effect =
  | { readonly type: "Persist"; readonly snapshot: StoreSnapshot } // storage.put（確定の起点）
  | { readonly type: "SetAlarm"; readonly at: EpochMillis } // storage.setAlarm
  | { readonly type: "ClearAlarm" } // storage.deleteAlarm
  | { readonly type: "Broadcast"; readonly message: ServerMessage } // 接続中の全 WS へ
  // 外部（Solver_Worker）へ計画を要求する（要件5.1）。運ぶのは対象集合・走行中・パラメータ・麺プリセット・
  // 要求時点の指紋。要求の入力は engine の決定として一箇所に定め、shell は Effect と storeId の写しを送るだけ
  // にする（麺プリセットを shell の在メモリから添えると、同じ要求の入力が二箇所から来る）。
  // storeId は載せない——engine は storeId を知らず、shell が送出時に付ける（構造の主権）。
  // 送出は投機であって確定の一部ではないため列の末尾に置く。失敗は Timer 本体へ伝播させない（AC 10.2）。
  | {
      readonly type: "RequestPlan";
      readonly pending: readonly PendingOrder[]; // 計画の対象集合（未着手品目）
      readonly running: readonly Timer[]; // 釜を占める Timer（slot 解放表の所与）
      readonly params: ScheduleParams; // 重み 3・arms・許容幅 2・距離 1・レイアウト 2 の 9 値
      readonly noodlePresets: readonly NoodlePreset[]; // 茹で時間の出所（外部解が serveAt = startAt + 茹で時間 を満たすために要る）
      readonly digest: InputDigest; // 要求時点の Input_Fingerprint（この要求がどの入力に対するものかの同定）
    };

/** 純粋変換の結果。成功なら新状態と Effect 列、失敗なら拒否理由。 */
export type Outcome =
  | { readonly ok: true; readonly state: TimerState; readonly effects: readonly Effect[] }
  | { readonly ok: false; readonly rejection: Rejection };
