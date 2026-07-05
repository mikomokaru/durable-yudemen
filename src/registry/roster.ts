// registry/roster.ts — 実効名簿（Effective_Roster）の導出（独立した純粋関数）。
// チェーン Roster と店舗 Roster の和集合であり、priority / enforced の統制意味論も
// deny 手段も持たない（除外は名簿の構成で表現する・要件3.5）。
// cloudflare:workers にも storage にも触れない純粋モジュール。

import type { Roster } from "./ideal";

/**
 * effectiveRoster — チェーン Roster と店舗 Roster の和集合（重複排除）。
 *
 * ・priority / enforced の統制意味論を持たない。名簿は「加える」だけで、deny 手段を持たない（要件3.5）。
 * ・Roster は順序に意味を持たせない集合ゆえ、出力は初出順（chainRoster → storeRoster）で重複を落とした
 *   決定的な列とする（同じ入力集合には常に同じ列を返す）。
 * ・純粋・冪等・順序非依存：`effectiveRoster(a, effectiveRoster(a, b))` は `effectiveRoster(a, b)` に等しく、
 *   結果は入力の並びに依らず集合として一意（Property 7）。
 */
export function effectiveRoster(chainRoster: Roster, storeRoster: Roster): Roster {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const identity of [...chainRoster, ...storeRoster]) {
    if (seen.has(identity)) continue;
    seen.add(identity);
    merged.push(identity);
  }
  return merged;
}
