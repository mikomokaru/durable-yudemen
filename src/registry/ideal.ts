// registry/ideal.ts — イデア（望ましい設定の正本）の型。
// レジストリだけが使う語彙であり domain には置かない（audience に従う）。
// cloudflare:workers にも storage にも触れない純粋モジュール。
//
// NOTE: 本ファイルはレジストリの型の最終形。イデアの語彙一式（Chain / Policy / StoreOverride /
// Roster / Identity / Store）を SSOT として一箇所に置く。StoreId は slug.ts が、Policy /
// StoreOverride は composeEffectiveConfig（compose.ts）が、Roster は projection.ts が依存する。

import type { NonEmptyArray } from "../domain/timer";
import type { FirmnessCode, MenuItem, NoodlePreset } from "../domain/store";

/** storeId — 店舗 DO の名前（idFromName のキー）かつ URL 宛先。グローバル一意のスラッグ。 */
export type StoreId = string;

/** チェーン識別子（イデアのメタデータ。URL・DO 名には出さない）。 */
export type ChainId = string;

/** Policy 識別子。 */
export type PolicyId = string;

/** identity — Access が発行する JWT の正準クレーム（不透明な文字列）。Roster の要素。 */
export type Identity = string;

/** Roster — 接続を許可する identity の集合（順序に意味を持たせない・重複は同一視）。ワイヤに出さない。 */
export type Roster = readonly Identity[];

/** Policy のフィールド mode。enforced = 統制（後の層は上書き不可）／default = 既定供給（上書き可）。 */
export type PolicyMode = "enforced" | "default";

/** mode 付きの値。Policy はフィールドごとに mode と値を持つ（要件3.3）。 */
export interface ModedValue<T> {
  readonly mode: PolicyMode;
  readonly value: T;
}

/**
 * PolicyFields — Policy が主張するフィールドの部分集合（各フィールドは任意）。
 * StoreConfig の各フィールドに対応し、Policy はその一部だけを mode 付きで主張してよい。
 */
export interface PolicyFields {
  readonly unitCount?: ModedValue<number>;
  readonly arms?: ModedValue<number>;
  readonly toleranceRatio?: ModedValue<number>;
  readonly noodlePresets?: ModedValue<NonEmptyArray<NoodlePreset>>; // 配列は丸ごと置換の単位（要件4.4）
  // POS の対応表 2 枚も Policy が主張できる形にする（硬さコードとメニューはチェーン共通の可能性が高く、
  // 統制で配れなければ全店へ同じ表を個別投入することになる）。noodlePresets と同じく丸ごと置換の単位。
  readonly firmnessCodes?: ModedValue<readonly FirmnessCode[]>;
  readonly menuItems?: ModedValue<readonly MenuItem[]>;
}

/** Policy — 名前・priority・フィールドごとの mode/値。地域差・業態差は Policy の割当で表現する（要件3.3）。 */
export interface Policy {
  readonly policyId: PolicyId;
  readonly chainId: ChainId;
  readonly name: string;
  readonly priority: number; // 小さいほど上位（全社統制）。昇順に畳む（要件4.2 / 4.3）
  readonly fields: PolicyFields;
}

/** Store_Override — 店舗の個別値（部分設定）。合成の最終層。統制中も保持し、無視するに留める（要件4.7）。 */
export interface StoreOverride {
  readonly unitCount?: number;
  readonly arms?: number;
  readonly toleranceRatio?: number;
  readonly noodlePresets?: NonEmptyArray<NoodlePreset>;
  // 店舗が主張する対応表（券売機の商品コードは店舗によって異なりうる）。店舗の主張ゆえ mode は持たない。
  readonly firmnessCodes?: readonly FirmnessCode[];
  readonly menuItems?: readonly MenuItem[];
}

/** Chain — 店舗を束ねる組織単位。個人店も店舗 1 のチェーンとして表す（同型・要件3.2）。 */
export interface Chain {
  readonly chainId: ChainId;
  readonly name: string;
  readonly chainRoster: Roster; // 全店共通の名簿（本部・SV 等）
}

/** Store — 店舗のイデア。所属 chainId・Policy 割当・Store_Override・店舗 Roster・活性状態を持つ（要件3.1 / 3.9）。 */
export interface Store {
  readonly storeId: StoreId;
  readonly chainId: ChainId;
  readonly name: string; // 人間可読の店舗名（Entry の店舗リスト・切替 UI の表示用。storeId はランダムスラッグゆえ表示に使えない）
  readonly policyIds: readonly PolicyId[]; // このチェーンの Policy のうち店舗へ割り当てるもの
  readonly override: StoreOverride;
  readonly storeRoster: Roster;
  readonly active: boolean; // false = deactivated（閉店・要件3.9 / 6.6）
  readonly storeCode?: string; // 外部マスタの店舗コード（イデアのメタデータ。URL には漏らさない・要件2.2）
  readonly createdAt: number; // 登録時刻（不変）。既定店舗（登録順の先頭・要件7.4）の順序基準
  readonly updatedAt: number; // 最終更新時刻（監査・一覧表示用）。収束の突き合わせには revision を用いる
}
