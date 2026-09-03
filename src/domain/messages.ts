// domain/messages.ts — WS 上のワイヤ表現とメッセージプロトコル（engine と client が共有）。
// プラットフォーム非依存の純粋な型定義。
//
// サーバは残り時間を送らず、endTime（事実）と serverTime（送信時点のサーバ現在時刻）を送る
// （要件10.2）。残りの算出はクライアントの導出であって、状態として持たない。
//
// ワイヤ上の Timer 表現は TimerFact（既定の型パラメータ＝生プリミティブ）そのもの。別名は設けない。
// engine 専用の seq やブランド型はワイヤに出さない（既定の生表現に縮退する）。

import type { TimerFact, NonEmptyArray } from "./timer";
import type { StoreConfig } from "./store";
import type { PendingOrder } from "./order";
import type { Firmness } from "./firmness";

/**
 * CookRecommendation — 推奨の 1 件（次に開始すべき品目・slot・開始タイミング）。
 *
 * Committed_Plan からの導出値ゆえ永続しない（状態に昇格させれば計画と推奨の二つの真実が生まれる）。
 * ワイヤ表現ゆえブランド型を使わず生プリミティブで運ぶ。基数は保つ——slotIds の非空は wire.ts の関門が
 * 確立するため、受け手が読み飛ばしで再確立する必要はない。
 */
export interface CookRecommendation {
  /** 対象品目の POS 側識別子。itemIndex との組で 1 品目を指す（Pending_Order と同じ鍵）。 */
  readonly externalOrderId: string;
  /** 同一オーダー内の品目連番。 */
  readonly itemIndex: number;
  /** 推奨する slot（釜）の集合（型で非空を強制）。 */
  readonly slotIds: NonEmptyArray<string>;
  /** 推奨する開始の絶対時刻。到来しても自動開始はしない（指示ではなく提案）。 */
  readonly startAt: number;
}

/** client → server のメッセージ。 */
export type ClientMessage =
  | {
      readonly type: "start";
      readonly slotIds: NonEmptyArray<string>;
      readonly noodleType: string;
      readonly boilSeconds: number;
      // 由来する注文品目（省略時はアドホック麺茹で＝POS を経ない開始）。engine の Event.Start は
      // 組（Ordered["orderItem"]）で持つが、ワイヤは既存の start と同じ平坦な兄弟フィールドで運ぶ。
      // 「両方揃うか、どちらも無いか」を組で強制しない理由は slot-suggested-start が品目参照を別種別へ
      // 移すことにあり、ここで組を型にすれば作ってすぐ消すことになる。組を成す判定は wire.ts が担う。
      readonly externalOrderId?: string;
      readonly itemIndex?: number;
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
  // 唯一の権威表現（hydration も状態変化も同一・全量／要件4.1）。待ち行列と推奨も同乗させ、種別を増やさない。
  | {
      readonly type: "snapshot";
      readonly serverTime: number;
      readonly timers: readonly TimerFact[];
      /** 未着手オーダーの全量（計画対象の 64 件を超える分も含む・要件2.3 / 2.4）。 */
      readonly pendingOrders: readonly PendingOrder[];
      /** Committed_Plan からの導出値。永続しない（要件8.1 / 8.5）。 */
      readonly recommendations: readonly CookRecommendation[];
    }
  // 店舗設定の一方向配信（サーバ権威・クライアント不変）。StoreConfig をそのまま運ぶ（要件3.4）。
  //
  // 項目を列挙しない。列挙すれば StoreConfig の項目集合を写した第二の一覧が生まれ、設定が増えたときに
  // 両方を直す規律が要る。intersection にすれば第二の一覧そのものが存在せず、取りこぼす場所が無い。
  // 基数（noodlePresets の NonEmptyArray・slotOffsets の 6 要素タプル）も弱めない——wire.ts の関門が
  // 境界で確立するため、弱めて運ぶ理由が消えた。ワイヤ上の JSON は平坦なままである（intersection は
  // 構造を入れ子にしない）。StoreConfig 側に type / serverTime という名の項目を置くと黙って重なる。
  | ({ readonly type: "config"; readonly serverTime: number } & StoreConfig)
  | {
      readonly type: "error";
      readonly serverTime: number;
      readonly code: string;
      readonly message: string;
    }; // 各拒否・失敗（要求元へ直接 ws.send）
