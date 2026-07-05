// registry/reverse-index.ts — identity 逆引きインデックス（イデアからの導出値）。
// 正引き（店舗→identity）は投影として店舗 DO へ配るが、逆引き（identity→店舗）は
// レジストリ内のこのインデックスに残す（要件3.6）。Entry の行き先解決（要件7.2）は
// 保持済みインデックスの単一読み出しで完結し、全名簿の走査を要しない。
// 正本はあくまでイデア（chain:* / store:*）一本であり、本インデックスは名簿変更で
// 必ず再導出される導出値ゆえ、全イデアからいつでも再構築できる。
// cloudflare:workers にも storage にも触れない純粋モジュール。

import type { Chain, Store, StoreId, Identity, Roster } from "./ideal";
import { effectiveRoster } from "./roster";

/** identity → 接続可能店舗リストの逆引きインデックス（イデアからの導出値・要件3.6）。 */
export type ReverseIndex = ReadonlyMap<Identity, readonly StoreId[]>;

/**
 * buildReverseIndex — 全 Chain・Store から逆引きインデックスを事前計算する（名簿の書き込み時に再導出）。
 *
 * ・活性店舗のみを対象とする（active=false の閉店は逆引きに現れない・要件3.9 / 6.6）。
 * ・各店舗の実効 Roster（チェーン Roster と店舗 Roster の和集合）を effectiveRoster で導出し、
 *   その各 identity に storeId を積む（和集合の意味論・deny 手段の不在は roster.ts の責務）。
 * ・店舗の登録順（createdAt 昇順・同着は storeId 昇順）で走査するため、各 identity の店舗リストは
 *   登録順に並ぶ。これにより既定店舗（登録順の先頭・要件7.4）の決定が安定する。
 *   updatedAt を順序基準にすると店舗更新のたびに「先頭」が動くため、不変の createdAt を用いる。
 * ・純粋・決定的：同一イデアからは常に同一のインデックスを返す。
 */
export function buildReverseIndex(chains: readonly Chain[], stores: readonly Store[]): ReverseIndex {
  // chainId → チェーン Roster の引き当て表（店舗が参照するチェーン名簿の供給源）。
  const chainRosterById = new Map<string, Roster>();
  for (const chain of chains) {
    chainRosterById.set(chain.chainId, chain.chainRoster);
  }

  // 活性店舗のみを登録順（createdAt 昇順・同着 storeId 昇順）で安定に走査する。
  const activeStores = stores
    .filter((store) => store.active)
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt || (a.storeId < b.storeId ? -1 : a.storeId > b.storeId ? 1 : 0));

  const index = new Map<Identity, StoreId[]>();
  for (const store of activeStores) {
    // チェーンが未登録なら、その和集合はチェーン側を空として扱う（欠落に優雅に耐える）。
    const chainRoster = chainRosterById.get(store.chainId) ?? [];
    for (const identity of effectiveRoster(chainRoster, store.storeRoster)) {
      const reached = index.get(identity);
      if (reached === undefined) {
        index.set(identity, [store.storeId]);
      } else {
        reached.push(store.storeId);
      }
    }
  }

  return index;
}

/**
 * storesForIdentity — 逆引きインデックスの単一読み出し（Entry の行き先解決・要件7.2）。
 *
 * 未登録 identity は空配列を返す。全名簿を走査しない（保持済みインデックスの参照のみ）。
 */
export function storesForIdentity(index: ReverseIndex, identity: Identity): readonly StoreId[] {
  return index.get(identity) ?? [];
}
