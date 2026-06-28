// domain/store.ts — 店舗のサーバ権威設定（StoreConfig）。Timer の SSOT フローとは別概念。
// プラットフォーム非依存の純粋な型と検証だけを持つ。import を持たない。
//
// StoreConfig はクライアントが制御しない（UI から変更不可・店舗ごとに固定）サーバ権威の設定で、
// サーバから各クライアントへ一方向に配信される（config ServerMessage）。Timer のような
// クライアントコマンド駆動の状態遷移（decide/Effect）には乗らない。
//
// 値の源は env シード（STORE_UNIT_COUNT）で、DO 初回構築時に検証して storeConfig として永続する。
// 詳細は yude-men-timer/design.md「店舗設定の配信（StoreConfig）」を参照。

/** ユニット総数の下限（1 ユニット = 6 スロット）。 */
export const UNIT_COUNT_MIN = 1;

/** ユニット総数の上限（4 ユニット = 24 スロット）。 */
export const UNIT_COUNT_MAX = 4;

/** ユニット総数の既定。env シード不在・不正・接続前のクライアント表示のフォールバックに用いる。 */
export const DEFAULT_UNIT_COUNT = 3;

/**
 * StoreConfig — 店舗のサーバ権威設定。現行はユニット総数のみ。
 *
 * クライアントは受信して表示・担当範囲のクランプに用いるが、変更はできない（サーバ権威）。
 * 将来サーバ制御の設定が増えればここへ足す（配信機構 config は StoreConfig 全体を運ぶ）。
 */
export interface StoreConfig {
  /** 店舗のユニット総数（UNIT_COUNT_MIN〜UNIT_COUNT_MAX）。1 ユニット = 6 スロット。 */
  readonly unitCount: number;
}

/**
 * 任意の生値（env 文字列・永続値など）を、範囲内の整数ユニット総数へ写す純粋関数。
 *
 * 整数でない・範囲外・非有限はすべて DEFAULT_UNIT_COUNT へ畳む（不正値を表現させない）。
 * 範囲内へはクランプし、検証を一箇所へ集約する。
 */
export function toUnitCount(raw: unknown): number {
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return DEFAULT_UNIT_COUNT;
  }
  return Math.min(Math.max(value, UNIT_COUNT_MIN), UNIT_COUNT_MAX);
}
