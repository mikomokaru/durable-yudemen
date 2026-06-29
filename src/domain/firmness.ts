// domain/firmness.ts — 茹で加減（firmness）の安定したドメイン識別子。import を持たない中立の語彙。
//
// 将来、券売機の「硬さ商品コード（オーダー全体で共有）」がこの id へ 1:1 写像される。表示ラベル（日本語）は
// client 側に分離し、ここは外部統合・プロトコル・永続が頼る安定 id だけを定義する（命名規律・英語方針）。
// 調整する秒数は「麺の種類ごと」に異なるため、ここには持たない（StoreConfig の NoodlePreset が硬さ別の
// 茹で秒を麺ごとに定義する）。firmness はその茹で秒表のキーであって、増減量そのものではない。

/** 茹で加減の安定 id。並びは硬い→柔らかい（FIRMNESS_ORDER）。既定は normal。 */
export type Firmness = "extraHard" | "hard" | "normal" | "soft";

/** UI・選択肢の並び順（硬→柔）。 */
export const FIRMNESS_ORDER: readonly Firmness[] = ["extraHard", "hard", "normal", "soft"];

/** 既定の茹で加減（開始時・移行時のフォールバック）。 */
export const DEFAULT_FIRMNESS: Firmness = "normal";

/** 未検証入力（ワイヤ・永続・設定）から Firmness を確立する型ガード。 */
export function isFirmness(value: unknown): value is Firmness {
  return value === "extraHard" || value === "hard" || value === "normal" || value === "soft";
}
