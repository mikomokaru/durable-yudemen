// src/ingress/declared-text.ts — payload の申告値を「処理を進めるために要る文字列」として読み出す
// 唯一の関門。
//
// この関門を通るのは Unique_Key の 4 要素（`store_id` / `terminal_id` / `bill_no` / `datetime`）と、
// その 1 つと同一の値である Store_Code だけである。**規則を 1 箇所に置くのは、識別子の成否と宛先の
// 成否が同じ値から導かれるためである**——二箇所に書けば「宛先は決まらないが識別子は成立する」
// Record が生まれ、同じ値の可否がどちらで見たかによって分かれる。
//
// **Pass_Through との境界がここに引かれる。** Requirement 14 は `payload` の中身を拒否事由にしないと
// 定めるが、Unique_Key の 4 要素は AC 6.18 が明示した唯一の例外である（識別子を導けなければ重複判定も
// 書き込みも進められない）。ゆえに本関門を 4 要素以外のフィールドへ広げない——広げた瞬間、素通しが
// 素通しでなくなる。
//
// cloudflare:workers にも storage にも触れない純粋モジュール（AC 1.8）。

/**
 * readDeclaredText — 申告値を文字列へ読み出す。読み出せなければ `null`。
 *
 * 読めるのは `string`（非空）と有限の `number` だけである。実データでは `store_id` / `terminal_id` /
 * `bill_no` が数値で届き `datetime` が文字列で届くため、両方を同一の関門で受ける（`1` と `"1"` は
 * 同一の値へ落ちる・AC 6.18・14.5）。
 *
 * **`String(raw)` を無条件に通さない。** symbol や `toString` が投げるオブジェクトで例外になり、解釈の
 * 全域性（Property 1）が破れる。`typeof` で先に絞れば try/catch も要らず、投げないことが構造から読める。
 *
 * **AC 6.18 の文言（欠落・null、または文字列化した結果が空文字）より厳しい側へ寄せている。** オブジェクト・
 * 配列・真偽値は文字列化すれば `[object Object]` や `"true"` になり空文字ではないが、ここでは読めない
 * ものとして扱う——`[object Object]` を宛先コードとして成立させれば、原因が「宛先未登録の 2 時間保留」に
 * 化けて失効とともに消える。毒として扱えば `poisonRecord` のカウンタと診断ログに残り、観測できる。
 * Duplicate_Bias は重複と欠落の分岐に適用する規律であり、ここは「気づけるかどうか」の分岐である。
 */
export function readDeclaredText(raw: unknown): string | null {
  if (typeof raw === "string") return raw.length === 0 ? null : raw;
  // 非有限の数値は文字列化しても識別子・宛先を成さない（"NaN" を宛先として扱わない）。
  if (typeof raw === "number") return Number.isFinite(raw) ? String(raw) : null;
  return null;
}
