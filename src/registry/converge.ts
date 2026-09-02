// registry/converge.ts — 収束の純粋核。
//
// 「今どの店舗を・どの投影で押すべきか」「残作業をどう更新するか」という純粋な決定だけを切り出す。
// 実際の作用（イデアの put・applyProjection RPC 押し込み・setAlarm）は shell（StoreRegistryDO）が
// 端で実行する（計算と作用の分離）。本モジュールは cloudflare:workers にも storage にも触れない。
//
// 三つの純粋関数を提供する：
//   - affectedStores    … 変更種別から収束対象の storeId を過不足なく逆引きする（要件3.7）
//   - recomposeProjection … 最新イデアから当該店舗の投影を再合成する（決定的・要件5.4）
//   - nextResidual      … 押し込み成否から残作業リストを更新する（成功で除去・失敗で保持・要件5.8）

import type { Chain, ChainId, Policy, PolicyId, Store, StoreId } from "./ideal";
import type { StoreProjection } from "./projection";
import { composeEffectiveConfig } from "./compose";
import { effectiveRoster } from "./roster";

/**
 * RosterTarget — 名簿変更の対象。チェーン名簿は全店へ、店舗名簿は当該店へ波及する（要件3.5 / 3.7）。
 * scope でチェーン／店舗を判別する（同定する識別子だけを持つ最小の記述）。
 */
export type RosterTarget =
  | { readonly scope: "chain"; readonly chainId: ChainId }
  | { readonly scope: "store"; readonly storeId: StoreId };

/**
 * IdealChange — イデアのどの部分が変わったかを表す変更種別（要件3.7）。
 * この記述だけから affectedStores が影響店舗を逆引きできる（変更＝収束の起点）。
 * kind でチェーン／Policy／店舗／名簿の各変種を判別する（レジストリ内部の語彙）。
 */
export type IdealChange =
  | { readonly kind: "chain"; readonly chainId: ChainId }
  | { readonly kind: "policy"; readonly policyId: PolicyId }
  | { readonly kind: "store"; readonly storeId: StoreId }
  | { readonly kind: "roster"; readonly target: RosterTarget };

/**
 * affectedStores — 変更種別に設定・名簿が依存する全店舗を過不足なく逆引きする（要件3.7）。
 *
 * ・チェーン変更 → そのチェーンに属する全店（chainId 一致）。
 * ・Policy 変更  → その Policy を割り当てている全店（policyIds に含む）。
 * ・店舗変更     → 当該店のみ。
 * ・名簿変更     → チェーン名簿なら全店、店舗名簿なら当該店（RosterTarget で分岐）。
 *
 * 参照するのは stores のみ（チェーン所属と Policy 割当はいずれも Store が保持する）。純粋・決定的。
 * 返す storeId は重複しない（各 Store の storeId は一意）。
 */
export function affectedStores(change: IdealChange, stores: readonly Store[]): readonly StoreId[] {
  switch (change.kind) {
    case "chain":
      return storeIdsInChain(stores, change.chainId);
    case "policy":
      return stores.filter((s) => s.policyIds.includes(change.policyId)).map((s) => s.storeId);
    case "store":
      return [change.storeId];
    case "roster":
      return change.target.scope === "chain"
        ? storeIdsInChain(stores, change.target.chainId)
        : [change.target.storeId];
  }
}

/** あるチェーンに属する店舗の storeId を返す内部ヘルパ（チェーン変更・チェーン名簿変更で共有）。 */
function storeIdsInChain(stores: readonly Store[], chainId: ChainId): readonly StoreId[] {
  return stores.filter((s) => s.chainId === chainId).map((s) => s.storeId);
}

/**
 * recomposeProjection — その時点の最新イデアから当該店舗の投影を再合成する（要件5.4 / 5.9）。
 *
 * 割り当て済み Policy 群と Store_Override から composeEffectiveConfig で config を合成し、
 * 店舗が属するチェーンの chainRoster と店舗 Roster の和集合を effectiveRoster で導出して roster に載せ、
 * active と version（= 合成時点のレジストリ revision）を添えた StoreProjection を返す。
 * 常に最新イデアから再導出するため、押し込みは履歴順序を持たず last-write-wins で自然収束する。
 *
 * 実効 Roster は effectiveRoster（純粋・冪等・順序非依存）で導出するため、recomposeProjection は
 * 決定的なまま保たれる（Property 14）。roster はサーバ内部の投影値であり ServerMessage には載らない（要件5.3）。
 *
 * 同一イデア・同一 storeId・同一 revision からは常に同一の投影を返す（純粋・決定的）。
 * storeId は収束対象（affectedStores の返り値）であることを前提とし、イデアに存在しなければ
 * 前提違反として例外を投げる（黙って既定へ畳まない — 収束台帳を壊さないため）。
 */
export function recomposeProjection(
  storeId: StoreId,
  chains: readonly Chain[], // 店舗が属するチェーンの chainRoster を実効 Roster の導出に用いる
  stores: readonly Store[],
  policies: readonly Policy[],
  revision: number,
): StoreProjection {
  const store = stores.find((s) => s.storeId === storeId);
  if (store === undefined) {
    throw new Error(`recomposeProjection: イデアに存在しない storeId: ${storeId}`);
  }
  const assigned = policies.filter((p) => store.policyIds.includes(p.policyId));
  const config = composeEffectiveConfig(assigned, store.override);
  // 実効 Roster = チェーン Roster と店舗 Roster の和集合（要件3.5）。
  // チェーンが未登録なら chainRoster を空として扱う（欠落に優雅に耐える・buildReverseIndex と同型）。
  const chain = chains.find((c) => c.chainId === store.chainId);
  const roster = effectiveRoster(chain?.chainRoster ?? [], store.storeRoster);
  return { config, roster, active: store.active, version: revision };
}

/**
 * nextResidual — 押し込み成否から残作業リストを更新する（要件5.8）。
 *
 * 成功なら当該 storeId を除去し、失敗なら保持する（集合としての和：既に含むなら重複させない）。
 * この更新の反復適用が、成功した店舗を漏れなく除去し失敗を残す at-least-once 収束の基盤になる。純粋・決定的。
 */
export function nextResidual(
  residual: readonly StoreId[],
  storeId: StoreId,
  pushOk: boolean,
): readonly StoreId[] {
  if (pushOk) {
    return residual.filter((id) => id !== storeId);
  }
  return residual.includes(storeId) ? residual : [...residual, storeId];
}
