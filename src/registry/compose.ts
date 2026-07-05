// registry/compose.ts — Effective_Config の合成（単一の純粋関数）。
// イデア（Policy 群・Store_Override）から完全な StoreConfig を導く計算であり、
// 作用（put・RPC・Alarm）を含まない。cloudflare:workers にも storage にも触れない純粋モジュール。

import type { Policy, PolicyFields, StoreOverride } from "./ideal";
import {
  type StoreConfig,
  toUnitCount,
  toArms,
  toToleranceRatio,
  toNoodlePresets,
} from "../domain/store";

/** StoreConfig と対応する合成対象フィールド名（PolicyFields / StoreOverride が主張しうる集合）。 */
type ConfigField = keyof StoreConfig;

/** 合成が畳むフィールドの正準列挙。PolicyFields・StoreOverride・StoreConfig の三者で共通の語彙。 */
const CONFIG_FIELDS: readonly ConfigField[] = ["unitCount", "arms", "toleranceRatio", "noodlePresets"];

/**
 * composeEffectiveConfig — Policy 群（priority 昇順に畳む）と Store_Override から完全な StoreConfig を合成する。
 *
 * ・基底は domain の DEFAULT_*（どの層も主張しないフィールドの供給源＝出力完全性を保証・要件4.5）。
 * ・priority 昇順（小さい＝全社統制が先）に畳む。同着は policyId 昇順で安定化（曖昧割当は入口で排除済み・要件3.4）。
 * ・enforced はその層で確定し以後ロック（後の層・Override が無視される・要件4.2）。縦の衝突は最小 priority が勝つ（要件4.3）。
 * ・default は後の層が上書き可。配列フィールド（noodlePresets）は層ごとの丸ごと置換（要素マージなし・要件4.4）。
 * ・Store_Override は最終層で、ロックされていないフィールドにのみ適用される。統制解除で再びロックが外れ Override が復活する（要件4.7）。
 *
 * 出力完全性と値域内（要件4.5）は domain の検証関数で構造的に保証する：基底に DEFAULT_* を置くため acc は常に全
 * フィールドを持ち、最後に各値を対応検証関数（toUnitCount 等）へ通して値域へ収める。入力 Policy は値域検証済み
 * （入口で拒否型検証済み・要件4.6）を前提とするが、合成の出口でも検証関数を一度通し範囲安全を構造で担保する。
 *
 * 入力の Policy は同一チェーン所属・値域検証済みを前提とする。純粋・決定的・順序非依存。
 */
export function composeEffectiveConfig(
  policies: readonly Policy[],
  override: StoreOverride,
): StoreConfig {
  // 基底層：どの層も主張しないフィールドの供給源（出力完全性を保証）。生値を unknown で持ち、出口で検証関数へ通す。
  const acc: Record<ConfigField, unknown> = {
    unitCount: undefined,
    arms: undefined,
    toleranceRatio: undefined,
    noodlePresets: undefined,
  };
  // enforced で確定済みのフィールド名（一度ロックされたら以後の層・Override が無視される・単調増加）。
  const locked = new Set<ConfigField>();

  // priority 昇順（小さい＝全社統制が先）。同着は policyId 昇順で決定的に畳む（順序非依存）。
  const ordered = [...policies].sort(
    (a, b) => a.priority - b.priority || compareStrings(a.policyId, b.policyId),
  );

  for (const policy of ordered) {
    for (const field of CONFIG_FIELDS) {
      const moded = policy.fields[field as keyof PolicyFields];
      if (moded === undefined) continue; // 主張されたフィールドのみ畳む
      if (locked.has(field)) continue; // 上位 enforced が確定済み → 無視（要件4.3）
      acc[field] = moded.value; // 丸ごと置換（配列も要素マージしない・要件4.4）
      if (moded.mode === "enforced") locked.add(field); // 以後ロック（要件4.2）
    }
  }

  // Store_Override は最終層。ロックされていないフィールドにのみ適用（統制中は無視・解除で復活・要件4.7）。
  for (const field of CONFIG_FIELDS) {
    if (locked.has(field)) continue;
    const value = override[field as keyof StoreOverride];
    if (value === undefined) continue;
    acc[field] = value;
  }

  // 出口で検証関数を通し、値域内・完全性を構造で保証する（未主張フィールドは undefined → DEFAULT_* へ畳む）。
  return {
    unitCount: toUnitCount(acc.unitCount),
    arms: toArms(acc.arms),
    toleranceRatio: toToleranceRatio(acc.toleranceRatio),
    noodlePresets: toNoodlePresets(acc.noodlePresets),
  };
}

/** policyId 同着の安定化に用いる決定的な文字列比較（辞書順・昇順）。 */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
