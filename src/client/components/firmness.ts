// client/components/firmness.ts — 茹で加減の表示ラベル（ドメイン id → 日本語）。
//
// 安定 id（Firmness）と並び・既定は domain/firmness.ts（外部統合・プロトコル・永続の正本）。ここは UI の
// 表示語だけを id へ対応づける（id と表示の分離。券売機は id へ写像、画面は日本語で出す）。茹で秒は麺ごとに
// StoreConfig が持つため、ここには持たない。

import type { Firmness } from "../../domain/firmness";

/** 茹で加減 id → 表示ラベル（日本語）。 */
export const FIRMNESS_LABEL: Record<Firmness, string> = {
  extraHard: "バリカタ",
  hard: "かため",
  normal: "ふつう",
  soft: "やわめ",
};
