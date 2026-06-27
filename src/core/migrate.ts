// core/migrate.ts — 永続層から読み出した raw データの version 検査とスキーマ移行（純粋）。
// cloudflare:workers にも storage にも触れない純粋モジュール。
//
// ここは「型のない永続層」と「型のある core」の境界。storage.get が返す unknown を、
// version を検査したうえで現行スキーマの ActiveTimersSnapshot へ写す。失敗は例外ではなく
// 戻り値（ShellFailure）で表し、いずれの失敗時も入力 raw を一切変更しない（移行を確定しない）。

import { CURRENT_SCHEMA_VERSION } from "./types";
import type { EpochMillis, SlotId, NoodleType, TimerId } from "./types";
import { EMPTY_STATE } from "./state";
import { createTimer } from "./timer";
import type { Timer } from "./timer";
import type { ShellFailure } from "./rejection";
import type { ActiveTimersSnapshot } from "./snapshot";
import { toSnapshot } from "./snapshot";

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
 */
function reviveTimer(value: unknown): Timer | null {
  if (typeof value !== "object" || value === null) return null;
  const t = value as Record<string, unknown>;
  if (
    typeof t.id !== "string" ||
    typeof t.slotId !== "string" ||
    typeof t.noodleType !== "string" ||
    typeof t.endTime !== "number" ||
    typeof t.seq !== "number"
  ) {
    return null;
  }
  return createTimer({
    id: t.id as TimerId,
    slotId: t.slotId as SlotId,
    noodleType: t.noodleType as NoodleType,
    endTime: t.endTime as EpochMillis,
    seq: t.seq,
  });
}

/** 0 以上の整数か。nextSeq は登録順の採番で、負や小数はありえない。 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
