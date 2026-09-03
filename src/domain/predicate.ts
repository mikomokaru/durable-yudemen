// domain/predicate.ts — 自分の型を持たない検査の唯一の持ち主。
//
// ここに置くのは「その検査のために型を一つ立てるほどではない」述語だけである。型と対になる述語は型の隣に置く
// ——`isNonEmpty` は `NonEmptyArray` の定義と同居して timer.ts に、`isFirmness` は Firmness と同居して
// firmness.ts に在る。名前だけを移しても概念は動かない。
//
// このモジュールは**何も import しない葉**である。store.ts / order.ts / wire.ts のいずれからも循環なく
// 依存できる位置を保つための制約であり、ここに型やドメインの語彙を持ち込まない。
//
// 同じ検査が engine/migrate.ts と observe/log.ts に無名で二重化しており、それらはここへ寄せる。

/**
 * 非 null のオブジェクトを `Record<string, unknown>` として確立する。
 *
 * 未検証の生値からプロパティを読む前段の唯一の関門。`typeof value === "object"` は null を含むため、
 * 二つの条件を一つの述語へ閉じる（片方だけを書き忘れる余地を残さない）。配列も object ゆえ通るが、
 * 呼び出し側は配列を `toArrayOf` の側で先に分岐するため、ここで配列を弾く必要はない。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 非空の文字列か。
 *
 * 空文字を弾くのは、識別子として使われる文字列（`externalOrderId` / `tableId` / `noodleType`）が
 * 空のとき「無い」と区別できなくなるためである。空文字を通せば、どの注文も指さない参照が組を成す。
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * 0 以上の整数か。
 *
 * `NaN` / `Infinity` は比較をすり抜けるため、整数性を先に要求する（`Number.isInteger` は双方を false と
 * する）。品目連番・件数・エポックミリ秒の下限がこの形を共有する。
 */
export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
