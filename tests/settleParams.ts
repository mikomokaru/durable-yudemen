// tests/settleParams.ts — テストフィクスチャ用：SettleParams（decide / settle が受ける値の束）を組む。
//
// 既存テストの関心事は Boil_Sync の 2 値（arms / toleranceRatio）だけで、計画の採点パラメータ・麺プリセットは
// 主張に関与しない。各テストへ 9 項目を書き写せば、既定が変わるたびに写し間違いの箱が増える。ゆえに
// 「計画側は既定で埋める」という判断を一箇所に置く（storeConfigDefaults.ts と同じ役割・同じ理由）。

import type { SettleParams } from "../src/engine/settle";
import type { SyncParams } from "../src/engine/sync";
import { DEFAULT_NOODLE_PRESETS, DEFAULT_UNIT_COUNT } from "../src/domain/store";
import { schedulingDefaults } from "./storeConfigDefaults";

/**
 * Boil_Sync の 2 値に、計画側（麺プリセット・重み・許容幅・レイアウト）の既定を足して SettleParams を組む。
 *
 * unitCount はレイアウト（unitOrigins の要素数＝釜の数）を決める。既定は DEFAULT_UNIT_COUNT で、
 * 釜の数を主張に含めるテストだけが明示的に渡す。
 */
export function settleParams(
  sync: SyncParams,
  unitCount: number = DEFAULT_UNIT_COUNT,
): SettleParams {
  // arms は同期と採点で一つの実体。テストが主張する sync 側の値を後ろに置いて勝たせる。
  return { ...schedulingDefaults(unitCount), ...sync, noodlePresets: DEFAULT_NOODLE_PRESETS };
}
