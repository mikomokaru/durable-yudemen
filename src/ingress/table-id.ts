// src/ingress/table-id.ts — Record の `payload.table_no` を Table_Group の識別子へ読む。
//
// 上流の 1 フィールドをどう読むかだけを持つ（`noodle-spec.ts` / `store-code.ts` と同じ置き場）。
// 読んだ先の使い道——群の鍵・同時提供の採点——は engine の関心事であり、本モジュールは知らない。
//
// cloudflare:workers にも storage にも触れない純粋モジュール。

import { readDeclaredText } from "./declared-text";

/**
 * 上流の POS が「**卓が分からない**」を表すために送る `table_no` の値（2026-09-13・ユーザー確認）。
 *
 * **`1` は実在する 1 番卓ではない。** 券売機・カウンター・持ち帰りなど卓が特定できない受注に、
 * POS が既定値として入れて送る。`0` と欠落も同じ意味である。**全店共通の規則である。**
 *
 * **実在の卓として読むと、店の全注文が 1 つの Table_Group に畳まれる。** 実データ
 * （`noodle_plan_histories` 1,919 行・`kenbaiki_orders` 300 行）は**全行が `1`** ゆえ、
 * 誤読は全局面に及んでいた——同卓同時提供の項（`tableSyncWeight`）が**互いに無関係な杯を
 * 揃えようとし**、コーパス 12 局面の実測で**総費用の 28%（123,990）がその架空の圧力**だった
 * （`verification/table-id-unknown-20260914.md`）。
 *
 * ここで `null` へ正規化するので、**下流は誰も番兵値を知らない**。engine の `tableKeyOf` が
 * `null` を伝票ごとの群へ写す（卓が分からない品目は「同じ伝票のひとまとまり」として扱う）。
 */
export const UNKNOWN_TABLE_VALUES: ReadonlySet<string> = new Set(["0", "1"]);

/**
 * `payload.table_no` を Table_Group の識別子へ写す（AC 6.26）。卓が分からない品目は `null`。
 *
 * 読み出しは `readDeclaredText` に委ねる——実データでは卓番が数値で届き、Unique_Key の要素と同じ
 * 「申告値を文字列として読む」規則に従うのが素直である。番兵の除外を文字列化の**後**に置くのは、
 * 数値の `1` と文字列の `"1"` が同じ意味を表すためで、型によって扱いが分かれる形を作らない。
 */
export function toTableId(raw: unknown): string | null {
  const text = readDeclaredText(raw);
  return text === null || UNKNOWN_TABLE_VALUES.has(text) ? null : text;
}
