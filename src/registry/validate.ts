// registry/validate.ts — レジストリ入口の拒否型検証（純粋関数）。
//
// イデアへ投入される生値（未検証・untrusted）を受け、未知フィールド・型不一致・値域外・必須欠落を
// 「拒否」として判定する。受理か拒否（理由付き）かの判定だけを返し、HTTP 400 応答やイデアの put 有無は
// 一切判定しない（作用は shell が持つ）。cloudflare:workers にも storage にも触れない純粋モジュール。
//
// 要件4.6 の核心は「黙って既定へ畳まない」こと。domain の to* 関数（toUnitCount ほか）は不正値を
// DEFAULT_* へ畳む（クランプ）が、機械間 API ではその畳み込みが投入元の誤りを隠蔽する。ゆえに本検証は
// domain の値域定数（UNIT_COUNT_MIN/MAX ほか）を直に用いて値域外をクランプ前に拒否する（to* は呼ばない）。
//
// 同一の純粋判定を Chain / Store 入口（Store_Override・Roster の値）と Policy 入口（PolicyFields の
// mode/値）の双方が再利用する。判定の対象（target）だけが異なり、値域・型・未知フィールドの検査ロジックは
// 一箇所に集約する。target はルートから導かれる信頼済みタグ、raw のみが untrusted。

import { FIRMNESS_ORDER } from "../domain/firmness";
import {
  UNIT_COUNT_MIN,
  UNIT_COUNT_MAX,
  ARMS_MIN,
  ARMS_MAX,
  TOLERANCE_RATIO_MIN,
  TOLERANCE_RATIO_MAX,
} from "../domain/store";
import { isNonEmpty, type NonEmptyArray } from "../domain/timer";

/** 拒否理由の区分（要件4.6 が挙げる 4 分岐に一致）。 */
export type RejectionReason =
  | "unknown-field" // 許可されないフィールドが存在する（黙って捨てず拒否する）
  | "type-mismatch" // 型が期待と異なる（整数期待の非整数を含む）
  | "out-of-range" // 型は合うが値域・基数（非空など）を外れる
  | "missing-required"; // 必須フィールドが欠落している

/** 一件の拒否。どのフィールドが、なぜ弾かれたかを表明する。 */
export interface Rejection {
  /** フィールドパス（例: "override.unitCount" / "noodlePresets[0].boilSeconds.hard"）。 */
  readonly path: string;
  readonly reason: RejectionReason;
  /** 人間可読の補足（許容値域・期待型など）。理由の再構成に足る情報を持たせる。 */
  readonly detail: string;
}

/** 受理／拒否の判定結果。拒否は必ず 1 件以上の理由を伴う（握り潰された失敗を残さない）。 */
export type ProvisioningVerdict =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly rejections: NonEmptyArray<Rejection> };

/**
 * 検証の対象。target はルート（信頼済み）から導かれる区分で、raw のみが untrusted な生値。
 * - storeOverride: Store_Override（StoreConfig 相当フィールドを平の値で任意保持）
 * - policyFields:  PolicyFields（同フィールドを ModedValue = { mode, value } で任意保持）
 * - roster:        Roster（接続許可 identity の配列）
 */
export type ProvisioningInput =
  | { readonly target: "storeOverride"; readonly raw: unknown }
  | { readonly target: "policyFields"; readonly raw: unknown }
  | { readonly target: "roster"; readonly raw: unknown };

/**
 * validateProvisioningInput — レジストリ入口の拒否型検証。純粋・決定的・作用なし。
 *
 * 受理なら { accepted: true }、拒否なら理由を全件（短絡せず）集約して返す。値域外はクランプ前に拒否する
 * （to* 関数を呼ばない）。判定のみを行い、HTTP・put には一切触れない。
 */
export function validateProvisioningInput(input: ProvisioningInput): ProvisioningVerdict {
  const rejections =
    input.target === "roster"
      ? validateRoster(input.raw, "roster")
      : validateStoreConfigFields(input.raw, input.target);
  return isNonEmpty(rejections) ? { accepted: false, rejections } : { accepted: true };
}

// ── StoreConfig 相当フィールド群の検証（Store_Override / PolicyFields で共有）──

/** StoreConfig 由来の数値フィールドと、その値域（クランプ前に拒否する基準）。 */
const NUMERIC_FIELD_RANGE = {
  unitCount: { min: UNIT_COUNT_MIN, max: UNIT_COUNT_MAX },
  arms: { min: ARMS_MIN, max: ARMS_MAX },
  toleranceRatio: { min: TOLERANCE_RATIO_MIN, max: TOLERANCE_RATIO_MAX },
} as const;

/** 主張してよいフィールド集合（数値 3 種＋配列 1 種）。これ以外は未知フィールドとして拒否する。 */
const ALLOWED_CONFIG_FIELDS: readonly string[] = [...Object.keys(NUMERIC_FIELD_RANGE), "noodlePresets"];

const POLICY_MODES: readonly string[] = ["enforced", "default"];

/**
 * Store_Override（平の値）または PolicyFields（ModedValue）を検証する。
 * どちらも「StoreConfig の一部を任意に主張する」形で、全フィールドが optional（欠落は拒否しない）。
 * 主張されたフィールドだけを、値域・型・（moded なら mode/value 構造）で検査する。
 */
function validateStoreConfigFields(
  raw: unknown,
  target: "storeOverride" | "policyFields",
): Rejection[] {
  const object = asRecord(raw);
  if (object === null) {
    return [{ path: target, reason: "type-mismatch", detail: "オブジェクトである必要がある" }];
  }

  const rejections: Rejection[] = [
    ...unknownFieldRejections(object, ALLOWED_CONFIG_FIELDS, target),
  ];

  for (const field of Object.keys(NUMERIC_FIELD_RANGE) as (keyof typeof NUMERIC_FIELD_RANGE)[]) {
    if (!(field in object)) continue; // optional — 欠落は拒否しない
    const range = NUMERIC_FIELD_RANGE[field];
    if (target === "policyFields") {
      rejections.push(...validateModed(object[field], `${field}`, (value, path) =>
        validateNumeric(value, range, path),
      ));
    } else {
      rejections.push(...validateNumeric(object[field], range, field));
    }
  }

  if ("noodlePresets" in object) {
    if (target === "policyFields") {
      rejections.push(...validateModed(object.noodlePresets, "noodlePresets", validateNoodlePresets));
    } else {
      rejections.push(...validateNoodlePresets(object.noodlePresets, "noodlePresets"));
    }
  }

  return rejections;
}

/** ModedValue<T> = { mode: "enforced" | "default"; value: T } の構造を検証し、value を委譲検証する。 */
function validateModed(
  raw: unknown,
  path: string,
  validateValue: (value: unknown, path: string) => Rejection[],
): Rejection[] {
  const object = asRecord(raw);
  if (object === null) {
    return [{ path, reason: "type-mismatch", detail: "{ mode, value } である必要がある" }];
  }

  const rejections: Rejection[] = [...unknownFieldRejections(object, ["mode", "value"], path)];

  if (!("mode" in object)) {
    rejections.push({ path: `${path}.mode`, reason: "missing-required", detail: "mode は必須" });
  } else if (typeof object.mode !== "string") {
    rejections.push({ path: `${path}.mode`, reason: "type-mismatch", detail: "文字列である必要がある" });
  } else if (!POLICY_MODES.includes(object.mode)) {
    rejections.push({
      path: `${path}.mode`,
      reason: "out-of-range",
      detail: `enforced | default のいずれか（受領: ${object.mode}）`,
    });
  }

  if (!("value" in object)) {
    rejections.push({ path: `${path}.value`, reason: "missing-required", detail: "value は必須" });
  } else {
    rejections.push(...validateValue(object.value, `${path}.value`));
  }

  return rejections;
}

/** 整数値域 [min, max] を、クランプ前に拒否する（domain の to* を呼ばない）。 */
function validateNumeric(raw: unknown, range: { min: number; max: number }, path: string): Rejection[] {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return [{ path, reason: "type-mismatch", detail: "有限の数値である必要がある" }];
  }
  if (!Number.isInteger(raw)) {
    return [{ path, reason: "type-mismatch", detail: "整数である必要がある" }];
  }
  if (raw < range.min || raw > range.max) {
    return [{ path, reason: "out-of-range", detail: `${range.min}〜${range.max} の範囲（受領: ${raw}）` }];
  }
  return [];
}

/**
 * noodlePresets を検証する。非空配列で、各要素が { noodleType: 非空文字列, boilSeconds: 全 4 硬さの正の整数秒 }
 * であることを要求する（toNoodlePresets の受理条件を、畳まず拒否として表明する）。
 */
function validateNoodlePresets(raw: unknown, path: string): Rejection[] {
  if (!Array.isArray(raw)) {
    return [{ path, reason: "type-mismatch", detail: "配列である必要がある" }];
  }
  if (raw.length === 0) {
    return [{ path, reason: "out-of-range", detail: "1 つ以上の麺種プリセットが必要" }];
  }

  const rejections: Rejection[] = [];
  raw.forEach((item, index) => {
    rejections.push(...validateNoodlePreset(item, `${path}[${index}]`));
  });
  return rejections;
}

/** 単一の NoodlePreset を検証する。 */
function validateNoodlePreset(raw: unknown, path: string): Rejection[] {
  const object = asRecord(raw);
  if (object === null) {
    return [{ path, reason: "type-mismatch", detail: "オブジェクトである必要がある" }];
  }

  const rejections: Rejection[] = [
    ...unknownFieldRejections(object, ["noodleType", "boilSeconds"], path),
  ];

  if (!("noodleType" in object)) {
    rejections.push({ path: `${path}.noodleType`, reason: "missing-required", detail: "noodleType は必須" });
  } else if (typeof object.noodleType !== "string") {
    rejections.push({ path: `${path}.noodleType`, reason: "type-mismatch", detail: "文字列である必要がある" });
  } else if (object.noodleType.length === 0) {
    rejections.push({ path: `${path}.noodleType`, reason: "out-of-range", detail: "空文字列は不可" });
  }

  if (!("boilSeconds" in object)) {
    rejections.push({ path: `${path}.boilSeconds`, reason: "missing-required", detail: "boilSeconds は必須" });
  } else {
    rejections.push(...validateBoilSeconds(object.boilSeconds, `${path}.boilSeconds`));
  }

  return rejections;
}

/** FirmnessSeconds を検証する。全 4 硬さが正の整数秒であることを要求する。 */
function validateBoilSeconds(raw: unknown, path: string): Rejection[] {
  const object = asRecord(raw);
  if (object === null) {
    return [{ path, reason: "type-mismatch", detail: "オブジェクトである必要がある" }];
  }

  const rejections: Rejection[] = [...unknownFieldRejections(object, FIRMNESS_ORDER, path)];

  for (const firmness of FIRMNESS_ORDER) {
    const fieldPath = `${path}.${firmness}`;
    if (!(firmness in object)) {
      rejections.push({ path: fieldPath, reason: "missing-required", detail: `${firmness} は必須` });
      continue;
    }
    const sec = object[firmness];
    if (typeof sec !== "number" || !Number.isFinite(sec)) {
      rejections.push({ path: fieldPath, reason: "type-mismatch", detail: "有限の数値である必要がある" });
    } else if (!Number.isInteger(sec)) {
      rejections.push({ path: fieldPath, reason: "type-mismatch", detail: "整数である必要がある" });
    } else if (sec <= 0) {
      rejections.push({ path: fieldPath, reason: "out-of-range", detail: `正の秒数（受領: ${sec}）` });
    }
  }

  return rejections;
}

// ── Roster の検証（Chain / Store 双方の名簿値）──

/** Roster = 非空 identity 文字列の配列。要素の順序・重複には意味を持たせない（検証は型のみ）。 */
function validateRoster(raw: unknown, path: string): Rejection[] {
  if (!Array.isArray(raw)) {
    return [{ path, reason: "type-mismatch", detail: "配列である必要がある" }];
  }
  const rejections: Rejection[] = [];
  raw.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (typeof item !== "string") {
      rejections.push({ path: itemPath, reason: "type-mismatch", detail: "文字列である必要がある" });
    } else if (item.length === 0) {
      rejections.push({ path: itemPath, reason: "out-of-range", detail: "空文字列は不可" });
    }
  });
  return rejections;
}

// ── 共通ヘルパ ──

/** 許可集合に無いキーを未知フィールドとして拒否列にする。 */
function unknownFieldRejections(
  object: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): Rejection[] {
  const rejections: Rejection[] = [];
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      rejections.push({ path: `${path}.${key}`, reason: "unknown-field", detail: "許可されないフィールド" });
    }
  }
  return rejections;
}

/** プレーンオブジェクト（配列・null を除く）へ絞り込む。該当しなければ null。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
