// core/migrate.ts — 永続層から読み出した raw データの version 検査とスキーマ移行（純粋）。
// cloudflare:workers にも storage にも触れない純粋モジュール。
//
// ここは「型のない永続層」と「型のある core」の境界。storage.get が返す unknown を、
// version を検査したうえで現行スキーマの StoreSnapshot へ写す。失敗は例外ではなく
// 戻り値（ShellFailure）で表し、いずれの失敗時も入力 raw を一切変更しない（移行を確定しない）。

import { isNonNegativeInteger, toDeclaredName } from "../domain/predicate";
import { CURRENT_SCHEMA_VERSION } from "../engine/types";
import type { EpochMillis, SlotId, NoodleType, TimerId } from "../engine/types";
import { EMPTY_STATE } from "./state";
import { createTimer } from "./timer";
import type { Timer } from "./timer";
import type { ShellFailure } from "./rejection";
import type { StoreSnapshot } from "./snapshot";
import { toSnapshot } from "./snapshot";
import type { AcceptedSlice, Placement } from "./schedule";
import type { InputDigest } from "./digest";
import type { PendingOrder } from "../domain/order";
import type { NonEmptyArray } from "../domain/timer";
import { isNonEmpty } from "../domain/timer";
import { DEFAULT_FIRMNESS, isFirmness, type Firmness } from "../domain/firmness";
import { SLOT_SPAN_MAX, SLOT_SPAN_MIN } from "../domain/store";

/**
 * migrate の結果。成功なら現行スキーマのスナップショット、失敗なら ShellFailure。
 *
 * core の `Outcome` と同じ ok 判別の形を踏襲する（成功と失敗を構造で切り分け、握り潰さない）。
 * 失敗時に snapshot を持たないことが型で保証され、移行未確定のまま先へ進めない。
 */
export type MigrationOutcome =
  | { readonly ok: true; readonly snapshot: StoreSnapshot }
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
  // v7 で追加した 3 フィールド。欠如（v6 以前）は空値／null で埋める（design.md の移行表）。
  const pendingOrders = revivePendingOrders(record.pendingOrders);
  const acceptedSlices = reviveAcceptedSlices(record.acceptedSlices);
  if (pendingOrders === null || acceptedSlices === null) {
    return { ok: false, failure: { code: "MigrationFailed" } };
  }

  return {
    ok: true,
    snapshot: {
      version: CURRENT_SCHEMA_VERSION,
      timers,
      nextSeq,
      pendingOrders,
      acceptedSlices,
      // 指紋は「直前に要求した時点の値」でしかなく、失えば次の状態変化で 1 回余分に要求が出るだけ。
      // 壊れた値を移行失敗にする代償（店舗が起動しない）に見合わないため null へ畳む。
      requestedDigest: reviveRequestedDigest(record.requestedDigest),
      lastSequenceByTerminal: reviveLastSequenceByTerminal(record.lastSequenceByTerminal),
    },
  };
}

/**
 * 端末ごとの判定材料として解釈する（v8 で追加）。
 * - 欠如 / null（v7 以前は取り込み経路が存在せず、判定材料を持つ端末が無い）→ 空。
 * - 全エントリが「非空文字列のキー → 非空文字列の値」→ そのまま。
 * - それ以外 → 空へ畳む（移行失敗にしない）。
 *
 * 待ち行列や採用済み計画と規律を分けるのは、失われる事実の重さが違うからである。判定材料の喪失が生むのは
 * 重複だけで（弾けなくなった Record が再度受理され、`upsertOrder` が吸収する）、欠落は生じない。一方で
 * 移行失敗は店舗を起動不能にし、その間に届く Record は再送の果てに失われる。欠落と重複の分岐では重複を
 * 選ぶ（Duplicate_Bias）。
 *
 * 一部のエントリだけを落とさないのは、規則を 1 つに保つためである（全体が形を満たすか、空か）。
 */
function reviveLastSequenceByTerminal(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (
    entries.some(
      ([terminalId, seq]) => terminalId.length === 0 || typeof seq !== "string" || seq.length === 0,
    )
  ) {
    return {};
  }
  return Object.fromEntries(entries as readonly [string, string][]);
}

/**
 * Pending_Order 集合として解釈する（v7 で追加）。
 * - 欠如 / null（v6 以前は待ち行列を持たない）→ 空集合。POS 連携前の稼働店に未着手オーダーは存在しない。
 * - 配列 → 全要素を検証して写す。**一件でも形を満たさなければ全体を移行失敗**（null）。
 *   reviveTimers と同じ規律であり、domain の toPendingOrders が部分受理を許さないのと同じ理由——
 *   不正要素を落とせば「注文の一部だけが待ち行列に在る」嘘が生まれ、現場が欠品に気づけない。
 * - 配列でない → 壊れたデータ（null）。
 */
function revivePendingOrders(value: unknown): readonly PendingOrder[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const orders: PendingOrder[] = [];
  for (const element of value) {
    const order = revivePendingOrder(element);
    if (order === null) return null;
    orders.push(order);
  }
  return orders;
}

/**
 * 一件の raw を PendingOrder へ写す。永続値ゆえ noodleType はプリセットと突き合わせない
 * （突き合わせは受理時の関心事で、移行時に設定を要求すれば永続層が設定に依存してしまう）。形だけを見る。
 */
function revivePendingOrder(value: unknown): PendingOrder | null {
  if (typeof value !== "object" || value === null) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.externalOrderId !== "string" || o.externalOrderId.length === 0) return null;
  if (!isNonNegativeInteger(o.itemIndex)) return null;
  if (typeof o.noodleType !== "string" || o.noodleType.length === 0) return null;
  if (!isFirmness(o.firmness)) return null;
  // tableId は「無い」ことに意味がある（単独グループ）。欠如／null は null、空文字と非文字列は壊れたデータ。
  // 判定は toDeclaredName ただ一つに閉じる（取り込み・ワイヤ・移行の 3 経路で同じ形の関門を書かない）。
  const tableId = toDeclaredName(o.tableId);
  if (tableId === null) return null;
  // itemName / sizeName は v9 で追加。欠如は null（v8 以前の永続値はこの経路を通る）。空文字と非文字列は
  // 壊れたデータ——取り込みが null へ畳んでいる以上、永続に空文字が在ることは自分の不具合である。
  const itemName = toDeclaredName(o.itemName);
  if (itemName === null) return null;
  const sizeName = toDeclaredName(o.sizeName);
  if (sizeName === null) return null;
  if (typeof o.arrivalTime !== "number" || !Number.isFinite(o.arrivalTime)) return null;
  // slotSpan は v8 で追加。欠如は 1、値域外・非整数は壊れたデータ（呼び出し側が全体を移行失敗にする）。
  const slotSpan = reviveSlotSpan(o.slotSpan);
  if (slotSpan === null) return null;
  return {
    externalOrderId: o.externalOrderId,
    itemIndex: o.itemIndex,
    noodleType: o.noodleType,
    firmness: o.firmness,
    tableId: tableId.name,
    arrivalTime: o.arrivalTime,
    slotSpan,
    itemName: itemName.name,
    sizeName: sizeName.name,
  };
}

/**
 * 永続の slotSpan を現行 v8 形へ写す（v8 で追加）。
 * - 欠如 / null（v7 以前は麺量の語彙を持たない）→ SLOT_SPAN_MIN。v7 以前の待ち行列は現に 1 品目 1 スロット
 *   で計画されており、埋めた値が当時の実際の挙動に一致する。
 * - 値域内の整数 → その値。
 * - それ以外（非整数・値域外）→ 壊れたデータ（null）。
 *
 * 値域外をクランプしないのは、どこにも要求されていない占有幅を新たに作らないためである（domain の
 * toSlotSpan / toNoodleSize と同じ判断）。
 */
function reviveSlotSpan(value: unknown): number | null {
  if (value === undefined || value === null) return SLOT_SPAN_MIN;
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < SLOT_SPAN_MIN || value > SLOT_SPAN_MAX) return null;
  return value;
}

/**
 * 採用済み PlanSlice 列として解釈する（v7 で追加）。
 * 欠如は空集合（採用済み外部計画なし＝Committed_Plan は Baseline のみ）。
 * 不正要素は revivePendingOrders と同じく全体を移行失敗にする——採用は再計算で復元できない事実であり、
 * 一部を黙って落とせば「この店が採用した計画」が静かに書き換わる。
 */
function reviveAcceptedSlices(value: unknown): readonly AcceptedSlice[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const slices: AcceptedSlice[] = [];
  for (const element of value) {
    const slice = reviveAcceptedSlice(element);
    if (slice === null) return null;
    slices.push(slice);
  }
  return slices;
}

/** 一件の raw を AcceptedSlice へ写す。score は整数（目的関数値は整数で閉じる）。 */
function reviveAcceptedSlice(value: unknown): AcceptedSlice | null {
  if (typeof value !== "object" || value === null) return null;
  const s = value as Record<string, unknown>;
  if (typeof s.tableKey !== "string" || s.tableKey.length === 0) return null;
  if (typeof s.score !== "number" || !Number.isInteger(s.score)) return null;
  if (!Array.isArray(s.placements)) return null;
  const placements: Placement[] = [];
  for (const element of s.placements) {
    const placement = revivePlacement(element);
    if (placement === null) return null;
    placements.push(placement);
  }
  return { tableKey: s.tableKey, placements, score: s.score };
}

/** 一件の raw を Placement へ写す。slotIds は Timer と同じ非空配列の規律に従う。 */
function revivePlacement(value: unknown): Placement | null {
  if (typeof value !== "object" || value === null) return null;
  const p = value as Record<string, unknown>;
  if (typeof p.externalOrderId !== "string" || p.externalOrderId.length === 0) return null;
  if (!isNonNegativeInteger(p.itemIndex)) return null;
  const slotIds = reviveSlotIds(p.slotIds, undefined);
  if (slotIds === null) return null;
  if (typeof p.startAt !== "number" || !Number.isFinite(p.startAt)) return null;
  if (typeof p.serveAt !== "number" || !Number.isFinite(p.serveAt)) return null;
  return {
    externalOrderId: p.externalOrderId,
    itemIndex: p.itemIndex,
    slotIds: slotIds as NonEmptyArray<SlotId>,
    startAt: p.startAt as EpochMillis,
    serveAt: p.serveAt as EpochMillis,
  };
}

/**
 * 永続の requestedDigest を現行 v7 形へ写す（v7 で追加）。
 * 欠如 / null（v6 以前）と数値でない値はいずれも null（未要求扱い）。指紋は等値比較しかされず、
 * 失った代償は「次の状態変化で 1 回余分に要求が出る」だけで無害である。
 */
function reviveRequestedDigest(value: unknown): InputDigest | null {
  if (typeof value === "number" && Number.isFinite(value)) return value as InputDigest;
  return null;
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
  // orderItem は v7 で追加。欠如/null（v6 以前・アドホック麺茹で）と形を満たさない値は null へ畳む。
  const orderItem = reviveOrderItem(t.orderItem);
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
    orderItem,
  });
}

/**
 * 永続の orderItem 表現を現行 v7 形へ写す（v7 で追加）。
 * - 欠如 / null（v6 以前は注文紐づけを持たない）→ null（アドホック麺茹で扱い）。
 * - { externalOrderId: 非空文字列; itemIndex: 0 以上の整数 } → その参照。
 * - それ以外 → null へ畳む（移行失敗にしない）。
 *
 * 移行失敗にしないのは、この参照の用途が「開始済み品目を Pending_Order の置換から除く」ひとつであり、
 * 失っても起きるのは二重調理の防止が効かない可能性だけで、Timer 自体の計時は完全に保たれるためである。
 * 壊れた紐づけで店舗全体を起動不能にする代償の方が大きい（adjustment を移行失敗にする判断とは、
 * 失われる事実の重さが違う——あちらは実効 endTime、すなわち計時そのものを歪める）。
 */
function reviveOrderItem(
  value: unknown,
): { readonly externalOrderId: string; readonly itemIndex: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.externalOrderId !== "string" || item.externalOrderId.length === 0) return null;
  if (!isNonNegativeInteger(item.itemIndex)) return null;
  return { externalOrderId: item.externalOrderId, itemIndex: item.itemIndex };
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
