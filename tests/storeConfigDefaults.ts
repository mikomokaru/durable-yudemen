// tests/storeConfigDefaults.ts — テストフィクスチャ用：StoreConfig のうち、呼び出し側フィクスチャが明示しない
// 残余を既定値で埋める。
//
// これらの項目は既存テストの関心事（unitCount / arms / toleranceRatio / noodlePresets の扱い）ではないため、
// 各フィクスチャへ書き写さず一箇所から供給する。既定が変わってもテストが自動で追随し、写し間違いが起きない。
// 採点パラメータ 8 値はイデアの主張対象そのものに入っていないが、POS の対応表 2 枚は主張できる（合成対象で
// ある）。ここが供給するのは「当該フィクスチャが主張しない」場合の既定であり、対応表を関心事とするテストは
// 自身で値を与えてこの供給を上書きする。
//
// 供給は 2 段に分かれる。schedulingDefaults は採点パラメータ（ScheduleParams ちょうど 8 値）だけを返し、
// configResidualDefaults がそれに POS の対応表 2 枚を足して StoreConfig の残余を成す。分けるのは、前者を
// SettleParams / ScheduleParams として使う呼び出し側（engine の採点・整合テスト）に、採点と無関係な
// 対応表を混ぜないためである。

import type { ScheduleParams } from "../src/engine/objective";
import {
  DEFAULT_AFFINITY_TOLERANCE_DISTANCE,
  DEFAULT_AFFINITY_WEIGHT,
  DEFAULT_FIRMNESS_CODES,
  DEFAULT_MENU_ITEMS,
  DEFAULT_ORDER_SYNC_TOLERANCE_SECONDS,
  DEFAULT_ORDER_SYNC_WEIGHT,
  DEFAULT_SLOT_OFFSETS,
  DEFAULT_TABLE_SYNC_TOLERANCE_SECONDS,
  DEFAULT_TABLE_SYNC_WEIGHT,
  defaultUnitOrigins,
  type StoreConfig,
} from "../src/domain/store";

/** 採点パラメータ（重み 3・許容幅 3・レイアウト 2）の既定。unitOrigins は unitCount に依存する。 */
export function schedulingDefaults(unitCount: number): ScheduleParams {
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

/**
 * StoreConfig の残余（採点パラメータ 8 値 ＋ POS の対応表 2 枚）を既定値で満たした部分。
 *
 * 戻り型を Omit<StoreConfig, …> に据えるのは、StoreConfig が項目を増やしたときにここで型が破れ、
 * フィクスチャの供給漏れが型検査で露わになるためである（黙って欠けたまま通らせない）。
 */
export function configResidualDefaults(
  unitCount: number,
): Omit<StoreConfig, "unitCount" | "arms" | "toleranceRatio" | "noodlePresets"> {
  return {
    ...schedulingDefaults(unitCount),
    firmnessCodes: DEFAULT_FIRMNESS_CODES,
    menuItems: DEFAULT_MENU_ITEMS,
  };
}
