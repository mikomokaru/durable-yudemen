// registry/authz.ts — 接続時認可の純粋核（identity の正準クレーム正規化）。
//
// Access が発行する JWT の正準クレーム（email 等の文字列）は、IdP・入力経路により大小文字や前後空白の
// 表現差を持ちうる。Roster 照合を「同じ人」の単位で行うため、照合の両辺（接続要求の identity と Roster の
// 各要素）を同一の正準形へ写してから比較する。正規化はイデア空間の語彙（Identity）に属する純粋な決定で
// あり、作用（レジストリ照会・storage）を一切持たない。cloudflare:workers にも storage にも触れない。
//
// 接続時 Roster 認可そのもの（投影のみで完結・レジストリ照会なし）は shell（StoreTimerDO）が本関数を用いて
// 行う（要件6.3 / 6.4）。ここは「正準形への写像」だけを担う（要件9.5）。

import type { Identity } from "./ideal";

/**
 * normalize — identity の正準クレーム文字列を照合用の正準形へ写す（冪等・決定的）。
 *
 * ・trim で前後空白を落とし、toLowerCase で大小文字差を吸収する（email 系クレームの表現差の吸収・要件9.5）。
 * ・冪等：`normalize(normalize(x))` は `normalize(x)` に等しい（trim/toLowerCase は再適用しても不動点）。
 * ・決定的：同じ入力に常に同じ出力（時計・乱数・外部状態に依らない純粋関数）。
 *
 * 照合の両辺（接続要求の identity と Roster の各要素）を本関数で正規化してから比較する。単純で決定的な
 * 規則に留める（過剰な正準化——Unicode 正規化やドメイン別ルール——は現時点の要件が要さない・YAGNI）。
 */
export function normalize(identity: Identity): string {
  return identity.trim().toLowerCase();
}
