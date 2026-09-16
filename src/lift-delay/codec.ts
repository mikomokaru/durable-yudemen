// 遅延記録の canonical 一行と、その解析（lift-delay-log 要件 5.1・5.4）。
//
// 操作履歴の codec と同じ規律を踏む。属性の順序を固定し、余分な空白を持たず、1 行に収める。
// 同じ事実が常に同じ byte 列になるので、原文をそのまま保存したまま複製を見分けられる。
//
// 入れ子（`startContext` / `completionAction`）も順序を固定する。順序が揺れれば、同じ事実が別の byte
// 列になり、複製の判定が壊れる。

import { isFirmness } from "../domain/firmness";
import type { NonEmptyArray } from "../domain/timer";
import {
  isSupportedLiftDelayPayloadVersion,
  LIFT_DELAY_RECORD_TYPE,
  LIFT_DELAY_START_RECORD_TYPE,
  type LiftDelayRecord,
  type LiftDelayStartContext,
  type LiftDelayStartRecord,
  type ShownPlacement,
  type TerminalOutcome,
} from "./record";

export type LiftDelayLineFailure =
  | "invalid-json"
  | "other-record-type"
  | "unsupported-payload-version"
  | "missing-required-attribute"
  | "attribute-type"
  | "attribute-value"
  // オブジェクトで届いた記録が Tail 側の検査に通らなかった。どの場が駄目だったかは
  // 失敗に添える `issues` に入る（`src/data-platform/record-schema.ts`）。
  | "schema-invalid";

export type LiftDelayLineResult =
  | { readonly ok: true; readonly record: LiftDelayRecord }
  | { readonly ok: false; readonly failure: LiftDelayLineFailure };

const OUTCOMES: readonly TerminalOutcome[] = ["completed", "cancelled"];
const START_SOURCES = ["order-item", "ad-hoc"] as const;
const UNKNOWN_REASONS = ["before-introduction", "missing", "capacity", "undecodable"] as const;

/**
 * console へ渡す payload。**その場で作り直した素のオブジェクトである。**
 *
 * Producer が record をそのまま `console.log` へ渡すと、渡るのは参照である。tail event が組まれる
 * までの間に呼び出し側が中身を書き換えれば、届くのは別物になる。属性を書き写し、配列を複製することで
 * その窓を閉じる。副産物として、既知属性だけ・固定順序という canonical の性質もここで決まる。
 */
export function liftDelayPayload(record: LiftDelayRecord): Record<string, unknown> {
  return {
    recordType: record.recordType,
    payloadVersion: record.payloadVersion,
    eventId: record.eventId,
    storeId: record.storeId,
    timerId: record.timerId,
    outcome: record.outcome,
    startedAt: record.startedAt,
    dueAt: record.dueAt,
    terminalAt: record.terminalAt,
    noodleType: record.noodleType,
    firmness: record.firmness,
    slotIds: [...record.slotIds],
  };
}

/** 固定順序の canonical 一行。 */
export function printCanonicalLiftDelayLine(record: LiftDelayRecord): string {
  return JSON.stringify(liftDelayPayload(record));
}

/** 開始 record の console payload。終端と同じ規律で作り直す。 */
export function liftDelayStartPayload(record: LiftDelayStartRecord): Record<string, unknown> {
  const placement =
    record.shownPlacement.kind === "found"
      ? {
          kind: "found",
          startAt: record.shownPlacement.startAt,
          serveAt: record.shownPlacement.serveAt,
          mates: record.shownPlacement.mates,
        }
      : { kind: "absent" };
  return {
    recordType: record.recordType,
    payloadVersion: record.payloadVersion,
    eventId: record.eventId,
    storeId: record.storeId,
    timerId: record.timerId,
    startedAt: record.startedAt,
    source: record.source,
    pendingBeforeStart: record.pendingBeforeStart,
    pendingOtherItems: record.pendingOtherItems,
    activeTimerCount: record.activeTimerCount,
    occupiedSlotCount: record.occupiedSlotCount,
    shownPlacement: placement,
    appliedWait: { kind: record.appliedWait.kind },
    orderItem:
      record.orderItem === null
        ? null
        : {
            externalOrderId: record.orderItem.externalOrderId,
            itemIndex: record.orderItem.itemIndex,
          },
  };
}

/** 開始 record の canonical 一行。終端と同じ規律で順序を固定する。 */
export function printCanonicalLiftDelayStartLine(record: LiftDelayStartRecord): string {
  return JSON.stringify(liftDelayStartPayload(record));
}

export type LiftDelayStartLineResult =
  | { readonly ok: true; readonly record: LiftDelayStartRecord }
  | { readonly ok: false; readonly failure: LiftDelayLineFailure };

/** 開始 record の解析。他形式は失敗ではなく `other-record-type` を返す。 */
export function parseLiftDelayStartLine(line: string): LiftDelayStartLineResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, failure: "invalid-json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, failure: "invalid-json" };
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.recordType !== LIFT_DELAY_START_RECORD_TYPE) {
    return { ok: false, failure: "other-record-type" };
  }
  if (!isSupportedLiftDelayPayloadVersion(raw.payloadVersion)) {
    return { ok: false, failure: "unsupported-payload-version" };
  }

  // 開始 record の本体は文脈そのものである。読み手を一箇所に保つため、同じ検査を通す。
  const context = readStartContext({ ...raw, kind: "recorded" });
  if (typeof context === "string") return { ok: false, failure: context };
  if (context.kind !== "recorded") return { ok: false, failure: "attribute-value" };
  if (
    !isNonEmptyString(raw.storeId) ||
    !isNonEmptyString(raw.timerId) ||
    !isNonEmptyString(raw.eventId)
  ) {
    return { ok: false, failure: "attribute-type" };
  }

  // 品目への参照（版 2 で追加）。**無ければ null にする。** 版 1 の行を弾かないためで、
  // 「記録していなかった」と「注文由来でない」は `source` が分ける（`record.ts` の該当箇所）。
  const rawOrderItem = raw.orderItem;
  let orderItem: LiftDelayStartRecord["orderItem"] = null;
  if (rawOrderItem !== undefined && rawOrderItem !== null) {
    if (typeof rawOrderItem !== "object" || Array.isArray(rawOrderItem)) {
      return { ok: false, failure: "attribute-type" };
    }
    const ref = rawOrderItem as Record<string, unknown>;
    if (
      !isNonEmptyString(ref.externalOrderId) ||
      typeof ref.itemIndex !== "number" ||
      !Number.isInteger(ref.itemIndex) ||
      ref.itemIndex < 0
    ) {
      return { ok: false, failure: "attribute-value" };
    }
    orderItem = { externalOrderId: ref.externalOrderId, itemIndex: ref.itemIndex };
  }

  return {
    ok: true,
    record: {
      recordType: LIFT_DELAY_START_RECORD_TYPE,
      payloadVersion: raw.payloadVersion,
      eventId: raw.eventId,
      storeId: raw.storeId,
      timerId: raw.timerId,
      orderItem,
      startedAt: context.startedAt,
      source: context.source,
      pendingBeforeStart: context.pendingBeforeStart,
      pendingOtherItems: context.pendingOtherItems,
      activeTimerCount: context.activeTimerCount,
      occupiedSlotCount: context.occupiedSlotCount,
      shownPlacement: context.shownPlacement,
      appliedWait: context.appliedWait,
    },
  };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function readStartContext(value: unknown): LiftDelayStartContext | LiftDelayLineFailure {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "attribute-type";
  const raw = value as Record<string, unknown>;

  if (raw.kind === "unknown") {
    return (UNKNOWN_REASONS as readonly unknown[]).includes(raw.reason)
      ? { kind: "unknown", reason: raw.reason as (typeof UNKNOWN_REASONS)[number] }
      : "attribute-value";
  }
  if (raw.kind !== "recorded") return "attribute-value";

  if (
    !isPositiveInteger(raw.startedAt) ||
    !isCount(raw.pendingBeforeStart) ||
    !isCount(raw.pendingOtherItems) ||
    !isCount(raw.activeTimerCount) ||
    !isCount(raw.occupiedSlotCount)
  ) {
    return "attribute-type";
  }
  if (!(START_SOURCES as readonly unknown[]).includes(raw.source)) return "attribute-value";

  const placement = raw.shownPlacement;
  if (typeof placement !== "object" || placement === null) return "attribute-type";
  const rawPlacement = placement as Record<string, unknown>;
  let shownPlacement: ShownPlacement;
  if (rawPlacement.kind === "found") {
    if (
      !isPositiveInteger(rawPlacement.startAt) ||
      !isPositiveInteger(rawPlacement.serveAt) ||
      !isCount(rawPlacement.mates)
    ) {
      return "attribute-type";
    }
    shownPlacement = {
      kind: "found",
      startAt: rawPlacement.startAt,
      serveAt: rawPlacement.serveAt,
      mates: rawPlacement.mates,
    };
  } else if (rawPlacement.kind === "absent") {
    shownPlacement = { kind: "absent" };
  } else {
    return "attribute-value";
  }

  const appliedWait = raw.appliedWait as Record<string, unknown> | null;
  if (appliedWait?.kind !== "not-introduced") return "attribute-value";

  return {
    kind: "recorded",
    startedAt: raw.startedAt,
    source: raw.source as (typeof START_SOURCES)[number],
    pendingBeforeStart: raw.pendingBeforeStart,
    pendingOtherItems: raw.pendingOtherItems,
    activeTimerCount: raw.activeTimerCount,
    occupiedSlotCount: raw.occupiedSlotCount,
    shownPlacement,
    appliedWait: { kind: "not-introduced" },
  };
}

/**
 * canonical 一行を解析する。**他形式の行は失敗ではなく `other-record-type`** として返す——
 * 操作履歴の行や別のアプリログを「壊れた遅延記録」として数えないためである。
 */
export function parseLiftDelayLine(line: string): LiftDelayLineResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, failure: "invalid-json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, failure: "invalid-json" };
  }
  const raw = parsed as Record<string, unknown>;

  if (raw.recordType !== LIFT_DELAY_RECORD_TYPE) {
    return { ok: false, failure: "other-record-type" };
  }
  if (!isSupportedLiftDelayPayloadVersion(raw.payloadVersion)) {
    return { ok: false, failure: "unsupported-payload-version" };
  }

  for (const attribute of [
    "eventId",
    "storeId",
    "timerId",
    "outcome",
    "startedAt",
    "dueAt",
    "terminalAt",
    "noodleType",
    "firmness",
    "slotIds",
  ]) {
    if (raw[attribute] === undefined) return { ok: false, failure: "missing-required-attribute" };
  }

  if (
    !isNonEmptyString(raw.eventId) ||
    !isNonEmptyString(raw.storeId) ||
    !isNonEmptyString(raw.timerId) ||
    !isNonEmptyString(raw.noodleType)
  ) {
    return { ok: false, failure: "attribute-type" };
  }
  if (
    !isPositiveInteger(raw.startedAt) ||
    !isPositiveInteger(raw.dueAt) ||
    !isPositiveInteger(raw.terminalAt)
  ) {
    return { ok: false, failure: "attribute-type" };
  }
  if (!Array.isArray(raw.slotIds) || raw.slotIds.length === 0) {
    return { ok: false, failure: "attribute-type" };
  }
  if (!raw.slotIds.every(isNonEmptyString)) return { ok: false, failure: "attribute-type" };
  if (!(OUTCOMES as readonly unknown[]).includes(raw.outcome)) {
    return { ok: false, failure: "attribute-value" };
  }
  if (!isFirmness(raw.firmness)) return { ok: false, failure: "attribute-value" };

  const slotIds = raw.slotIds as string[];
  return {
    ok: true,
    record: {
      recordType: LIFT_DELAY_RECORD_TYPE,
      payloadVersion: raw.payloadVersion,
      eventId: raw.eventId,
      storeId: raw.storeId,
      timerId: raw.timerId,
      outcome: raw.outcome as TerminalOutcome,
      startedAt: raw.startedAt,
      dueAt: raw.dueAt,
      terminalAt: raw.terminalAt,
      noodleType: raw.noodleType,
      firmness: raw.firmness,
      slotIds: [slotIds[0] as string, ...slotIds.slice(1)] as NonEmptyArray<string>,
    },
  };
}
