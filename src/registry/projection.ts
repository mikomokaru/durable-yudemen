// registry/projection.ts — レジストリが店舗 DO へ押し込む投影の型。
//
// 投影を「配信可能な config（StoreConfig）」と「サーバ内部のみの roster（Roster）」へ構造分離する。
// この型は domain（client も見る中立地帯）には置かず、shell 間の RPC 契約としてレジストリ側に閉じる。
// import するのは src/registry/ と src/shell/store-timer-do.ts のみで、domain 経由で client へは到達しない。
// これにより Roster が ServerMessage（ワイヤ）へ流れる経路を型レベルで断つ（要件5.3 / 6.5）。
//
// config だけが配信可能・roster はサーバ内部という区別を、送信時のフィルタではなく型の構造で表明する
// （「不正な状態を表現可能にしない」— Roster のワイヤ漏洩を構築不能にする）。cloudflare:workers にも
// storage にも触れない純粋な型定義のみ。

import type { StoreConfig } from "../domain/store";
import type { Roster } from "./ideal";

/**
 * StoreProjection — レジストリが店舗 DO へ押し込む投影。
 * config だけが配信可能で、roster はサーバ内部に留まる（接続時認可に使うがワイヤには載らない）。
 */
export interface StoreProjection {
  /** 配信可能な店舗設定（config ServerMessage で接続中クライアントへ再配信される）。 */
  readonly config: StoreConfig;
  /** 実効 Roster。接続時認可にのみ用い、ServerMessage には決して載らない（サーバ内部）。 */
  readonly roster: Roster;
  /** 非活性（deactivated）なら店舗 DO が新規接続を拒否し既存 WS を閉じる（要件6.6）。 */
  readonly active: boolean;
  /** 合成時点のレジストリ revision。イデアの全書き込みで単調増加し収束の突き合わせに用いる（要件5.9）。 */
  readonly version: number;
}
