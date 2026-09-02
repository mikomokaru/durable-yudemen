import { isFirmness } from "../domain/firmness";
import type { NonEmptyArray } from "../domain/timer";
import { isValidStoreId } from "../registry/slug";
import type { OperationRecord } from "./record";

const KNOWN_ATTRIBUTES = new Set([
  "storeId",
  "timerId",
  "operationKind",
  "eventTime",
  "slotIds",
  "noodleType",
  "firmness",
  "startTime",
  "endTime",
  "boiledAt",
]);

const COMMON_ATTRIBUTES = [
  "storeId",
  "timerId",
  "operationKind",
  "eventTime",
  "slotIds",
  "noodleType",
  "firmness",
] as const;
const OPERATION_KINDS = ["boil-started", "boiled", "adjusted", "completed", "cancelled"] as const;
type OperationKind = (typeof OPERATION_KINDS)[number];
export type OperationLineFailure =
  | "invalid-json"
  | "duplicate-known-attribute"
  | "missing-required-attribute"
  | "disallowed-operation-kind-attribute"
  | "known-attribute-type"
  | "known-attribute-value";
type ParsedOperationLineResult =
  | { readonly ok: true; readonly record: OperationRecord }
  | { readonly ok: false; readonly failure: OperationLineFailure };
export type OperationLineResult =
  | { readonly ok: true; readonly record: OperationRecord }
  | { readonly ok: false; readonly lineNumber: number; readonly failure: OperationLineFailure };

function knownAttributes(record: OperationRecord) {
  const common = {
    storeId: record.storeId,
    timerId: record.timerId,
    operationKind: record.operationKind,
    eventTime: record.eventTime,
    slotIds: [...record.slotIds],
    noodleType: record.noodleType,
    firmness: record.firmness,
  };

  switch (record.operationKind) {
    case "boil-started":
      return { ...common, startTime: record.startTime, endTime: record.endTime };
    case "boiled":
      return { ...common, endTime: record.endTime, boiledAt: record.boiledAt };
    case "adjusted":
      return { ...common, endTime: record.endTime };
    case "completed":
    case "cancelled":
      return common;
  }
}

function topLevelMemberNames(line: string): readonly string[] | null {
  let cursor = 0;
  const names: string[] = [];
  const skipWhitespace = () => {
    while (/\s/.test(line[cursor] ?? "")) cursor += 1;
  };
  const stringEnd = (start: number): number | null => {
    let escaped = false;
    for (let index = start + 1; index < line.length; index += 1) {
      const character = line[index]!;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') return index + 1;
    }
    return null;
  };

  skipWhitespace();
  if (line[cursor] !== "{") return null;
  cursor += 1;
  skipWhitespace();
  if (line[cursor] === "}") return names;

  while (cursor < line.length) {
    if (line[cursor] !== '"') return null;
    const end = stringEnd(cursor);
    if (end === null) return null;
    names.push(JSON.parse(line.slice(cursor, end)) as string);
    cursor = end;
    skipWhitespace();
    if (line[cursor] !== ":") return null;
    cursor += 1;

    let depth = 0;
    while (cursor < line.length) {
      const character = line[cursor]!;
      if (character === '"') {
        const valueStringEnd = stringEnd(cursor);
        if (valueStringEnd === null) return null;
        cursor = valueStringEnd;
        continue;
      }
      if (character === "{" || character === "[") depth += 1;
      else if (character === "]") depth -= 1;
      else if (character === "}") {
        if (depth === 0) return names;
        depth -= 1;
      } else if (character === "," && depth === 0) {
        cursor += 1;
        skipWhitespace();
        break;
      }
      cursor += 1;
    }
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOperationKind(value: unknown): value is OperationKind {
  return typeof value === "string" && (OPERATION_KINDS as readonly string[]).includes(value);
}

function requiredAttributes(kind: OperationKind): readonly string[] {
  switch (kind) {
    case "boil-started":
      return [...COMMON_ATTRIBUTES, "startTime", "endTime"];
    case "boiled":
      return [...COMMON_ATTRIBUTES, "endTime", "boiledAt"];
    case "adjusted":
      return [...COMMON_ATTRIBUTES, "endTime"];
    case "completed":
    case "cancelled":
      return COMMON_ATTRIBUTES;
  }
}

function allowedAttributes(kind: OperationKind): ReadonlySet<string> {
  return new Set(requiredAttributes(kind));
}

function hasOwn(record: Record<string, unknown>, attribute: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, attribute);
}

function hasKnownAttributeTypeViolation(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  for (const attribute of allowed) {
    const value = record[attribute];
    if (attribute === "slotIds") {
      if (!Array.isArray(value) || value.some((slotId) => typeof slotId !== "string")) return true;
    } else if (
      attribute === "eventTime" ||
      attribute === "startTime" ||
      attribute === "endTime" ||
      attribute === "boiledAt"
    ) {
      if (typeof value !== "number") return true;
    } else if (typeof value !== "string") return true;
  }
  return false;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function hasKnownAttributeValueViolation(record: Record<string, unknown>): boolean {
  const slotIds = record.slotIds as readonly string[];
  return (
    !isValidStoreId(record.storeId as string) ||
    (record.timerId as string).length === 0 ||
    !isOperationKind(record.operationKind) ||
    !isPositiveInteger(record.eventTime) ||
    slotIds.length === 0 ||
    slotIds.some((slotId) => slotId.length === 0) ||
    (record.noodleType as string).length === 0 ||
    !isFirmness(record.firmness) ||
    (hasOwn(record, "startTime") && !isPositiveInteger(record.startTime)) ||
    (hasOwn(record, "endTime") && !isPositiveInteger(record.endTime)) ||
    (hasOwn(record, "boiledAt") && !isPositiveInteger(record.boiledAt))
  );
}

function operationRecord(record: Record<string, unknown>, kind: OperationKind): OperationRecord {
  const common = {
    storeId: record.storeId as string,
    timerId: record.timerId as string,
    operationKind: kind,
    eventTime: record.eventTime as OperationRecord["eventTime"],
    slotIds: record.slotIds as unknown as NonEmptyArray<string>,
    noodleType: record.noodleType as string,
    firmness: record.firmness as OperationRecord["firmness"],
  };
  switch (kind) {
    case "boil-started":
      return {
        ...common,
        operationKind: kind,
        startTime: record.startTime as OperationRecord["eventTime"],
        endTime: record.endTime as OperationRecord["eventTime"],
      };
    case "boiled":
      return {
        ...common,
        operationKind: kind,
        endTime: record.endTime as OperationRecord["eventTime"],
        boiledAt: record.boiledAt as OperationRecord["eventTime"],
      };
    case "adjusted":
      return {
        ...common,
        operationKind: kind,
        endTime: record.endTime as OperationRecord["eventTime"],
      };
    case "completed":
    case "cancelled":
      return { ...common, operationKind: kind };
  }
}

/** Operation Record 一件を、既知属性だけから成る canonical JSON 一行へ写す。 */
export function printCanonicalOperationLine(record: OperationRecord): string {
  return JSON.stringify(knownAttributes(record));
}

/** record と slotIds の順序を保ち、canonical line を LF 一個で連結する。 */
export function printCanonicalOperationLines(records: readonly OperationRecord[]): string {
  return records.map(printCanonicalOperationLine).join("\n");
}

/** JSON 一行を未知属性から隔離し、既知属性だけの Operation Record または失敗へ写す。 */
function parseOperationLine(line: string): ParsedOperationLineResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, failure: "invalid-json" };
  }
  if (!isObject(parsed)) return { ok: false, failure: "invalid-json" };

  const memberNames = topLevelMemberNames(line);
  if (memberNames === null) return { ok: false, failure: "invalid-json" };
  const seen = new Set<string>();
  for (const name of memberNames) {
    if (!KNOWN_ATTRIBUTES.has(name)) continue;
    if (seen.has(name)) return { ok: false, failure: "duplicate-known-attribute" };
    seen.add(name);
  }

  for (const attribute of COMMON_ATTRIBUTES) {
    if (!hasOwn(parsed, attribute)) return { ok: false, failure: "missing-required-attribute" };
  }
  const kind = parsed.operationKind;
  if (isOperationKind(kind)) {
    const required = requiredAttributes(kind);
    if (required.some((attribute) => !hasOwn(parsed, attribute))) {
      return { ok: false, failure: "missing-required-attribute" };
    }
    const allowed = allowedAttributes(kind);
    if (
      memberNames.some((attribute) => KNOWN_ATTRIBUTES.has(attribute) && !allowed.has(attribute))
    ) {
      return { ok: false, failure: "disallowed-operation-kind-attribute" };
    }
    if (hasKnownAttributeTypeViolation(parsed, allowed)) {
      return { ok: false, failure: "known-attribute-type" };
    }
  } else if (typeof kind !== "string") {
    return { ok: false, failure: "known-attribute-type" };
  }

  if (!isOperationKind(kind) || hasKnownAttributeValueViolation(parsed)) {
    return { ok: false, failure: "known-attribute-value" };
  }
  return { ok: true, record: operationRecord(parsed, kind) };
}

/** LF 区切りの全行を入力順に解析し、失敗には1始まりの行番号を付ける。 */
export function parseOperationLines(lines: string): readonly OperationLineResult[] {
  return lines.split("\n").map((line, index) => {
    const result = parseOperationLine(line);
    return result.ok ? result : { ...result, lineNumber: index + 1 };
  });
}
