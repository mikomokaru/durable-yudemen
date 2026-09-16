import { afterEach, describe, expect, it, vi } from "vitest";
import {
  toCpsatTransportRequest,
  dispatchCpsatTransportRequest,
} from "../experiments/cpsat-workers/transport/request";
import manifest from "../experiments/cpsat-workers/transport/manifest.json";
import { parseCpsatObservation, type CpsatObservation } from "../src/cpsat/observation";
import { summarizeCpsatObservations } from "../src/observe/cpsat";
import provenance from "./observe/fixtures/cpsat-transport-provenance.json";

const probe = { allowed: true, origin: { kind: "probe" } } as const;
const engine = {
  allowed: true,
  origin: { kind: "engine", instanceId: "do-1", decisionId: "decision-1", effectIndex: 3 },
  parentEventId: "persist-1",
  storeRef: manifest.stores[0]?.ref ?? "",
} as const;

function row(): CpsatObservation {
  const problem = manifest.problems[0];
  if (!problem) throw new Error("Missing fixed fixture");
  return {
    schemaVersion: 1,
    eventId: "caller-intent",
    at: Date.now(),
    storeRef: engine.storeRef,
    backend: "cpsat",
    // Direct probes never create engine-generation facts.
    mode: "probe",
    instanceId: "caller-instance",
    invocationId: "caller-invocation",
    parentEventId: null,
    versions: {
      code: manifest.code,
      model: problem.sha256,
      codec: manifest.codec,
      wasm: manifest.wasm,
      glue: manifest.glue,
      profile: manifest.profile,
      budget: String(problem.budget),
      missingReason: null,
    },
    fact: {
      type: "cpsat.request-dispatched",
      requestId: "req-1",
      origin: probe.origin,
      sameInputRetry: false,
    },
  };
}

function admitted() {
  const input = toCpsatTransportRequest(JSON.stringify(row()), probe);
  if (!input) throw new Error("Positive control was rejected");
  return input;
}

function capture() {
  const rows: CpsatObservation[] = [];
  const write = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    if (typeof line !== "string") throw new Error("Non-text observation");
    const parsed = parseCpsatObservation(line);
    if (!parsed) throw new Error("Invalid observation");
    rows.push(parsed);
  });
  return { rows, write };
}

afterEach(() => vi.restoreAllMocks());

describe("fixed transport request conversion", () => {
  it.each(provenance)("shares the solver's mode/origin/parent fixture %#", (fixture) => {
    const input = row();
    const text = JSON.stringify({
      ...input,
      mode: fixture.mode,
      instanceId: fixture.origin === "engine" ? engine.origin.instanceId : input.instanceId,
      parentEventId: fixture.parentEventId,
      fact: {
        ...input.fact,
        origin: fixture.origin === "engine" ? engine.origin : probe.origin,
      },
    });
    expect(parseCpsatObservation(text) !== null).toBe(fixture.codecAccepted);
    const authorization = fixture.origin === "engine" ? engine : probe;
    expect(toCpsatTransportRequest(text, authorization) !== null).toBe(fixture.transportAccepted);
    // Even a valid row cannot switch the trusted caller's provenance.
    expect(toCpsatTransportRequest(text, fixture.origin === "engine" ? probe : engine)).toBeNull();
  });

  it("requires caller authorization and preserves fixed-input validation", () => {
    const input = row();
    const text = JSON.stringify(input);
    expect(toCpsatTransportRequest(text, probe)).toEqual(input);
    expect(toCpsatTransportRequest(text, { ...probe, allowed: false })).toBeNull();
    expect(toCpsatTransportRequest(null, probe)).toBeNull();
    expect(toCpsatTransportRequest("{", probe)).toBeNull();
    expect(toCpsatTransportRequest(" ".repeat(16_385), probe)).toBeNull();
    expect(
      toCpsatTransportRequest(JSON.stringify({ ...input, secret: "never-log" }), probe),
    ).toBeNull();
    expect(toCpsatTransportRequest(JSON.stringify({ ...input, mode: "live" }), probe)).toBeNull();
    expect(
      toCpsatTransportRequest(JSON.stringify({ ...input, storeRef: "f".repeat(64) }), probe),
    ).toBeNull();
    expect(
      toCpsatTransportRequest(
        JSON.stringify({ ...input, versions: { ...input.versions, budget: "1" } }),
        probe,
      ),
    ).toBeNull();
  });

  it("matches trusted Effect provenance without allowing a probe body to claim it", () => {
    const input = admitted();
    const fromEngine = {
      ...input,
      mode: "live",
      instanceId: engine.origin.instanceId,
      parentEventId: engine.parentEventId,
      fact: { ...input.fact, origin: engine.origin },
    };
    const text = JSON.stringify(fromEngine);
    expect(toCpsatTransportRequest(text, engine)).toEqual(fromEngine);
    expect(toCpsatTransportRequest(text, probe)).toBeNull();
    const disguised = JSON.stringify({ ...fromEngine, mode: "probe" });
    expect(toCpsatTransportRequest(disguised, engine)).toBeNull();
    expect(toCpsatTransportRequest(disguised, probe)).toBeNull();
    expect(toCpsatTransportRequest(JSON.stringify(input), engine)).toBeNull();
    expect(toCpsatTransportRequest(text, { ...engine, allowed: false })).toBeNull();
    expect(toCpsatTransportRequest(text, { ...engine, parentEventId: "other-persist" })).toBeNull();
    expect(toCpsatTransportRequest(text, { ...engine, storeRef: "f".repeat(64) })).toBeNull();
    for (const origin of [
      { ...engine.origin, instanceId: "other-instance" },
      { ...engine.origin, decisionId: "other-decision" },
      { ...engine.origin, effectIndex: 4 },
    ]) {
      expect(toCpsatTransportRequest(text, { ...engine, origin })).toBeNull();
    }
  });

  it("does not fold the active time window into conversion", () => {
    // Checked-in manifest is disabled with a closed window. Conversion alone
    // must not be treated as permission to dispatch at a later time.
    expect(manifest.enabled).toBe(false);
    expect(manifest.expiresAt).toBe(0);
    expect(toCpsatTransportRequest(JSON.stringify(row()), probe)).not.toBeNull();
  });
});

describe("one observed transport attempt", () => {
  it("rechecks the window after an asynchronous boundary, with zero dispatch on expiry", async () => {
    const { rows } = capture();
    let now = 100;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const withinWindow = () => now >= 100 && now < 200;
    const fetch = vi.fn<Fetcher["fetch"]>().mockResolvedValue(new Response(null, { status: 202 }));
    expect(withinWindow()).toBe(true);
    const input = admitted();
    // Deterministic scheduling boundary, not a real-time sleep or a solver measurement.
    await Promise.resolve().then(() => {
      now = 200;
    });
    const response = await dispatchCpsatTransportRequest(input, { fetch }, withinWindow);
    expect(response.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });

  it.each([
    [202, 202, "accepted"],
    [429, 429, "busy"],
    [503, 503, "failed"],
    [200, 503, "failed"],
  ] as const)("records one attempt for downstream %i", async (status, expected, outcome) => {
    const { rows } = capture();
    const input = admitted();
    const fetch = vi.fn<Fetcher["fetch"]>().mockImplementation(async (request) => {
      expect(request).toBeInstanceOf(Request);
      if (!(request instanceof Request)) throw new Error("Expected bounded request");
      expect(request.url).toBe("https://solver.invalid/plan");
      expect(request.method).toBe("POST");
      expect(rows).toHaveLength(1);
      expect(parseCpsatObservation(await request.text())).toEqual(rows[0]);
      return new Response(null, { status });
    });
    const response = await dispatchCpsatTransportRequest(input, { fetch }, () => true);
    expect(response.status).toBe(expected);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.eventId).not.toBe(input.eventId);
    expect(rows[0]?.instanceId).not.toBe(input.instanceId);
    expect(rows[0]?.invocationId).not.toBe(input.invocationId);
    expect(rows[0]?.parentEventId).toBeNull();
    expect(rows[0]?.fact).toEqual(input.fact);
    expect(rows[1]?.parentEventId).toBe(rows[0]?.eventId);
    expect(rows[1]?.fact).toEqual({ type: "cpsat.dispatch-result", requestId: "req-1", outcome });
  });

  it("does not send if the dispatch observation cannot be written", async () => {
    const { write } = capture();
    write.mockImplementation(() => {
      throw new Error("write unavailable");
    });
    const fetch = vi.fn<Fetcher["fetch"]>();
    const response = await dispatchCpsatTransportRequest(admitted(), { fetch }, () => true);
    expect(response.status).toBe(503);
    expect(write).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("records a binding exception without a second attempt", async () => {
    const { rows } = capture();
    const fetch = vi.fn<Fetcher["fetch"]>().mockRejectedValue(new Error("injected"));
    const response = await dispatchCpsatTransportRequest(admitted(), { fetch }, () => true);
    expect(response.status).toBe(503);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.fact).toEqual({
      type: "cpsat.dispatch-result",
      requestId: "req-1",
      outcome: "failed",
    });
  });

  it("records the result of an already sent request even after the window closes", async () => {
    const { rows } = capture();
    let active = true;
    const withinWindow = vi.fn(() => active);
    const fetch = vi.fn<Fetcher["fetch"]>().mockImplementation(async () => {
      await Promise.resolve();
      active = false;
      return new Response(null, { status: 202 });
    });
    const response = await dispatchCpsatTransportRequest(admitted(), { fetch }, withinWindow);
    expect(response.status).toBe(202);
    expect(withinWindow).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.fact).toEqual({
      type: "cpsat.dispatch-result",
      requestId: "req-1",
      outcome: "accepted",
    });
  });

  it("retains the Effect's Persist parent and identity without creating generation facts", async () => {
    const { rows } = capture();
    const direct = admitted();
    const input = toCpsatTransportRequest(
      JSON.stringify({
        ...direct,
        mode: "live",
        instanceId: engine.origin.instanceId,
        parentEventId: engine.parentEventId,
        fact: { ...direct.fact, origin: engine.origin },
      }),
      engine,
    );
    if (!input) throw new Error("Positive Effect fixture was rejected");
    const fetch = vi.fn<Fetcher["fetch"]>().mockResolvedValue(new Response(null, { status: 202 }));
    await dispatchCpsatTransportRequest(input, { fetch }, () => true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.parentEventId).toBe(engine.parentEventId);
    expect(rows[0]?.instanceId).toBe(input.instanceId);
    expect(rows[0]?.invocationId).toBe(input.invocationId);
    expect(rows[0]?.fact).toEqual(input.fact);
    expect(rows.some((item) => item.fact.type === "cpsat.request-generated")).toBe(false);

    // These parents are explicit fixtures, not a claim that the real Effect
    // interpreter has been wired. The shared sender must preserve causality.
    const generated: CpsatObservation = {
      ...input,
      eventId: "generated-1",
      parentEventId: null,
      fact: {
        type: "cpsat.request-generated",
        decisionId: engine.origin.decisionId,
        effectIndex: engine.origin.effectIndex,
      },
    };
    const saved: CpsatObservation = {
      ...generated,
      eventId: engine.parentEventId,
      parentEventId: generated.eventId,
      fact: {
        type: "cpsat.persist-result",
        decisionId: engine.origin.decisionId,
        outcome: "saved",
      },
    };
    const to = Date.now() + 1;
    const summary = summarizeCpsatObservations([generated, saved, ...rows], {
      from: input.at,
      to,
      capturedFrom: input.at,
      capturedTo: to,
      retainedFrom: input.at,
      samplingRate: 1,
      exportComplete: true,
      scopes: [{ storeRef: input.storeRef, backend: "cpsat", mode: "live" }],
      gaps: [],
      frequencyLimits: null,
    });
    expect(summary.issues).toEqual([]);
    expect(summary.usableForRates).toBe(true);
    expect(summary.totals[0]?.counts).toMatchObject({
      generated: 1,
      dispatched: 1,
      solveStarted: 0,
    });
  });
});
