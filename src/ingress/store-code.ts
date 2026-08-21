// src/ingress/store-code.ts — Record から Store_Code を読み、Store_Code ごとの組へ畳む。
//
// Store_Code は `payload.store_id`（外部マスタの店舗コード）であり、URL に載る StoreId（推測困難な
// ランダム base32 スラッグ）とは別概念である。ここが読むのは前者だけで、後者への逆引きは
// src/registry/code-index.ts の関心事である——この分離を保つため、本モジュールは registry を知らない。
//
// cloudflare:workers にも storage にも触れない純粋モジュール（AC 1.8）。

import type { ArrivalRecord } from "./batch";
import { readDeclaredText } from "./declared-text";

/**
 * StoreCodeGroups — Record 列を Store_Code ごとに畳んだ結果。
 *
 * **Store_Code を読み出せなかった Record を黙って落とさず、別の列として返す。** 落とせば呼び出し元が
 * 件数の帳尻を合わせられず、欠落が誰にも見えない（Duplicate_Bias が守るのは重複と欠落の分岐だが、
 * ここでは「気づけるかどうか」の分岐である）。分類（`poison` の `"unique-key-incomplete"`）は
 * `RecordOutcome` の関心事ゆえ本モジュールは種別を名乗らず、読み出せなかった事実だけを返す。
 *
 * 入力の各 Record は `byStoreCode` のいずれか 1 つの組か `unreadableStoreCode` のどちらか一方に
 * 必ず 1 回だけ現れる（畳んだ結果が入力の分割になっている）。
 */
export interface StoreCodeGroups {
  /**
   * Store_Code → 当該店舗の Record 列（到着順）。
   *
   * `Map` で返すことが「同一 Store_Code は結果に 1 回だけ現れる」ことである（AC 4.7）。組の列で返せば
   * 同じコードが二度現れうる形になり、Worker が同じ照会を繰り返す余地が型に残る。
   */
  readonly byStoreCode: ReadonlyMap<string, readonly ArrivalRecord[]>;
  /** Store_Code を読み出せなかった Record（到着順）。宛先が定まらないため組に属せない。 */
  readonly unreadableStoreCode: readonly ArrivalRecord[];
}

/**
 * groupByStoreCode — Record 列を Store_Code ごとの組へ畳む（AC 5.1・5.3・4.7）。
 *
 * **同一 Store_Code 内の到着順を保つ。** 上流のパーティションキーが `store_id` で並列度 1 ゆえ、同一
 * `store_id` の Record は到着順で届く。その順序をここで失えば、下流の単調性による冪等（`sequence_number`
 * が単調でなければ重複として読み飛ばす）が意味を失い、後着の内容が先着に負ける。
 *
 * 異なる Store_Code 間の順序は揃えない（上流も保証しない・AC 5.4）。`Map` の反復順は各 Store_Code の
 * 初出順になるが、これは畳み方の帰結であって表明ではない。
 */
export function groupByStoreCode(records: readonly ArrivalRecord[]): StoreCodeGroups {
  const byStoreCode = new Map<string, ArrivalRecord[]>();
  const unreadableStoreCode: ArrivalRecord[] = [];

  for (const record of records) {
    // Store_Code は Unique_Key の 4 要素の 1 つと同一の値ゆえ、読み出しも同一の関門を通す
    // （規則を二箇所に置けば「宛先は決まらないが識別子は成立する」Record が生まれる）。
    const storeCode = readDeclaredText(record.payload.store_id);
    if (storeCode === null) {
      unreadableStoreCode.push(record);
      continue;
    }
    const arrived = byStoreCode.get(storeCode);
    if (arrived === undefined) {
      byStoreCode.set(storeCode, [record]);
    } else {
      // 既存の組へ push することで到着順が保たれる（間に他店舗が挟まっても並びは崩れない）。
      arrived.push(record);
    }
  }

  return { byStoreCode, unreadableStoreCode };
}
