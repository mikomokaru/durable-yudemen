// registry/slug.ts — storeId の採番と検証。
// 純粋関数は「乱数バイト列 → slug」の符号化に留め、乱数採取（crypto.getRandomValues）は
// shell が担う。cloudflare:workers にも storage にも触れない純粋モジュール。

import type { StoreId } from "./ideal";

/** storeId の許容形 — 許容文字集合（[a-z0-9-]）かつ長さ 1..64（要件1.2 / 2.3）。 */
const STORE_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

/** storeId の最大長。mintStoreId はこの境界を超える slug を構築しない（不正な storeId を表現不能にする）。 */
const MAX_STORE_ID_LENGTH = 64;

/**
 * base32 の符号化表（RFC 4648 を小文字化）。全 32 文字が [a-z0-9] に収まるため、
 * ここから組む slug は常に isValidStoreId の許容文字集合を満たす。1 文字 = 5 ビット。
 */
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** raw が storeId の許容文字集合・長さ（[a-z0-9-]・1..64）を満たすか（要件1.2 / 2.3）。 */
export function isValidStoreId(raw: string): boolean {
  return STORE_ID_PATTERN.test(raw);
}

/**
 * mintStoreId — 乱数バイト列を [a-z0-9-] の推測困難スラッグへ符号化する（要件2.2）。
 *
 * 純粋関数としてはバイト列 → slug の符号化に留め、乱数採取は shell が担う。出力は必ず
 * isValidStoreId を満たす：符号化表が [a-z0-9] のみ（文字集合）で、長さは MAX_STORE_ID_LENGTH
 * で頭打ちにする（長さ上限）。randomBytes は非空を前提とする — shell は固定長の乱数バッファを
 * 供給する。空入力は空文字となり storeId たりえないため、非空の保証は呼び出し側（shell）が持つ。
 */
export function mintStoreId(randomBytes: Uint8Array): StoreId {
  let acc = 0; // 未出力ビットの蓄積
  let bits = 0; // acc に溜まっている有効ビット数
  let slug = "";

  for (const byte of randomBytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      slug += BASE32_ALPHABET.charAt((acc >>> bits) & 31);
      if (slug.length === MAX_STORE_ID_LENGTH) return slug; // 長さ上限で打ち切る（不正長を作らない）
    }
    acc &= (1 << bits) - 1; // 出力済みの上位ビットを捨てる（32bit オーバーフロー防止）
  }

  if (bits > 0) {
    // 端数ビットを左詰めして 1 文字に符号化し、末尾の乱数も slug に反映する
    slug += BASE32_ALPHABET.charAt((acc << (5 - bits)) & 31);
  }

  return slug;
}
