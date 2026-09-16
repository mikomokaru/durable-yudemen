import { isRecord } from "../domain/predicate";
import {
  parseCpsatObservation,
  serializeCpsatObservation,
  type CpsatObservation,
} from "../cpsat/observation";

type Scope = Pick<CpsatObservation, "storeRef" | "backend" | "mode">;
type Counts = ReturnType<typeof emptyCounts>;

/** 全 exporter の取得範囲を突き合わせた manifest。単なる行の最小・最大時刻ではない。 */
export interface CpsatObservationCoverage {
  readonly from: number;
  readonly to: number;
  readonly capturedFrom: number;
  readonly capturedTo: number;
  readonly retainedFrom: number | null;
  readonly samplingRate: number | null;
  readonly exportComplete: boolean | null;
  readonly scopes: readonly Scope[];
  readonly gaps: readonly { readonly from: number; readonly to: number }[];
  /** 稼働中の1分窓の想定上限。試験の費用枠ではない。null は未設定。 */
  readonly frequencyLimits: {
    readonly generated: number;
    readonly dispatched: number;
    readonly solveStarted: number;
  } | null;
}

type Window = Scope & {
  readonly from: number;
  readonly to: number;
  readonly observed: Counts;
  /** 欠測・相関不正を含む窓では null。観測できた下限値とは分ける。 */
  readonly counts: Counts | null;
  readonly missingReasons: readonly string[];
  readonly frequency: "not-configured" | "not-assessed" | "within-range" | "exceeded";
};

export interface CpsatObservationSummary {
  readonly coverage: CpsatObservationCoverage | null;
  readonly invalidRows: number;
  readonly duplicateRows: number;
  readonly conflictingRows: number;
  readonly issues: readonly string[];
  /** usable は計数の可用性だけ。求解成功・輸送成立・有効化の合否ではない。 */
  readonly usableForRates: boolean;
  readonly totals: readonly Window[];
  readonly minutes: readonly Window[];
}

const uint = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
function interval(v: unknown): v is Record<string, unknown> & { from: number; to: number } {
  return isRecord(v) && uint(v.from) && uint(v.to) && v.from < v.to;
}
function isScope(v: unknown): v is Scope {
  return (
    isRecord(v) &&
    typeof v.storeRef === "string" &&
    /^[a-f0-9]{64}$/.test(v.storeRef) &&
    (v.backend === "ts" || v.backend === "cpsat") &&
    (v.mode === "live" || v.mode === "probe" || v.mode === "fake")
  );
}
function scopeKey(v: Scope): string {
  return `${v.storeRef}:${v.backend}:${v.mode}`;
}
function isCoverage(v: unknown): v is CpsatObservationCoverage {
  if (
    !isRecord(v) ||
    !interval(v) ||
    !uint(v.capturedFrom) ||
    !uint(v.capturedTo) ||
    v.capturedFrom >= v.capturedTo ||
    !(v.retainedFrom === null || uint(v.retainedFrom)) ||
    !(
      v.samplingRate === null ||
      (typeof v.samplingRate === "number" && v.samplingRate > 0 && v.samplingRate <= 1)
    ) ||
    !(v.exportComplete === null || typeof v.exportComplete === "boolean") ||
    !Array.isArray(v.scopes) ||
    v.scopes.length === 0 ||
    !v.scopes.every(isScope) ||
    !Array.isArray(v.gaps) ||
    !v.gaps.every(interval)
  )
    return false;
  if (new Set(v.scopes.map(scopeKey)).size !== v.scopes.length) return false;
  const limits = v.frequencyLimits;
  return (
    limits === null ||
    (isRecord(limits) &&
      uint(limits.generated) &&
      uint(limits.dispatched) &&
      uint(limits.solveStarted))
  );
}

function emptyCounts() {
  return {
    generated: 0,
    dispatched: 0,
    solveStarted: 0,
    knownSameInputRetries: 0,
    retryClassificationUnknown: 0,
    suppressed: 0,
    dispatchAccepted: 0,
    dispatchFailed: 0,
    solverAccepted: 0,
    preparationFailed: 0,
    solveSucceeded: 0,
    solveFailed: 0,
    adopted: 0,
    rejected: 0,
    planSaved: 0,
    planSaveFailed: 0,
    broadcast: 0,
    callbackDelivered: 0,
    callbackFailed: 0,
    persistFailed: 0,
    doConstructed: 0,
    hibernation: 0,
    cold: 0,
    deployment: 0,
    constructionCauseUnknown: 0,
  };
}

function count(rows: readonly CpsatObservation[]): Counts {
  const counts = emptyCounts();
  for (const row of rows) {
    const f = row.fact;
    switch (f.type) {
      case "cpsat.request-generated":
        counts.generated++;
        break;
      case "cpsat.request-dispatched":
        counts.dispatched++;
        if (f.sameInputRetry === true) counts.knownSameInputRetries++;
        if (f.sameInputRetry === null) counts.retryClassificationUnknown++;
        break;
      case "cpsat.request-suppressed":
        counts.suppressed++;
        break;
      case "cpsat.persist-result":
        if (f.outcome === "failed") counts.persistFailed++;
        break;
      case "cpsat.dispatch-result":
        if (f.outcome === "accepted") counts.dispatchAccepted++;
        else counts.dispatchFailed++;
        break;
      case "cpsat.solver-accepted":
        counts.solverAccepted++;
        break;
      case "cpsat.preparation-failed":
        counts.preparationFailed++;
        break;
      case "cpsat.solve-started":
        counts.solveStarted++;
        break;
      case "cpsat.solve-finished":
        if (f.status === "OPTIMAL" || f.status === "FEASIBLE") counts.solveSucceeded++;
        else counts.solveFailed++;
        break;
      case "cpsat.callback-returned":
        if (f.outcome === "delivered") counts.callbackDelivered++;
        else counts.callbackFailed++;
        break;
      case "cpsat.plan-decided":
        if (f.outcome === "adopted") counts.adopted++;
        else counts.rejected++;
        break;
      case "cpsat.plan-persisted":
        if (f.outcome === "saved") counts.planSaved++;
        else counts.planSaveFailed++;
        break;
      case "cpsat.plan-broadcast":
        counts.broadcast++;
        break;
      case "cpsat.do-constructed":
        counts.doConstructed++;
        if (f.cause === "unknown") counts.constructionCauseUnknown++;
        else counts[f.cause]++;
        break;
    }
  }
  return counts;
}

function semanticKey(row: CpsatObservation): string {
  const f = row.fact;
  const prefix = `${scopeKey(row)}:${f.type}:`;
  switch (f.type) {
    case "cpsat.request-generated":
    case "cpsat.request-suppressed":
      return `${prefix}${row.instanceId}:${f.decisionId}:${f.effectIndex}`;
    case "cpsat.persist-result":
      return `${prefix}${row.instanceId}:${f.decisionId}`;
    case "cpsat.do-constructed":
      return `${prefix}${row.instanceId}`;
    case "cpsat.solve-started":
    case "cpsat.solve-finished":
    case "cpsat.preparation-failed":
    case "cpsat.solver-accepted":
    case "cpsat.plan-decided":
    case "cpsat.plan-persisted":
    case "cpsat.plan-broadcast":
      return `${prefix}${f.requestId}:${row.instanceId}:${row.invocationId}`;
    // メモリの時系列・Timer の再調整は複数回記録できる。
    case "cpsat.measurement":
    case "cpsat.timer":
      return `${prefix}${row.eventId}`;
    default:
      return `${prefix}${f.requestId}`;
  }
}

function validParent(row: CpsatObservation, parent: CpsatObservation | undefined): boolean {
  const f = row.fact;
  if (f.type === "cpsat.request-generated" || f.type === "cpsat.do-constructed")
    return row.parentEventId === null;
  if (f.type === "cpsat.request-dispatched" && f.origin.kind === "probe")
    return row.parentEventId === null;
  if (!parent || scopeKey(parent) !== scopeKey(row)) return false;
  for (const key of ["model", "codec", "wasm", "glue", "profile", "budget"] as const) {
    if (row.versions[key] !== parent.versions[key]) return false;
  }
  const p = parent.fact;
  if ("requestId" in f && "requestId" in p && f.requestId !== p.requestId) return false;
  switch (f.type) {
    case "cpsat.persist-result":
    case "cpsat.request-suppressed":
      return (
        p.type === "cpsat.request-generated" &&
        f.decisionId === p.decisionId &&
        row.instanceId === parent.instanceId &&
        (f.type === "cpsat.persist-result" || f.effectIndex === p.effectIndex)
      );
    case "cpsat.request-dispatched":
      return (
        f.origin.kind === "engine" &&
        parent.instanceId === f.origin.instanceId &&
        ((p.type === "cpsat.persist-result" &&
          p.outcome === "saved" &&
          p.decisionId === f.origin.decisionId) ||
          (p.type === "cpsat.request-generated" &&
            p.decisionId === f.origin.decisionId &&
            p.effectIndex === f.origin.effectIndex))
      );
    case "cpsat.dispatch-result":
    case "cpsat.solver-accepted":
      return p.type === "cpsat.request-dispatched";
    case "cpsat.solve-started":
    case "cpsat.preparation-failed":
      return (
        p.type === "cpsat.solver-accepted" &&
        row.invocationId === parent.invocationId &&
        row.instanceId === parent.instanceId
      );
    case "cpsat.solve-finished":
      return (
        p.type === "cpsat.solve-started" &&
        row.invocationId === parent.invocationId &&
        row.instanceId === parent.instanceId
      );
    case "cpsat.callback-returned":
      return p.type === "cpsat.solve-finished" || p.type === "cpsat.preparation-failed";
    case "cpsat.plan-decided":
      return (
        p.type === "cpsat.solve-finished" &&
        (f.outcome === "rejected" || p.status === "FEASIBLE" || p.status === "OPTIMAL")
      );
    case "cpsat.plan-persisted":
      return p.type === "cpsat.plan-decided" && p.outcome === "adopted";
    case "cpsat.plan-broadcast":
    case "cpsat.timer":
      return p.type === "cpsat.plan-persisted" && p.outcome === "saved";
    case "cpsat.measurement":
      return "requestId" in p && p.type !== "cpsat.measurement" && p.type !== "cpsat.timer";
  }
}

/** 行の順序・重複に依存しない集計。未知の取得範囲を実測0件に補完しない。 */
export function summarizeCpsatObservations(
  input: readonly unknown[],
  coverageInput: unknown,
): CpsatObservationSummary {
  if (!isCoverage(coverageInput))
    return {
      coverage: null,
      invalidRows: 0,
      duplicateRows: 0,
      conflictingRows: 0,
      issues: ["invalid-coverage"],
      usableForRates: false,
      totals: [],
      minutes: [],
    };
  // coverage も共有成果物に出る。未知の設定・秘密値をコピーしない。
  const coverage: CpsatObservationCoverage = {
    from: coverageInput.from,
    to: coverageInput.to,
    capturedFrom: coverageInput.capturedFrom,
    capturedTo: coverageInput.capturedTo,
    retainedFrom: coverageInput.retainedFrom,
    samplingRate: coverageInput.samplingRate,
    exportComplete: coverageInput.exportComplete,
    scopes: coverageInput.scopes.map(({ storeRef, backend, mode }) => ({
      storeRef,
      backend,
      mode,
    })),
    gaps: coverageInput.gaps.map(({ from, to }) => ({ from, to })),
    frequencyLimits:
      coverageInput.frequencyLimits === null
        ? null
        : {
            generated: coverageInput.frequencyLimits.generated,
            dispatched: coverageInput.frequencyLimits.dispatched,
            solveStarted: coverageInput.frequencyLimits.solveStarted,
          },
  };
  // 店舗数と窓数の積を制限する。年単位・全店舗の誤入力でメモリを使い切らない。
  const windowCount = Math.ceil(coverage.to / 60_000) - Math.floor(coverage.from / 60_000);
  if (windowCount * coverage.scopes.length > 100_000)
    return {
      coverage,
      invalidRows: 0,
      duplicateRows: 0,
      conflictingRows: 0,
      issues: ["coverage-too-large"],
      usableForRates: false,
      totals: [],
      minutes: [],
    };
  let invalidRows = 0;
  let duplicateRows = 0;
  let conflictingRows = 0;
  const issues = new Set<string>();
  const byId = new Map<string, CpsatObservation>();
  const byMeaning = new Map<string, CpsatObservation>();
  const rows: CpsatObservation[] = [];
  const parsed = input
    .flatMap((value) => {
      const row = parseCpsatObservation(value);
      if (row === null) {
        invalidRows++;
        return [];
      }
      return [row];
    })
    .sort((a, b) =>
      (serializeCpsatObservation(a) ?? "").localeCompare(serializeCpsatObservation(b) ?? ""),
    );
  for (const row of parsed) {
    const prior = byId.get(row.eventId) ?? byMeaning.get(semanticKey(row));
    if (prior) {
      if (serializeCpsatObservation(prior) === serializeCpsatObservation(row)) duplicateRows++;
      else conflictingRows++;
    } else {
      byId.set(row.eventId, row);
      byMeaning.set(semanticKey(row), row);
      rows.push(row);
    }
  }
  if (invalidRows) issues.add("invalid-rows");
  if (conflictingRows) issues.add("conflicting-rows");
  for (const row of rows) {
    if (!validParent(row, row.parentEventId === null ? undefined : byId.get(row.parentEventId)))
      issues.add("broken-causal-link");
    if (!coverage.scopes.some((scope) => scopeKey(scope) === scopeKey(row)))
      issues.add("unlisted-scope");
    if (row.at < coverage.capturedFrom || row.at >= coverage.capturedTo)
      issues.add("outside-capture");
    if (
      row.fact.type === "cpsat.solve-started" &&
      byMeaning.has(
        `${scopeKey(row)}:cpsat.preparation-failed:${row.fact.requestId}:${row.instanceId}:${row.invocationId}`,
      )
    )
      issues.add("solve-after-preparation-failure");
    if (row.fact.type === "cpsat.request-dispatched" && row.fact.origin.kind === "engine") {
      const origin = row.fact.origin;
      const key = `${scopeKey(row)}:cpsat.request-generated:${origin.instanceId}:${origin.decisionId}:${origin.effectIndex}`;
      if (!byMeaning.has(key)) issues.add("missing-generation");
      const persistence = byMeaning.get(
        `${scopeKey(row)}:cpsat.persist-result:${origin.instanceId}:${origin.decisionId}`,
      );
      if (
        persistence?.fact.type === "cpsat.persist-result" &&
        persistence.fact.outcome === "failed"
      )
        issues.add("dispatch-after-persist-failure");
    }
  }
  const globalIssues = [...issues].sort();
  const byScope = new Map<string, CpsatObservation[]>();
  const byMinute = new Map<string, CpsatObservation[]>();
  for (const row of rows) {
    if (row.at < coverage.from || row.at >= coverage.to) continue;
    const scope = scopeKey(row);
    const minute = `${scope}:${Math.floor(row.at / 60_000)}`;
    const all = byScope.get(scope) ?? [];
    all.push(row);
    byScope.set(scope, all);
    const bucket = byMinute.get(minute) ?? [];
    bucket.push(row);
    byMinute.set(minute, bucket);
  }
  function window(scope: Scope, from: number, to: number, assessFrequency: boolean): Window {
    const missing = [...globalIssues];
    if (coverage.samplingRate !== 1) missing.push("sampling");
    if (coverage.exportComplete !== true) missing.push("export-incomplete");
    if (coverage.retainedFrom === null || coverage.retainedFrom > from) missing.push("retention");
    if (coverage.capturedFrom > from || coverage.capturedTo < to) missing.push("capture-range");
    if (coverage.gaps.some((gap) => gap.from < to && gap.to > from)) missing.push("capture-gap");
    const selected = assessFrequency
      ? byMinute.get(`${scopeKey(scope)}:${Math.floor(from / 60_000)}`)
      : byScope.get(scopeKey(scope));
    const observed = count(selected ?? []);
    const counts = missing.length === 0 ? observed : null;
    const limits = coverage.frequencyLimits;
    let frequency: Window["frequency"] = "not-configured";
    if (limits !== null) {
      frequency =
        counts === null || !assessFrequency || to - from !== 60_000
          ? "not-assessed"
          : counts.generated > limits.generated ||
              counts.dispatched > limits.dispatched ||
              counts.solveStarted > limits.solveStarted
            ? "exceeded"
            : "within-range";
    }
    return { ...scope, from, to, observed, counts, missingReasons: missing, frequency };
  }
  const scopes = [...coverage.scopes].sort((a, b) => scopeKey(a).localeCompare(scopeKey(b)));
  const totals = scopes.map((scope) => window(scope, coverage.from, coverage.to, false));
  const minutes: Window[] = [];
  for (
    let start = Math.floor(coverage.from / 60_000) * 60_000;
    start < coverage.to;
    start += 60_000
  ) {
    for (const scope of scopes)
      minutes.push(
        window(scope, Math.max(start, coverage.from), Math.min(start + 60_000, coverage.to), true),
      );
  }
  return {
    coverage,
    invalidRows,
    duplicateRows,
    conflictingRows,
    issues: globalIssues,
    usableForRates: totals.every((total) => total.counts !== null),
    totals,
    minutes,
  };
}
