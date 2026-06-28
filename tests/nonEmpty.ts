// tests/nonEmpty.ts — テスト生成器用：非空を実行時に確認して NonEmptyArray へ昇格する。
//
// 生成器は minLength 1 を保証するため実際には throw しないが、`as unknown as` のような
// 不正直なキャストを避け、「検証して型を確立する」という本番境界（src/domain/timer の isNonEmpty）と
// 同じ規律をテストでも用いる。fast-check がブランド型・タプル型を直接生成できない制約の橋渡し。

import { isNonEmpty, type NonEmptyArray } from "../src/domain/timer";

/** 非空を実行時に確認して NonEmptyArray<T> へ昇格する。空なら生成器の不変条件違反として throw。 */
export function nonEmpty<T>(values: readonly T[]): NonEmptyArray<T> {
  if (!isNonEmpty(values)) {
    throw new Error("test generator invariant violated: expected a non-empty array");
  }
  return values;
}
