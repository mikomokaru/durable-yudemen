// domain/store.ts — 店舗のサーバ権威設定（StoreConfig）。Timer の SSOT フローとは別概念。
// プラットフォーム非依存の純粋な型と検証だけを持つ（domain 内の timer 契約のみ取り込む）。
//
// StoreConfig はクライアントが制御しない（UI から変更不可・店舗ごとに固定）サーバ権威の設定で、
// サーバから各クライアントへ一方向に配信される（config ServerMessage）。Timer のような
// クライアントコマンド駆動の状態遷移（decide/Effect）には乗らない。
//
// 値の源は env シード（STORE_UNIT_COUNT / STORE_NOODLE_PRESETS）で、DO 初回構築時に検証して
// storeConfig として永続する。稼働中の差し替えは運用エンドポイント（PUT /admin/config）が再投入する。
// 詳細は yude-men-timer/design.md「店舗設定の配信（StoreConfig）」を参照。

import { isNonEmpty, type NonEmptyArray } from "./timer";
import { FIRMNESS_ORDER, type Firmness } from "./firmness";

/** ユニット総数の下限（1 ユニット = 6 スロット）。 */
export const UNIT_COUNT_MIN = 1;

/** ユニット総数の上限（4 ユニット = 24 スロット）。 */
export const UNIT_COUNT_MAX = 4;

/** ユニット総数の既定。env シード不在・不正・接続前のクライアント表示のフォールバックに用いる。 */
export const DEFAULT_UNIT_COUNT = 3;

/** 硬さ別の茹で時間（秒）。麺ごとに異なる値を持つ（券売機統合・運用注入の写し先）。 */
export type FirmnessSeconds = Readonly<Record<Firmness, number>>;

/**
 * NoodlePreset — 店舗が提供する麺種と、その麺の硬さ別茹で時間（秒）の組。開始操作の入力をこの集合へ閉じ込める。
 *
 * 茹で時間は「麺の種類ごと」に硬さ別で定義する（FirmnessSeconds）。開始は既定 normal を用い、茹で加減の
 * 変更でその麺の該当秒へ endTime を引き直す。サーバ権威でクライアントは変更不可。茹で時間の範囲ポリシー
 * （1〜1800 秒）の正本は engine の validateStart / adjustTimer にあり、ここでは構造（非空の種別名・全 4 硬さの
 * 正の整数秒）の健全性だけを担保する。
 */
export interface NoodlePreset {
  readonly noodleType: string;
  readonly boilSeconds: FirmnessSeconds;
}

/** 麺種プリセットの既定。env シード不在・不正・接続前のクライアント表示のフォールバックに用いる。 */
export const DEFAULT_NOODLE_PRESETS: NonEmptyArray<NoodlePreset> = [
  { noodleType: "Thin", boilSeconds: { extraHard: 45, hard: 52, normal: 60, soft: 75 } },
  { noodleType: "Medium", boilSeconds: { extraHard: 75, hard: 82, normal: 90, soft: 105 } },
  { noodleType: "Thick", boilSeconds: { extraHard: 100, hard: 110, normal: 120, soft: 140 } },
];

/**
 * StoreConfig — 店舗のサーバ権威設定（ユニット総数＋麺種プリセット）。
 *
 * クライアントは受信して表示・担当範囲のクランプ・開始選択肢の提示に用いるが、変更はできない（サーバ権威）。
 * 将来サーバ制御の設定が増えればここへ足す（配信機構 config は StoreConfig 全体を運ぶ）。
 */
export interface StoreConfig {
  /** 店舗のユニット総数（UNIT_COUNT_MIN〜UNIT_COUNT_MAX）。1 ユニット = 6 スロット。 */
  readonly unitCount: number;
  /** 店舗が提供する麺種プリセット（型で非空を強制・開始 UI はこの集合だけを咲かせる）。 */
  readonly noodlePresets: NonEmptyArray<NoodlePreset>;
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

/**
 * 任意の生値（env の JSON 文字列・永続配列・運用投入のボディなど）を、非空の麺種プリセット列へ写す純粋関数。
 *
 * 文字列は JSON として解釈し（失敗は既定へ）、配列でなければ既定へ畳む。各要素は構造検証（非空の noodleType・
 * 正の整数 boilSeconds）に通ったものだけを正規化して残す。結果が空なら DEFAULT_NOODLE_PRESETS へ畳む
 * （「不正な状態を表現可能にしない」を基数へ適用＝開始 UI が必ず 1 つ以上の選択肢を持つ）。検証を一箇所へ集約する。
 */
export function toNoodlePresets(raw: unknown): NonEmptyArray<NoodlePreset> {
  const source = typeof raw === "string" ? parseJson(raw) : raw;
  if (!Array.isArray(source)) {
    return DEFAULT_NOODLE_PRESETS;
  }
  const presets: NoodlePreset[] = [];
  for (const item of source) {
    const preset = toNoodlePreset(item);
    if (preset !== null) presets.push(preset);
  }
  return isNonEmpty(presets) ? presets : DEFAULT_NOODLE_PRESETS;
}

/** 生値を NoodlePreset へ正規化する。構造（非空種別名・全 4 硬さの正の整数秒）を満たさなければ null。 */
function toNoodlePreset(value: unknown): NoodlePreset | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.noodleType !== "string" || candidate.noodleType.length === 0) return null;
  const boilSeconds = toFirmnessSeconds(candidate.boilSeconds);
  if (boilSeconds === null) return null;
  // 余剰フィールドを落として正規化する（store config に混ぜ物を残さない）。
  return { noodleType: candidate.noodleType, boilSeconds };
}

/** 生値を FirmnessSeconds へ。全 4 硬さが正の整数秒であることを要求する（一つでも欠け/不正なら null）。 */
function toFirmnessSeconds(value: unknown): FirmnessSeconds | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const seconds = {} as Record<Firmness, number>;
  for (const firmness of FIRMNESS_ORDER) {
    const sec = candidate[firmness];
    if (typeof sec !== "number" || !Number.isInteger(sec) || sec <= 0) return null;
    seconds[firmness] = sec;
  }
  return seconds;
}

/** JSON 文字列を解釈する。解釈不能は undefined（呼び出し側が既定へ畳む）。 */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
