// tests/storeConfigDefaults.ts — テストフィクスチャ用：StoreConfig のうち同期の重み・許容幅・slot
// レイアウトを既定値で埋める。
//
// これらの項目は既存テストの関心事（unitCount / arms / toleranceRatio / noodlePresets の扱い）ではないため、
// 各フィクスチャへ書き写さず一箇所から供給する。既定が変わってもテストが自動で追随し、写し間違いが起きない。

import {
  DEFAULT_AFFINITY_TOLERANCE_DISTANCE,
  DEFAULT_AFFINITY_WEIGHT,
  DEFAULT_ORDER_SYNC_TOLERANCE_SECONDS,
  DEFAULT_ORDER_SYNC_WEIGHT,
  DEFAULT_SLOT_OFFSETS,
  DEFAULT_TABLE_SYNC_TOLERANCE_SECONDS,
  DEFAULT_TABLE_SYNC_WEIGHT,
  defaultUnitOrigins,
  type StoreConfig,
} from "../src/domain/store";

/** StoreConfig の残余（重み・許容幅・レイアウト）を既定値で満たした部分。unitOrigins は unitCount に依存する。 */
export function schedulingDefaults(
  unitCount: number,
): Omit<StoreConfig, "unitCount" | "arms" | "toleranceRatio" | "noodlePresets"> {
  return {
    orderSyncWeight: DEFAULT_ORDER_SYNC_WEIGHT,
    tableSyncWeight: DEFAULT_TABLE_SYNC_WEIGHT,
    affinityWeight: DEFAULT_AFFINITY_WEIGHT,
    orderSyncToleranceSeconds: DEFAULT_ORDER_SYNC_TOLERANCE_SECONDS,
    tableSyncToleranceSeconds: DEFAULT_TABLE_SYNC_TOLERANCE_SECONDS,
    affinityToleranceDistance: DEFAULT_AFFINITY_TOLERANCE_DISTANCE,
    unitOrigins: defaultUnitOrigins(unitCount),
    slotOffsets: DEFAULT_SLOT_OFFSETS,
  };
}
