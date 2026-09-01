// src/ingress/unique-key.ts — Unique_Key の導出。4 要素 → 識別子、または null。
//
// cloudflare:workers にも storage にも触れない純粋モジュール。
//
// **規則の正本は上流の Python `urllib.parse.quote(value, safe="/")` である。** 本経路が導く値は上流の
// `seen:{unique_key}:{hash}` の `unique_key` 部と同一の文字列になり、障害時に上下流の突き合わせが
// できる（AC 6.2）。ゆえに `encodeURIComponent` をそのまま使えない——あれは `! * ' ( )` を素通しし
// `/` を `%2F` へ写すため、上流と 6 文字で食い違う。

import { readDeclaredText } from "./declared-text";

/**
 * Unique_Key を成す 4 要素（AC 6.1）。**`order_id` を含めない。**
 *
 * 上流は `order_id` を表示用フィールドとして扱い、置換・削除しても一意キーが変わらないことを検証
 * している。含めれば上流の重複判定単位と本経路の識別単位がずれる（AC 6.3）。
 *
 * 順序が意味を持つ（`:` 連結の並びがそのまま識別子になる）ゆえ配列で持つ。
 */
const UNIQUE_KEY_FIELDS = ["store_id", "terminal_id", "bill_no", "datetime"] as const;

/** 要素の区切り。要素内の `:` は `%3A` へ写るため、この文字は常に区切りとしてだけ現れる。 */
const FIELD_SEPARATOR = ":";

/**
 * TextEncoder を用いるのは、上流が UTF-8 バイト列を `%XX` へ写すためである。
 *
 * 孤立サロゲートに対し Python の `quote` は例外を投げるが、こちらは U+FFFD へ畳む。上流が投げる値は
 * そもそも本経路へ届かないため差は観測されず、代わりに本関数が全域である（例外を投げない）ことを得る。
 */
const utf8 = new TextEncoder();

/**
 * toUniqueKey — payload の 4 要素から Unique_Key を導く。決定的（同一 payload から常に同一の値）。
 *
 * **null を返すのは 4 要素のいずれかを `readDeclaredText` が読み出せないときだけである**（AC 6.18 の
 * Poison_Record `unique-key-incomplete` に対応する）。読み出しの規則は宛先の Store_Code と共有する
 * ——同じ値の可否が識別子と宛先で分かれないためである（`declared-text.ts` 冒頭）。
 *
 * **4 要素すべてを同一の関門に通す。** 実データでは 3 要素が数値・`datetime` が文字列で届くが、要素ごとに
 * 規則を変えれば「規則が一つである」ことが名目だけになる。ゆえに `datetime` に数値が来れば 10 進表記
 * として通り、`bill_no` に文字列が来ればそのまま通る（型は拒否事由ではない・Requirement 14）。
 */
export function toUniqueKey(payload: Record<string, unknown>): string | null {
  const parts: string[] = [];
  for (const field of UNIQUE_KEY_FIELDS) {
    const text = readDeclaredText(payload[field]);
    if (text === null) return null;
    parts.push(quoteUpstream(text));
  }
  return parts.join(FIELD_SEPARATOR);
}

/**
 * 上流の `quote(value, safe="/")` と同一のパーセントエンコード。
 *
 * 素通しするのは無予約文字（英数字と `- _ . ~`）と既定の `safe` である `/` のみ。それ以外は UTF-8
 * バイト列の大文字 16 進 `%XX` へ写す。`~` を素通しするのは Python 3.7 以降の `quote` がこれを無予約
 * 文字として扱うためである。
 */
function quoteUpstream(value: string): string {
  let quoted = "";
  for (const byte of utf8.encode(value)) {
    quoted += isPassThroughByte(byte)
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return quoted;
}

/** 素通しするバイト。ASCII の範囲で閉じる（多バイト文字は必ず `%XX` へ写る）。 */
function isPassThroughByte(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) || // A-Z
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    (byte >= 0x2d && byte <= 0x2f) || // - . /（`/` は既定の safe）
    byte === 0x5f || // _
    byte === 0x7e // ~
  );
}
