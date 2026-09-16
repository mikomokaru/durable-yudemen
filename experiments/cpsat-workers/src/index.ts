import { runtime, solve } from "./runtime";

const OR_TOOLS_VERSION = "9.15";
const OR_TOOLS_WASM_REVISION = "e1453348bc43d3b0afc0c2e5a535f5c9b45326f4";
const MAX_REPEAT = 50;
let isolateId: string | undefined;

function authorized(request: Request, env: CpsatPocEnv): boolean {
  // Fail closed if a deployment or local environment is missing its secret.
  if (!/^[a-f0-9]{64}$/.test(env.POC_AUTH_TOKEN ?? "")) return false;
  const provided = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${env.POC_AUTH_TOKEN}`;
  const encoder = new TextEncoder();
  const providedBytes = encoder.encode(provided);
  const expectedBytes = encoder.encode(expected);
  return (
    providedBytes.byteLength === expectedBytes.byteLength &&
    crypto.subtle.timingSafeEqual(providedBytes, expectedBytes)
  );
}

function integerParameter(
  url: URL,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}

async function readModel(request: Request): Promise<Uint8Array | null> {
  if (request.body === null) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > 1_048_576) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk.value);
  }
  if (length === 0) return null;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export default {
  async fetch(request: Request, env: CpsatPocEnv): Promise<Response> {
    if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);
    isolateId ??= crypto.randomUUID();
    const url = new URL(request.url);
    const modelRequest = url.pathname === "/solve-model";
    // The new input surface is local-only until a separate deployment review.
    if (modelRequest && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      return json({ error: "model endpoint is local-only" }, 404);
    }
    if (request.method !== (modelRequest ? "POST" : "GET"))
      return json({ error: "unexpected method" }, 405);
    if (url.pathname === "/health") {
      return json({ ok: true, poc: "cpsat-deterministic-v1" });
    }
    if (url.pathname !== "/run" && !modelRequest) return json({ error: "not found" }, 404);

    const caseName = modelRequest ? "model" : (url.searchParams.get("case") ?? "small");
    if (
      caseName !== "small" &&
      caseName !== "hard" &&
      caseName !== "hard-search" &&
      !(modelRequest && caseName === "model")
    ) {
      return json({ error: "case must be small, hard or hard-search" }, 400);
    }
    const clockMode = url.searchParams.get("clock") ?? "host";
    if (clockMode !== "host" && clockMode !== "frozen") {
      return json({ error: "clock must be host or frozen" }, 400);
    }
    // Reject the former API explicitly; never silently ignore a requested deadline.
    if (url.searchParams.has("timeLimitMs")) {
      return json({ error: "timeLimitMs was removed; use deterministicLimit (not seconds)" }, 400);
    }
    const repeat = integerParameter(url, "repeat", 1, 1, MAX_REPEAT);
    const deterministicLimit = Number(url.searchParams.get("deterministicLimit") ?? "0.05");
    if (
      repeat === null ||
      !Number.isFinite(deterministicLimit) ||
      deterministicLimit <= 0 ||
      deterministicLimit > 1
    ) {
      return json(
        { error: "repeat must be 1..50; deterministicLimit must be finite and in (0, 1]" },
        400,
      );
    }
    if (caseName !== "small" && deterministicLimit * repeat > 0.2) {
      return json({ error: "hard-case work budget per request must not exceed 0.2" }, 400);
    }

    const modelBytes = modelRequest ? await readModel(request) : undefined;
    if (modelBytes === null) return json({ error: "model body must be 1..1048576 bytes" }, 413);

    const requestStartedAt = performance.now();
    const loaded = await runtime(clockMode);
    const samples = [];
    for (let index = 0; index < repeat; ++index) {
      samples.push(solve(loaded.value, caseName, deterministicLimit, modelBytes));
    }

    const requestId =
      request.headers.get("x-cpsat-request-id")?.slice(0, 100) ?? crypto.randomUUID();
    console.log(
      JSON.stringify({
        kind: "cpsat-poc-result",
        requestId,
        isolateId,
        caseName,
        clockMode,
        repeat,
        initializedNow: loaded.initializedNow,
        statuses: samples.map((sample) => sample.status),
        maxWasmMemoryBytes: Math.max(...samples.map((sample) => sample.wasmMemoryBytes)),
      }),
    );

    return json({
      runtime: {
        isolateId,
        orToolsVersion: OR_TOOLS_VERSION,
        sourceRevision: OR_TOOLS_WASM_REVISION,
        searchWorkers: 1,
        pthreadsLinked: false,
        clockMode,
        limitKind: "max_deterministic_time",
        initializedNow: loaded.initializedNow,
        initializationMs: loaded.initializationMs,
      },
      requestId,
      requestElapsedMs: performance.now() - requestStartedAt,
      samples,
    });
  },
} satisfies ExportedHandler<CpsatPocEnv>;
