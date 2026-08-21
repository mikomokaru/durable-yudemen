// registry/code-index.ts — Store_Code 逆引きインデックス（イデアからの導出値）。
// 外部マスタの店舗コード（Store.storeCode）から宛先 StoreId を引く。reverse-index.ts と同型に置く。
// 基数だけが違う——Store_Code は全店で一意ゆえ単数、identity は複数店舗に届きうるゆえ複数。
// 正本はイデア（store:*）一本であり、本インデックスは店舗の書き込みで必ず再導出される導出値ゆえ、
// 全イデアからいつでも再構築できる。
// cloudflare:workers にも storage にも触れない純粋モジュール。

import type { Store, StoreId } from "./ideal";
import { isNonEmpty, type NonEmptyArray } from "../domain/timer";

/** Store_Code → 宛先 StoreId の逆引きインデックス（イデアからの導出値・要件2.1）。 */
export type CodeIndex = ReadonlyMap<string, StoreId>;

/**
 * DuplicateStoreCode — 一件の Store_Code 衝突。
 * 同一の Store_Code を主張する 2 つ以上の店舗を、そのコードと関与する storeId 群として表明する
 * （宛先が一意に定まらない組）。拒否理由の再構成に足る情報を持たせる（AmbiguousPolicyConflict と同型）。
 */
export interface DuplicateStoreCode {
  readonly storeCode: string;
  /** 衝突に関与する storeId 群（同一 Store_Code を主張する 2 件以上・storeId 昇順）。 */
  readonly storeIds: NonEmptyArray<StoreId>;
}

/**
 * buildCodeIndex — 全店舗から Store_Code の逆引きインデックスを再導出する（店舗の書き込み時に再導出・要件2.2）。
 *
 * ・**非活性店舗も含める**（要件2.7）。Store_Code は全店で一意ゆえ逆引きは活性状態に依らず一意であり、
 *   閉店の判定は StoreTimerDO の既存ゲートに任せる。索引を活性で絞れば「閉店だから届かない」の判断が
 *   二箇所に分かれる。
 * ・Store_Code を持たない店舗は載せない（要件3.8。Store_Code は任意のメタデータであり、
 *   POS_Ingress の宛先にならない店舗を許容する）。
 * ・純粋・決定的：同一イデアからは常に同一のインデックスを返す。衝突が在っても結果が揺れないよう、
 *   登録順（createdAt 昇順・同着は storeId 昇順）で走査して先着を残す。順序基準に updatedAt を
 *   用いれば店舗更新のたびに宛先が動くため、不変の createdAt を用いる（reverse-index と同一の規律）。
 *   なお衝突自体は detectDuplicateStoreCodes が確定の前に拒否するため、先着が残る形は
 *   「イデアが不正なときも索引が決定的である」ことだけを保証する。
 */
export function buildCodeIndex(stores: readonly Store[]): CodeIndex {
  // 登録順（createdAt 昇順・同着は storeId 昇順）で安定に走査する。
  const orderedStores = stores
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || compareStrings(a.storeId, b.storeId));

  const index = new Map<string, StoreId>();
  for (const store of orderedStores) {
    const storeCode = store.storeCode;
    if (storeCode !== undefined && !index.has(storeCode)) {
      index.set(storeCode, store.storeId);
    }
  }

  return index;
}

/**
 * storeForCode — 逆引きインデックスの単一読み出し（宛先解決・要件2.4）。
 *
 * 未知の Store_Code は undefined を返し、いかなる店舗へもフォールバックしない（要件2.6）。
 * 全店舗を走査しない（保持済みインデックスの参照のみ）。
 */
export function storeForCode(index: CodeIndex, storeCode: string): StoreId | undefined {
  return index.get(storeCode);
}

/**
 * detectDuplicateStoreCodes — 店舗集合に Store_Code の衝突があるか検出する（要件3.1 / 3.6）。
 *
 * Store_Code ごとに、それを主張する storeId を積み、2 件以上積まれた組を衝突として返す。返す衝突は
 * 決定的な順序（storeCode 昇順）に並べ、各衝突の storeIds も storeId 昇順で安定化する。衝突が無ければ
 * 空配列を返す（`.length === 0` と「衝突なし」が同値）。
 *
 * 活性状態で絞らない（要件3.1：Store_Code は active / deactivated を問わず全店で一意）。閉店した店舗の
 * コードを別店舗が再利用できれば、閉店前に届いた保留分の宛先が後から変わる。
 * 本関数は検出（計算）だけを担い、HTTP 400 応答やイデアの put 有無は判定しない（作用は shell が持つ）。
 */
export function detectDuplicateStoreCodes(stores: readonly Store[]): readonly DuplicateStoreCode[] {
  const claims = new Map<string, StoreId[]>();
  for (const store of stores) {
    const storeCode = store.storeCode;
    if (storeCode === undefined) continue;
    const claim = claims.get(storeCode);
    if (claim === undefined) {
      claims.set(storeCode, [store.storeId]);
    } else {
      claim.push(store.storeId);
    }
  }

  const duplicates: DuplicateStoreCode[] = [];
  for (const [storeCode, storeIds] of claims) {
    const sorted = [...storeIds].sort(compareStrings);
    // 2 件以上のときだけ衝突（単一主張は宛先が一意）。isNonEmpty は length>=2 ゆえ自明に満たす。
    if (storeIds.length >= 2 && isNonEmpty(sorted)) {
      duplicates.push({ storeCode, storeIds: sorted });
    }
  }

  return duplicates.sort((a, b) => compareStrings(a.storeCode, b.storeCode));
}

/** storeId / storeCode 同着の安定化に用いる決定的な文字列比較（辞書順・昇順）。 */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
