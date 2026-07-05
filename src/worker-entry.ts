// worker-entry.ts — Entry（`/`）の行き先解決の純粋ロジック（要件7.3〜7.5）。
//
// resolveEntryDestination / EntryDestination は cloudflare:workers にも jose にも依存しない純粋な
// 型・関数として src/worker.ts から隔離する。Worker エントリ（src/worker.ts）は DO の re-export 経由で
// cloudflare:workers を、Access 検証で jose を引き込むため、既定 pool ではロードできない。行き先解決の
// property 検証（Property 18）を DO ランタイムに阻まれず既定 pool で走らせるため、判定を端に寄せる
// （構造の主権・worker-auth.ts と同じ隔離）。src/worker.ts は本モジュールから import・re-export する。

import type { StoreId } from "./registry/ideal";

/**
 * EntryDestination — Entry（`/`）の行き先解決の結果（要件7.3〜7.5）。
 *
 * redirect は当該店舗の Store_Path へ 302 する宛先。none は「接続先なし」（0 店舗）を表す別個の合図で、
 * いかなる店舗へもフォールバックしないことを型で表明する（要件7.5。redirect と none を判別可能にし、
 * 「どこかへ落とす」経路を構築不能にする）。
 */
export type EntryDestination =
  | { readonly kind: "redirect"; readonly storeId: StoreId }
  | { readonly kind: "none" };

/**
 * resolveEntryDestination — 逆引きで得た接続可能店舗リスト（登録順）から Entry の行き先を決める純粋関数（要件7.3〜7.5）。
 *
 * ・1 店舗 → その店舗へリダイレクト（要件7.3）。
 * ・複数店舗 → 既定店（登録順の先頭）へリダイレクト（要件7.4。店舗切替 UI 用のリスト受け渡しはタスク 14.2）。
 * ・0 店舗 → 接続先なし（要件7.5）。いずれの場合もフォールバックしない。
 *
 * 逆引きインデックスは登録順（createdAt 昇順・buildReverseIndex が保証）で storeId を並べるため、
 * 先頭が既定店になる。1 店舗と複数店舗はともに先頭へリダイレクトする点で同型ゆえ、分岐は「先頭が在るか」に集約する。
 * 純粋・決定的：同じ入力に同じ出力（作用を含まない・テストはタスク 14.4 / 14.5）。
 */
export function resolveEntryDestination(stores: readonly StoreId[]): EntryDestination {
  const first = stores[0];
  return first === undefined ? { kind: "none" } : { kind: "redirect", storeId: first };
}
