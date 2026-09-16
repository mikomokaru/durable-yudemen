import { afterEach, beforeEach, expect, it, vi } from "vitest";
import shim from "../experiments/cpsat-workers/transport/shim";
import manifest from "../experiments/cpsat-workers/transport/manifest.json";
import { parseCpsatObservation } from "../src/cpsat/observation";

const original = structuredClone(manifest);
const bindings = {
  // 求解への到達手段は Queue だけである。shim は CP-SAT Worker への binding を
  // 持たないので、この試験も Queue への投入を観測する（design 第9節）。
  CPSAT_PLAN_QUEUE: {
    send: vi.fn<Queue["send"]>(),
    sendBatch: vi.fn<Queue["sendBatch"]>(),
  },
  SOLVER: {
    fetch: vi.fn<Fetcher["fetch"]>(),
    connect() {
      throw new Error("No socket transport");
    },
  },
} as unknown as CpsatTransportProbeEnv & Pick<Env, "SOLVER"> & { CPSAT_PLAN_QUEUE: Queue };
const store = manifest.stores.find((item) => item.series === "shim");
if (!store) throw new Error("Missing shim fixture");
const storeId = store.id;
const body = () => ({
  storeId,
  pending: [{ externalOrderId: "secret-order" }],
  running: [],
  params: { secret: "private-policy" },
  noodlePresets: [],
  digest: 123,
  shownPlan: [],
});
const request = (value: unknown = body()) =>
  new Request("https://solver.invalid/plan", {
    method: "POST",
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(manifest, {
    enabled: true,
    notBefore: Date.now() - 1000,
    expiresAt: Date.now() + 60_000,
  });
});
afterEach(() => {
  Object.assign(manifest, structuredClone(original));
  vi.restoreAllMocks();
});

it("manifest fixes two disjoint store scopes per series", () => {
  expect(manifest.stores.filter((item) => item.series === "direct")).toHaveLength(2);
  expect(manifest.stores.filter((item) => item.series === "shim")).toHaveLength(2);
  expect(new Set(manifest.stores.map((item) => item.id)).size).toBe(4);
  expect(new Set(manifest.stores.map((item) => item.ref)).size).toBe(4);
  for (const item of manifest.stores)
    expect(manifest.problems.some((problem) => problem.name === item.problem)).toBe(true);
});

it("replaces the business body with an allowlisted fixed probe and a non-H1 receipt", async () => {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    lines.push(line);
  });
  const ts = vi.spyOn(bindings.SOLVER, "fetch");
  let sent = "";
  const cp = vi.spyOn(bindings.CPSAT_PLAN_QUEUE, "send").mockImplementation(async (message) => {
    // Queue には観測行がそのまま載る。業務のボディは載らない——差し替えが効いている
    // ことを、載った値そのもので確かめる。
    sent = JSON.stringify((message as { row: unknown }).row);
    return { successfulMessages: 1, failedMessages: 0 } as unknown as QueueSendResponse;
  });
  expect((await shim.fetch(request(), bindings)).status).toBe(202);
  expect(cp).toHaveBeenCalledTimes(1);
  expect(ts).not.toHaveBeenCalled();
  const row = parseCpsatObservation(sent);
  expect(row).toMatchObject({
    mode: "probe",
    storeRef: store?.ref,
    parentEventId: null,
    fact: { origin: { kind: "probe" } },
  });
  expect(row?.versions.model).toBe(
    manifest.problems.find((problem) => problem.name === store?.problem)?.sha256,
  );
  expect(lines).toHaveLength(3);
  expect(parseCpsatObservation(lines[0] ?? "")).toBeNull();
  expect(JSON.parse(lines[0] ?? "")).toEqual({
    transport: "shim",
    requestId: row?.fact.type === "cpsat.request-dispatched" ? row.fact.requestId : null,
    storeRef: store?.ref,
    receivedAt: expect.any(Number),
    pendingCount: 1,
    runningCount: 0,
  });
  for (const text of [...lines, sent]) {
    expect(text).not.toContain("secret-order");
    expect(text).not.toContain("private-policy");
    expect(text).not.toContain("decisionId");
    expect(text).not.toContain("cpsat.request-generated");
  }
});

it.each(["model", "callbackUrl", "budget", "storeRef", "origin", "parentEventId"])(
  "rejects injected %s rather than forwarding it",
  async (key) => {
    const cp = vi.spyOn(bindings.CPSAT_PLAN_QUEUE, "send");
    const ts = vi.spyOn(bindings.SOLVER, "fetch");
    expect((await shim.fetch(request({ ...body(), [key]: "untrusted" }), bindings)).status).toBe(
      400,
    );
    expect(cp).not.toHaveBeenCalled();
    expect(ts).not.toHaveBeenCalled();
  },
);

it("rejects unbounded bytes, malformed JSON/UTF-8 and wrong methods", async () => {
  const cp = vi.spyOn(bindings.CPSAT_PLAN_QUEUE, "send");
  const ts = vi.spyOn(bindings.SOLVER, "fetch");
  for (const value of ["{", "x".repeat(1_048_577), new Uint8Array([0xc0, 0xaf]), "null", "{}"]) {
    const incoming = new Request("https://solver.invalid/plan", { method: "POST", body: value });
    // Each request owns a stream; finish its refusal before testing the next.
    // oxlint-disable-next-line no-await-in-loop
    expect((await shim.fetch(incoming, bindings)).status).toBe(400);
  }
  expect((await shim.fetch(new Request("https://solver.invalid/plan"), bindings)).status).toBe(404);
  expect(cp).not.toHaveBeenCalled();
  expect(ts).not.toHaveBeenCalled();
});

it("checks expiry after reading and never falls back from a shim store to TS", async () => {
  const cp = vi.spyOn(bindings.CPSAT_PLAN_QUEUE, "send");
  const ts = vi.spyOn(bindings.SOLVER, "fetch");
  const incoming = new Request("https://solver.invalid/plan", {
    method: "POST",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(body())));
        manifest.expiresAt = Date.now() - 1;
        controller.close();
      },
    }),
  });
  expect((await shim.fetch(incoming, bindings)).status).toBe(503);
  expect(cp).not.toHaveBeenCalled();
  expect(ts).not.toHaveBeenCalled();
});

// 輸送を Queue へ移したので、送出の時点に solver の busy／期限切れは現れない。
// 投入が成功したか失敗したか、その 2 つだけである。旧試験（CP の 429／503 を
// そのまま返す）はもう系を記述していないため、投入の結末で置き換える。
it.each([
  ["accepted", false, 202],
  ["send failure", true, 503],
] as const)(
  "makes exactly one send attempt and never falls back to TS: %s",
  async (_name, fails, status) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const ts = vi.spyOn(bindings.SOLVER, "fetch");
    const cp = vi.spyOn(bindings.CPSAT_PLAN_QUEUE, "send").mockImplementation(async () => {
      if (fails) throw new Error("injected");
      return { successfulMessages: 1, failedMessages: 0 } as unknown as QueueSendResponse;
    });
    expect((await shim.fetch(request(), bindings)).status).toBe(status);
    // 1 回だけ。失敗しても輸送層に委ね、ここでは再送しない（R6.7）。
    expect(cp).toHaveBeenCalledTimes(1);
    expect(ts).not.toHaveBeenCalled();
  },
);

it.each([true, false])(
  "non-shim stores retain exact TS body/response when enabled=%s",
  async (enabled) => {
    manifest.enabled = enabled;
    const cp = vi.spyOn(bindings.CPSAT_PLAN_QUEUE, "send");
    const text = JSON.stringify({ ...body(), storeId: "not-a-transport-store" }, null, 2);
    const ts = vi.spyOn(bindings.SOLVER, "fetch").mockImplementation(async (input) => {
      if (!(input instanceof Request)) throw new Error("Expected forwarded request");
      expect(await input.text()).toBe(text);
      expect(input.headers.get("X-Preserved")).toBe("yes");
      expect(input.method).toBe("POST");
      expect(input.url).toBe("https://solver.invalid/plan");
      return new Response("TS response", { status: 418, headers: { "X-TS": "unchanged" } });
    });
    const response = await shim.fetch(
      new Request("https://solver.invalid/plan", {
        method: "POST",
        body: text,
        headers: { "X-Preserved": "yes" },
      }),
      bindings,
    );
    expect(response.status).toBe(418);
    expect(await response.text()).toBe("TS response");
    expect(response.headers.get("X-TS")).toBe("unchanged");
    expect(ts).toHaveBeenCalledTimes(1);
    expect(cp).not.toHaveBeenCalled();
  },
);
