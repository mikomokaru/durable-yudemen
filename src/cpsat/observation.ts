import { isRecord } from "../domain/predicate";

type Origin =
  | {
      readonly kind: "engine";
      readonly instanceId: string;
      readonly decisionId: string;
      readonly effectIndex: number;
    }
  | { readonly kind: "probe" };

type Reading =
  | {
      readonly value: null;
      readonly reason: "unavailable" | "not-recorded" | "not-applicable" | "clock-not-advancing";
    }
  | {
      readonly value: number;
      readonly source:
        | "platform-invocation"
        | "host-clock"
        | "wasm"
        | "solver"
        | "model"
        | "configuration";
      readonly from:
        | "invocation-start"
        | "response-sent"
        | "request-dispatched"
        | "solve-started"
        | "checkpoint";
      readonly to:
        | "invocation-end"
        | "accepted"
        | "solve-finished"
        | "callback-returned"
        | "wait-until-end"
        | "checkpoint";
      readonly bound: "exact" | "upper" | "lower";
    };

type Fact =
  | {
      readonly type: "cpsat.request-generated";
      readonly decisionId: string;
      readonly effectIndex: number;
    }
  | {
      readonly type: "cpsat.persist-result";
      readonly decisionId: string;
      readonly outcome: "saved" | "failed";
    }
  | {
      readonly type: "cpsat.request-suppressed";
      readonly decisionId: string;
      readonly effectIndex: number;
      readonly reason: "duplicate" | "in-flight" | "limit";
    }
  | {
      readonly type: "cpsat.request-dispatched";
      readonly requestId: string;
      readonly origin: Origin;
      readonly sameInputRetry: boolean | null;
    }
  | {
      readonly type: "cpsat.dispatch-result";
      readonly requestId: string;
      readonly outcome: "accepted" | "failed" | "busy";
    }
  | { readonly type: "cpsat.solver-accepted" | "cpsat.solve-started"; readonly requestId: string }
  | {
      readonly type: "cpsat.preparation-failed";
      readonly requestId: string;
      readonly stage: "initialization" | "model" | "serialization";
    }
  | {
      readonly type: "cpsat.solve-finished";
      readonly requestId: string;
      readonly status:
        | "OPTIMAL"
        | "FEASIBLE"
        | "UNKNOWN"
        | "INFEASIBLE"
        | "MODEL_INVALID"
        | "exception";
    }
  | {
      readonly type: "cpsat.callback-returned";
      readonly requestId: string;
      readonly outcome: "delivered" | "failed";
    }
  | {
      readonly type: "cpsat.plan-decided";
      readonly requestId: string;
      readonly outcome: "adopted" | "rejected";
    }
  | {
      readonly type: "cpsat.plan-persisted";
      readonly requestId: string;
      readonly outcome: "saved" | "failed";
    }
  | { readonly type: "cpsat.plan-broadcast"; readonly requestId: string }
  | {
      readonly type: "cpsat.do-constructed";
      readonly cause: "hibernation" | "cold" | "deployment" | "unknown";
    }
  | {
      readonly type: "cpsat.measurement";
      readonly requestId: string;
      readonly metric:
        | "cpu-limit-ms"
        | "cpu-ms"
        | "invocation-wall-ms"
        | "acceptance-wall-ms"
        | "solve-callback-wall-ms"
        | "wait-until-wall-ms"
        | "wasm-bytes"
        | "isolate-bytes"
        | "budget-deterministic"
        | "consumed-deterministic"
        | "variables"
        | "constraints"
        | "model-bytes";
      readonly reading: Reading;
    }
  | {
      readonly type: "cpsat.timer";
      readonly requestId: string;
      readonly itemRef: string;
      readonly timerRef: string;
      readonly plannedServeAt: number;
      readonly effectiveEndTime: number;
      readonly boiledAt: number | null;
      readonly boiledAtState: "observed" | "not-fired" | "missing";
    };

/** 計数の事実。識別子・時刻は作用側から渡し、注文や正準入力は受け取らない。 */
export interface CpsatObservation {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly at: number;
  readonly storeRef: string;
  readonly backend: "ts" | "cpsat";
  readonly mode: "live" | "probe" | "fake";
  readonly instanceId: string;
  readonly invocationId: string;
  /** 直接の先行事実。時計の大小ではなく、この参照を照合する。 */
  readonly parentEventId: string | null;
  readonly versions: {
    readonly code: string;
    readonly model: string | null;
    readonly codec: string | null;
    readonly wasm: string | null;
    readonly glue: string | null;
    readonly profile: string | null;
    readonly budget: string | null;
    readonly missingReason: "fake" | "not-applicable" | "not-recorded" | null;
  };
  readonly fact: Fact;
}

const token = (v: unknown): v is string =>
  typeof v === "string" && /^[a-zA-Z0-9_.-]{1,128}$/.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const uint = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const oneOf = (v: unknown, choices: readonly string[]): boolean =>
  typeof v === "string" && choices.includes(v);

// own data fields だけを認める。未知項目や toJSON/getter を通じた生入力の出力を防ぐ。
function fields(v: unknown, names: readonly string[]): v is Record<string, unknown> {
  if (!isRecord(v) || Array.isArray(v)) return false;
  const prototype: unknown = Object.getPrototypeOf(v);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(v);
  return (
    keys.length === names.length &&
    names.every((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(v, name);
      return descriptor !== undefined && "value" in descriptor && descriptor.enumerable === true;
    })
  );
}

function isOrigin(v: unknown): v is Origin {
  return (
    (fields(v, ["kind"]) && v.kind === "probe") ||
    (fields(v, ["kind", "instanceId", "decisionId", "effectIndex"]) &&
      v.kind === "engine" &&
      token(v.instanceId) &&
      token(v.decisionId) &&
      uint(v.effectIndex))
  );
}

function isReading(v: unknown): v is Reading {
  if (fields(v, ["value", "reason"])) {
    return (
      v.value === null &&
      oneOf(v.reason, ["unavailable", "not-recorded", "not-applicable", "clock-not-advancing"])
    );
  }
  return (
    fields(v, ["value", "source", "from", "to", "bound"]) &&
    typeof v.value === "number" &&
    Number.isFinite(v.value) &&
    v.value >= 0 &&
    oneOf(v.source, [
      "platform-invocation",
      "host-clock",
      "wasm",
      "solver",
      "model",
      "configuration",
    ]) &&
    oneOf(v.from, [
      "invocation-start",
      "response-sent",
      "request-dispatched",
      "solve-started",
      "checkpoint",
    ]) &&
    oneOf(v.to, [
      "invocation-end",
      "accepted",
      "solve-finished",
      "callback-returned",
      "wait-until-end",
      "checkpoint",
    ]) &&
    oneOf(v.bound, ["exact", "upper", "lower"])
  );
}

function isMeasurement(v: Record<string, unknown>): boolean {
  if (
    !fields(v, ["type", "requestId", "metric", "reading"]) ||
    !token(v.requestId) ||
    !isReading(v.reading)
  )
    return false;
  const r = v.reading;
  if (
    !oneOf(v.metric, [
      "cpu-limit-ms",
      "cpu-ms",
      "invocation-wall-ms",
      "acceptance-wall-ms",
      "solve-callback-wall-ms",
      "wait-until-wall-ms",
      "wasm-bytes",
      "isolate-bytes",
      "budget-deterministic",
      "consumed-deterministic",
      "variables",
      "constraints",
      "model-bytes",
    ])
  )
    return false;
  if (r.value === null) return true;
  switch (v.metric) {
    case "cpu-ms":
    case "invocation-wall-ms":
      return (
        r.source === "platform-invocation" &&
        r.from === "invocation-start" &&
        r.to === "invocation-end" &&
        r.bound === "exact"
      );
    case "wait-until-wall-ms":
      return (
        r.to === "wait-until-end" &&
        ((r.source === "host-clock" && r.from === "response-sent" && r.bound === "exact") ||
          (r.source === "platform-invocation" &&
            r.from === "invocation-start" &&
            r.bound === "upper"))
      );
    case "acceptance-wall-ms":
      return (
        r.source === "host-clock" &&
        r.from === "request-dispatched" &&
        r.to === "accepted" &&
        r.bound === "exact"
      );
    case "solve-callback-wall-ms":
      return (
        r.source === "host-clock" &&
        r.from === "solve-started" &&
        r.to === "callback-returned" &&
        r.bound === "exact"
      );
    default: {
      const source =
        v.metric === "wasm-bytes"
          ? "wasm"
          : v.metric === "isolate-bytes"
            ? "platform-invocation"
            : v.metric === "consumed-deterministic"
              ? "solver"
              : v.metric === "cpu-limit-ms" || v.metric === "budget-deterministic"
                ? "configuration"
                : "model";
      return (
        r.source === source &&
        r.from === "checkpoint" &&
        r.to === "checkpoint" &&
        r.bound === "exact" &&
        (v.metric === "budget-deterministic" ||
          v.metric === "consumed-deterministic" ||
          uint(r.value))
      );
    }
  }
}

function isFact(v: unknown): v is Fact {
  if (!isRecord(v)) return false;
  switch (v.type) {
    case "cpsat.request-generated":
      return (
        fields(v, ["type", "decisionId", "effectIndex"]) &&
        token(v.decisionId) &&
        uint(v.effectIndex)
      );
    case "cpsat.persist-result":
      return (
        fields(v, ["type", "decisionId", "outcome"]) &&
        token(v.decisionId) &&
        oneOf(v.outcome, ["saved", "failed"])
      );
    case "cpsat.request-suppressed":
      return (
        fields(v, ["type", "decisionId", "effectIndex", "reason"]) &&
        token(v.decisionId) &&
        uint(v.effectIndex) &&
        oneOf(v.reason, ["duplicate", "in-flight", "limit"])
      );
    case "cpsat.request-dispatched":
      return (
        fields(v, ["type", "requestId", "origin", "sameInputRetry"]) &&
        token(v.requestId) &&
        isOrigin(v.origin) &&
        (v.sameInputRetry === null || typeof v.sameInputRetry === "boolean")
      );
    case "cpsat.dispatch-result":
      return (
        fields(v, ["type", "requestId", "outcome"]) &&
        token(v.requestId) &&
        oneOf(v.outcome, ["accepted", "failed", "busy"])
      );
    case "cpsat.solver-accepted":
    case "cpsat.solve-started":
    case "cpsat.plan-broadcast":
      return fields(v, ["type", "requestId"]) && token(v.requestId);
    case "cpsat.preparation-failed":
      return (
        fields(v, ["type", "requestId", "stage"]) &&
        token(v.requestId) &&
        oneOf(v.stage, ["initialization", "model", "serialization"])
      );
    case "cpsat.solve-finished":
      return (
        fields(v, ["type", "requestId", "status"]) &&
        token(v.requestId) &&
        oneOf(v.status, [
          "OPTIMAL",
          "FEASIBLE",
          "UNKNOWN",
          "INFEASIBLE",
          "MODEL_INVALID",
          "exception",
        ])
      );
    case "cpsat.callback-returned":
      return (
        fields(v, ["type", "requestId", "outcome"]) &&
        token(v.requestId) &&
        oneOf(v.outcome, ["delivered", "failed"])
      );
    case "cpsat.plan-decided":
      return (
        fields(v, ["type", "requestId", "outcome"]) &&
        token(v.requestId) &&
        oneOf(v.outcome, ["adopted", "rejected"])
      );
    case "cpsat.plan-persisted":
      return (
        fields(v, ["type", "requestId", "outcome"]) &&
        token(v.requestId) &&
        oneOf(v.outcome, ["saved", "failed"])
      );
    case "cpsat.do-constructed":
      return (
        fields(v, ["type", "cause"]) &&
        oneOf(v.cause, ["hibernation", "cold", "deployment", "unknown"])
      );
    case "cpsat.measurement":
      return isMeasurement(v);
    case "cpsat.timer":
      return (
        fields(v, [
          "type",
          "requestId",
          "itemRef",
          "timerRef",
          "plannedServeAt",
          "effectiveEndTime",
          "boiledAt",
          "boiledAtState",
        ]) &&
        token(v.requestId) &&
        hash(v.itemRef) &&
        hash(v.timerRef) &&
        uint(v.plannedServeAt) &&
        uint(v.effectiveEndTime) &&
        ((v.boiledAtState === "observed" && uint(v.boiledAt)) ||
          (oneOf(v.boiledAtState, ["not-fired", "missing"]) && v.boiledAt === null))
      );
    default:
      return false;
  }
}

function isObservation(v: unknown): v is CpsatObservation {
  if (
    !fields(v, [
      "schemaVersion",
      "eventId",
      "at",
      "storeRef",
      "backend",
      "mode",
      "instanceId",
      "invocationId",
      "parentEventId",
      "versions",
      "fact",
    ])
  )
    return false;
  if (
    v.schemaVersion !== 1 ||
    !token(v.eventId) ||
    !uint(v.at) ||
    !hash(v.storeRef) ||
    !oneOf(v.backend, ["ts", "cpsat"]) ||
    !oneOf(v.mode, ["live", "probe", "fake"]) ||
    !token(v.instanceId) ||
    !token(v.invocationId) ||
    !(v.parentEventId === null || token(v.parentEventId)) ||
    v.parentEventId === v.eventId ||
    !isFact(v.fact)
  )
    return false;
  const versions = v.versions;
  if (
    !fields(versions, [
      "code",
      "model",
      "codec",
      "wasm",
      "glue",
      "profile",
      "budget",
      "missingReason",
    ]) ||
    !token(versions.code)
  )
    return false;
  const nullable = [
    versions.model,
    versions.codec,
    versions.wasm,
    versions.glue,
    versions.profile,
    versions.budget,
  ];
  if (
    !nullable.every((x) => x === null || token(x)) ||
    !(nullable.includes(null)
      ? oneOf(versions.missingReason, ["fake", "not-applicable", "not-recorded"])
      : versions.missingReason === null)
  )
    return false;
  if (![versions.wasm, versions.glue, versions.profile].every((x) => x === null || hash(x)))
    return false;
  if (versions.missingReason === "fake" && v.mode !== "fake") return false;
  if (v.fact.type === "cpsat.request-generated" && v.mode === "probe") return false;
  // Both transport ends parse this row. A mode is not an independent label:
  // direct probes have no engine parent; live sends must have one. The fake
  // mode remains a codec/aggregation fixture mode (including broken traces),
  // never permission to send through either real transport entry.
  if (v.fact.type === "cpsat.request-dispatched" && v.mode !== "fake") {
    if (v.mode === "probe") {
      if (v.fact.origin.kind !== "probe" || v.parentEventId !== null) return false;
    } else if (v.fact.origin.kind !== "engine" || v.parentEventId === null) {
      return false;
    }
  }
  return true;
}

/** schema を固定し、検査済みの切り離した値だけを返す。失敗時に生入力を返さない。 */
export function buildCpsatObservation(
  input: Omit<CpsatObservation, "schemaVersion">,
): CpsatObservation | null {
  try {
    return parseCpsatObservation({ ...input, schemaVersion: 1 });
  } catch {
    return null;
  }
}

export function parseCpsatObservation(input: unknown): CpsatObservation | null {
  try {
    if (typeof input === "string" && input.length > 16_384) return null;
    const value: unknown = typeof input === "string" ? JSON.parse(input) : input;
    if (!isObservation(value)) return null;
    // キャプチャ後の呼出側による書き換えを集計へ持ち込まない。
    const copy: unknown = JSON.parse(JSON.stringify(value));
    return isObservation(copy) ? copy : null;
  } catch {
    return null;
  }
}

export function serializeCpsatObservation(input: CpsatObservation): string | null {
  const row = parseCpsatObservation(input);
  if (row === null) return null;
  // JSON のキー順は同一性ではない。重複照合でもこの表現を使う。
  return JSON.stringify(row, (_key, value: unknown) => {
    if (!isRecord(value) || Array.isArray(value)) return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, value[key]]),
    );
  });
}
