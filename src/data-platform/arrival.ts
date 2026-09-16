// 共通の履歴基盤へ渡す「到達一件」の物理契約。Stream schema・runtime validator・観測行から行への
// 写像を、ここ一箇所だけで定義する（operation-history-log 要件 4.2 / 4.4 / 4.9）。
//
// なぜ一箇所か——Pipelines の stream schema は作成後に変更できない。列の集合が二箇所に書かれれば、
// 送る側と受け取る側が静かにずれ、ずれた行は取込後に落ちる（送信 API は ingested しか確認しない）。
// 列定義・検証・写像が同じ定数から出ていれば、ずれは型検査とテストで止まる。
//
// 列名は canonical payload の属性名と同じ camelCase にする。snake_case は SQL の引用符なし識別子に
// 向くが、`store_id` は POS ベンダーの payload キーであり、型メンバとして宣言しない規律がある
// （pos-order-ingress 要件 14.6・tests/pos-order-ingress.static.test.ts）。綴りが同じで意味の違う
// 識別子を持つより、この repo の語彙を一つに保つ方を採る。
//
// 代償として、reader 側で識別子の引用が要る可能性がある（Snowflake は引用符なしの識別子を
// 大文字へ畳む）。実 table に対する挙動の確認はタスク 3.3 で、query を組む一箇所へ閉じる。

import { isValidStoreId } from "../registry/slug";
import type { OperationRecord } from "../operation-history/record";

/** 収集する記録の種別。物理世代とは別で、世代内で増やさない。 */
export const HISTORY_DATASETS = ["operation", "lift-delay", "order-arrival"] as const;
export type Dataset = (typeof HISTORY_DATASETS)[number];

/**
 * 物理世代。列の集合・型・必須性が変わるときだけ上げ、新しい Stream・sink・table を別名で作る
 * （要件 4.9）。既存 table へ sink を後から繋ぐことはできないため、この数を上げる変更は必ず
 * 新資源の作成を伴う。payload の属性追加は payloadVersion 側で表す。
 */
export const PHYSICAL_VERSION = 1;

/** operation の canonical payload 形式版。既存 OperationRecord 契約が版 1。 */
export const OPERATION_PAYLOAD_VERSION = 1;

/** 観測経路。Tail 以外（旧履歴の移行等）が増えても物理 schema は変えない。 */
export const ARRIVAL_SOURCES = ["tail"] as const;
export type ArrivalSource = (typeof ARRIVAL_SOURCES)[number];

/** 収集保証。console 由来も遅延記録も best-effort である（要件 4.3）。 */
export const ARRIVAL_GUARANTEES = ["best-effort"] as const;
export type ArrivalGuarantee = (typeof ARRIVAL_GUARANTEES)[number];

/**
 * Tail event の切詰め状態。**不明を false で埋めない**（要件 4.7）ため、真偽値ではなく三値で持つ。
 * `not-detected` は「切詰めなしと確認できた」、`unknown` は「確認する手段がなかった」。
 */
export const TRUNCATIONS = ["detected", "not-detected", "unknown"] as const;
export type Truncation = (typeof TRUNCATIONS)[number];

/**
 * 1 行あたりの上限。Pipelines の 1 送信あたり 5 MB に対して batch 件数を決める根拠になる値であり、
 * 「ここを超える行は送らない」という送信前の判断（要件 4.4）にも使う。代表的な operation 行は
 * 300 byte 未満で、遅延行は開始文脈を含めても 1 KB 程度を見込む。実測で確定するのはタスク 1.3。
 */
export const CANONICAL_PAYLOAD_BYTE_LIMIT = 16_384;
export const SOURCE_METADATA_BYTE_LIMIT = 4_096;
export const ARRIVAL_BYTE_LIMIT = 32_768;

/** 識別子の byte 上限。UUID（36）とその将来形に余裕を持たせた固定値。 */
const IDENTIFIER_BYTE_LIMIT = 128;

/**
 * Iceberg の 1 行。**null は「値が無い」ことを表す列の値**であって省略ではない——省略可能属性に
 * すると「書かなかった」と「無いと分かっている」が同じ形になり、移行データの不明理由を失う。
 *
 * interface ではなく型別名なのは、Pipelines の binding が `Record<string, unknown>` を要求し、
 * interface には暗黙の index signature が付かないため。送る形と binding の型を一致させておく。
 */
export type HistoryArrival = {
  readonly dataset: Dataset;
  readonly physicalVersion: number;
  readonly payloadVersion: number;
  /** 観測した行ごとに Tail が採番する。再観測は別 arrival になる（要件 4.7）。 */
  readonly arrivalId: string;
  /** 遅延記録の安定イベント ID。operation は持たない。 */
  readonly eventId: string | null;
  readonly storeId: string;
  readonly source: ArrivalSource;
  readonly guarantee: ArrivalGuarantee;
  /** 元の操作時刻（epoch ms）。decide へ渡した now であり、観測時刻とは別（要件 4.8）。 */
  readonly eventTime: number;
  /** Tail が観測した時刻（epoch ms）。取得時刻が分からない移行行は null。 */
  readonly observedAt: number | null;
  /** 原文そのまま。分析用の収束前の事実を保つ（要件 4.8）。 */
  readonly canonicalPayload: string;
  /** 版付き JSON 文字列。切詰め・来歴・不明理由を持つ。 */
  readonly sourceMetadata: string;
  /** 合成プローブ行の識別。通常 query は除外する（要件 7.3）。 */
  readonly isSynthetic: boolean;
  readonly probeId: string | null;
};

type FieldType = "string" | "int32" | "int64" | "bool";

interface FieldSpec {
  readonly name: keyof HistoryArrival;
  readonly type: FieldType;
  readonly required: boolean;
}

/**
 * 物理列の定義。この配列が stream schema と runtime validator の唯一の出所である。
 *
 * 時刻を `timestamp` ではなく `int64` で持つのは、`timestamp` が数値を秒・ミリ秒・マイクロ秒の
 * どれとして解釈するかを設定に委ねる型であり、原時刻の単位を保存側の解釈に預けることになるため。
 * epoch ms の整数をそのまま残し、解釈は読む側の一箇所に置く。
 */
export const ARRIVAL_FIELDS = [
  { name: "dataset", type: "string", required: true },
  { name: "physicalVersion", type: "int32", required: true },
  { name: "payloadVersion", type: "int32", required: true },
  { name: "arrivalId", type: "string", required: true },
  { name: "eventId", type: "string", required: false },
  { name: "storeId", type: "string", required: true },
  { name: "source", type: "string", required: true },
  { name: "guarantee", type: "string", required: true },
  { name: "eventTime", type: "int64", required: true },
  { name: "observedAt", type: "int64", required: false },
  { name: "canonicalPayload", type: "string", required: true },
  { name: "sourceMetadata", type: "string", required: true },
  { name: "isSynthetic", type: "bool", required: true },
  { name: "probeId", type: "string", required: false },
] as const satisfies readonly FieldSpec[];

/**
 * `wrangler pipelines streams create --schema-file` が読む形。配備する schema ファイルと、
 * 送信前に通す validator が同じ定義から出ていることを、この関数の存在で示す。
 */
export function arrivalStreamSchema(): {
  fields: { name: string; type: FieldType; required: boolean }[];
} {
  return {
    fields: ARRIVAL_FIELDS.map((field) => ({
      name: field.name,
      type: field.type,
      required: field.required,
    })),
  };
}

/** 送信前に落とす理由。列を特定できるものは列名を伴う（要件 4.4 の診断）。 */
export type ArrivalRejection =
  | {
      readonly reason: "unknown-column" | "missing-column" | "column-type" | "column-value";
      readonly column: string;
    }
  | { readonly reason: "row-bytes"; readonly bytes: number };

export type ArrivalCheck =
  | { readonly ok: true; readonly arrival: HistoryArrival }
  | { readonly ok: false; readonly rejection: ArrivalRejection };

const FIELD_BY_NAME = new Map<string, FieldSpec>(
  ARRIVAL_FIELDS.map((field) => [field.name, field]),
);

const INT32_MAX = 2_147_483_647;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function typeMatches(type: FieldType, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "bool":
      return typeof value === "boolean";
    case "int32":
    case "int64":
      return typeof value === "number" && Number.isSafeInteger(value);
  }
}

function isBoundedIdentifier(value: string): boolean {
  return value.length > 0 && utf8Bytes(value) <= IDENTIFIER_BYTE_LIMIT;
}

/** 版付き JSON であることまで確かめる。文字列の中身を検査せずに送ると、読む側で初めて壊れる。 */
function isVersionedJsonObject(value: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const version = (parsed as Record<string, unknown>).v;
  return typeof version === "number" && Number.isSafeInteger(version) && version >= 1;
}

function rejectValue(column: keyof HistoryArrival): ArrivalCheck {
  return { ok: false, rejection: { reason: "column-value", column } };
}

/**
 * 値域の検査。型が合っていても意味が通らない行は送らない——stream の schema は型しか見ず、
 * 意味の違反は取込後に落ちるか、そのまま保存されて分析側で初めて現れる。
 */
function checkValues(row: HistoryArrival): ArrivalCheck {
  if (!(HISTORY_DATASETS as readonly string[]).includes(row.dataset)) return rejectValue("dataset");
  if (row.physicalVersion !== PHYSICAL_VERSION) return rejectValue("physicalVersion");
  if (row.payloadVersion < 1 || row.payloadVersion > INT32_MAX) {
    return rejectValue("payloadVersion");
  }
  if (!isBoundedIdentifier(row.arrivalId)) return rejectValue("arrivalId");

  // operation は Timer 事実の組で相関し、安定イベント ID を持たない（要件 5.1 / 5.2）。
  // **他の dataset は持つ。** ここを「lift-delay だけが持つ」と書いていたため、注文到着の行が
  // 全て弾かれた（2026-09-16 に本番で踏んだ）。dataset を足すたびに直す形ではなく、持たない側を
  // 挙げる形にする——足した dataset は既定で「持つ」に入る。
  const expectsEventId = row.dataset !== "operation";
  if (expectsEventId !== (row.eventId !== null)) return rejectValue("eventId");
  if (row.eventId !== null && !isBoundedIdentifier(row.eventId)) return rejectValue("eventId");

  if (!isValidStoreId(row.storeId)) return rejectValue("storeId");
  if (!(ARRIVAL_SOURCES as readonly string[]).includes(row.source)) return rejectValue("source");
  if (!(ARRIVAL_GUARANTEES as readonly string[]).includes(row.guarantee)) {
    return rejectValue("guarantee");
  }
  if (row.eventTime <= 0) return rejectValue("eventTime");
  if (row.observedAt !== null && row.observedAt <= 0) return rejectValue("observedAt");

  // canonical 行は一行である。埋め込み改行を許すと、保存された原文から行の境界が失われる。
  if (row.canonicalPayload.length === 0 || row.canonicalPayload.includes("\n")) {
    return rejectValue("canonicalPayload");
  }
  if (utf8Bytes(row.canonicalPayload) > CANONICAL_PAYLOAD_BYTE_LIMIT) {
    return rejectValue("canonicalPayload");
  }
  if (
    utf8Bytes(row.sourceMetadata) > SOURCE_METADATA_BYTE_LIMIT ||
    !isVersionedJsonObject(row.sourceMetadata)
  ) {
    return rejectValue("sourceMetadata");
  }

  // 合成行と業務行の区別は、この一つの不変条件で保たれる（要件 7.3）。
  if (row.isSynthetic !== (row.probeId !== null)) return rejectValue("probeId");
  if (row.probeId !== null && !isBoundedIdentifier(row.probeId)) return rejectValue("probeId");

  return { ok: true, arrival: row };
}

/**
 * 配備する物理 schema と同じ定義で、送信直前の一件を検査する（要件 4.4）。
 *
 * 入力を `unknown` で受けるのは、ここが型の外側との境界だから——型が通っていることを根拠に
 * 検査を省けば、生成型と実資源がずれた瞬間に検知手段がなくなる。
 */
export function validateArrival(candidate: unknown): ArrivalCheck {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return { ok: false, rejection: { reason: "column-type", column: "" } };
  }
  const row = candidate as Record<string, unknown>;

  for (const key of Object.keys(row)) {
    if (!FIELD_BY_NAME.has(key)) {
      return { ok: false, rejection: { reason: "unknown-column", column: key } };
    }
  }

  for (const field of ARRIVAL_FIELDS) {
    const value = row[field.name];
    if (value === undefined) {
      return { ok: false, rejection: { reason: "missing-column", column: field.name } };
    }
    if (value === null) {
      if (field.required) {
        return { ok: false, rejection: { reason: "missing-column", column: field.name } };
      }
      continue;
    }
    if (!typeMatches(field.type, value)) {
      return { ok: false, rejection: { reason: "column-type", column: field.name } };
    }
  }

  const bytes = utf8Bytes(JSON.stringify(row));
  if (bytes > ARRIVAL_BYTE_LIMIT) {
    return { ok: false, rejection: { reason: "row-bytes", bytes } };
  }

  return checkValues(candidate as HistoryArrival);
}

/** Tail が一行を観測したときに分かる、canonical payload に属さない事実。 */
export interface TailObservation {
  readonly arrivalId: string;
  readonly observedAt: number;
  readonly producerScript: string;
  readonly truncation: Truncation;
  /** 合成プローブの識別子。業務行では null。 */
  readonly probeId: string | null;
}

function sourceMetadata(observation: TailObservation): string {
  return JSON.stringify({
    v: 1,
    producerScript: observation.producerScript,
    truncation: observation.truncation,
    // 何を根拠にその三値になったかを残す。値だけでは「確認していない」と「確認して無かった」が
    // 後から区別できない。
    truncationBasis: observation.truncation === "unknown" ? "unavailable" : "trace-item",
  });
}

/**
 * 観測した遅延ログ一行を物理行へ写す。
 *
 * operation との違いは 2 つだけである。dataset が `lift-delay` になることと、**安定イベント ID を
 * 列に持つ**こと。遅延は時刻ではなく ID で複製を収束させる（要件 5.2）ので、読み側が列だけで
 * 突き合わせられるようにする。
 */
export function liftDelayArrival(
  facts: {
    readonly eventId: string;
    readonly storeId: string;
    readonly eventTime: number;
    readonly payloadVersion: number;
  },
  canonicalPayload: string,
  observation: TailObservation,
): HistoryArrival {
  return {
    dataset: "lift-delay",
    physicalVersion: PHYSICAL_VERSION,
    payloadVersion: facts.payloadVersion,
    arrivalId: observation.arrivalId,
    eventId: facts.eventId,
    storeId: facts.storeId,
    source: "tail",
    guarantee: "best-effort",
    eventTime: facts.eventTime,
    observedAt: observation.observedAt,
    canonicalPayload,
    sourceMetadata: sourceMetadata(observation),
    isSynthetic: observation.probeId !== null,
    probeId: observation.probeId,
  };
}

/**
 * 観測した注文到着 1 行を物理行へ写す。
 *
 * `eventTime` には**上流が付与した到着時刻**を入れる。我々の受信時刻ではない——列の意味を
 * 「POS が届けた時刻」に揃えることで、注文到着を起点にした範囲限定がこちら側の遅れを含まない。
 */
export function orderArrivalArrival(
  facts: {
    readonly eventId: string;
    readonly storeId: string;
    readonly eventTime: number;
    readonly payloadVersion: number;
  },
  canonicalPayload: string,
  observation: TailObservation,
): HistoryArrival {
  return {
    dataset: "order-arrival",
    physicalVersion: PHYSICAL_VERSION,
    payloadVersion: facts.payloadVersion,
    arrivalId: observation.arrivalId,
    eventId: facts.eventId,
    storeId: facts.storeId,
    source: "tail",
    guarantee: "best-effort",
    eventTime: facts.eventTime,
    observedAt: observation.observedAt,
    canonicalPayload,
    sourceMetadata: sourceMetadata(observation),
    isSynthetic: observation.probeId !== null,
    probeId: observation.probeId,
  };
}

/**
 * 観測した operation 一行を物理行へ写す。canonical 行はそのまま運び、既知属性からは
 * 相関と範囲限定に要る storeId と eventTime だけを列へ出す（要件 4.2）。
 */
export function operationArrival(
  record: OperationRecord,
  canonicalPayload: string,
  observation: TailObservation,
): HistoryArrival {
  return {
    dataset: "operation",
    physicalVersion: PHYSICAL_VERSION,
    payloadVersion: OPERATION_PAYLOAD_VERSION,
    arrivalId: observation.arrivalId,
    eventId: null,
    storeId: record.storeId,
    source: "tail",
    guarantee: "best-effort",
    eventTime: record.eventTime,
    observedAt: observation.observedAt,
    canonicalPayload: canonicalPayload,
    sourceMetadata: sourceMetadata(observation),
    isSynthetic: observation.probeId !== null,
    probeId: observation.probeId,
  };
}
