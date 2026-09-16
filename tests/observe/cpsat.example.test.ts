import * as fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  buildCpsatObservation,
  parseCpsatObservation,
  serializeCpsatObservation,
  type CpsatObservation,
} from "../../src/cpsat/observation";
import { observeCpsat } from "../../src/cpsat/observe";
import { summarizeCpsatObservations, type CpsatObservationCoverage } from "../../src/observe/cpsat";
import { decide } from "../../src/engine/decide";
import { genScheduledScene } from "../core/schedulingScenes";
import fixture from "./fixtures/cpsat-counts.json";

const scope = { storeRef: "a".repeat(64), backend: "cpsat", mode: "fake" } as const;
const versions = {
  code: "fixture-v1",
  model: null,
  codec: null,
  wasm: null,
  glue: null,
  profile: null,
  budget: null,
  missingReason: "fake",
} as const;
const coverage: CpsatObservationCoverage = {
  from: 0,
  to: 120_000,
  capturedFrom: 0,
  capturedTo: 120_000,
  retainedFrom: 0,
  samplingRate: 1,
  exportComplete: true,
  scopes: [scope],
  gaps: [],
  frequencyLimits: null,
};

function row(
  eventId: string,
  fact: CpsatObservation["fact"],
  parentEventId: string | null = null,
  extra: Partial<Omit<CpsatObservation, "fact" | "eventId" | "parentEventId">> = {},
): CpsatObservation {
  const built = buildCpsatObservation({
    ...scope,
    versions,
    at: 10,
    instanceId: "do-1",
    invocationId: "entry-1",
    ...extra,
    eventId,
    parentEventId,
    fact,
  });
  if (built === null) throw new Error("Invalid test observation");
  return built;
}

const generated = row("g", {
  type: "cpsat.request-generated",
  decisionId: "decision-1",
  effectIndex: 3,
});
const saved = row(
  "p",
  { type: "cpsat.persist-result", decisionId: "decision-1", outcome: "saved" },
  "g",
);
const dispatched = row(
  "d",
  {
    type: "cpsat.request-dispatched",
    requestId: "req-1",
    origin: { kind: "engine", instanceId: "do-1", decisionId: "decision-1", effectIndex: 3 },
    sameInputRetry: false,
  },
  "p",
);
const accepted = row("a", { type: "cpsat.solver-accepted", requestId: "req-1" }, "d", {
  instanceId: "solver-1",
  invocationId: "solve-1",
});
const started = row("s", { type: "cpsat.solve-started", requestId: "req-1" }, "a", {
  instanceId: "solver-1",
  invocationId: "solve-1",
});
const finished = row(
  "f",
  { type: "cpsat.solve-finished", requestId: "req-1", status: "FEASIBLE" },
  "s",
  { instanceId: "solver-1", invocationId: "solve-1" },
);
const decided = row(
  "v",
  { type: "cpsat.plan-decided", requestId: "req-1", outcome: "adopted" },
  "f",
);
const committed = row(
  "c",
  { type: "cpsat.plan-persisted", requestId: "req-1", outcome: "saved" },
  "v",
);
const trace = [generated, saved, dispatched, accepted, started, finished, decided, committed];

describe("CP-SAT observation codec", () => {
  it("round trips every lifecycle fact without sharing mutable input", () => {
    const rows = [
      ...trace,
      row(
        "suppressed",
        {
          type: "cpsat.request-suppressed",
          decisionId: "decision-1",
          effectIndex: 3,
          reason: "duplicate",
        },
        "g",
      ),
      row(
        "dispatch-result",
        { type: "cpsat.dispatch-result", requestId: "req-1", outcome: "accepted" },
        "d",
      ),
      row(
        "callback",
        { type: "cpsat.callback-returned", requestId: "req-1", outcome: "delivered" },
        "f",
      ),
      row("broadcast", { type: "cpsat.plan-broadcast", requestId: "req-1" }, "c"),
      row("construct", { type: "cpsat.do-constructed", cause: "unknown" }),
    ];
    for (const original of rows) {
      const copy = parseCpsatObservation(serializeCpsatObservation(original));
      expect(copy).toEqual(original);
      expect(copy).not.toBe(original);
      expect(copy?.fact).not.toBe(original.fact);
    }
  });

  it.each([
    { ...generated, schemaVersion: 2 },
    { ...generated, at: NaN },
    { ...generated, at: Infinity },
    { ...generated, at: Number.MAX_SAFE_INTEGER + 1 },
    { ...generated, eventId: "" },
    { ...generated, inputKey: "RAW_CANONICAL_INPUT" },
    { ...generated, fact: { ...generated.fact, order: "RAW_ORDER" } },
    { ...generated, versions: { ...versions, token: "SECRET" } },
    { ...generated, storeRef: "raw-store-name" },
    { ...generated, parentEventId: generated.eventId },
    { ...generated, mode: "probe" },
    { ...generated, fact: { ...generated.fact, effectIndex: -1 } },
    { ...generated, versions: { ...versions, missingReason: null } },
    "{",
    "x".repeat(16_385),
  ])("rejects unknown, non-finite, raw or ambiguous input %#", (input) => {
    expect(parseCpsatObservation(input)).toBeNull();
  });

  it("does not serialize unknown properties or custom toJSON and does not throw on log failure", () => {
    const sink = vi.fn();
    const unsafe = { ...generated, token: "SECRET" };
    expect(observeCpsat(unsafe, sink)).toBe(false);
    const custom = { ...generated, toJSON: () => ({ secret: "SECRET" }) };
    expect(observeCpsat(custom, sink)).toBe(false);
    expect(sink).not.toHaveBeenCalled();
    expect(
      observeCpsat(generated, () => {
        throw new Error("sink failed");
      }),
    ).toBe(false);
    expect(observeCpsat(generated, sink)).toBe(true);
    expect(sink).toHaveBeenCalledExactlyOnceWith(serializeCpsatObservation(generated));
  });

  it("keeps missing measurements distinct from measured zero and validates the measurement interval", () => {
    const measurement = row(
      "cpu",
      {
        type: "cpsat.measurement",
        requestId: "req-1",
        metric: "cpu-ms",
        reading: {
          value: 0,
          source: "platform-invocation",
          from: "invocation-start",
          to: "invocation-end",
          bound: "exact",
        },
      },
      "d",
    );
    expect(parseCpsatObservation(measurement)).toEqual(measurement);
    const missing = row(
      "missing",
      {
        type: "cpsat.measurement",
        requestId: "req-1",
        metric: "cpu-ms",
        reading: { value: null, reason: "clock-not-advancing" },
      },
      "d",
    );
    expect(missing.fact).not.toEqual(measurement.fact);
    expect(
      parseCpsatObservation({
        ...measurement,
        fact: {
          ...measurement.fact,
          reading: {
            value: 0,
            source: "host-clock",
            from: "solve-started",
            to: "solve-finished",
            bound: "exact",
          },
        },
      }),
    ).toBeNull();
    const upper = row(
      "wait-until",
      {
        type: "cpsat.measurement",
        requestId: "req-1",
        metric: "wait-until-wall-ms",
        reading: {
          value: 6500,
          source: "platform-invocation",
          from: "invocation-start",
          to: "wait-until-end",
          bound: "upper",
        },
      },
      "d",
    );
    expect(parseCpsatObservation(upper)).toEqual(upper);
    if (upper.fact.type !== "cpsat.measurement" || upper.fact.reading.value === null)
      throw new Error("fixture");
    expect(
      parseCpsatObservation({
        ...upper,
        fact: { ...upper.fact, reading: { ...upper.fact.reading, to: "invocation-end" } },
      }),
    ).toBeNull();
    expect(
      parseCpsatObservation({
        ...upper,
        fact: { ...upper.fact, reading: { ...upper.fact.reading, bound: "exact" } },
      }),
    ).toBeNull();
  });

  it("keeps planned, effective and automatic fire times distinct, including catch-up firing", () => {
    const first = row(
      "timer-1",
      {
        type: "cpsat.timer",
        requestId: "req-1",
        itemRef: "b".repeat(64),
        timerRef: "c".repeat(64),
        plannedServeAt: 1000,
        effectiveEndTime: 1100,
        boiledAt: 3000,
        boiledAtState: "observed",
      },
      "c",
      { at: 3000 },
    );
    const second = row(
      "timer-2",
      {
        type: "cpsat.timer",
        requestId: "req-1",
        itemRef: "d".repeat(64),
        timerRef: "e".repeat(64),
        plannedServeAt: 1000,
        effectiveEndTime: 1200,
        boiledAt: 3000,
        boiledAtState: "observed",
      },
      "c",
      { at: 3000 },
    );
    expect(parseCpsatObservation(serializeCpsatObservation(first))).toEqual(first);
    expect(summarizeCpsatObservations([...trace, first, second], coverage).usableForRates).toBe(
      true,
    );
    expect(
      parseCpsatObservation({ ...first, fact: { ...first.fact, completeAt: 3000 } }),
    ).toBeNull();
    expect(parseCpsatObservation({ ...first, fact: { ...first.fact, boiledAt: null } })).toBeNull();
  });
});

describe("CP-SAT counts across instances", () => {
  it("uses the persisted fixture: generated 2, dispatched 1, solve started 0", () => {
    const summary = summarizeCpsatObservations(fixture.rows, fixture.coverage);
    expect(summary.usableForRates).toBe(true);
    expect(summary.totals[0]?.counts).toMatchObject({
      generated: 2,
      dispatched: 1,
      solveStarted: 0,
      persistFailed: 1,
      doConstructed: 2,
      constructionCauseUnknown: 1,
      hibernation: 1,
    });
    expect(summary.minutes.map((minute) => minute.counts?.generated)).toEqual([1, 1]);
  });

  it("deduplicates reordered rows but not distinct instances or invocations", () => {
    const summary = summarizeCpsatObservations([...trace, ...trace].reverse(), coverage);
    expect(summary.duplicateRows).toBe(trace.length);
    expect(summary.usableForRates).toBe(true);
    expect(summary.totals[0]?.counts).toMatchObject({
      generated: 1,
      dispatched: 1,
      solveStarted: 1,
      solveSucceeded: 1,
      adopted: 1,
      planSaved: 1,
    });
    const anotherAccepted = {
      ...accepted,
      eventId: "a2",
      instanceId: "solver-2",
      invocationId: "solve-2",
    };
    const anotherStart = {
      ...started,
      eventId: "s2",
      parentEventId: "a2",
      instanceId: "solver-2",
      invocationId: "solve-2",
    };
    expect(
      summarizeCpsatObservations([...trace, anotherAccepted, anotherStart], coverage).totals[0]
        ?.counts?.solveStarted,
    ).toBe(2);
  });

  it.each(["g", "p", "d", "a", "s", "f", "v"])(
    "does not pass a trace with the middle row %s removed",
    (id) => {
      const summary = summarizeCpsatObservations(
        trace.filter((item) => item.eventId !== id),
        coverage,
      );
      expect(summary.usableForRates).toBe(false);
      expect(summary.issues).toContain("broken-causal-link");
      expect(summary.totals[0]?.counts).toBeNull();
    },
  );

  it.each([
    { samplingRate: 0.5 },
    { samplingRate: null },
    { retainedFrom: null },
    { retainedFrom: 1 },
    { exportComplete: false },
    { exportComplete: null },
    { capturedFrom: 1 },
    { capturedTo: 60_000 },
    { gaps: [{ from: 60_000, to: 120_000 }] },
  ])("does not turn incomplete acquisition into zero %#", (change) => {
    const summary = summarizeCpsatObservations([], { ...coverage, ...change });
    expect(summary.usableForRates).toBe(false);
    expect(summary.totals[0]?.observed.solveStarted).toBe(0);
    expect(summary.totals[0]?.counts).toBeNull();
  });

  it("invalidates only gap-overlapping windows, and labels unknown causes and retries", () => {
    const summary = summarizeCpsatObservations(fixture.rows, {
      ...fixture.coverage,
      gaps: [{ from: 60_000, to: 120_000 }],
    });
    expect(summary.minutes[0]?.counts).not.toBeNull();
    expect(summary.minutes[1]?.counts).toBeNull();
    const unknown = { ...dispatched, fact: { ...dispatched.fact, sameInputRetry: null } };
    const counts = summarizeCpsatObservations([generated, saved, unknown], coverage).totals[0]
      ?.counts;
    expect(counts).toMatchObject({ knownSameInputRetries: 0, retryClassificationUnknown: 1 });
  });

  it("rejects conflicting IDs, semantic duplicate generations, broken request IDs, and send-after-put-failure", () => {
    for (const rows of [
      [...trace, { ...generated, at: 11 }],
      [...trace, { ...generated, eventId: "different-id" }],
      [...trace, { ...dispatched, fact: { ...dispatched.fact, requestId: "different-request" } }],
      trace.map((r) =>
        r.eventId === "p" ? { ...saved, fact: { ...saved.fact, outcome: "failed" } } : r,
      ),
    ])
      expect(summarizeCpsatObservations(rows, coverage).usableForRates).toBe(false);
  });

  it("separates live/probe/fake and never invents engine generation for a direct probe", () => {
    const probe = row(
      "probe",
      {
        type: "cpsat.request-dispatched",
        requestId: "probe-request",
        origin: { kind: "probe" },
        sameInputRetry: false,
      },
      null,
      { mode: "probe", versions: { ...versions, missingReason: "not-recorded" } },
    );
    const summary = summarizeCpsatObservations([...trace, probe], {
      ...coverage,
      scopes: [scope, { ...scope, mode: "probe" }, { ...scope, mode: "live" }],
    });
    expect(summary.usableForRates).toBe(true);
    expect(summary.totals.find((total) => total.mode === "probe")?.counts).toMatchObject({
      generated: 0,
      dispatched: 1,
      solveStarted: 0,
    });
    expect(summary.totals.find((total) => total.mode === "live")?.counts?.dispatched).toBe(0);
    expect(summarizeCpsatObservations([probe], coverage).issues).toContain("unlisted-scope");
  });

  it("checks operational frequency only on complete fixed one-minute windows", () => {
    const limits = { generated: 0, dispatched: 0, solveStarted: 0 };
    const summary = summarizeCpsatObservations(trace, { ...coverage, frequencyLimits: limits });
    expect(summary.minutes.map((minute) => minute.frequency)).toEqual(["exceeded", "within-range"]);
    expect(summary.totals[0]?.frequency).toBe("not-assessed");
    expect(
      summarizeCpsatObservations(trace, { ...coverage, samplingRate: 0.5, frequencyLimits: limits })
        .minutes[0]?.frequency,
    ).toBe("not-assessed");
    expect(
      summarizeCpsatObservations([], { ...coverage, from: 1, frequencyLimits: limits }).minutes[0]
        ?.frequency,
    ).toBe("not-assessed");
  });

  it("retains cross-window context and rejects invalid coverage or malformed rows", () => {
    expect(summarizeCpsatObservations(trace, { ...coverage, from: 60_000 }).usableForRates).toBe(
      true,
    );
    expect(summarizeCpsatObservations(trace, { ...coverage, to: -1 }).usableForRates).toBe(false);
    expect(summarizeCpsatObservations(["RAW_SECRET"], coverage)).toMatchObject({
      invalidRows: 1,
      usableForRates: false,
    });
    expect(JSON.stringify(summarizeCpsatObservations(["RAW_SECRET"], coverage))).not.toContain(
      "RAW_SECRET",
    );
    const withSecret = {
      ...coverage,
      secret: "RAW_SECRET",
      scopes: [{ ...scope, secret: "RAW_SECRET" }],
    };
    expect(JSON.stringify(summarizeCpsatObservations([], withSecret))).not.toContain("RAW_SECRET");
    expect(
      summarizeCpsatObservations([], { ...coverage, to: Number.MAX_SAFE_INTEGER }).issues,
    ).toContain("coverage-too-large");
  });

  it("records initialization failures as zero solves, and distinguishes validation from persistence and broadcast", () => {
    const failed = row(
      "init-failed",
      { type: "cpsat.preparation-failed", requestId: "req-1", stage: "initialization" },
      "a",
      { instanceId: "solver-1", invocationId: "solve-1" },
    );
    const noSolve = summarizeCpsatObservations(
      [generated, saved, dispatched, accepted, failed],
      coverage,
    );
    expect(noSolve.usableForRates).toBe(true);
    expect(noSolve.totals[0]?.counts).toMatchObject({
      generated: 1,
      dispatched: 1,
      solveStarted: 0,
      preparationFailed: 1,
      solveFailed: 0,
    });
    expect(summarizeCpsatObservations([...trace, failed], coverage).issues).toContain(
      "solve-after-preparation-failure",
    );
    const failedSave = row(
      "c",
      { type: "cpsat.plan-persisted", requestId: "req-1", outcome: "failed" },
      "v",
    );
    const rows = [...trace.slice(0, -1), failedSave];
    expect(summarizeCpsatObservations(rows, coverage).totals[0]?.counts).toMatchObject({
      adopted: 1,
      planSaved: 0,
      planSaveFailed: 1,
      broadcast: 0,
    });
    expect(
      summarizeCpsatObservations(
        [...rows, row("broadcast", { type: "cpsat.plan-broadcast", requestId: "req-1" }, "c")],
        coverage,
      ).usableForRates,
    ).toBe(false);
    const wrongVersion = { ...accepted, versions: { ...versions, model: "different-model" } };
    expect(
      summarizeCpsatObservations(
        trace.map((r) => (r.eventId === "a" ? wrongVersion : r)),
        coverage,
      ).usableForRates,
    ).toBe(false);
  });

  it("counts a duplicate response rejection in a later DO invocation separately from the original adoption", () => {
    const duplicate = row(
      "duplicate-rejected",
      { type: "cpsat.plan-decided", requestId: "req-1", outcome: "rejected" },
      "f",
      { instanceId: "do-2", invocationId: "callback-2" },
    );
    const summary = summarizeCpsatObservations([...trace, duplicate], coverage);
    expect(summary.usableForRates).toBe(true);
    expect(summary.totals[0]?.counts).toMatchObject({ adopted: 1, rejected: 1, planSaved: 1 });
  });
});

describe("three recording points connected to a fake transport", () => {
  // 既存の決定を素材にする。F-1 の Event・要求単独列は導入しない。
  const requesting = fc
    .sample(genScheduledScene, { seed: 20_260_626, numRuns: 30 })
    .map((scene) => decide(scene.state, scene.event, scene.params))
    .find(
      (outcome) => outcome.ok && outcome.effects.some((effect) => effect.type === "RequestPlan"),
    );

  async function run(
    failure: "persist" | "suppressed" | "dispatch" | "accepted-only" | "none",
    sinkFails = false,
  ) {
    if (!requesting?.ok) throw new Error("Generator did not produce RequestPlan");
    expect(requesting.effects[0]?.type).toBe("Persist");
    const lines: string[] = [];
    const order: string[] = [];
    const emit = (observation: CpsatObservation) => {
      order.push(observation.fact.type);
      return observeCpsat(observation, (line) => {
        if (sinkFails) throw new Error("sink");
        lines.push(line);
      });
    };
    const put = vi.fn(async () => {
      order.push("put");
      if (failure === "persist") throw new Error("put failed");
    });
    const solve = vi.fn(() => {
      order.push("wasm-call");
      return "FEASIBLE" as const;
    });
    // H1: decide の列を受け取った直後。Persist より前なので put 失敗時も生成が残る。
    const index = requesting.effects.findIndex((effect) => effect.type === "RequestPlan");
    const gen = row("g", {
      type: "cpsat.request-generated",
      decisionId: "decision-1",
      effectIndex: index,
    });
    emit(gen);
    const binding = {
      fetch: vi.fn(async () => {
        order.push("binding-call");
        if (failure === "dispatch") throw new Error("binding failed");
        emit(accepted);
        if (failure !== "accepted-only") {
          // H3: 初期化・モデル・直列化を終えたと見立てた地点。solve の直前だけで記録する。
          emit(started);
          const status = solve();
          emit({ ...finished, fact: { type: "cpsat.solve-finished", requestId: "req-1", status } });
        }
        return new Response(null, { status: 202 });
      }),
    };
    for (const effect of requesting.effects) {
      if (effect.type === "Persist") {
        // 順序そのものが主張対象。Persist と要求を並列化しない。
        try {
          // oxlint-disable-next-line no-await-in-loop -- 順序付き Effect の fake interpreter。
          await put();
          emit(saved);
        } catch {
          emit(
            row(
              "p",
              { type: "cpsat.persist-result", decisionId: "decision-1", outcome: "failed" },
              "g",
            ),
          );
          break;
        }
      } else if (effect.type === "RequestPlan") {
        if (failure === "suppressed") {
          emit(
            row(
              "suppressed",
              {
                type: "cpsat.request-suppressed",
                decisionId: "decision-1",
                effectIndex: index,
                reason: "in-flight",
              },
              "g",
            ),
          );
          continue;
        }
        const dispatch = row(
          "d",
          {
            type: "cpsat.request-dispatched",
            requestId: "req-1",
            origin: {
              kind: "engine",
              instanceId: "do-1",
              decisionId: "decision-1",
              effectIndex: index,
            },
            sameInputRetry: false,
          },
          "p",
        );
        try {
          // H2: 送信を試みる直前。受理や求解成功ではない。
          emit(dispatch);
          // oxlint-disable-next-line no-await-in-loop -- 順序付き Effect の fake interpreter。
          const response = await binding.fetch();
          emit(
            row(
              "result",
              {
                type: "cpsat.dispatch-result",
                requestId: "req-1",
                outcome: response.status === 202 ? "accepted" : "failed",
              },
              "d",
            ),
          );
        } catch {
          emit(
            row(
              "result",
              { type: "cpsat.dispatch-result", requestId: "req-1", outcome: "failed" },
              "d",
            ),
          );
        }
      }
    }
    return {
      lines,
      order,
      put,
      binding,
      solve,
      summary: summarizeCpsatObservations(lines, coverage),
    };
  }

  it.each([
    ["persist", 0, 0],
    ["suppressed", 0, 0],
    ["dispatch", 1, 0],
    ["accepted-only", 1, 0],
    ["none", 1, 1],
  ] as const)("%s records generation/send/solve separately", async (failure, sent, solved) => {
    const result = await run(failure);
    expect(result.summary.usableForRates).toBe(true);
    expect(result.summary.totals[0]?.counts).toMatchObject({
      generated: 1,
      dispatched: sent,
      solveStarted: solved,
    });
    expect(result.binding.fetch).toHaveBeenCalledTimes(sent);
    expect(result.solve).toHaveBeenCalledTimes(solved);
    expect(result.order.indexOf("cpsat.request-generated")).toBeLessThan(
      result.order.indexOf("put"),
    );
    if (sent)
      expect(result.order.indexOf("cpsat.request-dispatched") + 1).toBe(
        result.order.indexOf("binding-call"),
      );
    if (solved)
      expect(result.order.indexOf("cpsat.solve-started") + 1).toBe(
        result.order.indexOf("wasm-call"),
      );
  });

  it("does not fail operations when observation output fails", async () => {
    const result = await run("none", true);
    expect(result.put).toHaveBeenCalledOnce();
    expect(result.solve).toHaveBeenCalledOnce();
    expect(result.lines).toEqual([]);
    // 呼出側は捕捉した欠測を manifest へ渡す。空ログから取得成功を推測しない。
    expect(
      summarizeCpsatObservations(result.lines, { ...coverage, exportComplete: false })
        .usableForRates,
    ).toBe(false);
  });
});
