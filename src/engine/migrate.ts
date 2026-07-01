// core/migrate.ts — 永続層から読み出した raw データの version 検査とスキーマ移行（純粋）。
// cloudflare:workers にも storage にも触れない純粋モジュール。
//
// ここは「型のない永続層」と「型のある core」の境界。storage.get が返す unknown を、
// version を検査したうえで現行スキーマの ActiveTimersSnapshot へ写す。失敗は例外ではなく
// 戻り値（ShellFailure）で表し、いずれの失敗時も入力 raw を一切変更しない（移行を確定しない）。

import { CURRENT_SCHEMA_VERSION } from "../engine/types";
import type { EpochMillis, SlotId, NoodleType, TimerId } from "../engine/types";
import { EMPTY_STATE } from "./state";
import { createTimer } from "./timer";
import type { Timer } from "./timer";
import type { ShellFailure } from "./rejection";
import type { ActiveTimersSnapshot } from "./snapshot";
import { toSnapshot } from "./snapshot";
import type { NonEmptyArray } from "../domain/timer";
import { isNonEmpty } from "../domain/timer";
import { DEFAULT_FIRMNESS, isFirmness, type Firmness } from "../domain/firmness";

/**
 * migrate の結果。成功なら現行スキーマのスナップショット、失敗なら ShellFailure。
 *
 * core の `Outcome` と同じ ok 判別の形を踏襲する（成功と失敗を構造で切り分け、握り潰さない）。
 * 失敗時に snapshot を持たないことが型で保証され、移行未確定のまま先へ進めない。
 */
export type MigrationOutcome =
  | { readonly ok: true; readonly snapshot: ActiveTimersSnapshot }
  | { readonly ok: false; readonly failure: ShellFailure };

/**
 * 永続データの version を検査し、現行スキーマへ移行する。
 *
 * 判断の順序自体が要件11の写し:
 *  1. 不在（未保存）は初回起動。旧データの空集合とみなし現行の空スナップショットへ移行（要件11.4 / 7.4）。
 *  2. version が現行より大きいなら移行せずエラー。元データに触れない（要件11.5）。
 *     構造検査より前に弾くのは、「未対応版には移行を試みない」という規律のため。
 *  3. それ以外（現行・旧版・version 欠如）は timers / nextSeq を取り出して現行へ写す（要件11.2 / 11.3 / 11.4）。
 *     スナップショットとして解釈できない壊れたデータは移行失敗（要件11.6）。
 */
export function migrate(raw: unknown): MigrationOutcome {
  // 1. 未保存（storage.get が undefined）は初回起動。空集合を現行版で確定する。
  if (raw === undefined || raw === null) {
    return { ok: true, snapshot: toSnapshot(EMPTY_STATE) };
  }

  // スナップショットはオブジェクトでしか表現されない。プリミティブは解釈不能（壊れたデータ）。
  if (typeof raw !== "object") {
    return { ok: false, failure: { code: "MigrationFailed" } };
  }

  const record = raw as Record<string, unknown>;
  const version = record.version;

  if (version !== undefined) {
    // version を名乗るなら 1 以上の整数でなければならない（要件11.1）。逸脱は壊れたデータ。
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      return { ok: false, failure: { code: "MigrationFailed" } };
    }
    // 2. 現行より新しいスキーマは移行せずエラー。元データは不変（要件11.5）。
    if (version > CURRENT_SCHEMA_VERSION) {
      return { ok: false, failure: { code: "UnsupportedSchemaVersion" } };
    }
  }

  // 3. 現行・旧版・version 欠如をいずれも現行へ写す。本パイロットには v1 より前の実スキーマが
  //    存在しないため、移行の実体は「現行版として解釈し直す」こと。解釈できなければ失敗。
  const timers = reviveTimers(record.timers);
  const nextSeq = record.nextSeq;
  if (timers === null || !isNonNegativeInteger(nextSeq)) {
    return { ok: false, failure: { code: "MigrationFailed" } };
  }

  return {
    ok: true,
    snapshot: { version: CURRENT_SCHEMA_VERSION, timers, nextSeq },
  };
}

/** Timer の配列として解釈する。一件でも形を満たさなければ全体を移行失敗扱いにする（null）。 */
function reviveTimers(value: unknown): readonly Timer[] | null {
  if (!Array.isArray(value)) return null;
  const timers: Timer[] = [];
  for (const element of value) {
    const timer = reviveTimer(element);
    if (timer === null) return null;
    timers.push(timer);
  }
  return timers;
}

/**
 * 一件の raw を Timer へ写す。形（各フィールドの存在と素の型）を検査し、
 * 検証済みの素値をブランド型へ昇格して唯一の構築経路 createTimer に通す。
 * ここが永続層の素値とブランド型の境界（cast はこの一点に閉じ込める）。
 *
 * slotIds は v1（単一 `slotId` 文字列）と v2（`slotIds` 配列）の双方を受け、現行 v2 形へ写す:
 * v2 形（`slotIds` が非空文字列の非空配列）を優先し、無ければ v1 の `slotId`（文字列）を `[slotId]` に包む。
 */
function reviveTimer(value: unknown): Timer | null {
  if (typeof value !== "object" || value === null) return null;
  const t = value as Record<string, unknown>;
  if (
    typeof t.id !== "string" ||
    typeof t.noodleType !== "string" ||
    typeof t.endTime !== "number" ||
    typeof t.seq !== "number"
  ) {
    return null;
  }
  const slotIds = reviveSlotIds(t.slotIds, t.slotId);
  if (slotIds === null) return null;
  // boiledAt は v3 で追加。欠如/null（v2 以前・走行中）は null、数値はその値。それ以外は壊れたデータ。
  const boiledAt = reviveBoiledAt(t.boiledAt);
  if (boiledAt === INVALID_BOILED_AT) return null;
  // startTime は v4 で追加。欠如（v3 以前）は endTime で埋める（進捗リングは縮退・UI 側でガード）。
  const startTime = reviveStartTime(t.startTime, t.endTime);
  if (startTime === null) return null;
  // firmness は v5 で追加。欠如（v4 以前）は normal で埋める。不正な文字列は移行失敗。
  const firmness = reviveFirmness(t.firmness);
  if (firmness === null) return null;
  // adjustment は v6 で追加。欠如/null（v5 以前）は 0 で埋める（移行後の reconcile が running を再同期する）。非有限は移行失敗。
  const adjustment = reviveAdjustment(t.adjustment);
  if (adjustment === null) return null;
  return createTimer({
    id: t.id as TimerId,
    slotIds: slotIds as NonEmptyArray<SlotId>,
    noodleType: t.noodleType as NoodleType,
    firmness,
    startTime: startTime as EpochMillis,
    endTime: t.endTime as EpochMillis,
    seq: t.seq,
    boiledAt,
    adjustment,
  });
}

/**
 * 永続の firmness 表現を現行 v5 形へ写す（v5 で追加）。
 * - 欠如 / null（v4 以前は firmness を持たない）→ "normal"。
 * - 有効な Firmness → その値。
 * - それ以外（未知の文字列等）→ 壊れたデータ（null）。
 */
function reviveFirmness(value: unknown): Firmness | null {
  if (value === undefined || value === null) return DEFAULT_FIRMNESS;
  return isFirmness(value) ? value : null;
}

/**
 * 永続の adjustment 表現を現行 v6 形へ写す（v6 で追加）。
 * - 欠如 / null（v5 以前は adjustment を持たない）→ 0（未調整）。移行後の reconcile が running を正しい値へ収束させる。
 * - 有限数値 → その値（符号付きミリ秒オフセット）。
 * - それ以外（非有限数・文字列等）→ 壊れたデータ（null）。
 */
function reviveAdjustment(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

/**
 * 永続の startTime 表現を現行 v4 形へ写す（v4 で追加）。
 * - 欠如 / null（v3 以前は startTime を持たない）→ endTime で埋める（duration=0・進捗リングは UI 側でガード）。
 * - 有限数値 → その値。
 * - それ以外（非有限数・文字列等）→ 壊れたデータ（null）。
 * endTime は呼び出し前に number と検証済みのため、フォールバック値として安全に使える。
 */
function reviveStartTime(value: unknown, endTime: unknown): number | null {
  if (value === undefined || value === null) return endTime as number;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

/** reviveBoiledAt の「壊れたデータ」標識（null は正当な値ゆえ別の番兵が要る）。 */
const INVALID_BOILED_AT = Symbol("invalid-boiledAt");

/**
 * 永続の boiledAt 表現を現行 v3 形へ写す。
 * - 欠如 / null（v2 以前は走行中のみ永続。boiled 概念が無い）→ null。
 * - 有限数値 → その値（EpochMillis）。
 * - それ以外（非有限数・文字列等）→ 壊れたデータ（INVALID_BOILED_AT）。
 */
function reviveBoiledAt(value: unknown): EpochMillis | null | typeof INVALID_BOILED_AT {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value as EpochMillis;
  return INVALID_BOILED_AT;
}

/**
 * 永続スロット表現を現行 v2 形（非空文字列の非空配列）へ写す。移行をここに集約する。
 * - v2: `slotIds` が「1 件以上・全要素が非空文字列」の配列ならそのまま採る。
 * - v1: `slotIds` が無く `slotId` が非空文字列なら `[slotId]` に包む。
 * - いずれも満たさなければ移行失敗（null）。
 */
function reviveSlotIds(slotIds: unknown, legacySlotId: unknown): NonEmptyArray<string> | null {
  if (Array.isArray(slotIds)) {
    if (slotIds.some((s) => typeof s !== "string" || s.length === 0)) return null;
    const strings = slotIds as readonly string[];
    return isNonEmpty(strings) ? strings : null;
  }
  if (typeof legacySlotId === "string" && legacySlotId.length > 0) {
    return [legacySlotId];
  }
  return null;
}

/** 0 以上の整数か。nextSeq は登録順の採番で、負や小数はありえない。 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
