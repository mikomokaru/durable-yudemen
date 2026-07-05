// registry/policy-conflict.ts — 曖昧な Policy 割当の検出（純粋関数）。
//
// 店舗へ割り当てられた Policy 群が「曖昧な統制」を生むかを判定する計算であり、作用（put・RPC・Alarm）を
// 含まない。cloudflare:workers にも storage にも触れない純粋モジュール。
//
// 曖昧さの正体（要件3.4）：composeEffectiveConfig は Policy を priority 昇順（同着は policyId 昇順）に
// 畳むが、同一 priority の複数 Policy が同一フィールドを主張すると、どちらが勝つかは policyId の辞書順という
// 「統制の意味を持たない偶発的な順序」でしか決まらない。これは畳み順が本質的に未定義であることと同じで、
// 運用者の意図を偽る（naming の priority だけでは勝敗が決まらない）。ゆえにこの状態はイデアに表現可能にせず、
// 割当の入口で拒否する（不正な状態を構築不能にする — バリデーションで弾くより表現不能が真）。
//
// 本モジュールは検出（計算）だけを担い、HTTP 400 応答やイデアの put 有無は判定しない（作用は shell が持つ）。
// 参照する Policy 群は shell が policy:{policyId} キーから解決して渡す。存在しない Policy 参照は曖昧さを
// 生み得ない（主張するフィールドが無い）ため、解決できたものだけを渡す前提で扱う。

import type { Policy, PolicyFields, PolicyId } from "./ideal";
import { isNonEmpty, type NonEmptyArray } from "../domain/timer";

/**
 * AmbiguousPolicyConflict — 一件の曖昧な統制。
 * 同一 priority で同一フィールドを主張する 2 つ以上の Policy を、その priority・フィールド名・関与する
 * policyId 群として表明する（畳み順が未定義になる組）。拒否理由の再構成に足る情報を持たせる。
 */
export interface AmbiguousPolicyConflict {
  readonly priority: number;
  /** 主張が衝突したフィールド名（unitCount / arms / toleranceRatio / noodlePresets のいずれか）。 */
  readonly field: string;
  /** 衝突に関与する policyId 群（同一 priority で同一フィールドを主張する 2 件以上・policyId 昇順）。 */
  readonly policyIds: NonEmptyArray<PolicyId>;
}

/**
 * detectAmbiguousAssignment — 割り当て済み Policy 群に曖昧な統制があるか検出する（要件3.4）。
 *
 * (priority, field) ごとに、そのフィールドを主張する policyId を積み、2 件以上積まれた組を曖昧な衝突として
 * 返す。返す衝突は決定的な順序（priority 昇順・field 昇順）に並べ、各衝突の policyIds も policyId 昇順で
 * 安定化する。曖昧さが無ければ空配列を返す（`.length === 0` と「曖昧なし」が同値・Property 6 の iff）。
 *
 * 単一 Policy が同一フィールドを重複主張することはない（PolicyFields はフィールドごとに単一の ModedValue）。
 * ゆえに衝突は必ず異なる 2 つ以上の Policy の間にのみ生じる。異なる priority で同一フィールドを主張するのは
 * 曖昧ではない（enforced 支配・default 上書きが priority で決定的に解決する）ため衝突としない。純粋・決定的。
 */
export function detectAmbiguousAssignment(
  policies: readonly Policy[],
): readonly AmbiguousPolicyConflict[] {
  // (priority, field) → 主張する policyId 群。priority は数値、field は固定名（コロンを含まない）ゆえ
  // `${priority}:${field}` はキーとして衝突しない。
  const claims = new Map<string, { priority: number; field: string; policyIds: PolicyId[] }>();

  for (const policy of policies) {
    for (const field of assertedFields(policy)) {
      const key = `${policy.priority}:${field}`;
      const claim = claims.get(key);
      if (claim === undefined) {
        claims.set(key, { priority: policy.priority, field, policyIds: [policy.policyId] });
      } else {
        claim.policyIds.push(policy.policyId);
      }
    }
  }

  const conflicts: AmbiguousPolicyConflict[] = [];
  for (const claim of claims.values()) {
    const sorted = [...claim.policyIds].sort(compareStrings);
    // 2 件以上のときだけ曖昧（単一主張は勝敗が決定的）。isNonEmpty は length>=2 ゆえ自明に満たす。
    if (claim.policyIds.length >= 2 && isNonEmpty(sorted)) {
      conflicts.push({ priority: claim.priority, field: claim.field, policyIds: sorted });
    }
  }

  return conflicts.sort((a, b) => a.priority - b.priority || compareStrings(a.field, b.field));
}

/** Policy が実際に主張しているフィールド名（値が存在するもの）を列挙する。 */
function assertedFields(policy: Policy): readonly string[] {
  return Object.keys(policy.fields).filter(
    (field) => policy.fields[field as keyof PolicyFields] !== undefined,
  );
}

/** policyId / field 同着の安定化に用いる決定的な文字列比較（辞書順・昇順）。 */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
